require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const zlib = require('zlib');
const Client = require('ssh2-sftp-client');
const crypto = require('crypto');
const OpenAI = require('openai');
const { createMonthlyReportPdf, summarizeDaily } = require('./report');

const app = express();
const PORT = process.env.PORT || 3000;

// SFTP-Zugangsdaten werden über Umgebungsvariablen gesetzt, damit sie nicht im Code/Repository liegen.
// Notwendige Variablen:
//   SFTP_HOST, SFTP_PORT (optional, Standard 22), SFTP_USERNAME, SFTP_PASSWORD
const sftpConfig = {
  host: process.env.SFTP_HOST,
  port: process.env.SFTP_PORT ? Number(process.env.SFTP_PORT) : 22,
  username: process.env.SFTP_USERNAME,
  password: process.env.SFTP_PASSWORD,
};

// Remote-Verzeichnis auf dem SFTP-Server, aus dem .gz-Dateien geholt werden
const remoteDirectory = '/logs';

// Lokales Zielverzeichnis (relativ zum Projektordner)
const localDirectory = path.join(__dirname, 'downloads');
// Unterverzeichnis für entpackte Dateien
const extractedDirectory = path.join(localDirectory, 'unzipped');
// Metadatei für bereits verarbeitete Downloads
const downloadMetaFile = path.join(localDirectory, 'download-meta.json');
// Datei für tägliche Besuchsstatistiken
const dailyStatsFile = path.join(extractedDirectory, 'daily-stats.json');
// Konfigurationsdatei
const configFile = path.join(__dirname, 'config.json');

function loadConfig() {
  try {
    if (!fs.existsSync(configFile)) {
      return { relevantDomains: ['www.hrv.de', 'hrv.de'], sessionThresholdMinutes: 30 };
    }
    const raw = fs.readFileSync(configFile, 'utf8');
    const parsed = JSON.parse(raw);
    return {
      relevantDomains: parsed.relevantDomains || ['www.hrv.de', 'hrv.de'],
      sessionThresholdMinutes: parsed.sessionThresholdMinutes || 30,
    };
  } catch (e) {
    console.error('Konnte Konfigurationsdatei nicht lesen, verwende Defaults:', e);
    return { relevantDomains: ['www.hrv.de', 'hrv.de'], sessionThresholdMinutes: 30 };
  }
}

const config = loadConfig();

// User-Agents von Skripten, Scannern und Diensten, die sich nicht "bot" nennen (leer/"-" eingeschlossen)
const TOOL_UA_RE = /^-?$|python|curl|wget|go-http|java\/|okhttp|axios|node-fetch|undici|libwww|scrapy|headless|phantom|selenium|puppeteer|playwright|httpclient|aiohttp|httpx|bun\/|deno\/|zgrab|masscan|nikto|sqlmap|censys|expanse|netsystems|l9explore|l9tcpid|postman|guzzle|linkvalidator|skypeuripreview|uptime|pingdom|gtmetrix|lighthouse|facebookexternalhit|whatsapp|telegram/i;
// Ein echter Browser lädt Stylesheets, Skripte, Bilder oder Schriften nach (favicon wird auch von Bots abgerufen)
const BROWSER_ASSET_RE = /\.(css|js|mjs|png|jpe?g|gif|svg|webp|avif|ico|woff2?|ttf|eot|map|scss)$|\/_CGSmartImage\/|\/assets\//i;

function isBrowserAsset(urlPath) {
  return BROWSER_ASSET_RE.test(urlPath) && !/favicon|apple-touch-icon/i.test(urlPath);
}

// Einstufung allein am User-Agent: ai | bot | human (human = noch unbestätigt)
function classifyUserAgent(uaRaw) {
  const ua = (uaRaw || '').toLowerCase();

  // AI-Clients priorisieren, falls sowohl "bot" als auch AI-Muster vorkommen
  if (ua.includes('chatgpt') || ua.includes('gpt') || ua.includes('openai') || ua.includes('copilot') || ua.includes('oai-searchbot') || ua.includes('ai-')) {
    return 'ai';
  }

  if (/bot|crawl|spider|searchbot|crawler/.test(ua) || TOOL_UA_RE.test(ua)) {
    return 'bot';
  }

  return 'human';
}

// Bestätigt "human" bei Browser-Verhalten (Assets geladen oder mehrere Seiten), sonst "unclear"
function resolveVisitorType(visitor, loadedBrowserAssets) {
  if (visitor.type !== 'human') return visitor.type;
  const pageCount = visitor.pages ? visitor.pages.size : 0;
  return pageCount >= 2 || loadedBrowserAssets ? 'human' : 'unclear';
}

function loadDownloadMeta() {
  try {
    if (!fs.existsSync(downloadMetaFile)) {
      return { files: {} };
    }
    const raw = fs.readFileSync(downloadMetaFile, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') {
      return { files: {} };
    }
    if (!parsed.files || typeof parsed.files !== 'object') {
      parsed.files = {};
    }
    return parsed;
  } catch (e) {
    console.error('Konnte Download-Metadatei nicht lesen, starte neu:', e);
    return { files: {} };
  }
}

function saveDownloadMeta(meta) {
  try {
    if (!fs.existsSync(localDirectory)) {
      fs.mkdirSync(localDirectory, { recursive: true });
    }
    fs.writeFileSync(downloadMetaFile, JSON.stringify(meta, null, 2), 'utf8');
  } catch (e) {
    console.error('Konnte Download-Metadatei nicht schreiben:', e);
  }
}

function loadDailyStats() {
  try {
    if (!fs.existsSync(dailyStatsFile)) {
      return {};
    }
    const raw = fs.readFileSync(dailyStatsFile, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') {
      return {};
    }
    return parsed;
  } catch (e) {
    console.error('Konnte tägliche Statistikdatei nicht lesen, starte neu:', e);
    return {};
  }
}

function saveDailyStats(stats) {
  try {
    if (!fs.existsSync(extractedDirectory)) {
      fs.mkdirSync(extractedDirectory, { recursive: true });
    }
    fs.writeFileSync(dailyStatsFile, JSON.stringify(stats, null, 2), 'utf8');
  } catch (e) {
    console.error('Konnte tägliche Statistikdatei nicht schreiben:', e);
  }
}

function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Health-Check: Prüfen, ob das Download-Verzeichnis ansprechbar ist
app.get('/download-dir-status', (req, res) => {
  try {
    if (!fs.existsSync(localDirectory)) {
      fs.mkdirSync(localDirectory, { recursive: true });
    }

    fs.access(localDirectory, fs.constants.R_OK | fs.constants.W_OK, (err) => {
      if (err) {
        console.error('Download-Verzeichnis nicht ansprechbar:', err);
        return res.status(500).json({
          success: false,
          message: 'Download-Verzeichnis ist nicht ansprechbar.',
          error: err.message,
        });
      }

      res.json({
        success: true,
        message: 'Download-Verzeichnis ist ansprechbar.',
      });
    });
  } catch (error) {
    console.error('Fehler beim Prüfen des Download-Verzeichnisses:', error);
    res.status(500).json({
      success: false,
      message: 'Fehler beim Prüfen des Download-Verzeichnisses.',
      error: error.message,
    });
  }
});

app.post('/download', async (req, res) => {
  // Fortschritt als Server-Sent Events (SSE) streamen
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  function send(data) {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  }

  const sftp = new Client();

  try {
    const meta = loadDownloadMeta();

    send({ step: 'connect', label: 'Verbinde mit SFTP-Server…', pct: 1 });
    await sftp.connect(sftpConfig);

    send({ step: 'scan', label: 'Lese Dateiliste vom SFTP-Server…', pct: 3 });
    const fileList = await sftp.list(remoteDirectory);
    const gzFiles = fileList.filter((item) => {
      if (item.type !== '-') return false;
      const nameLower = item.name.toLowerCase();
      return nameLower.endsWith('.gz') && nameLower.startsWith('access.log');
    });

    const totalRemoteFiles = gzFiles.length;
    const totalRemoteBytes = gzFiles.reduce((sum, f) => {
      const size = typeof f.size === 'number' ? f.size : 0;
      return sum + size;
    }, 0);

    if (!fs.existsSync(localDirectory)) {
      fs.mkdirSync(localDirectory, { recursive: true });
    }

    const downloadedFiles = [];
    const skippedFiles = [];
    const localPaths = [];

    // Schritt 1: Archive herunterladen – 5 % → 55 %
    let downloadDone = 0;
    for (const file of gzFiles) {
      const key = file.name;
      const existing = meta.files && meta.files[key];
      const remoteSize = file.size;
      const remoteMtime = file.modifyTime;
      const pct = Math.round(2 + (downloadDone / Math.max(totalRemoteFiles, 1)) * 5);

      if (
        existing &&
        typeof existing.remoteSize === 'number' &&
        typeof existing.remoteMtime === 'number' &&
        existing.remoteSize === remoteSize &&
        existing.remoteMtime === remoteMtime
      ) {
        skippedFiles.push(key);
        downloadDone++;
        send({ step: 'download', label: `Überspringe (unverändert): ${key}  (${downloadDone}/${totalRemoteFiles})`, file: key, pct });
        continue;
      }

      send({ step: 'download', label: `Herunterladen: ${key}  (${downloadDone + 1}/${totalRemoteFiles})`, file: key, pct });
      const remotePath = `${remoteDirectory.replace(/\/+$/, '')}/${file.name}`;
      const localPath = path.join(localDirectory, file.name);

      await sftp.fastGet(remotePath, localPath);
      downloadedFiles.push(file.name);
      localPaths.push({ localPath, key, remoteSize, remoteMtime });
      downloadDone++;
    }

    await sftp.end();

    // Schritt 2: Entpacken – 55 % → 75 %
    const processedExtractedFiles = new Set();
    let processedBytes = 0;
    let skippedBytes = 0;

    for (const file of gzFiles) {
      if (skippedFiles.includes(file.name)) {
        const size = typeof file.size === 'number' ? file.size : 0;
        skippedBytes += size;
      }
    }

    const totalToExtract = localPaths.length;
    let extractDone = 0;
    for (const item of localPaths) {
      const { localPath, key, remoteSize, remoteMtime } = item;
      const pct = Math.round(7 + (extractDone / Math.max(totalToExtract, 1)) * 90);
      send({ step: 'extract', label: `Entpacke: ${key}  (${extractDone + 1}/${totalToExtract})`, file: key, pct });
      try {
        const extractedNames = await extractAndNormalizeLog(localPath);
        if (Array.isArray(extractedNames)) {
          extractedNames.forEach((n) => processedExtractedFiles.add(n));
        } else if (typeof extractedNames === 'string' && extractedNames) {
          processedExtractedFiles.add(extractedNames);
        }

        if (typeof remoteSize === 'number') {
          processedBytes += remoteSize;
        }

        try {
          const hash = await sha256File(localPath);
          meta.files[key] = {
            remotePath: `${remoteDirectory.replace(/\/+$/, '')}/${key}`,
            remoteSize,
            remoteMtime,
            hash,
            processedAt: new Date().toISOString(),
          };
        } catch (hashErr) {
          console.error('Konnte Hash für heruntergeladene Datei nicht berechnen:', hashErr);
        }
      } catch (e) {
        console.error('Fehler beim automatischen Entpacken/Normalisieren:', e);
      }
      extractDone++;
    }

    saveDownloadMeta(meta);

    // Schritt 3: Tagesstatistiken – 75 % → 98 %
    const dailyStats = loadDailyStats();
    const updatedDates = [];
    const allExtracted = Array.from(processedExtractedFiles);
    const totalDates = allExtracted.length;
    let dailyDone = 0;
    let lastDay = '';
    for (const fileName of allExtracted) {
      const pct = Math.round(97 + (dailyDone / Math.max(totalDates, 1)) * 2);
      send({ step: 'daily', label: `Analysiere: ${fileName}  (${dailyDone + 1}/${totalDates})`, file: fileName, pct, lastDay });
      try {
        const stats = await computeDailyStatsForFile(fileName);
        if (stats && stats.date) {
          dailyStats[stats.date] = stats;
          updatedDates.push(stats.date);
          lastDay = stats.date;
        }
      } catch (statsErr) {
        console.error('Fehler beim Berechnen der Tagesstatistik für', fileName, statsErr);
      }
      dailyDone++;
    }
    if (updatedDates.length > 0) {
      saveDailyStats(dailyStats);
    }

    const processedFilesTotal = downloadedFiles.length + skippedFiles.length;
    const processedBytesTotal = processedBytes + skippedBytes;

    send({
      step: 'done',
      label: 'Abgeschlossen',
      pct: 100,
      result: {
        success: true,
        message: 'Download und Verarbeitung abgeschlossen',
        count: downloadedFiles.length,
        files: downloadedFiles,
        skipped: skippedFiles,
        totalRemoteFiles,
        totalRemoteBytes,
        processedFiles: processedFilesTotal,
        processedBytes: processedBytesTotal,
        skippedBytes,
        extracted: Array.from(processedExtractedFiles),
        dailyStatsUpdated: updatedDates,
      },
    });
    res.end();
  } catch (error) {
    console.error('SFTP-Fehler:', error);
    try { await sftp.end(); } catch (_) {}
    send({ step: 'error', label: `Fehler: ${error.message}`, pct: 0 });
    res.end();
  }
});

// Hilfsfunktion: Entpacke eine heruntergeladene access.log-*.gz-Datei automatisch,
// teile sie nach Datum auf und führe pro Tag in eine Zieldatei zusammen.
async function extractAndNormalizeLog(localGzPath) {
  if (!fs.existsSync(localGzPath)) return null;

  if (!fs.existsSync(extractedDirectory)) {
    fs.mkdirSync(extractedDirectory, { recursive: true });
  }

  const gzBaseName = path.basename(localGzPath, '.gz');
  const tmpPath = path.join(extractedDirectory, `${gzBaseName}.tmp`);

  // 1) Entpacken in eine temporäre Datei
  await new Promise((resolve, reject) => {
    const readStream = fs.createReadStream(localGzPath);
    const gunzip = zlib.createGunzip();
    const writeStream = fs.createWriteStream(tmpPath);

    readStream
      .pipe(gunzip)
      .pipe(writeStream)
      .on('finish', resolve)
      .on('error', reject);
  });

  // 2) Inhalt nach Datum aufsplitten und pro Tag in eine Datei schreiben
  const readline = require('readline');
  const rl = readline.createInterface({
    input: fs.createReadStream(tmpPath, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });

  const logRegex = /^(\S+)\s+\S+\s+\S+\s+\[([^\]]+)\]\s+"(\S+)\s+([^\"]+)\s+\S+"\s+(\d{3})\s+\S+\s+(\S+)\s+"([^\"]*)"\s+"([^\"]*)"/;

  const monthMap = {
    Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06',
    Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12',
  };

  function toIsoFromApacheTime(str) {
    const m = /^(\d{2})\/(\w{3})\/(\d{4}):(\d{2}):(\d{2}):(\d{2}) ([+\-]\d{4})$/.exec(str);
    if (!m) return null;
    const [, dd, monStr, yyyy, hh, mm, ss, offset] = m;
    const mon = monthMap[monStr] || '01';
    const offH = offset.slice(0, 3);
    const offM = offset.slice(3);
    return `${yyyy}-${mon}-${dd}T${hh}:${mm}:${ss}${offH}:${offM}`;
  }

  const writtenDates = new Set();

  await new Promise((resolve) => {
    rl.on('line', (line) => {
      const match = logRegex.exec(line);
      if (!match) {
        return;
      }
      const timeRaw = match[2];
      const iso = toIsoFromApacheTime(timeRaw);
      if (!iso) {
        return;
      }
      const datePart = iso.slice(0, 10);
      const finalName = `access-${datePart}.log`;
      const finalPath = path.join(extractedDirectory, finalName);

      // Pro Tag eine Datei; bestehende Dateien werden nicht überschrieben,
      // sondern höchstens erweitert (append).
      const lineWithNewline = line.endsWith('\n') ? line : line + '\n';
      fs.appendFileSync(finalPath, lineWithNewline);
      writtenDates.add(finalName);
    });

    rl.on('close', () => {
      resolve();
    });
  });

  // Temporäre Datei entfernen
  try {
    fs.unlinkSync(tmpPath);
  } catch (_) {}

  // Rückgabe: alle erzeugten/erweiterten Dateien (oder null)
  return writtenDates.size ? Array.from(writtenDates) : null;
}

// Hilfsfunktion: Werte eine Tages-Logdatei (access-YYYY-MM-DD.log) aus
// und berechne Aufrufe/Besuche nach Typ.
async function computeDailyStatsForFile(fileName) {
  const sourcePath = path.join(extractedDirectory, fileName);

  if (!sourcePath.startsWith(extractedDirectory)) {
    return null;
  }

  if (!fs.existsSync(sourcePath)) {
    return null;
  }

  const readline = require('readline');
  const stream = fs.createReadStream(sourcePath, { encoding: 'utf8' });

  const rl = readline.createInterface({
    input: stream,
    crlfDelay: Infinity,
  });

  // Beispielzeile:
  // 82.38.56.0 - - [30/Mar/2026:00:02:29 +0200] "GET /aboutus HTTP/1.1" 301 273 hrv.de "https://hrv.de/aboutus" "UA" "-"
  const logRegex = /^(\S+)\s+\S+\s+\S+\s+\[([^\]]+)\]\s+"(\S+)\s+([^\"]+)\s+\S+"\s+(\d{3})\s+\S+\s+(\S+)\s+"([^\"]*)"\s+"([^\"]*)"/;

  const monthMap = {
    Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06',
    Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12',
  };

  function toIsoFromApacheTime(str) {
    const m = /^(\d{2})\/(\w{3})\/(\d{4}):(\d{2}):(\d{2}):(\d{2}) ([+\-]\d{4})$/.exec(str);
    if (!m) return str;
    const [, dd, monStr, yyyy, hh, mm, ss, offset] = m;
    const mon = monthMap[monStr] || '01';
    const offH = offset.slice(0, 3);
    const offM = offset.slice(3);
    return `${yyyy}-${mon}-${dd}T${hh}:${mm}:${ss}${offH}:${offM}`;
  }

  let totalLines = 0;
  const visitors = new Map();
  const assetVisitors = new Set(); // Besucher, die Browser-Assets (auch 304) geladen haben
  const MAX_VISITORS = 2000;
  let firstDateIsoFull = null;
  let errors4xx = 0;
  let errors429 = 0;

  await new Promise((resolve, reject) => {
    rl.on('line', (line) => {
      totalLines += 1;

      const match = logRegex.exec(line);
      if (!match) return;

      const ip = match[1];
      const timeRaw = match[2];
      const method = match[3];
      const pathRequested = match[4];
      const status = match[5];
      const host = match[6];
      const userAgent = match[8];

      // Nur relevante Domains berücksichtigen
      if (!config.relevantDomains.includes(host)) return;

      // 4xx-Fehler zählen (400-499)
      const statusCode = parseInt(status, 10);
      if (statusCode >= 400 && statusCode < 500) {
        errors4xx += 1;
      }
      
      // 429-Fehler separat zählen
      if (statusCode === 429) {
        errors429 += 1;
      }

      // Browser-Assets merken, bevor 3xx/404 verworfen werden (Wiederkehrer erhalten 304)
      const urlPathOnly = pathRequested.split('?')[0];
      const assetRequest = isBrowserAsset(urlPathOnly);
      if (assetRequest && (status === '200' || status === '304')) {
        assetVisitors.add(`${ip}|${userAgent || ''}`);
      }

      // Nur 200er für Besucherzählung berücksichtigen, 404/3xx ignorieren
      if (status !== '200') return;

      const url = host && host !== '-' ? `https://${host}${pathRequested}` : pathRequested;
      const timeIso = toIsoFromApacheTime(timeRaw);

      if (!firstDateIsoFull || timeIso < firstDateIsoFull) {
        firstDateIsoFull = timeIso;
      }

      const key = `${ip}|${userAgent || ''}`;
      let visitor = visitors.get(key);

      const currentType = classifyUserAgent(userAgent);

      if (!visitor) {
        if (visitors.size >= MAX_VISITORS) {
          return;
        }
        visitor = {
          ip,
          userAgent,
          firstTime: timeIso,
          lastTime: timeIso,
          lastUrl: url,
          hits: 1,
          type: currentType,
          pages: new Set(),
        };
      } else {
        visitor.lastTime = timeIso;
        visitor.lastUrl = url;
        visitor.hits += 1;
        if (visitor.type !== 'ai') {
          if (currentType === 'ai') {
            visitor.type = 'ai';
          } else if (visitor.type === 'human' && currentType === 'bot') {
            visitor.type = 'bot';
          }
        }
      }

      if (!assetRequest) visitor.pages.add(urlPathOnly);
      visitors.set(key, visitor);
    });

    rl.on('close', () => resolve());
    rl.on('error', (err) => reject(err));
    stream.on('error', (err) => reject(err));
  });

  const entries = Array.from(visitors.values());
  const firstDateIso = firstDateIsoFull ? firstDateIsoFull.slice(0, 10) : null;

  let visitsTotal = 0;
  let visitsBots = 0;
  let visitsAi = 0;
  let visitsHuman = 0;
  let visitsUnclear = 0;

  function calcSessionsForVisitor(v) {
    if (!v.firstTime || !v.lastTime) return 1;
    const start = Date.parse(v.firstTime);
    const end = Date.parse(v.lastTime);
    if (Number.isNaN(start) || Number.isNaN(end) || end <= start) return 1;
    const diffMinutes = (end - start) / 60000;
    // Session-Grenze aus Konfiguration – längere Spanne wird als zwei Besuche gezählt
    return diffMinutes > config.sessionThresholdMinutes ? 2 : 1;
  }

  for (const v of entries) {
    const sessions = calcSessionsForVisitor(v);
    visitsTotal += sessions;

    const type = resolveVisitorType(v, assetVisitors.has(`${v.ip}|${v.userAgent || ''}`));
    if (type === 'ai') {
      visitsAi += sessions;
    } else if (type === 'bot') {
      visitsBots += sessions;
    } else if (type === 'unclear') {
      visitsUnclear += sessions;
    } else {
      visitsHuman += sessions;
    }
  }

  const m = /^access-(\d{4}-\d{2}-\d{2})\.log$/.exec(fileName);
  const dateKey = m ? m[1] : firstDateIso || fileName;

  return {
    date: dateKey,
    lineCountApprox: totalLines,
    visitsTotal,
    visitsBots,
    visitsAi,
    visitsHuman,
    visitsUnclear,
    errors4xx,
    errors429,
  };
}

// Liste alle Dateien im lokalen downloads-Verzeichnis auf
app.get('/files', (req, res) => {
  try {
    if (!fs.existsSync(localDirectory)) {
      return res.json({ success: true, files: [] });
    }

    const files = fs.readdirSync(localDirectory)
      .filter((name) => {
        const fullPath = path.join(localDirectory, name);
        return fs.statSync(fullPath).isFile() && name.toLowerCase().endsWith('.gz');
      })
      .map((name) => {
        const st = fs.statSync(path.join(localDirectory, name));
        return { name, size: st.size, mtime: st.mtime.toISOString() };
      });

    res.json({ success: true, files });
  } catch (error) {
    console.error('Fehler beim Auflisten der Downloads:', error);
    res.status(500).json({
      success: false,
      message: 'Fehler beim Auflisten der Dateien im downloads-Verzeichnis',
      error: error.message,
    });
  }
});

// Liste nur entpackte Dateien (alles außer .gz) im downloads-Verzeichnis auf
app.get('/unzipped', (req, res) => {
  try {
    if (!fs.existsSync(extractedDirectory)) {
      return res.json({ success: true, files: [], total: 0 });
    }

    const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
    const limit  = Math.min(100, Math.max(1, parseInt(req.query.limit,  10) || 25));

    const allFiles = fs
      .readdirSync(extractedDirectory)
      .filter((name) => {
        const fullPath = path.join(extractedDirectory, name);
        return fs.statSync(fullPath).isFile() && name.toLowerCase().endsWith('.log');
      })
      .map((name) => {
        const st = fs.statSync(path.join(extractedDirectory, name));
        return { name, size: st.size, mtime: st.mtime.toISOString() };
      })
      .sort((a, b) => {
        // Datum aus Dateinamen extrahieren (z.B. access-2026-03-31.log)
        const dateA = a.name.match(/(\d{4}-\d{2}-\d{2})/)?.[1] ?? '';
        const dateB = b.name.match(/(\d{4}-\d{2}-\d{2})/)?.[1] ?? '';
        return dateB.localeCompare(dateA); // absteigend: neueste zuerst
      });

    const files = allFiles.slice(offset, offset + limit);
    res.json({ success: true, files, total: allFiles.length, offset, limit });
  } catch (error) {
    console.error('Fehler beim Auflisten der entpackten Dateien:', error);
    res.status(500).json({
      success: false,
      message: 'Fehler beim Auflisten der entpackten Dateien im Unterverzeichnis',
      error: error.message,
    });
  }
});

// Entpacke eine ausgewählte .gz-Datei aus dem downloads-Verzeichnis
app.post('/extract', (req, res) => {
  const { fileName } = req.body || {};

  if (!fileName || typeof fileName !== 'string') {
    return res.status(400).json({
      success: false,
      message: 'Es wurde keine gültige Datei angegeben',
    });
  }

  const sourcePath = path.join(localDirectory, fileName);

  if (!sourcePath.startsWith(localDirectory)) {
    return res.status(400).json({
      success: false,
      message: 'Ungültiger Dateiname',
    });
  }

  if (!fs.existsSync(sourcePath)) {
    return res.status(404).json({
      success: false,
      message: 'Datei wurde nicht gefunden',
    });
  }

  if (!fs.existsSync(extractedDirectory)) {
    fs.mkdirSync(extractedDirectory, { recursive: true });
  }

  // Ziel-Dateiname: gleich wie .gz-Datei, aber ohne .gz-Endung
  const targetFileName = fileName.toLowerCase().endsWith('.gz')
    ? fileName.slice(0, -3)
    : `${fileName}.unzipped`;
  const targetPath = path.join(extractedDirectory, targetFileName);

  const readStream = fs.createReadStream(sourcePath);
  const writeStream = fs.createWriteStream(targetPath);
  const gunzip = zlib.createGunzip();

  readStream
    .pipe(gunzip)
    .pipe(writeStream)
    .on('finish', () => {
      res.json({
        success: true,
        message: 'Datei erfolgreich entpackt',
        source: fileName,
        target: targetFileName,
      });
    })
    .on('error', (error) => {
      console.error('Fehler beim Entpacken:', error);
      res.status(500).json({
        success: false,
        message: 'Fehler beim Entpacken der Datei',
        error: error.message,
      });
    });
});

  // Analysiere eine ausgewählte entpackte Datei aus dem Unterverzeichnis
  app.post('/analyze', (req, res) => {
    const { fileName } = req.body || {};

    if (!fileName || typeof fileName !== 'string') {
      return res.status(400).json({
        success: false,
        message: 'Es wurde keine gültige Datei angegeben',
      });
    }

    const sourcePath = path.join(extractedDirectory, fileName);

    if (!sourcePath.startsWith(extractedDirectory)) {
      return res.status(400).json({
        success: false,
        message: 'Ungültiger Dateiname',
      });
    }

    if (!fs.existsSync(sourcePath)) {
      return res.status(404).json({
        success: false,
        message: 'Entpackte Datei wurde nicht gefunden',
      });
    }

    const MAX_CHARS = 5000; // Vorschau begrenzen

    const readline = require('readline');
    const stream = fs.createReadStream(sourcePath, { encoding: 'utf8' });

    const rl = readline.createInterface({
      input: stream,
      crlfDelay: Infinity,
    });

    let preview = '';
    let previewTruncated = false;
    let totalLines = 0;
    const visitors = new Map(); // key = IP+UA, Wert = zusammengefasste Daten
    const assetVisitors = new Set(); // Besucher, die Browser-Assets (auch 304) geladen haben
    const MAX_VISITORS = 2000;
    let firstDateIsoFull = null; // frühester Zeitstempel als vollständige ISO-Zeit

    // Beispielzeile:
    // 82.38.56.0 - - [30/Mar/2026:00:02:29 +0200] "GET /aboutus HTTP/1.1" 301 273 hrv.de "https://hrv.de/aboutus" "UA" "-"
    const logRegex = /^(\S+)\s+\S+\s+\S+\s+\[([^\]]+)\]\s+"(\S+)\s+([^\"]+)\s+\S+"\s+(\d{3})\s+\S+\s+(\S+)\s+"([^\"]*)"\s+"([^\"]*)"/;

    const monthMap = {
      Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06',
      Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12',
    };

    function toIsoFromApacheTime(str) {
      // z.B. "30/Mar/2026:00:02:29 +0200"
      const m = /^(\d{2})\/(\w{3})\/(\d{4}):(\d{2}):(\d{2}):(\d{2}) ([+\-]\d{4})$/.exec(str);
      if (!m) return str;
      const [, dd, monStr, yyyy, hh, mm, ss, offset] = m;
      const mon = monthMap[monStr] || '01';
      const offH = offset.slice(0, 3); // +02
      const offM = offset.slice(3);    // 00
      return `${yyyy}-${mon}-${dd}T${hh}:${mm}:${ss}${offH}:${offM}`;
    }

    rl.on('line', (line) => {
      totalLines += 1;

      // Vorschau auf die ersten MAX_CHARS Zeichen aufbauen
      if (!previewTruncated) {
        if (preview.length + line.length + 1 <= MAX_CHARS) {
          preview += line + '\n';
        } else {
          const remaining = MAX_CHARS - preview.length;
          if (remaining > 0) {
            preview += line.slice(0, remaining);
          }
          previewTruncated = true;
        }
      }

      // Logzeile parsen: IP, Zeit, Methode, Pfad, Status, Host, Referrer, User-Agent
      const match = logRegex.exec(line);
      if (!match) return;

      const ip = match[1];
      const timeRaw = match[2];
      const method = match[3];
      const pathRequested = match[4];
      const status = match[5];
      const host = match[6];
      const userAgent = match[8];

      // Browser-Assets merken, bevor 3xx/404 verworfen werden (Wiederkehrer erhalten 304)
      const urlPathOnly = pathRequested.split('?')[0];
      const assetRequest = isBrowserAsset(urlPathOnly);
      if (assetRequest && (status === '200' || status === '304') && config.relevantDomains.includes(host)) {
        assetVisitors.add(`${ip}|${userAgent || ''}`);
      }

      // Nur 200er berücksichtigen, 404/3xx ignorieren
      if (status !== '200') return;

      // Nur relevante Domains berücksichtigen
      if (!config.relevantDomains.includes(host)) return;

      const url = host && host !== '-' ? `https://${host}${pathRequested}` : pathRequested;
      const timeIso = toIsoFromApacheTime(timeRaw);

      if (!firstDateIsoFull || timeIso < firstDateIsoFull) {
        firstDateIsoFull = timeIso;
      }

      const key = `${ip}|${userAgent || ''}`;
      let visitor = visitors.get(key);

      const currentType = classifyUserAgent(userAgent);

      if (!visitor) {
        if (visitors.size >= MAX_VISITORS) {
          // Bei sehr vielen unterschiedlichen Besuchern brechen wir still mit Aggregation ab
          return;
        }
        visitor = {
          ip,
          userAgent,
          firstTime: timeIso,
          lastTime: timeIso,
          lastUrl: url,
          hits: 1,
          type: currentType,
          pages: new Set(),
        };
      } else {
        visitor.lastTime = timeIso;
        visitor.lastUrl = url;
        visitor.hits += 1;
        // Typ ggf. hochstufen (human -> bot/ai, bot -> ai), aber nie von ai zurückstufen
        if (visitor.type !== 'ai') {
          if (currentType === 'ai') {
            visitor.type = 'ai';
          } else if (visitor.type === 'human' && currentType === 'bot') {
            visitor.type = 'bot';
          }
        }
      }

      if (!assetRequest) visitor.pages.add(urlPathOnly);
      visitors.set(key, visitor);
    });

    rl.on('close', () => {
      try {
        const entries = Array.from(visitors.values());
        const firstDateIso = firstDateIsoFull ? firstDateIsoFull.slice(0, 10) : null; // nur Datum

        let visitsTotal = 0;
        let visitsBots = 0;
        let visitsAi = 0;
        let visitsHuman = 0;
        let visitsUnclear = 0;

        function calcSessionsForVisitor(v) {
          if (!v.firstTime || !v.lastTime) return 1;
          const start = Date.parse(v.firstTime);
          const end = Date.parse(v.lastTime);
          if (Number.isNaN(start) || Number.isNaN(end) || end <= start) return 1;
          const diffMinutes = (end - start) / 60000;
          // Session-Grenze aus Konfiguration – längere Spanne wird als zwei Besuche gezählt
          return diffMinutes > config.sessionThresholdMinutes ? 2 : 1;
        }

        for (const v of entries) {
          const sessions = calcSessionsForVisitor(v);
          visitsTotal += sessions;

          v.type = resolveVisitorType(v, assetVisitors.has(`${v.ip}|${v.userAgent || ''}`));
          if (v.type === 'ai') {
            visitsAi += sessions;
          } else if (v.type === 'bot') {
            visitsBots += sessions;
          } else if (v.type === 'unclear') {
            visitsUnclear += sessions;
          } else {
            visitsHuman += sessions;
          }
        }

        res.json({
          success: true,
          message: 'Analyse der entpackten Datei abgeschlossen',
          file: fileName,
          lineCountApprox: totalLines,
          preview,
          previewTruncated,
          visitsTotal,
          visitsBots,
          visitsAi,
          visitsHuman,
          visitsUnclear,
          firstDateIso,
          entries: entries.map(({ pages, ...visitor }) => visitor),
        });
      } catch (error) {
        console.error('Fehler bei der Analyse der entpackten Datei:', error);
        res.status(500).json({
          success: false,
          message: 'Fehler bei der Analyse der entpackten Datei',
          error: error.message,
        });
      }
    });

    rl.on('error', (error) => {
      console.error('Fehler beim Lesen der entpackten Datei für Analyse:', error);
      res.status(500).json({
        success: false,
        message: 'Fehler beim Lesen der entpackten Datei für die Analyse',
        error: error.message,
      });
    });
  });

// Rechne alle vorhandenen Tages-Logdateien neu in die daily-stats.json
app.post('/recompute-daily-stats', async (req, res) => {
  try {
    if (!fs.existsSync(extractedDirectory)) {
      return res.json({
        success: true,
        message: 'Kein Unterverzeichnis für entpackte Dateien vorhanden.',
        updatedDates: [],
        totalFiles: 0,
      });
    }

    const files = fs
      .readdirSync(extractedDirectory)
      .filter((name) => {
        const fullPath = path.join(extractedDirectory, name);
        return (
          fs.statSync(fullPath).isFile() &&
          name.toLowerCase().endsWith('.log') &&
          name.startsWith('access-')
        );
      });

    if (!files.length) {
      return res.json({
        success: true,
        message: 'Keine Tages-Logdateien zum Auswerten gefunden.',
        updatedDates: [],
        totalFiles: 0,
      });
    }

    const dailyStats = loadDailyStats();
    const updatedDates = [];

    for (const fileName of files) {
      try {
        const stats = await computeDailyStatsForFile(fileName);
        if (stats && stats.date) {
          dailyStats[stats.date] = stats;
          updatedDates.push(stats.date);
        }
      } catch (err) {
        console.error('Fehler beim Berechnen der Tagesstatistik für', fileName, err);
      }
    }

    if (updatedDates.length > 0) {
      saveDailyStats(dailyStats);
    }

    res.json({
      success: true,
      message: 'Tägliche Statistiken wurden neu berechnet.',
      updatedDates,
      totalFiles: files.length,
    });
  } catch (error) {
    console.error('Fehler beim Neuberechnen der täglichen Statistiken:', error);
    res.status(500).json({
      success: false,
      message: 'Fehler beim Neuberechnen der täglichen Statistiken',
      error: error.message,
    });
  }
});

// Liefert die letzten 30 Tage aus daily-stats.json (sortiert nach Datum)
app.get('/daily-stats-last30', (req, res) => {
  try {
    const stats = loadDailyStats();
    const allDates = Object.keys(stats || {})
      .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
      .sort();

    const last30 = allDates.slice(-30);
    const days = last30.map((date) => {
      const s = stats[date] || {};
      return {
        date,
        lineCountApprox: s.lineCountApprox || 0,
        visitsTotal: s.visitsTotal || 0,
        visitsHuman: s.visitsHuman || 0,
        visitsUnclear: s.visitsUnclear || 0,
        visitsBots: s.visitsBots || 0,
        visitsAi: s.visitsAi || 0,
        errors4xx: s.errors4xx || 0,
        errors429: s.errors429 || 0,
      };
    });

    res.json({
      success: true,
      days,
    });
  } catch (error) {
    console.error('Fehler beim Lesen der letzten 30 Tagesstatistiken:', error);
    res.status(500).json({
      success: false,
      message: 'Fehler beim Lesen der letzten 30 Tagesstatistiken',
      error: error.message,
    });
  }
});

// Liefert die Top-Referrer der letzten 30 Tage
app.get('/top-referrers', (req, res) => {
  try {
    if (!fs.existsSync(extractedDirectory)) {
      return res.json({ success: true, referrers: [] });
    }

    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 30);
    const cutoffStr = cutoff.toISOString().slice(0, 10);

    const logFiles = fs.readdirSync(extractedDirectory)
      .filter((name) => {
        const m = /^access-(\d{4}-\d{2}-\d{2})\.log$/.exec(name);
        return m && m[1] >= cutoffStr;
      });

    if (!logFiles.length) {
      return res.json({ success: true, referrers: [] });
    }

    const sorted = collectTopReferrers(logFiles, 15);

    res.json({
      success: true,
      referrers: sorted,
    });
  } catch (error) {
    console.error('Fehler beim Lesen der Top-Referrer:', error);
    res.status(500).json({
      success: false,
      message: 'Fehler beim Lesen der Top-Referrer',
      error: error.message,
    });
  }
});

// Gespeicherte Analysen: downloads/analyses/<typ>-YYYY-MM-DD.md (gleicher Tag wird überschrieben)
const analysesDirectory = path.join(localDirectory, 'analyses');
const ANALYSIS_TYPES = {
  'ai-analyze': '90-Tage-Analyse',
  'ai-analyze-raw': 'Analyse der Rohdaten',
  'ai-bot-analyze': 'KI-Zugriffe & GEO-Analyse',
};

function localDateString(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// Titel und Erstelldatum, die jeder Analyse vorangestellt werden
function analysisHeader(type) {
  const now = new Date();
  return `# ${ANALYSIS_TYPES[type]} – ${localDateString(now)}\n\nErstellt: ${now.toLocaleString('de-DE')}\n\n`;
}

function saveAnalysis(type, content) {
  fs.mkdirSync(analysesDirectory, { recursive: true });
  const fileName = `${type}-${localDateString()}.md`;
  fs.writeFileSync(path.join(analysesDirectory, fileName), content, 'utf8');
  return fileName;
}

// Reicht den Modell-Stream an den Client durch und speichert das fertige Ergebnis
async function relayStreamAndSave(res, stream, type, preamble = '') {
  const prefix = analysisHeader(type) + preamble;
  res.write(`data: ${JSON.stringify({ prefix })}\n\n`);
  let text = '';
  for await (const chunk of stream) {
    const piece = chunk.choices[0]?.delta?.content ?? '';
    if (piece) {
      text += piece;
      res.write(`data: ${JSON.stringify({ text: piece })}\n\n`);
    }
  }
  const saved = text.trim() ? saveAnalysis(type, `${prefix}${text}\n`) : null;
  res.write(`data: ${JSON.stringify({ done: true, saved })}\n\n`);
  res.end();
}

// Liefert die zuletzt gespeicherte Analyse eines Typs
app.get('/analyses/latest', (req, res) => {
  const type = String(req.query.type || '');
  if (!Object.prototype.hasOwnProperty.call(ANALYSIS_TYPES, type)) {
    return res.status(400).json({ success: false, error: 'Unbekannter Analyse-Typ.' });
  }
  const fileRegex = new RegExp(`^${type}-(\\d{4}-\\d{2}-\\d{2})\\.md$`);
  const files = fs.existsSync(analysesDirectory)
    ? fs.readdirSync(analysesDirectory).filter((n) => fileRegex.test(n)).sort()
    : [];
  if (!files.length) {
    return res.json({ success: true, found: false });
  }
  const file = files[files.length - 1];
  res.json({
    success: true,
    found: true,
    file,
    date: fileRegex.exec(file)[1],
    content: fs.readFileSync(path.join(analysesDirectory, file), 'utf8'),
  });
});

function statsToMarkdown(stats) {
  const labels = { training: 'Training', search: 'KI-Suche', user: 'Nutzeranfrage', ads: 'Werbeprüfung', unbekannt: 'unbekannt' };
  const cell = (v) => String(v).replace(/\|/g, '\\|');
  const table = (headers, rows) =>
    [`| ${headers.join(' | ')} |`, `| ${headers.map(() => '---').join(' | ')} |`, ...rows.map((r) => `| ${r.map(cell).join(' | ')} |`)].join('\n');

  const purposes = Object.entries(stats.byPurpose).map(([k, v]) => `${labels[k] || k}: ${v}`).join(' | ');
  const parts = [
    `Zeitraum ${stats.period.from} bis ${stats.period.to}: ${stats.totalAiHits} KI-Zugriffe von ${stats.totalPageRequests} Seitenaufrufen (${stats.aiSharePercent} %)` +
      (purposes ? ` – ${purposes}` : ''),
    '## KI-Crawler',
    table(
      ['Crawler', 'Anbieter', 'Zweck', 'Zugriffe', '2xx', '3xx', '404', 'Sonst. Fehler', 'robots/llms/sitemap'],
      stats.bots.map((b) => [
        b.name, b.vendor, labels[b.purpose] || b.purpose, b.hits, b.ok, b.redirects, b.notFound, b.otherErrors,
        Object.entries(b.special).map(([p, n]) => `${p}: ${n}`).join(', ') || '-',
      ])
    ),
    '## Von KI am häufigsten abgefragte Seiten',
    table(['Pfad', 'Zugriffe', 'Crawler'], stats.topPages.map((p) => [p.path, p.hits, p.bots.join(', ')])),
  ];
  if (stats.notFoundPaths.length) {
    parts.push('## Von KI abgefragte, nicht gefundene Pfade (404)');
    parts.push(table(['Pfad', 'Zugriffe'], stats.notFoundPaths.map((p) => [p.path, p.hits])));
  }
  return parts.join('\n\n');
}

// Azure-OpenAI-Client (API-Key); Endpoint und Deployment stammen aus der .env
function getAiConfig() {
  const endpoint = (process.env.AZURE_OPENAI_ENDPOINT || '').replace(/\/+$/, '');
  const apiKey = process.env.AZURE_OPENAI_API_KEY;
  const deployment = process.env.AZURE_OPENAI_DEPLOYMENT;
  if (!endpoint || !apiKey || !deployment) return null;
  return {
    client: new OpenAI({ baseURL: `${endpoint}/openai/v1/`, apiKey }),
    model: deployment,
  };
}

const AI_CONFIG_ERROR = 'AZURE_OPENAI_ENDPOINT, AZURE_OPENAI_API_KEY oder AZURE_OPENAI_DEPLOYMENT nicht konfiguriert.';

// Prompt für die Tagesstatistik-Analyse (Standard: die letzten N Tage, Monatsbericht: ein Kalendermonat)
function buildDailyStatsMessages(entries, periodLabel = `der letzten ${entries.length} Tage`) {
  const statsJson = JSON.stringify(entries.map((d) => ({
    date: d.date,
    total: d.visitsTotal ?? 0,
    human: d.visitsHuman ?? 0,
    unclear: d.visitsUnclear ?? 0,
    bot: d.visitsBots ?? 0,
    ai: d.visitsAi ?? 0,
  })));

  return [
    {
      role: 'system',
      content:
        'Du bist ein Webanalyse-Experte. Du bekommst Tagesstatistiken einer Website als JSON mit den Feldern ' +
        'date (Datum), total (Gesamtaufrufe), human (Besucher mit Browser-Verhalten), unclear (Besucher ohne erkennbares Browser-Verhalten, ' +
        'vermutlich überwiegend getarnte Bots), bot (Bots), ai (KI-Crawler). ' +
        'Analysiere die Daten auf Deutsch und berichte über: Trends bei menschlichen Besuchern, ' +
        'Bot-Auffälligkeiten oder Angriffsmuster, KI-Crawler-Entwicklung, Wochentags-Muster, ' +
        'besondere Ausreißer und konkrete Handlungsempfehlungen. Antworte strukturiert mit Überschriften.',
    },
    {
      role: 'user',
      content: `Hier sind die Tagesstatistiken ${periodLabel}:\n${statsJson}`,
    },
  ];
}

// Sampelt Apache-Logzeilen (logFiles: neueste zuerst) und baut den Rohdaten-Prompt
function buildRawSampleMessages(logFiles) {
  // Pro Datei max. 300 Zeilen sampeln – nur Einträge zwischen 10:00 und 16:00 Uhr
  const SAMPLE_PER_FILE = 300;
  const sampleLines = [];

  // Apache-Zeitformat: [31/Mar/2026:14:23:01 +0200] → Stunde und Minute extrahieren
  const timeInWindowRegex = /\[[\d]{2}\/\w+\/\d{4}:(\d{2}):(\d{2}):\d{2} [+\-]\d{4}\]/;

  for (const name of logFiles) {
    const fullPath = path.join(extractedDirectory, name);
    const content = fs.readFileSync(fullPath, 'utf8');
    const lines = content.split('\n').filter((line) => {
      if (!line) return false;
      // Nur Zeilen für www.hrv.de
      if (!line.includes('www.hrv.de')) return false;
      // Statische Ressourcen und Bilder ignorieren
      if (/\.(ico|js|css|png|jpg|jpeg|gif|svg|webp|bmp|woff2?|ttf|eot)("| )/.test(line)) return false;
      // HTTP-Statuscode extrahieren: nach "GET /pfad HTTP/1.1" folgt der Status
      const statusMatch = /"\s+(\d{3})\s+/.exec(line);
      if (statusMatch) {
        const status = parseInt(statusMatch[1], 10);
        // 3xx und 404 ignorieren
        if (status >= 300 && status < 400) return false;
        if (status === 404) return false;
      }
      // Zeitfenster 07:30–21:00
      const m = timeInWindowRegex.exec(line);
      if (!m) return false;
      const totalMinutes = parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
      return totalMinutes >= 7 * 60 + 30 && totalMinutes < 21 * 60;
    });
    // Von hinten sampeln → neueste Einträge der Datei zuerst
    const reversed = lines.slice().reverse();
    const step = Math.max(1, Math.floor(reversed.length / SAMPLE_PER_FILE));
    for (let i = 0; i < reversed.length && sampleLines.length < logFiles.length * SAMPLE_PER_FILE; i += step) {
      sampleLines.push(reversed[i].replace(/\b(\d{1,3}\.\d{1,3}\.\d{1,3})\.0\b/g, '$1.*'));
    }
  }

  // Token-Budget: 8000 gesamt – ca. 600 für System-/User-Prompt-Overhead → 7400 für Rohdaten
  // Schätzung: 1 Token ≈ 4 Zeichen
  const TOKEN_BUDGET = 7400;
  let totalChars = 0;
  const budgetedLines = [];
  for (const line of sampleLines) {
    const lineChars = line.length + 1; // +1 für '\n'
    if (totalChars + lineChars > TOKEN_BUDGET * 4) break;
    budgetedLines.push(line);
    totalChars += lineChars;
  }

  const rawSample = budgetedLines.join('\n');
  const actualDays = logFiles.length;
  const dateFrom = logFiles[logFiles.length - 1].slice(7, 17);
  const dateTo = logFiles[0].slice(7, 17);
  const info = `Werte ${actualDays} Tag(e) aus (${dateFrom} bis ${dateTo}), ${budgetedLines.length} Log-Zeilen`;

  return {
    info,
    messages: [
      {
        role: 'system',
        content:
          'Du bist ein Webanalyse-Experte. Du bekommst eine repräsentative Auswahl von Apache-Access-Log-Zeilen ' +
          'des Auswertungszeitraums. Jede Zeile hat das Format: IP - - [Datum] "Methode Pfad Protokoll" Status Bytes Referer UserAgent. ' +
          'Analysiere auf Deutsch und berichte über: ' +
          '1) Häufigste aufgerufene Seiten/Pfade, ' +
          '2) Auffällige IP-Adressen oder Angriffsmuster (z.B. viele 4xx-Fehler, Scanner), ' +
          '3) HTTP-Statuscodes (Fehler 4xx/5xx häufig?), ' +
          '4) Bot- und KI-Crawler-User-Agents, ' +
          '5) Ungewöhnliche Anfragen oder Sicherheitshinweise, ' +
          '6) Konkrete Handlungsempfehlungen. ' +
          'Antworte strukturiert mit Überschriften.',
      },
      {
        role: 'user',
        content: `Analysiere diese ${budgetedLines.length} Apache-Log-Zeilen aus ${actualDays} Tagen (${dateFrom} bis ${dateTo}):\n\n${rawSample}`,
      },
    ],
  };
}

// Prompt für die GEO-Analyse der aggregierten KI-Zugriffe
function buildBotMessages(stats) {
  return [
    {
      role: 'system',
      content:
        'Du bist Experte für Webanalyse und Generative Engine Optimization (GEO). Du bekommst aggregierte Zugriffsdaten ' +
        'von KI-Crawlern und KI-Agenten auf eine Website (JSON). Felder: bots (je Crawler: purpose = training | search | user | ads | unbekannt, ' +
        'hits, ok = HTTP 2xx, redirects, notFound, otherErrors, topPages, special = Abrufe von robots.txt/llms.txt/sitemap), ' +
        'topPages (am häufigsten von KI abgefragte Seiten), topSections (Bereiche der Seite), notFoundPaths (von KI abgefragte, ' +
        'nicht existierende Pfade), daily (KI-Zugriffe pro Tag), aiSharePercent (Anteil KI an allen Seitenaufrufen). ' +
        'Antworte auf Deutsch, strukturiert mit Überschriften: ' +
        '1) Überblick (Umfang, Anteil, Entwicklung, Verteilung nach Training/Suche/Nutzeranfrage), ' +
        '2) Welche Crawler sind besonders aktiv und was bedeutet ihr Zweck, ' +
        '3) Welche Seiten und Bereiche werden besonders häufig abgefragt und was lässt das über das Interesse der KI vermuten, ' +
        '4) Auffälligkeiten (Fehler, 404er, Weiterleitungen, fehlende Abrufe von robots.txt/llms.txt; Abfragen sensibler Pfade wie ' +
        '/.env gehören nicht zu GEO, sondern sind als Sicherheitshinweis/möglicher Scanner mit gefälschtem KI-User-Agent zu nennen), ' +
        '5) Konkrete GEO-Empfehlungen, abgeleitet aus den Daten (z. B. Inhalte der meistgefragten Seiten ausbauen, ' +
        'klare Frage-Antwort-Struktur, strukturierte Daten/schema.org, Aktualität, Fehlerseiten beheben, robots.txt und llms.txt ' +
        'gezielt für Training vs. Suche steuern), priorisiert nach Wirkung. ' +
        'Nutze nur Zahlen aus den Daten, erfinde keine Werte und kennzeichne Annahmen als solche.',
    },
    {
      role: 'user',
      content: `Zeitraum ${stats.period.from} bis ${stats.period.to}. Aggregierte KI-Zugriffe:\n${JSON.stringify(stats)}`,
    },
  ];
}

// KI-Analyse der letzten 90 Tage via Azure OpenAI
app.post('/ai-analyze', async (req, res) => {
  const ai = getAiConfig();
  if (!ai) {
    return res.status(500).json({ success: false, error: AI_CONFIG_ERROR });
  }

  const dailyStats = loadDailyStats();
  const entries = Object.values(dailyStats)
    .filter((d) => d && d.date)
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(-90);

  if (!entries.length) {
    return res.status(400).json({ success: false, error: 'Keine Tagesstatistiken vorhanden. Bitte zuerst Dateien herunterladen und analysieren.' });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  try {
    const stream = await ai.client.chat.completions.create({
      model: ai.model,
      stream: true,
      messages: buildDailyStatsMessages(entries),
    });

    await relayStreamAndSave(res, stream, 'ai-analyze');
  } catch (err) {
    console.error('KI-Analyse Fehler:', err);
    res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
    res.end();
  }
});

// KI-Analyse der Rohdaten der letzten 30 Tage (access-YYYY-MM-DD.log)
app.post('/ai-analyze-raw', async (req, res) => {
  const ai = getAiConfig();
  if (!ai) {
    return res.status(500).json({ success: false, error: AI_CONFIG_ERROR });
  }

  if (!fs.existsSync(extractedDirectory)) {
    return res.status(400).json({ success: false, error: 'Kein unzipped-Verzeichnis gefunden.' });
  }

  // Letzte 30 Tage bestimmen
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 30);
  const cutoffStr = cutoff.toISOString().slice(0, 10);

  const logFiles = fs.readdirSync(extractedDirectory)
    .filter((name) => {
      const m = /^access-(\d{4}-\d{2}-\d{2})\.log$/.exec(name);
      return m && m[1] >= cutoffStr;
    })
    .sort().reverse();

  if (!logFiles.length) {
    return res.status(400).json({ success: false, error: 'Keine Log-Dateien der letzten 30 Tage gefunden.' });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  try {
    const { messages, info: rawInfo } = buildRawSampleMessages(logFiles);
    res.write(`data: ${JSON.stringify({ info: rawInfo })}\n\n`);

    const stream = await ai.client.chat.completions.create({
      model: ai.model,
      stream: true,
      messages,
    });

    await relayStreamAndSave(res, stream, 'ai-analyze-raw', `> ${rawInfo}\n\n`);
  } catch (err) {
    console.error('KI-Rohdaten-Analyse Fehler:', err);
    res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
    res.end();
  }
});

// Bekannte KI-Crawler/-Agenten; purpose: training (Modelltraining), search (KI-Suche/Index), user (durch Nutzerfrage ausgelöst), ads (Werbeprüfung)
const AI_BOTS = [
  { name: 'GPTBot', vendor: 'OpenAI', purpose: 'training', re: /gptbot/i },
  { name: 'OAI-SearchBot', vendor: 'OpenAI', purpose: 'search', re: /oai-searchbot/i },
  { name: 'ChatGPT-User', vendor: 'OpenAI', purpose: 'user', re: /chatgpt-user/i },
  { name: 'ClaudeBot', vendor: 'Anthropic', purpose: 'training', re: /claudebot|anthropic-ai/i },
  { name: 'Claude-SearchBot', vendor: 'Anthropic', purpose: 'search', re: /claude-searchbot/i },
  { name: 'Claude-User', vendor: 'Anthropic', purpose: 'user', re: /claude-user/i },
  { name: 'PerplexityBot', vendor: 'Perplexity', purpose: 'search', re: /perplexitybot/i },
  { name: 'Perplexity-User', vendor: 'Perplexity', purpose: 'user', re: /perplexity-user/i },
  { name: 'Google-Extended/GoogleOther', vendor: 'Google', purpose: 'training', re: /google-extended|googleother|google-cloudvertexbot/i },
  { name: 'Meta-ExternalAgent', vendor: 'Meta', purpose: 'training', re: /meta-externalagent|meta-externalfetcher|facebookbot/i },
  { name: 'Bytespider', vendor: 'ByteDance', purpose: 'training', re: /bytespider/i },
  { name: 'CCBot', vendor: 'Common Crawl', purpose: 'training', re: /ccbot/i },
  { name: 'Amazonbot', vendor: 'Amazon', purpose: 'search', re: /amazonbot/i },
  { name: 'DuckAssistBot', vendor: 'DuckDuckGo', purpose: 'search', re: /duckassistbot/i },
  { name: 'MistralAI-User', vendor: 'Mistral', purpose: 'user', re: /mistralai-user/i },
  { name: 'Cohere', vendor: 'Cohere', purpose: 'training', re: /cohere-ai|cohere-training/i },
  { name: 'Diffbot', vendor: 'Diffbot', purpose: 'training', re: /diffbot/i },
  { name: 'YouBot', vendor: 'You.com', purpose: 'search', re: /youbot/i },
  { name: 'AIWebIndex', vendor: 'Lyrenth', purpose: 'search', re: /aiwebindex/i },
  { name: 'OAI-AdsBot', vendor: 'OpenAI', purpose: 'ads', re: /oai-adsbot/i },
  { name: 'xAI-Grok', vendor: 'xAI', purpose: 'unbekannt', re: /xai-grok/i },
];
// Fallback analog zur Klassifizierung in den Tagesstatistiken
const AI_GENERIC_RE = /chatgpt|gpt|openai|copilot|oai-searchbot|ai-/i;
const STATIC_ASSET_RE = /\.(ico|js|css|png|jpg|jpeg|gif|svg|webp|bmp|woff2?|ttf|eot|map)$/i;
const AI_SPECIAL_FILE_RE = /^\/(robots\.txt|llms(-full)?\.txt|sitemap[^/]*\.xml)$/i;

function identifyAiBot(userAgent) {
  const ua = userAgent || '';
  const known = AI_BOTS.find((b) => b.re.test(ua));
  if (known) return known;
  if (AI_GENERIC_RE.test(ua)) return { name: 'Sonstige KI-Agenten', vendor: 'unbekannt', purpose: 'unbekannt' };
  return null;
}

// Wertet alle übergebenen Logdateien (aufsteigend sortiert) auf KI-Zugriffe aus
async function collectAiBotStats(logFiles) {
  const readline = require('readline');
  const logRegex = /^(\S+)\s+\S+\s+\S+\s+\[([^\]]+)\]\s+"(\S+)\s+([^\"]+)\s+\S+"\s+(\d{3})\s+\S+\s+(\S+)\s+"([^\"]*)"\s+"([^\"]*)"/;

  const bots = new Map();
  const pages = new Map();
  const sections = new Map();
  const notFound = new Map();
  const daily = new Map();
  let totalPageRequests = 0;
  let totalAiHits = 0;

  const top = (map, n) => Array.from(map.entries()).sort((a, b) => b[1] - a[1]).slice(0, n);

  for (const name of logFiles) {
    const date = name.slice(7, 17);
    const rl = readline.createInterface({
      input: fs.createReadStream(path.join(extractedDirectory, name), { encoding: 'utf8' }),
      crlfDelay: Infinity,
    });

    for await (const line of rl) {
      const m = logRegex.exec(line);
      if (!m) continue;
      const method = m[3];
      const status = parseInt(m[5], 10);
      const host = m[6];
      if (!config.relevantDomains.includes(host)) continue;
      if (method !== 'GET' && method !== 'HEAD') continue;

      const urlPath = m[4].split('?')[0];
      const isSpecial = AI_SPECIAL_FILE_RE.test(urlPath);
      if (!isSpecial && STATIC_ASSET_RE.test(urlPath)) continue;
      if (!isSpecial) totalPageRequests += 1;

      const bot = identifyAiBot(m[8]);
      if (!bot) continue;

      let b = bots.get(bot.name);
      if (!b) {
        b = {
          name: bot.name, vendor: bot.vendor, purpose: bot.purpose,
          hits: 0, ok: 0, redirects: 0, notFound: 0, otherErrors: 0,
          firstSeen: date, lastSeen: date, pages: new Map(), special: {},
        };
        bots.set(bot.name, b);
      }
      b.lastSeen = date;

      if (isSpecial) {
        b.special[urlPath] = (b.special[urlPath] || 0) + 1;
        continue;
      }

      b.hits += 1;
      totalAiHits += 1;
      daily.set(date, (daily.get(date) || 0) + 1);

      if (status >= 200 && status < 300) {
        b.ok += 1;
        b.pages.set(urlPath, (b.pages.get(urlPath) || 0) + 1);
        const p = pages.get(urlPath) || { hits: 0, bots: new Set() };
        p.hits += 1;
        p.bots.add(bot.name);
        pages.set(urlPath, p);
        const section = '/' + (urlPath.split('/')[1] || '');
        sections.set(section, (sections.get(section) || 0) + 1);
      } else if (status >= 300 && status < 400) {
        b.redirects += 1;
      } else if (status === 404) {
        b.notFound += 1;
        notFound.set(urlPath, (notFound.get(urlPath) || 0) + 1);
      } else {
        b.otherErrors += 1;
      }
    }
  }

  const botList = Array.from(bots.values()).sort((a, b) => b.hits - a.hits);
  const byPurpose = {};
  for (const b of botList) byPurpose[b.purpose] = (byPurpose[b.purpose] || 0) + b.hits;

  return {
    totalPageRequests,
    totalAiHits,
    aiSharePercent: totalPageRequests ? Number(((totalAiHits / totalPageRequests) * 100).toFixed(2)) : 0,
    byPurpose,
    bots: botList.map((b) => ({
      name: b.name, vendor: b.vendor, purpose: b.purpose,
      hits: b.hits, ok: b.ok, redirects: b.redirects, notFound: b.notFound, otherErrors: b.otherErrors,
      firstSeen: b.firstSeen, lastSeen: b.lastSeen, special: b.special,
      topPages: top(b.pages, 8).map(([p, hits]) => ({ path: p, hits })),
    })),
    topPages: Array.from(pages.entries())
      .sort((a, b) => b[1].hits - a[1].hits)
      .slice(0, 25)
      .map(([p, v]) => ({ path: p, hits: v.hits, bots: Array.from(v.bots) })),
    topSections: top(sections, 10).map(([p, hits]) => ({ section: p, hits })),
    notFoundPaths: top(notFound, 10).map(([p, hits]) => ({ path: p, hits })),
    daily: Array.from(daily.entries()).sort((a, b) => a[0].localeCompare(b[0])).map(([date, hits]) => ({ date, hits })),
  };
}

// Gesonderte Analyse der KI-Zugriffe der letzten 30 Tage inkl. GEO-Empfehlungen
app.post('/ai-bot-analyze', async (req, res) => {
  const ai = getAiConfig();
  if (!ai) {
    return res.status(500).json({ success: false, error: AI_CONFIG_ERROR });
  }

  if (!fs.existsSync(extractedDirectory)) {
    return res.status(400).json({ success: false, error: 'Kein unzipped-Verzeichnis gefunden.' });
  }

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 30);
  const cutoffStr = cutoff.toISOString().slice(0, 10);

  const logFiles = fs.readdirSync(extractedDirectory)
    .filter((name) => {
      const m = /^access-(\d{4}-\d{2}-\d{2})\.log$/.exec(name);
      return m && m[1] >= cutoffStr;
    })
    .sort();

  if (!logFiles.length) {
    return res.status(400).json({ success: false, error: 'Keine Log-Dateien der letzten 30 Tage gefunden.' });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  try {
    const stats = await collectAiBotStats(logFiles);
    const dateFrom = logFiles[0].slice(7, 17);
    const dateTo = logFiles[logFiles.length - 1].slice(7, 17);
    stats.period = { from: dateFrom, to: dateTo, days: logFiles.length };

    if (!stats.totalAiHits) {
      res.write(`data: ${JSON.stringify({ error: 'Im Zeitraum wurden keine KI-Zugriffe gefunden.' })}\n\n`);
      return res.end();
    }

    const stream = await ai.client.chat.completions.create({
      model: ai.model,
      stream: true,
      messages: buildBotMessages(stats),
    });

    await relayStreamAndSave(res, stream, 'ai-bot-analyze', `${statsToMarkdown(stats)}\n\n---\n\n`);
  } catch (err) {
    console.error('KI-Zugriffsanalyse Fehler:', err);
    res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
    res.end();
  }
});

// ---------- Monatsbericht (PDF) ----------
const reportsDirectory = path.join(localDirectory, 'reports');
const MONTH_REGEX = /^\d{4}-(0[1-9]|1[0-2])$/;
let reportInProgress = false;

function reportFileName(month) {
  return `webstat-monatsbericht-${month}.pdf`;
}

function monthLabel(month) {
  return new Date(`${month}-15T12:00:00`).toLocaleDateString('de-DE', { month: 'long', year: 'numeric' });
}

// Logdateien eines Monats, aufsteigend nach Datum
function monthLogFiles(month) {
  if (!fs.existsSync(extractedDirectory)) return [];
  return fs.readdirSync(extractedDirectory)
    .filter((name) => {
      const m = /^access-(\d{4}-\d{2})-\d{2}\.log$/.exec(name);
      return m && m[1] === month;
    })
    .sort();
}

// Top-Referrer (externe Quellen, nur HTTP 200) aus den übergebenen Logdateien
function collectTopReferrers(logFiles, limit) {
  const logRegex = /^(\S+)\s+\S+\s+\S+\s+\[([^\]]+)\]\s+"(\S+)\s+([^\"]+)\s+\S+"\s+(\d{3})\s+\S+\s+(\S+)\s+"([^\"]*)"\s+"([^\"]*)"/;
  const referrerCounts = new Map();

  for (const fileName of logFiles) {
    const lines = fs.readFileSync(path.join(extractedDirectory, fileName), 'utf8').split('\n');

    for (const line of lines) {
      const match = logRegex.exec(line);
      if (!match) continue;

      const status = match[5];
      const host = match[6];
      const referrer = match[7];

      // Nur 200er berücksichtigen
      if (status !== '200') continue;

      // Nur relevante Domains berücksichtigen
      if (!config.relevantDomains.includes(host)) continue;

      // Leere, "-" oder interne Referrer ignorieren (interne = relevante Domains)
      if (!referrer || referrer === '-') continue;
      if (config.relevantDomains.some((d) => referrer.includes(d))) continue;

      referrerCounts.set(referrer, (referrerCounts.get(referrer) || 0) + 1);
    }
  }

  return Array.from(referrerCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([url, count]) => ({ url, count }));
}

// Verfügbare Monate (aus den Logdateien) samt Vollständigkeit und vorhandenem PDF
function listReportMonths() {
  const months = new Map();
  if (fs.existsSync(extractedDirectory)) {
    for (const name of fs.readdirSync(extractedDirectory)) {
      const m = /^access-(\d{4}-\d{2})-\d{2}\.log$/.exec(name);
      if (m) months.set(m[1], (months.get(m[1]) || 0) + 1);
    }
  }
  const currentMonth = localDateString().slice(0, 7);

  return Array.from(months.entries())
    .sort((a, b) => b[0].localeCompare(a[0]))
    .map(([month, days]) => {
      const [year, mon] = month.split('-').map(Number);
      const pdfPath = path.join(reportsDirectory, reportFileName(month));
      const stat = fs.existsSync(pdfPath) ? fs.statSync(pdfPath) : null;
      return {
        month,
        label: monthLabel(month),
        days,
        daysInMonth: new Date(year, mon, 0).getDate(),
        isCurrentMonth: month === currentMonth,
        pdf: stat ? { createdAt: stat.mtime.toISOString(), size: stat.size } : null,
      };
    });
}

// Monat vor dem übergebenen Monat (YYYY-MM)
function previousMonth(month) {
  const [year, mon] = month.split('-').map(Number);
  const d = new Date(year, mon - 2, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

// Kennzahlen für den Laien-Artikel; Veränderungen werden hier berechnet, damit das Modell nicht rechnen muss
function buildSummaryPayload({ label, coverage, daily, aiStats, previous, previousNote }) {
  const describe = (days, cov, aiTotals) => {
    const s = summarizeDaily(days);
    const raw = {
      besuche_gesamt: s.perDay.total,
      browser_besucher: s.perDay.human,
      unklar_vermutlich_bots: s.perDay.unclear,
      bots: s.perDay.bots,
      ki_crawler_besucher: s.perDay.ai,
    };
    if (aiTotals && aiTotals.totalAiHits) raw.ki_seitenabrufe = aiTotals.totalAiHits / cov.days;
    return {
      raw,
      data: {
        tage_mit_statistik: s.days,
        tage_im_monat: cov.daysInMonth,
        pro_tag: Object.fromEntries(Object.entries(raw).map(([key, value]) => [key, Math.round(value)])),
        ...(aiTotals ? { ki_anteil_an_seitenabrufen_prozent: aiTotals.aiSharePercent } : {}),
      },
    };
  };

  const current = describe(daily, coverage, aiStats);
  const payload = { monat: label, laufender_monat: coverage.isCurrentMonth, daten: current.data, vormonat: null, veraenderung_pro_tag_prozent: null };
  if (previous) {
    const prev = describe(previous.daily, previous.coverage, previous.aiTotals);
    payload.vormonat = { monat: previous.monthLabel, ...prev.data };
    // Gleiche Basis wie die Vergleichstabelle im PDF (ungerundete Tagesdurchschnitte)
    payload.veraenderung_pro_tag_prozent = Object.fromEntries(
      Object.keys(current.raw)
        .filter((key) => prev.raw[key])
        .map((key) => [key, Math.round(((current.raw[key] - prev.raw[key]) / prev.raw[key]) * 1000) / 10])
    );
  } else if (previousNote) {
    payload.hinweis_vormonat = previousNote;
  }
  return payload;
}

// Kurzer, allgemeinverständlicher Artikel über den Monat (mit Vormonatsvergleich, falls vorhanden)
function buildSummaryMessages(payload) {
  return [
    {
      role: 'system',
      content:
        'Du schreibst für Geschäftsführer ohne technisches Vorwissen einen kurzen, gut lesbaren Artikel über die Besuche auf einer Website in einem Monat. ' +
        'Regeln: Deutsch, Fließtext in 3 bis 4 kurzen Absätzen (insgesamt 150 bis 220 Wörter), keine Überschriften, keine Aufzählungen, keine Tabellen, keine Emojis. ' +
        'Beginne mit der wichtigsten Aussage. Vermeide Fachbegriffe oder erkläre sie in einem Halbsatz ' +
        '(Bot = automatisches Programm; KI-Crawler = Programm von KI-Anbietern, das Webseiten liest; ' +
        '"unklar" = Besuche ohne erkennbares Browser-Verhalten, vermutlich überwiegend automatisierte Zugriffe). ' +
        'Die Zahl der Besucher mit Browser-Verhalten ist die bestmögliche Schätzung echter Menschen; weise einmal darauf hin, dass es eine Schätzung ist. ' +
        'Wenn ein Vormonat vorhanden ist, vergleiche anhand der Werte pro Tag (nicht der Monatssummen) und nenne zwei bis drei Zahlen mit der gelieferten Veränderung in Prozent. ' +
        'Ist kein Vormonat vorhanden, erwähne das in einem Satz. Weise bei laufendem Monat oder Lücken in den Daten kurz darauf hin. ' +
        'Liegt der Vormonat nur teilweise vor (tage_mit_statistik kleiner als tage_im_monat), sage ausdrücklich, dass der Vergleich nur eingeschränkt aussagekräftig ist. ' +
        'Verwende ausschließlich gelieferte Zahlen, rechne nichts selbst nach und erfinde keine Ursachen; Vermutungen kennzeichnest du als solche. ' +
        'Nenne höchstens fünf Zahlen, ohne Nachkommastellen, Prozentwerte auf ganze Zahlen gerundet ("etwa 15 %"), und sprich von Besuchen pro Tag. ' +
        'Gehe nicht auf technische Fehlercodes ein. ' +
        'Schließe mit einem Satz, was das für die Website bedeutet.',
    },
    { role: 'user', content: `Daten (JSON):\n${JSON.stringify(payload)}` },
  ];
}

// Sammelt alle Daten eines Monats und führt die KI-Analysen für genau diesen Zeitraum aus
async function buildMonthlyReportData(month, progress) {
  const logFiles = monthLogFiles(month);
  const [year, mon] = month.split('-').map(Number);
  const label = monthLabel(month);
  const from = logFiles[0].slice(7, 17);
  const to = logFiles[logFiles.length - 1].slice(7, 17);

  const allDaily = Object.values(loadDailyStats());
  const monthDaily = (m) => allDaily
    .filter((d) => d && d.date && d.date.startsWith(`${m}-`))
    .sort((a, b) => a.date.localeCompare(b.date));
  const daily = monthDaily(month);

  progress('Werte Referrer aus…');
  const referrers = collectTopReferrers(logFiles, 15);

  progress('Werte KI-Zugriffe aus…');
  const aiStats = await collectAiBotStats(logFiles);
  aiStats.period = { from, to, days: logFiles.length };

  // Vormonat für den Vergleich; nur mit Statistiken der aktuellen Klassifizierung vergleichbar
  const prevMonth = previousMonth(month);
  const prevLogFiles = monthLogFiles(prevMonth);
  const prevDaily = monthDaily(prevMonth);
  let previous = null;
  let previousNote = null;
  if (!prevDaily.length) {
    previousNote = 'Für den Vormonat liegen keine Tagesstatistiken vor, ein Vergleich ist daher nicht möglich.';
  } else if (prevDaily.some((d) => d.visitsUnclear === undefined)) {
    previousNote = 'Die Tagesstatistik des Vormonats stammt aus einer älteren Klassifizierung und ist nicht vergleichbar. Bitte im Reiter "Statistik" die Tagesstatistiken neu berechnen.';
  } else {
    progress('Werte Vormonat aus…');
    let aiTotals = null;
    if (prevLogFiles.length) {
      const s = await collectAiBotStats(prevLogFiles);
      aiTotals = { totalAiHits: s.totalAiHits, totalPageRequests: s.totalPageRequests, aiSharePercent: s.aiSharePercent };
    }
    const [prevYear, prevMon] = prevMonth.split('-').map(Number);
    previous = {
      month: prevMonth,
      monthLabel: monthLabel(prevMonth),
      daily: prevDaily,
      coverage: { days: prevLogFiles.length || prevDaily.length, daysInMonth: new Date(prevYear, prevMon, 0).getDate() },
      aiTotals,
    };
  }

  const coverage = {
    from,
    to,
    days: logFiles.length,
    daysInMonth: new Date(year, mon, 0).getDate(),
    isCurrentMonth: month === localDateString().slice(0, 7),
  };

  const ai = getAiConfig();
  const analyses = [];
  const runAnalysis = async (key, title, unavailable, getMessages) => {
    progress(`KI-Analyse: ${title}…`);
    if (unavailable) return analyses.push({ key, error: unavailable });
    if (!ai) return analyses.push({ key, error: AI_CONFIG_ERROR });
    try {
      const result = await ai.client.chat.completions.create({ model: ai.model, messages: getMessages() });
      return analyses.push({ key, markdown: result.choices[0]?.message?.content || '' });
    } catch (err) {
      console.error(`Monatsbericht ${month}: KI-Analyse "${title}" fehlgeschlagen:`, err);
      return analyses.push({ key, error: err.message });
    }
  };

  await runAnalysis('summary', 'Zusammenfassung', daily.length ? null : 'Keine Tagesstatistiken für diesen Monat.',
    () => buildSummaryMessages(buildSummaryPayload({ label, coverage, daily, aiStats, previous, previousNote })));
  await runAnalysis('trend', 'Trendanalyse', daily.length ? null : 'Keine Tagesstatistiken für diesen Monat.',
    () => buildDailyStatsMessages(daily, `des Monats ${label} (${daily.length} Tage)`));
  await runAnalysis('raw', 'Rohdaten', null,
    () => buildRawSampleMessages([...logFiles].reverse()).messages);
  await runAnalysis('geo', 'GEO-Empfehlungen', aiStats.totalAiHits ? null : 'Keine KI-Zugriffe im Zeitraum.',
    () => buildBotMessages(aiStats));

  return {
    month,
    monthLabel: label,
    sites: config.relevantDomains,
    createdAt: new Date().toLocaleString('de-DE'),
    model: ai ? ai.model : null,
    coverage,
    daily,
    referrers,
    aiStats,
    previous,
    previousNote,
    analyses,
  };
}

app.get('/reports/months', (req, res) => {
  res.json({ success: true, months: listReportMonths() });
});

app.post('/reports/generate', async (req, res) => {
  const month = String((req.body && req.body.month) || '');
  if (!MONTH_REGEX.test(month) || !listReportMonths().some((m) => m.month === month)) {
    return res.status(400).json({ success: false, error: 'Ungültiger oder nicht verfügbarer Monat.' });
  }
  if (reportInProgress) {
    return res.status(409).json({ success: false, error: 'Es läuft bereits eine Berichtserstellung.' });
  }
  reportInProgress = true;

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  const send = (event) => res.write(`data: ${JSON.stringify(event)}\n\n`);

  try {
    const data = await buildMonthlyReportData(month, (info) => send({ info }));
    send({ info: 'Erzeuge PDF…' });
    const buffer = await createMonthlyReportPdf(data);
    fs.mkdirSync(reportsDirectory, { recursive: true });
    fs.writeFileSync(path.join(reportsDirectory, reportFileName(month)), buffer);
    send({ done: true, month });
  } catch (err) {
    console.error('Monatsbericht Fehler:', err);
    send({ error: err.message });
  } finally {
    reportInProgress = false;
    res.end();
  }
});

app.get('/reports/download', (req, res) => {
  const month = String(req.query.month || '');
  if (!MONTH_REGEX.test(month)) {
    return res.status(400).json({ success: false, error: 'Ungültiger Monat.' });
  }
  const filePath = path.join(reportsDirectory, reportFileName(month));
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ success: false, error: 'Für diesen Monat wurde noch kein PDF erstellt.' });
  }
  const disposition = req.query.inline === '1' ? 'inline' : 'attachment';
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `${disposition}; filename="${reportFileName(month)}"`);
  res.sendFile(filePath);
});

app.listen(PORT, () => {
  console.log(`Server läuft auf http://localhost:${PORT}`);
});

'use strict';

// Erzeugt den Monatsbericht als PDF (pdfmake) aus aufbereiteten Daten und Markdown-Analysen.
const path = require('path');
const pdfmake = require('pdfmake');
const { marked } = require('marked');

pdfmake.addFonts(require('pdfmake/fonts/Roboto.js'));
pdfmake.addFonts(require('pdfmake/standard-fonts/Courier.js'));

// Berichtsinhalte stammen teils aus Logdaten: keine externen Ressourcen, lokal nur die mitgelieferten Schriften
const pdfmakeRoot = path.dirname(require.resolve('pdfmake/package.json'));
pdfmake.setUrlAccessPolicy(() => false);
pdfmake.setLocalAccessPolicy((filePath) => /^Courier(-\w+)?$/.test(filePath) || path.resolve(filePath).startsWith(pdfmakeRoot));

const PAGE_MARGINS = [48, 60, 48, 56];
const CONTENT_WIDTH = 595.28 - PAGE_MARGINS[0] - PAGE_MARGINS[2];
const COLORS = {
  accent: '#1f4f8f',
  accent2: '#2d6a9f',
  head: '#e8eef7',
  zebra: '#f6f7f9',
  line: '#cfd6df',
  muted: '#666666',
  human: '#3b82c4',
  unclear: '#9aa4af',
  bot: '#e0a030',
  ai: '#7a5ac8',
};
const WEEKDAYS = ['Sonntag', 'Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag'];
const PURPOSE_LABELS = { training: 'Training', search: 'KI-Suche', user: 'Nutzeranfrage', ads: 'Werbeprüfung', unbekannt: 'unbekannt' };

const fmt = (n) => Number(n || 0).toLocaleString('de-DE');
const pct = (part, total) => (total ? `${((part / total) * 100).toLocaleString('de-DE', { maximumFractionDigits: 1 })} %` : '–');
const fmtDate = (iso) => `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}`;
const weekdayOf = (iso) => new Date(`${iso}T12:00:00`).getDay();

// Emojis und Symbole außerhalb der eingebetteten Schrift würden als leere Kästchen erscheinen
function clean(text) {
  return String(text ?? '').replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}]/gu, '');
}

function heading(text, level, extra = {}) {
  const node = { text, style: `h${level}`, ...extra };
  if (level <= 2) {
    node.tocItem = true;
    node.tocStyle = { fontSize: level === 1 ? 10.5 : 9.5, bold: level === 1 };
    node.tocMargin = level === 1 ? [0, 5, 0, 1] : [14, 0, 0, 0];
  }
  return node;
}

const zebraLayout = {
  hLineWidth: () => 0.5,
  vLineWidth: () => 0,
  hLineColor: () => COLORS.line,
  paddingTop: () => 3,
  paddingBottom: () => 3,
  paddingLeft: () => 5,
  paddingRight: () => 5,
  fillColor: (row) => (row === 0 ? COLORS.head : row % 2 === 0 ? COLORS.zebra : null),
};

function dataTable({ headers, rows, widths, align = [], fontSize = 8.5 }) {
  const head = headers.map((h, i) => ({ text: h, bold: true, color: COLORS.accent, alignment: align[i] || 'left' }));
  const body = rows.map((r) => r.map((c, i) => ({ text: clean(c), alignment: align[i] || 'left' })));
  return {
    table: { headerRows: 1, dontBreakRows: true, widths: widths || headers.map(() => '*'), body: [head, ...body] },
    layout: zebraLayout,
    fontSize,
    margin: [0, 0, 0, 10],
  };
}

function note(text) {
  return { text, italics: true, color: COLORS.muted, fontSize: 9, margin: [0, 0, 0, 8] };
}

// ---------- Markdown -> pdfmake ----------

function inline(tokens, base = {}) {
  const out = [];
  for (const t of tokens || []) {
    switch (t.type) {
      case 'text':
      case 'escape':
        if (t.tokens && t.tokens.length) out.push(...inline(t.tokens, base));
        else out.push({ ...base, text: clean(t.text) });
        break;
      case 'strong':
        out.push(...inline(t.tokens, { ...base, bold: true }));
        break;
      case 'em':
        out.push(...inline(t.tokens, { ...base, italics: true }));
        break;
      case 'del':
        out.push(...inline(t.tokens, { ...base, decoration: 'lineThrough' }));
        break;
      case 'codespan':
        out.push({ ...base, text: clean(t.text), font: 'Courier', fontSize: (base.fontSize || 10) - 1, background: '#eeeeee' });
        break;
      case 'link': {
        const safe = /^https?:\/\//i.test(t.href || '');
        out.push(...inline(t.tokens, safe ? { ...base, color: '#1f6feb', decoration: 'underline', link: t.href } : base));
        break;
      }
      case 'br':
        out.push({ ...base, text: '\n' });
        break;
      case 'image':
        out.push({ ...base, text: clean(t.text) });
        break;
      case 'html': {
        const txt = String(t.raw || '').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '');
        if (txt) out.push({ ...base, text: clean(txt) });
        break;
      }
      default:
        if (t.raw) out.push({ ...base, text: clean(t.raw) });
    }
  }
  return out;
}

function plainText(tokens) {
  return inline(tokens).map((p) => p.text).join('').replace(/\s+/g, ' ').trim();
}

function listItems(items) {
  return items.map((item) => {
    const parts = [];
    for (const t of item.tokens || []) {
      if (t.type === 'text' || t.type === 'paragraph') {
        parts.push({ text: inline(t.tokens || [{ type: 'text', text: t.text }]) });
      } else {
        parts.push(...blocks([t]));
      }
    }
    return parts.length === 1 ? parts[0] : { stack: parts };
  });
}

function blocks(tokens) {
  const out = [];
  for (const t of tokens) {
    switch (t.type) {
      case 'heading': {
        // Überschriften der Analysetexte liegen unterhalb der Berichts-Kapitel (H1)
        const level = t.depth <= 2 ? 2 : t.depth === 3 ? 3 : 4;
        out.push(heading(plainText(t.tokens), level));
        break;
      }
      case 'paragraph':
        out.push({ text: inline(t.tokens), margin: [0, 0, 0, 6] });
        break;
      case 'text':
        out.push({ text: inline(t.tokens || [{ type: 'text', text: t.text }]), margin: [0, 0, 0, 4] });
        break;
      case 'list': {
        const node = { [t.ordered ? 'ol' : 'ul']: listItems(t.items), margin: [0, 0, 0, 6] };
        if (t.ordered && t.start) node.start = Number(t.start);
        out.push(node);
        break;
      }
      case 'table': {
        const head = t.header.map((c) => ({ text: inline(c.tokens, { bold: true, color: COLORS.accent }), alignment: c.align || 'left' }));
        const rows = t.rows.map((r) => r.map((c) => ({ text: inline(c.tokens), alignment: c.align || 'left' })));
        out.push({
          table: { headerRows: 1, dontBreakRows: true, widths: t.header.map(() => '*'), body: [head, ...rows] },
          layout: zebraLayout,
          fontSize: 8.5,
          margin: [0, 2, 0, 10],
        });
        break;
      }
      case 'code':
        out.push({
          table: { widths: ['*'], body: [[{ text: clean(t.text), font: 'Courier', fontSize: 8.5, preserveLeadingSpaces: true }]] },
          layout: { hLineWidth: () => 0.5, vLineWidth: () => 0.5, hLineColor: () => COLORS.line, vLineColor: () => COLORS.line, fillColor: () => '#f4f4f4' },
          margin: [0, 2, 0, 8],
        });
        break;
      case 'blockquote':
        out.push({
          table: { widths: ['*'], body: [[{ stack: blocks(t.tokens), color: '#444444' }]] },
          layout: {
            hLineWidth: () => 0,
            vLineWidth: (i) => (i === 0 ? 2.5 : 0),
            vLineColor: () => '#9bb8d9',
            paddingLeft: () => 8,
            paddingTop: () => 2,
            paddingBottom: () => 0,
          },
          margin: [0, 2, 0, 6],
        });
        break;
      case 'hr':
        out.push({ canvas: [{ type: 'line', x1: 0, y1: 0, x2: CONTENT_WIDTH, y2: 0, lineWidth: 0.5, lineColor: COLORS.line }], margin: [0, 6, 0, 8] });
        break;
      default:
        break; // space, html
    }
  }
  return out;
}

function markdownToPdf(md) {
  return blocks(marked.lexer(String(md || '')));
}

// ---------- Berichtsteile ----------

// Summen und Tagesdurchschnitte einer Liste von Tagesstatistiken
function summarizeDaily(daily) {
  const sum = (key) => daily.reduce((s, d) => s + (d[key] || 0), 0);
  const days = daily.length;
  const totals = {
    total: sum('visitsTotal'),
    human: sum('visitsHuman'),
    unclear: sum('visitsUnclear'),
    bots: sum('visitsBots'),
    ai: sum('visitsAi'),
    errors4xx: sum('errors4xx'),
    errors429: sum('errors429'),
  };
  const perDay = Object.fromEntries(Object.entries(totals).map(([key, value]) => [key, days ? value / days : 0]));
  return { days, totals, perDay };
}

// Kurzer, für Laien geschriebener Artikel (vom Modell erzeugt) am Anfang des Berichts
function summarySection(analysis) {
  const head = heading('Das Wichtigste in Kürze', 2);
  if (!analysis || !analysis.markdown) {
    return [head, note(`Die Zusammenfassung ist nicht verfügbar${analysis && analysis.error ? `: ${analysis.error}` : '.'}`)];
  }
  const text = analysis.markdown.replace(/^#{1,6}\s+/gm, '');
  return [
    head,
    {
      table: { widths: ['*'], body: [[{ stack: markdownToPdf(text), fontSize: 10.5 }]] },
      layout: {
        hLineWidth: () => 0,
        vLineWidth: (i) => (i === 0 ? 3 : 0),
        vLineColor: () => COLORS.accent2,
        paddingLeft: () => 12,
        paddingRight: () => 10,
        paddingTop: () => 8,
        paddingBottom: () => 2,
        fillColor: () => '#f3f7fc',
      },
      margin: [0, 0, 0, 4],
    },
    note('Dieser Text wurde automatisch mit Azure OpenAI auf Basis der unten stehenden Kennzahlen erstellt.'),
  ];
}

// Vergleich der Tagesdurchschnitte mit dem Vormonat (Monatslängen und Datenlücken sollen das Ergebnis nicht verfälschen)
function comparisonSection(data) {
  const head = heading('Vergleich mit dem Vormonat', 2);
  const prevData = data.previous;
  if (!prevData || !prevData.daily.length || !data.daily.length) {
    return [head, note(data.previousNote || 'Für den Vormonat liegen keine Tagesstatistiken vor, ein Vergleich ist daher nicht möglich.')];
  }
  const cur = summarizeDaily(data.daily);
  const prev = summarizeDaily(prevData.daily);
  const change = (c, p) => (p ? `${c >= p ? '+' : '−'}${Math.abs(((c - p) / p) * 100).toLocaleString('de-DE', { maximumFractionDigits: 1 })} %` : '–');
  const avg = (v) => fmt(Math.round(v));

  const rows = [
    ['Besuche gesamt', 'total'],
    ['Besucher mit Browser-Verhalten', 'human'],
    ['Unklar (vermutlich Bots)', 'unclear'],
    ['Bots', 'bots'],
    ['KI-Crawler (Besucher)', 'ai'],
    ['4xx-Fehler', 'errors4xx'],
  ].map(([label, key]) => [label, avg(cur.perDay[key]), avg(prev.perDay[key]), change(cur.perDay[key], prev.perDay[key])]);

  const curAi = data.aiStats && data.aiStats.totalAiHits;
  const prevAi = prevData.aiTotals && prevData.aiTotals.totalAiHits;
  if (curAi && prevAi) {
    const c = curAi / data.coverage.days;
    const p = prevAi / prevData.coverage.days;
    rows.push(['KI-Seitenabrufe', avg(c), avg(p), change(c, p)]);
  }

  return [
    {
      unbreakable: true,
      stack: [
        head,
        dataTable({
          headers: ['Ø pro Tag', data.monthLabel, prevData.monthLabel, 'Veränderung'],
          rows,
          widths: ['*', 90, 90, 70],
          align: ['left', 'right', 'right', 'right'],
          fontSize: 9.5,
        }),
        note(`Datenbasis: ${cur.days} Tage (${data.monthLabel}) bzw. ${prev.days} Tage (${prevData.monthLabel}). Verglichen werden Tagesdurchschnitte.`),
      ],
    },
  ];
}

function kpiSection(daily) {
  const sum = (key) => daily.reduce((s, d) => s + (d[key] || 0), 0);
  const total = sum('visitsTotal');
  const human = sum('visitsHuman');
  const unclear = sum('visitsUnclear');
  const bots = sum('visitsBots');
  const ai = sum('visitsAi');
  const days = daily.length || 1;
  const byHuman = [...daily].sort((a, b) => (b.visitsHuman || 0) - (a.visitsHuman || 0));
  const peak = byHuman[0];
  const low = byHuman[byHuman.length - 1];

  const rows = [
    ['Besuche gesamt', fmt(total), `Ø ${fmt(Math.round(total / days))} pro Tag`],
    ['Besucher mit Browser-Verhalten', fmt(human), pct(human, total)],
    ['Unklar (vermutlich Bots)', fmt(unclear), pct(unclear, total)],
    ['Bots', fmt(bots), pct(bots, total)],
    ['KI-Crawler (Besucher)', fmt(ai), pct(ai, total)],
  ];
  if (peak) rows.push(['Stärkster Tag (Browser-Besucher)', fmt(peak.visitsHuman), `${fmtDate(peak.date)}, ${WEEKDAYS[weekdayOf(peak.date)]}`]);
  if (low) rows.push(['Schwächster Tag (Browser-Besucher)', fmt(low.visitsHuman), `${fmtDate(low.date)}, ${WEEKDAYS[weekdayOf(low.date)]}`]);
  rows.push(['4xx-Fehler gesamt', fmt(sum('errors4xx')), `davon 429 (Rate-Limit): ${fmt(sum('errors429'))}`]);

  return [
    heading('Kennzahlen im Überblick', 2),
    dataTable({ headers: ['Kennzahl', 'Wert', 'Anteil / Anmerkung'], rows, widths: [170, 90, '*'], align: ['left', 'right', 'left'], fontSize: 9.5 }),
    note('Besuche = eindeutige Kombinationen aus IP und User-Agent mit mindestens einem erfolgreichen Abruf (HTTP 200) pro Tag. ' +
      'Browser-Verhalten = Stylesheets, Skripte oder Bilder werden nachgeladen oder mehrere Seiten abgerufen. ' +
      'Unklar = nur eine einzelne Seite ohne Nachladen, meist Skripte oder Bots mit gefälschtem Browser-User-Agent. ' +
      'Bots umfassen auch Werkzeuge wie curl, Python oder Headless-Browser.'),
  ];
}

function dailyChart(daily) {
  const H = 140;
  const n = daily.length;
  const max = Math.max(1, ...daily.map((d) => d.visitsTotal || 0));
  const slot = CONTENT_WIDTH / n;
  const barW = slot * 0.72;
  const canvas = [
    { type: 'line', x1: 0, y1: H / 2, x2: CONTENT_WIDTH, y2: H / 2, lineWidth: 0.3, lineColor: COLORS.line },
    { type: 'line', x1: 0, y1: H, x2: CONTENT_WIDTH, y2: H, lineWidth: 0.8, lineColor: '#999999' },
  ];
  daily.forEach((d, i) => {
    const x = i * slot + (slot - barW) / 2;
    let y = H;
    for (const [key, color] of [['visitsHuman', COLORS.human], ['visitsUnclear', COLORS.unclear], ['visitsBots', COLORS.bot], ['visitsAi', COLORS.ai]]) {
      const h = ((d[key] || 0) / max) * H;
      y -= h;
      if (h > 0) canvas.push({ type: 'rect', x, y, w: barW, h, color });
    }
  });

  const swatch = (color) => ({ canvas: [{ type: 'rect', x: 0, y: 2, w: 8, h: 8, color }], width: 12 });
  return [
    {
      columns: [
        swatch(COLORS.human), { text: 'Browser-Besucher', width: 82 },
        swatch(COLORS.unclear), { text: 'Unklar', width: 42 },
        swatch(COLORS.bot), { text: 'Bots', width: 36 },
        swatch(COLORS.ai), { text: 'KI-Crawler', width: 'auto' },
      ],
      fontSize: 8.5,
      margin: [0, 0, 0, 4],
    },
    { text: `Skala: bis ${fmt(max)} Besuche pro Tag`, fontSize: 8, color: COLORS.muted },
    { canvas, margin: [0, 3, 0, 2] },
    {
      columns: [
        { text: fmtDate(daily[0].date), alignment: 'left' },
        { text: fmtDate(daily[n - 1].date), alignment: 'right' },
      ],
      fontSize: 8,
      color: COLORS.muted,
      margin: [0, 0, 0, 10],
    },
  ];
}

function weekdaySection(daily) {
  const groups = new Map();
  for (const d of daily) {
    const wd = weekdayOf(d.date);
    const g = groups.get(wd) || { days: 0, total: 0, human: 0, unclear: 0, bots: 0, ai: 0 };
    g.days += 1;
    g.total += d.visitsTotal || 0;
    g.human += d.visitsHuman || 0;
    g.unclear += d.visitsUnclear || 0;
    g.bots += d.visitsBots || 0;
    g.ai += d.visitsAi || 0;
    groups.set(wd, g);
  }
  const rows = [1, 2, 3, 4, 5, 6, 0].filter((wd) => groups.has(wd)).map((wd) => {
    const g = groups.get(wd);
    const avg = (v) => fmt(Math.round(v / g.days));
    return [WEEKDAYS[wd], g.days, avg(g.total), avg(g.human), avg(g.unclear), avg(g.bots), avg(g.ai)];
  });
  return [
    heading('Wochentagsmuster', 2),
    dataTable({
      headers: ['Wochentag', 'Tage', 'Ø Besuche', 'Ø Browser', 'Ø Unklar', 'Ø Bots', 'Ø KI'],
      rows,
      widths: ['*', 36, 62, 62, 56, 50, 44],
      align: ['left', 'right', 'right', 'right', 'right', 'right', 'right'],
    }),
  ];
}

function dailySection(daily) {
  if (!daily.length) {
    return [heading('2. Tagesverlauf', 1, { pageBreak: 'before' }), note('Für diesen Monat liegen keine Tagesstatistiken vor. Bitte zuerst die Tagesstatistiken neu berechnen.')];
  }
  const rows = daily.map((d) => [
    fmtDate(d.date), WEEKDAYS[weekdayOf(d.date)].slice(0, 2), fmt(d.visitsTotal), fmt(d.visitsHuman), fmt(d.visitsUnclear), fmt(d.visitsBots), fmt(d.visitsAi), fmt(d.errors4xx), fmt(d.errors429),
  ]);
  return [
    heading('2. Tagesverlauf', 1, { pageBreak: 'before' }),
    heading('Besuche pro Tag', 2),
    ...dailyChart(daily),
    ...weekdaySection(daily),
    heading('Tageswerte', 2),
    dataTable({
      headers: ['Datum', 'Tag', 'Besuche', 'Browser', 'Unklar', 'Bots', 'KI', '4xx', '429'],
      rows,
      widths: [60, 26, 52, 50, 46, 44, 36, 46, 36],
      align: ['left', 'left', 'right', 'right', 'right', 'right', 'right', 'right', 'right'],
    }),
  ];
}

function referrerSection(referrers) {
  const body = referrers.length
    ? dataTable({
      headers: ['#', 'Referrer', 'Abrufe'],
      rows: referrers.map((r, i) => [i + 1, r.url, fmt(r.count)]),
      widths: [22, '*', 55],
      align: ['right', 'left', 'right'],
    })
    : note('Im Zeitraum wurden keine externen Referrer erfasst.');
  return [
    heading('3. Herkunft der Besucher', 1, { pageBreak: 'before' }),
    heading('Top-Referrer', 2),
    body,
    note('Berücksichtigt werden Abrufe mit HTTP 200 und externem Referrer; interne Verweise sind ausgeschlossen.'),
  ];
}

function aiAccessSection(stats) {
  const head = heading('4. KI-Zugriffe', 1, { pageBreak: 'before' });
  if (!stats || !stats.totalAiHits) {
    return [head, note('Im Zeitraum wurden keine KI-Zugriffe festgestellt.')];
  }
  const purposeRows = Object.entries(stats.byPurpose)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => [PURPOSE_LABELS[k] || k, fmt(v), pct(v, stats.totalAiHits)]);

  return [
    head,
    heading('Überblick', 2),
    {
      text: [
        { text: fmt(stats.totalAiHits), bold: true },
        ` KI-Seitenabrufe bei ${fmt(stats.totalPageRequests)} Seitenabrufen insgesamt (Anteil `,
        { text: `${stats.aiSharePercent.toLocaleString('de-DE')} %`, bold: true },
        ').',
      ],
      margin: [0, 0, 0, 8],
    },
    dataTable({ headers: ['Zweck', 'Abrufe', 'Anteil'], rows: purposeRows, widths: ['*', 80, 80], align: ['left', 'right', 'right'], fontSize: 9.5 }),
    heading('KI-Crawler im Detail', 2),
    dataTable({
      headers: ['Crawler', 'Anbieter', 'Zweck', 'Abrufe', '2xx', '3xx', '404', 'Sonst.', 'robots/llms/sitemap'],
      rows: stats.bots.map((b) => [
        b.name, b.vendor, PURPOSE_LABELS[b.purpose] || b.purpose, fmt(b.hits), fmt(b.ok), fmt(b.redirects), fmt(b.notFound), fmt(b.otherErrors),
        Object.entries(b.special).map(([p, c]) => `${p}: ${c}`).join(', ') || '–',
      ]),
      widths: [70, 46, 44, 34, 30, 30, 30, 30, '*'],
      align: ['left', 'left', 'left', 'right', 'right', 'right', 'right', 'right', 'left'],
      fontSize: 7.5,
    }),
    note('2xx = erfolgreich, 3xx = Weiterleitung, 404 = nicht gefunden, Sonst. = übrige Fehler.'),
    heading('Meistabgefragte Seiten', 2),
    dataTable({
      headers: ['Pfad', 'Abrufe', 'Crawler'],
      rows: stats.topPages.map((p) => [p.path, fmt(p.hits), p.bots.length > 4 ? `${p.bots.slice(0, 4).join(', ')} +${p.bots.length - 4}` : p.bots.join(', ')]),
      widths: ['*', 45, 150],
      align: ['left', 'right', 'left'],
      fontSize: 8,
    }),
    heading('Abgefragte Bereiche', 2),
    dataTable({
      headers: ['Bereich', 'Abrufe', 'Anteil'],
      rows: stats.topSections.map((s) => [s.section, fmt(s.hits), pct(s.hits, stats.totalAiHits)]),
      widths: ['*', 70, 70],
      align: ['left', 'right', 'right'],
    }),
    ...(stats.notFoundPaths.length
      ? [
        heading('Nicht gefundene Pfade (404)', 2),
        dataTable({ headers: ['Pfad', 'Abrufe'], rows: stats.notFoundPaths.map((p) => [p.path, fmt(p.hits)]), widths: ['*', 60], align: ['left', 'right'] }),
        note('Pfade wie /.env stammen häufig von Scannern mit gefälschtem KI-User-Agent und sind ein Sicherheits-, kein GEO-Thema.'),
      ]
      : []),
  ];
}

function analysisSection(title, analysis, sourceNote) {
  const head = heading(title, 1, { pageBreak: 'before' });
  if (!analysis || !analysis.markdown) {
    return [head, note(`Analyse nicht verfügbar${analysis && analysis.error ? `: ${analysis.error}` : '.'}`)];
  }
  return [head, note(sourceNote), ...markdownToPdf(analysis.markdown)];
}

function coverPage(data) {
  const { coverage } = data;
  const rows = [
    ['Website', data.sites.join(', ') || '–'],
    ['Berichtszeitraum', `${fmtDate(coverage.from)} bis ${fmtDate(coverage.to)}`],
    ['Datenbasis', `${coverage.days} von ${coverage.daysInMonth} Tagen`],
    ['Erstellt am', data.createdAt],
  ];
  const warning = coverage.isCurrentMonth
    ? 'Der Monat ist noch nicht abgeschlossen; der Bericht enthält die Daten bis zum letzten vorliegenden Log-Tag.'
    : coverage.days < coverage.daysInMonth
      ? 'Für einzelne Tage dieses Monats liegen keine Logdaten vor; die Auswertung ist unvollständig.'
      : null;

  return [
    { text: 'webStat LogAnalyzer', fontSize: 13, color: COLORS.muted, margin: [0, 150, 0, 6] },
    { text: 'Monatsbericht', fontSize: 34, bold: true, color: COLORS.accent },
    { text: data.monthLabel, fontSize: 22, color: COLORS.accent2, margin: [0, 2, 0, 30] },
    {
      table: { widths: [110, '*'], body: rows.map(([k, v]) => [{ text: k, bold: true, color: COLORS.muted }, { text: clean(v) }]) },
      layout: { hLineWidth: (i, node) => (i === 0 || i === node.table.body.length ? 0 : 0.5), vLineWidth: () => 0, hLineColor: () => COLORS.line, paddingTop: () => 5, paddingBottom: () => 5 },
      fontSize: 10.5,
    },
    ...(warning ? [{ text: warning, italics: true, color: '#a15c00', fontSize: 9.5, margin: [0, 14, 0, 0] }] : []),
    { text: '', pageBreak: 'after' },
  ];
}

function buildDocDefinition(data) {
  const aiNote = (what) => `${what} Erstellt mit Azure OpenAI (${data.model || 'Modell'}); die Auswertung ist eine automatische Einschätzung und sollte fachlich geprüft werden.`;
  const [summary, trend, raw, geo] = ['summary', 'trend', 'raw', 'geo'].map((k) => data.analyses.find((a) => a.key === k));

  return {
    pageSize: 'A4',
    pageMargins: PAGE_MARGINS,
    info: { title: `webStat Monatsbericht ${data.monthLabel}`, author: 'webStat LogAnalyzer', subject: data.sites.join(', ') },
    defaultStyle: { font: 'Roboto', fontSize: 10, lineHeight: 1.25 },
    styles: {
      h1: { fontSize: 18, bold: true, color: COLORS.accent, margin: [0, 0, 0, 10] },
      h2: { fontSize: 13.5, bold: true, color: COLORS.accent2, margin: [0, 14, 0, 6] },
      h3: { fontSize: 11.5, bold: true, color: '#33475b', margin: [0, 10, 0, 4] },
      h4: { fontSize: 10.5, bold: true, color: '#33475b', margin: [0, 8, 0, 3] },
    },
    header: (page) => (page === 1 ? null : { text: `webStat – Monatsbericht ${data.monthLabel}`, fontSize: 8, color: '#888888', margin: [PAGE_MARGINS[0], 26, PAGE_MARGINS[2], 0] }),
    footer: (page, pages) => ({
      columns: [{ text: `Erstellt: ${data.createdAt}`, alignment: 'left' }, { text: `Seite ${page} von ${pages}`, alignment: 'right' }],
      fontSize: 8,
      color: '#888888',
      margin: [PAGE_MARGINS[0], 22, PAGE_MARGINS[2], 0],
    }),
    content: [
      ...coverPage(data),
      { toc: { title: { text: 'Inhaltsverzeichnis', style: 'h1' } } },
      heading('1. Zusammenfassung', 1, { pageBreak: 'before' }),
      ...summarySection(summary),
      ...(data.daily.length ? kpiSection(data.daily) : [note('Für diesen Monat liegen keine Tagesstatistiken vor.')]),
      ...comparisonSection(data),
      ...dailySection(data.daily),
      ...referrerSection(data.referrers),
      ...aiAccessSection(data.aiStats),
      ...analysisSection('5. Trendanalyse der Tagesstatistik (KI)', trend, aiNote('Grundlage: Tagesstatistiken des Monats.')),
      ...analysisSection('6. Analyse der Rohdaten (KI)', raw, aiNote('Grundlage: repräsentative Stichprobe der Logzeilen des Monats.')),
      ...analysisSection('7. KI-Zugriffe und GEO-Empfehlungen (KI)', geo, aiNote('Grundlage: aggregierte KI-Zugriffe des Monats.')),
    ],
  };
}

async function createMonthlyReportPdf(data) {
  const buffer = await pdfmake.createPdf(buildDocDefinition(data)).getBuffer();
  return Buffer.from(buffer);
}

module.exports = { createMonthlyReportPdf, summarizeDaily };

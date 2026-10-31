#!/usr/bin/env node
// Shared foundation for the report builders (build-report-audit.mjs,
// build-report-all.mjs): formatting helpers, data loading, HTML atoms,
// styles, the CLI/all-mode scaffolding and the optional PDF pipeline.
// Not runnable on its own - import it from a builder.

import { readFileSync, writeFileSync, readdirSync, existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import readline from 'node:readline/promises';
import { inflateSync } from 'node:zlib';

import { setLocale, tr, mapLabel, localeMeta, interpolate } from './locales/index.mjs';

// --- Locale switch ----------------------------------------------------------------
//
// Every report is written in one language, chosen by the builder before it
// renders anything. useLocale() re-creates the module-level formatters for
// that language; the exports stay `let` so ESM live bindings carry the new
// formatters to the builders' already-imported names (fmt.format(...) keeps
// working unchanged). Until useLocale() runs the formatters are Swedish -
// the language every existing report was written in.

export const useLocale = (code) => {
  setLocale(code);
  const { tag, decimalSep } = localeMeta();
  fmt = new Intl.NumberFormat(tag);
  fmtPct = new Intl.NumberFormat(tag, { style: 'percent', maximumFractionDigits: 1 });
  decimalSep_ = decimalSep;
};

// --- Formatting helpers --------------------------------------------------------

export let fmt = new Intl.NumberFormat('sv-SE');
export let fmtPct = new Intl.NumberFormat('sv-SE', { style: 'percent', maximumFractionDigits: 1 });
// One-decimal numbers with the locale's decimal separator, replacing the
// per-builder .replace('.', ',') hacks. Kept off Intl on purpose: fmtPct's
// percent style adds a non-breaking space before % in some locales, and the
// donut aria labels need the plain separator form.
let decimalSep_ = ',';
export const fmtDec1 = (num) => Number(num).toFixed(1).replace('.', decimalSep_);
export const share = (part, whole) => (whole > 0 ? fmtPct.format(part / whole) : '–');

export const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export const fmtDur = (sec) => {
  const s = Math.round(Number(sec) || 0);
  const m = Math.floor(s / 60);
  const r = s % 60;
  return m === 0
    ? tr('common.durSeconds', { s: r })
    : tr('common.durMinutes', { m, s: String(r).padStart(2, '0') });
};

export const fmtDate = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleDateString(localeMeta().tag, { day: 'numeric', month: 'long', year: 'numeric' });
};

// The "report generated" timestamp in the meta line; locale-dependent.
export const fmtDateTime = (d) => d.toLocaleString(localeMeta().tag, { dateStyle: 'long', timeStyle: 'short' });

// Chart x-axis labels stay hand-rolled instead of Intl: the day/month order
// (1/9 vs 9/1) is a locale convention, not something a date formatter gives
// us compactly.
export const shortDay = (iso) => {
  const [, m, d] = String(iso).split('-');
  return interpolate(localeMeta().shortDay, { d: Number(d), m: Number(m) });
};

export const hits = (r) => r.nb_hits ?? r.nb_visits ?? 0;
export const sortByValue = (rows) => [...rows].sort((a, b) => (b.value ?? 0) - (a.value ?? 0));
export const safe = (s) => String(s || '').replace(/[^0-9A-Za-z-]/g, '');

// --- Data loading ---------------------------------------------------------------

export const makeReadJson = (dataDir) => (name) => {
  try {
    return JSON.parse(readFileSync(join(dataDir, `${name}.json`), 'utf8'));
  } catch {
    return null;
  }
};

// Matomo occasionally wraps range reports in an object keyed by the date
// range. Unwrap to the payload we care about.
export const unwrap = (v) => {
  if (!v || Array.isArray(v) || typeof v !== 'object') return v ?? null;
  const keys = Object.keys(v);
  if (keys.length === 1 && /^\d{4}-\d{2}-\d{2}(,\d{4}-\d{2}-\d{2})?$/.test(keys[0])) {
    return v[keys[0]];
  }
  return v;
};

// Month summaries arrive either bare or wrapped under the month label
// ("2026-09"); null when there is no usable object.
export const unwrapMonth = (v) => {
  if (!v || Array.isArray(v) || typeof v !== 'object') return null;
  const keys = Object.keys(v);
  if (keys.length === 1 && /^\d{4}-\d{2}$/.test(keys[0])) return v[keys[0]];
  return v.nb_uniq_visitors === undefined ? null : v;
};

// True when period.json describes exactly one full calendar month - the
// window for which the month archive can stand in for the range summary.
export const isFullMonth = (period) => {
  const m = /^(\d{4})-(\d{2})-01$/.exec(String(period?.start || ''));
  if (!m) return false;
  const lastDay = new Date(Date.UTC(Number(m[1]), Number(m[2]), 0)).toISOString().slice(0, 10);
  return period?.end === lastDay;
};

// Unique visitors: range archives omit the metric unless Matomo's
// enable_processing_unique_visitors_range setting is on, but month archives
// carry it by default - the month summary (pulled only for full calendar
// months) fills the KPI. summaryMonth must be unwrapped; period comes from
// period.json, guarding against a stale month file from another window.
export const uniqVisitors = (summary, summaryMonth, period) =>
  summary.nb_uniq_visitors ??
  (isFullMonth(period) && summaryMonth ? summaryMonth.nb_uniq_visitors : undefined) ??
  0;

// --- Labels and colors ----------------------------------------------------------

export const DONUT_COLORS = ['#2f6bb0', '#2e8b7a', '#c98a1b', '#7a8694', '#9a5f8f', '#b0556d'];

// Raw values from Matomo (device types, theme values, referrer types) are
// translated with the current locale's label maps; see mapLabel in
// scripts/locales/index.mjs. Unmapped values pass through as-is.

// --- HTML atoms -------------------------------------------------------------------

export const barCell = (value, max) => {
  const w = max > 0 ? Math.min(100, Math.max(1.5, (value / max) * 100)) : 0;
  return `<div class="bar" aria-hidden="true"><span style="width:${w.toFixed(1)}%"></span></div>`;
};

// Short tables must not split across pages (a lone header row at a page
// bottom is a widowed header); tables taller than a screenful are marked
// "long" and may break - the print CSS repeats their thead on every page.
export const tableClass = (rows) => (rows.length > 8 ? ' class="long"' : '');

export const rankTable = (rows, total, opts = {}) => {
  if (!rows.length) return `<p class="muted">${esc(tr('common.empty'))}</p>`;
  const { labelHead = tr('common.headPage'), valueHead = tr('common.headPageviews'), caption = '' } = opts;
  const max = Math.max(...rows.map((r) => r.value), 1);
  return `
<table${tableClass(rows)}>
  <caption class="sr-only">${esc(caption || tr('common.captionFallback', { label: labelHead, value: valueHead.toLowerCase() }))}</caption>
  <thead><tr>
    <th scope="col" class="num">#</th>
    <th scope="col">${esc(labelHead)}</th>
    <th scope="col" class="barhead" aria-hidden="true"></th>
    <th scope="col" class="num">${esc(valueHead)}</th>
    <th scope="col" class="num">${esc(tr('common.shareHead'))}</th>
  </tr></thead>
  <tbody>
    ${rows
      .map(
        (r, i) => `
    <tr>
      <td class="num muted">${i + 1}</td>
      <th scope="row" class="path">${esc(r.label)}</th>
      <td class="barcell">${barCell(r.value, max)}</td>
      <td class="num">${fmt.format(r.value)}</td>
      <td class="num">${share(r.value, total)}</td>
    </tr>`
      )
      .join('')}
  </tbody>
</table>`;
};

export const simpleTable = (rows, total, labelHead, valueHead, caption) => {
  if (!rows.length) return `<p class="muted">${esc(tr('common.empty'))}</p>`;
  return `
<table${tableClass(rows)}>
  <caption class="sr-only">${esc(caption)}</caption>
  <thead><tr>
    <th scope="col">${esc(labelHead)}</th>
    <th scope="col" class="num">${esc(valueHead)}</th>
    <th scope="col" class="num">${esc(tr('common.shareHead'))}</th>
  </tr></thead>
  <tbody>
    ${rows
      .map(
        (r) => `
    <tr>
      <th scope="row" class="path">${esc(r.label)}</th>
      <td class="num">${fmt.format(r.value)}</td>
      <td class="num">${share(r.value, total)}</td>
    </tr>`
      )
      .join('')}
  </tbody>
</table>`;
};

// Every chart instance needs unique <title>/<desc> ids: a page can hold
// several charts (the traffic overview renders three donuts) and duplicate
// ids would make their aria-labelledby references ambiguous.
let chartSeq = 0;

export const donut = (rows) => {
  const total = rows.reduce((s, r) => s + r.value, 0);
  if (total <= 0) return `<p class="muted">${esc(tr('common.empty'))}</p>`;
  const uid = `donut-${++chartSeq}`;
  const R = 52;
  const C = 2 * Math.PI * R;
  let acc = 0;
  const segs = rows
    .map((r, i) => {
      const frac = r.value / total;
      const pct = Math.round(frac * 1000) / 10;
      const seg = `<circle cx="70" cy="70" r="${R}" fill="none" stroke="${DONUT_COLORS[i % DONUT_COLORS.length]}" stroke-width="24" stroke-dasharray="${(frac * C).toFixed(2)} ${C.toFixed(2)}" stroke-dashoffset="${(-acc * C).toFixed(2)}" transform="rotate(-90 70 70)" role="img" aria-label="${esc(r.label)}: ${fmt.format(r.value)} (${pct.toString().replace('.', decimalSep_)} %)"></circle>`;
      acc += frac;
      return seg;
    })
    .join('');
  // The center figures live outside the SVG as plain HTML: they repeat what
  // <title> already says, so they stay out of the accessibility tree, and
  // contrast tools can resolve their background (SVG graphics defeat that).
  return `
<div class="donut-wrap">
  <div class="donut-box">
    <svg viewBox="0 0 140 140" width="180" height="180" role="group" aria-labelledby="${uid}-title" aria-describedby="${uid}-desc" focusable="false">
      <title id="${uid}-title">${esc(tr('common.donutTitle', { total: fmt.format(total) }))}</title>
      <desc id="${uid}-desc">${esc(tr('common.donutDesc', { labels: rows.map((r) => r.label).join(', ') }))}</desc>
      ${segs}
    </svg>
    <p class="donut-center" aria-hidden="true"><span class="donut-n">${fmt.format(total)}</span><span class="donut-l">${esc(tr('common.donutCenter'))}</span></p>
  </div>
  <ul class="legend">
    ${rows
      .map(
        (r, i) =>
          `<li><span class="dot" style="background:${DONUT_COLORS[i % DONUT_COLORS.length]}" aria-hidden="true"></span><span>${esc(r.label)} <span class="muted">· ${fmt.format(r.value)} (${share(r.value, total)})</span></span></li>`
      )
      .join('')}
  </ul>
</div>`;
};

export const barList = (rows) => {
  const total = rows.reduce((s, r) => s + r.value, 0);
  const max = Math.max(...rows.map((r) => r.value), 1);
  return `
<ul class="barlist">
  ${rows
    .map(
      (r) => `
  <li>
    <span class="bl-label">${esc(r.label)}</span>
    <span class="bl-track" aria-hidden="true"><span style="width:${((r.value / max) * 100).toFixed(1)}%"></span></span>
    <span class="bl-val">${fmt.format(r.value)} · ${share(r.value, total)}</span>
  </li>`
    )
    .join('')}
</ul>`;
};

// Vertical bar chart (inline SVG, viewBox-scaled, print-safe) for series like
// visits per day or per hour. The bars are decorative - the caption goes to
// screen readers and the peak is spelled out, since bar heights alone are not
// accessible. labelEvery thins out x-axis labels on dense series.
export const barChart = (rows, opts = {}) => {
  const { labelEvery = 1, caption = '' } = opts;
  const uid = `barchart-${++chartSeq}`;
  const data = rows.filter((r) => r && typeof r.label === 'string');
  if (!data.length || data.every((r) => !(r.value > 0))) return `<p class="muted">${esc(tr('common.empty'))}</p>`;
  const max = Math.max(...data.map((r) => r.value), 1);
  const peak = data.reduce((a, b) => (b.value > a.value ? b : a));
  const W = 960;
  const H = 240;
  const baseline = H - 26;
  // The max label gets its own lane above the plot area: inside it, a tall
  // first bar could run into the label and wreck both legibility and the
  // contrast between the two.
  const top = 26;
  const bw = W / data.length;
  const bars = data
    .map((r, i) => {
      const h = Math.max(((r.value ?? 0) / max) * (baseline - top), 0.75);
      const x = (i * bw + bw * 0.12).toFixed(1);
      const w = (bw * 0.76).toFixed(1);
      const label = esc(r.label);
      const val = fmt.format(r.value ?? 0);
      return `<rect x="${x}" y="${(baseline - h).toFixed(1)}" width="${w}" height="${h.toFixed(1)}" rx="2" role="img" aria-label="${label}: ${val}"></rect>`;
    })
    .join('');
  const labels = data
    .map((r, i) =>
      i % labelEvery === 0
        ? `<text x="${(i * bw + bw / 2).toFixed(1)}" y="${baseline + 18}" text-anchor="middle">${esc(r.label)}</text>`
        : ''
    )
    .join('');
  return `
<div class="chart-wrap">
  <p class="sr-only">${esc(caption)}${caption ? '. ' : ''}${esc(tr('common.chartPeakSr', { label: peak.label, value: fmt.format(peak.value) }))}</p>
  <div class="chart-box">
    <svg viewBox="0 0 ${W} ${H}" role="group" aria-labelledby="${uid}-title" aria-describedby="${uid}-desc" focusable="false" class="barchart">
      <title id="${uid}-title">${esc(caption || tr('common.chartTitleFallback'))}</title>
      <desc id="${uid}-desc">${esc(caption)} ${esc(tr('common.chartPeakDesc', { label: peak.label, value: fmt.format(peak.value) }))}</desc>
      <line x1="0" y1="${baseline}" x2="${W}" y2="${baseline}" class="chart-axis"></line>
      ${bars}
      ${labels}
    </svg>
    <span class="chart-max" aria-hidden="true">${fmt.format(max)}</span>
  </div>
</div>`;
};

export const notice = (html) => `<div class="notice">${html}</div>`;

export const kpiGrid = (kpis, label = tr('common.kpiAria')) => `<section class="kpis" aria-label="${esc(label)}">
  ${kpis.map((k) => `<div class="kpi"><div class="n">${k.v}</div><div class="l">${k.l}</div></div>`).join('\n  ')}
</section>`;

// --- Styles -----------------------------------------------------------------------

// baseCss is shared verbatim by every report; paperSize comes from
// settings.json ("A4" | "Letter") and sets the print page size. Chart styles
// live separately so reports without charts do not carry them.
export const baseCss = (paperSize = 'A4') => `
:root{
  --bg:#f3f5f8;--card:#fff;--ink:#1c2b39;--muted:#5a6a7a;--line:#dde3ea;
  --accent:#1f5fa8;--accent-deep:#14446f;--bar:#2f6bb0;
  --warn-bg:#fbf3df;--warn-line:#e5d3a8;
}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--ink);
  font:16px/1.6 system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",sans-serif;}
.wrap{max-width:1080px;margin:0 auto;padding:32px 28px 72px}
.masthead{margin:8px 0 20px}
.kicker{margin:0 0 6px;font-size:.82rem;font-weight:650;letter-spacing:.08em;color:var(--accent-deep)}
h1{margin:0 0 10px;font-size:clamp(1.6rem,3.5vw,2.3rem);line-height:1.2;color:#132433}
.meta{margin:0;color:var(--muted);font-size:.82rem}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:14px;margin:22px 0 6px}
.kpi{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px 18px}
.kpi .n{font-size:1.7rem;font-weight:650;line-height:1.2;font-variant-numeric:tabular-nums}
.kpi .l{margin-top:4px;color:var(--muted);font-size:.88rem}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:26px 30px 22px;margin:22px 0}
h2{margin:0 0 6px;font-size:1.3rem;line-height:1.3;color:#132433}
h3{margin:26px 0 10px;font-size:1.02rem;color:#26404f}
.lead{margin:0 0 18px;color:var(--muted);max-width:64ch}
table{width:100%;border-collapse:collapse;margin:6px 0 4px;font-size:.94rem;font-variant-numeric:tabular-nums}
th,td{padding:8px 10px;text-align:left;border-bottom:1px solid var(--line);vertical-align:middle}
thead th{color:var(--muted);font-size:.8rem;font-weight:600;border-bottom:2px solid var(--line)}
th.num,td.num{text-align:right;white-space:nowrap}
/* Row headers are th (scope=row) but must look like the data cells around them. */
tbody th{font-weight:400}
th.path,td.path{word-break:break-word;min-width:16ch}
.barhead,.barcell{width:26%}
.bar{height:8px;border-radius:4px;background:#e8edf3;overflow:hidden}
.bar span{display:block;height:100%;border-radius:4px;background:var(--bar)}
tr.bad .path{color:#8c3a3a;font-weight:600}
  .donut-wrap{display:flex;gap:26px;align-items:center;flex-wrap:nowrap;margin:8px 0 4px}
  .donut-box{position:relative;flex:0 0 auto}
  .donut-wrap svg{width:180px;height:180px;max-width:180px;display:block}
  .donut-center{position:absolute;inset:0;margin:0;display:flex;flex-direction:column;align-items:center;justify-content:center;pointer-events:none}
  /* The explicit white backgrounds let contrast tools resolve these texts
     against a color instead of the SVG graphics underneath them. */
  .donut-center span{background:#fff;padding:0 4px}
  .legend{list-style:none;margin:0;padding:0;font-size:.95rem;flex:1 1 auto;min-width:0}
.dot{display:inline-block;width:11px;height:11px;border-radius:50%;margin-right:8px}
.donut-n{font-size:20px;font-weight:650;line-height:1.2;color:#1c2b39}
.donut-l{font-size:11px;color:#5a6a7a}
.duo{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:6px 34px}
.duo h3{margin-top:18px}
.barlist{list-style:none;margin:14px 0 6px;padding:0}
.barlist li{display:grid;grid-template-columns:minmax(10ch,16ch) 1fr max-content;gap:14px;align-items:center;margin:10px 0}
.bl-track{height:14px;border-radius:7px;background:#e8edf3;overflow:hidden}
.bl-track span{display:block;height:100%;border-radius:7px;background:var(--accent)}
.bl-val{font-variant-numeric:tabular-nums;font-size:.95rem;white-space:nowrap}
.notice{background:var(--warn-bg);border:1px solid var(--warn-line);border-left:5px solid #c99a2e;border-radius:10px;padding:14px 18px;margin:8px 0 4px}
.notice p{margin:0}
.muted{color:var(--muted)}
.small{font-size:.88rem}
footer{margin-top:34px;color:var(--muted);font-size:.9rem}
code{background:#eef1f5;border-radius:5px;padding:1px 6px;font-size:.9em}
.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}
@page{size:${paperSize};margin:14mm 12mm}
@media print{
  body{background:#fff}
  .wrap{max-width:none;padding:0}
  /* Bars, dots and notice backgrounds must survive printing. */
  *{-webkit-print-color-adjust:exact;print-color-adjust:exact}
  /* Cards may flow across pages (a tall card forced onto one sheet
     leaves the previous page mostly blank); the atoms inside may not:
     rows split cleanly because Chrome repeats thead on every page. */
  .kpi,.donut-wrap,.notice,tr{break-inside:avoid}
  table{break-inside:avoid}
  table.long{break-inside:auto}
  h2,h3{break-after:avoid}
}
@media (max-width:640px){
  .card{padding:20px 18px 16px}
  .barlist li{grid-template-columns:1fr;gap:4px}
  .bl-label{font-weight:600}
}
`;

export const chartCss = `
.chart-wrap{margin:8px 0 4px}
.chart-box{position:relative}
.barchart{display:block;width:100%;height:auto}
.barchart rect{fill:var(--bar)}
.barchart text{font-size:11px;fill:#5a6a7a}
.chart-box .chart-max{position:absolute;top:0;left:4px;font-size:12px;line-height:1;color:#5a6a7a;background:#fff;padding:2px 4px}
.barchart .chart-axis{stroke:#dde3ea}
@media print{
  .chart-wrap{break-inside:avoid}
}
`;

// --- CLI scaffolding ----------------------------------------------------------------

// Report language is chosen with --lang=<code> (single-token form only, so
// it fans through runAllSites unchanged); the actual validation happens in
// resolveReportLanguage (scripts/settings.mjs) once the full precedence
// chain is known.
export const parseReportArgv = (argv) => {
  const known = (a) => ['--pdf', '--no-pdf'].includes(a) || a.startsWith('--lang=');
  const unknownFlags = argv.filter((a) => a.startsWith('--') && !known(a));
  const positional = argv.filter((a) => !a.startsWith('--'));
  const pdfFlag = argv.includes('--pdf') ? true : argv.includes('--no-pdf') ? false : null;
  const langFlag = argv.find((a) => a.startsWith('--lang='))?.slice('--lang='.length);
  return { slug: positional[0], unknownFlags, pdfFlag, langFlag };
};

// The "data available for: …" hint under a usage message.
export const listAvailableSlugs = (base) => {
  const dataRoot = join(base, 'data');
  if (!existsSync(dataRoot)) return [];
  return readdirSync(dataRoot, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
};

// "all" builds every configured site: this script is re-run once per site
// config so per-site behavior (data checks, warnings, PDF handling) stays
// identical to a single build; the PDF question is asked once here and the
// answer, like the language flag, forwarded to every site.
export async function runAllSites(scriptPath, base, pdfFlag, interactive, langFlag) {
  const configDir = join(base, 'config');
  const slugs = existsSync(configDir)
    ? readdirSync(configDir, { withFileTypes: true })
        .filter((d) => d.isFile() && !d.name.startsWith('.'))
        .map((d) => d.name)
        .sort()
    : [];
  if (!slugs.length) {
    console.error('no site configs in config/ - nothing to build');
    process.exit(1);
  }
  let forward;
  if (pdfFlag !== null) forward = pdfFlag ? '--pdf' : '--no-pdf';
  else if (!interactive) forward = '--no-pdf';
  else forward = (await askPdf()) ? '--pdf' : '--no-pdf';
  const langArgs = langFlag ? [`--lang=${langFlag}`] : [];
  const failed = [];
  for (const s of slugs) {
    console.log(`\n== ${s} ==`);
    const r = spawnSync(process.execPath, [scriptPath, s, forward, ...langArgs], { stdio: 'inherit' });
    if (r.status !== 0) failed.push(s);
  }
  console.log();
  if (failed.length) {
    console.error(`FAILED: ${failed.join(' ')}`);
    process.exit(1);
  }
  console.log(`built ${slugs.length} reports: ${slugs.join(', ')}`);
  process.exit(0);
}

// Ask once whether to write PDFs; empty answer (Enter) and EOF/Ctrl-D both
// accept the default (yes).
export async function askPdf() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  let answer = '';
  try {
    do {
      answer = (await rl.question('Also save the report as PDF? [Y/n] ')).trim().toLowerCase();
    } while (answer !== '' && !/^(y|yes|n|no)$/.test(answer));
  } catch (err) {
    // Ctrl-D / EOF aborts the pending question - take the default (yes).
    if (err?.code !== 'ABORT_ERR') throw err;
  } finally {
    rl.close();
  }
  return !answer.startsWith('n');
}

// --- PDF pipeline -------------------------------------------------------------------

// Chromium-based browsers render the reports' CSS grid and SVG correctly;
// wkhtmltopdf-style converters do not. The first candidate that exists wins;
// CHROME_BIN points to a browser not on the list.
function findBrowser() {
  const candidates = [];
  if (process.env.CHROME_BIN) candidates.push(process.env.CHROME_BIN);
  candidates.push(
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser'
  );
  const onPath = (name) => (process.env.PATH || '').split(':').filter(Boolean).map((d) => join(d, name));
  candidates.push(...onPath('google-chrome'), ...onPath('chromium'), ...onPath('chromium-browser'), ...onPath('msedge'));
  return candidates.find((c) => existsSync(c)) ?? null;
}

// Ghostscript re-subsets and dedupes what Chrome embedded, roughly halving
// the file again. Optional: without it the PDF is just bigger, never wrong.
function findGs() {
  const candidates = [...(process.env.PATH || '').split(':'), '/opt/homebrew/bin', '/usr/local/bin'].filter(Boolean).map((d) => join(d, 'gs'));
  return candidates.find((c) => existsSync(c)) ?? null;
}

// Read the accessibility-relevant markers out of a finished PDF: whether a
// structure tree is present (i.e. the PDF is tagged), the document language
// and title. Dictionaries can hide inside compressed object streams, so
// every stream is inflated and scanned too. Zero dependencies.
export function inspectPdf(pdfPath) {
  const raw = readFileSync(pdfPath).toString('latin1');
  const chunks = [raw];
  const re = /stream\r?\n/g;
  for (let m; (m = re.exec(raw)); ) {
    const start = m.index + m[0].length;
    const end = raw.indexOf('endstream', start);
    if (end < 0) break;
    try {
      chunks.push(inflateSync(Buffer.from(raw.slice(start, end), 'latin1')).toString('latin1'));
    } catch {
      // not a flate stream (image data, fonts) - nothing to scan there
    }
  }
  const hay = chunks.join('\n');
  // Strings arrive as UTF-16BE hex (Chrome's choice) or as a literal with
  // escaped parens; both encodings are decoded here.
  const str = (name) => {
    const hex = hay.match(new RegExp(`/${name}\\s*<([0-9A-Fa-f\\s]+)>`));
    if (hex) {
      try {
        const bytes = Buffer.from(hex[1].replace(/\s+/g, ''), 'hex');
        const text =
          bytes[0] === 0xfe && bytes[1] === 0xff
            ? bytes.subarray(2).swap16().toString('utf16le')
            : bytes.toString('latin1');
        return text.replace(/\0+$/, '');
      } catch {
        return '';
      }
    }
    const lit = hay.match(new RegExp(`/${name}\\s*\\(((?:\\\\.|[^\\\\)])*)\\)`));
    return lit ? lit[1].replace(/\\([()\\])/g, '$1') : '';
  };
  return {
    tagged: hay.includes('/StructTreeRoot') && /\/Marked\s+true/.test(hay),
    lang: str('Lang'),
    title: str('Title'),
  };
}

const isTaggedPdf = (path) => {
  try {
    return inspectPdf(path).tagged;
  } catch {
    return false;
  }
};

// The PDF is the shareable variant of a report: identical to the HTML
// except that internal notes (span.internal) are hidden, and - purely to
// keep the file small - it uses Helvetica Neue instead of the system font.
// Chrome on macOS cannot embed San Francisco as a real font and falls back
// to dozens of Type 3 glyph programs (~400 kB for a short report); any
// ordinary TrueType embeds as a couple of compact subsets instead.
const PDF_ONLY_CSS =
  '<style>.internal{display:none !important}body{font-family:"Helvetica Neue",Helvetica,Arial,sans-serif}*{-webkit-print-color-adjust:exact;print-color-adjust:exact}main,header,footer,section{display:block}</style>';

export function writePdf(htmlPath, html, pdfOnlyCss = PDF_ONLY_CSS) {
  const browser = findBrowser();
  if (!browser) {
    throw new Error(
      'no Chromium-based browser found for PDF output (checked Chrome, Chromium, Edge and Brave; set CHROME_BIN to override). The HTML report is unchanged.'
    );
  }
  const pdfPath = htmlPath.replace(/\.html$/, '.pdf');
  const workDir = mkdtempSync(join(tmpdir(), 'matomo-report-'));
  try {
    const src = join(workDir, 'report.html');
    let pdfHtml = html.replace('</head>', `${pdfOnlyCss}\n</head>`);
    // Language of the whole document: the builders always set lang on the
    // html element; this fallback covers callers that omit it. Chrome copies
    // it into the tagged PDF's /Lang entry.
    if (!/<html\b[^>]*\blang\s*=/i.test(pdfHtml)) {
      pdfHtml = pdfHtml.replace('<html', `<html lang="${localeMeta().htmlLang}"`);
    }
    writeFileSync(src, pdfHtml);
    const run = spawnSync(
      browser,
      [
        '--headless=new',
        '--disable-gpu',
        '--no-pdf-header-footer',
        '--disable-dev-shm-usage',
        '--disable-setuid-sandbox',
        '--no-sandbox',
        // Tagged (accessible) PDF with a structure tree. Recent Chrome tags
        // every print-to-pdf by default (verified with Chrome 157); these
        // flags keep tagging on for older Chromium builds where it had to be
        // requested - both spellings have existed, and unknown switches are
        // ignored, so passing both is safe.
        '--generate-tagged-pdf',
        '--export-tagged-pdf',
        `--user-data-dir=${join(workDir, 'profile')}`,
        `--print-to-pdf=${pdfPath}`,
        pathToFileURL(src).href,
      ],
      { stdio: ['ignore', 'ignore', 'pipe'], encoding: 'utf8', timeout: 180000 }
    );
    if (run.error) throw new Error(`could not run ${browser}: ${run.error.message}`);
    if (run.status !== 0) {
      const tail = (run.stderr || '').trim().split('\n').slice(-4).join('\n');
      throw new Error(`${browser} exited with ${run.status}${tail ? `:\n${tail}` : ''}`);
    }
    // Chrome exits 0 without complaint - only a real PDF file proves it worked.
    if (!existsSync(pdfPath)) throw new Error(`${browser} produced no output file`);
    let bytes = statSync(pdfPath).size;
    if (bytes < 512 || readFileSync(pdfPath).subarray(0, 4).toString('latin1') !== '%PDF') {
      throw new Error(`output is not a PDF (only ${bytes} bytes)`);
    }
    let compressed = false;
    const tagged = isTaggedPdf(pdfPath);
    const gs = findGs();
    if (gs && bytes > 100 * 1024) {
      const shrunk = join(workDir, 'shrunk.pdf');
      const gsRun = spawnSync(
        gs,
        [
          '-q', '-dNOPAUSE', '-dBATCH', '-sDEVICE=pdfwrite',
          '-dCompatibilityLevel=1.5', '-dSubsetFonts=true', '-dCompressFonts=true',
          `-sOutputFile=${shrunk}`, pdfPath,
        ],
        { stdio: ['ignore', 'ignore', 'pipe'], encoding: 'utf8', timeout: 120000 }
      );
      const gsOk =
        gsRun.status === 0 &&
        existsSync(shrunk) &&
        statSync(shrunk).size > 512 &&
        readFileSync(shrunk).subarray(0, 4).toString('latin1') === '%PDF';
      // Replace only when the copy is really smaller, still has every page
      // and - the accessibility contract - still carries the structure tree:
      // Ghostscript's pdfwrite re-creates the document and drops the tags
      // (verified with gs 10.08), so a tagged PDF is never swapped for an
      // untagged one, even if that costs the kilobytes.
      if (gsOk && statSync(shrunk).size < bytes && (!tagged || isTaggedPdf(shrunk))) {
        // gs SAFER mode blocks PostScript file access unless permitted.
        const pages = (f) =>
          parseInt(
            String(
              spawnSync(gs, ['-q', '-dNODISPLAY', `--permit-file-read=${f}`, '-c', `(${f}) (r) file runpdfbegin pdfpagecount = quit`], {
                stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8', timeout: 60000,
              }).stdout
            ).match(/\d+/)?.[0] ?? '0',
            10
          );
        const before = pages(pdfPath);
        if (before > 0 && pages(shrunk) === before) {
          writeFileSync(pdfPath, readFileSync(shrunk));
          bytes = statSync(pdfPath).size;
          compressed = true;
        }
      }
    }
    return { pdfPath, bytes, compressed, ...inspectPdf(pdfPath) };
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

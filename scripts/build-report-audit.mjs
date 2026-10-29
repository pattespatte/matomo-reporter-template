#!/usr/bin/env node
// Build the accessibility-audit reference report for a site from the
// aggregated Matomo JSON in data/<slug>/ (pulled by pull_audit.sh).
//
//   bun scripts/build-report-audit.mjs <slug> [--pdf|--no-pdf]
//   (or: node scripts/build-report-audit.mjs <slug> ...)
//
// The slug is the site config name in config/ (e.g. test-example-com).
// The report is a single self-contained HTML file (inline CSS, inline SVG,
// no external requests) written to reports/<slug>--<start>_<end>.html.
// Missing data is tolerated and marked in the report.
//
// After writing the HTML, an interactive terminal is asked whether to also
// save the report as PDF (rendered with a Chromium-based browser, see
// report-common.mjs). --pdf forces it, --no-pdf and non-terminal stdin skip
// it. The PDF omits everything wrapped in <span class="internal"> - internal
// notes pointing at docs/how-to.md that make no sense outside the project -
// and is written as a tagged (accessible) PDF; Ghostscript compression only
// applies when it keeps those tags intact.
//
// Shared atoms, styles and the PDF pipeline live in report-common.mjs; this
// script defines the audit report's data, sections and assembly. The wider
// traffic overview built from pull_all.sh data is build-report-all.mjs.

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  fmt, fmtDur, fmtDate, share, esc, hits, sortByValue, safe,
  makeReadJson, unwrap, unwrapMonth, uniqVisitors,
  barCell, tableClass, DEVICE_LABELS_SV,
  rankTable, simpleTable, donut, barList, notice, kpiGrid,
  baseCss, parseReportArgv, listAvailableSlugs, runAllSites, askPdf, writePdf,
} from './report-common.mjs';

// --- CLI ---------------------------------------------------------------------

const here = dirname(fileURLToPath(import.meta.url));
const base = join(here, '..');

const { slug, unknownFlags, pdfFlag } = parseReportArgv(process.argv.slice(2));
if (!slug || unknownFlags.length) {
  console.error('usage: build-report-audit.mjs <slug|all> [--pdf|--no-pdf]    (e.g. test-example-com)');
  console.error('  all       build every site in config/ (data must be pulled first)');
  console.error('  --pdf     write reports/<slug>--<start>_<end>.pdf without asking');
  console.error('  --no-pdf  never write a PDF (also the default when stdin is not a terminal)');
  if (unknownFlags.length) console.error(`unknown option: ${unknownFlags.join(' ')}`);
  else {
    const have = listAvailableSlugs(base);
    if (have.length) console.error(`data available for: ${have.join(', ')}`);
  }
  process.exit(1);
}

const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);

// --- "all" builds every configured site ------------------------------------------

if (slug === 'all') {
  await runAllSites(fileURLToPath(import.meta.url), base, pdfFlag, interactive);
}

const dataDir = join(base, 'data', slug);
if (!existsSync(dataDir)) {
  console.error(`no data found in ${dataDir}`);
  console.error(`run ./scripts/pull_audit.sh ${slug} first - see docs/how-to.md`);
  process.exit(1);
}
const outDir = join(base, 'reports');

// --- Site-specific configuration -------------------------------------------

// Page-title labels that Matomo logs 404 pages under (lowercase, exact match).
// More titles can be added per site via EXTRA_NOT_FOUND_TITLES in the site
// config, which lands in data/<slug>/period.json.
const BASE_NOT_FOUND_TITLES = [
  'page not found',
  '404',
  'sidan hittades inte',
  'sidan kunde inte hittas',
  'hittades inte',
  'kunde inte hittas',
  'fel 404',
];

const TOP_PAGES = 15;
const TOP_SECTIONS = 10;
const TOP_ENTRY = 5;
const TOP_RESOLUTIONS = 8;
const TOP_BROWSERS = 8;
const TOP_OS = 6;
const TOP_LANGUAGES = 5;

const THEME_LABELS_SV = {
  light: 'Ljust läge',
  ljust: 'Ljust läge',
  dark: 'Mörkt läge',
  mörkt: 'Mörkt läge',
  mörk: 'Mörkt läge',
  system: 'Följer systemet',
  'no preference': 'Ingen inställning',
  unknown: 'Okänd',
};

const statusTable = (rows) => {
  const total = rows.reduce((s, r) => s + r.value, 0);
  const max = Math.max(...rows.map((r) => r.value), 1);
  return `
<table${tableClass(rows)}>
  <caption class="sr-only">HTTP-statuskoder, rangordnade efter antal besök</caption>
  <thead><tr>
    <th scope="col">Status</th>
    <th scope="col" class="barhead" aria-hidden="true"></th>
    <th scope="col" class="num">Besök</th>
    <th scope="col" class="num">Andel</th>
  </tr></thead>
  <tbody>
    ${rows
      .map((r) => {
        const bad = /^[45]\d\d$/.test(r.label);
        return `
    <tr${bad ? ' class="bad"' : ''}>
      <th scope="row" class="path">${esc(r.label)}</th>
      <td class="barcell">${barCell(r.value, max)}</td>
      <td class="num">${fmt.format(r.value)}</td>
      <td class="num">${share(r.value, total)}</td>
    </tr>`;
      })
      .join('')}
  </tbody>
</table>`;
};

// --- Load data ---------------------------------------------------------------

const readJson = makeReadJson(dataDir);

const period = readJson('period') ?? {};
const domain = typeof period.domain === 'string' && period.domain ? period.domain : slug;
const extraTitles = Array.isArray(period.extra_not_found_titles)
  ? period.extra_not_found_titles.map((t) => String(t).toLowerCase().trim()).filter(Boolean)
  : [];
const NOT_FOUND_TITLES = [...BASE_NOT_FOUND_TITLES, ...extraTitles];

const site = unwrap(readJson('site')) ?? {};
const summary = unwrap(readJson('visits_summary')) ?? {};
const actions = unwrap(readJson('actions_summary')) ?? {};
const summaryMonth = unwrapMonth(readJson('visits_summary_month'));

const rowsOf = (name) => {
  const raw = readJson(name);
  return Array.isArray(raw) ? raw.filter((r) => r && typeof r.label === 'string') : [];
};

const pageRows = rowsOf('page_urls');
const titleRows = rowsOf('page_titles');
const entryRows = rowsOf('entry_pages');

const visits = summary.nb_visits ?? 0;
const uniqueVisitors = uniqVisitors(summary, summaryMonth, period);
const pageviewsFromRows = pageRows.reduce((s, r) => s + hits(r), 0);
const totalPageviews = pageviewsFromRows || actions.nb_pageviews || 0;

// --- Derived data -------------------------------------------------------------

// Sections = first URL path segment, aggregated across all pages.
function sectionOf(label) {
  const path = String(label).replace(/^https?:\/\/[^/?#]+/i, '').split(/[?#]/)[0];
  const seg = path.split('/').filter(Boolean)[0];
  return seg ? `/${seg.replace(/\/+$/, '')}` : 'Startsida';
}

const sectionMap = new Map();
for (const r of pageRows) {
  const key = sectionOf(r.label);
  const cur = sectionMap.get(key) ?? 0;
  sectionMap.set(key, cur + hits(r));
}
const sectionTotal = [...sectionMap.values()].reduce((s, v) => s + v, 0);
const sectionRows = sortByValue([...sectionMap].map(([label, value]) => ({ label, value }))).slice(0, TOP_SECTIONS);

const topPages = sortByValue(pageRows.map((r) => ({ label: r.label, value: hits(r) }))).slice(0, TOP_PAGES);

const entryList = sortByValue(
  entryRows.map((r) => ({ label: r.label, value: r.entry_nb_visits ?? r.nb_visits ?? 0 }))
).slice(0, TOP_ENTRY);

// 404 pages: page-title rows whose title is a known "not found" label, with
// the per-address breakdown from the row's subtable (requires expanded=1).
function collectNotFound() {
  const rows = titleRows.filter((r) => NOT_FOUND_TITLES.includes(String(r.label).toLowerCase().trim()));
  const byUrl = new Map();
  for (const r of rows) {
    const urls = Array.isArray(r.subtable) && r.subtable.length ? r.subtable : [r];
    for (const u of urls) {
      const key = String(u.label);
      const cur = byUrl.get(key) ?? 0;
      byUrl.set(key, cur + hits(u));
    }
  }
  return sortByValue([...byUrl].map(([label, value]) => ({ label, value })));
}
const notFoundRows = collectNotFound();
const notFoundTotal = notFoundRows.reduce((s, r) => s + r.value, 0);

// Light/dark mode: custom dimension if configured, else events named light/dark.
function themeData() {
  const dim = readJson('theme_dimension');
  if (Array.isArray(dim) && dim.length) {
    const rows = dim.map((r) => ({
      label: THEME_LABELS_SV[String(r.label).toLowerCase().trim()] ?? String(r.label),
      value: r.nb_visits ?? 0,
    }));
    return { source: 'dimension', rows: sortByValue(rows) };
  }
  const ev = readJson('events_names');
  if (Array.isArray(ev)) {
    const picked = ev
      .filter((r) => /^(light|dark|ljust|mörkt|mörk|system|no preference)$/i.test(String(r.label).trim()))
      .map((r) => ({
        label: THEME_LABELS_SV[String(r.label).toLowerCase().trim()] ?? String(r.label),
        value: r.nb_events ?? 0,
      }));
    if (picked.length) return { source: 'events', rows: picked };
  }
  return null;
}
const theme = themeData();

// HTTP status codes: custom dimension if configured.
function statusData() {
  const dim = readJson('status_dimension');
  if (!Array.isArray(dim) || !dim.length) return null;
  return sortByValue(dim.map((r) => ({ label: String(r.label), value: r.nb_visits ?? 0 })));
}
const statuses = statusData();

const deviceRows = sortByValue(
  rowsOf('device_types').map((r) => ({ label: DEVICE_LABELS_SV[r.label] ?? (r.label || 'Okänd'), value: r.nb_visits ?? 0 }))
);

const namedRows = (name) => sortByValue(rowsOf(name).map((r) => ({ label: r.label, value: r.nb_visits ?? 0 })));
const totalsOf = (rows) => rows.reduce((s, r) => s + r.value, 0);

const browsersAll = namedRows('browsers');
const osAll = namedRows('os_families');
const resolutionsAll = namedRows('resolutions');
const languagesAll = namedRows('languages');
const browsers = browsersAll.slice(0, TOP_BROWSERS);
const osList = osAll.slice(0, TOP_OS);
const resolutions = resolutionsAll.slice(0, TOP_RESOLUTIONS);
const languages = languagesAll.slice(0, TOP_LANGUAGES);

// --- Section content ------------------------------------------------------------

// Distinguish a failed pull (only period.json landed in data/) from a real
// one: check whether any report file exists. A genuine zero-traffic period
// still produces report files, so it is not treated as a missing pull.
const pulled = [
  'site', 'visits_summary', 'actions_summary', 'page_urls', 'page_titles', 'entry_pages',
  'device_types', 'os_families', 'browsers', 'resolutions', 'languages', 'events_names',
  'theme_dimension', 'status_dimension',
].some((n) => existsSync(join(dataDir, `${n}.json`)));
const noData = !pulled;

const kpis = [
  { l: 'Besök', v: fmt.format(visits) },
  { l: 'Unika besökare', v: uniqueVisitors > 0 ? fmt.format(uniqueVisitors) : '–' },
  { l: 'Sidvisningar', v: fmt.format(totalPageviews) },
  { l: 'Sidvisningar per besök', v: visits > 0 ? (totalPageviews / visits).toFixed(1).replace('.', ',') : '–' },
  { l: 'Snitttid per besök', v: summary.avg_time_on_site ? fmtDur(summary.avg_time_on_site) : '–' },
];

const startTxt = fmtDate(period.start);
const endTxt = fmtDate(period.end);
const periodTxt = startTxt && endTxt ? `${startTxt} – ${endTxt}` : 'okänd period';
const generated = new Date().toLocaleString('sv-SE', { dateStyle: 'long', timeStyle: 'short' });
const siteName = typeof site.name === 'string' && site.name ? site.name : domain;

let themeContent;
if (theme) {
  const srcNote =
    theme.source === 'dimension'
      ? 'Källa: anpassad dimension i Matomo.'
      : 'Källa: händelser i Matomo. Värdet räknar byten av läge, inte besök.';
  themeContent = `${barList(theme.rows)}\n<p class="muted small">${srcNote}</p>`;
} else {
  themeContent = notice(
    '<p><strong>Ljust och mörkt läge spåras inte.</strong> Be Matomo-administratören skapa en dimension för färgschema och sätt MATOMO_THEME_DIMENSION i config-filen.<span class="internal"> Guiden <code>docs/how-to.md</code> beskriver hur det görs.</span></p>'
  );
}

let notFoundContent;
if (notFoundRows.length) {
  notFoundContent = rankTable(notFoundRows, notFoundTotal, {
    labelHead: 'Adress',
    valueHead: 'Sidvisningar',
    caption: 'Felsidor (404), rangordnade efter sidvisningar',
  });
} else {
  notFoundContent =
    '<p class="muted">Inga 404-sidor har registrerats under perioden. Det kan också bero på att 404-sidans rubrik inte matchar de eftersökta titlarna. Fler titlar läggs till med EXTRA_NOT_FOUND_TITLES i config-filen.</p>';
}

let statusContent;
if (statuses) {
  statusContent = `<h3>Statuskoder</h3>\n  ${statusTable(statuses)}`;
} else {
  statusContent = '';
}

// <span class="internal"> marks internal-only notes (references to
// docs/how-to.md). The HTML report keeps them; writePdf hides them so a
// shared PDF points at no project-internal files.
const methodItems = [
  `Källan är Matomos rapport-API för webbplatsen ${esc(siteName)} (${esc(domain)}). Alla värden är aggregerade och innehåller inga personuppgifter.`,
  'Matomo mäter bara det som sker i besökarens webbläsare. Serverfel som gör att sidan inte laddas alls syns därför inte i siffrorna.',
  ...(uniqueVisitors > 0
    ? []
    : ['Antalet unika besökare för en hel period kräver en inställning i Matomo. Saknas värdet beror det på inställningen, inte på att besökare saknas.']),
  'Ljust och mörkt läge samt HTTP-statuskoder kräver egen spårning.<span class="internal"> Hur den konfigureras står i docs/how-to.md.</span>',
];

// --- Assemble -----------------------------------------------------------------

const html = `<!DOCTYPE html>
<html lang="sv">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="description" content="Underlag till tillgänglighetsgranskning för ${esc(domain)} - Matomo-analys ${esc(periodTxt)}">
<title>Underlag till tillgänglighetsgranskning – ${esc(domain)}</title>
<style>${baseCss}</style>
</head>
<body>
<div class="wrap">
<header class="masthead">
  <p class="kicker">Underlag till tillgänglighetsgranskning</p>
  <h1>${esc(domain)}</h1>
  <p class="meta">Period: ${esc(periodTxt)} · Källa: Matomo · Rapport genererad ${esc(generated)}</p>
</header>
<main id="main-content">
${
  noData
    ? notice('<p><strong>Inga data hittades i mappen data.</strong> Kör <code>./scripts/pull_audit.sh</code> först.<span class="internal"> Guiden <code>docs/how-to.md</code> beskriver stegen.</span></p>')
    : ''
}
${kpiGrid(kpis)}

<section class="card">
  <h2>Mest besökta sidor</h2>
  <p class="lead">Sidorna med flest sidvisningar bör granskas först, eftersom de flesta besökare möter dem.</p>
  ${rankTable(topPages, totalPageviews, { labelHead: 'Sida', valueHead: 'Sidvisningar', caption: 'Mest besökta sidor, rangordnade efter sidvisningar' })}
  ${entryList.length ? `<h3>Vanligaste ingångssidorna</h3>${simpleTable(entryList, visits, 'Sida', 'Ingångsbesök', 'Vanligaste ingångssidorna med antal ingångsbesök')}` : ''}
</section>

<section class="card">
  <h2>Mest besökta avsnitt</h2>
  <p class="lead">Avsnitten visar andelen sidvisningar per del av webbplatsen, räknat på första nivån i webbadressen. Använd andelarna för att prioritera granskningsinsatsen.</p>
  ${rankTable(sectionRows, sectionTotal, { labelHead: 'Avsnitt', valueHead: 'Sidvisningar', caption: 'Avsnitt, rangordnade efter sidvisningar' })}
</section>

<section class="card">
  <h2>Enheter, skärmar och programvara</h2>
  <p class="lead">Fördelningen visar vilka skärmar och inmatningssätt samt vilka webbläsar- och operativsystemkombinationer som bör ingå i testet. Skärmläsare testas i de mest använda webbläsarna.</p>
  <h3>Enhetstyp</h3>
  ${donut(deviceRows)}
  <div class="duo">
    <div>
      <h3>Upplösningar</h3>
      ${simpleTable(resolutions, totalsOf(resolutionsAll), 'Upplösning', 'Besök', 'Upplösningar, rangordnade efter antal besök')}
    </div>
    <div>
      <h3>Webbläsare</h3>
      ${simpleTable(browsers, totalsOf(browsersAll), 'Webbläsare', 'Besök', 'Webbläsare, rangordnade efter antal besök')}
    </div>
    <div>
      <h3>Operativsystem</h3>
      ${simpleTable(osList, totalsOf(osAll), 'Operativsystem', 'Besök', 'Operativsystem, rangordnade efter antal besök')}
    </div>
    <div>
      <h3>Språk i webbläsaren</h3>
      ${simpleTable(languages, totalsOf(languagesAll), 'Språk', 'Besök', 'Språkinställning i webbläsaren, rangordnad efter antal besök')}
    </div>
  </div>
</section>

<section class="card">
  <h2>Ljust och mörkt läge</h2>
  <p class="lead">Kontrast och färg behöver granskas i både ljust och mörkt läge. Fördelningen visar hur vanligt varje läge är under perioden.</p>
  ${themeContent}
</section>

<section class="card">
  <h2>Felsidor och HTTP-status</h2>
  <p class="lead">Även felsidor ska vara tillgängliga. Listan visar vilka adresser som behöver åtgärdas och granskas.</p>
  <h3>404-sidor</h3>
  ${notFoundContent}
  ${statusContent}
</section>

<section class="card">
  <h2>Metod och begränsningar</h2>
  <ul>
    ${methodItems.map((t) => `<li>${t}</li>`).join('\n    ')}
  </ul>
</section>

</main>
<footer>
  <p>Automatgenererad av <code>build-report-audit.mjs</code>. Underlaget visar aggregerad trafik och ska läsas tillsammans med granskningens övriga material.</p>
</footer>
</div>
</body>
</html>
`;

// --- Write ---------------------------------------------------------------------

mkdirSync(outDir, { recursive: true });
const stamp = safe(period.start) && safe(period.end) ? `${safe(period.start)}_${safe(period.end)}` : 'senaste';
const outFile = join(outDir, `${slug}--${stamp}.html`);
writeFileSync(outFile, html);

// A report with no numbers in it is almost certainly a failed or skipped
// pull (only period.json landed in data/). Write the file for inspection,
// but fail loudly so it can't be mistaken for a real result.
if (noData) {
  console.error(`WARNING: no report data found in ${dataDir} - ${outFile} contains zeros only.`);
  console.error(`run ./scripts/pull_audit.sh ${slug} first and make sure it ends with "all fetches ok" - see docs/how-to.md`);
  process.exit(1);
}
console.log(`ok: ${outFile}`);

// --- Optional PDF ---------------------------------------------------------------

// Ask only when someone is actually at the terminal; --pdf/--no-pdf decide
// for scripts, tests and pipes, and a bare run with no terminal stdin never
// blocks on a question nobody can answer.
let wantPdf;
if (pdfFlag !== null) {
  wantPdf = pdfFlag;
} else if (!interactive) {
  wantPdf = false;
} else {
  wantPdf = await askPdf();
}

if (wantPdf) {
  try {
    const { pdfPath, bytes, compressed, tagged, lang, title } = writePdf(outFile, html);
    const traits = [
      `${Math.round(bytes / 1024)} kB`,
      'docs references omitted',
      ...(compressed ? ['Ghostscript-compressed'] : []),
      tagged ? 'tagged' : 'WARNING: NOT TAGGED',
      ...(lang ? [`lang ${lang}`] : []),
      ...(title ? [`title "${title}"`] : []),
    ];
    console.log(`ok: ${pdfPath} (${traits.join(', ')})`);
    if (!tagged) {
      console.error(`WARNING: ${pdfPath} has no structure tree - update the Chromium-based browser (tagged output needs a reasonably current one).`);
    }
  } catch (err) {
    console.error(`ERROR writing PDF: ${err.message}`);
    process.exit(1);
  }
}

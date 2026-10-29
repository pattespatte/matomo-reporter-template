#!/usr/bin/env node
// Build the traffic-overview report for a site from the aggregated Matomo
// JSON in data/<slug>/ (pulled by pull_all.sh).
//
//   bun scripts/build-report-all.mjs <slug> [--pdf|--no-pdf]
//   (or: node scripts/build-report-all.mjs <slug> ...)
//
// Wider than the audit report (build-report-audit.mjs): daily trend, hour of
// day, new vs returning visitors, engagement, geography and traffic sources
// on top of the device and page breakdowns. The report renders aggregated
// reports only - the visitor-level rows in data/<slug>/live/ are never read,
// so the report stays free of personal data.
//
// Output: reports/<slug>--<start>_<end>--all.html (+ .pdf when requested).
// Shared atoms, styles and the PDF pipeline live in report-common.mjs.

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  fmt, fmtDur, fmtDate, share, esc, hits, sortByValue, safe,
  makeReadJson, unwrap, unwrapMonth, uniqVisitors,
  barCell, tableClass, DEVICE_LABELS_SV,
  rankTable, simpleTable, donut, barList, barChart, notice, kpiGrid,
  baseCss, chartCss, parseReportArgv, listAvailableSlugs, runAllSites, askPdf, writePdf,
} from './report-common.mjs';

// --- CLI ---------------------------------------------------------------------

const here = dirname(fileURLToPath(import.meta.url));
const base = join(here, '..');

const { slug, unknownFlags, pdfFlag } = parseReportArgv(process.argv.slice(2));
if (!slug || unknownFlags.length) {
  console.error('usage: build-report-all.mjs <slug|all> [--pdf|--no-pdf]    (e.g. test-example-com)');
  console.error('  all       build every site in config/ (data must be pulled first)');
  console.error('  --pdf     write reports/<slug>--<start>_<end>--all.pdf without asking');
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
  console.error(`run ./scripts/pull_all.sh ${slug} first - see docs/how-to.md`);
  process.exit(1);
}
const outDir = join(base, 'reports');

// --- Tunables -----------------------------------------------------------------

const TOP_PAGES = 15;
const TOP_ENTRY = 5;
const TOP_EXIT = 8;
const TOP_REGIONS = 8;
const TOP_RESOLUTIONS = 8;
const TOP_BROWSERS = 8;
const TOP_BROWSER_VERSIONS = 8;
const TOP_OS = 6;
const TOP_OS_VERSIONS = 6;
const TOP_LANGUAGES = 5;

// --- Load data ---------------------------------------------------------------

const readJson = makeReadJson(dataDir);

const period = readJson('period') ?? {};
const domain = typeof period.domain === 'string' && period.domain ? period.domain : slug;

const site = unwrap(readJson('site')) ?? {};
const summary = unwrap(readJson('visits_summary')) ?? {};
const actions = unwrap(readJson('actions_summary')) ?? {};
const frequency = unwrap(readJson('visit_frequency')) ?? {};
const summaryMonth = unwrapMonth(readJson('visits_summary_month'));

const rowsOf = (name) => {
  const raw = readJson(name);
  return Array.isArray(raw) ? raw.filter((r) => r && typeof r.label === 'string') : [];
};

const visits = summary.nb_visits ?? 0;
const uniqueVisitors = uniqVisitors(summary, summaryMonth, period);
const totalPageviews = actions.nb_pageviews ?? 0;
const newVisits = frequency.nb_visits_new ?? 0;
const returningVisits = frequency.nb_visits_returning ?? 0;

// Daily series: the period=day summary comes keyed by date (older pulls
// predate the fetch - the report notices instead of guessing).
const dailyRaw = readJson('visits_summary_daily');
const shortDay = (iso) => {
  const [, m, d] = String(iso).split('-');
  return `${Number(d)}/${Number(m)}`;
};
const dailyRows =
  dailyRaw && !Array.isArray(dailyRaw) && typeof dailyRaw === 'object'
    ? Object.keys(dailyRaw)
        .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
        .sort()
        .map((d) => ({ label: shortDay(d), value: Number(dailyRaw[d]?.nb_visits) || 0 }))
    : [];

// Hour of day: 24 rows labelled "00"-"23"; keep numeric order.
const hourRows = rowsOf('local_time')
  .map((r) => ({ label: String(r.label), value: r.nb_visits ?? 0 }))
  .sort((a, b) => Number(a.label) - Number(b.label));

// Engagement buckets are ordinal (0-10s ... 30+ min) - never sort by value.
const durationRows = rowsOf('interest_duration').map((r) => ({ label: r.label, value: r.nb_visits ?? 0 }));
const pagesRows = rowsOf('interest_actions').map((r) => ({ label: r.label, value: r.nb_visits ?? 0 }));
const loyaltyRows = rowsOf('visits_by_visit_count').map((r) => ({ label: r.label, value: r.nb_visits ?? 0 }));

// Geography: country names arrive in Swedish; region labels carry an ISO
// code in brackets ("Stockholms län [SE-01], Sverige") that adds noise.
const stripCode = (s) => String(s).replace(/\s*\[[^\]]*\]/g, '');
const countryRows = sortByValue(rowsOf('countries').map((r) => ({ label: r.label, value: r.nb_visits ?? 0 })));
const regionRows = sortByValue(
  rowsOf('regions').map((r) => ({ label: stripCode(r.label), value: r.nb_visits ?? 0 }))
).slice(0, TOP_REGIONS);

// Traffic sources: the type report decides the donut, the detail reports
// are often empty (nothing linked here, no campaigns) - tolerated below.
const refTypeRows = sortByValue(rowsOf('referrer_types').map((r) => ({ label: r.label, value: r.nb_visits ?? 0 })));
const refWebsites = rowsOf('referrer_websites').map((r) => ({ label: r.label, value: r.nb_visits ?? 0 }));
const refEngines = rowsOf('referrer_search_engines').map((r) => ({ label: r.label, value: r.nb_visits ?? 0 }));
const refKeywords = rowsOf('referrer_keywords').map((r) => ({ label: r.label, value: r.nb_visits ?? 0 }));
const refCampaigns = rowsOf('referrer_campaigns').map((r) => ({ label: r.label, value: r.nb_visits ?? 0 }));

// Devices and software: family level first, versions after.
const deviceRows = sortByValue(
  rowsOf('device_types').map((r) => ({ label: DEVICE_LABELS_SV[r.label] ?? (r.label || 'Okänd'), value: r.nb_visits ?? 0 }))
);
const namedRows = (name) => sortByValue(rowsOf(name).map((r) => ({ label: r.label, value: r.nb_visits ?? 0 })));
const totalsOf = (rows) => rows.reduce((s, r) => s + r.value, 0);
const browsersAll = namedRows('browsers');
const browserVersionsAll = namedRows('browser_versions');
const osAll = namedRows('os_families');
const osVersionsAll = namedRows('os_versions');
const resolutionsAll = namedRows('resolutions');
const languagesAll = namedRows('languages');

// Pages: entry pages count entrances, exit pages carry their own rate.
const pageRows = rowsOf('page_urls');
const entryList = sortByValue(
  rowsOf('entry_pages').map((r) => ({ label: r.label, value: r.entry_nb_visits ?? r.nb_visits ?? 0 }))
).slice(0, TOP_ENTRY);
const exitRows = sortByValue(
  rowsOf('exit_pages').map((r) => ({ label: r.label, value: r.exit_nb_visits ?? r.nb_visits ?? 0, rate: r.exit_rate ?? '–' }))
).slice(0, TOP_EXIT);

// --- Section content ------------------------------------------------------------

// A pull_all dataset always leaves report files behind (a zero-traffic
// month included); only period.json means the pull never happened.
const pulled = [
  'site', 'visits_summary', 'visit_frequency', 'local_time', 'referrer_types',
  'countries', 'device_types', 'interest_duration', 'exit_pages', 'page_urls',
].some((n) => existsSync(join(dataDir, `${n}.json`)));
const noData = !pulled;

const kpis = [
  { l: 'Besök', v: fmt.format(visits) },
  { l: 'Unika besökare', v: uniqueVisitors > 0 ? fmt.format(uniqueVisitors) : '–' },
  { l: 'Sidvisningar', v: fmt.format(totalPageviews) },
  { l: 'Sidvisningar per besök', v: visits > 0 ? (totalPageviews / visits).toFixed(1).replace('.', ',') : '–' },
  { l: 'Snitttid per besök', v: summary.avg_time_on_site ? fmtDur(summary.avg_time_on_site) : '–' },
  { l: 'Nya / återkommande besök', v: newVisits + returningVisits > 0 ? `${fmt.format(newVisits)} / ${fmt.format(returningVisits)}` : '–' },
];

const startTxt = fmtDate(period.start);
const endTxt = fmtDate(period.end);
const periodTxt = startTxt && endTxt ? `${startTxt} – ${endTxt}` : 'okänd period';
const generated = new Date().toLocaleString('sv-SE', { dateStyle: 'long', timeStyle: 'short' });
const siteName = typeof site.name === 'string' && site.name ? site.name : domain;

const trendContent = dailyRows.length
  ? barChart(dailyRows, { labelEvery: 5, caption: 'Antal besök per dag under perioden' })
  : notice(
      '<p><strong>Daglig utveckling saknas.</strong> Filen tillkom i pull_all.sh den 27 oktober 2026 – kör en ny dragning så fylls avsnittet.</p>'
    );

const freqGroups = [
  {
    label: 'Nya besök',
    visits: newVisits,
    ppv: frequency.nb_actions_per_visit_new,
    dur: frequency.avg_time_on_site_new,
  },
  {
    label: 'Återkommande besök',
    visits: returningVisits,
    ppv: frequency.nb_actions_per_visit_returning,
    dur: frequency.avg_time_on_site_returning,
  },
];
const freqTotal = newVisits + returningVisits;
const freqTable = freqTotal > 0
  ? `
<table>
  <caption class="sr-only">Nya och återkommande besök, med sidvisningar per besök och snitttid</caption>
  <thead><tr>
    <th scope="col">Grupp</th>
    <th scope="col" class="num">Besök</th>
    <th scope="col" class="num">Andel</th>
    <th scope="col" class="num">Sidor per besök</th>
    <th scope="col" class="num">Snitttid</th>
  </tr></thead>
  <tbody>
    ${freqGroups
      .map(
        (g) => `
    <tr>
      <td>${esc(g.label)}</td>
      <td class="num">${fmt.format(g.visits)}</td>
      <td class="num">${share(g.visits, freqTotal)}</td>
      <td class="num">${g.ppv != null ? Number(g.ppv).toFixed(1).replace('.', ',') : '–'}</td>
      <td class="num">${g.dur != null ? fmtDur(g.dur) : '–'}</td>
    </tr>`
      )
      .join('')}
  </tbody>
</table>`
  : '<p class="muted">Inga data.</p>';

const exitTable = (rows) => {
  if (!rows.length) return '<p class="muted">Inga data.</p>';
  const max = Math.max(...rows.map((r) => r.value), 1);
  return `
<table${tableClass(rows)}>
  <caption class="sr-only">Vanligaste utgångssidorna, rangordnade efter utgångsbesök</caption>
  <thead><tr>
    <th scope="col" class="num">#</th>
    <th scope="col">Sida</th>
    <th scope="col" class="barhead" aria-hidden="true"></th>
    <th scope="col" class="num">Utgångsbesök</th>
    <th scope="col" class="num">Utgångsfrekvens</th>
  </tr></thead>
  <tbody>
    ${rows
      .map(
        (r, i) => `
    <tr>
      <td class="num muted">${i + 1}</td>
      <td class="path">${esc(r.label)}</td>
      <td class="barcell">${barCell(r.value, max)}</td>
      <td class="num">${fmt.format(r.value)}</td>
      <td class="num">${esc(r.rate)}</td>
    </tr>`
      )
      .join('')}
  </tbody>
</table>`;
};

const methodItems = [
  `Källan är Matomos rapport-API för webbplatsen ${esc(siteName)} (${esc(domain)}). Rapporten bygger endast på aggregerade värden och innehåller inga personuppgifter.`,
  'Matomo mäter bara det som sker i besökarens webbläsare. Serverfel som gör att sidan inte laddas alls syns därför inte i siffrorna.',
  ...(uniqueVisitors > 0
    ? []
    : ['Antalet unika besökare för en hel period kräver en inställning i Matomo. Saknas värdet beror det på inställningen, inte på att besökare saknas.']),
  'Geografiska uppgifter bygger på geolokalisering av besökarens nätverksanslutning och är approximativa.',
];

// --- Assemble -----------------------------------------------------------------

const css = baseCss + chartCss;

const html = `<!DOCTYPE html>
<html lang="sv">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Trafiköversikt – ${esc(domain)}</title>
<style>${css}</style>
</head>
<body>
<div class="wrap">
<header class="masthead">
  <p class="kicker">Trafiköversikt</p>
  <h1>${esc(domain)}</h1>
  <p class="meta">Period: ${esc(periodTxt)} · Källa: Matomo · Rapport genererad ${esc(generated)}</p>
</header>
${
  noData
    ? notice('<p><strong>Inga data hittades i mappen data.</strong> Kör <code>./scripts/pull_all.sh</code> först.<span class="internal"> Guiden <code>docs/how-to.md</code> beskriver stegen.</span></p>')
    : ''
}
${kpiGrid(kpis)}

<section class="card">
  <h2>Utveckling över perioden</h2>
  <p class="lead">Besöken per dag visar hur trafiken har rört sig under perioden, till exempel veckorytm och enstaka toppar.</p>
  ${trendContent}
</section>

<section class="card">
  <h2>Tid på dygnet</h2>
  <p class="lead">Besöken fördelade på dygnets timmar, räknat i besökarens lokala tid. Mönstret visar när webbplatsen faktiskt används.</p>
  ${barChart(hourRows, { labelEvery: 3, caption: 'Antal besök per timme på dygnet' })}
</section>

<section class="card">
  <h2>Nya och återkommande besökare</h2>
  <p class="lead">Återkommande besökare har besökt webbplatsen tidigare. Jämför grupperna – återkommande besökare läser ofta fler sidor och stannar längre.</p>
  ${donut([
    { label: 'Nya besök', value: newVisits },
    { label: 'Återkommande besök', value: returningVisits },
  ])}
  ${freqTable}
</section>

<section class="card">
  <h2>Engagemang</h2>
  <p class="lead">Hur länge besökarna stannar, hur många sidor de ser per besök och hur många gånger de kommer tillbaka.</p>
  <div class="duo">
    <div>
      <h3>Besökslängd</h3>
      ${barList(durationRows)}
    </div>
    <div>
      <h3>Sidor per besök</h3>
      ${barList(pagesRows)}
    </div>
    <div>
      <h3>Antal besök per besökare</h3>
      ${barList(loyaltyRows)}
    </div>
  </div>
</section>

<section class="card">
  <h2>Geografi</h2>
  <p class="lead">Besökarnas länder och regioner. Uppgifterna bygger på geolokalisering och är approximativa.</p>
  <div class="duo">
    <div>
      <h3>Länder</h3>
      ${simpleTable(countryRows, totalsOf(countryRows), 'Land', 'Besök', 'Länder, rangordnade efter antal besök')}
    </div>
    <div>
      <h3>Regioner</h3>
      ${simpleTable(regionRows, totalsOf(regionRows), 'Region', 'Besök', 'Regioner, rangordnade efter antal besök')}
    </div>
  </div>
</section>

<section class="card">
  <h2>Trafikkällor</h2>
  <p class="lead">Hur besökarna hittade till webbplatsen: direkt, via länkar, sök, delade länkar eller kampanjer.</p>
  ${donut(refTypeRows)}
  <div class="duo">
    <div>
      <h3>Länkande webbplatser</h3>
      ${simpleTable(refWebsites, totalsOf(refWebsites), 'Webbplats', 'Besök', 'Länkande webbplatser, rangordnade efter antal besök')}
    </div>
    <div>
      <h3>Sökmotorer</h3>
      ${simpleTable(refEngines, totalsOf(refEngines), 'Sökmotor', 'Besök', 'Sökmotorer, rangordnade efter antal besök')}
    </div>
    <div>
      <h3>Sökord</h3>
      ${simpleTable(refKeywords, totalsOf(refKeywords), 'Sökord', 'Besök', 'Sökord, rangordnade efter antal besök')}
    </div>
    <div>
      <h3>Kampanjer</h3>
      ${simpleTable(refCampaigns, totalsOf(refCampaigns), 'Kampanj', 'Besök', 'Kampanjer, rangordnade efter antal besök')}
    </div>
  </div>
</section>

<section class="card">
  <h2>Enheter, skärmar och programvara</h2>
  <p class="lead">Vilka enheter, skärmstorlekar och programversioner besökarna använder. Äldre versioner kan ha begränsat stöd för moderna funktioner.</p>
  <h3>Enhetstyp</h3>
  ${donut(deviceRows)}
  <div class="duo">
    <div>
      <h3>Upplösningar</h3>
      ${simpleTable(resolutionsAll.slice(0, TOP_RESOLUTIONS), totalsOf(resolutionsAll), 'Upplösning', 'Besök', 'Upplösningar, rangordnade efter antal besök')}
    </div>
    <div>
      <h3>Webbläsare</h3>
      ${simpleTable(browsersAll.slice(0, TOP_BROWSERS), totalsOf(browsersAll), 'Webbläsare', 'Besök', 'Webbläsare, rangordnade efter antal besök')}
    </div>
    <div>
      <h3>Webbläsarversioner</h3>
      ${simpleTable(browserVersionsAll.slice(0, TOP_BROWSER_VERSIONS), totalsOf(browserVersionsAll), 'Version', 'Besök', 'Webbläsarversioner, rangordnade efter antal besök')}
    </div>
    <div>
      <h3>Operativsystem</h3>
      ${simpleTable(osAll.slice(0, TOP_OS), totalsOf(osAll), 'Operativsystem', 'Besök', 'Operativsystem, rangordnade efter antal besök')}
    </div>
    <div>
      <h3>Operativsystemversioner</h3>
      ${simpleTable(osVersionsAll.slice(0, TOP_OS_VERSIONS), totalsOf(osVersionsAll), 'Version', 'Besök', 'Operativsystemversioner, rangordnade efter antal besök')}
    </div>
    <div>
      <h3>Språk i webbläsaren</h3>
      ${simpleTable(languagesAll.slice(0, TOP_LANGUAGES), totalsOf(languagesAll), 'Språk', 'Besök', 'Språkinställning i webbläsaren, rangordnad efter antal besök')}
    </div>
  </div>
</section>

<section class="card">
  <h2>Mest besökta sidor</h2>
  <p class="lead">Sidorna med flest sidvisningar under perioden, tillsammans med vanligaste ingångs- och utgångssidorna.</p>
  ${rankTable(sortByValue(pageRows.map((r) => ({ label: r.label, value: hits(r) }))).slice(0, TOP_PAGES), pageRows.reduce((s, r) => s + hits(r), 0), { labelHead: 'Sida', valueHead: 'Sidvisningar', caption: 'Mest besökta sidor, rangordnade efter sidvisningar' })}
  ${entryList.length ? `<h3>Vanligaste ingångssidorna</h3>${simpleTable(entryList, visits, 'Sida', 'Ingångsbesök', 'Vanligaste ingångssidorna med antal ingångsbesök')}` : ''}
  <h3>Vanligaste utgångssidorna</h3>
  ${exitTable(exitRows)}
</section>

<section class="card">
  <h2>Metod och begränsningar</h2>
  <ul>
    ${methodItems.map((t) => `<li>${t}</li>`).join('\n    ')}
  </ul>
</section>

<footer>
  <p>Automatgenererad av <code>build-report-all.mjs</code>. Trafiköversikten visar aggregerad trafik och kompletteras av underlaget till tillgänglighetsgranskningen.</p>
</footer>
</div>
</body>
</html>
`;

// --- Write ---------------------------------------------------------------------

mkdirSync(outDir, { recursive: true });
const stamp = safe(period.start) && safe(period.end) ? `${safe(period.start)}_${safe(period.end)}` : 'senaste';
const outFile = join(outDir, `${slug}--${stamp}--all.html`);
writeFileSync(outFile, html);

// A report with no numbers in it is almost certainly a failed or skipped
// pull (only period.json landed in data/). Write the file for inspection,
// but fail loudly so it can't be mistaken for a real result.
if (noData) {
  console.error(`WARNING: no report data found in ${dataDir} - ${outFile} contains zeros only.`);
  console.error(`run ./scripts/pull_all.sh ${slug} first and make sure it ends with "all fetches ok" - see docs/how-to.md`);
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
    const { pdfPath, bytes, compressed } = writePdf(outFile, html);
    console.log(`ok: ${pdfPath} (${Math.round(bytes / 1024)} kB, docs references omitted${compressed ? ', Ghostscript-compressed' : ''})`);
  } catch (err) {
    console.error(`ERROR writing PDF: ${err.message}`);
    process.exit(1);
  }
}

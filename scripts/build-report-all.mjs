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
  fmt, fmtDur, fmtDate, fmtDec1, fmtDateTime, shortDay, share, esc, hits, sortByValue, safe,
  makeReadJson, unwrap, unwrapMonth, uniqVisitors, useLocale,
  barCell, tableClass,
  rankTable, simpleTable, donut, barList, barChart, notice, kpiGrid,
  baseCss, chartCss, parseReportArgv, listAvailableSlugs, runAllSites, askPdf, writePdf,
} from './report-common.mjs';
import { tr, mapLabel, localeMeta } from './locales/index.mjs';
import { loadSettings, resolveReportLanguage } from './settings.mjs';

// --- CLI ---------------------------------------------------------------------

const here = dirname(fileURLToPath(import.meta.url));
const base = join(here, '..');
const settings = loadSettings(base);

const { slug, unknownFlags, pdfFlag, langFlag } = parseReportArgv(process.argv.slice(2));
if (!slug || unknownFlags.length) {
  console.error('usage: build-report-all.mjs <slug|all> [--pdf|--no-pdf] [--lang=<code>]    (e.g. test-example-com)');
  console.error('  all       build every site in config/ (data must be pulled first)');
  console.error('  --pdf     write reports/<slug>--<start>_<end>--all.pdf without asking');
  console.error('  --no-pdf  never write a PDF (also the default when stdin is not a terminal)');
  console.error('  --lang    report language (en | fr | de | es | sv); default from settings.json');
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
  await runAllSites(fileURLToPath(import.meta.url), base, pdfFlag, interactive, langFlag);
}

const dataDir = join(base, 'data', slug);
if (!existsSync(dataDir)) {
  console.error(`no data found in ${dataDir}`);
  console.error(`run ./scripts/pull_all.sh ${slug} first - see docs/how-to.md`);
  process.exit(1);
}
const outDir = join(base, 'reports');

// --- Tunables -----------------------------------------------------------------

const TOP_PAGES = settings.topRows.pages;
const TOP_ENTRY = settings.topRows.entryPages;
const TOP_EXIT = settings.topRows.exitPages;
const TOP_REGIONS = settings.topRows.regions;
const TOP_RESOLUTIONS = settings.topRows.resolutions;
const TOP_BROWSERS = settings.topRows.browsers;
const TOP_BROWSER_VERSIONS = settings.topRows.browserVersions;
const TOP_OS = settings.topRows.operatingSystems;
const TOP_OS_VERSIONS = settings.topRows.osVersions;
const TOP_LANGUAGES = settings.topRows.languages;

// --- Load data ---------------------------------------------------------------

const readJson = makeReadJson(dataDir);

const period = readJson('period') ?? {};
const domain = typeof period.domain === 'string' && period.domain ? period.domain : slug;

// Report language: --lang flag > REPORT_LANG env > settings.json > the
// language recorded by the pull in period.json > Swedish. Everything below
// this line renders through the chosen locale's strings and formatters.
useLocale(resolveReportLanguage({ flag: langFlag, env: process.env.REPORT_LANG, settings, periodLang: period.language }));

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
const dailyRows =
  dailyRaw && !Array.isArray(dailyRaw) && typeof dailyRaw === 'object'
    ? Object.keys(dailyRaw)
        .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
        .sort()
        .map((d) => ({ label: shortDay(d), value: Number(dailyRaw[d]?.nb_visits) || 0 }))
    : [];

// Hour of day: 24 rows labeled "00"-"23"; keep numeric order.
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
  rowsOf('device_types').map((r) => ({ label: mapLabel('devices', r.label, r.label || tr('common.deviceUnknown')), value: r.nb_visits ?? 0 }))
);
const namedRows = (name) => sortByValue(rowsOf(name).map((r) => ({ label: r.label, value: r.nb_visits ?? 0 })));
const totalsOf = (rows) => rows.reduce((s, r) => s + r.value, 0);
const browsersAll = namedRows('browsers');
const browserVersionsAll = namedRows('browser_versions');
const osAll = namedRows('os_families');
const osVersionsAll = namedRows('os_versions');
const resolutionsAll = namedRows('resolutions');
const languagesAll = namedRows('languages');

// Pages: entry pages count entrances, exit pages carry their own rate -
// which Matomo delivers preformatted in the pull's language ("12,7 %").
// Parse it tolerantly (comma or dot) and re-render in the report language;
// anything unparseable passes through as-is.
const formatExitRate = (raw) => {
  const m = /^\s*([\d.,]+)\s*%\s*$/.exec(String(raw ?? ''));
  if (!m) return String(raw ?? '–');
  const num = Number(m[1].replace(',', '.'));
  if (Number.isNaN(num)) return String(raw);
  // The reports use a regular space before % everywhere else (donut aria
  // labels included); the NBSP some locales get from Intl is normalized here.
  return new Intl.NumberFormat(localeMeta().tag, { style: 'percent', maximumFractionDigits: 1 })
    .format(num / 100)
    .replace(/\u00A0|\u202F/g, ' ');
};
const pageRows = rowsOf('page_urls');
const entryList = sortByValue(
  rowsOf('entry_pages').map((r) => ({ label: r.label, value: r.entry_nb_visits ?? r.nb_visits ?? 0 }))
).slice(0, TOP_ENTRY);
const exitRows = sortByValue(
  rowsOf('exit_pages').map((r) => ({ label: r.label, value: r.exit_nb_visits ?? r.nb_visits ?? 0, rate: formatExitRate(r.exit_rate ?? '–') }))
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
  { l: tr('common.kpiVisits'), v: fmt.format(visits) },
  { l: tr('common.kpiUniqueVisitors'), v: uniqueVisitors > 0 ? fmt.format(uniqueVisitors) : '–' },
  { l: tr('common.kpiPageviews'), v: fmt.format(totalPageviews) },
  { l: tr('common.kpiPageviewsPerVisit'), v: visits > 0 ? fmtDec1(totalPageviews / visits) : '–' },
  { l: tr('common.kpiAvgTime'), v: summary.avg_time_on_site ? fmtDur(summary.avg_time_on_site) : '–' },
  { l: tr('all.kpiNewReturning'), v: newVisits + returningVisits > 0 ? `${fmt.format(newVisits)} / ${fmt.format(returningVisits)}` : '–' },
];

const startTxt = fmtDate(period.start);
const endTxt = fmtDate(period.end);
const periodTxt = startTxt && endTxt ? `${startTxt} – ${endTxt}` : tr('common.unknownPeriod');
const generated = fmtDateTime(new Date());
const siteName = typeof site.name === 'string' && site.name ? site.name : domain;

// The fixed release date of the visits_summary_daily fetch, rendered in the
// report language inside the "daily data missing" notice.
const dailySince = fmtDate('2026-10-27');

const trendContent = dailyRows.length
  ? barChart(dailyRows, { labelEvery: 5, caption: tr('all.captionDaily') })
  : notice(`<p>${tr('all.dailyMissingNotice', { date: dailySince })}</p>`);

const freqGroups = [
  {
    label: tr('all.newVisits'),
    visits: newVisits,
    ppv: frequency.nb_actions_per_visit_new,
    dur: frequency.avg_time_on_site_new,
  },
  {
    label: tr('all.returningVisits'),
    visits: returningVisits,
    ppv: frequency.nb_actions_per_visit_returning,
    dur: frequency.avg_time_on_site_returning,
  },
];
const freqTotal = newVisits + returningVisits;
const freqTable = freqTotal > 0
  ? `
<table>
  <caption class="sr-only">${esc(tr('all.captionFrequency'))}</caption>
  <thead><tr>
    <th scope="col">${esc(tr('all.headGroup'))}</th>
    <th scope="col" class="num">${esc(tr('common.headVisits'))}</th>
    <th scope="col" class="num">${esc(tr('common.shareHead'))}</th>
    <th scope="col" class="num">${esc(tr('all.headPagesPerVisit'))}</th>
    <th scope="col" class="num">${esc(tr('all.headAvgTime'))}</th>
  </tr></thead>
  <tbody>
    ${freqGroups
      .map(
        (g) => `
    <tr>
      <th scope="row">${esc(g.label)}</th>
      <td class="num">${fmt.format(g.visits)}</td>
      <td class="num">${share(g.visits, freqTotal)}</td>
      <td class="num">${g.ppv != null ? fmtDec1(g.ppv) : '–'}</td>
      <td class="num">${g.dur != null ? fmtDur(g.dur) : '–'}</td>
    </tr>`
      )
      .join('')}
  </tbody>
</table>`
  : `<p class="muted">${esc(tr('common.empty'))}</p>`;

const exitTable = (rows) => {
  if (!rows.length) return `<p class="muted">${esc(tr('common.empty'))}</p>`;
  const max = Math.max(...rows.map((r) => r.value), 1);
  return `
<table${tableClass(rows)}>
  <caption class="sr-only">${esc(tr('all.captionExitPages'))}</caption>
  <thead><tr>
    <th scope="col" class="num">#</th>
    <th scope="col">${esc(tr('common.headPage'))}</th>
    <th scope="col" class="barhead" aria-hidden="true"></th>
    <th scope="col" class="num">${esc(tr('all.headExitVisits'))}</th>
    <th scope="col" class="num">${esc(tr('all.headExitRate'))}</th>
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
      <td class="num">${esc(r.rate)}</td>
    </tr>`
      )
      .join('')}
  </tbody>
</table>`;
};

const methodItems = [
  tr('all.methodSource', { site: esc(siteName), domain: esc(domain) }),
  tr('common.methodBrowserOnly'),
  ...(uniqueVisitors > 0 ? [] : [tr('common.methodUniqueVisitors')]),
  tr('all.methodGeography'),
];

// --- Assemble -----------------------------------------------------------------

const org = settings.organization;
const footerTxt = org ? tr('all.footerOrg', { script: 'build-report-all.mjs', org: esc(org) }) : tr('all.footer', { script: 'build-report-all.mjs' });

const html = `<!DOCTYPE html>
<html lang="${localeMeta().htmlLang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="description" content="${esc(tr('all.metaDescription', { domain, period: periodTxt }))}">
<title>${esc(tr('all.docTitle', { domain }))}</title>
<style>${baseCss(settings.paper)}${chartCss}</style>
</head>
<body>
<div class="wrap">
<header class="masthead">
  <p class="kicker">${esc(tr('all.kicker'))}</p>
  <h1>${esc(domain)}</h1>
  <p class="meta">${esc(tr('common.metaLine', { period: periodTxt, generated }))}</p>
</header>
<main id="main-content">
${
  noData
    ? notice(`<p>${tr('common.noDataNotice', { script: 'pull_all.sh' })}</p>`)
    : ''
}
${kpiGrid(kpis)}

<section class="card">
  <h2>${esc(tr('all.sectionTrend'))}</h2>
  <p class="lead">${esc(tr('all.leadTrend'))}</p>
  ${trendContent}
</section>

<section class="card">
  <h2>${esc(tr('all.sectionHour'))}</h2>
  <p class="lead">${esc(tr('all.leadHour'))}</p>
  ${barChart(hourRows, { labelEvery: 3, caption: tr('all.captionHourly') })}
</section>

<section class="card">
  <h2>${esc(tr('all.sectionVisitors'))}</h2>
  <p class="lead">${esc(tr('all.leadVisitors'))}</p>
  ${donut([
    { label: tr('all.newVisits'), value: newVisits },
    { label: tr('all.returningVisits'), value: returningVisits },
  ])}
  ${freqTable}
</section>

<section class="card">
  <h2>${esc(tr('all.sectionEngagement'))}</h2>
  <p class="lead">${esc(tr('all.leadEngagement'))}</p>
  <div class="duo">
    <div>
      <h3>${esc(tr('all.headVisitDuration'))}</h3>
      ${barList(durationRows)}
    </div>
    <div>
      <h3>${esc(tr('all.headPagesPerVisit'))}</h3>
      ${barList(pagesRows)}
    </div>
    <div>
      <h3>${esc(tr('all.headVisitsPerVisitor'))}</h3>
      ${barList(loyaltyRows)}
    </div>
  </div>
</section>

<section class="card">
  <h2>${esc(tr('all.sectionGeography'))}</h2>
  <p class="lead">${esc(tr('all.leadGeography'))}</p>
  <div class="duo">
    <div>
      <h3>${esc(tr('all.headCountries'))}</h3>
      ${simpleTable(countryRows, totalsOf(countryRows), tr('all.headCountry'), tr('common.headVisits'), tr('all.captionCountries'))}
    </div>
    <div>
      <h3>${esc(tr('all.headRegions'))}</h3>
      ${simpleTable(regionRows, totalsOf(regionRows), tr('all.headRegion'), tr('common.headVisits'), tr('all.captionRegions'))}
    </div>
  </div>
</section>

<section class="card">
  <h2>${esc(tr('all.sectionSources'))}</h2>
  <p class="lead">${esc(tr('all.leadSources'))}</p>
  ${donut(refTypeRows)}
  <div class="duo">
    <div>
      <h3>${esc(tr('all.headRefWebsites'))}</h3>
      ${simpleTable(refWebsites, totalsOf(refWebsites), tr('all.headWebsite'), tr('common.headVisits'), tr('all.captionRefWebsites'))}
    </div>
    <div>
      <h3>${esc(tr('all.headSearchEngines'))}</h3>
      ${simpleTable(refEngines, totalsOf(refEngines), tr('all.headSearchEngine'), tr('common.headVisits'), tr('all.captionSearchEngines'))}
    </div>
    <div>
      <h3>${esc(tr('all.headKeywords'))}</h3>
      ${simpleTable(refKeywords, totalsOf(refKeywords), tr('all.headKeywords'), tr('common.headVisits'), tr('all.captionKeywords'))}
    </div>
    <div>
      <h3>${esc(tr('all.headCampaigns'))}</h3>
      ${simpleTable(refCampaigns, totalsOf(refCampaigns), tr('all.headCampaign'), tr('common.headVisits'), tr('all.captionCampaigns'))}
    </div>
  </div>
</section>

<section class="card">
  <h2>${esc(tr('common.sectionDevices'))}</h2>
  <p class="lead">${esc(tr('all.leadDevices'))}</p>
  <h3>${esc(tr('common.headDeviceTypes'))}</h3>
  ${donut(deviceRows)}
  <div class="duo">
    <div>
      <h3>${esc(tr('common.headResolutions'))}</h3>
      ${simpleTable(resolutionsAll.slice(0, TOP_RESOLUTIONS), totalsOf(resolutionsAll), tr('common.headResolution'), tr('common.headVisits'), tr('common.captionResolutions'))}
    </div>
    <div>
      <h3>${esc(tr('common.headBrowsers'))}</h3>
      ${simpleTable(browsersAll.slice(0, TOP_BROWSERS), totalsOf(browsersAll), tr('common.headBrowsers'), tr('common.headVisits'), tr('common.captionBrowsers'))}
    </div>
    <div>
      <h3>${esc(tr('all.headBrowserVersions'))}</h3>
      ${simpleTable(browserVersionsAll.slice(0, TOP_BROWSER_VERSIONS), totalsOf(browserVersionsAll), tr('all.headVersion'), tr('common.headVisits'), tr('all.captionBrowserVersions'))}
    </div>
    <div>
      <h3>${esc(tr('common.headOperatingSystems'))}</h3>
      ${simpleTable(osAll.slice(0, TOP_OS), totalsOf(osAll), tr('common.headOperatingSystems'), tr('common.headVisits'), tr('common.captionOperatingSystems'))}
    </div>
    <div>
      <h3>${esc(tr('all.headOsVersions'))}</h3>
      ${simpleTable(osVersionsAll.slice(0, TOP_OS_VERSIONS), totalsOf(osVersionsAll), tr('all.headVersion'), tr('common.headVisits'), tr('all.captionOsVersions'))}
    </div>
    <div>
      <h3>${esc(tr('common.headBrowserLanguages'))}</h3>
      ${simpleTable(languagesAll.slice(0, TOP_LANGUAGES), totalsOf(languagesAll), tr('common.headLanguage'), tr('common.headVisits'), tr('common.captionLanguages'))}
    </div>
  </div>
</section>

<section class="card">
  <h2>${esc(tr('common.sectionTopPages'))}</h2>
  <p class="lead">${esc(tr('all.leadTopPages'))}</p>
  ${rankTable(sortByValue(pageRows.map((r) => ({ label: r.label, value: hits(r) }))).slice(0, TOP_PAGES), pageRows.reduce((s, r) => s + hits(r), 0), { labelHead: tr('common.headPage'), valueHead: tr('common.headPageviews'), caption: tr('common.captionTopPages') })}
  ${entryList.length ? `<h3>${esc(tr('common.headEntryPages'))}</h3>${simpleTable(entryList, visits, tr('common.headPage'), tr('common.headEntryVisits'), tr('common.captionEntryPages'))}` : ''}
  <h3>${esc(tr('all.headExitPages'))}</h3>
  ${exitTable(exitRows)}
</section>

<section class="card">
  <h2>${esc(tr('common.sectionMethod'))}</h2>
  <ul>
    ${methodItems.map((t) => `<li>${t}</li>`).join('\n    ')}
  </ul>
</section>

</main>
<footer>
  <p>${footerTxt}</p>
</footer>
</div>
</body>
</html>
`;

// --- Write ---------------------------------------------------------------------

mkdirSync(outDir, { recursive: true });
const stamp = safe(period.start) && safe(period.end) ? `${safe(period.start)}_${safe(period.end)}` : safe(tr('all.filenameFallback'));
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

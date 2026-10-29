# Analytics reports for accessibility audits (Matomo)

Shared tooling for pulling aggregated Matomo analytics per site and building a self-contained HTML report to use as reference when planning and prioritising an accessibility audit (WCAG): which pages to audit first, which devices/browsers to test, and which error pages need attention. Any number of sites are supported – each site is a small config file.

## Layout

```
sites/
├── scripts/                  # shared tooling (site-independent)
│   ├── fetch.sh              # generic single-report fetcher
│   ├── pull_audit.sh         # audit pull – aggregated reports only
│   ├── pull_all.sh           # deep-dive pull incl. visitor-level rows
│   ├── report-common.mjs     # shared report atoms, styles, PDF pipeline
│   ├── build-report-audit.mjs# audit report builder (pull_audit data)
│   └── build-report-all.mjs  # traffic-overview builder (pull_all data)
├── docs/               # this guide
├── config/             # one <slug> file per tracked site (shell syntax, sourced - never run)
├── .secrets/           # env.example template; env holds your credentials
├── data/               # generated: raw JSON per site in data/<slug>/
└── reports/            # generated: reports/<slug>--<start>_<end>[--all].html/.pdf
```

The slug is the site config file name and comes from the domain with dots as dashes: `test.example.com` → `test-example-com`.

## One-time setup

Copy the credentials template and fill in your Matomo URL and a token:

```bash
cd sites
cp .secrets/env.example .secrets/env
$EDITOR .secrets/env
chmod +x ./scripts/pull_audit.sh
chmod +x ./scripts/build-report-audit.mjs
```

The token needs **view** access. In Matomo 5: Personal settings → Security → Auth tokens. Create a dedicated token for this work and revoke it when done. Tokens created with the "Only allow secure requests" option work fine – the scripts send `token_auth` as a POST parameter, never in the URL. `.secrets/env` is listed in `.gitignore` and must never be committed. Values exported in your shell always win over the file.

## Pull and build

```bash
./scripts/pull_audit.sh test-example-com                    # last full calendar month
# alt custom date span:
./scripts/pull_audit.sh test-example-com 2026-09-01 2026-09-30
./scripts/build-report-audit.mjs test-example-com
```

## All sites in one go

```bash
./scripts/pull_audit.sh all                 # every config/, last full calendar month (or pass dates)
./scripts/build-report-audit.mjs all        # build every configured site that has data
```

`all` runs each site through the exact same code as a single-site run (each site is a fresh invocation), so per-site validation, the auth-abort logic and the PDF behavior are unchanged. Notes:

- The pull shares one date window across all sites and reports failed sites in a `FAILED:` list at the end (a site with an empty `MATOMO_SITE`, say). A rejected credential stops the whole run immediately – every further site would only feed the brute-force counter.
- The build asks the PDF question once and applies the answer to every site; `--pdf`/`--no-pdf` skip the question. A site without pulled data is listed in `FAILED:` and fails the run.

The pull fetches aggregated reports only (summary, pages, titles, entry pages, devices, OS, browsers, resolutions, languages, event names, plus optional custom dimensions). It never fetches visitor-level data (`Live.` API).

The builder produces `reports/<slug>--<start>_<end>.html` – one HTML file with inline CSS and SVG charts. It makes no external requests, works offline, and prints well to PDF. It tolerates missing files and marks the gaps in the report, so you can build even before theme or status tracking is in place. The report itself follows accessibility basics: semantic HTML, `lang="sv"`, table captions, tabular numbers, AA-contrast colors, and every chart paired with a data table.

After writing the HTML, the builder asks in the terminal whether to save the report as PDF as well (`Also save the report as PDF? [Y/n]` – Enter means yes). The PDF is rendered by a Chromium-based browser (Chrome, Chromium, Edge and Brave are found automatically; `CHROME_BIN` points to another one) and lands next to the HTML as `reports/<slug>--<start>_<end>.pdf`. It is the shareable variant: references to this guide (`docs/how-to.md`) are omitted, since they make no sense outside the project. Use `--pdf` to write the PDF without asking and `--no-pdf` to never – when input is not a terminal, no question is asked and no PDF is written.

The PDF is kept small (~100 kB instead of ~400 kB) with two measures: it uses Helvetica Neue instead of the macOS system font (Chrome cannot embed San Francisco as a real font and emits dozens of bulky Type 3 glyph programs), and – when Ghostscript is installed (`brew install ghostscript`) – the file is re-compressed and the embedded font subsets deduplicated. Without Ghostscript the PDF is simply bigger, never wrong.

Report sections and their audit use: summary KPIs for context, most visited pages and entry pages to prioritize what to audit first, sections to prioritize between parts of the site, devices/resolutions/browsers/OS/languages to build the test matrix, light/dark mode shares, and 404 pages plus HTTP status distribution for error-page accessibility.

## Add a new site

1. Create `config/<slug>` (copy `config/test-example-com` and edit it):

```bash
export MATOMO_SITE="7"                    # idSite – see the lookup below
export MATOMO_DOMAIN="other-site.se"
# Optional, uncomment when tracked:
#export MATOMO_THEME_DIMENSION="1"
#export MATOMO_STATUS_DIMENSION="2"
#export EXTRA_NOT_FOUND_TITLES="sidan finns inte"
```

2. Run the pull and build with the new slug – nothing else to configure.

### Find the idSite for a new site

```bash
set -a; source .secrets/env; set +a
DATA_DIR=data/<slug> ./scripts/fetch.sh site_ids SitesManager.getSitesIdFromSiteUrl "url=https://<domain>"
cat data/<slug>/site_ids.json
```

Then paste the id into the site config.

## Light and dark mode

Matomo does not track color scheme out of the box. It is normally a visit-scope custom dimension. To check whether one exists (and what id it has):

```bash
set -a; source .secrets/env; set +a
DATA_DIR=data/<slug> ./scripts/fetch.sh dims CustomDimensions.getAvailableCustomDimensions
cat data/<slug>/dims.json
```

If that call returns a permissions error, ask the Matomo administrator to list the dimensions for the site. Then set `MATOMO_THEME_DIMENSION` in the site config and pull again.

If color scheme is not yet tracked on the site, this snippet (placed before the standard matomo.js tag on every page) adds it. The dimension id must match the one created in Matomo (Settings → Custom Dimensions):

```html
<script>
  // Example: track color scheme as custom dimension 1 (visit scope).
  const scheme = () => matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  window._paq = window._paq || [];
  _paq.push(['setCustomDimensionValue', 1, scheme()]);
  // Count in-visit switches as events so page views are not inflated.
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    _paq.push(['trackEvent', 'theme', 'changed', scheme()]);
  });
</script>
```

Fallback: if no dimension is configured but the site sends events named `light`/`dark` (or `ljust`/`mörkt`), the report picks those up automatically from event names.

## 404 and other HTTP statuses

**404:** Matomo logs 404 pages automatically when the 404 page includes the standard tracking code and its page title is exactly "Page not found". The report lists the affected addresses with page views. If the site uses a different 404 title, add it (lowercase) to `EXTRA_NOT_FOUND_TITLES` in the site config – the built-in list covers the common Swedish variants.

**Other statuses (403, 500, …):** not tracked by default. On a server-rendered site, push the response status into a custom dimension before the page view is tracked:

```js
_paq.push(['setCustomDimensionValue', 2, String(response.status)]);
```

Then set `MATOMO_STATUS_DIMENSION` in the site config and pull again. The report shows the status distribution with 4xx/5xx rows highlighted.

**Limitation:** Matomo only sees what runs in the visitor's browser. A server error that prevents the page (and its tracker) from loading at all is invisible to these numbers.

## Re-running for a new period

Run the pull with new dates (or no dates for the last full month) and rebuild. `all` accepts dates the same way (`./scripts/pull_audit.sh all 2026-10-01 2026-10-31`). The report filename contains the period, so earlier reports are kept alongside.

## Deep dives and the traffic overview

`./scripts/pull_all.sh <slug>` pulls the full report set including visitor-level Live rows into `data/<slug>/live/`. That data can contain personal information – use it only when the aggregated audit pull is not enough, and delete it when done.

`./scripts/build-report-all.mjs <slug>` builds the **traffic overview** from the same pull: a wider report for the web team with daily trend, hour of day, new vs returning visitors, engagement (visit length, pages per visit, return visits), geography, traffic sources, device and software versions, and entry/exit pages. It goes to `reports/<slug>--<start>_<end>--all.html` (plus `.pdf`), next to the audit report for the same period.

The traffic overview reads aggregated reports only. The visitor-level rows in `data/<slug>/live/` are never rendered – the report contains no personal data and can be shared freely. `all`, `--pdf` and `--no-pdf` work exactly as for the audit report.

## Testing without Matomo

`../tests/run-test.sh` runs the whole chain offline: it starts a local mock of the Matomo API (`../tests/mock-matomo.mjs`) that serves a real fixture, pulls a throwaway site config, builds the report and checks its contents. It also verifies the failure paths (rejected token, empty data dir). Use it after changing the scripts, or to see what a working run looks like before credentials exist.

## Troubleshooting

- **"no site config at config/…"** – the slug does not match a file in `config/`. The error lists the available configs.
- **"MATOMO_URL is not set" / "still the placeholder"** – copy `.secrets/env.example` to `.secrets/env` and fill in real values, or export the variables yourself.
- **"MATOMO_SITE is not set"** – set the idSite in the site's config file.
- **HTTP 401** – read the `Matomo says:` part of the error line, it pinpoints the cause: *"required to be sent as a POST parameter or in the HTTP Authorization header"* means an outdated `fetch.sh` is putting the token in the URL – current versions send it as a POST body parameter, so update the scripts. *Invalid token_auth* means the value in `.secrets/env` is wrong, revoked or expired – create a fresh token (Matomo 5: Personal settings → Security → Auth tokens) and paste it again. A message about **access/view permission** means the token's user may not see that idSite – ask the Matomo administrator for view access, and double-check `MATOMO_SITE` in the site config. An error ending with `[server requested Basic auth …]` is not Matomo rejecting you but a proxy or SSO gateway in front of it – add `MATOMO_HTTP_AUTH="user:password"` to `.secrets/env`. A body that starts with `<html` is a login/SSO page – the API URL is being redirected to a portal curl cannot pass; use the direct Matomo URL instead. If the pull printed `NOTE: MATOMO_TOKEN contained whitespace`, the env file had stray CR/LF from editing (Windows line endings) – it was stripped automatically, but re-saving the file with LF endings avoids it.
- **HTTP 500 "Too many failed logins"** – Matomo's brute-force protection has locked the API after repeated failed authentication attempts (every request in a failed pull counts, and earlier failed runs too). **Stop retrying – each new attempt keeps the lockout alive.** Wait for it to clear (typically well under an hour) or ask the Matomo administrator. Meanwhile, check the token in the Matomo UI: Personal settings → Security → Auth tokens lists each token and its expiry – when in doubt, create a fresh dedicated token and replace `MATOMO_TOKEN` in `.secrets/env`. The pull aborts at the first rejected credential, so a bad token costs one request, not twelve.
- **Unika besökare shows "–"** – Matomo's range reports omit that metric by default. For a report covering exactly one calendar month the pull scripts fetch the month archive instead, where unique visitors are always processed, so the KPI fills in without any Matomo change. For other ranges only the administrator can help: `enable_processing_unique_visitors_range = 1` under `[General]` in Matomo's `config.ini.php`. That is one installation-wide setting, not per site – a single change covers every site in that Matomo. Note that it affects newly archived data; Matomo's own config reference says past reports need the `matomo_archive_*` tables dropped to re-process. Until then, accept visits as the headline metric.
- **PDF step fails or reports no browser** – the PDF needs a Chromium-based browser; the error lists what was searched. Install Google Chrome (or set `CHROME_BIN` to a Chromium, Edge or Brave binary) and build again, or use `--no-pdf`. The HTML report is always written, PDF failure or not.
- **PDF is several hundred kB** – Ghostscript is missing, so only the Chromium output lands. `brew install ghostscript` and rebuild; the ok-line says `Ghostscript-compressed` when it ran.
- **Theme section says tracking is missing** – `MATOMO_THEME_DIMENSION` is not set in the config, the id is wrong, or the site does not track color scheme yet.
- **No 404 rows despite known broken links** – the 404 page may not include the tracker, or its title is not in the built-in list nor in `EXTRA_NOT_FOUND_TITLES`.
- **FAILED list at end of pull** – individual reports that failed are listed by name; the rest still downloaded. Each failed fetch also prints its own `ERROR in <name> …` line while running: a curl message means the host could not be reached (network, TLS, proxy), an HTTP status pinpoints the cause (401 = wrong or revoked token, 404 = wrong `MATOMO_URL`, e.g. a subpath install), and anything else is Matomo's own error message. Re-run, and check plugin availability (e.g. Events) if the same one keeps failing.
- **build-report-audit/all exits with "no report data found"** – `data/<slug>/` contains only `period.json`, meaning every fetch in the pull failed or the pull was never run (the all-report says `pull_all.sh`, the audit report `pull_audit.sh`). The HTML file is still written so you can see the empty state, but the exit code is non-zero so scripts do not mistake it for a real result.

## Data protection

The token is read from `.secrets/env` or the environment and never written elsewhere or echoed. The audit pull fetches aggregated statistics only, no visitor-level data. For the broader privacy and security context.
# Matomo Reporter Template

Shared tooling for pulling aggregated Matomo analytics per site and building a self-contained HTML report to use as reference when planning and prioritising an accessibility audit (WCAG): which pages to audit first, which devices/browsers to test, and which error pages need attention.

Aggregated statistics only — no visitor-level data. Any number of sites are supported; each site is a small config file.

## Layout

```
.
├── .secrets/           # env.example template; .env holds your credentials (gitignored)
├── config/             # one <slug> file per tracked site (shell syntax, sourced — never run)
├── data/               # generated: raw JSON per site in data/<slug>/ (gitignored)
├── docs/               # detailed guide: docs/how-to.md
├── reports/            # generated: reports/<slug>--<start>_<end>[--all].html/.pdf
└── scripts/            # shared tooling (site-independent)
    ├── fetch.sh              # generic single-report fetcher
    ├── pull_audit.sh         # audit pull – aggregated reports only
    ├── pull_all.sh           # deep-dive pull incl. visitor-level rows
    ├── report-common.mjs     # shared report atoms, styles, PDF pipeline
    ├── build-report-audit.mjs# audit report builder (pull_audit data)
    └── build-report-all.mjs  # traffic-overview builder (pull_all data)
```

The slug is the site config file name and comes from the domain with dots as dashes: `test.example.com` → `test-example-com`.

## One-time setup

```bash
cp .secrets/env.example .secrets/env
$EDITOR .secrets/env      # fill in MATOMO_URL and MATOMO_TOKEN
chmod +x ./scripts/pull_audit.sh
chmod +x ./scripts/build-report-audit.mjs
```

The token needs **view** access. In Matomo 5: Personal settings → Security → Auth tokens. Create a dedicated token for this work and revoke it when done. `.secrets/env` is listed in `.gitignore` and must never be committed.

## Pull and build

```bash
./scripts/pull_audit.sh test-example-com                    # last full calendar month
./scripts/build-report-audit.mjs test-example-com
```

Custom date span:

```bash
./scripts/pull_audit.sh test-example-com 2026-09-01 2026-09-30
./scripts/build-report-audit.mjs test-example-com
```

All sites at once:

```bash
./scripts/pull_audit.sh all
./scripts/build-report-audit.mjs all
```

## Scripts

- `pull_audit.sh <slug|all> [start] [end]` — aggregated reports only (audit-ready)
- `pull_all.sh <slug|all> [start] [end]` — full set including visitor-level Live rows; handle that data with care
- `build-report-audit.mjs <slug|all> [--pdf|--no-pdf]` — accessibility-audit reference report
- `build-report-all.mjs <slug|all> [--pdf|--no-pdf]` — wider traffic overview for the web team
- `create_audit_reports_for_all_sites.sh` — pull + build every configured site

Reports are single self-contained HTML files (inline CSS and SVG, no external requests) and work offline. The builder optionally renders a PDF via a Chromium-based browser.

## Add a new site

Create `config/<slug>` with at least `MATOMO_SITE` (idSite) and `MATOMO_DOMAIN`. See `docs/how-to.md` for how to look up the idSite.

## Data protection

The token is read from `.secrets/env` or the environment and never written elsewhere or echoed. `.secrets/env` and `data/` are gitignored and must never be committed.

Full documentation: [`docs/how-to.md`](docs/how-to.md)

#!/usr/bin/env bash
# Pull the aggregated Matomo reports used to build the accessibility-audit
# reference report for a site (see docs/how-to.md).
#
# Aggregated reports only - no visitor-level data is fetched.
#
# Usage: pull_audit.sh <slug|config-path|all> [start] [end]
#   <slug>          file in config/, e.g. test-example-com
#                   (a direct path to a config file also works)
#   all             every file in config/ - each site is pulled by a fresh
#                   run of this script, so per-site validation and the
#                   auth-abort logic stay exactly as for a single site
#   [start] [end]   range dates YYYY-MM-DD. Default: MATOMO_START/MATOMO_END
#                   from the environment if both are set, else the last full
#                   calendar month (computed once, shared by every site).
#
# Shared credentials (MATOMO_URL, MATOMO_TOKEN) are read from .secrets/env
# if present - see .secrets/env.example. Values already exported in your
# shell win over that file.
set -uo pipefail

BASE="$(cd "$(dirname "$0")/.." && pwd)"
cd "$BASE" || exit

usage() {
  echo "usage: $0 <slug|config-path|all> [start] [end]" >&2
  echo "site configs in config/:" >&2
  for c in config/*; do [[ -f "$c" ]] && echo "  $(basename "$c")" >&2; done
  exit 1
}

[[ $# -ge 1 ]] || usage

# --- resolve site config ------------------------------------------------------

site_arg="$1"
shift
if [[ "$site_arg" == "all" ]]; then
  # Every site gets its own pull (fresh run of this script): config checks,
  # credentials handling and the abort-on-rejected-credential logic are
  # identical to a single-site pull, and one broken site does not stop
  # the others unless the credentials were rejected.
  config_list=()
  for c in config/*; do [[ -f "$c" ]] && config_list+=("$(basename "$c")"); done
  (( ${#config_list[@]} )) || { echo "ERROR: no site configs in config/ - nothing to pull" >&2; exit 1; }
  if (( $# >= 2 )); then
    dates=("$1" "$2")
  elif (( $# > 0 )); then
    echo "ERROR: dates come in pairs - start and end (YYYY-MM-DD)" >&2
    exit 1
  elif [[ -n "${MATOMO_START:-}" && -n "${MATOMO_END:-}" ]]; then
    echo "using dates from environment: ${MATOMO_START} to ${MATOMO_END}"
    dates=("${MATOMO_START}" "${MATOMO_END}")
  else
    echo "no dates given - using last full month"
    dates=("$(date -v1d -v-1m +%F)" "$(date -v1d -v-1d +%F)")
  fi
  failed=()
  for cfg in "${config_list[@]}"; do
    echo
    echo "== ${cfg} =="
    if "$0" "config/${cfg}" "${dates[@]}"; then :; else
      rc=$?
      failed+=("${cfg}")
      if (( rc == 2 )); then
        echo >&2
        echo "stopping the all-sites pull: ${cfg} was rejected (credentials). Fix MATOMO_TOKEN and re-run - the remaining sites were skipped." >&2
        exit 2
      fi
    fi
  done
  echo
  if (( ${#failed[@]} )); then
    echo "FAILED: ${failed[*]}"
    exit 1
  fi
  echo "all sites pulled ok - build the reports with: ./scripts/build-report-audit.mjs all"
  exit 0
fi
if [[ "$site_arg" == */* ]]; then
  config_file="$site_arg"
else
  config_file="config/${site_arg}"
fi
if [[ ! -f "$config_file" ]]; then
  echo "ERROR: no site config at ${config_file}" >&2
  usage
fi
slug="$(basename "$config_file")"
# shellcheck source=/dev/null
source "$config_file"

# --- shared credentials --------------------------------------------------------

if [[ -f .secrets/env ]]; then
  # shellcheck source=/dev/null
  source .secrets/env
fi

# --- date window ----------------------------------------------------------------

if [[ $# -ge 2 ]]; then
  MATOMO_START="$1"
  MATOMO_END="$2"
  shift 2
elif [[ -z "${MATOMO_START:-}" || -z "${MATOMO_END:-}" ]]; then
  # Last full calendar month.
  # BSD date (macOS). GNU equivalent:
  #   start: date -d "$(date +%Y-%m-01) -1 month" +%F
  #   end:   date -d "$(date +%Y-%m-01) -1 day" +%F
  MATOMO_START="$(date -v1d -v-1m +%F)"
  MATOMO_END="$(date -v1d -v-1d +%F)"
  echo "no dates given - using last full month: ${MATOMO_START} to ${MATOMO_END}"
fi
export MATOMO_START MATOMO_END

# --- validation -------------------------------------------------------------------

die() { echo "ERROR: $*" >&2; exit 1; }

[[ -n "${MATOMO_URL:-}" ]] || die "MATOMO_URL is not set. Put it in .secrets/env (copy .secrets/env.example) or export it."
[[ -n "${MATOMO_TOKEN:-}" ]] || die "MATOMO_TOKEN is not set. Put it in .secrets/env (copy .secrets/env.example) or export it."
[[ -n "${MATOMO_SITE:-}" ]] || die "MATOMO_SITE is not set. Set it in ${config_file}."
[[ "$MATOMO_URL" != *"example.com"* ]] || die "MATOMO_URL is still the placeholder from env.example - fill in .secrets/env."
[[ "$MATOMO_TOKEN" != paste-* ]] || die "MATOMO_TOKEN is still the placeholder from env.example - fill in .secrets/env."
[[ "$MATOMO_START" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ && "$MATOMO_END" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]] \
  || die "dates must be YYYY-MM-DD (got '${MATOMO_START}', '${MATOMO_END}')"

# A token pasted with stray whitespace (typically a trailing CR from a
# CRLF-edited .secrets/env) fails auth invisibly - strip it once here.
if [[ "$MATOMO_TOKEN" =~ [[:space:]] ]]; then
  echo "NOTE: MATOMO_TOKEN contained whitespace (trailing CR/LF from editing .secrets/env?) - continuing with it stripped" >&2
  MATOMO_TOKEN="${MATOMO_TOKEN//[[:space:]]/}"
fi
export MATOMO_URL MATOMO_TOKEN MATOMO_SITE

# --- data dir and period metadata ---------------------------------------------

DATA_DIR="data/${slug}"
export DATA_DIR
mkdir -p "$DATA_DIR"

extra_titles="[]"
if [[ -n "${EXTRA_NOT_FOUND_TITLES:-}" ]]; then
  extra_titles="$(printf '%s' "$EXTRA_NOT_FOUND_TITLES" | jq -R 'split(":") | map(gsub("^ +| +$"; ""))')"
fi
jq -n \
  --arg slug "$slug" \
  --arg domain "${MATOMO_DOMAIN:-}" \
  --arg start "$MATOMO_START" \
  --arg end "$MATOMO_END" \
  --arg pulled_at "$(date +%Y-%m-%dT%H:%M:%S%z)" \
  --argjson extra_titles "$extra_titles" \
  '{slug:$slug, domain:$domain, start:$start, end:$end, pulled_at:$pulled_at, extra_not_found_titles:$extra_titles}' \
  > "${DATA_DIR}/period.json"

# --- fetch the report set ------------------------------------------------------

failed=()
# fetch.sh exit 2 = authentication rejected (bad token or failed-login
# lockout). Aborting beats ploughing on: every extra request is another
# failed login in Matomo's brute-force counter.
fetch() {
  ./scripts/fetch.sh "$@"
  rc=$?
  if (( rc != 0 )); then
    failed+=("$1")
    if (( rc == 2 )); then
      echo >&2
      echo "stopping the pull: Matomo rejected the credentials. Fix MATOMO_TOKEN (create a fresh token if in doubt - see docs/how-to.md) and, if the failed-login lockout is active, wait for it to clear before retrying." >&2
      exit 2
    fi
  fi
}

# Unika besökare for the whole period: Matomo omits that metric in range
# reports unless the administrator sets enable_processing_unique_visitors_range
# in config.ini.php. Month archives carry it by default, so when the report
# covers exactly one calendar month the value is fetched from the month
# archive and the report shows it without needing that setting. Any other
# range keeps the "–" in the report. (GNU date equivalent of the end check:
#   date -d "$(date +%Y-%m-01 <<<"$MATOMO_START") +1 month -1 day" +%F )
fetch_uniq_visitors_month() {
  if [[ "$MATOMO_START" == *-01 ]] \
     && [[ "$MATOMO_END" == "$(date -j -f '%Y-%m-%d' -v+1m -v-1d "$MATOMO_START" +%F 2>/dev/null)" ]]; then
    fetch visits_summary_month VisitsSummary.get period=month "date=${MATOMO_START}"
  else
    # Remove a month summary left by an earlier calendar-month pull - the
    # builder must not read a stale month into a different period's report.
    rm -f "${DATA_DIR}/visits_summary_month.json"
    echo "skip visits_summary_month - ${MATOMO_START} to ${MATOMO_END} is not one full calendar month (unika besökare shows '–')"
  fi
}

echo "== site metadata & summary =="
fetch site SitesManager.getSiteFromId
fetch visits_summary VisitsSummary.get
fetch_uniq_visitors_month
fetch actions_summary Actions.get

echo "== pages =="
fetch page_urls Actions.getPageUrls flat=1
fetch page_titles Actions.getPageTitles expanded=1
fetch entry_pages Actions.getEntryPageUrls flat=1

echo "== devices & clients =="
fetch device_types DevicesDetection.getType
fetch os_families DevicesDetection.getOsFamilies
fetch browsers DevicesDetection.getBrowsers
fetch resolutions Resolution.getResolution
fetch languages UserLanguage.getLanguage

echo "== color scheme & http status =="
if [[ -n "${MATOMO_THEME_DIMENSION:-}" ]]; then
  fetch theme_dimension CustomDimensions.getCustomDimension "idDimension=${MATOMO_THEME_DIMENSION}"
else
  echo "  skip theme_dimension - set MATOMO_THEME_DIMENSION in ${config_file} (see docs/how-to.md)"
fi
if [[ -n "${MATOMO_STATUS_DIMENSION:-}" ]]; then
  fetch status_dimension CustomDimensions.getCustomDimension "idDimension=${MATOMO_STATUS_DIMENSION}"
else
  echo "  skip status_dimension - set MATOMO_STATUS_DIMENSION in ${config_file} (see docs/how-to.md)"
fi
fetch events_names Events.getName

echo
if (( ${#failed[@]} )); then
  echo "FAILED: ${failed[*]}"
  exit 1
fi
echo "all fetches ok - build the report with: ./scripts/build-report-audit.mjs ${slug}"

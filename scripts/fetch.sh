#!/usr/bin/env bash
# Fetch one report from the Matomo HTTP API (read-only) and save it as JSON.
#
# Usage: ./scripts/fetch.sh <output-name> <method> [extra params...]
#   extra params are passed through as raw request parameters, e.g. "period=hour"
#
# Required environment variables (never hardcoded, never echoed):
#   MATOMO_URL    base URL, e.g. https://matomo.example.com
#   MATOMO_TOKEN  token_auth with view access
#   MATOMO_SITE   idSite
# Optional:
#   MATOMO_START / MATOMO_END   range dates (YYYY-MM-DD); sent as the default
#                               period/date. Needed for data reports, not for
#                               metadata methods (e.g. SitesManager.*).
#   REPORT_LANG   report/data language (en|fr|de|es|sv); sent as Matomo's
#                 language parameter so row labels (countries, referrer
#                 types, ...) come back localized. No default - when unset
#                 Matomo answers in the install's default language.
#   DATA_DIR      output directory (default: data); set by the pull scripts
#                 to data/<slug>, set it yourself for manual lookups
#
# Exit codes: 0 = ok, 1 = fetch failed (report-level problem),
#             2 = authentication rejected (401 or failed-login lockout) -
#             retrying with the same credentials will not help; the pull
#             scripts abort on it so a bad token does not fire the whole
#             request set into Matomo's brute-force protection.

set -euo pipefail

name="${1:?usage: fetch.sh <output-name> <method> [extra params...]}"
method="${2:?missing method}"
shift 2

: "${MATOMO_URL:?set MATOMO_URL}"
: "${MATOMO_TOKEN:?set MATOMO_TOKEN}"
: "${MATOMO_SITE:?set MATOMO_SITE}"

extra=("$@")

# Default period/date when dates are set; any explicit period=/date= in extra
# params wins because Matomo takes the last occurrence of a repeated parameter.
params=(
  "module=API"
  "method=${method}"
  "idSite=${MATOMO_SITE}"
  "format=JSON"
  "filter_limit=10000"
  "token_auth=${MATOMO_TOKEN}"
)
if [[ -n "${MATOMO_START:-}" && -n "${MATOMO_END:-}" ]]; then
  params+=("period=range" "date=${MATOMO_START},${MATOMO_END}")
fi
# An explicit language= in extra params wins: Matomo takes the last
# occurrence of a repeated parameter (same rule as period=/date= above).
if [[ -n "${REPORT_LANG:-}" ]]; then
  params+=("language=${REPORT_LANG}")
fi
if (( ${#extra[@]} )); then
  params+=("${extra[@]}")
fi

# Send the request as POST with all parameters in the body. Matomo tokens
# created with the "Only allow secure requests" option are rejected when the
# token_auth travels in the URL (HTTP 401, "required to be sent as a POST
# parameter or in the HTTP Authorization header") - the POST body works for
# every token class, and keeps the token out of URLs, access logs and the
# process list alike.
query="$(printf '%s&' "${params[@]}")"
query="${query%'&'}"
url="${MATOMO_URL%/}/index.php"

data_dir="${DATA_DIR:-data}"
out="${data_dir}/${name}.json"
mkdir -p "$data_dir"

# The base URL (never the full URL - it carries the token) goes into error
# messages so failures are diagnosable: curl errors distinguish network/TLS
# problems, the HTTP status distinguishes auth (401) and path (404) problems.
base="${MATOMO_URL%/}"
body_file="$(mktemp)" || exit 1
code_file="$(mktemp)" || exit 1
err_file="$(mktemp)" || exit 1
hdr_file="$(mktemp)" || exit 1
trap 'rm -f "$body_file" "$code_file" "$err_file" "$hdr_file"' EXIT

# MATOMO_HTTP_AUTH (user:password) is for Matomo installs behind an
# HTTP-Auth proxy/SSO - separate from Matomo's own token_auth.
curl_args=(-sS --max-time 120)
if [[ -n "${MATOMO_HTTP_AUTH:-}" ]]; then
  curl_args+=(-u "$MATOMO_HTTP_AUTH")
fi

if ! curl "${curl_args[@]}" -D "$hdr_file" -o "$body_file" -w '%{http_code}' -d "$query" "$url" >"$code_file" 2>"$err_file"; then
  echo "ERROR in ${name} (${method}): request to ${base} failed: $(cat "$err_file") (check host, TLS and proxy settings - see docs/how-to.md)" >&2
  exit 1
fi
http_code="$(cat "$code_file")"
if [[ "$http_code" != 2* ]]; then
  # Surface why: Matomo's own JSON error message, or the start of a non-JSON
  # body (SSO login page, proxy error). A WWW-Authenticate header means
  # something in FRONT of Matomo rejected the request before token_auth was
  # even evaluated.
  detail="(empty body)"
  if jq -e 'type == "object" and (.message | type == "string")' "$body_file" >/dev/null 2>&1; then
    detail="Matomo says: $(jq -r '.message' "$body_file")"
  elif [[ -s "$body_file" ]]; then
    detail="body starts with: $(head -c 120 "$body_file")"
  fi
  if grep -qi '^www-authenticate:' "$hdr_file"; then
    scheme="$(grep -i '^www-authenticate:' "$hdr_file" | head -1 | tr -d '\r' | awk '{print $2}')"
    detail="${detail} [server requested ${scheme} auth - this is a proxy/SSO in front of Matomo, not Matomo itself; set MATOMO_HTTP_AUTH=\"user:password\" in .secrets/env]"
  fi
  # Auth rejections get their own exit code so the pull scripts can stop
  # instead of sending 12 more doomed requests into the brute-force counter.
  auth_rejected=0
  if [[ "$http_code" == 401 ]]; then
    auth_rejected=1
  elif [[ "$detail" == *"Too many failed logins"* ]]; then
    auth_rejected=1
    detail="${detail} [Matomo's failed-login lockout is active - stop retrying, wait for it to clear and fix the token first]"
  fi
  echo "ERROR in ${name} (${method}): HTTP ${http_code} from ${base} - ${detail} (401 = wrong/revoked token or missing view access, 404 = wrong MATOMO_URL, 5xx = Matomo-side - see docs/how-to.md)" >&2
  if [[ "$auth_rejected" == 1 ]]; then
    exit 2
  fi
  exit 1
fi

# Matomo returns HTTP 200 even on error; catch the JSON error envelope.
if jq -e 'type == "object" and has("result") and .result == "error"' "$body_file" >/dev/null 2>&1; then
  echo "ERROR in ${name} (${method}): $(jq -r '.message' "$body_file")" >&2
  exit 1
fi

if ! jq . "$body_file" > "$out" 2>/dev/null; then
  echo "ERROR in ${name} (${method}): response from ${base} is not JSON - starts with: $(head -c 120 "$body_file")" >&2
  exit 1
fi
echo "ok: ${out} ($(wc -c < "$out" | tr -d ' ') bytes) ${method}"

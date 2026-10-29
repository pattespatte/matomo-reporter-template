#!/usr/bin/env bash
# Pull and build the accessibility-audit report for every configured site in
# one go: pull_audit.sh all, then build-report-audit.mjs all.
#
# Usage: create_audit_reports_for_all_sites.sh [start] [end] [--pdf|--no-pdf]
#   [start] [end]   range dates YYYY-MM-DD, forwarded to the pull. Default:
#                   MATOMO_START/MATOMO_END from the environment if both are
#                   set, else the last full calendar month.
#   --pdf           write PDFs without asking
#   --no-pdf        never write PDFs
#
# Without --pdf/--no-pdf an interactive terminal is asked once whether to
# write PDFs; a non-interactive run never does. The build step only runs
# when the pull succeeded for every site - building on top of a failed pull
# would mix report files from different periods under the new period label.
set -uo pipefail

cd "$(dirname "$0")/.." || exit

usage() {
  echo "usage: $0 [start] [end] [--pdf|--no-pdf]" >&2
  exit 1
}

dates=()
pdf_flag=()
for arg in "$@"; do
  case "$arg" in
    --pdf|--no-pdf) pdf_flag+=("$arg") ;;
    -*) echo "ERROR: unknown option: $arg" >&2; usage ;;
    *) dates+=("$arg") ;;
  esac
done
case ${#dates[@]} in
  0|2) ;;
  1) echo "ERROR: dates come in pairs - start and end (YYYY-MM-DD)" >&2; usage ;;
  *) echo "ERROR: at most two dates (start end), got ${#dates[@]}" >&2; usage ;;
esac

if ! ./scripts/pull_audit.sh all ${dates[@]+"${dates[@]}"}; then
  echo "ERROR: pull failed - build skipped so no report can mix periods. Fix the pull (see FAILED above) and re-run." >&2
  exit 1
fi

./scripts/build-report-audit.mjs all ${pdf_flag[@]+"${pdf_flag[@]}"} || exit 1
echo "Done."

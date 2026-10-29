#!/usr/bin/env bash

cd "$(dirname "$0")/.." || exit
./scripts/pull_audit.sh all            # pull every site in config/ (last full month, or pass dates)
./scripts/build-report-audit.mjs all   # build every configured site
echo "Done."
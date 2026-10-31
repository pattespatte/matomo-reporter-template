# read-settings.sh - sourced by the pull scripts to read settings.json
# (repo root) without duplicating its keys in bash. settings.json may be
# absent: every lookup then returns the given default, matching the Node
# loader's behavior in scripts/settings.mjs.
#
# Usage (after sourcing):
#   lang="$(settings_get '.language' 'sv')"
#
# Values already exported in the shell win over the file - callers check
# their own variable first, mirroring the ":=" convention in .secrets/env.

settings_get() {
  local path="$1" default="${2:-}" value=""
  if [[ -f settings.json ]]; then
    value="$(jq -r "${path} // empty" settings.json 2>/dev/null || true)"
  fi
  if [[ -n "$value" && "$value" != "null" ]]; then
    printf '%s' "$value"
  else
    printf '%s' "$default"
  fi
}

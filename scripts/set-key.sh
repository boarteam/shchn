#!/usr/bin/env bash
# Saves an API key to .env without echoing it, putting it on a command line or
# leaving it in shell history.
#   npm run set-key                     # ANTHROPIC_API_KEY
#   npm run set-key -- SONIOX_API_KEY   # any other variable
set -euo pipefail

name="${1:-ANTHROPIC_API_KEY}"
cd "$(dirname "$0")/.."
[[ -f .env ]] || cp .env.example .env

read -rsp "Paste ${name} and press Enter (input is hidden): " value
echo
value="${value//[[:space:]]/}"
if [[ -z "$value" ]]; then
  echo "Nothing entered; .env is unchanged."
  exit 1
fi

tmp="$(mktemp .env.tmp.XXXXXX)"
trap 'rm -f "$tmp"' EXIT
found=0
while IFS= read -r line || [[ -n "$line" ]]; do
  if [[ "$line" == "${name}="* ]]; then
    printf '%s=%s\n' "$name" "$value"
    found=1
  else
    printf '%s\n' "$line"
  fi
done < .env > "$tmp"
[[ $found -eq 1 ]] || printf '%s=%s\n' "$name" "$value" >> "$tmp"
chmod 600 "$tmp"
mv "$tmp" .env
echo "Saved ${name} (ending …${value: -4}) to .env"

if [[ "$name" == "ANTHROPIC_API_KEY" ]]; then
  # Checks the key against the free model list. The key reaches curl on stdin, not argv.
  status="$(printf 'x-api-key: %s\n' "$value" | curl -sS -o /dev/null -w '%{http_code}' -H @- \
    -H 'anthropic-version: 2023-06-01' https://api.anthropic.com/v1/models || true)"
  case "$status" in
    200) echo "The key works." ;;
    401) echo "The API rejected this key (401). Check that you copied all of it, then run this again." ;;
    *) echo "Couldn't check the key (HTTP ${status:-no response}); it's saved anyway." ;;
  esac
fi

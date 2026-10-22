#!/usr/bin/env bash
# Runs api.test.ts against one api image and reports its memory use.
# usage: tests/e2e/run.sh <label> <image> <migrate command>
set -euo pipefail

label=$1
export API_IMAGE=$2
export MIGRATE_COMMAND=$3
dc=(docker compose -f "$(dirname "$0")/compose.yaml")

cleanup() {
  "${dc[@]}" logs --no-color > "e2e-$label.log" 2>&1 || true
  "${dc[@]}" down -v --remove-orphans > /dev/null 2>&1 || true
}
trap cleanup EXIT

mem() { docker stats --no-stream --format '{{.MemUsage}}' "$("${dc[@]}" ps -q api)" | cut -d/ -f1 | xargs; }

"${dc[@]}" up -d api
sleep 20
idle=$(mem)

"${dc[@]}" --profile tests run --rm tests
loaded=$(mem)

# Migrations must be safe to run on every deploy.
"${dc[@]}" run --rm migrate

echo "$label: idle $idle, after tests $loaded"
if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  echo "| $label | \`$API_IMAGE\` | $idle | $loaded |" >> "$GITHUB_STEP_SUMMARY"
fi

#!/usr/bin/env bash
# Smoke test of a built cloud UI image: substitution, SPA fallback, caching, health check.
# usage: tests/ui-smoke.sh <image>
set -euo pipefail
image=$1
api=https://jett.example.com
base=http://localhost:8080
work=$(mktemp -d)

fail() { echo "FAIL: $*"; docker logs ui || true; exit 1; }
trap 'docker rm -f ui > /dev/null 2>&1 || true' EXIT

docker run -d --name ui -p 8080:8080 -e JETKVM_CLOUD_API="$api/" "$image" > /dev/null
for _ in $(seq 30); do curl -fs "$base/" -o "$work/index.html" && break; sleep 1; done
[ -s "$work/index.html" ] || fail "no index.html"

if grep -q __JETKVM_CLOUD_API__ "$work/index.html"; then fail "placeholder left in index.html"; fi

# Every JS file the page references, and the ones those import, must be free of the placeholder,
# and one of them has to carry the API origin.
grep -oE 'assets/immutable/[A-Za-z0-9._-]+\.js' "$work/index.html" | sort -u > "$work/js"
[ -s "$work/js" ] || { head -c 2000 "$work/index.html"; fail "index.html references no scripts"; }
for f in $(cat "$work/js"); do
  curl -fs "$base/$f" | grep -oE 'assets/immutable/[A-Za-z0-9._-]+\.js' || true
done | sort -u >> "$work/js"
sort -u -o "$work/js" "$work/js"
echo "checking $(wc -l < "$work/js") scripts"
found=0
for f in $(cat "$work/js"); do
  curl -fs "$base/$f" -o "$work/chunk.js" || fail "$f not served"
  if grep -q __JETKVM_CLOUD_API__ "$work/chunk.js"; then fail "placeholder left in $f"; fi
  if grep -q "$api" "$work/chunk.js"; then found=1; fi
done
[ "$found" = 1 ] || fail "API origin not found in any script"

curl -fs "$base/devices/abc" | grep -q '<div id="root"' || fail "SPA fallback"
[ "$(curl -s -o /dev/null -w '%{http_code}' "$base/assets/immutable/missing.js")" = 404 ] || fail "missing asset is not 404"
first=$(head -1 "$work/js")
curl -fsI "$base/$first" | grep -qi 'cache-control: public, max-age=31536000, immutable' || fail "immutable caching"
curl -fs -H 'Accept-Encoding: gzip' -o /dev/null -w '%{size_download}' "$base/$first" > /dev/null || fail "gzip"

if docker run --rm -e JETKVM_CLOUD_API=ftp://nope "$image" 2> /dev/null; then fail "accepted a bad JETKVM_CLOUD_API"; fi

for _ in $(seq 20); do
  [ "$(docker inspect -f '{{.State.Health.Status}}' ui)" = healthy ] && break
  sleep 3
done
[ "$(docker inspect -f '{{.State.Health.Status}}' ui)" = healthy ] || fail "health check"

size=$(docker image inspect "$image" --format '{{.Size}}')
echo "OK, image $((size / 1024 / 1024)) MiB"
if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then echo "cloud-ui image: $((size / 1024 / 1024)) MiB" >> "$GITHUB_STEP_SUMMARY"; fi

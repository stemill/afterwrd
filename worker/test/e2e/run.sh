#!/usr/bin/env bash
# afterwrd's end-to-end tests: real local copies of the site (wrangler dev) driven by Chrome, with a virtual
# passkey authenticator. See README.md.
#   npm run test:e2e                     everything except upgrade
#   npm run test:e2e -- <suite>…         some: core fresh albums update feed groups checks forged
#   npm run test:e2e -- upgrade v0.17.0  an older release's site (0.17.0 or later), upgraded in place to this code
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
WORKER="$(cd "$HERE/../.." && pwd)"
export OUT="$HERE/out"
WRANGLER="$WORKER/node_modules/.bin/wrangler"
FAILED=0
mkdir -p "$OUT"

for port in 8787 8788 8789 8790; do
  if lsof -iTCP:$port -sTCP:LISTEN >/dev/null 2>&1; then
    echo "Port $port is in use (is \`npm run dev\` running?). Stop it and try again." >&2
    exit 1
  fi
done

# The made-up Facebook downloads: the basic one, and one with a friends list.
rm -rf "$OUT/fake-export.zip" "$OUT/friends-export.zip" "$OUT/friends-export"
(cd "$HERE/fixtures/export" && zip -qr "$OUT/fake-export.zip" .)
cp -R "$HERE/fixtures/export" "$OUT/friends-export"
mkdir -p "$OUT/friends-export/connections/friends"
cp "$HERE/fixtures/friends.json" "$OUT/friends-export/connections/friends/your_friends.json"
(cd "$OUT/friends-export" && zip -qr "$OUT/friends-export.zip" .)
PHOTOS="$HERE/fixtures/photos"

# Tests use the default local database; any of yours is set aside and put back afterwards. So is package.json, which
# the update tests change for a moment.
if [ -d "$WORKER/.wrangler/state" ]; then rm -rf "$OUT/saved-state"; mv "$WORKER/.wrangler/state" "$OUT/saved-state"; fi
cp "$WORKER/package.json" "$OUT/package.json.saved"
restore() {
  pkill -f "wrangler dev --port 87" 2>/dev/null
  pkill -f "wrangler dev --name afterwrd-87" 2>/dev/null
  sleep 1
  cp "$OUT/package.json.saved" "$WORKER/package.json"
  rm -rf "$WORKER/.wrangler/state"
  if [ -d "$OUT/saved-state" ]; then mkdir -p "$WORKER/.wrangler"; mv "$OUT/saved-state" "$WORKER/.wrangler/state"; fi
  if [ -d "$OUT/old" ]; then git -C "$WORKER" worktree remove --force "$OUT/old" 2>/dev/null; fi
}
trap restore EXIT

wait_for() { for _ in $(seq 1 90); do curl -s -o /dev/null "http://localhost:$1/_auth/login" && return 0; sleep 1; done; echo "Site on $1 didn't start" >&2; return 1; }
start() { # [code dir] [extra wrangler args…] — one fresh site on 8787
  local dir="$WORKER"
  if [ "${1:-}" != "" ] && [ -d "$1" ]; then dir="$1"; shift; fi
  (cd "$dir" && "$WRANGLER" dev --port 8787 --ip 127.0.0.1 --var SETUP_CODE:local-test-setup-code "$@" > "$OUT/dev.log" 2>&1 &)
  wait_for 8787
}
stop() { pkill -f "wrangler dev --port 8787" 2>/dev/null; sleep 2; }
fresh() { stop; rm -rf "$WORKER/.wrangler/state"; start "$@"; }
suite() { echo "== $1"; (cd "$HERE" && node "$@") | grep -v '^PASS' ; [ "${PIPESTATUS[0]}" = 0 ] || FAILED=1; }

run_core() { # each on a new site
  fresh; suite security.mjs
  fresh; suite comments.mjs "$OUT/fake-export.zip"
  fresh; suite posts.mjs "$OUT/fake-export.zip" "$PHOTOS"
  fresh; suite admin.mjs
  stop
}
run_fresh() { fresh; suite fresh.mjs "$OUT/fake-export.zip" "$PHOTOS"; stop; }
run_albums() { fresh; suite albums.mjs "$PHOTOS"; stop; }
run_update() {
  fresh; suite update-ui.mjs current; stop
  # Pretend to be an older version, so an update is waiting (package.json is put back afterwards).
  sed -i.bak 's/"version": "[^"]*"/"version": "0.0.1"/' "$WORKER/package.json" && rm -f "$WORKER/package.json.bak"
  # With a stand-in for Cloudflare's token endpoint (run by the test) for Connect Cloudflare.
  fresh --var ALLOW_LOCAL_SITES:1 --var OAUTH_TOKEN_URL:http://127.0.0.1:8799/token; suite update-ui.mjs behind; stop
  fresh --var UPDATE_TOKEN:test-token-not-real; suite update-ui.mjs remembered; stop
  cp "$OUT/package.json.saved" "$WORKER/package.json"
}
three_sites() { # $1: the suite, run against three sites, each with its own database; $2: also a group's Worker (G, 8790)
  stop
  local sites="8787:A 8788:B 8789:C"
  if [ "${2:-}" = group ]; then sites="$sites 8790:G"; fi
  for site in $sites; do
    local port="${site%%:*}" name="${site##*:}" mode="--var SETUP_CODE:local-test-setup-code"
    if [ "$name" = G ]; then mode="--var GROUP_KEY:local-test-group-key"; fi
    rm -rf "$OUT/state$name"
    (cd "$WORKER" && "$WRANGLER" dev --name "afterwrd-$port" --port "$port" --ip 127.0.0.1 --inspector-port $((port + 500)) \
      --persist-to "$OUT/state$name" $mode --var ALLOW_LOCAL_SITES:1 > "$OUT/dev$port.log" 2>&1 &)
  done
  wait_for 8787 && wait_for 8788 && wait_for 8789 && { [ "${2:-}" != group ] || wait_for 8790; }
  suite "$1" "$OUT/fake-export.zip" "$PHOTOS" "$OUT/stateA" "$OUT/stateB" "$OUT/stateC" "$OUT/stateG"
  pkill -f "wrangler dev --name afterwrd-87" 2>/dev/null; sleep 2
}
run_feed() { three_sites feed.mjs; }
run_groups() { three_sites groups.mjs group; }
run_checks() { # one site, with stand-ins for Cloudflare and GitHub on 8799 (checks.mjs runs them)
  fresh --var ALLOW_LOCAL_SITES:1 --var OAUTH_TOKEN_URL:http://127.0.0.1:8799/token \
    --var CLOUDFLARE_API_URL:http://127.0.0.1:8799/client/v4 --var RELEASES_URL:http://127.0.0.1:8799/releases
  suite checks.mjs; stop
}
run_screenshots() { three_sites screenshots.mjs group; } # the README's pictures, in docs/screenshots (not a test)
run_forged() {
  echo "== forged"
  node "$WORKER/scripts/asset-hashes.mjs" # the static file hashes src/static.js bundles
  "$WORKER/node_modules/.bin/esbuild" "$HERE/unit-entry.js" --bundle --format=esm --platform=node --loader:.json=json \
    --loader:.sql=text --alias:cloudflare:workers="$HERE/workers-stub.js" --outfile="$OUT/bundle.mjs" --log-level=error
  (cd "$HERE" && node forged.mjs) | grep -v '^PASS'; [ "${PIPESTATUS[0]}" = 0 ] || FAILED=1
}
run_upgrade() { # $1: an older release tag
  local tag="$1"
  rm -rf "$OUT/old" "$OUT/stateU"
  git -C "$WORKER" worktree add -q --detach "$OUT/old" "$tag" || { FAILED=1; return; }
  ln -s "$WORKER/node_modules" "$OUT/old/worker/node_modules"
  stop
  (cd "$OUT/old/worker" && "$WRANGLER" dev --port 8787 --ip 127.0.0.1 --persist-to "$OUT/stateU" --var SETUP_CODE:local-test-setup-code > "$OUT/dev.log" 2>&1 &)
  wait_for 8787; suite upgrade.mjs before "$PHOTOS"; stop
  (cd "$WORKER" && "$WRANGLER" dev --port 8787 --ip 127.0.0.1 --persist-to "$OUT/stateU" --var SETUP_CODE:local-test-setup-code > "$OUT/dev.log" 2>&1 &)
  wait_for 8787; suite upgrade.mjs after "$PHOTOS"; stop
  git -C "$WORKER" worktree remove --force "$OUT/old"
}

if [ $# -eq 0 ]; then set -- core fresh albums update feed groups checks forged; fi
while [ $# -gt 0 ]; do
  case "$1" in
    core|fresh|albums|update|feed|groups|checks|forged|screenshots) "run_$1" ;;
    upgrade) shift; run_upgrade "${1:?give an older release tag, e.g. v0.12.0}" ;;
    *) echo "Unknown suite: $1" >&2; FAILED=1 ;;
  esac
  shift
done

if [ "$FAILED" = 0 ]; then echo "All passed."; else echo "Something failed (see above; logs and screenshots are in $OUT)."; fi
exit "$FAILED"

#!/usr/bin/env bash
# Driver for verifying the ADS-B Tauri desktop app on macOS.
#
# The GUI is NOT drivable here: tauri-driver is Linux/Windows only, and a
# non-interactive shell has no Screen Recording permission, so `screencapture`
# fails with "could not create image from display".
#
# So this drives the app through the two surfaces that ARE reachable:
#   * its TCP input   -- a mock dump1090 on :30003 (mock_dump1090.py)
#   * its HTTP output -- the read-only tool server on :8787 (tool_server.rs)
# The one thing it cannot do is click Start; `wait` blocks for a human to.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(git -C "$HERE" rev-parse --show-toplevel)"
APP_DIR="${ADSB_APP_DIR:-$HOME/Library/Application Support/com.adsb.aircraft-tracker}"
DB="$APP_DIR/adsb_history.db"
TOOLS="${ADSB_TOOL_SERVER:-localhost:8787}"
BACKUP="${ADSB_BACKUP_DIR:-/tmp/adsb-backup}"

now_ms() { python3 -c 'import time;print(int(time.time()*1000))'; }
tool() { curl -s -m 10 -X POST "$TOOLS/tools/$1" -H 'Content-Type: application/json' -d "$2"; }
app_up() { tool getStorageStats '{}' 2>/dev/null | grep -q '"ok":true'; }

require_app() {
  app_up || { echo "FAIL: tool server not answering on $TOOLS -- is the app running?" >&2; exit 1; }
}

case "${1:-help}" in

backup)
  mkdir -p "$BACKUP"
  cp "$DB" "$DB.wal" "$APP_DIR/config.json" "$BACKUP/" 2>/dev/null
  echo "backed up to $BACKUP"; ls -la "$BACKUP"
  ;;

baseline)
  require_app; mkdir -p "$BACKUP"
  tool getStorageStats '{}' | python3 -c '
import json,sys
d=json.load(sys.stdin)["data"]
print(json.dumps({k:d[k] for k in ("row_count","raw_message_count","flight_count")}))' \
  | tee "$BACKUP/baseline.json"
  ;;

feed)
  python3 "$HERE/mock_dump1090.py" &
  echo "mock feed pid $!"
  ;;

wait)
  require_app
  echo "waiting for TST00* rows -- click Start in the app window..."
  for _ in $(seq 1 120); do
    N=$(now_ms)
    if tool getAircraftSummary "{\"start_ms\":$((N-120000)),\"end_ms\":$N}" | grep -q 'TST00'; then
      echo "aircraft reached storage"; exit 0
    fi
    sleep 3
  done
  echo "FAIL: no mock aircraft after 6 minutes" >&2; exit 1
  ;;

verify)
  require_app
  N=$(now_ms)
  echo "merge assertions (MSG1 + MSG3 + MSG4 -> one record):"
  tool getTrajectory "{\"hex_ident\":\"TST001\",\"start_ms\":$((N-600000)),\"end_ms\":$N}" \
    | python3 "$HERE/verify_merge.py"
  ;;

summary)
  require_app
  N=$(now_ms)
  tool getAircraftSummary "{\"start_ms\":$((N-600000)),\"end_ms\":$N}" | python3 "$HERE/summarize.py"
  ;;

selftest) # validate the parsers against captured fixtures -- needs no app
  fail=0
  echo "verify_merge.py -- healthy trajectory (expect exit 0)"
  python3 "$HERE/verify_merge.py" < "$HERE/fixtures/trajectory_ok.json" >/dev/null \
    && echo "  ok" || { echo "  BROKEN: rejected a valid trajectory"; fail=1; }
  echo "verify_merge.py -- broken merge (expect exit 1)"
  python3 "$HERE/verify_merge.py" < "$HERE/fixtures/trajectory_broken_merge.json" >/dev/null \
    && { echo "  BROKEN: accepted a null position -- the detector cannot detect"; fail=1; } \
    || echo "  ok"
  echo "verify_merge.py -- empty response (expect exit 1)"
  echo '{"ok":true,"data":[]}' | python3 "$HERE/verify_merge.py" >/dev/null \
    && { echo "  BROKEN: accepted an empty trajectory"; fail=1; } || echo "  ok"
  echo "summarize.py -- all six aircraft (expect exit 0)"
  python3 "$HERE/summarize.py" < "$HERE/fixtures/summary_ok.json" >/dev/null \
    && echo "  ok" || { echo "  BROKEN: rejected a full summary"; fail=1; }
  [ $fail -eq 0 ] && echo "selftest PASSED" || echo "selftest FAILED"
  exit $fail
  ;;

purge)
  if app_up; then
    echo "FAIL: app still running -- stop it first, DuckDB holds an exclusive lock" >&2
    exit 1
  fi
  mkdir -p "$REPO/rust/adsb-data-engine/examples"
  cp "$HERE/purge_test_rows.rs" "$REPO/rust/adsb-data-engine/examples/"
  ( cd "$REPO/rust" && cargo run -q -p adsb-data-engine --example purge_test_rows -- "$DB" )
  rc=$?
  rm -f "$REPO/rust/adsb-data-engine/examples/purge_test_rows.rs"
  rmdir "$REPO/rust/adsb-data-engine/examples" 2>/dev/null
  exit $rc
  ;;

*)
  cat <<USAGE
usage: driver.sh <command>       (paths default to the installed app's data dir)

  backup     copy DB + config to $BACKUP before a mock run
  baseline   record row counts, to compare after purge
  feed       start the mock dump1090 on :30003
  wait       block until mock aircraft reach DuckDB (needs the Start click)
  verify     assert MSG1/MSG3/MSG4 merged onto one record   <-- the real test
  summary    list the mock aircraft and their position counts
  selftest   check the parsers against fixtures (no app needed)
  purge      delete TST00* rows (app must be STOPPED first)
USAGE
  ;;
esac

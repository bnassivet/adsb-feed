#!/usr/bin/env bash
# The OpenSky service on its own: `stack.sh opensky` / `stop-opensky` and the
# control subcommands, behind `make up-opensky` / `down-opensky` / ...
#
# A throwaway named stack and a FAKE binary (ADSB_BIN): nothing real starts and
# no OpenSky credit is spent. The point most worth pinning is that the
# credentials reach the process through its environment and nowhere else.
#
#     bash scripts/tests/test_stack_opensky.sh
set -uo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
STACK_SH="$REPO/scripts/stack.sh"
NAME="openskytest$$"
CONFIG="$REPO/adsb-stack-$NAME.toml"   # gitignored: adsb-stack-*.toml
RUN="$REPO/.run/$NAME"
FAKE_BIN="$(mktemp -d)"
SECRET="s3cr3t-$$-value"
fails=0

cleanup() {
  STACK="$NAME" ADSB_BIN="$FAKE_BIN" bash "$STACK_SH" stop-opensky >/dev/null 2>&1
  rm -rf "$CONFIG" "$RUN" "$FAKE_BIN"
}
trap cleanup EXIT

check() { # check <label> <expected> <actual>
  if [ "$2" = "$3" ]; then
    printf '  ok    %s\n' "$1"
  else
    printf '  FAIL  %s\n        expected: %s\n        actual:   %s\n' "$1" "$2" "$3"
    fails=$((fails + 1))
  fi
}

# set_opensky <key> <toml value> -- scoped to [opensky].
set_opensky() {
  python3 - "$CONFIG" "$1" "$2" <<'PY'
import re, sys
path, key, value = sys.argv[1:4]
text = open(path).read()
head, sep, rest = text.partition("[opensky]")
assert sep, "template has no [opensky] section"
body, nxt, tail = rest.partition("\n[")
body, n = re.subn(rf"(?m)^{key}\s*=.*$", f"{key} = {value}", body, count=1)
assert n == 1, f"[opensky] has no {key} key"
open(path, "w").write(head + sep + body + nxt + tail)
PY
}

sh_() {
  # The caller's shell must not leak real credentials into the test.
  env -u ADSB_OPENSKY_CLIENT_ID -u ADSB_OPENSKY_CLIENT_SECRET -u ADSB_OPENSKY_CREDENTIALS_FILE \
    STACK="$NAME" ADSB_BIN="$FAKE_BIN" ADSB_CURL="$FAKE_BIN/curl" bash "$STACK_SH" "$@" 2>&1
}
pid_file_exists() { [ -f "$RUN/opensky.pid" ] && echo yes || echo no; }

cp "$REPO/adsb-stack-template.toml" "$CONFIG"

echo "disabled in the config: refuses, starts nothing"
out="$(sh_ opensky)"; rc=$?
check "exits non-zero" "1" "$([ "$rc" -ne 0 ] && echo 1 || echo 0)"
check "names the setting" "yes" "$(grep -q 'enabled' <<<"$out" && echo yes || echo no)"
check "no pid file" "no" "$(pid_file_exists)"

echo "enabled but not built: refuses with the build command"
set_opensky enabled true
out="$(sh_ opensky)"; rc=$?
check "says to build" "yes" "$(grep -q 'make build' <<<"$out" && echo yes || echo no)"
check "no pid file" "no" "$(pid_file_exists)"

echo "enabled and built: starts with credentials in its environment only"
set_opensky client_id '"me-api-client"'
set_opensky client_secret "\"$SECRET\""
# The fake reports its argv and whether each credential arrived, never the
# secret itself.
cat > "$FAKE_BIN/adsb-opensky-server" <<'FAKE'
#!/bin/sh
echo "argv: $*"
echo "id: ${ADSB_OPENSKY_CLIENT_ID:-unset}"
[ -n "${ADSB_OPENSKY_CLIENT_SECRET:-}" ] && echo "secret: set" || echo "secret: unset"
exec sleep 60
FAKE
chmod +x "$FAKE_BIN/adsb-opensky-server"

out="$(sh_ opensky)"; rc=$?
check "exits zero" "0" "$rc"
check "pid file written" "yes" "$(pid_file_exists)"
LOG="$RUN/logs/opensky.log"
for _ in $(seq 1 50); do grep -q '^secret:' "$LOG" 2>/dev/null && break; sleep 0.1; done
check "started with the rendered config" "yes" \
  "$(grep -q -- "argv: --config $RUN/opensky.toml" "$LOG" && echo yes || echo no)"
check "client id in the environment" "yes" "$(grep -qx 'id: me-api-client' "$LOG" && echo yes || echo no)"
check "client secret in the environment" "yes" "$(grep -qx 'secret: set' "$LOG" && echo yes || echo no)"
check "secret not on the command line" "no" "$(grep -q -- "$SECRET" "$LOG" && echo yes || echo no)"
check "secret not in the rendered config" "no" \
  "$(grep -q -- "$SECRET" "$RUN/opensky.toml" && echo yes || echo no)"
pid="$(cat "$RUN/opensky.pid")"
check "secret not in ps" "no" \
  "$(ps -ww -o args= -g "$pid" 2>/dev/null | grep -q -- "$SECRET" && echo yes || echo no)"

out="$(sh_ stop-opensky)"; rc=$?
check "stop exits zero" "0" "$rc"
check "pid file removed" "no" "$(pid_file_exists)"
check "process gone" "no" "$(kill -0 "$pid" 2>/dev/null && echo yes || echo no)"

echo "the desktop is told where the control API is"
env_out="$(sh_ desktop-env)"
check "API URL" "yes" \
  "$(grep -qx 'ADSB_OPENSKY_API_URL=http://localhost:8791' <<<"$env_out" && echo yes || echo no)"
check "no topic when it is derived" "no" \
  "$(grep -q '^ADSB_MQTT_OPENSKY_TOPIC=' <<<"$env_out" && echo yes || echo no)"
check "recording left at its default (on)" "no" \
  "$(grep -q '^ADSB_OPENSKY_RECORD=' <<<"$env_out" && echo yes || echo no)"
check "the secret never reaches the desktop" "no" \
  "$(grep -q -- "$SECRET" <<<"$env_out" && echo yes || echo no)"

echo "control subcommands talk to this stack's API"
cat > "$FAKE_BIN/curl" <<'FAKE'
#!/bin/sh
here="$(dirname "$0")"
method=GET body="" url=""
while [ $# -gt 0 ]; do
  case "$1" in
    -X) method="$2"; shift ;;
    -d) body="$2"; shift ;;
    -H|-w|--max-time) shift ;;
    -*) ;;
    *) url="$1" ;;
  esac
  shift
done
echo "$method $url${body:+ $body}" >> "$here/api.log"
case "$url" in
  */v1/credits) printf '{"daily_limit": 4000, "hours": []}\n200' ;;
  */v1/status)  printf '{"version": 1, "state": "idle"}\n200' ;;
  *)            printf '{"enabled": false}\n202' ;;
esac
FAKE
chmod +x "$FAKE_BIN/curl"
out="$(sh_ opensky-credits)"; rc=$?
check "credits exits zero" "0" "$rc"
check "credits asked /v1/credits" "yes" \
  "$(grep -qx 'GET http://127.0.0.1:8791/v1/credits' "$FAKE_BIN/api.log" && echo yes || echo no)"
out="$(sh_ opensky-disable)"; rc=$?
check "disable exits zero" "0" "$rc"
check "disable sent the desired state" "yes" \
  "$(grep -q 'PUT http://127.0.0.1:8791/v1/enabled {"enabled":false}' "$FAKE_BIN/api.log" && echo yes || echo no)"

echo
if [ "$fails" -eq 0 ]; then echo "all OpenSky stack checks passed"; else echo "$fails check(s) failed"; exit 1; fi

#!/usr/bin/env bash
# The weather service on its own: `stack.sh weather` / `stop-weather`, behind
# `make up-weather` / `down-weather` / `restart-weather`.
#
# Runs against a throwaway named stack and a FAKE binary (ADSB_BIN), so it
# starts nothing real and spends no Open-Meteo quota.
#
#     bash scripts/tests/test_stack_weather.sh
set -uo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
STACK_SH="$REPO/scripts/stack.sh"
NAME="weathertest$$"
CONFIG="$REPO/adsb-stack-$NAME.toml"   # gitignored: adsb-stack-*.toml
RUN="$REPO/.run/$NAME"
FAKE_BIN="$(mktemp -d)"
fails=0

cleanup() {
  STACK="$NAME" ADSB_BIN="$FAKE_BIN" bash "$STACK_SH" stop-weather >/dev/null 2>&1
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

# write_config <true|false> -- the template with [weather].enabled set.
write_config() {
  python3 - "$REPO/adsb-stack-template.toml" "$CONFIG" "$1" <<'PY'
import re, sys
src, dst, enabled = sys.argv[1:4]
text = open(src).read()
head, sep, rest = text.partition("[weather]")
assert sep, "template has no [weather] section"
body, nxt, tail = rest.partition("\n[")
body, n = re.subn(r"(?m)^enabled\s*=\s*\w+", f"enabled = {enabled}", body, count=1)
assert n == 1, "[weather] has no enabled key"
open(dst, "w").write(head + sep + body + nxt + tail)
PY
}

sh_() { STACK="$NAME" ADSB_BIN="$FAKE_BIN" ADSB_CURL="$FAKE_BIN/curl" bash "$STACK_SH" "$@" 2>&1; }
pid_file_exists() { [ -f "$RUN/weather.pid" ] && echo yes || echo no; }

echo "disabled in the config: refuses, starts nothing"
write_config false
out="$(sh_ weather)"; rc=$?
check "exits non-zero" "1" "$([ "$rc" -ne 0 ] && echo 1 || echo 0)"
check "names the setting to change" "yes" "$(grep -q 'enabled' <<<"$out" && echo yes || echo no)"
check "no pid file" "no" "$(pid_file_exists)"

echo "enabled but not built: refuses with the build command"
write_config true
out="$(sh_ weather)"; rc=$?
check "exits non-zero" "1" "$([ "$rc" -ne 0 ] && echo 1 || echo 0)"
check "says to build" "yes" "$(grep -q 'make build' <<<"$out" && echo yes || echo no)"
check "no pid file" "no" "$(pid_file_exists)"

echo "enabled and built: starts, stops"
cat > "$FAKE_BIN/adsb-weather-server" <<'FAKE'
#!/bin/sh
echo "fake weather server $*"
exec sleep 60
FAKE
chmod +x "$FAKE_BIN/adsb-weather-server"

out="$(sh_ weather)"; rc=$?
check "exits zero" "0" "$rc"
check "pid file written" "yes" "$(pid_file_exists)"
check "process alive" "yes" "$(kill -0 "$(cat "$RUN/weather.pid" 2>/dev/null)" 2>/dev/null && echo yes || echo no)"
check "config was rendered for it" "yes" "$([ -f "$RUN/weather.toml" ] && echo yes || echo no)"
# The fake writes its argv once perl has exec'd it, which is not instant:
# poll rather than sleep a fixed amount, or this is flaky under load.
logged_config() { grep -q -- "--config $RUN/weather.toml" "$RUN/logs/weather.log" 2>/dev/null; }
for _ in $(seq 1 50); do logged_config && break; sleep 0.1; done
check "started with the rendered config" "yes" "$(logged_config && echo yes || echo no)"

out="$(sh_ weather)"
check "a second start is a no-op" "yes" "$(grep -q 'already running' <<<"$out" && echo yes || echo no)"

pid="$(cat "$RUN/weather.pid")"
out="$(sh_ stop-weather)"; rc=$?
check "stop exits zero" "0" "$rc"
check "pid file removed" "no" "$(pid_file_exists)"
check "process gone" "no" "$(kill -0 "$pid" 2>/dev/null && echo yes || echo no)"

echo "stopping when nothing runs is not an error -- even with weather disabled"
write_config false
sh_ stop-weather >/dev/null; rc=$?
check "exits zero" "0" "$rc"

echo "the desktop is launched on this stack's MQTT topic"
# Regression: `make up-desktop` passed no MQTT settings, so the desktop kept a
# topic from its own stored config (adsb/sbs/raw, from before topics carried a
# stage), derived adsb/weather/grid from it, and sat at "waiting for the weather
# service" while the service published to adsb/dev/weather/grid.
write_config true
stack_value() { # stack_value <section> <key>
  python3 -c 'import sys,tomllib; print(tomllib.load(open(sys.argv[1],"rb"))[sys.argv[2]][sys.argv[3]])' \
    "$CONFIG" "$1" "$2"
}
env_out="$(sh_ desktop-env)"
has() { grep -qx -- "$1" <<<"$env_out" && echo yes || echo no; }
check "feed topic"  "yes" "$(has "ADSB_MQTT_TOPIC=$(stack_value mqtt topic)")"
check "broker host" "yes" "$(has "ADSB_MQTT_BROKER=$(stack_value mqtt host)")"
check "broker port" "yes" "$(has "ADSB_MQTT_PORT=$(stack_value mqtt port)")"
# Unset, the desktop derives the weather topic from the feed topic by the same
# rule as render-config.py; exporting a copy of that rule would be a third one.
check "no weather topic when it is derived" "no" \
  "$(grep -q '^ADSB_MQTT_WEATHER_TOPIC=' <<<"$env_out" && echo yes || echo no)"
# Env beats the stored setting on every launch, so exporting the source kind
# would make Settings -> Feed Source look dead.
check "source kind left to the app's setting" "no" \
  "$(grep -q '^ADSB_SOURCE_KIND=' <<<"$env_out" && echo yes || echo no)"

python3 - "$CONFIG" <<'PY'
import re, sys
path = sys.argv[1]
text = open(path).read()
text, n = re.subn(r'(?m)^# topic = "adsb/dev/weather/grid"$', 'topic = "adsb/test/weather/custom"', text, count=1)
assert n == 1, "template no longer carries the commented weather topic"
open(path, "w").write(text)
PY
env_out="$(sh_ desktop-env)"
check "an explicit weather topic is passed through" "yes" \
  "$(has "ADSB_MQTT_WEATHER_TOPIC=adsb/test/weather/custom")"

echo "the weather control API subcommands talk to the running service"
write_config true
# set_weather_key <key> <toml value> -- scoped to [weather]: [storage] has an
# http_port too, and editing that one would pass this test for the wrong reason.
set_weather_key() {
  python3 - "$CONFIG" "$1" "$2" <<'PY'
import re, sys
path, key, value = sys.argv[1:4]
text = open(path).read()
head, sep, rest = text.partition("[weather]")
body, nxt, tail = rest.partition("\n[")
body, n = re.subn(rf"(?m)^{key}\s*=.*$", f"{key} = {value}", body, count=1)
assert n == 1, f"[weather] has no {key} key"
open(path, "w").write(head + sep + body + nxt + tail)
PY
}
# Nothing listens here: curl is faked below, so no port is ever opened.
API_PORT=18789
set_weather_key http_port "$API_PORT"

env_out="$(sh_ desktop-env)"
check "the desktop is told where the control API is" "yes" \
  "$(has "ADSB_WEATHER_API_URL=http://$(stack_value mqtt host):$API_PORT")"

# A stand-in for curl, and through it for the service. It logs each request
# and answers the way the real API does: GET a status, PUT enabled=false
# accepted, PUT enabled=true refused as an unwritable state file would be.
# With "down" in the mode file it fails the way curl does with nothing
# listening. The real HTTP path is covered by the Rust control_api tests.
API_LOG="$FAKE_BIN/api-requests.log"
echo up > "$FAKE_BIN/api-mode"
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
echo "$method $url${body:+ $body}" >> "$here/api-requests.log"
if [ "$(cat "$here/api-mode")" = down ]; then
  echo "curl: (7) Failed to connect: Connection refused" >&2
  exit 7
fi
case "$method $body" in
  "GET ")               printf '{"version": 1, "enabled": true, "state": "idle"}\n200' ;;
  *'"enabled":false'*)  printf '{"enabled": false}\n202' ;;
  *)                    printf '{"error": "state file is read-only"}\n500' ;;
esac
FAKE
chmod +x "$FAKE_BIN/curl"

out="$(sh_ weather-status)"; rc=$?
check "status exits zero" "0" "$rc"
check "status shows the service's state" "yes" "$(grep -q '"state": "idle"' <<<"$out" && echo yes || echo no)"
check "status asked this stack's API" "yes" \
  "$(grep -qx "GET http://127.0.0.1:$API_PORT/v1/status" "$API_LOG" && echo yes || echo no)"

out="$(sh_ weather-disable)"; rc=$?
check "disable exits zero" "0" "$rc"
check "disable sent the desired state" "yes" \
  "$(grep -qx "PUT http://127.0.0.1:$API_PORT/v1/enabled {\"enabled\":false}" "$API_LOG" && echo yes || echo no)"
check "disable points at the status for the outcome" "yes" \
  "$(grep -q 'weather-status' <<<"$out" && echo yes || echo no)"

out="$(sh_ weather-enable)"; rc=$?
check "a refused command exits non-zero" "1" "$([ "$rc" -ne 0 ] && echo 1 || echo 0)"
check "a refused command shows the service's reason" "yes" \
  "$(grep -q 'read-only' <<<"$out" && echo yes || echo no)"
check "a refused command is not mistaken for a dead service" "no" \
  "$(grep -q 'is the weather service running' <<<"$out" && echo yes || echo no)"

echo down > "$FAKE_BIN/api-mode"
out="$(sh_ weather-status)"; rc=$?
check "nothing listening exits non-zero" "1" "$([ "$rc" -ne 0 ] && echo 1 || echo 0)"
check "nothing listening says how to start it" "yes" \
  "$(grep -q 'make up-weather' <<<"$out" && echo yes || echo no)"

set_weather_key http_port 0
out="$(sh_ weather-status)"; rc=$?
check "a disabled API is refused" "1" "$([ "$rc" -ne 0 ] && echo 1 || echo 0)"
check "a disabled API names the setting" "yes" \
  "$(grep -q 'http_port = 0' <<<"$out" && echo yes || echo no)"

echo
if [ "$fails" -eq 0 ]; then echo "OK"; else echo "$fails failure(s)"; exit 1; fi

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

sh_() { STACK="$NAME" ADSB_BIN="$FAKE_BIN" bash "$STACK_SH" "$@" 2>&1; }
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

echo
if [ "$fails" -eq 0 ]; then echo "OK"; else echo "$fails failure(s)"; exit 1; fi

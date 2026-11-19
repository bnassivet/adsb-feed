#!/usr/bin/env bash
# [desktop] copilotkit_inspector -> NEXT_PUBLIC_COPILOTKIT_DISABLE_INSPECTOR,
# [desktop] radar_cleanup_on_start -> ADSB_RADAR_CLEANUP_ON_START, and the
# desktop's secrets staying out of the printout.
#
# Asserted through `stack.sh desktop-env`, which prints the environment the
# desktop is launched with, so nothing is started.
#
#     bash scripts/tests/test_stack_inspector.sh
set -uo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
STACK_SH="$REPO/scripts/stack.sh"
NAME="inspectortest$$"
CONFIG="$REPO/adsb-stack-$NAME.toml"   # gitignored: adsb-stack-*.toml
RUN="$REPO/.run/$NAME"
fails=0

cleanup() { rm -rf "$CONFIG" "$RUN"; }
trap cleanup EXIT

check() { # check <label> <expected> <actual>
  if [ "$2" = "$3" ]; then
    printf '  ok    %s\n' "$1"
  else
    printf '  FAIL  %s\n        expected: %s\n        actual:   %s\n' "$1" "$2" "$3"
    fails=$((fails + 1))
  fi
}

# set_inspector <toml value | "absent"> -- edits [desktop] only.
set_inspector() {
  python3 - "$REPO/adsb-stack-template.toml" "$CONFIG" "$1" <<'PY'
import re, sys
src, dst, value = sys.argv[1:4]
text = open(src).read()
head, sep, rest = text.partition("[desktop]")
assert sep, "template has no [desktop] section"
body, nxt, tail = rest.partition("\n[")
body, n = re.subn(r"(?m)^copilotkit_inspector\s*=.*\n?", "", body)
if value != "absent":
    body = body.rstrip("\n") + f"\ncopilotkit_inspector = {value}\n"
open(dst, "w").write(head + sep + body + nxt + tail)
PY
}

VAR=NEXT_PUBLIC_COPILOTKIT_DISABLE_INSPECTOR
env_line() { STACK="$NAME" bash "$STACK_SH" desktop-env 2>&1 | grep "^$VAR=" || echo "(unset)"; }

echo "the template documents the setting, on by default"
check "template has copilotkit_inspector = true" "yes" \
  "$(grep -qx 'copilotkit_inspector = true' "$REPO/adsb-stack-template.toml" && echo yes || echo no)"

echo "default and explicit true leave the variable unset (.env.local still applies)"
set_inspector absent
check "key absent" "(unset)" "$(env_line)"
set_inspector true
check "true" "(unset)" "$(env_line)"

echo "false turns the inspector off"
set_inspector false
check "false" "$VAR=true" "$(env_line)"

# set_radar_cleanup <toml value | "absent"> -- edits [desktop] of $CONFIG in place.
set_radar_cleanup() {
  python3 - "$CONFIG" "$1" <<'PY'
import re, sys
dst, value = sys.argv[1:3]
text = open(dst).read()
head, sep, rest = text.partition("[desktop]")
assert sep, "config has no [desktop] section"
body, nxt, tail = rest.partition("\n[")
body = re.sub(r"(?m)^radar_cleanup_on_start\s*=.*\n?", "", body)
if value != "absent":
    body = body.rstrip("\n") + f"\nradar_cleanup_on_start = {value}\n"
open(dst, "w").write(head + sep + body + nxt + tail)
PY
}
radar_line() { STACK="$NAME" bash "$STACK_SH" desktop-env 2>&1 | grep "^ADSB_RADAR_CLEANUP_ON_START=" || echo "(unset)"; }

echo "radar frames are cleaned up at start by default"
check "template has radar_cleanup_on_start = true" "yes" \
  "$(grep -qx 'radar_cleanup_on_start = true' "$REPO/adsb-stack-template.toml" && echo yes || echo no)"
set_radar_cleanup absent
check "key absent" "(unset)" "$(radar_line)"
set_radar_cleanup true
check "true" "(unset)" "$(radar_line)"
set_radar_cleanup false
check "false keeps them" "ADSB_RADAR_CLEANUP_ON_START=false" "$(radar_line)"

echo "the CARTO, OpenAIP and Météo-France keys are never printed"
python3 - "$CONFIG" <<'PY'
import re, sys
p = sys.argv[1]; t = open(p).read()
for k in ("carto_api_key", "openaip_api_key", "meteofrance_api_key"):
    t, n = re.subn(rf'(?m)^{k}\s*=.*$', f'{k} = "secret-test-key"', t, count=1)
    assert n == 1, k
open(p, "w").write(t)
PY
check "no secret in desktop-env" "no" \
  "$(STACK="$NAME" bash "$STACK_SH" desktop-env 2>&1 | grep -q 'secret-test-key' && echo yes || echo no)"

echo
if [ "$fails" -eq 0 ]; then echo "OK"; else echo "$fails failure(s)"; exit 1; fi

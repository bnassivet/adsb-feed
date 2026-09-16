#!/usr/bin/env bash
# The feed client's Prometheus port, as stack.sh sees it.
#
# Two lists want this port -- `doctor`'s collision check and `stack_ports`,
# which `down` and `reap` use to find orphans -- and they are maintained
# separately. A port that reaches one and not the other is exactly the failure
# this pins.
#
# Runs against a throwaway named stack and a FAKE binary (ADSB_BIN), so it
# starts nothing real.
#
#     bash scripts/tests/test_stack_metrics.sh
set -uo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
STACK_SH="$REPO/scripts/stack.sh"
NAME="metricstest$$"
CONFIG="$REPO/adsb-stack-$NAME.toml"   # gitignored: adsb-stack-*.toml
RUN="$REPO/.run/$NAME"
FAKE_BIN="$(mktemp -d)"
fails=0

cleanup() { rm -rf "$CONFIG" "$RUN" "$FAKE_BIN"; }
trap cleanup EXIT

check() { # check <label> <expected> <actual>
  if [ "$2" = "$3" ]; then
    printf '  ok    %s\n' "$1"
  else
    printf '  FAIL  %s\n        expected: %s\n        actual:   %s\n' "$1" "$2" "$3"
    fails=$((fails + 1))
  fi
}

cp "$REPO/adsb-stack-template.toml" "$CONFIG"

# set_metrics_key <key> <toml value> -- scoped to [metrics], the way
# test_stack_weather.sh scopes its edits to [weather]. [storage] has an
# http_port too, and a loose regex would edit the wrong section and pass for
# the wrong reason.
set_metrics_key() {
  python3 - "$CONFIG" "$1" "$2" <<'PY'
import re, sys
path, key, value = sys.argv[1:4]
text = open(path).read()
head, sep, rest = text.partition("[metrics]")
assert sep, "template has no [metrics] section"
body, nxt, tail = rest.partition("\n[")
body, n = re.subn(rf"(?m)^{key}\s*=.*$", f"{key} = {value}", body, count=1)
assert n == 1, f"[metrics] has no {key} key"
open(path, "w").write(head + sep + body + nxt + tail)
PY
}

# Drop a section entirely, to stand in for a config written before this existed.
drop_metrics_section() {
  python3 - "$CONFIG" <<'PY'
import sys
path = sys.argv[1]
text = open(path).read()
head, sep, rest = text.partition("[metrics]")
assert sep, "template has no [metrics] section"
_body, nxt, tail = rest.partition("\n[")
open(path, "w").write(head + nxt.lstrip("\n") + tail)
PY
}

sh_() { STACK="$NAME" ADSB_BIN="$FAKE_BIN" bash "$STACK_SH" "$@" 2>&1; }

# doctor's Ports block only -- the port must be listed as a port, not merely
# mentioned somewhere in the output.
doctor_ports() { sh_ doctor | sed -n '/^Ports:/,/^[A-Z]/p'; }
lists_port() { grep -qE "^ +(free|BUSY) +$1$" <<<"$(doctor_ports)" && echo yes || echo no; }

echo "the template's port reaches doctor"
check "8790 is checked for collisions" "yes" "$(lists_port 8790)"

echo "a changed port follows"
set_metrics_key feed_port 18790
check "the new port is checked" "yes" "$(lists_port 18790)"
check "the old port is not" "no" "$(lists_port 8790)"

echo "0 disables the endpoint, so there is no port to collide"
set_metrics_key feed_port 0
check "0 is never reported as a port" "no" "$(lists_port 0)"

echo "a config written before [metrics] existed still works"
# Every gitignored adsb-stack.toml predates this section. Rendering and doctor
# must not break on one, and must not invent a listener it never asked for.
drop_metrics_section
out="$(sh_ doctor)"
check "doctor still runs" "yes" "$(grep -q '^Ports:' <<<"$out" && echo yes || echo no)"
check "no port is assumed" "no" "$(lists_port 8790)"

echo
if [ "$fails" -eq 0 ]; then echo "OK"; else echo "$fails failure(s)"; exit 1; fi

#!/usr/bin/env bash
# Path/identity resolution for named stacks, via `stack.sh paths`.
#
# Plain bash, no framework: this must run from a bare checkout the same way
# `make up` does.
#
#     bash scripts/tests/test_stack_paths.sh
set -uo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
STACK_SH="$REPO/scripts/stack.sh"
fails=0

check() { # check <label> <expected> <actual>
  if [ "$2" = "$3" ]; then
    printf '  ok    %s\n' "$1"
  else
    printf '  FAIL  %s\n        expected: %s\n        actual:   %s\n' "$1" "$2" "$3"
    fails=$((fails + 1))
  fi
}

field() { # field <STACK value> <key>
  STACK="$1" bash "$STACK_SH" paths | awk -v k="$2" '$1 == k {print $2}'
}

echo "default stack (STACK unset) -- must be byte-identical to today's layout"
check "config file" "$REPO/adsb-stack.toml"   "$(field "" config)"
check "run dir"     "$REPO/.run"              "$(field "" run)"
check "logs"        "$REPO/.run/logs"         "$(field "" logs)"
check "name"        "default"                 "$(field "" name)"
check "compose project" "adsb-mqtt"           "$(field "" project)"

echo "named stack STACK=prod"
check "config file" "$REPO/adsb-stack-prod.toml" "$(field prod config)"
check "run dir"     "$REPO/.run/prod"            "$(field prod run)"
check "logs"        "$REPO/.run/prod/logs"       "$(field prod logs)"
check "name"        "prod"                       "$(field prod name)"
# A distinct compose project keeps the two brokers' containers, networks and
# volumes apart; without it the second `up` adopts the first one's container.
check "compose project" "adsb-mqtt-prod"         "$(field prod project)"

echo "a second named stack is independent of the first"
check "config file" "$REPO/adsb-stack-lab.toml" "$(field lab config)"
check "run dir"     "$REPO/.run/lab"            "$(field lab run)"
check "compose project" "adsb-mqtt-lab"         "$(field lab project)"

echo "a path may be given instead of a name"
check "config file" "$REPO/deploy/other.toml" "$(field "$REPO/deploy/other.toml" config)"
# Named from the file's stem, so .run/ stays keyed to something meaningful.
check "run dir"     "$REPO/.run/other"         "$(field "$REPO/deploy/other.toml" run)"

echo "tauri dev config override"
# The default ports must produce NO override at all, so the default stack runs
# the committed tauri.conf.json and plain `npm run tauri dev`.
# The default stack, on the committed ports, must produce NO override at all --
# it then runs tauri.conf.json unchanged and the plain `npm run tauri dev`.
check "default stack produces no override" "" "$(STACK= bash "$STACK_SH" tauri-config)"

ovr="$(python3 "$REPO/scripts/tauri-dev-config.py" 3010 8010)"
check "devUrl carries the dev port" "http://localhost:3010" \
  "$(printf %s "$ovr" | python3 -c 'import json,sys;print(json.load(sys.stdin)["build"]["devUrl"])')"
check "beforeDevCommand carries it too" "npx next dev --port 3010" \
  "$(printf %s "$ovr" | python3 -c 'import json,sys;print(json.load(sys.stdin)["build"]["beforeDevCommand"])')"
# The CSP is the half that is easy to forget: without this the second instance's
# agent calls are blocked outright and it reads as "the agent is down".
check "CSP allows this stack's agent" "yes" \
  "$(printf %s "$ovr" | python3 -c '
import json,sys
csp = json.load(sys.stdin)["app"]["security"]["csp"]
print("yes" if "http://localhost:8010" in csp and "http://127.0.0.1:8010" in csp else "no")')"
check "CSP does not still allow the default agent" "yes" \
  "$(printf %s "$ovr" | python3 -c '
import json,sys
csp = json.load(sys.stdin)["app"]["security"]["csp"]
print("yes" if "localhost:8000" not in csp else "no")')"
check "CSP keeps the map tile sources" "yes" \
  "$(printf %s "$ovr" | python3 -c '
import json,sys
csp = json.load(sys.stdin)["app"]["security"]["csp"]
print("yes" if "tile.openstreetmap.org" in csp and "ipc:" in csp else "no")')"

echo
if [ "$fails" -eq 0 ]; then echo "OK"; else echo "$fails failure(s)"; exit 1; fi

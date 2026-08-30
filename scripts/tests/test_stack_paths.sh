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

echo
if [ "$fails" -eq 0 ]; then echo "OK"; else echo "$fails failure(s)"; exit 1; fi

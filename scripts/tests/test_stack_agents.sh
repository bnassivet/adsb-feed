#!/usr/bin/env bash
# The AI agents on their own: `stack.sh agents` / `stop-agents`, behind
# `make down-agents` / `restart-agents`.
#
# Runs against a throwaway named stack with a FAKE `uv` first on PATH, so it
# starts no real agent, needs no LLM, and binds no port.
#
#     bash scripts/tests/test_stack_agents.sh
set -uo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
STACK_SH="$REPO/scripts/stack.sh"
NAME="agentstest$$"
CONFIG="$REPO/adsb-stack-$NAME.toml"   # gitignored: adsb-stack-*.toml
RUN="$REPO/.run/$NAME"
FAKE_BIN="$(mktemp -d)"
fails=0

sh_() { STACK="$NAME" PATH="$FAKE_BIN:$PATH" bash "$STACK_SH" "$@" 2>&1; }

cleanup() {
  sh_ stop-agents >/dev/null
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

cp "$REPO/adsb-stack-template.toml" "$CONFIG"

# Stands in for `uv run python -m <module>`: logs its argv and its working
# directory, then idles like a server would.
cat > "$FAKE_BIN/uv" <<'FAKE'
#!/bin/sh
echo "fake uv $* (in $(pwd))"
exec sleep 60
FAKE
chmod +x "$FAKE_BIN/uv"

pid_of()  { cat "$RUN/$1.pid" 2>/dev/null; }
alive()   { kill -0 "$(pid_of "$1")" 2>/dev/null && echo yes || echo no; }
has_pid() { [ -f "$RUN/$1.pid" ] && echo yes || echo no; }
# The fake logs once perl has exec'd it, which is not instant: poll.
logged() { # logged <name> <pattern>
  for _ in $(seq 1 50); do
    grep -q -- "$2" "$RUN/logs/$1.log" 2>/dev/null && { echo yes; return; }
    sleep 0.1
  done
  echo no
}

echo "agents: starts both, without the rest of the stack"
out="$(sh_ agents)"; rc=$?
check "exits zero" "0" "$rc"
for n in agent sim-agent; do
  check "$n pid file written" "yes" "$(has_pid "$n")"
  check "$n alive" "yes" "$(alive "$n")"
done
check "agent runs adsb_agent" "yes" "$(logged agent "-m adsb_agent (in $REPO/rust/adsb-agent)")"
check "sim-agent runs adsb_simulation_agent" "yes" \
  "$(logged sim-agent "-m adsb_simulation_agent (in $REPO/rust/adsb-simulation-agent)")"
for n in feed data-server weather desktop; do
  check "does not start $n" "no" "$(has_pid "$n")"
done

out="$(sh_ agents)"
check "a second start is a no-op" "yes" "$(grep -q 'already running' <<<"$out" && echo yes || echo no)"

echo "stop-agents: stops both"
agent_pid="$(pid_of agent)"; sim_pid="$(pid_of sim-agent)"
out="$(sh_ stop-agents)"; rc=$?
check "exits zero" "0" "$rc"
check "agent pid file removed" "no" "$(has_pid agent)"
check "sim-agent pid file removed" "no" "$(has_pid sim-agent)"
check "agent gone" "no" "$(kill -0 "$agent_pid" 2>/dev/null && echo yes || echo no)"
check "sim-agent gone" "no" "$(kill -0 "$sim_pid" 2>/dev/null && echo yes || echo no)"

echo "stopping when nothing runs is not an error"
sh_ stop-agents >/dev/null; rc=$?
check "exits zero" "0" "$rc"

echo "restart-agents is stop then start"
recipe="$(make -n -C "$REPO" restart-agents STACK="$NAME" 2>&1)"
check "stops first" "yes" "$(head -1 <<<"$recipe" | grep -q 'stop-agents' && echo yes || echo no)"
check "then starts" "yes" "$(grep -q 'stack.sh agents\|SH) agents\| agents$' <<<"$recipe" && echo yes || echo no)"

echo
if [ "$fails" -eq 0 ]; then echo "OK"; else echo "$fails failure(s)"; exit 1; fi

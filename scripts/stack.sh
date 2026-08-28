#!/usr/bin/env bash
# Start, stop and inspect the local ADS-B stack.
#
# Everything is configured from adsb-stack.toml -- edit that, not the rendered
# files in .run/. PIDs and logs live in .run/ too, which is gitignored.
#
# Deliberately kills only PIDs it started. A broad `pkill -f adsb` would catch
# a developer's own hand-started process, which is exactly the sort of thing
# that makes people distrust tooling like this.
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUN="$REPO/.run"
LOGS="$RUN/logs"
STACK="$REPO/adsb-stack.toml"
TEMPLATE="$REPO/adsb-stack-template.toml"
BIN="$REPO/rust/target/release"
MOCK="$REPO/skills/run-adsb-desktop/mock_dump1090.py"
COMPOSE="$REPO/infrastructure/mqtt/docker-compose.yml"

mkdir -p "$RUN" "$LOGS"

# ---------------------------------------------------------------------------
# Reading adsb-stack.toml
# ---------------------------------------------------------------------------

# cfg <section> <key> [default] -- one value out of the stack file.
cfg() {
  python3 - "$STACK" "$1" "$2" "${3-}" <<'PY'
import sys, tomllib
path, section, key, default = sys.argv[1:5]
try:
    with open(path, "rb") as fh:
        v = tomllib.load(fh).get(section, {}).get(key, default)
except FileNotFoundError:
    v = default
print("true" if v is True else "false" if v is False else v)
PY
}

# Every command that reads the config funnels through this, so a missing file
# always produces the same one-line fix rather than a tomllib traceback.
require_config() {
  [ -f "$STACK" ] && return 0
  cat >&2 <<MSG
error: adsb-stack.toml not found.

  It is gitignored -- your machine's copy, like a .env. Create it with:

      make config

MSG
  exit 1
}

port_busy() { lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1; }
pidfile()   { echo "$RUN/$1.pid"; }

running() { # running <name>
  local f; f="$(pidfile "$1")"
  [ -f "$f" ] && kill -0 "$(cat "$f")" 2>/dev/null
}

start() { # start <name> <command...>
  local name="$1"; shift
  if running "$name"; then
    echo "  already running: $name (pid $(cat "$(pidfile "$name")"))"
    return 0
  fi
  "$@" > "$LOGS/$name.log" 2>&1 &
  echo $! > "$(pidfile "$name")"
  echo "  started $name (pid $!) -> .run/logs/$name.log"
}

stop() { # stop <name>
  local f; f="$(pidfile "$1")"
  [ -f "$f" ] || return 0
  local pid; pid="$(cat "$f")"
  if kill -0 "$pid" 2>/dev/null; then
    # SIGTERM, not SIGKILL: the data server checkpoints its WAL on the way out,
    # and an unclean stop leaves one that is slow to replay next boot.
    kill "$pid" 2>/dev/null
    for _ in $(seq 1 50); do kill -0 "$pid" 2>/dev/null || break; sleep 0.1; done
    kill -0 "$pid" 2>/dev/null && kill -9 "$pid" 2>/dev/null
    echo "  stopped $1"
  fi
  rm -f "$f"
}

render() { python3 "$REPO/scripts/render-config.py"; }

# ---------------------------------------------------------------------------

case "${1:-help}" in

config)
  if [ -f "$STACK" ]; then
    # Never clobber: this file holds a real receiver location and a token
    # someone chose. Same rule as install-edge.sh on the Pi.
    echo "adsb-stack.toml already exists -- leaving it alone."
    echo "Compare against the template with:  diff adsb-stack-template.toml adsb-stack.toml"
    exit 0
  fi
  cp "$TEMPLATE" "$STACK"
  echo "Created adsb-stack.toml from the template."
  echo "Edit [receiver] with your antenna's real position, then: make up"
  ;;

render) require_config; render ;;

doctor)
  rc=0
  echo "Config:"
  if [ -f "$STACK" ]; then
    echo "  ok      adsb-stack.toml"
  else
    echo "  MISSING adsb-stack.toml -- run: make config"
    rc=1
  fi

  echo "Binaries:"
  for b in adsb-pulsar-client adsb-data-server; do
    if [ -x "$BIN/$b" ]; then echo "  ok      $b"
    else echo "  MISSING $b -- run: make build"; rc=1; fi
  done

  echo "Docker:"
  if docker info >/dev/null 2>&1; then echo "  ok      daemon running"
  else echo "  MISSING docker daemon -- needed for the MQTT broker"; rc=1; fi

  echo "Ports:"
  # 3000 is listed because Grafana in infrastructure/docker-compose.yml wants
  # the same port as the desktop's Next dev server -- they cannot both run.
  for p in 1883 "$(cfg dump1090 port 30003)" "$(cfg storage http_port 8787)" \
           "$(cfg agents desktop_tool_port 8788)" 3000 8000 8300; do
    if port_busy "$p"; then echo "  BUSY    $p"; else echo "  free    $p"; fi
  done

  echo "Skills:"
  "$REPO/scripts/install-skills.sh" status 2>&1 | sed 's/^/  /'

  if [ "$(cfg agents enabled false)" = "true" ]; then
    echo "Agents:"
    llm="$(cfg agents llm_base_url)"
    if curl -s -m 3 -o /dev/null "$llm/models" 2>/dev/null; then
      echo "  ok      LLM at $llm"
    else
      echo "  MISSING LLM at $llm -- the agents will start but fail on first use"
    fi
  fi
  exit $rc
  ;;

up)
  require_config
  render
  echo "Broker:"
  docker compose -f "$COMPOSE" up -d 2>&1 | sed 's/^/  /'

  # The recorder must be subscribed BEFORE the feed publishes. MQTT here is
  # QoS 0 with persistence off, so anything sent while nobody is subscribed is
  # gone -- the feed would look healthy and nothing would be recorded.
  echo "Recorder:"
  start data-server "$BIN/adsb-data-server" --config "$RUN/data-server.toml"
  for _ in $(seq 1 40); do
    grep -q "Subscribed to MQTT topic" "$LOGS/data-server.log" 2>/dev/null && break
    sleep 0.25
  done
  grep -q "Subscribed to MQTT topic" "$LOGS/data-server.log" 2>/dev/null \
    || echo "  WARNING: recorder has not subscribed yet; early messages may be lost"

  if [ "$(cfg dump1090 mock true)" = "true" ]; then
    echo "Mock receiver:"
    start mock python3 "$MOCK"
    sleep 1
  fi

  echo "Feed:"
  start feed "$BIN/adsb-pulsar-client" --config "$RUN/feed.toml"

  if [ "${2-}" = "--agents" ] || [ "$(cfg agents enabled false)" = "true" ]; then
    echo "Agents:"
    start sim-agent sh -c "cd '$REPO/rust/adsb-simulation-agent' && uv run python -m adsb_simulation_agent"
    start agent     sh -c "cd '$REPO/rust/adsb-agent' && uv run python -m adsb_agent"
  fi

  echo
  echo "Up. 'make status' to check, 'make verify' to confirm data is flowing."
  ;;

down)
  # Reverse of start order: producers first, so the recorder sees the tail.
  for n in agent sim-agent feed mock data-server; do stop "$n"; done
  echo "Broker:"
  docker compose -f "$COMPOSE" down 2>&1 | sed 's/^/  /'
  ;;

status)
  require_config
  http="$(cfg storage http_port 8787)"
  for n in data-server feed mock agent sim-agent; do
    if running "$n"; then
      printf "  %-12s running (pid %s)\n" "$n" "$(cat "$(pidfile "$n")")"
    else
      printf "  %-12s stopped\n" "$n"
    fi
  done
  printf "  %-12s " "broker"
  port_busy 1883 && echo "listening on 1883" || echo "not listening"
  printf "  %-12s " "query api"
  curl -s -m 3 -X POST "localhost:$http/tools/getStorageStats" \
    -H 'Content-Type: application/json' -d '{}' 2>/dev/null | grep -q '"ok":true' \
    && echo "responding on $http" || echo "not responding on $http"
  ;;

logs)
  if [ -n "${2-}" ]; then tail -f "$LOGS/$2.log"; else tail -f "$LOGS"/*.log; fi
  ;;

verify)
  require_config
  http="$(cfg storage http_port 8787)"
  echo "Sampling $http twice, 6s apart..."
  read_rows() {
    curl -s -m 5 -X POST "localhost:$http/tools/getStorageStats" \
      -H 'Content-Type: application/json' -d '{}' 2>/dev/null \
      | python3 -c 'import json,sys; print(json.load(sys.stdin)["data"]["row_count"])' 2>/dev/null
  }
  a="$(read_rows)"; sleep 6; b="$(read_rows)"
  if [ -z "$a" ] || [ -z "$b" ]; then
    echo "FAIL: query API not answering -- is the stack up?" >&2; exit 1
  fi
  echo "  row_count: $a -> $b"
  if [ "$b" -gt "$a" ]; then
    echo "PASS: rows are being recorded"
  else
    echo "FAIL: no new rows. Check .run/logs/feed.log and data-server.log" >&2; exit 1
  fi
  ;;

*)
  cat <<USAGE
usage: stack.sh <command>

  config    create adsb-stack.toml from the template (never overwrites)
  render    regenerate .run/*.toml from adsb-stack.toml
  doctor    preflight: binaries, docker, ports, skills, LLM
  up        broker -> recorder -> feed (add --agents for the AI agents)
  down      stop everything this script started
  status    what is running
  logs [n]  tail one process, or all
  verify    confirm rows are actually being recorded

Config: adsb-stack.toml (gitignored; from adsb-stack-template.toml)
State:  .run/
USAGE
  ;;
esac

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

# Start a command as its own process-group LEADER, so stopping it later takes
# its children with it.
#
# Why this matters: `uv run python -m adsb_agent` forks python, and
# `npm run tauri dev` is a whole tree (next dev, cargo, the app binary).
# Signalling only the pid we recorded orphans the children, still holding their
# ports -- which is how a stale dev server ends up squatting on :3000 and
# failing the next launch with EADDRINUSE.
#
# perl is invoked DIRECTLY, never through a shell function. Wrapped in a
# function, `f cmd &` makes $! a bash subshell sitting in *our* process group,
# so the recorded pid is not the leader and `kill -- -$pid` would signal the
# caller's own group. As a simple command, bash execs perl in the background
# child, so $! is perl's pid, setpgrp makes it the leader, and the exec'd tree
# inherits it. macOS has no setsid(1); perl is the portable stand-in.
start() { # start <name> <command...>
  local name="$1"; shift
  if running "$name"; then
    echo "  already running: $name (pid $(cat "$(pidfile "$name")"))"
    return 0
  fi
  perl -e 'setpgrp(0,0); exec @ARGV or die "exec: $!"' "$@" \
    > "$LOGS/$name.log" 2>&1 &
  local pid=$!
  echo "$pid" > "$(pidfile "$name")"
  echo "  started $name (pid $pid) -> .run/logs/$name.log"
}

stop() { # stop <name>
  local f; f="$(pidfile "$1")"
  [ -f "$f" ] || return 0
  local pid; pid="$(cat "$f")"

  if kill -0 "$pid" 2>/dev/null; then
    # Only signal the group when the pid really is its leader. If start() ever
    # failed to make one, `kill -- -$pid` would hit whatever group it landed in
    # -- possibly ours -- so fall back to the single process instead.
    local pgid; pgid="$(ps -o pgid= -p "$pid" 2>/dev/null | tr -d ' ')"
    local target="$pid"
    [ "$pgid" = "$pid" ] && target="-$pid"

    # SIGTERM first, not SIGKILL: the data server checkpoints its WAL on the
    # way out, and an unclean stop leaves one that is slow to replay next boot.
    kill -TERM "$target" 2>/dev/null
    for _ in $(seq 1 60); do kill -0 "$pid" 2>/dev/null || break; sleep 0.1; done
    kill -0 "$pid" 2>/dev/null && kill -KILL "$target" 2>/dev/null
    echo "  stopped $1"
  fi
  rm -f "$f"
}

# Ports the stack is expected to own, for orphan reporting.
stack_ports() {
  echo "1883 $(cfg dump1090 port 30003) $(cfg storage http_port 8787)"
  echo "$(cfg agents desktop_tool_port 8788) 3000"
  [ "$(cfg agents enabled false)" = "true" ] && \
    echo "$(cfg agents agent_port 8000) $(cfg agents sim_agent_port 8300)"
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

  # Identity hygiene. All warnings, never failures: a single-node experiment
  # has no reason to carry a stage, and this must not block `make up`.
  #
  # The collision these guard against is silent and looks like a network fault.
  # Subscribers take the MQTT client id `<source_id>-sub`, so a desktop reusing
  # the recorder's source_id evicts it in a loop -- killing recording and the
  # live map together. See deploy/README.md.
  if [ -f "$STACK" ]; then
    echo "Identity:"
    id="$(cfg receiver id "")"
    topic="$(cfg mqtt topic "")"
    remote_uri="$(cfg remote uri "")"
    stage="${id##*-}"
    case "$stage" in
      dev|prod|staging|test)
        if [ "${topic#*/}" = "$topic" ] || [ "${topic#*"$stage"}" = "$topic" ]; then
          echo "  WARN    receiver.id is '$id' but mqtt.topic is '$topic' --"
          echo "          the stage should appear in both: adsb/$stage/sbs/raw"
        else
          echo "  ok      $id on $topic"
        fi
        ;;
      *)
        echo "  WARN    receiver.id '$id' has no stage suffix (-dev / -prod)."
        echo "          Two stacks on one LAN will evict each other. See deploy/README.md"
        ;;
    esac
    if [ -n "$remote_uri" ]; then
      # quack:host:port -> host -> short name. A desktop whose id matches the
      # remote node's is the exact case above.
      rhost="$(printf %s "$remote_uri" | cut -d: -f2)"
      if [ "${id%%-*}" = "${rhost%%.*}" ]; then
        echo "  WARN    receiver.id '$id' looks like the remote node '$rhost'."
        echo "          Give this client its own id or it will evict the recorder."
      fi
    fi
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

  # Duplicate feeds share one MQTT client id and evict each other in a loop.
  # That storm produced 567k reconnects and a 144 MB log before it was noticed,
  # so it is worth naming rather than leaving to be discovered.
  echo "Duplicates:"
  for proc in adsb-pulsar-client adsb-data-server; do
    # macOS pgrep has no -c; count lines instead.
    n=$(pgrep -f "target/release/$proc " 2>/dev/null | wc -l | tr -d " ")
    if [ "$n" -gt 1 ]; then
      echo "  DUPLICATE $n x $proc running -- they share an MQTT client id and will"
      echo "            evict each other in a reconnect loop. Fix: make reap"
      rc=1
    else
      echo "  ok        $proc x$n"
    fi
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
    start sim-agent sh -c "cd '$REPO/rust/adsb-simulation-agent' && exec uv run python -m adsb_simulation_agent"
    start agent     sh -c "cd '$REPO/rust/adsb-agent' && exec uv run python -m adsb_agent"
  fi

  echo
  echo "Up. 'make status' to check, 'make verify' to confirm data is flowing."
  ;;

desktop)
  require_config
  port="$(cfg agents desktop_tool_port 8788)"
  echo "Desktop:"
  # Backgrounded with a PID file like everything else, so `down` can stop it.
  # `npm run tauri dev` is a process tree -- next dev, cargo, the app binary --
  # which is why start/stop work on process groups.
  start desktop env "ADSB_AGENT_TOOL_SERVER_PORT=$port" \
    sh -c "cd '$REPO/rust/adsb-pulsar-client-desktop' && exec npm run tauri dev"
  echo "  watch it with: make logs N=desktop"
  ;;

client)
  # Pure client: the desktop attached to a data server elsewhere, plus the
  # agents. No broker, no feed, no recorder -- `up --agents` starts all three
  # unconditionally, and `make remote` starts no agents, so neither fits.
  require_config
  uri="$(cfg remote uri "")"
  [ -n "$uri" ] || { echo "Set [remote].uri in adsb-stack.toml first." >&2; exit 1; }
  tok="$(cfg remote token "")"
  mh="$(cfg mqtt host localhost)"
  mp="$(cfg mqtt port 1883)"
  mt="$(cfg mqtt topic adsb/sbs/raw)"
  port="$(cfg agents desktop_tool_port 8788)"

  case "$mh" in
    localhost|127.0.0.1)
      echo "Note: mqtt.host is $mh, so the live feed will be read locally." >&2
      echo "      Point it at the remote node for live aircraft over the LAN." >&2;;
  esac

  echo "Desktop (remote: $uri, live: mqtt://$mh:$mp/$mt):"
  # Both planes, explicitly. History is seeded on FIRST launch only; the live
  # source is applied every launch. See QUICKSTART.md topology 4.
  start desktop env \
    "ADSB_REMOTE_URI=$uri" "ADSB_REMOTE_TOKEN=$tok" \
    "ADSB_SOURCE_KIND=mqtt" "ADSB_MQTT_BROKER=$mh" \
    "ADSB_MQTT_PORT=$mp" "ADSB_MQTT_TOPIC=$mt" \
    "ADSB_AGENT_TOOL_SERVER_PORT=$port" \
    sh -c "cd '$REPO/rust/adsb-pulsar-client-desktop' && exec npm run tauri dev"

  echo "Agents:"
  # The agent defaults its tool server to :8787, which in the all-local stack
  # resolves to the data server. There is no data server on this machine, so
  # without this every one of its data tools fails with connection-refused.
  start sim-agent sh -c "cd '$REPO/rust/adsb-simulation-agent' && exec uv run python -m adsb_simulation_agent"
  start agent env "ADSB_AGENT_TOOL_SERVER_URL=http://127.0.0.1:$port" \
    sh -c "cd '$REPO/rust/adsb-agent' && exec uv run python -m adsb_agent"

  echo
  echo "Client up. 'make logs N=desktop' to watch it, 'make down' to stop."
  ;;

stop-desktop)
  echo "Desktop:"
  stop desktop
  ;;

down)
  # Reverse of start order: producers first, so the recorder sees the tail.
  for n in desktop agent sim-agent feed mock data-server; do stop "$n"; done
  echo "Broker:"
  docker compose -f "$COMPOSE" down 2>&1 | sed 's/^/  /'

  # Report anything still holding a stack port that we did not start. Killing
  # it is deliberately NOT automatic -- it may be the developer's own process --
  # but leaving them guessing why the next `up` fails is worse.
  orphans=""
  for p in $(stack_ports); do
    port_busy "$p" && orphans="$orphans $p"
  done
  if [ -n "$orphans" ]; then
    echo "Still in use (not started by this stack):"
    for p in $orphans; do
      printf "  :%-6s %s\n" "$p" "$(lsof -nP -iTCP:"$p" -sTCP:LISTEN 2>/dev/null | awk 'NR==2{print $1" pid "$2}')"
    done
    echo "  Clear them with: make reap"
  fi
  ;;

reap)
  # Last resort for orphans a previous run left behind -- typically a `tauri
  # dev` tree killed with Ctrl-C, whose next dev server keeps :3000 and makes
  # the next `make up-desktop` fail with EADDRINUSE.
  require_config
  found=0
  for p in $(stack_ports); do
    pids="$(lsof -nP -tiTCP:"$p" -sTCP:LISTEN 2>/dev/null)"
    for pid in $pids; do
      echo "  killing $(ps -p "$pid" -o comm= 2>/dev/null) (pid $pid) on :$p"
      kill -TERM -"$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null
      found=1
    done
  done
  [ "$found" = 1 ] || echo "  nothing listening on the stack's ports"
  ;;

status)
  require_config
  http="$(cfg storage http_port 8787)"
  for n in data-server feed mock desktop agent sim-agent; do
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
  desktop      start the desktop app (backgrounded; make logs N=desktop)
  client       desktop + agents ONLY, attached to [remote] -- no local stack
  stop-desktop stop just the desktop app
  down      stop everything this script started
  reap      kill whatever still holds the stack's ports (orphans)
  status    what is running
  logs [n]  tail one process, or all
  verify    confirm rows are actually being recorded

Config: adsb-stack.toml (gitignored; from adsb-stack-template.toml)
State:  .run/
USAGE
  ;;
esac

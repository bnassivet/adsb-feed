# ADS-B stack -- single entry point.
#
# Configuration lives in adsb-stack.toml. Local state (rendered configs, PIDs,
# logs, the dev database) lives in .run/, which is gitignored and safe to delete.
#
# Build and Pi-deployment targets are DELEGATED to rust/Makefile rather than
# duplicated, so the Docker arm64 logic and its job caps stay in one place.

RUST := $(CURDIR)/rust

# Which stack. Unset means adsb-stack.toml and .run/, exactly as before, so
# nothing that predates named stacks needs renaming:
#
#   make up                 adsb-stack.toml        .run/
#   make up STACK=prod      adsb-stack-prod.toml   .run/prod/
#
# Two stacks run in parallel as long as their configs choose different ports;
# `make doctor STACK=...` reports collisions. The desktop app is the exception
# -- single-instance across all stacks, and it says so if you try.
STACK ?=
SH := STACK=$(STACK) $(CURDIR)/scripts/stack.sh

.DEFAULT_GOAL := help

.PHONY: help
help:
	@echo "Run the stack:  (add STACK=<name> for a second, parallel stack)"
	@echo "  make doctor       preflight: binaries, docker, ports, skills"
	@echo "  make up           broker -> recorder -> feed"
	@echo "  make up-agents    ... plus the AI agents (:8000, :8300)"
	@echo "  make up-desktop   ... plus the desktop app (backgrounded)"
	@echo "  make remote       desktop only, attached to [remote] in adsb-stack.toml"
	@echo "  make client       desktop + agents only, no local broker/feed/recorder"
	@echo "  make down         stop everything the stack started"
	@echo "  make down-desktop stop just the desktop app"
	@echo "  make reap         kill orphans still holding the stack's ports"
	@echo "  make status       what is running"
	@echo "  make logs         tail all logs (make logs N=feed for one)"
	@echo "  make verify       confirm rows are actually being recorded"
	@echo "  make render       regenerate .run/*.toml from adsb-stack.toml"
	@echo "  make paths        which config and state dir this STACK resolves to"
	@echo "  make tauri-config the desktop's tauri -c override for this STACK"
	@echo "  make render-fleet F=deploy/prod.toml   render per-node fleet configs"
	@echo ""
	@echo "Build:"
	@echo "  make build        cargo build --release (host)"
	@echo "  make edge-arm64   Raspberry Pi artifacts   (delegated to rust/)"
	@echo "  make deploy       ship them to a Pi         (delegated to rust/)"
	@echo "  make ci           the full local gate       (delegated to rust/)"
	@echo ""
	@echo "Setup (once per checkout):"
	@echo "  make config       create adsb-stack.toml from the template"
	@echo "  make skills       symlink skills/ into .claude/"

# --- running ---------------------------------------------------------------

.PHONY: config
config: ; @$(SH) config

.PHONY: doctor up up-agents down status logs verify render paths tauri-config
paths:   ; @$(SH) paths
tauri-config: ; @$(SH) tauri-config
doctor:  ; @$(SH) doctor
up:      ; @$(SH) up
up-agents: ; @$(SH) up --agents
down:    ; @$(SH) down
status:  ; @$(SH) status
verify:  ; @$(SH) verify
render:  ; @$(SH) render
logs:    ; @$(SH) logs $(N)

# Backgrounded with a PID file like every other process, so `make down` can
# actually stop it. It used to run in the foreground for its output, but that
# left `tauri dev` -- a tree of next dev, cargo and the app binary -- with no
# way to be stopped except Ctrl-C, and any other exit orphaned a dev server
# squatting on :3000 that failed the next launch with EADDRINUSE.
.PHONY: up-desktop
up-desktop: up
	@$(SH) desktop

.PHONY: down-desktop
down-desktop:
	@$(SH) stop-desktop

.PHONY: reap
reap: ; @$(SH) reap

# The three-node topology: this machine is a pure client of a fleet elsewhere.
# Unlike `remote`, it also starts the agents and backgrounds the desktop with a
# PID file, so `make down` can stop the whole thing.
.PHONY: client
client: ; @$(SH) client

# Fleet configs for deployed nodes -- a different lifecycle from the dev stack:
# see deploy/README.md. F defaults to the conventional prod fleet.
.PHONY: render-fleet
render-fleet: F ?= deploy/prod.toml
render-fleet:
	@python3 scripts/render-config.py --fleet $(F)

# Desktop against a data server elsewhere -- no local feed or recorder.
#
# Two independent planes, and BOTH have to be pointed at the remote node:
#   history -> ADSB_REMOTE_URI (Quack ATTACH), seeded on FIRST launch only;
#              afterwards the stored setting wins -- Settings -> History Storage.
#   live    -> ADSB_SOURCE_KIND=mqtt + the broker, applied on EVERY launch.
# Setting only the first is the failure this target used to have: history loads
# from the Pi while the live map stays empty, because source_kind defaulted to
# `socket` against a 127.0.0.1:30003 with nothing behind it.
.PHONY: remote
remote:
	@test -f adsb-stack.toml || { echo "adsb-stack.toml not found -- run: make config" >&2; exit 1; }; \
	get() { python3 -c "import tomllib,sys;print(tomllib.load(open('adsb-stack.toml','rb'))[sys.argv[1]][sys.argv[2]])" "$$1" "$$2"; }; \
	uri=$$(get remote uri); tok=$$(get remote token); \
	mh=$$(get mqtt host); mp=$$(get mqtt port); mt=$$(get mqtt topic); \
	if [ -z "$$uri" ]; then echo "Set [remote].uri in adsb-stack.toml first." >&2; exit 1; fi; \
	case "$$mh" in localhost|127.0.0.1) \
	  echo "Note: mqtt.host is $$mh, so the live feed will be read locally." >&2; \
	  echo "      Point it at the remote node for live aircraft over the LAN." >&2;; \
	esac; \
	echo "Attaching the desktop to $$uri (live feed: mqtt://$$mh:$$mp/$$mt)"; \
	cd rust/adsb-pulsar-client-desktop && \
	  ADSB_REMOTE_URI="$$uri" ADSB_REMOTE_TOKEN="$$tok" \
	  ADSB_SOURCE_KIND=mqtt ADSB_MQTT_BROKER="$$mh" ADSB_MQTT_PORT="$$mp" ADSB_MQTT_TOPIC="$$mt" \
	  npm run tauri dev

# --- setup and build -------------------------------------------------------

.PHONY: skills
skills: ; @$(CURDIR)/scripts/install-skills.sh install

.PHONY: build
build: ; @cd $(RUST) && cargo build --release

.PHONY: edge-arm64 feed-arm64 server-arm64 feed-armv7 deploy
edge-arm64 feed-arm64 server-arm64 feed-armv7 deploy:
	@$(MAKE) -C $(RUST) $@

# The shell/Python tooling has its own tests. Stdlib unittest, no pytest, so it
# runs from a bare checkout the same way `make render` does.
.PHONY: test-scripts
test-scripts:
	@python3 scripts/tests/test_render_config.py
	@bash scripts/tests/test_stack_paths.sh

# The full gate: the tooling tests, then the Rust workspace gate in rust/.
.PHONY: ci
ci: test-scripts
	@$(MAKE) -C $(RUST) ci

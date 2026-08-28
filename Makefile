# ADS-B stack -- single entry point.
#
# Configuration lives in adsb-stack.toml. Local state (rendered configs, PIDs,
# logs, the dev database) lives in .run/, which is gitignored and safe to delete.
#
# Build and Pi-deployment targets are DELEGATED to rust/Makefile rather than
# duplicated, so the Docker arm64 logic and its job caps stay in one place.

RUST := $(CURDIR)/rust
STACK := $(CURDIR)/scripts/stack.sh

.DEFAULT_GOAL := help

.PHONY: help
help:
	@echo "Run the stack:"
	@echo "  make doctor       preflight: binaries, docker, ports, skills"
	@echo "  make up           broker -> recorder -> feed"
	@echo "  make up-agents    ... plus the AI agents (:8000, :8300)"
	@echo "  make up-desktop   ... plus the desktop app"
	@echo "  make remote       desktop only, attached to [remote] in adsb-stack.toml"
	@echo "  make down         stop everything the stack started"
	@echo "  make status       what is running"
	@echo "  make logs         tail all logs (make logs N=feed for one)"
	@echo "  make verify       confirm rows are actually being recorded"
	@echo "  make render       regenerate .run/*.toml from adsb-stack.toml"
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
config: ; @$(STACK) config

.PHONY: doctor up up-agents down status logs verify render
doctor:  ; @$(STACK) doctor
up:      ; @$(STACK) up
up-agents: ; @$(STACK) up --agents
down:    ; @$(STACK) down
status:  ; @$(STACK) status
verify:  ; @$(STACK) verify
render:  ; @$(STACK) render
logs:    ; @$(STACK) logs $(N)

# The desktop is a foreground app with its own dev server, so it is deliberately
# NOT backgrounded into .run/ -- you want its output in front of you.
.PHONY: up-desktop
up-desktop: up
	@echo "Starting the desktop app (Ctrl-C to stop it; the stack keeps running)"
	@cd rust/adsb-pulsar-client-desktop && npm run tauri dev

# Desktop against a data server elsewhere -- no local feed or recorder.
# ADSB_REMOTE_URI seeds the mode on FIRST launch only; afterwards the stored
# setting wins, so change it in Settings -> History Storage.
.PHONY: remote
remote:
	@test -f adsb-stack.toml || { echo "adsb-stack.toml not found -- run: make config" >&2; exit 1; }; \
	uri=$$(python3 -c "import tomllib;print(tomllib.load(open('adsb-stack.toml','rb'))['remote']['uri'])"); \
	tok=$$(python3 -c "import tomllib;print(tomllib.load(open('adsb-stack.toml','rb'))['remote']['token'])"); \
	if [ -z "$$uri" ]; then echo "Set [remote].uri in adsb-stack.toml first." >&2; exit 1; fi; \
	echo "Attaching the desktop to $$uri"; \
	cd rust/adsb-pulsar-client-desktop && ADSB_REMOTE_URI="$$uri" ADSB_REMOTE_TOKEN="$$tok" npm run tauri dev

# --- setup and build -------------------------------------------------------

.PHONY: skills
skills: ; @$(CURDIR)/scripts/install-skills.sh install

.PHONY: build
build: ; @cd $(RUST) && cargo build --release

.PHONY: edge-arm64 feed-arm64 server-arm64 deploy ci
edge-arm64 feed-arm64 server-arm64 deploy ci:
	@$(MAKE) -C $(RUST) $@

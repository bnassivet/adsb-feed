# Build and deployment for the ADS-B edge binaries.
#
# Cross-building for a Raspberry Pi from an Apple Silicon Mac is NOT a
# cross-compile: the host is arm64 and the Pi is aarch64, so a
# `--platform linux/arm64` container builds NATIVELY under Docker's VM. That
# sidesteps the hard part -- there is no cross toolchain to wire up, and
# DuckDB's bundled C++ amalgamation compiles with the container's own gcc.
#
# `cross` does NOT work here: its images are x86_64, and rust-toolchain.toml
# pins 1.92, so it tries to install a non-host x86_64 toolchain and rustup
# refuses.
#
# On an x86_64 host, the same targets work but the container is emulated and
# the DuckDB build is much slower; build on the Pi's own architecture or use a
# native arm64 runner instead.

RUST_IMAGE  ?= rust:1.92-bookworm
TARGET_DIR  ?= target-linux-arm64
PLATFORM    ?= linux/arm64
PI_HOST     ?= pi@raspberrypi.local

# Parallelism is capped deliberately. The workspace release profile sets
# codegen-units = 1 (right for a small, fast edge binary), so every parallel
# rustc holds a whole crate's codegen in one unit. On a 16-CPU / 8 GB Docker
# VM, building arrow-cast 16-wide gets SIGKILLed by the OOM killer. Cap the
# jobs rather than weakening the profile -- the profile is what keeps the
# shipped binary small.
JOBS ?= 4
# The data server needs a lower cap than the feed client. DuckDB's unity-build
# translation units (ub_src_*.cpp) each take GBs in cc1plus at -O3, so four in
# parallel exceed an 8 GB Docker VM and the build dies in cc-rs with a bare
# "exit status: 1". Measured good at 2: peak ~1.1 GiB, 9m44s.
SERVER_JOBS ?= 2

# Named volumes for the registry and rustup dir. Without them every build
# re-downloads the crate index AND the toolchain: rust-toolchain.toml pins
# channel "1.92", which rustup treats as a different toolchain from the image's
# preinstalled "1.92.0", so it fetches it (plus rustfmt and clippy) every run.
CACHE_MOUNTS = -v adsb-cargo-registry:/usr/local/cargo/registry \
	-v adsb-rustup:/usr/local/rustup

DOCKER_RUN = docker run --rm --platform $(PLATFORM) \
	-v "$(CURDIR)":/work -w /work \
	$(CACHE_MOUNTS) \
	-e CARGO_TARGET_DIR=/work/$(TARGET_DIR) \
	$(RUST_IMAGE)

OUT = $(TARGET_DIR)/release

.PHONY: help
help:
	@echo "Edge build targets (aarch64 Linux, for Raspberry Pi 4/5):"
	@echo "  feed-arm64        adsb-pulsar-client, no Pulsar (no protoc needed)"
	@echo "  feed-arm64-pulsar adsb-pulsar-client with Pulsar (installs protoc)"
	@echo "  server-arm64      adsb-data-server (bundled DuckDB; the slow one)"
	@echo "  edge-arm64        both artifacts for a storage node"
	@echo "  deploy PI_HOST=…  scp the built binaries + units to a Pi"
	@echo "  ci                the full local gate"

# ~19s, ~2.1 MB. Omitting Pulsar drops the `pulsar` crate and with it the
# protoc build dependency -- the main friction when building for the edge.
.PHONY: feed-arm64
feed-arm64:
	$(DOCKER_RUN) cargo build --release -p adsb-pulsar-client -j $(JOBS) \
		--no-default-features --features cli,mqtt
	@ls -la $(OUT)/adsb-pulsar-client

# Pulsar needs protoc at build time, so this variant installs it first.
.PHONY: feed-arm64-pulsar
feed-arm64-pulsar:
	$(DOCKER_RUN) sh -c "apt-get update -qq && apt-get install -y -qq protobuf-compiler && \
		cargo build --release -p adsb-pulsar-client -j $(JOBS)"
	@ls -la $(OUT)/adsb-pulsar-client

# aarch64 only: DuckDB has no 32-bit ARM support.
.PHONY: server-arm64
server-arm64:
	$(DOCKER_RUN) cargo build --release -p adsb-data-server -j $(SERVER_JOBS)
	@ls -la $(OUT)/adsb-data-server

.PHONY: edge-arm64
edge-arm64: feed-arm64 server-arm64

# Feed-only node (Pi Zero / Pi 3 on a 32-bit OS). No data server: DuckDB
# cannot be built for this target at all.
.PHONY: feed-armv7
feed-armv7:
	docker run --rm --platform linux/arm/v7 \
		-v "$(CURDIR)":/work -w /work \
		-e CARGO_TARGET_DIR=/work/target-linux-armv7 \
		$(RUST_IMAGE) \
		cargo build --release -p adsb-pulsar-client -j $(JOBS) --no-default-features --features cli,mqtt
	@ls -la target-linux-armv7/release/adsb-pulsar-client

# Ships whichever binaries have been built: a feed-only node never builds the
# data server, and install-edge.sh skips it when absent.
.PHONY: deploy
deploy:
	@test -f $(OUT)/adsb-pulsar-client || { \
		echo "No feed binary. Run 'make feed-arm64' first." >&2; exit 1; }
	scp $(OUT)/adsb-pulsar-client $(PI_HOST):/tmp/
	@if [ -f $(OUT)/adsb-data-server ]; then \
		scp $(OUT)/adsb-data-server adsb-data-server/adsb-data-server.service \
		    adsb-data-server/data-server.example.toml $(PI_HOST):/tmp/; \
	else \
		echo "(no data server built -- deploying feed client only)"; \
	fi
	scp adsb-pulsar-client/adsb-pulsar-client.service \
	    adsb-pulsar-client/feed.example.toml \
	    scripts/install-edge.sh $(PI_HOST):/tmp/
	@echo "Now on the Pi:  sudo bash /tmp/install-edge.sh"

.PHONY: ci
ci:
	cargo test --workspace
	cargo clippy --workspace -- -D warnings
	cargo fmt --all --check
	# Proves Pulsar is genuinely optional and that no-default-features
	# consumers (the Tauri app, adsb-data-server) still compile.
	cargo build -p adsb-pulsar-client --no-default-features --features cli,mqtt
	cargo build -p adsb-pulsar-client --no-default-features

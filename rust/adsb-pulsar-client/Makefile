.PHONY: help build release test clean run install fmt clippy doc cross-armv7 cross-aarch64

help: ## Show this help message
	@echo "Available targets:"
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-20s\033[0m %s\n", $$1, $$2}'

build: ## Build debug version
	cargo build

release: ## Build optimized release version
	cargo build --release

test: ## Run tests
	cargo test

clean: ## Clean build artifacts
	cargo clean

run: ## Run in test mode (localhost dump1090)
	cargo run -- \
		--socket-host localhost \
		--socket-port 30003 \
		--test-mode

install: release ## Install to system
	cargo install --path .

fmt: ## Format code
	cargo fmt

clippy: ## Run clippy linter
	cargo clippy -- -D warnings

doc: ## Generate and open documentation
	cargo doc --no-deps --open

cross-armv7: ## Cross-compile for Raspberry Pi (ARMv7)
	cargo build --release --target armv7-unknown-linux-gnueabihf

cross-aarch64: ## Cross-compile for Raspberry Pi (ARM64)
	cargo build --release --target aarch64-unknown-linux-gnu

check: fmt clippy test ## Run all checks (format, lint, test)

# Production deployment targets
deploy-local: release ## Deploy to /usr/local/bin
	sudo cp target/release/adsb-pulsar-client /usr/local/bin/
	sudo chmod +x /usr/local/bin/adsb-pulsar-client

deploy-systemd: deploy-local ## Install systemd service
	@echo "Copy systemd service file:"
	@echo "  sudo cp adsb-pulsar-client.service /etc/systemd/system/"
	@echo "  sudo systemctl daemon-reload"
	@echo "  sudo systemctl enable adsb-pulsar-client"
	@echo "  sudo systemctl start adsb-pulsar-client"

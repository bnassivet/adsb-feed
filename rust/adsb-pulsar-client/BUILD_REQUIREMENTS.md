# Build Requirements

## Why is protoc needed?

The Rust Pulsar client (`pulsar` crate) uses Protocol Buffers for its internal wire protocol. At build time, it compiles `.proto` files into Rust code, which requires the `protoc` (Protocol Buffers compiler) to be installed on your system.

This is a **build-time only** requirement - the final binary does not need `protoc` to run.

## Installation Options

### Option 1: Install protoc (Recommended)

This is the simplest and fastest option.

**macOS with Homebrew:**
```bash
brew install protobuf
```

**macOS with MacPorts:**
```bash
sudo port install protobuf3-cpp
```

**macOS without package manager:**
Download from: https://github.com/protocolbuffers/protobuf/releases
1. Download the appropriate binary for macOS
2. Extract and place `protoc` in your PATH

**Linux (Debian/Ubuntu):**
```bash
sudo apt-get update
sudo apt-get install protobuf-compiler
```

**Linux (RHEL/CentOS/Fedora):**
```bash
sudo yum install protobuf-compiler
```

**Verify installation:**
```bash
protoc --version
# Should output: libprotoc 3.x.x or higher
```

### Option 2: Use Pre-Built Binary (If no package manager)

If you don't have Homebrew or MacPorts:

```bash
# Download latest protobuf release
PROTOC_VERSION=25.1
PROTOC_ZIP=protoc-${PROTOC_VERSION}-osx-universal_binary.zip

curl -LO https://github.com/protocolbuffers/protobuf/releases/download/v${PROTOC_VERSION}/${PROTOC_ZIP}
unzip ${PROTOC_ZIP} -d $HOME/.local
export PATH="$HOME/.local/bin:$PATH"

# Verify
protoc --version
```

Add to your `~/.zshrc` or `~/.bash_profile`:
```bash
export PATH="$HOME/.local/bin:$PATH"
```

### Option 3: Cross-Compile on Another Machine

If you can't install protoc on your target device (e.g., Raspberry Pi), build on a different machine:

```bash
# On your development machine (with protoc installed):
rustup target add armv7-unknown-linux-gnueabihf
cargo build --release --target armv7-unknown-linux-gnueabihf

# Copy the binary to Raspberry Pi
scp target/armv7-unknown-linux-gnueabihf/release/adsb-pulsar-client pi@raspberrypi:/home/pi/
```

The compiled binary is standalone and doesn't need protoc on the target device.

## After Installing protoc

Once `protoc` is installed, you can build the project:

```bash
cd src/rust/adsb-pulsar-client
cargo build --release
```

The resulting binary at `target/release/adsb-pulsar-client` is completely standalone and can be deployed anywhere without any dependencies.

## Troubleshooting

### "Could not find `protoc`"

**Solution:** Make sure `protoc` is in your PATH:
```bash
which protoc
# Should output the path to protoc
```

If not found, add to PATH or reinstall.

### "protoc version too old"

**Solution:** Update to protobuf 3.x or later:
```bash
brew upgrade protobuf  # macOS
```

### Still having issues?

Check that protoc is executable:
```bash
ls -la $(which protoc)
chmod +x $(which protoc)
```

## Alternative: Use Python Version

If installing protoc is not feasible for your use case, you can use the Python implementation instead:

```bash
cd src/python
uv sync
uv run python pulsar-client-async.py [options]
```

The Python version doesn't require protoc, but it will be slower and use more resources than the Rust version.

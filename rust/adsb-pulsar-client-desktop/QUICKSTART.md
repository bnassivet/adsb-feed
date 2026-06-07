# Quick Start Guide - ADS-B Desktop Tracker

## 0. Prerequisites

**Rust 1.75+:**
```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
```

**Protocol Buffers compiler** (required by the Pulsar crate):

```bash
# macOS
brew install protobuf

# Linux (Debian/Ubuntu)
sudo apt-get install protobuf-compiler
```

**Node.js 18+:**
```bash
# macOS
brew install node

# Or via nvm
nvm install --lts
```

**Python 3.12+ and [uv](https://github.com/astral-sh/uv)** (only for the optional AI assistant — see section 5):
```bash
curl -LsSf https://astral.sh/uv/install.sh | sh
```

**Verify:**
```bash
rustc --version    # 1.75+
protoc --version
node --version     # 18+
npm --version
uv --version       # optional, for the AI assistant
```

## 1. Install Dependencies

```bash
cd adsb-feed/rust/adsb-pulsar-client-desktop

# Install Node.js dependencies
npm install
```

## 2. Run in Development Mode

```bash
npm run tauri dev
```

This starts both the Next.js dev server and the Tauri Rust backend. The first build takes a few minutes (Rust compilation); subsequent launches use the cache.

The app window opens automatically. Use **Settings** to configure the connection before clicking **Start**.

## 3. Configure the Connection

Open **Settings** from the top-right corner of the dashboard.

### Test Mode (no Pulsar, no dump1090 needed)

1. Check **Test mode**
2. Set **Socket Host** to `localhost` and **Socket Port** to `30003`
3. Click **Save**

The client will attempt to connect to the socket but won't require a Pulsar broker.

### With Local dump1090

1. Make sure dump1090 is running on your machine:
   ```bash
   # Verify port 30003 is listening
   netstat -an | grep 30003
   ```
2. Set **Socket Host** to `localhost` and **Socket Port** to `30003`
3. Check **Test mode** (unless you also have Pulsar running)
4. Click **Save**, then **Start** from the dashboard

Aircraft should appear on the map and in the table within seconds.

### With dump1090 + Pulsar

1. Start a local Pulsar broker:
   ```bash
   docker run -it -p 6650:6650 -p 8080:8080 apachepulsar/pulsar:latest bin/pulsar standalone
   ```
2. In Settings, configure:
   - **Socket Host**: your dump1090 host (e.g. `10.0.0.200`)
   - **Socket Port**: `30003`
   - **Broker URL**: `pulsar://localhost:6650`
   - **Topic**: `persistent://kradsb/adsb/sbs-topic`
   - **Test mode**: unchecked
3. Click **Save**, then **Start**

## 4. Using the Dashboard

| Area | Description |
|------|-------------|
| **Header** | Connection status indicators (Socket / Pulsar), Start/Stop button, Settings link |
| **Sidebar** | Filter aircraft by callsign, altitude range, and ground speed range |
| **Map** | Leaflet map with aircraft markers colored by altitude and rotated by heading |
| **Details Panel** | Click any aircraft (map marker or table row) to open a right panel with full details: altitude sparkline with time/altitude axes, vertical tendency, squawk, message count, and last-seen time. Drag the left edge to resize; use `<<`/`>>` to fold/unfold |
| **Table** | Sortable aircraft list with callsign, altitude, speed, squawk, and position |
| **Footer** | Live metrics: messages/s, total sent, bytes received, errors, queue size, uptime |

### Keyboard Shortcuts

- **Cmd+Option+I** (macOS) / **Ctrl+Shift+I** (Linux/Windows): Open Web Inspector for debugging

## 5. (Optional) Start the AI Assistant

The app includes an optional natural-language chat panel (AG-UI) backed by a local
Python agent. It runs as a **separate process** — the tracker works fine without it; the
chat panel simply reports the agent as unreachable until it is started.

You also need an OpenAI-compatible LLM endpoint running (LM Studio by default on
`http://localhost:1234/v1`) with a capable tool-calling model such as
**Qwen2.5-7B-Instruct**.

```bash
cd adsb-feed/rust/adsb-agent

# Install the agent's Python dependencies (--all-extras includes voice input)
uv sync --all-extras

# Start the agent (defaults to port 8000)
uv run python -m adsb_agent
```

The desktop app connects to the agent at `http://localhost:8000/ag-ui`. The Tauri backend
also starts a loopback tool server on `127.0.0.1:8787` that the agent uses for read-only
historical queries (no setup needed — it starts with the app).

For configuration, environment variables, and voice-input (Voxtral / LFM2.5-Audio) setup,
see [`agent/README.md`](../adsb-agent/README.md). For the architecture, see
[docs/DESIGN.md §18](docs/DESIGN.md#ai-agent--ag-ui-integration).

## 6. Build for Production

```bash
npm run tauri build
```

The bundled application is output to `src-tauri/target/release/bundle/`. On macOS this produces a `.dmg` and `.app`.

## Common Issues

### "No route to host" on Start

The socket host is unreachable. Go to **Settings** and verify the **Socket Host** and **Socket Port** match your dump1090 instance. Use `localhost` for a local source.

### "Connection refused" to Pulsar

Pulsar isn't running at the configured broker URL. Either:
- Start Pulsar: `docker run -it -p 6650:6650 -p 8080:8080 apachepulsar/pulsar:latest bin/pulsar standalone`
- Or enable **Test mode** in Settings to skip Pulsar

### First build is slow

The initial `npm run tauri dev` compiles the entire Rust backend (~2-3 minutes). Subsequent runs reuse the Cargo cache and start in seconds.

### Map tiles not loading

The app needs internet access for OpenStreetMap tiles. Check your network connection and ensure no firewall blocks `https://*.tile.openstreetmap.org`.

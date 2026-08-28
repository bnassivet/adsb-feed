# adsb-pulsar-client — Design Document

## Overview

`adsb-pulsar-client` is a high-performance, async Rust library (and CLI binary) that ingests SBS-1
format messages from a dump1090 TCP socket and fans them out to one or more pluggable forwarding
backends. It targets edge deployment on Raspberry Pi devices but is equally usable as a library
embedded in desktop applications (see: `adsb-pulsar-client-desktop`).

```
dump1090 (TCP/SBS-1)
        │
        ▼
┌──────────────────────────────────────────┐
│           ADSBFeedClient                 │
│                                          │
│  TcpStream → LineBuffer → forward_message│
│                               │          │
│                     ┌─────────┴────────┐ │
│                     │  Fan-out loop    │ │
│                     └──┬────────────┬──┘ │
│             retry_queues[0]   retry_queues[N]
└─────────────┼────────────────┼────────────┘
              ▼                ▼
      Forwarder #0        Forwarder #N
    (PulsarForwarder)   (FileForwarder / …)
```

---

## Key Design Decisions

### 1. Pluggable backends via `MessageForwarder` trait

The core client is decoupled from any specific backend. All forwarding logic lives behind the
`MessageForwarder` trait; the client holds a `Vec<Box<dyn MessageForwarder>>` and fans out every
message to all registered backends independently.

This means:
- Adding a new backend (MQTT, WebSocket, …) requires zero changes to `client.rs`.
- Backends can be combined at runtime (e.g., Pulsar + file simultaneously).
- The Tauri desktop app uses `NoopForwarder` and the message-tap channel — no Pulsar dependency.

### 2. Per-forwarder independent failure handling

Each forwarder has its own retry queue (`retry_queues[i]: VecDeque<Vec<u8>>`). If Pulsar fails but
the file forwarder succeeds, only the Pulsar queue accumulates messages. Housekeeping ticks drain
each queue independently, maximising data delivery without cross-contaminating forwarder state.

### 3. Feature-gated Pulsar dependency

The `pulsar` Cargo feature (default-enabled for the CLI, disabled for the Tauri crate) gates:
- The `pulsar` optional dependency itself.
- `ClientError::Pulsar` error variant.
- `PulsarForwarder` module.
- `#[cfg(feature = "pulsar")]` match arms in `is_recoverable()` / `should_retry()`.

This keeps the dependency footprint minimal for embedders that don't need Pulsar.

### 4. `async-trait` for dyn-compatible async trait

Native async trait support (`async fn` in traits, stabilised in Rust 1.75) does not yet support
`dyn` dispatch without boxing. The `async-trait` crate provides the `#[async_trait]` macro which
desugars each `async fn` to `fn -> Pin<Box<dyn Future>>`, making `Box<dyn MessageForwarder>` work.

### 5. Static `connect_socket` avoids `Sync` requirement

`ADSBFeedClient` is moved into `tokio::spawn`. The borrow checker requires the type to be `Send`
but not `Sync`. `dyn MessageForwarder` is `Send` but not `Sync` (e.g., `mpsc::UnboundedReceiver`
inside `PulsarForwarder`). To avoid requiring `Sync`, `connect_socket` is implemented as a static
method taking `config: &Config` rather than borrowing `&self` across an `.await` point.

### 6. Heartbeat-aware connection monitoring

The core client includes a `ConnectionMonitor` that performs lightweight byte-level pattern matching
to detect dump1090 heartbeat messages (hex_ident `000000`, sent every ~60 seconds). This enables
three-tier idle detection without full SBS parsing:

- **TCP-level**: Raw socket read timeout (`socket_read_timeout_secs`, default 75s) catches fully
  dead connections where `stream.read()` blocks.
- **Heartbeat-level**: `ConnectionMonitor` tracks the time since the last heartbeat or data message.
  If `heartbeat_timeout_secs` (default 90s = 1.5x the 60s heartbeat interval) elapses with no
  heartbeat or data, the connection is declared stale and reconnection is triggered. Checked every
  1 second in the housekeeping tick.
- **UI-level** (desktop app only): Socket watchdog task emits Degraded/ConnectionLost status events
  based on elapsed time since the last parsed message.

The heartbeat pattern (default `,000000,`) is matched via byte-level `windows()` scan — no CSV
parsing or field splitting. All lines (including heartbeats) continue to be forwarded to backends
and the message tap; the monitor only classifies them for health tracking.

### 7. Exponential backoff for reconnection

`run_client_mode()` uses exponential backoff between reconnection attempts: starting at
`initial_retry_delay_secs` (default 1s), doubling each attempt, capped at `max_retry_delay_secs`
(default 60s). Backoff resets to the initial delay on successful connection. This prevents
rapid-fire retries during extended outages while recovering quickly from brief glitches.

### 8. Message tap via `broadcast::channel`

`ADSBFeedClient::with_message_tap(capacity)` returns a `broadcast::Receiver<Vec<u8>>`. The sender
is stored in the client; every forwarded message is also sent to the broadcast channel on a
fire-and-forget basis (`let _ = tx.send(…)`). Lag / slow consumers cause their own dropped messages
without blocking the forwarding hot path.

---

## Module Map

```
src/
├── lib.rs                    Re-exports all public types
├── client.rs                 ADSBFeedClient — event loop, fan-out, retry
├── config.rs                 Config, ConnectionMode, ForwarderKind
├── connection_monitor.rs     ConnectionMonitor — heartbeat-aware idle detection
├── error.rs                  ClientError, Result
├── metrics.rs                Metrics (lock-free atomics), MetricsSnapshot
├── source/
│   ├── mod.rs                MessageSource trait + SourceStatus + split_lines
│   ├── socket_source.rs      SocketSource (wraps ADSBFeedClient)
│   └── mqtt_source.rs        MqttSource (cfg(feature = "mqtt"))
└── forwarder/
    ├── mod.rs                MessageForwarder trait + NoopForwarder
    ├── file.rs               FileForwarder (BufWriter, append mode)
    ├── mqtt_forwarder.rs     MqttForwarder (cfg(feature = "mqtt"))
    └── pulsar_forwarder.rs   PulsarForwarder (cfg(feature = "pulsar"))
```

---

## Interface Reference

### `MessageForwarder` trait

```rust
#[async_trait::async_trait]
pub trait MessageForwarder: Send {
    /// Establish connection to the backend.
    /// Called once by ADSBFeedClient::run() before the event loop starts.
    async fn connect(&mut self) -> Result<()>;

    /// Send a single raw SBS-1 message (without trailing newline).
    /// Implementations may buffer internally; call flush() to force delivery.
    async fn send(&mut self, message: &[u8]) -> Result<()>;

    /// Flush any buffered messages to the backend.
    /// Called periodically by the housekeeping tick (every 500 ms by default).
    async fn flush(&mut self) -> Result<()>;

    /// Gracefully close the connection.
    /// Called during shutdown; should flush before closing.
    async fn disconnect(&mut self) -> Result<()>;

    /// Whether the forwarder currently has an active connection.
    /// Used by the client to decide whether to enqueue for retry.
    fn is_connected(&self) -> bool;

    /// Human-readable backend name (e.g., "pulsar", "file", "noop").
    /// Logged at startup and used in error messages.
    fn name(&self) -> &str;
}
```

**Contract:**
- `send()` is called only when `is_connected()` returns `true`.
- On `send()` error the client calls `disconnect()` and enqueues the message for retry.
- `flush()` is only called when `is_connected()` returns `true`.
- `connect()` failure propagates to `run()` and aborts startup (non-recoverable path).

---

### `ADSBFeedClient`

```rust
pub struct ADSBFeedClient { /* private */ }

impl ADSBFeedClient {
    /// Create a new client.
    /// `forwarders` may be empty (useful in test_mode).
    pub fn new(config: Config, forwarders: Vec<Box<dyn MessageForwarder>>) -> Result<Self>;

    /// Attach a broadcast tap; returns the receiver end.
    /// Every message forwarded also goes to this channel (fire-and-forget).
    pub fn with_message_tap(&mut self, capacity: usize) -> broadcast::Receiver<Vec<u8>>;

    /// Shared metrics handle (lock-free reads).
    pub fn metrics(&self) -> Metrics;

    /// Run the client until shutdown or unrecoverable error.
    /// Connects all forwarders then enters the receive-and-forward loop.
    pub async fn run(&mut self) -> Result<()>;

    /// Send a graceful shutdown signal (safe to call from another task).
    pub fn shutdown(&self);
}
```

---

### `Config`

Key fields relevant to multi-forwarder operation:

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `forwarders` | `Vec<ForwarderKind>` | `[Pulsar]` | Ordered list of active backends (`Pulsar`, `Mqtt`, `File`, `Noop`) |
| `file_path` | `String` | `adsb_messages_<timestamp>.sbs` | Output path for `FileForwarder` |
| `pulsar_broker` | `String` | `pulsar://localhost:6650` | Pulsar broker URL |
| `pulsar_topic` | `String` | `persistent://kradsb/adsb/sbs-topic` | Pulsar topic |
| `test_mode` | `bool` | `false` | Skip all forwarder I/O (count-only) |
| `connection_mode` | `ConnectionMode` | `Client` | TCP client or server |
| `dump1090_tz` | `String` | `"Local"` | IANA timezone for interpreting SBS-1 timestamps (`"Local"`, `"UTC"`, or IANA name e.g. `"Europe/Paris"`) |
| `heartbeat_timeout_secs` | `u64` | `90` | Stale connection timeout; 0 disables. Triggers reconnect if no heartbeat/data arrives within this period |
| `heartbeat_pattern` | `String` | `",000000,"` | Byte pattern identifying heartbeat lines from dump1090; empty string disables pattern matching |

`ForwarderKind` enum: `Pulsar`, `File`, `Noop`.

---

### `ForwarderKind`

```rust
pub enum ForwarderKind { Pulsar, File, Noop }
```

Implements `Default` (→ `Pulsar`), `Display`, `FromStr`, `Serialize`, `Deserialize`.

---

### `ClientError`

```rust
pub enum ClientError {
    Socket(#[from] std::io::Error),          // Recoverable
    #[cfg(feature = "pulsar")]
    Pulsar(#[from] pulsar::Error),            // Recoverable
    Forwarder(String),                        // Recoverable — generic backend error
    Config(String),                           // Fatal
    BufferOverflow { current, limit },        // Fatal
    RetryQueueFull(usize),                    // Retriable
    Shutdown,                                 // Sentinel — not an error
    Other(String),                            // Fatal
}
```

Use `.is_recoverable()` to decide whether to reconnect, `.should_retry()` for retry-queue logic.

---

### `Metrics` / `MetricsSnapshot`

```rust
pub struct Metrics { /* Arc<AtomicU64> counters — Clone is cheap */ }

impl Metrics {
    pub fn messages_sent(&self) -> u64;       // Messages forwarded to backends
    pub fn messages_received(&self) -> u64;   // All TCP lines (including heartbeats)
    pub fn errors(&self) -> u64;
    pub fn bytes_sent(&self) -> u64;
    pub fn bytes_received(&self) -> u64;
    pub fn reconnection_attempts(&self) -> u64;
    pub fn snapshot(&self) -> MetricsSnapshot;
}
```

All reads use `Ordering::Relaxed`; safe to poll from any thread without coordination.

---

## Built-in Implementations

### `NoopForwarder`

Always connected, all operations succeed immediately. Used by:
- `test_mode` invocations (no actual I/O wanted).
- Tauri desktop app (uses the message-tap channel instead of forwarder output).

### `FileForwarder`

Appends one raw SBS-1 line per message to a file. Uses `tokio::io::BufWriter` for efficient
batched I/O; the buffer is flushed by the client's housekeeping tick every ~500 ms and on
`disconnect()`.

Configuration: set `--forwarder file --file-path <path>` or populate `Config { forwarders: vec![ForwarderKind::File], file_path: "...".into(), .. }`.

### `MqttForwarder` (`feature = "mqtt"`)

Publishes each raw SBS-1 line to an MQTT topic. This is the lightweight LAN transport that
lets `adsb-data-server` and the desktop app consume the feed **without an Apache Pulsar
broker** — selecting only `--forwarder mqtt` yields a no-Pulsar deployment. Pulsar remains
available as an additional fan-out leg for the Spark/Delta analytics path.

`rumqttc` only makes progress while its event loop is polled, and the loop is also the only
place connection state is observable, so `connect()` spawns a task that owns the event loop
for the life of the forwarder and reports transitions through an `AtomicBool` read by
`is_connected()`. Reconnection and its backoff are handled by `rumqttc` itself, unlike
`PulsarForwarder`, which hand-rolls a reconnect task.

**Loss posture.** QoS defaults to 0 and `send()` uses `try_publish` (non-blocking). The
client fans out to each forwarder in sequence, so a slow or wedged broker must never stall
the socket read loop or the Pulsar leg; a full outbound queue surfaces as a send error —
accounted for by the per-forwarder retry queue — rather than being awaited.

Configuration: `--forwarder mqtt --mqtt-broker <host> --mqtt-topic <topic>`, or populate
`Config { forwarders: vec![ForwarderKind::Mqtt], mqtt_broker: "...".into(), .. }`. The MQTT
client id defaults to `source_id`; it must be unique per node, since brokers evict an
existing session when a second client connects with the same id.

Building with `--no-default-features --features cli,mqtt` drops the `pulsar` crate and with
it the `protoc` build requirement — the main friction when cross-compiling for a Pi.

### `PulsarForwarder` (`feature = "pulsar"`)

Wraps a `pulsar::Producer`. Maintains a background reconnect task via `mpsc::unbounded_channel`;
`poll_reconnect()` is called non-blockingly on each `send()` and housekeeping tick so the main
loop is never blocked waiting for Pulsar reconnection.

---

## Implementing a Custom Forwarder

```rust
use adsb_pulsar_client::forwarder::MessageForwarder;
use adsb_pulsar_client::error::Result;

pub struct MyForwarder { /* your state */ }

#[async_trait::async_trait]
impl MessageForwarder for MyForwarder {
    async fn connect(&mut self) -> Result<()> {
        // open connection, return Err on failure
        Ok(())
    }

    async fn send(&mut self, message: &[u8]) -> Result<()> {
        // deliver message; Err triggers retry-queue + disconnect
        Ok(())
    }

    async fn flush(&mut self) -> Result<()> { Ok(()) }

    async fn disconnect(&mut self) -> Result<()> { Ok(()) }

    fn is_connected(&self) -> bool { true }

    fn name(&self) -> &str { "my-forwarder" }
}

// Wire it up:
let forwarders: Vec<Box<dyn MessageForwarder>> = vec![Box::new(MyForwarder { .. })];
let mut client = ADSBFeedClient::new(config, forwarders)?;
client.run().await?;
```

---

## Data Flow (detailed)

```
TcpStream (async read)
    │
    ├──► ConnectionMonitor.record_tcp_activity()
    │
    ▼
LineBuffer (BytesMut)          ← process_buffer() extracts complete \n-terminated lines
    │
    ▼ Vec<u8> (raw SBS-1 line, newline stripped)
    │
    ├──► ConnectionMonitor.classify_line()  ← Heartbeat vs Data (pattern match)
    ├──► Metrics.inc_messages_received()    ← count all lines
    ├──► broadcast::Sender                  ← fire-and-forget message tap (optional)
    │
    └──► for each forwarder i:
           if forwarders[i].is_connected():
               forwarders[i].send(&message)
               ├── Ok  → inc metrics
               └── Err → enqueue retry_queues[i], disconnect forwarder i
           else:
               enqueue retry_queues[i]

Housekeeping tick (1s):
    for each forwarder i:
        if forwarders[i].is_connected():
            drain up to 500 messages from retry_queues[i]
            forwarders[i].flush()
    ConnectionMonitor.is_stale()? → force reconnect

Stats tick (10s):
    log MetricsSnapshot + time since last heartbeat/data
```

---

## Feature Flags

| Feature | Default | Effect |
|---------|---------|--------|
| `cli` | yes | Enables `clap` derive on `Config`; gates the binary entry point |
| `pulsar` | yes | Enables `pulsar` crate dependency, `PulsarForwarder`, `ClientError::Pulsar` |

Tauri crate: `default-features = false` → neither feature active; `NoopForwarder` + `FileForwarder` only.


---

## Message sources (input side)

`MessageSource` is the mirror of `MessageForwarder`: a forwarder decides where raw SBS-1
lines **go**, a source decides where they **come from**. Both ends of the crate trade in the
same currency — a `broadcast::Receiver<Vec<u8>>` of raw SBS-1 lines, the shape
`ADSBFeedClient::with_message_tap` already produces — so a consumer works unchanged
regardless of which source feeds it.

```
                 ┌──────────────────────────────┐
dump1090 TCP ───►│ SocketSource                 │──┐
                 │  wraps ADSBFeedClient        │  │   broadcast::Receiver<Vec<u8>>
                 └──────────────────────────────┘  ├──►  raw SBS-1 lines
                 ┌──────────────────────────────┐  │     desktop app, adsb-data-server
MQTT topic ─────►│ MqttSource                   │──┘
                 └──────────────────────────────┘
```

| Item | Purpose |
|------|---------|
| `MessageSource` | `subscribe(capacity)`, `status()`, `run()`, `shutdown()`, `name()` |
| `SourceStatus` | `Disconnected` / `Connecting` / `Connected` — transport state only |
| `split_lines(payload)` | Splits a received payload into individual lines, normalising CRLF and dropping blanks |
| `LivenessPolicy` | Degraded/lost thresholds appropriate to the source, plus `resolve()` |
| `Liveness` | `Connecting` / `Healthy` / `Degraded` / `Lost` — the consumer-facing verdict |

### Why liveness is a policy, not a constant

The two sources have **no comparable timeout**. `SocketSource` has a TCP read
timeout, and the desktop watchdog has always derived `read_timeout + 10s / +30s`
from it. `MqttSource` has no such thing — reusing those numbers produces a
connection indicator that is confidently wrong. What an MQTT subscriber *does*
have is dump1090's 60s heartbeat relayed through the feed client, so silence is
measured against that: `heartbeat x 1.5` to degrade, `x 3` to declare lost.

`resolve()` also lets transport state win over the timers: a broker that has
dropped us is `Lost` even if a message arrived a moment ago, because the timers
describe the *feed* while the transport describes the *connection*.

### Why `MqttSource` matters

It lets a consumer read a live feed produced by a **different process** — typically the feed
client on a Raspberry Pi — with no Apache Pulsar in the picture. This is the input half of
the no-Pulsar deployment; `MqttForwarder` is the output half.

### Design notes

- **`SourceStatus` is deliberately coarse.** A source reports only what it can observe about
  its transport. Activity-based degradation ("no messages for N seconds") is layered on top
  by the consumer, because that threshold is a UI policy, not a transport fact — and it is
  derived differently for a TCP socket than for a broker subscription.
- **`MqttSource` subscribes on every `ConnAck`**, not once before the poll loop. `rumqttc`
  reconnects transparently, but the broker has forgotten the subscription; subscribing only
  at startup yields a source that silently stops delivering after the first reconnect.
- **The subscriber client id is suffixed `-sub`.** A source and a forwarder built from the
  same `Config` would otherwise collide, and brokers evict an existing session when a second
  client connects with the same id.
- **Delivery is fire-and-forget.** With no subscribers, or a lagging one, dropping is correct:
  this is a live feed, not a queue. Durability is the recorder's job.

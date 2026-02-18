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

### 6. Message tap via `broadcast::channel`

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
├── error.rs                  ClientError, Result
├── metrics.rs                Metrics (lock-free atomics), MetricsSnapshot
└── forwarder/
    ├── mod.rs                MessageForwarder trait + NoopForwarder
    ├── file.rs               FileForwarder (BufWriter, append mode)
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
| `forwarders` | `Vec<ForwarderKind>` | `[Pulsar]` | Ordered list of active backends |
| `file_path` | `String` | `adsb_messages_<timestamp>.sbs` | Output path for `FileForwarder` |
| `pulsar_broker` | `String` | `pulsar://localhost:6650` | Pulsar broker URL |
| `pulsar_topic` | `String` | `persistent://kradsb/adsb/sbs-topic` | Pulsar topic |
| `test_mode` | `bool` | `false` | Skip all forwarder I/O (count-only) |
| `connection_mode` | `ConnectionMode` | `Client` | TCP client or server |

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
    pub fn messages_sent(&self) -> u64;
    pub fn messages_failed(&self) -> u64;
    pub fn bytes_sent(&self) -> u64;
    pub fn bytes_received(&self) -> u64;
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
    ▼
LineBuffer (BytesMut)          ← process_buffer() extracts complete \n-terminated lines
    │
    ▼ Vec<u8> (raw SBS-1 line, newline stripped)
    │
    ├──► broadcast::Sender     ← fire-and-forget message tap (optional)
    │
    └──► for each forwarder i:
           if forwarders[i].is_connected():
               forwarders[i].send(&message)
               ├── Ok  → inc metrics
               └── Err → enqueue retry_queues[i], disconnect forwarder i
           else:
               enqueue retry_queues[i]

Housekeeping tick (500 ms):
    for each forwarder i:
        if forwarders[i].is_connected():
            drain up to 500 messages from retry_queues[i]
            forwarders[i].flush()
```

---

## Feature Flags

| Feature | Default | Effect |
|---------|---------|--------|
| `cli` | yes | Enables `clap` derive on `Config`; gates the binary entry point |
| `pulsar` | yes | Enables `pulsar` crate dependency, `PulsarForwarder`, `ClientError::Pulsar` |

Tauri crate: `default-features = false` → neither feature active; `NoopForwarder` + `FileForwarder` only.

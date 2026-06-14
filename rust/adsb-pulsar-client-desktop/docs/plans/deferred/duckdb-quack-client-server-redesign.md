# Redesign: `adsb-data-engine` as a DuckDB-native client/server (Quack)

> **Status: DEFERRED.** Design-only blueprint. Do not implement until DuckDB 2.0 / Quack GA.
> Authored June 2026 against DuckDB v1.5.3 (Quack beta).

## Context

Today `adsb-data-engine` is an **embedded** DuckDB library. The Tauri desktop app
(`adsb-pulsar-client-desktop/src-tauri/`) is the *sole owner* of the `.db` file:
`StorageHandle::open()` opens it in-process, `bridge.rs::persist_batch()` writes every
500 ms, and `commands.rs` exposes ~30 query commands. Because embedded DuckDB takes an
exclusive file lock, **no other process can read or write while the app holds it** — the
webapp, spark-adsb, and external tools are all locked out. The Python agent only reaches
the data indirectly through Tauri IPC.

DuckDB shipped a fix for exactly this in **v1.5.3 (May 2026): the "Quack" client/server
protocol** (`CALL quack_serve(...)` on the server, `ATTACH 'quack:host:port'` on clients,
HTTP transport, token auth, full CRUD/DDL/transactions). A server process holds the single
writer lock and serializes concurrent writes from many client processes.

**Goal of this change:** let the Tauri app, Python webapp/agent, spark-adsb, and external
tools all read *and* update the live ADS-B DuckDB directly.

**Decisions made (this is a design to execute later, not now):**
- **Topology: Both modes** — a standalone daemon is the default owner; the Tauri app can
  also self-host the server when running solo.
- **Beta posture: Design only, defer build.** Quack is beta until DuckDB 2.0 (fall 2026)
  and the current `duckdb` crate is pinned at `1.2`. **Do not bump the crate or commit
  runtime code yet.** This document is the blueprint; implementation starts when Quack is
  production-ready (DuckDB 2.0 / `libduckdb-sys ~1.10503+` proven stable).
- **Client scope: all four** — Tauri app, Python webapp/agent, spark-adsb, external/ad-hoc.

## Key facts grounding the design

- `duckdb` Rust crate currently: `duckdb = { version = "1.2", features = ["bundled"] }`
  at `adsb-feed/rust/adsb-data-engine/Cargo.toml:9`. Quack needs the `1.5.3`-based release
  (`libduckdb-sys ~1.10503.1`).
- Storage core: `adsb-data-engine/src/storage.rs` (~2850 lines) — `StorageHandle` wraps
  `Arc<Mutex<Storage>>`, runs `SCHEMA_SQL` on open, maintains an in-memory flight tracker.
  All ops are `*_sync` (blocking) with async wrappers via `tokio::task::spawn_blocking`.
- Tables (DDL in `storage.rs` SCHEMA_SQL): `positions`, `raw_messages`, `flights`,
  `status_events`, `events_of_interest`.
- Consumer: `state.rs` (`SharedStorage = Arc<RwLock<Option<StorageHandle>>>`),
  `bridge.rs::persist_batch()` (writes), `commands.rs` (~30 query commands),
  `tool_service.rs` (non-Arrow query helpers).
- Today **only** the Tauri app touches the DB. webapp/spark are not wired to it at all.

## Target architecture

```
                 adsb-data-engine (server crate / `adsb-data-server` bin)
                   owns ads.db  +  CALL quack_serve('quack:0.0.0.0:9494')
                                     │  (token auth, single writer lock held here)
        ┌──────────────────┬─────────┴────────────┬─────────────────────┐
   Tauri app          Python webapp/agent      spark-adsb           external CLI
 ATTACH 'quack:..'   duckdb.connect()+ATTACH   duckdb/JDBC ATTACH   duckdb -c ATTACH
 (feed writes +       (read + write EOIs)       (read analytics)     (ad-hoc, RO token)
  UI reads)
```

**Both modes** are an **explicit configuration choice** (not runtime auto-fallback — see
constraint 2):
1. **Daemon mode (default):** `adsb-data-server` binary opens the DB and calls
   `quack_serve()`; runs independently of the desktop UI (workstation, or Raspberry Pi).
   The Tauri app and all other services connect as clients via `ATTACH 'quack:<host>'`.
2. **Embedded self-host mode:** the Tauri app opens the DB in-process (as today) *and* calls
   `quack_serve()` on its own connection so other local clients can attach while the app is
   open. Used only when no daemon owns the file.

A remote-mode connection failure surfaces as the existing `None`/degraded state (UI goes
read-only) — it must **never** auto-open the shared file locally.

## Critical design constraints (architect review)

These reshape the refactor and must be resolved *before* coding — they are the difference
between a working shared store and a corrupted one.

1. **Ingestion state must be server-owned, not client-owned.** The in-memory flight tracker
   in `storage.rs` (HashMap rebuilt from `flights`, drives `flight_id` gap detection in
   `insert_batch_sync`) is correct *only for a single writer*. It cannot run in each client.
   **Decision: position ingestion + flight maintenance run only in the daemon.** Clients do
   not write `positions`/`flights` directly; the feed path funnels through the server (the
   server process runs `insert_batch_sync`, or it is exposed as a server-side routine).
   Other clients are read-mostly and may write only `events_of_interest`.
2. **No automatic embedded↔remote fallback (split-brain).** A slow-but-alive daemon plus a
   client that "falls back" to opening the same file = two exclusive-lock owners = corruption.
   **Decision: mode is explicit configuration**, not runtime auto-fallback. Embedded self-host
   may only open a file that no daemon owns. Remote-mode failure surfaces as `None`/degraded
   (UI read-only), never as a local file open of the shared DB.
3. **Server is the sole DDL/schema authority.** Today `StorageHandle::open()` runs `SCHEMA_SQL`
   + flight bootstrap. Split this into a **`bootstrap` path (server only)** and a
   **`connect` path (client: attach + schema-version handshake, no CREATE TABLE)**. Clients
   must never issue DDL against the remote catalog.
4. **Filesystem-coupled commands break in remote mode.** `export_database`, `swap_database`,
   `import_database`, `preview_import`, `move_database_to_snapshot` operate on local
   `.db`/`.wal` files; a remote client has no daemon-filesystem access. **Decision: these
   become server-side operations** (a maintenance command/endpoint on the daemon); in remote
   mode the client either proxies to the daemon or the command is disabled.
5. **Release/reclaim/swap largely retires.** Its purpose is freeing the file lock for other
   tools — moot once the daemon permanently owns the file. Move any still-useful semantics
   (checkpoint, snapshot) server-side; don't port the lock-release dance to clients.
6. **Hot-path write latency.** `bridge.rs::persist_batch()` every 500 ms becomes a network
   round-trip; keep it on bounded async buffering with the existing non-fatal drop semantics
   so the feed relay never backpressures on a slow/absent server.
7. **Authorization is coarse.** The regex `read_only` macro cannot express table-level rules
   (e.g. webapp writes only `events_of_interest`). Treat Quack auth as homelab-grade; for
   real table-level control, gate writes server-side or via the per-user ACL macro, and do
   not present the regex gate as a security boundary.
8. **Fleet protocol-version coupling.** Daemon, Tauri client, and the Python `duckdb` package
   must all run Quack-protocol-compatible versions simultaneously while it is beta — pin and
   roll them together.

## Alternatives considered (recorded for the deferred decision)

- **Minimal stable service API now (bridge option).** The repo already has `tool_server.rs`
  (HTTP-ish tool plane) and Arrow export. A small read API in front of the daemon-owned DB
  gives webapp/spark access *today* without a beta dependency — a low-risk bridge until
  DuckDB 2.0. Trade-off: bespoke API surface vs. native SQL/ATTACH.
- **DuckLake as the strategic target.** DuckDB's own roadmap points at Quack-as-DuckLake-
  catalog (catalog DB + object-storage data) as the durable multi-writer story. If the goal
  is many concurrent writers long-term, DuckLake may be a better destination than point-to-
  point Quack attachments. Revisit at DuckDB 2.0.
- **Chosen path:** Quack client/server (this document), because it directly delivers
  "other services read/update the live DB" with native SQL and minimal client code — accepted
  *only* as a deferred build pending GA.

## Refactor strategy (when build is greenlit)

### 1. Split the crate into engine + server + client
- Keep `adsb-data-engine` as the **schema + SQL + domain types** library (storage.rs,
  types.rs, sbs_parser.rs, geo.rs unchanged). This stays the single source of truth for
  `SCHEMA_SQL` and query SQL so server and embedded paths can't drift.
- Add a thin **server binary** `adsb-data-server` (new `[[bin]]` or sibling crate):
  `StorageHandle::bootstrap(config)` → `conn.execute_batch("CALL quack_serve('quack:0.0.0.0:9494', allow_other_hostname => true)")`
  → print/persist the auth token → run until signalled. Reuse the existing
  `checkpoint`/`prune` maintenance methods on a timer.
- Add a **connection mode** to `StorageConfig` (in `types.rs`):
  `enum Backend { EmbeddedFile(PathBuf), Remote { uri: String, token: Secret } }`.
  Split `StorageHandle::open()` into **`bootstrap()`** (server: open file, run `SCHEMA_SQL`,
  build flight tracker, own ingestion) and **`connect()`** (client: open in-memory DuckDB,
  `ATTACH '<uri>' AS adsb (TOKEN '<token>')`, schema-version handshake, **no DDL**, qualify
  tables as `adsb.*`). The read/query SQL is largely shared; **ingestion + flight-tracking
  stay server-side only** (constraint 1) — do not assume the write path is portable to
  clients.

### 2. Tauri app becomes a client (representative files)
- `src-tauri/src/lib.rs` `init_storage()`: select mode from **explicit config** (remote vs
  embedded self-host), **not** runtime auto-fallback (constraint 2). Remote-mode connection
  failure → `None`/degraded; never silently open the shared file locally. Keep returning the
  same `Arc<RwLock<Option<StorageHandle>>>` so `state.rs`/`commands.rs`/`bridge.rs` read-query
  signatures are unchanged.
- Read commands in `commands.rs`/`tool_service.rs` are mode-agnostic. **Write/maintenance
  commands are not**: position writes (`bridge.rs::persist_batch()`) route to the server's
  ingestion path, and the filesystem-coupled commands (export/import/swap/snapshot) become
  daemon-side operations or are disabled in remote mode (constraints 4–5).
- Add a reconnect path: a dropped remote attachment flips storage to `None` (existing
  degradation), and a watchdog retries `ATTACH` (mirror the `bridge.rs` alive-signal /
  `is_finished()` reconnection patterns already in the codebase).

### 3. Python clients (webapp + agent)
- Use the `duckdb` Python package: `con = duckdb.connect(); con.execute("ATTACH 'quack:HOST:9494' AS adsb (TOKEN ?)", [token])`.
- `webapp/services/`: add a `duckdb_query.py` sibling to the existing `delta_query.py` so
  the Dash app can read live positions/flights from Quack for real-time + recent history,
  keeping Delta Lake for deep historical. Respect the webapp's read-only contract for
  position data; only writes allowed from the webapp are user **events_of_interest**.
- adsb-agent: replace Tauri-IPC data fetches with direct `ATTACH` queries (optional, later).

### 4. spark-adsb
- Read-only consumer. Either the DuckDB Python package inside a PySpark job, or DuckDB's
  JDBC/ATTACH from a helper. Treat Quack as a live serving layer next to Delta Lake; do
  **not** route the bronze/silver/gold pipeline through it (respect component boundaries
  in the root CLAUDE.md).

### 5. Auth, security, ops

**Token model (from the Quack security docs).** Quack uses a simple **string token**, and
by default it is a **single shared token per server**, not per-client:
- `quack_serve()` auto-generates a random token at startup and returns it in the
  `auth_token` column, or you set it explicitly (min 4 chars):
  `CALL quack_serve('quack:0.0.0.0:9494', allow_other_hostname => true, token => '<token>');`
- Clients present it on every connection, either inline —
  `ATTACH 'quack:HOST:9494' AS adsb (TOKEN '<token>');` — or via a stored `quack` secret
  scoped to the server URI (preferred so the token isn't in query text/logs).
- Auth and authorization are **pluggable SQL macros** set globally on the server. This is
  how we get per-client and read-only behavior despite the default single token.

**Our chosen scheme (multi-token + read-only ACL).** At daemon startup, after `quack_serve`,
install macros so each client class gets its own token and rights:
```sql
-- one row per client class; tokens generated by us, not the default single token
CREATE TABLE quack_tokens (auth_token VARCHAR, user_name VARCHAR);
INSERT INTO quack_tokens VALUES
  ('<tauri-rw>',   'tauri'),     -- read + write (feed + EOIs)
  ('<webapp-rw>',  'webapp'),    -- read + write (EOIs only, enforced below)
  ('<spark-ro>',   'spark'),     -- read only
  ('<external-ro>','external');  -- read only

CREATE MACRO check_token(sid, client_token, server_token) AS (
  EXISTS (SELECT 1 FROM quack_tokens WHERE auth_token = client_token));
SET GLOBAL quack_authentication_function = 'check_token';

-- read-only gate for spark/external; tauri/webapp omitted from the restriction
CREATE MACRO read_only(sid, query) AS
  regexp_matches(upper(trim(query)), '^(SELECT|FROM|WITH|EXPLAIN|DESCRIBE|SHOW)\b');
SET GLOBAL quack_authorization_function = 'read_only';  -- start simple; per-user ACL later
```
For finer control (e.g. webapp may write `events_of_interest` but not `positions`), upgrade
to the per-user ACL pattern: a `quack_sessions(sid, user_name)` table populated by the auth
macro joined against a `quack_user_acls(user_name, query_kind)` allowlist in the
authorization macro.

**Generation & distribution process.**
1. Daemon generates four random tokens at first run (e.g. 32-char base62), writes them to a
   root-only secret file (`~/.config/adsb/quack_tokens.toml`) and inserts them into
   `quack_tokens`. Idempotent on restart (reuse existing file).
2. Each client gets *only its* token via that client's existing config mechanism — Tauri:
   app config/secret store; webapp: env var / `config.py`; spark: job env; external: handed
   out manually. Clients store it as a `quack` secret, not inline, where possible.
3. Rotation = update the row in `quack_tokens` + redistribute that one client's token; other
   clients are unaffected (another benefit of multi-token over the single shared default).

**Network/TLS.** Quack itself has **no TLS** and binds `localhost` only by default;
`allow_other_hostname => true` is required for remote bind. For anything beyond local dev,
**do not expose Quack directly** — front it with a proven HTTP reverse proxy terminating
TLS (per the Quack reverse-proxy guide). Default to `localhost` in dev.

**Deployment.** Two supported targets for the daemon:
- **Workstation/analytics box (default, recommended).** Keeps the Pi a thin Pulsar feed per
  the root-CLAUDE.md edge/analytics split. Tokens never live on the Pi.
- **On the Raspberry Pi (supported, opt-in).** Feasible on a **64-bit Pi (Pi 4/5, `aarch64`,
  64-bit Raspberry Pi OS)** — AArch64 is an officially supported DuckDB arch and the Quack
  core extension ships for it. Requirements/caveats: DuckDB needs **≥125 MB RAM per thread**
  (run 1–2 threads on the Pi; the 500 ms batched writes stay well within this); **32-bit
  `armv7`/Pi Zero are not supported** (would need an unsupported source build); and the
  `bundled` DuckDB compile is heavy — **cross-compile from the workstation or build in an
  `aarch64` Docker image**, don't compile on the Pi. Trade-off: co-locates storage at the
  edge, so webapp/spark/external clients reach back to the Pi over the LAN, diverging from
  the decoupled-architecture principle. Reasonable for a single-Pi home setup; avoid for
  the multi-Pi production topology.

## Crate/version changes (deferred until greenlit)
- `adsb-data-engine/Cargo.toml`: bump `duckdb` from `"1.2"` to the `1.5.3`-aligned release
  (verify `quack_serve`/`quack_query` autoload in the **bundled** build; if the core
  extension isn't statically present, document the autoload/network requirement).
- Pin exactly (`=`) while Quack is beta to avoid protocol drift; add a CHANGELOG note.

## Verification (when implemented)
1. Start `adsb-data-server`; confirm it prints a listen URI + token and holds `ads.db`.
2. From a second `duckdb` CLI: `ATTACH 'quack:localhost:9494' AS adsb (TOKEN '…')`,
   `SELECT count(*) FROM adsb.positions`, then an `INSERT` into `events_of_interest` —
   confirm a concurrent reader sees it (multi-writer proof).
3. Run the Tauri app in **remote mode** (explicit config): feed writes route through the
   daemon's server-side ingestion; flight_id assignment stays correct with the app + a second
   writer both connected (flight-tracker single-owner proof). Kill the daemon → app flips to
   `None`/degraded (it must **not** open the shared file) → restart daemon → watchdog re-attaches.
4. Run the Tauri app in **embedded self-host mode** (explicit config, no daemon): it owns the
   file and `quack_serve()` exposes it; a Python client attaches while the app is open.
   Confirm a daemon cannot also be started against the same file (split-brain guard).
4b. Verify filesystem-coupled commands (export/import/swap/snapshot) work server-side and are
   correctly disabled/proxied in remote mode (constraints 4–5).
5. Rust gate: `cargo test --workspace && cargo clippy --workspace -- -D warnings && cargo fmt --all --check`
   (add an integration test that boots a server, attaches a client, round-trips a write).
6. Python: webapp `duckdb_query.py` reads live positions and renders on the Dash map.

## Out of scope / risks
- Quack protocol/function-name breaking changes until DuckDB 2.0 — the reason build is
  deferred. Re-validate `quack_serve`/`ATTACH` syntax against the GA docs before coding.
- Throughput: DuckDB caps concurrent single-table insert rate (~5.4k tx/s in DuckDB's
  benchmark); the 500 ms batched-write design already stays well under this.
- Do not migrate the spark medallion pipeline onto Quack; keep Pulsar→Spark→Delta intact.

## References
- [Quack: The DuckDB Client-Server Protocol](https://duckdb.org/2026/05/12/quack-remote-protocol)
- [Quack Remote Protocol — Overview](https://duckdb.org/docs/current/quack/overview)
- [Quack — Security (auth/authorization macros)](https://duckdb.org/docs/current/quack/security)
- [Securing Quack with a Reverse Proxy](https://duckdb.org/docs/current/quack/setup/reverse_proxy)
- [DuckDB 1.5.3 release notes](https://duckdb.org/2026/05/20/announcing-duckdb-153)

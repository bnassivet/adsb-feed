# Redesign: `adsb-data-engine` as a DuckDB-native client/server (Quack)

> **Status: LARGELY IMPLEMENTED 2026-08-28 (was PARTIALLY, 2026-08-25).**
>
> The standalone daemon and the client/server split have since been **built**, on
> beta, as a deliberate decision — see the Raspberry Pi deployment work
> (`adsb-data-server`, `StorageConfig::remote`). What landed, and how it differs
> from the blueprint below:
>
> - **`adsb-data-server` exists** as its own crate: MQTT ingest -> DuckDB, Quack
>   sharing, read-only HTTP query API. It is the "daemon mode" of this document.
> - **`Backend::Remote` landed in a simpler shape than §5 anticipated.** Rather
>   than routing queries per table, remote mode attaches the daemon's catalog and
>   shadows the four observed table names with views. Every existing query then
>   works unmodified. There is no client/server rewrite of the query layer.
> - **Constraints 1 and 3 are satisfied by construction, not by re-architecture**,
>   because the daemon is the sole writer: ingest and flight tracking simply do
>   not run on a client. Quack enforces this for us -- `bootstrap_flights_sync`
>   against an attached catalog fails with "Multiple streaming scans or streaming
>   scans + CTAS / insert in the same query are not currently supported", so it is
>   skipped in remote mode.
> - **Constraint 2 holds**: mode is explicit configuration (`ADSB_REMOTE_URI`),
>   never a runtime fallback. Remote mode also uses a *separate* local file, so a
>   client can never open the embedded database by accident.
> - **Constraint 4/5 (filesystem-coupled commands) are NOT addressed.** Export,
>   import, swap and snapshot still assume a local file and are untested in remote
>   mode.
> - **Constraint 7 is sidestepped rather than solved**: the desktop never writes
>   to the remote, so the token's read+write scope stays a deployment note.
>
> Greenlight checklist items now answered empirically:
> - **`quack` publishes for `linux_arm64`** and autoinstalls there -- verified by
>   running `adsb-data-server --share` in an aarch64 container.
> - **The `bundled` build still cannot statically link it** (constraint 9 stands);
>   the autoinstall path was accepted and is documented, including the systemd
>   unit setting `HOME` so the extension directory is writable.
>
> Still deferred: DuckLake re-evaluation, the multi-token ACL scheme, and
> re-validating the Quack surface once DuckDB 2.0 ships.

<details>
<summary>Original 2026-08-25 status note</summary>

> **Status: PARTIALLY IMPLEMENTED 2026-08-25 — the rest remains DEFERRED.**
> The **embedded self-host mode** of this design has been built and shipped: `adsb-data-engine`
> now calls `quack_serve()` on the database it already owns, so other DuckDB clients can
> `ATTACH` to it. See `share.rs`, `StorageHandle::{start,stop}_sharing` / `sharing_status`,
> and the metrics-bar toggle.
>
> What was built is *only* that. The **client/server re-architecture in this document — the
> Tauri app becoming a remote client, a standalone daemon, `Backend::Remote`, the multi-token
> ACL scheme — is NOT built and stays deferred.** The engine remains the sole owner and sole
> writer, which is why the shipped slice needed none of it: constraints 1–3 are satisfied by
> construction rather than by re-architecture.
>
> Two findings from building it, corrected against this document:
> - **We were never on DuckDB 1.2.** `duckdb = "1.2"` was a caret requirement resolving to
>   **1.4.4**. Now pinned exactly at `=1.10505.0` (DuckDB v1.5.5).
> - **`arrow` is coupled to duckdb's major** (56 → 58 was required). Not anticipated here.
>
> Verified empirically rather than from the docs, which do not specify it: `quack_serve`
> returns exactly `(listen_uri, listen_url, auth_token)`, and `INSTALL quack` succeeds from
> the bundled build (autoinstalled, so it needs network on first use).

</details>

> **Reevaluated 2026-08-23** against DuckDB 1.5.5 / `duckdb-rs` 1.10505.0.
> Quack is still beta; the gate remains DuckDB 2.0, **now scheduled September 2026**.
> Design-only blueprint **for the remaining, still-deferred scope** — do not build the
> client/server split until DuckDB 2.0 / Quack GA. (The self-host slice above was shipped
> knowingly on beta because it is small, opt-in, and nothing depends on it.)
> Originally authored June 2026 against DuckDB v1.5.3 (Quack beta).

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

## Reevaluation log

Append a row per review. The design itself has not needed revision; only its version
facts and build assumptions.

| Reviewed | DuckDB stable | `duckdb` crate | Quack status | GA target | Verdict |
|---|---|---|---|---|---|
| 2026-06 (authored) | 1.5.3 | `1.10503.1` | beta | "fall 2026" | Defer |
| **2026-08-23** | **1.5.5** (2026-07-22) | **`1.10505.0`** / `libduckdb-sys =1.10505.0` (2026-07-22) | **still beta** | **September 2026** | **Defer — re-gate on the 2.0 release, not a date** |

Evidence behind the 2026-08-23 verdict:
- The Quack FAQ and extension page still say breaking changes are expected in "the
  protocol, function names and default settings".
- Neither the 1.5.4 nor the 1.5.5 announcement mentions Quack at all — no stabilization
  signal, and 1.5.5 only says "v2.0.0 in the fall".
- `duckdb/duckdb-quack` was still reworking core plumbing on **2026-08-20** — connection
  leases, statement-vs-connection locking, the result cache, fetch read-ahead.
- **New:** the `bundled` build cannot statically link Quack (constraint 9 below). This was
  an open "verify" item in the June draft; it now has a concrete, blocking answer.

**Documentation re-verification (2026-08-23).** The Quack docs were read in full, not
summarised. Three corrections to this document came out of it:
1. The **"no TLS" claim was right** and an earlier edit wrongly softened it — the Security
   page states the server does not use TLS itself. Restored, with the client-side
   `DISABLE_SSL` default (HTTPS for remote URIs) documented alongside it.
2. The **per-user ACL upgrade path in §5 is impossible as written** — SQL macros cannot
   execute DML, so the auth macro cannot populate a `quack_sessions` table. Table-level
   authorization requires shipping a custom DuckDB extension. Corrected in place.
3. **DuckDB now recommends DuckLake + PostgreSQL** as *the* stable multi-process-write
   solution, with Quack presented as the beta option. See Alternatives.
Plus a substantial API surface that did not exist in the announcement — see
*Documented API surface* below. The docs still describe the v1.5.3 beta and were not
updated for 1.5.4/1.5.5; `quack/troubleshooting` states plainly that Quack "is not ready
for production and is subject to breaking changes until the release of DuckDB v2.0".

## Key facts grounding the design

- `duckdb` Rust crate currently: `duckdb = { version = "1.2", features = ["bundled"] }`
  at `adsb-feed/rust/adsb-data-engine/Cargo.toml:9`. Quack needs at minimum the `1.5.3`-based
  release; the **latest published is `duckdb 1.10505.0` / `libduckdb-sys =1.10505.0`**
  (2026-07-22, tracking DuckDB 1.5.5). The eventual target is whatever release tracks
  DuckDB 2.0 — see *Crate/version changes* and constraint 9.
- Storage core: `adsb-data-engine/src/storage.rs` (~2850 lines) — `StorageHandle` wraps
  `Arc<Mutex<Storage>>`, runs `SCHEMA_SQL` on open, maintains an in-memory flight tracker.
  All ops are `*_sync` (blocking) with async wrappers via `tokio::task::spawn_blocking`.
- Tables (DDL in `storage.rs` SCHEMA_SQL): `positions`, `raw_messages`, `flights`,
  `status_events`, `events_of_interest`.
- Consumer: `state.rs` (`SharedStorage = Arc<RwLock<Option<StorageHandle>>>`),
  `bridge.rs::persist_batch()` (writes), `commands.rs` (~30 query commands),
  `tool_service.rs` (non-Arrow query helpers).
- Today **only** the Tauri app touches the DB. webapp/spark are not wired to it at all.

## Documented API surface (re-verified 2026-08-23)

The docs grew a full section since the announcement — `quack/overview`, `quack/reference`,
`quack/security`, `quack/setup/{overview,deployment,reverse_proxy,quack_wasm}` and
`quack/troubleshooting`. They still describe the **v1.5.3 beta** (the `whoami()` example
prints `v1.5.3`, and `connect/concurrency` even says "beta as of v1.5.2"), so the docs are
not internally consistent on versions and carry no 1.5.4/1.5.5 updates — but the API is now
specified in far more detail than this design assumed. Items below were **not** in the
original blueprint and should be used when it is built:

| Feature | Why it matters here |
|---|---|
| `quack_query(uri, query, token := …, disable_ssl := …)` | **Stateless** remote query, no `ATTACH` needed. The right client shape for **spark-adsb and external/ad-hoc readers** — no catalog attachment, no session to keep alive. |
| `ATTACH` vs `quack_query` | `ATTACH` is a **sticky session**: temp tables and `SET` values persist server-side across calls; `quack_query` does not. The Tauri app wants `ATTACH`; the read-only clients do not. |
| `whoami()` + `quack_identify(name, provider, hostname, region, meta)` | Returns node identity plus `duckdb_version` and `platform`. This **is** the version handshake constraints 3 and 8 asked for — use it instead of hand-rolling one, and use `quack_identify` to label the daemon (e.g. `name => 'adsb-daemon'`). |
| `CREATE SECRET (TYPE quack, TOKEN …, SCOPE 'quack:host')` then `ATTACH … (TYPE quack)` | The exact syntax for the "store the token as a secret, not inline" rule in §5. |
| `quack_stop(uri)` | Clean server shutdown — needed for daemon lifecycle and for tearing down embedded self-host mode. |
| `quack_uri_parser(uri, ssl)` | Validate/parse a configured URI into `STRUCT(host, port, ipv6, ssl, url)` — use it when parsing `Backend::Remote { uri }` config. |
| `quack_query_by_name(catalog, query)` | Ad-hoc SQL against an already-attached catalog (backs `remote_db.query(...)`). |
| `enable_logging('Quack')` + `duckdb_logs_parsed('Quack')` | Structured per-message log with `duration_ms`, `message_type`, `quack_connection_id`, `client_query_id`. **Use this for the constraint 6 latency measurement** instead of guessing. |
| `quack_fetch_batch_chunks` (default 12) | Server-side FETCH batching knob if result streaming needs tuning. |
| `httpfs_connection_caching` | **Off by default**: every client request otherwise opens a fresh TCP (and TLS) connection. Directly relevant to constraint 6 — the 500 ms `persist_batch()` write path must enable this or pay a handshake per batch. Also confirms Quack rides on **httpfs**. |


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

9. **The `bundled` build cannot statically link Quack** (found 2026-08-23; this was an open
   "verify" item in the June draft). `libduckdb-sys 1.10505.0` statically links only
   `core_functions`, `parquet` and `json` — its `extension_enabled` gate in
   `build_bundled_cc.rs` lists no `quack` feature. The same file *does* set
   `DUCKDB_EXTENSION_AUTOINSTALL_DEFAULT=1` / `AUTOLOAD_DEFAULT=1`, so
   `CALL quack_serve(...)` would **download the extension from extensions.duckdb.org on
   first use**. Consequences:
   - The daemon needs **outbound network on its first run** and a **writable extension
     directory**; a locked-down or air-gapped host must have the extension **pre-seeded**.
   - Extension binaries are tied to the **exact DuckDB build**, so the exact (`=`) crate pin
     stops being hygiene and becomes a correctness requirement — a patch bump invalidates
     the cached extension.
   - The **aarch64 Pi** target needs a per-arch availability check (`linux_arm64` build of
     the `quack` extension published) — see *Deployment → On the Raspberry Pi*.
   - `httpfs_connection_caching` appears in the Quack settings, suggesting Quack rides on
     **httpfs**, which is likewise not in the bundled static set. Verify before coding.
   - Corroborated by DuckDB's own troubleshooting page, whose remedy for Quack problems is
     `FORCE INSTALL quack;` — a downloaded extension, and one all nodes are expected to keep
     upgraded in lockstep (reinforcing constraint 8).
   **Decision: before any implementation, re-check whether the DuckDB-2.0-aligned
   `libduckdb-sys` exposes a static `quack` feature.** If not, choose deliberately between
   accepting the autoinstall path (documented + pre-seeded for the Pi) and linking against
   a system/prebuilt libduckdb instead of `bundled`.

## Alternatives considered (recorded for the deferred decision)

- **Minimal stable service API now (bridge option).** The repo already has `tool_server.rs`
  (HTTP-ish tool plane) and Arrow export. A small read API in front of the daemon-owned DB
  gives webapp/spark access *today* without a beta dependency — a low-risk bridge until
  DuckDB 2.0. Trade-off: bespoke API surface vs. native SQL/ATTACH.
  **Still unchosen as of 2026-08-23, and now for a stronger reason:** with GA roughly a
  month out, a bespoke read API would likely be obsolete before it finished shipping.
- **DuckLake as the strategic target.** DuckDB's own roadmap points at Quack-as-DuckLake-
  catalog (catalog DB + object-storage data) as the durable multi-writer story. If the goal
  is many concurrent writers long-term, DuckLake may be a better destination than point-to-
  point Quack attachments. Revisit at DuckDB 2.0.
  **Update 2026-08-23 — DuckDB's own guidance now says this out loud.** The canonical
  `docs/current/connect/concurrency` page presents multi-process writes as: Quack, "in beta
  stage … expected to become mature by DuckDB v2.0", and then — *"For a stable solution,
  consider using the DuckLake format with PostgreSQL as the catalog database"*, noting the
  DuckLake v1.0 spec and implementation were published in April 2026 and are **intended for
  production use**. So the vendor's recommended answer *today* is DuckLake, not Quack.
  This does not flip the decision — DuckLake means a PostgreSQL catalog plus object storage,
  which is a much heavier operational footprint than one daemon holding one `.db` file, and
  our requirement is "a handful of local services read/update one live DB", not a lakehouse.
  But it must be re-weighed at the greenlight: if Quack slips past 2.0 again, DuckLake is the
  supported fallback rather than a further deferral.
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
SET GLOBAL quack_authorization_function = 'read_only';  -- start simple; see the note below
```
**Both auth settings are global-scoped, and `RESET` is a trap.** The callbacks run on a
fresh transient server-side connection each time, so a plain `SET` is forwarded to the global
slot automatically — but a plain `RESET` only clears the *session* view and the auth path
keeps reading the stale global value. Use `RESET GLOBAL` to restore a default. Default
callback names are `quack_check_token` / `quack_nop_authorization` (the latter allows
everything).
**Finer control needs a native extension, not a macro** *(corrected 2026-08-23 — the
originally sketched upgrade path does not work).* The plan was a `quack_sessions(sid,
user_name)` table **populated by the auth macro**, joined against a per-user ACL in the
authorization macro. The Security page rules this out: a macro body "is restricted to a
single expression and cannot execute DML directly: there is no `INSERT`, `UPDATE`, or
`DELETE` inside a macro". Since `sid → user_name` is only knowable at authentication time
and cannot be recorded from a macro, table-level authorization is unreachable this way.

DuckDB's own answer is to **register a scalar function from a DuckDB extension** (C++, or
any language with C-extension-API bindings — Rust included) with the same
`(VARCHAR, …) → BOOLEAN` signature, then point the setting at it. That is a real project:
shipping and distributing a custom DuckDB extension to every node. **Decision stands from
constraint 7** — treat Quack auth as homelab-grade, enforce the webapp's
`events_of_interest`-only rule *server-side in our own code* rather than in Quack, and only
consider the extension route if genuine table-level enforcement becomes a requirement.

**Generation & distribution process.**
1. Daemon generates four random tokens at first run (e.g. 32-char base62), writes them to a
   root-only secret file (`~/.config/adsb/quack_tokens.toml`) and inserts them into
   `quack_tokens`. Idempotent on restart (reuse existing file).
2. Each client gets *only its* token via that client's existing config mechanism — Tauri:
   app config/secret store; webapp: env var / `config.py`; spark: job env; external: handed
   out manually. Clients store it as a `quack` secret, not inline, where possible.
3. Rotation = update the row in `quack_tokens` + redistribute that one client's token; other
   clients are unaffected (another benefit of multi-token over the single shared default).

**Network/TLS** *(re-verified against the docs 2026-08-23 — the original claim was correct)*.
The Quack **server does not use TLS itself**; the Security page states this outright and
justifies it ("involving TLS for localhost communication only adds dependencies for no real
benefit"). It binds `localhost` only by default; `allow_other_hostname => true` is required
for a remote bind. For anything beyond local dev, **do not expose Quack directly** — front it
with a proven HTTP reverse proxy terminating TLS (per the Quack reverse-proxy guide; DuckDB
ships nginx and Caddy recipes, and an EC2 CloudFormation template using nginx + Let's Encrypt).
Default to `localhost` in dev.

The **client** side is the part that surprises: `DISABLE_SSL` defaults to `true` for local
URIs (`localhost`, `127.0.0.1`, `::1`) and `false` otherwise — i.e. **a client attaching to a
remote daemon assumes HTTPS**. A properly proxied server therefore "just works", but a bare
remote daemon with no proxy requires an explicit `DISABLE_SSL true` on every client. Treat
needing that flag as the signal that the deployment is missing its proxy.

**Deployment.** Two supported targets for the daemon:
- **Workstation/analytics box (default, recommended).** Keeps the Pi a thin Pulsar feed per
  the root-CLAUDE.md edge/analytics split. Tokens never live on the Pi.
- **On the Raspberry Pi (supported, opt-in).** Feasible on a **64-bit Pi (Pi 4/5, `aarch64`,
  64-bit Raspberry Pi OS)** — AArch64 is an officially supported DuckDB arch and the Quack
  core extension ships for it. Requirements/caveats: DuckDB needs **≥125 MB RAM per thread**
  (run 1–2 threads on the Pi; the 500 ms batched writes stay well within this); **32-bit
  `armv7`/Pi Zero are not supported** (would need an unsupported source build); and the
  `bundled` DuckDB compile is heavy — **cross-compile from the workstation or build in an
  `aarch64` Docker image**, don't compile on the Pi. **Also see constraint 9**: the Pi will
  need to *download* the `quack` extension on first run (confirm a `linux_arm64` build is
  published) or have it pre-seeded, since it is not statically linked. Trade-off: co-locates storage at the
  edge, so webapp/spark/external clients reach back to the Pi over the LAN, diverging from
  the decoupled-architecture principle. Reasonable for a single-Pi home setup; avoid for
  the multi-Pi production topology.

## Crate/version changes (deferred until greenlit)
- `adsb-data-engine/Cargo.toml`: bump `duckdb` from `"1.2"` to **the release that tracks
  DuckDB 2.0** (not 1.5.x — by the time this is greenlit, 2.0 is the target). Latest
  published today for reference: `duckdb 1.10505.0` / `libduckdb-sys =1.10505.0`.
- **Pre-flight task (blocking, constraint 9):** confirm whether the 2.0-aligned
  `libduckdb-sys` exposes a static `quack` feature (and `httpfs`, if Quack requires it).
  If it does not, decide explicitly between the **autoinstall path** — outbound network on
  first run, writable extension dir, pre-seeded on the Pi — and **dropping `bundled`** in
  favour of linking a system/prebuilt libduckdb that ships the extension.
- Pin exactly (`=`), not just to avoid protocol drift but because the downloaded extension
  binary is keyed to the exact DuckDB build. Add a CHANGELOG note.

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
  This is not theoretical: as of **2026-08-20** the `duckdb/duckdb-quack` repo was still
  reworking connection leases, statement-vs-connection locking, the result cache and fetch
  read-ahead, and the docs still warn that "the protocol, function names, settings and
  defaults are still subject to change". The `ATTACH` surface has already moved since this
  document was written (`DISABLE_SSL`, `httpfs_connection_caching`, and a portless
  `'quack:localhost'` URI form).
- Throughput: DuckDB caps concurrent single-table insert rate (~5.4k tx/s in DuckDB's
  benchmark); the 500 ms batched-write design already stays well under this.
- Do not migrate the spark medallion pipeline onto Quack; keep Pulsar→Spark→Delta intact.

## Greenlight checklist (run the week DuckDB 2.0 ships)

Each item is a yes/no someone can settle in an afternoon. All must be **yes** before any
code is written; any **no** means append a row to the reevaluation log and defer again.

- [ ] **DuckDB 2.0 released** and Quack **declared stable** (not "beta" / "experimental")
      in the FAQ and the extension page.
- [ ] **`duckdb-rs` published against 2.0** — a `duckdb` / `libduckdb-sys` pair on crates.io
      tracking the 2.0 C API.
- [ ] **Quack is statically linkable** from `libduckdb-sys` (a `quack` feature in
      `extension_enabled`) **or** the autoinstall path is explicitly accepted, documented,
      and pre-seeded for the Pi (constraint 9).
- [ ] **`httpfs` dependency resolved** — either Quack does not need it, or it is covered by
      the same decision as above.
- [ ] **Python `duckdb` package** available on a protocol-compatible version, so webapp,
      agent and spark clients can be rolled together (constraint 8).
- [ ] **`quack` extension binary published for `linux_arm64`**, if the Pi deployment is in
      scope for the first cut.
- [ ] **Syntax re-validated against the GA docs**: `quack_serve` named parameters, the
      `ATTACH 'quack:…'` option list (`TOKEN`, `DISABLE_SSL`, …), and the
      `quack_authentication_function` / `quack_authorization_function` setting names used
      in §5 above.
- [ ] **TLS posture re-confirmed.** *(Answered 2026-08-23: the server does not terminate
      TLS, so the reverse proxy is mandatory off `localhost`. Re-check only that 2.0 did not
      change it.)*
- [ ] **DuckLake re-weighed** — DuckDB currently recommends DuckLake + PostgreSQL as the
      *stable* multi-process-write path. If Quack has slipped again at 2.0, take DuckLake
      rather than deferring a third time (see Alternatives).
- [ ] **Authorization requirement settled** — confirm we still accept homelab-grade,
      connection-level auth. Real table-level rules need a custom DuckDB extension
      (macros cannot do DML); budget for it explicitly or keep enforcement in our own code.

## References
- [Quack: The DuckDB Client-Server Protocol](https://duckdb.org/2026/05/12/quack-remote-protocol)
- [Quack Remote Protocol — Overview](https://duckdb.org/docs/current/quack/overview)
- [Quack — Security (auth/authorization macros)](https://duckdb.org/docs/current/quack/security)
- [Securing Quack with a Reverse Proxy](https://duckdb.org/docs/current/quack/setup/reverse_proxy)
- [DuckDB 1.5.3 release notes](https://duckdb.org/2026/05/20/announcing-duckdb-153)
- [Frequently Asked Questions for Quack](https://duckdb.org/quack/faq) — beta status, September 2026 target
- [Quack Extension (core extensions)](https://duckdb.org/docs/current/core_extensions/quack) — autoinstall/autoload on first use
- [Announcing DuckDB 1.5.5](https://duckdb.org/2026/07/22/announcing-duckdb-155) — no Quack mention
- [duckdb/duckdb-quack](https://github.com/duckdb/duckdb-quack) — protocol churn through 2026-08-20
- [Quack Reference](https://duckdb.org/docs/current/quack/reference) — functions, settings, ATTACH options, logging
- [Quack Troubleshooting](https://duckdb.org/docs/current/quack/troubleshooting) — "not ready for production … until DuckDB v2.0"; `FORCE INSTALL quack`
- [Quack Deployment](https://duckdb.org/docs/current/quack/setup/deployment) — EC2 recipe; sticky `ATTACH` vs stateless `quack_query`
- [DuckDB Concurrency](https://duckdb.org/docs/current/connect/concurrency) — recommends DuckLake + PostgreSQL as the stable multi-process-write solution

# Receiver location history (SCD2) and multiple receivers

## Context

**Today the receiver's position is configuration, not data.**
- `[receiver]` lat/lon/alt in `adsb-stack.toml` is copied into feed.toml, data-server.toml and weather.toml by `scripts/render-config.py`.
- The desktop keeps its own, separately typed copy in its Tauri store (Settings page).
- Nothing about the receiver is stored in DuckDB or sent over MQTT.

**Consequences:**
- When the antenna moves, every past calculation silently uses the new position:
  - detection range (`storage.rs:1842`)
  - the impossible-position quarantine (`storage.rs:1536`, frozen `rejected_positions.distance_nm`)
  - the desktop's distance, azimuth and elevation figures
- A remote (Quack) desktop only knows the location if someone typed it in. A new named stack falls back to Montréal (`MapInner.tsx:78`).
- The database cannot hold a second receiver:
  - `source_id` is fixed per `StorageHandle` (`storage.rs:740,2150`).
  - MQTT messages are bare SBS lines, and each process subscribes to one exact topic (`mqtt_source.rs:47`).

**Goal:**
- A point-in-time location history per receiver (SCD2), stored in the database and used by every calculation that involves position.
- A central recorder that ingests several receivers into one database.
- The desktop reads receivers and locations from the database, falling back to Settings.

**Decisions made with the user:**
- A central recorder with one topic per receiver.
- Location history comes from config + CLI first, then a desktop editor.
- The desktop reads the database first and falls back to Settings.

Work happens on the current branch `feature/receiver_conf_enh`, with TDD and one red-green-refactor cycle per commit. Commit only, never push. No Co-Authored-By trailer.

## Data model (adsb-data-engine)

New observed tables go in `SCHEMA_OBSERVED_SQL` (`storage.rs:198`) and in `share::OBSERVED_TABLES` (`share.rs:45`), so remote desktops see them through the existing view mechanism.

```sql
CREATE TABLE IF NOT EXISTS receivers (
  source_id TEXT PRIMARY KEY, name TEXT, first_seen_ms BIGINT NOT NULL);
CREATE TABLE IF NOT EXISTS receiver_locations (
  source_id TEXT NOT NULL, valid_from_ms BIGINT NOT NULL,
  valid_to_ms BIGINT,                 -- NULL = current; interval is [from, to)
  latitude DOUBLE NOT NULL, longitude DOUBLE NOT NULL, altitude_ft DOUBLE,
  origin TEXT NOT NULL,               -- 'config' | 'mqtt' | 'cli' | 'desktop' | 'backfill'
  recorded_at_ms BIGINT NOT NULL, note TEXT,
  PRIMARY KEY (source_id, valid_from_ms));
```

**Invariants**, per `source_id`:
- Periods never overlap.
- At most one period is open (`valid_to_ms IS NULL`).
- A new period is opened only when the position moves by more than a tolerance of about 1 m. This makes replays idempotent.

**New module `receiver_history.rs`.** It holds pure functions over `Vec<LocationPeriod>`, unit-tested without DuckDB:
- `observe(periods, pos, at)`: if the open period differs from `pos`, close it at `at` and open a new one. Otherwise do nothing. Used by the config bootstrap and by MQTT announcements.
- `move_at(periods, pos, at)`: split the period that contains `at`. Later periods are kept. Used for a back-dated move.
- `correct(periods, valid_from, pos)`: rewrite one period's coordinates in place. Used for "it was wrong all along".
- `remove(periods, valid_from)`: drop one period and let the previous one absorb its span.
- Each returns the new set or a validation error. Storage swaps in the new set for that source inside one transaction.

**New storage methods,** sync with async wrappers (the existing `spawn_blocking` pattern):
- `list_receivers`
- `receiver_locations(source_id)`
- `location_at(source_id, ts)`
- `apply_receiver_change(source_id, op)`
- In remote mode, writes go to `edge.receiver_locations` (views are read-only), not to the view.

**Export and import** (`storage.rs:3602`, `:3673`): include both tables, de-duplicated on `(source_id, valid_from_ms)`. Prune leaves them alone.

## Position-dependent calculations use the location in force at each fix

- **Quarantine** (`quarantine_positions_sync`):
  - Replace the literal receiver SQL with a range join: `positions p LEFT JOIN receiver_locations r ON r.source_id = p.source_id AND p.timestamp_ms >= r.valid_from_ms AND (r.valid_to_ms IS NULL OR p.timestamp_ms < r.valid_to_ms)`.
  - The `receiver: Option<(f64,f64)>` argument stays, but only as a fallback when no period covers a fix.
  - `distance_nm` is then computed from the correct location.
- **Detection range:**
  - `DetectionRangeQuery` gains `source_id: Option<String>`. `receiver_lat/lon` become `Option` fallbacks, which keeps compatibility with older daemons that lack the table.
  - Each fix's distance and bearing come from the location in force for it.
  - The result also reports the location period(s) the window covered, so the UI can say "location changed during this window".

## Multi-receiver ingest

- **Topic scheme:**
  - Feeds publish to `<mqtt.topic>/<source_id>`, for example `adsb/dev/sbs/raw/pi-garden-prod`.
  - `mqtt.topic` stays the *base*, so the weather-topic rule (`render-config.py:165` / `Config::weather_topic`, `config.rs:985`) is unchanged. Add `Config::publish_topic()` and `Config::sbs_subscriptions()`.
- **Routing:**
  - `route_publish` (`mqtt_source.rs:47`) gains wildcard matching. It returns `Route::Sbs { source_id: Option<String> }`: the last topic segment under `base/+`, or `None` on the legacy exact `base` topic.
  - Legacy feeds keep working. Their lines are stamped with the recorder's configured `source_id`.
- **Location announcement:**
  - On connect, each feed publishes a retained `adsb/<stage>/receiver/<source_id>` message: JSON `{lat, lon, alt_ft, since_ms}`.
  - The recorder subscribes to `adsb/<stage>/receiver/+` and calls `observe()` with origin `mqtt`. A remote Pi's config edit therefore becomes a new period with no manual step. The payload is far under rumqttc's 10 KiB.
- **Storage:**
  - `insert_batch`, `insert_raw_batch` and `insert_status_event` take the batch's `source_id` instead of `storage.source_id`. `storage.source_id` remains the default.
  - The recorder keeps one `IngestPipeline` per `source_id`, so the per-hex merge never mixes two receivers' fixes, and records each new `source_id` in `receivers`.
- **Flights** stay aircraft-level and shared across receivers. The tracker is keyed by hex and deliberately unchanged.
- **Config and tooling** (`render-config.py`, `adsb-stack-template.toml`, `deploy/fleet-template.toml`, fleet render):
  - New `mqtt.per_receiver_topic = true` setting.
  - Feed renders the publish topic.
  - Recorder renders `base/+` plus legacy `base`.
  - `make doctor` warns about a legacy topic.
  - Update the template so the setting doesn't exist on one machine only.

## Recorder bootstrap and CLI (adsb-data-server)

**Startup** (`recorder.rs` / `main.rs:51`):
- If `[receiver]` has a position, call `observe(source_id, pos, now)` with origin `config`.
- If the source has no periods at all, the first period's `valid_from` is back-filled to `MIN(timestamp_ms)` of its positions (origin `backfill`), so existing history gets a location.

**New clap subcommand** (the binary has none today): `adsb-data-server receiver list | history <id> | move <id> --lat --lon [--alt] --at <iso> | correct <id> --from <iso> ... | remove <id> --from <iso>`.
- It runs against the db_path from the same `--config`.
- Add `make receiver-history` / `make receiver-move` wrappers.

## Desktop (Tauri + Next)

**Rust commands:** `list_receivers`, `get_receiver_locations`, `apply_receiver_change`. Register them in `capabilities/default.json`. `get_detection_range` gains `source_id`.

**Live feed:**
- The desktop subscribes to `base/+`, `base` and `adsb/<stage>/receiver/+`, reusing the routing above.
- Receiver locations are then known in live-only MQTT mode too.

**Frontend:**
- **`useReceivers` hook.** Source: the database when storage is available, otherwise the retained MQTT announcements, otherwise the Settings location.
- **Receiver selector.**
  - Persisted in `useLocalStorage`.
  - Shown only when more than one receiver exists.
  - Drives `receiverLocation` (`page.tsx:322`). Every downstream use stays as it is: map centre, details, range lines, radar, tile cache, simulation origin, agent context (`useCopilotContext.ts:202`).
- **Map markers.** One for every receiver. The selected one is highlighted.
- **DB History.** Detection range passes `source_id`. The radar notes a location change inside the window.
- **Settings.**
  - "Receiver Location" becomes the fallback. Its label says that once a database has a location, the database wins.
  - New "Location history" table for the selected receiver: add a move (back-dated), correct, remove.
  - Edits call `apply_receiver_change` and are written to the local database, or in remote mode over Quack to `edge.`.

## Refactors this implies (please confirm, per the ask-before-refactoring rule)

1. **Storage insert APIs take `source_id` per batch** instead of always using `storage.source_id`. This touches ingest, the recorder and the desktop bridge.
2. **`route_publish` returns `Route::Sbs { source_id }`, with wildcard matching.** Callers in the feed source, recorder and desktop change.
3. **The recorder holds a map of ingest pipelines keyed by `source_id`** instead of a single pipeline.
4. **`DetectionRangeQuery.receiver_lat/lon` become `Option`.** This touches the TS types and `DBHistoryContent.tsx:110-131`.
5. **The desktop's `receiverLocation` moves from `appConfig` into a `useReceivers` hook.**

## Phases (each ships green and in TDD commits)

1. Engine: the tables, `receiver_history.rs`, storage CRUD and as-of lookup, OBSERVED_TABLES, export and import.
2. As-of quarantine and detection range, plus the recorder config bootstrap and back-fill.
3. Multi-receiver ingest: topics and routing, per-batch `source_id`, per-source pipelines, the location announcement, and the render-config/template/fleet/doctor changes.
4. Data-server `receiver` CLI and its make wrappers.
5. Desktop read side: commands, `useReceivers`, selector, markers, MQTT subscriptions, radar `source_id`.
6. Desktop location-history editor (write side, local database and remote over Quack).
7. Docs:
   - DESIGN.md: a new "Receivers & location history" section, and the topic scheme in §27.
   - QUICKSTART: multi-receiver topology.
   - adsb-feed/CLAUDE.md: the Transports section.
   - Then `graphify update .`.

## Critical files

- `rust/adsb-data-engine/src/{storage.rs,share.rs,types.rs,ingest.rs}`, plus the new `receiver_history.rs`
- `rust/adsb-data-server/src/{main.rs,config.rs,recorder.rs}`
- `rust/adsb-pulsar-client/src/{config.rs,source/mqtt_source.rs,forwarder/mqtt_forwarder.rs,client.rs}`
- `rust/adsb-pulsar-client-desktop/src-tauri/src/{commands.rs,lib.rs,quarantine.rs}` and `capabilities/default.json`
- `rust/adsb-pulsar-client-desktop/src/{app/page.tsx,app/settings/page.tsx,components/MapInner.tsx,components/DBHistoryContent.tsx,lib/types.ts}`, plus new `hooks/useReceivers.ts` and `components/ReceiverHistoryTable.tsx`
- `scripts/render-config.py`, `scripts/stack.sh`, `adsb-stack-template.toml`, `deploy/fleet-template.toml`

## Verification

**Tests:**
- **`receiver_history`:** move inside a period, at a boundary, before the first period; correct; remove the first, middle and last period; tolerance no-op; replay idempotence.
- **Storage** (fixtures `test_config`, `sample_position`, `range_of`, `track_with_glitches`):
  - A fix before a move is judged against the old location.
  - Detection range spans a move.
  - Remote catalog missing the new tables still opens (pattern at `storage.rs:4468`).
  - Export → import round-trip of the periods.
- **Routing:** `base/+` → `source_id`, legacy `base` → `None`, receiver announcement topic.
- **Recorder:** two `ScriptedSource` receivers produce rows with two `source_id`s. Bootstrap back-fills, then a changed config opens a new period.
- **Vitest:**
  - `useReceivers` fallback order.
  - The selector is hidden with one receiver.
  - The history table's edit flow.
  - DBHistoryContent passes `source_id`.

**CI gates,** from `adsb-feed/rust/`:
- `cargo test --workspace && cargo clippy --workspace -- -D warnings && cargo fmt --all --check`
- `npm test && npm run lint` in the desktop.

**End to end:**
1. `make up`, then `make verify`.
2. `adsb-data-server receiver history dev-laptop-dev` shows a `config` or `backfill` period.
3. Edit the latitude in `adsb-stack.toml`, then `make render` and restart. A second period opens.
4. Start a second mock feed with another `source_id` and `MOCK_RX_LAT/LON`. Two receivers appear in `receiver list`, and two markers plus a selector appear in `make up-desktop`.
5. The DB Stats radar changes with the selection.
6. In remote mode (`make client STACK=...`) with an empty Settings store, the map centres on the database's receiver, not Montréal.

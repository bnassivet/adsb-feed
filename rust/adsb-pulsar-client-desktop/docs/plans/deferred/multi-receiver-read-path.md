# Multi-receiver: the read path, time and operations

> **Status: DEFERRED (review of 2026-11-24).** Nothing below is built.
>
> Getting each receiver's data in -- attributed to the right receiver and placed
> at the right location -- is in place (plans 2026-11-23 and 2026-11-24). Reading
> it back out is not: most queries, every query result, timestamp parsing and
> the operational signals still assume one receiver. Items 1 and 2 should land
> before a second real receiver goes into production; the rest can wait until
> it does.
>
> Update this header and tick the tracker as items land.

## Tracker

| # | Item | Priority | Status |
|---|---|---|---|
| 1 | Per-receiver timestamp parsing and clock check | Before a 2nd receiver | ☐ |
| 2 | `source_id` in read results, a receiver filter on every query, (receiver, time) index | Before a 2nd receiver | ☐ |
| 3 | A defined fused view of an aircraft heard by several receivers | When fleet views are needed | ☐ |
| 4 | Per-receiver health in metrics | With the 2nd receiver | ☐ |
| 5 | Import de-duplication keyed by receiver | Low | ☐ |
| 6 | Agent tools take a receiver | Low | ☐ |
| 7 | Richer `receivers` metadata (timezone, label) | With item 1 | ☐ |
| 8 | Embedded desktop records under its configured id | Low | ☐ |
| 9 | `flights` says which receivers heard it | With item 3 | ☐ |
| 10 | Schema version and receiver-key integrity | Before the next breaking schema change | ☐ |

## Already in place (do not redo)

- **Identity travels with the data.** Feeds publish to `<topic>/<source_id>`;
  the recorder's demux runs one ingest pipeline per receiver and stores every row
  under it (`adsb-data-server/src/receivers.rs`, `IngestConfig::attribute_source_id`).
- **Location is dated data.** `receivers` and `receiver_locations` (SCD2), edited
  through pure operations (`receiver_history.rs`) and one transaction, also over
  Quack (`quack_query_by_name`). Export/import carry it.
- **As-of calculations.** The quarantine sweep and the detection range measure
  each fix from its receiver's location at the fix's time
  (`located_positions_sql`); detection range takes a `source_id`.
- **Liveness on the bus.** Retained `adsb/<stage>/receiver/<id>` (position) and
  `.../availability` (`online` / `offline` last will).
- **Weather per receiver.** A grid per active receiver, shared points fetched
  once, recorded and drawn per receiver.
- **Old and new components coexist** through the legacy topics and fallbacks.

## The schema today (2026-11-24)

`adsb-data-engine/src/storage.rs` creates every table on open. The data server
has no schema of its own.

**Recorded tables** (`SCHEMA_OBSERVED_SQL`, shared over Quack through
`share::OBSERVED_TABLES`):

| Table | Receiver column | Indexes |
|---|---|---|
| `positions` | `source_id` (nullable) | `(timestamp_ms)`, `(hex_ident, timestamp_ms)` |
| `rejected_positions` | `source_id` (nullable) | `(timestamp_ms)` |
| `raw_messages` | `source_id` (nullable) | `(timestamp_ms)`, `(hex_ident, timestamp_ms)` |
| `flights` | **none**, one row per aircraft per flight | `(hex_ident)`, `(last_seen_ms)` |
| `status_events` | `source_id` (nullable) | `(timestamp_ms)`, `(event_type, timestamp_ms)` |
| `weather_snapshots` | `source_id` NOT NULL | `(source_id, valid_time_ms)` |
| `receivers` | PK `source_id`; `name`, `first_seen_ms` | — |
| `receiver_locations` | PK `(source_id, valid_from_ms)`, SCD2 `[from, to)` | — |

**Authored tables** (`SCHEMA_AUTHORED_SQL`, always local, never shared):
`events_of_interest`, `scenarios`, `scenario_tracks`, `aircraft_info`,
`flight_routes`. None carries a receiver, and none needs one.

**What the schema says about multiple receivers.**
- Only `weather_snapshots` has an index that leads with `source_id`. Item 2
  adds it to `positions`, `raw_messages` and `rejected_positions`.
- `flights` has no receiver at all, and its `position_count` counts every
  receiver's rows (items 3 and 9).
- `source_id` is nullable on the event tables, and rows from before
  attribution may hold NULL. Filters must decide whether NULL means "the
  recorder's own receiver" or "unknown" (item 2), and import de-duplication
  must compare with `IS NOT DISTINCT FROM` (item 5).
- No foreign key ties a row's `source_id` to `receivers`. The demux registers
  each receiver in code (`register_receiver`), so a row can name a receiver
  the table does not list, for example after a partial import (item 10).
- `receivers` is thin: no `timezone` or `label` (item 7).
- There is no schema version. Migrations are `CREATE ... IF NOT EXISTS` and
  `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` on every open. That covers
  additive changes only (item 10).

## 1. Per-receiver timestamp parsing and clock check

**Problem.** SBS timestamps come from each Pi's own clock and zone, but:

- The recorder parses every receiver's lines with its **own** `dump1090_tz`.
  `receivers::demux` passes the same value to every pipeline
  (`adsb-data-server/src/receivers.rs`, `IngestConfig { dump1090_tz }`). A
  receiver whose host is set to another zone is stored hours off, with no error.
- The clock-offset warning keeps **one global** `LAST_ZONE_OFFSET`
  (`check_dump1090_clock`, `adsb-data-engine/src/storage.rs`). With two
  receivers at different offsets it flip-flops, or stays silent about one of them.
- The quarantine's speed test compares each aircraft's fixes across receivers
  (`WINDOW w AS (PARTITION BY hex_ident ORDER BY timestamp_ms)`), so clock skew
  between Pis can make real fixes look implausible.

**Direction.**
- Carry the feed's zone in `ReceiverLocationMessage` (`timezone`, optional,
  default `Local`). Store it on `receivers`, and have the demux build each
  pipeline with its receiver's zone (fall back to the recorder's).
- Keep the zone-offset state per receiver (a map keyed by `source_id`), and name
  the receiver in the warning.
- Partition the speed test by `(source_id, hex_ident)`, so each receiver's
  fixes are judged against its own clock. Check `track_with_glitches`-style
  tests still hold.

**Tests.** Two receivers in different zones are both stored at the true UTC
instant. The warning names the right receiver. A 2 s skew between two receivers'
fixes of one aircraft quarantines nothing.

## 2. Receiver in read results, filters, index

**Problem.**
- `PositionRecord` has no `source_id`, so the map, the Arrow exports and the
  agent cannot tell receivers apart even though every row carries one.
- These queries take no receiver filter: `get_trajectory`, `query_bbox`
  (and the density layer built on it), `get_flight_summary` (+ Arrow),
  `get_aircraft_summary`, `get_stats`, `get_time_distribution`,
  `get_raw_message_count`, `get_all_trajectories_arrow`,
  `get_trajectories_batch_arrow`.
- Indexes are on `timestamp_ms` and `(hex_ident, timestamp_ms)` only
  (`positions`, `raw_messages`, `rejected_positions`). A receiver filter scans
  more rows as receivers are added.

**Direction.**
- Add `source_id` to `PositionRecord` and to the Arrow schemas, and add an
  optional `source_id` to each query type, the same pattern as
  `DetectionRangeQuery` (`#[serde(default)]`, `NULL` = all). Mirror it in the
  TS types and in `tool_service`.
- Add `idx_positions_src_ts (source_id, timestamp_ms)` and the same on
  `raw_messages`; `CREATE INDEX IF NOT EXISTS` migrates existing files.
- Desktop: the DB History panel and the history preload pass `dbReceiverId`,
  as the radar already does (`page.tsx`).

**Tests.** Per query: with two receivers stored, a filter returns one, `None`
returns both. Arrow output carries the column. Query plans use the new index
(`EXPLAIN`).

## 3. A defined fused view

**Problem.** Two receivers hearing one aircraft each store a row, and nothing
reconciles them. Unfiltered views double-count positions and interleave
near-identical fixes, and `flights.position_count` is inflated because flights
are shared per aircraft (the tracker is keyed by `hex_ident`).

**Decide first** (a user decision, not designed):
- **Fuse at query time:** one fix per aircraft per second across receivers
  (e.g. `QUALIFY ROW_NUMBER() OVER (PARTITION BY hex_ident, timestamp_ms // 1000
  ORDER BY distance_from_its_receiver) = 1`). Raw rows stay untouched.
- **Fuse at ingest:** a fused table written by the recorder. Faster to read,
  but a second copy, and harder to undo.
- Either way, define what `flights.position_count` counts (fused fixes, most
  likely), and whether a flight records which receivers heard it.

**Tests.** Two receivers, one aircraft, overlapping coverage: the fused
trajectory has one fix per second and is monotonic in time; the flight count is
the fused count.

## 4. Per-receiver health

**Problem.** The recorder's `/metrics` describes the recorder only
(`metrics_export::render`, one `source_id` label). A receiver that stops sending
shows up only as `offline` on the bus. There is no per-receiver message rate or
last-seen time, so a Pi with a dead antenna but a live network looks healthy.

**Direction.** Each demux pipeline already counts lines and messages; export
them labelled `receiver="<id>"`. Add `adsb_receiver_last_message_seconds` and
`adsb_receiver_online` (from availability). Optionally add a Grafana panel per
receiver. Watch label cardinality: bounded by fleet size.

**Tests.** `/metrics` lists one series per receiver heard. A receiver that stops
sending ages in `last_message_seconds`.

## 5. Import de-duplication by receiver

**Problem.** `import_database_sync` de-duplicates `positions` on
`(hex_ident, timestamp_ms)` and `raw_messages` on `(hex_ident, timestamp_ms,
raw_message)` (`storage.rs`), ignoring `source_id`. Importing another receiver's
database drops its rows wherever they coincide with existing ones, which is
common in overlapping coverage.

**Direction.** Add `source_id` to both anti-join keys (`IS NOT DISTINCT FROM`,
for old rows with NULL). Keep `receiver_locations` as it is: one history per
receiver, never merged.

**Tests.** Two databases from two receivers with identical fixes import to both
rows.

## 6. Agent tools take a receiver

**Problem.** No server tool in `adsb-agent/src/adsb_agent/server_tools.py`
takes a `source_id`. The agent's context does say where the selected receiver
is (`useCopilotContext.ts`), but it cannot ask about another receiver.

**Direction.** After item 2, add an optional `sourceId` to the data tools, and
pass the selected receiver in the context. Keep the schemas in step with
`adsb-data-engine/src/types.rs`: a missing non-`Option` field is a serde error.

## 7. Richer `receivers` metadata

**Problem.** `receivers` holds `source_id`, an unused `name` and
`first_seen_ms`. Item 1 needs a timezone, and a fleet UI wants a label.

**Direction.** Add `timezone`, `label` and optionally `hardware`, as nullable
columns (`ALTER TABLE ... ADD COLUMN IF NOT EXISTS`, as
`rejected_positions.implied_speed_kt` did). Fill them from the announcement and
from the CLI (`receiver set --label ..`).

## 8. Embedded desktop identity

**Problem.** The desktop's own storage stamps rows `desktop`
(`src-tauri/src/storage_mode.rs`), not its configured `source_id`, so an
embedded desktop can never share a receiver view with a fleet. The UI works
around this (`dbReceiverId`: filter only by a receiver the database knows).

**Direction.** Stamp `config.source_id`, with a one-time migration of existing
`desktop` rows, or leave it as is and document the embedded desktop as a
single-receiver tool. Decide before item 2's UI work.

## 9. `flights` says which receivers heard it

**Problem.** `flights` is keyed by `flight_id` (hex + sequence) and has no
receiver column. Nothing records which receivers contributed to a flight, so a
fleet view cannot answer "flights seen by pi-a" without scanning `positions`,
and `position_count` sums every receiver's rows.

**Direction.** Decide together with item 3 (fused view). Options: a
`receivers TEXT[]` (or a `flight_receivers (flight_id, source_id, first_seen_ms,
last_seen_ms, position_count)` side table, which keeps per-receiver counts
without changing what `flights.position_count` means). Flights stay shared per
aircraft either way: the tracker is keyed by `hex_ident` on purpose.

**Tests.** Two receivers hearing one aircraft produce one flight that lists
both; a receiver filter on flights returns only the ones it heard.

## 10. Schema version and receiver-key integrity

**Problem.**
- Migrations are implicit: each open re-runs `IF NOT EXISTS` DDL. That handles
  a new table or a new nullable column, but not a changed key, a backfill
  (say, `NULL` → the recorder's id in `source_id`), or a renamed column. A
  remote desktop reading an older recorder over Quack cannot tell which
  version it is talking to, except by probing for missing tables (the pattern
  the receivers tables already use).
- `source_id` in the event tables is not constrained to `receivers`. DuckDB
  foreign keys would also cost on every insert and block deletes, so they are
  not the answer either.

**Direction.**
- A `schema_meta (key TEXT PRIMARY KEY, value TEXT)` table with
  `schema_version`, written by the recorder. Shared over Quack, so a desktop can
  warn "recorder schema N, desktop expects M". Ordered, idempotent migration
  steps keyed by version, for the first non-additive change.
- Keep receiver integrity in code: import and the demux register any
  `source_id` they write (`register_receiver`), and a check (`make doctor` or a
  `receiver list --orphans`) reports rows naming an unregistered receiver.

**Tests.** Opening a version-N file runs exactly the steps above N, once. An
import that brings a new `source_id` registers it. The orphan check finds a row
inserted without registration.

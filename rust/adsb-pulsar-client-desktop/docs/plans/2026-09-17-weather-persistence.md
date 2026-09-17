# Recording weather: persisting snapshots to the data storage

## Context

The weather capability is write-once, read-never. `adsb-weather-server` fetches
winds aloft and MSL pressure from Open-Meteo, publishes one ~16 KB
`WeatherSnapshot` as a **retained** MQTT message once an hour, and the desktop
draws it. Then it is gone: the next snapshot overwrites the retained message,
and the only things on disk are two last-value JSON files
(`.run/weather-cache.json`, `.run/weather-state.json`), both overwritten in
place.

`grep -rn -i weather rust/adsb-data-server/src rust/adsb-data-engine/src`
returns **zero matches**. The recorder has never seen the weather topic and no
table anywhere holds weather. The stack records where aircraft flew but not the
air they flew through, and the two cannot be correlated after the fact.

DESIGN.md already names the consequence as a deliberate restriction: per-aircraft
wind is shown *"for **live** selections only (current winds would describe the
wrong day for imported or DB-history tracks)"*. That guard exists **because
historical weather does not exist**. This change creates the data that makes it
liftable. The desktop wiring is a deliberate follow-up, not part of this work.

**Goal:** every distinct snapshot the service publishes is durably recorded in
the recorder's DuckDB — a little metadata plus the raw payload verbatim — and
readable back over the recorder's existing tool API.

## Decisions made with the user

- **Scope is store + read endpoints.** No UI change. The endpoints prove the data
  is queryable and are what a later desktop-history change consumes.
- **One row per model hour**, deduped on `(source_id, valid_time_ms)`. The
  retained message is re-delivered on *every* ConnAck; without this a reconnect
  loop writes near-identical 16 KB rows forever. ~24 rows/day.
- **Weather is never pruned.** ~140 MB/year. It is the slow-moving context that
  makes old flight data interpretable, so the retention window deliberately does
  not touch it. Pinned by a test, because `prune_sync` already deletes both
  `positions` and `raw_messages` and the next reader will assume weather follows.
- Work goes on `feature/weather-persistence`, test first, commits only — no push,
  no merge.

## Why the recorder is the writer

DuckDB takes an exclusive file lock and `adsb-data-server` holds it — `Recorder::open`
treats a failure there as fatal precisely because a recorder with no storage has
no reason to exist. The weather service therefore cannot write to the database.
It keeps publishing to MQTT and the recorder subscribes, which also preserves the
project's one-writer-per-piece-of-state discipline.

The subscription mechanism already exists and needs no new connection:
`MqttSource::with_aux_topic` (`adsb-pulsar-client/src/source/mqtt_source.rs:132`)
adds a topic to the connection the recorder already has and delivers each payload
**whole**, never line-split — built for exactly this retained-document case and
already used by the desktop. `MAX_INCOMING_PACKET_BYTES` is 1 MiB there, so the
rumqttc 10 KiB reconnect-storm trap is already solved on this path.

## Schema

One new **observed** table (recorded from the feed, like `status_events`), in
`SCHEMA_OBSERVED_SQL`:

```sql
CREATE TABLE IF NOT EXISTS weather_snapshots (
    source_id       TEXT    NOT NULL,
    valid_time_ms   BIGINT  NOT NULL,
    fetched_at_ms   BIGINT  NOT NULL,
    received_at_ms  BIGINT  NOT NULL,
    source          TEXT    NOT NULL,
    model           TEXT    NOT NULL,
    version         INTEGER NOT NULL,
    lat0 DOUBLE NOT NULL, lon0 DOUBLE NOT NULL,
    dlat DOUBLE NOT NULL, dlon DOUBLE NOT NULL,
    nlat INTEGER NOT NULL, nlon INTEGER NOT NULL,
    levels          TEXT    NOT NULL,
    payload         TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_weather_snapshots_src_valid
    ON weather_snapshots (source_id, valid_time_ms);
```

No `id` column — matching `positions`, `raw_messages` and `status_events`, whose
identity is a natural key. All `NOT NULL` because every one of these is
non-`Option` in `WeatherSnapshot`.

**The column set is permanent in practice.** This codebase has *no migration
mechanism*: `CREATE TABLE IF NOT EXISTS`, re-executed on open, is the entire
story — no `schema_version`, no `ALTER TABLE`, no runner. Adding a table is safe
and additive; adding a column later is not. So each column carries a
justification, and the bar is "unavailable or expensive without it":

| Column | Why it earns its place |
|---|---|
| `valid_time_ms` | The model hour. Dedupe key, sort key, and the join key to a track's timestamp. |
| `fetched_at_ms` | Separates "model hour 10:00, got it at 10:07" from "…at 11:58 after three retries". Unrecoverable if not captured. |
| `received_at_ms` | The only clock **this** process owns — the way to notice the weather host's clock is wrong, and the honest answer to "when did this row appear" after a retained replay into a fresh database. |
| `source`, `model` | Two rows for one hour from different models are *different data*. `model` is operator-settable and changes in the field. |
| `version` | What you filter on when `SNAPSHOT_VERSION` bumps to 2. |
| grid (6 cols) | The operator edits `radius_nm`/`spacing_deg` and the grid silently changes shape; these make that boundary findable and make "which snapshots cover this point" a `WHERE` clause instead of 8,760 JSON parses a year. |
| `levels` | Operator-settable, so it changes over time. "Which levels do I have history for" is the likeliest retrospective question. Ascending and comma-separated, which is `BTreeMap` order. |
| `payload` | The raw contract, verbatim. |

Rejected: `id`; `attribution` (a function of `source`, and present in the payload
any reader of the row already has); `point_count` (= `nlat*nlon`);
`payload_bytes` (= `length(payload)`); any per-point normalisation, which is the
opposite of what was asked for.

## Dedupe: anti-join, not a constraint

`INSERT … ON CONFLICT DO NOTHING` *is* supported by the pinned
`duckdb =1.10505.0`, but it requires a `PRIMARY KEY`/`UNIQUE` ART index on the
conflict target — committing the natural key into the schema, in a codebase with
no migrations. An anti-join keeps the key soft: if a second model ever shares a
broker the key becomes `(source_id, model, valid_time_ms)`, a one-line change
rather than an unfixable one. It is also already the house idiom —
`import_database_sync` dedupes both observed tables this way.

`insert_weather_snapshot_sync` returns `Result<bool>` — stored, or already had it
— which gives the persist task something to log and the test something to assert.
It uses `conn.execute` + `params![]`, the `insert_status_event_sync` shape, not
the `Appender` shape: this is one row an hour, not a batch.

**`source_id` is stamped from `StorageConfig`, not taken from the record**, exactly
as `insert_raw_batch_sync` does. A recorder can only write its own identity;
several receivers in one database arise through *import*, never through insert.

Trap: 17 positional placeholders, with the two key values bound **twice** —
DuckDB has no named-parameter reuse. `nlat`/`nlon` are `usize` in `GridSpec` and
have no `ToSql`; cast at the boundary.

Second layer, in-process: the persist task holds the last stored `valid_time_ms`
and short-circuits before any database round trip, so a flapping broker costs
nothing. The anti-join stays authoritative across restarts.

## The remote-mode trap

Adding the table to `share::OBSERVED_TABLES` makes `remote_view_sql` emit
`CREATE OR REPLACE VIEW weather_snapshots AS SELECT * FROM edge.weather_snapshots`,
executed at `storage.rs:245` with `?`. DuckDB binds a view body at create time,
so a **new desktop attached to an older daemon** fails that statement and
`StorageHandle::open` returns `Err`. That does not degrade weather — it kills
remote mode entirely, and `storage_mode.rs` has no fallback by design (a fallback
would mean a second exclusive-lock owner).

Fix, valuable for every future observed table: `share::remote_view_statements`
returns one statement per table, and `open()` creates them individually,
`warn!`-ing on a table the daemon does not have. The weather `COUNT(*)` in
`get_stats_sync` must be equally tolerant, or the whole stats chain — and
`/metrics` with it — goes down against an older daemon.

## Read endpoints

Split, so the 16 KB payload can never be pulled in bulk:

- `getWeatherSnapshots` — `{start_ms?, end_ms?, limit?}` (default 24, cap 1000)
  → metadata rows, newest first, **no payload**, plus `payload_bytes`.
- `getWeatherSnapshot` — `{valid_time_ms, source_id?}` → one row with the
  verbatim payload, `null` when absent.

An agent that could list 24 full snapshots would blow its own context with
~384 KB of grid data. The split makes the cheap call the default and the
expensive one explicitly single-row. No write tool, mirroring the existing
`scenario_writes_are_not_reachable_from_the_tool_server` regression.

## Configuration

`ServerConfig` gains `mqtt_weather_topic` (`ADSB_MQTT_WEATHER_TOPIC`, default
`""` = derive), **with its own `overlay!` line** — a key without one silently
ignores the rendered TOML value, which is the bug `http_bind_comes_from_the_file`
was written for.

The derivation rule is **not** copied a third time. `main.rs` already builds a
`FeedConfig`; that moves into `ServerConfig::feed_config()` so the existing
`Config::weather_topic` does the work. `render-config.py`'s `render_server` emits
the same expression `render_weather` uses, and the test asserts the two rendered
topics are *equal to each other* rather than to a literal, so they can only move
together.

No kill switch: the subscription rides the existing connection and the write is
24 rows a day.

## TDD sequence

Phase 1 (engine): types → round-trip → dedupe (same hour once; a refetch with a
new `fetched_at` still one row) → `source_id` stamping → ordering/window/limit →
listing carries no payload → single fetch is verbatim → async wrappers → **weather
survives the retention window** → stats count → observed views include it →
**a remote catalog missing a table still opens** → export/import (+ `preview_table`
needs a `ts_col` parameter; it hardcodes `timestamp_ms` and this table uses
`valid_time_ms`).

Phase 2 (recorder logic, new `adsb-data-server/src/weather.rs`):
`record_from_snapshot` keeps the original bytes → `next_weather` handles cleared,
duplicate, newer and wrong-version payloads → the persist task stores one row per
model hour → a storage failure does not end the task.

Phase 3: `run_with_weather`, with the existing `run` tests as the regression.
Phase 4: config overlay and topic derivation. Phase 5: the two read endpoints and
the no-writes regression. Phase 6: render-config test and documentation.

`make -C rust ci` after each phase.

## Traps

1. Remote views are fatal, not degraded (`storage.rs:245`). Highest risk here.
2. A missing `overlay!` line is silent — the derived default usually *works*,
   hiding the bug until someone sets an explicit `[weather].topic`.
3. 17 positional placeholders; the key is bound twice.
4. `preview_table` hardcodes `timestamp_ms`; this table uses `valid_time_ms`.
5. A `SNAPSHOT_VERSION` bump in a *mixed* deployment (old recorder, new service)
   silently stores nothing. Safe inside the workspace, unsafe across a partial Pi
   deploy. Do not add a store-rejected-payloads path — the metadata columns
   require a parse, and it violates "simple".
6. `watch::Ref` is not `Send` — clone the payload before awaiting.
7. An empty payload is a cleared retained message: a no-op, not an error and
   never a delete.
8. The recorder reads its config once at startup; `make render` alone changes
   nothing.
9. `payload` must be the received bytes, never a re-serialisation.

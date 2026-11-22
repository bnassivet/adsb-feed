# Quarantine impossible positions (step 1)

**Status: implemented** on `feature/erroneous_positions_robustness` (2026-11-22).
The reference is now DESIGN.md → *Quarantined positions*. Differences from this plan:

- Out-of-range fixes are classified **before** the speed test and are nobody's
  neighbour: otherwise a real fix next to a far glitch pair was rejected with it.
- The desktop sweeps from its own loop (`src-tauri/src/quarantine.rs`, every
  5 min, first after 30 s), not the bridge heartbeat, which only runs while a
  feed is connected. Both ingest owners share `QuarantineCursor`.
- Added afterwards: `implied_speed_kt` (with an `ALTER … IF NOT EXISTS` and a
  requeue on open), show/hide of rejected rows on the map (point, regular dot
  hover tooltip, H3 cell).
- Receiver location as a single current point is recorded as design debt
  (DESIGN.md → Design Debt).

## Context

The DB History → Detection Range radar shows a 2400 NM spike at 10° N. The DB holds
10 fixes > 1000 NM from a receiver in France (Arctic, South Atlantic, India…), all
CPR decode glitches. The query's speed-plausibility filter
(`get_detection_range_sync`, `adsb-data-engine/src/storage.rs:1542`) misses them
because glitches arrive in **bursts**: two bad fixes 0.9 s / 0.06 NM apart vouch
for each other (4CAE9A @ 83.7°N, 4D244B @ 71°N 115°W).

Decisions taken with the user:
- Glitches are **moved** out of `positions` into a new `rejected_positions` table
  (kept, inspectable), so every view gets clean data.
- The **ingest owner classifies**: the data server (receiver location rendered from
  the existing `[receiver] latitude/longitude` in `adsb-stack.toml`), and the desktop
  in embedded mode (from its settings store).
- Rejected rows are shown in a new collapsible section between Detection Range and
  Status Timeline.
- Work on a new branch `feature/erroneous_positions_robustness`, created from the
  current `feature/saved-regex-filters` HEAD (clean tree); commit, never push.
- This is the simple version; a more robust classifier is a later step 2.

## Classification rule (shared, one SQL predicate)

A position with lat/lon is rejected when either:
1. `out_of_range` — great-circle distance from the receiver > `MAX_RECEPTION_RANGE_NM`
   (new const = 500 NM; radio horizon at FL450 is ~270 NM). Skipped when no receiver.
2. `implausible_speed` — the existing neighbour test fails (no neighbour among
   prev/prev2/next/next2 reachable at `PLAUSIBLE_MAX_SPEED_KT` + `POSITION_JITTER_NM`).

Extract the neighbour test from `get_detection_range_sync` into one SQL fragment
builder reused by the query and the sweep (no duplicated haversine blocks).
The radar query also gains the range predicate inline, so rows not yet swept
(and older remote daemons) are already filtered.

## Changes

### adsb-data-engine
- `storage.rs` `SCHEMA_OBSERVED_SQL`: new table
  ```sql
  CREATE TABLE IF NOT EXISTS rejected_positions (
    <the 12 positions columns>,
    reason TEXT NOT NULL,          -- 'out_of_range' | 'implausible_speed'
    distance_nm DOUBLE,            -- from receiver; NULL without receiver
    rejected_at_ms BIGINT NOT NULL);
  CREATE INDEX ... ON rejected_positions (timestamp_ms);
  ```
- `share.rs` `OBSERVED_TABLES`: add `rejected_positions` (view creation is already
  per-table tolerant, so an older daemon just lacks it).
- New `quarantine_positions_sync(receiver: Option<(f64,f64)>, from_ms, to_ms) -> u64`
  (+ async wrapper like `prune`): in one transaction, compute window neighbours over
  `[from_ms - margin, to_ms + margin]`, classify rows in `[from_ms, to_ms]`, INSERT
  into `rejected_positions`, DELETE the same rows from `positions` (match on
  hex_ident, timestamp_ms, latitude, longitude via a temp table — positions has no PK).
  `raw_messages` and `flights` untouched (flights counts: step 2).
- New `get_rejected_positions_sync(start_ms, end_ms, limit)` → `Vec<RejectedPosition>`
  (newest first) + total count; types in `types.rs`.
- `prune_sync` also prunes `rejected_positions`; export (`storage.rs:3303`) copies it.

### adsb-data-server
- `config.rs`: optional `receiver_latitude` / `receiver_longitude` (overlay + serde).
- `scripts/render-config.py` `render_server` (and the fleet server render): emit them
  from `rx` / `site`, as `render_feed` already does.
- `recorder.rs` `spawn_maintenance`: before checkpoint, run the sweep over
  `[watermark, now - 60 s]` (60 s so `LEAD` neighbours exist); watermark kept in
  memory, starting at 0 → first tick backfills the existing history once.
  Log `Quarantined N positions`.

### desktop (src-tauri)
- Embedded mode only (remote: daemon owns the tables): same sweep with the store's
  receiver location — once after storage open (backfill), then on the bridge's
  60 s heartbeat (`bridge.rs:473`).
- New command `get_rejected_positions` in `commands.rs`, registered in `lib.rs`,
  capability if required.

### desktop (frontend)
- `src/lib/commands.ts` + `src/lib/types.ts`: `getRejectedPositions`, `RejectedPosition`.
- New `components/RejectedPositions.tsx`: table (time in selected TZ, hex, callsign,
  lat, lon, alt, distance NM, reason), fetched lazily when opened, for the current
  DB History time range.
- `components/DBHistoryContent.tsx` (~line 609): new `<details>` "Rejected Positions"
  (collapsed by default, same summary styling as Status Timeline) between the
  analytics block and Status Timeline.

## TDD order (one red-green-refactor per commit)
1. Radar ignores a 2-fix glitch cluster 2400 NM away inside a normal track (regression
   with the real 4CAE9A shape).
2. Sweep moves out-of-range and isolated-speed glitches, keeps real fixes around them,
   is idempotent, skips range check without receiver.
3. `get_rejected_positions` returns them in range order with reason/distance.
4. Server config parses receiver; render-config emits it (python test if present).
5. Recorder maintenance sweep (in-memory storage, short interval).
6. `RejectedPositions` component test (mock invoke: rows, empty, error) and
   DBHistoryContent ordering (section sits between analytics and Status Timeline).

## Verification
- `cargo test --workspace && cargo clippy --workspace -- -D warnings && cargo fmt --all --check`
- `npm test && npm run lint` in `adsb-pulsar-client-desktop/`
- `make render && make restart` (data server), check log for the backfill count;
  query the DB snapshot: 0 positions > 500 NM, ~10+ rows in `rejected_positions`.
- `make up-desktop`: Detection Range has no 2400 NM spike; the new section lists
  4CAE9A/4D244B etc.
- `graphify update .` after code changes.

Note: the IDE currently reports TS errors in `SavedFilters*.tsx` (`callsignRegex`,
`combine`); check `npx tsc --noEmit` first — likely stale IDE state from the
`lib/` gitignore issue, not in scope unless real.

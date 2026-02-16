# Design: RxTS & Msg# Table Columns

## Goal

Add two columns to the aircraft tracking table:
- **RxTS**: Last time a message was received from the aircraft (relative, e.g. "3s ago")
- **Msg#**: Total number of SBS-1 messages received for the aircraft (cumulative, pre-throttle)

## Data Flow

### Msg# (message count)

Counted in the Rust bridge *before* throttling, so it reflects true RF reception volume.

```
SBS-1 message arrives
  → bridge.rs: message_counts[hex_ident] += 1  (every message)
  → bridge.rs: buffer[hex_ident] = pos          (latest only, throttled)
  → flush: attach count to AircraftPosition.message_count
  → frontend: AircraftTrack.message_count += pos.message_count
```

### RxTS (receive timestamp)

Already tracked as `AircraftTrack.last_seen` (set to `Date.now()` on each batch merge). Just needs a table column displaying it via the existing `timeAgo()` formatter.

## Changes by Layer

### Rust: `sbs_parser.rs`
- Add `message_count: u64` field to `AircraftPosition` (default 0)

### Rust: `bridge.rs`
- Add `message_counts: HashMap<String, u64>` alongside position buffer
- Increment on every successful `parse_sbs_message`
- On 500ms flush: set `pos.message_count = counts[hex_ident]` for each position
- Drain counts for flushed aircraft only

### TypeScript: `types.ts`
- Add `message_count: number` to `AircraftPosition`
- Add `message_count: number` to `AircraftTrack`

### React: `AircraftTrackingContext.tsx`
- `mergePositionInto`: `track.message_count += pos.message_count`
- New track init: `message_count: pos.message_count`

### React: `AircraftTable.tsx`
- Add RxTS column: `<SortHeader label="RxTS" field="last_seen" />` with `timeAgo(t.last_seen)`
- Add Msg# column: `<SortHeader label="Msg#" field="message_count" />` with `t.message_count`
- Place both at rightmost position

## Testing

- Rust unit test: message_count accumulates across multiple messages for same hex_ident
- TS unit test: mergePositionInto accumulates message_count
- Component test: RxTS and Msg# columns render in table

## Decisions

- Count all SBS-1 messages (pre-throttle) for true RF reception metric
- Display RxTS as relative time ("3s ago") consistent with existing UI
- Cumulative counts (no reset until aircraft purged from tracking)

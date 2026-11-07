# Restore msgs/s, keep pos/s, fix hits/s

## Context
Commit `42f6cb7` renamed the metrics bar's **msgs/s** to **pos/s**. The user
says msgs/s was the right metric: it should count the messages **used to update
aircraft information**. In `IngestPipeline::absorb`
(`rust/adsb-data-engine/src/ingest.rs`) those are the messages that reach
`merge_into_buffer`, which `messages_parsed` already counts (any MSG 1–8 line
with a real hex). The user also wants **pos/s kept**.

Since msgs/s takes `messages_parsed`, hits/s needs its own counter again. It goes
back to its pre-`42f6cb7` meaning, "every line received". This time the ingest
pipeline counts it, so it works on MQTT too (an MQTT session's `messages_sent`
is a zeroed handle, which was the bug `42f6cb7` fixed).

| Label  | Counter (ingest pipeline)        | Counts |
|--------|----------------------------------|--------|
| hits/s | `lines_received` (**new**)       | every line delivered to the pipeline: MSG, SEL/ID/AIR/STA/CLK, heartbeats (hex `000000`), garbage |
| msgs/s | `messages_parsed` (existing)     | lines merged into an aircraft (`parse_sbs_message` → `merge_into_buffer`): MSG1–7, **not MSG8** |
| pos/s  | `positions_parsed` (existing)    | merged lines carrying a lat/lon fix |

The invariant is hits/s ≥ msgs/s ≥ pos/s.

## Changes (TDD: red first in each layer)

**Rust: `rust/adsb-data-engine/src/ingest.rs`**
- Add `lines_received: Arc<AtomicU64>` with `with_lines_received(..)` and `lines_received()`, mirroring `positions_parsed`.
- In `absorb`, increment it first for every `data`, before the UTF-8 check.
- Tests: `count_after` returns `(lines, messages, positions)`.
  - A line that is neither MSG nor valid (`STA,...` or `garbage`) and a heartbeat (hex `000000`) count as lines only.
  - `SAMPLE_MSG1` and `SAMPLE_MSG3` count as lines and messages; only the MSG3 is a position.
  - `SAMPLE_MSG3_NO_FIX` counts as a message but not as a position.

**Rust: stop merging MSG8 (all-call reply).** MSG8 carries only the on-ground flag, which adds nothing, so it no longer updates aircraft state.
- `rust/adsb-data-engine/src/sbs_parser.rs`: add `pub fn updates_aircraft_state(transmission_type: Option<u8>) -> bool`, which is `false` for `Some(8)` only.
  - Doc-comment the per-type table, including why MSG7 stays.
  - Unit tests:
    - 1–7 → true
    - 8 → false
    - `None` → true (merge an unknown type rather than drop it)
- `ingest.rs` `absorb`:
  - Call `parse_sbs_raw_fields` once and keep its result.
  - Raw recording is unchanged: MSG8 is still archived, so the DB History Message Types chart still shows it.
  - Only call `parse_sbs_message` → `merge_into_buffer` when `updates_aircraft_state(trans_type)`.
  - MSG8 therefore counts toward hits/s but not msgs/s, and not toward the aircraft's `message_count`.
- `ingest.rs` tests:
  - A `SAMPLE_MSG8` line creates no buffered aircraft and doesn't change an existing one's timestamp. Assert through the `RecordingSink`.
  - MSG8 still lands in the raw batch.
  - MSG8 counts as a line but not as a message.
- Side effect: an aircraft heard only through all-call replies no longer appears or refreshes `last_seen`. That matches "no additional value": it never had a position.
- `parse_sbs_message` is only called from `ingest.rs`, so the adsb-data-server recorder gets the same rule, since it shares `IngestPipeline`.

**MSG7 (air-to-air, DF16/ACAS): keep merging.** It carries the aircraft's own barometric altitude, which is the same data as MSG5. For a TCAS-equipped Mode S aircraft without ADS-B it can be the most frequent altitude source. It never overwrites a position (the merge only takes non-empty fields), so it has value and no downside.

**Tauri: `src-tauri/src/bridge.rs`, `state.rs`, `commands.rs`**
- Thread `lines_received` exactly like `positions_parsed`: `start_feed` (clones for relay and handle), `relay_messages` (`.with_lines_received`), `relay_metrics`, the `DesktopMetrics` field, the `FeedHandle` field, and `get_metrics` (both arms).
- Fix the doc comments: hits/s comes from `lines_received`, msgs/s from `messages_parsed`.

**Frontend: `rust/adsb-pulsar-client-desktop/src/`**
- `lib/types.ts`:
  - Add `lines_received` to `MetricsSnapshot`.
  - Change `messages_parsed`'s comment to msgs/s.
- `hooks/useMetrics.ts`:
  - Add `pos_per_sec` to `MetricsWithRates`.
  - Map the rates: `throughput_msg_per_sec` ← `messages_parsed` (msgs/s), `pos_per_sec` ← `positions_parsed`, `hits_per_sec` ← `lines_received`.
  - Add `lines_received: 0` to `EMPTY_METRICS`.
  - Update the JSDoc.
- `components/MetricsBar.tsx`: show three rates, each with a tooltip.
  - **hits/s**: "Every line received from the source, including heartbeats and non-MSG lines"
  - **msgs/s**: "MSG messages used to update aircraft information"
  - **pos/s**: "Messages carrying a position (latitude/longitude)"
- `app/settings/page.tsx`: change the window hint to "hits/s, msgs/s and pos/s".
- Tests, red first:
  - `hooks/__tests__/useMetrics.test.ts`:
    - `snapshot(elapsed, lines, messages, positions)`.
    - One test per rate.
    - One test for the ordering hits ≥ msgs ≥ pos.
  - `components/__tests__/MetricsBar.test.tsx`:
    - Assert the three labels and tooltips.
    - Update the fixture.
  - Other `MetricsSnapshot` fixtures will be flagged by `tsc`.
- `chat/FeedMetricsCard.tsx` ("Throughput … msg/s") already means msgs/s. No change.

**Docs: `docs/DESIGN.md`** (the `useMetrics` section, around line 1323)
- Replace the stale bullets (they still say `messages_sent`) with the three-rate table.
- Add the per-MSG-type merge table, noting that MSG8 is archived but not merged.

## Out of scope (reported to the user, not changed)
- `parse_bool` maps the SBS flag `-1` to `false`, and a test pins that. In BaseStation/dump1090, `-1` means **true**, so `is_on_ground` is probably inverted. Fix it separately if the user confirms.

## Verification
- From `rust/`, run `cargo test --workspace`, `cargo clippy --workspace -- -D warnings` and `cargo fmt --all --check`.
- From the desktop app directory, run `npm test`, `npm run lint` and `npx tsc --noEmit`.
- Optional: run `make up-desktop` on the MQTT stack and check that hits/s ≥ msgs/s ≥ pos/s, all greater than 0.
- Run `graphify update .` and commit on `feature/metrics-enhancements` with no Co-Authored-By. Don't push.

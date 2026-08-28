---
name: run-adsb-desktop
description: Build, launch, and verify the ADS-B Aircraft Tracker Tauri desktop app on macOS. Use when asked to run, start, launch, smoke-test, verify, or screenshot the desktop app, or to confirm a change to the feed/ingest path works in the real app rather than only in tests.
---

# Running and verifying the ADS-B desktop app (macOS)

Tauri v2 app: Rust backend (`src-tauri/`) + Next.js frontend (`src/`). It reads
SBS-1 from a dump1090 TCP socket, merges positions in
`adsb_data_engine::ingest`, persists to DuckDB, and emits to the webview.

**Paths below are relative to `rust/adsb-pulsar-client-desktop/`.**

## The GUI is not drivable on macOS — verify through the side doors

Two hard blocks, both confirmed:

- `tauri-driver` (Tauri's WebDriver) supports **Linux and Windows only**. There
  is no macOS WebDriver path.
- A non-interactive shell has no Screen Recording permission, so
  `screencapture -x out.png` fails with `could not create image from display`.
  There is no screenshot from an agent shell.

So the driver drives the app through the two surfaces that *are* reachable:

| Surface | What it is |
|---|---|
| TCP **input** | a mock dump1090 on `:30003` (`mock_dump1090.py`) |
| HTTP **output** | the app's read-only tool server on `:8787` (`src-tauri/src/tool_server.rs`) |

That covers parse → merge → persist objectively. The **emit → webview** half
needs a human to look at the window. One click is also unavoidable: the app
deliberately starts with the feed stopped (`src/app/page.tsx`), and
`tool_server.rs` deliberately excludes `startFeed` from its HTTP surface, so
no automated path can start the feed.

## Prerequisites

```bash
node --version   # v22+
cargo --version  # 1.92 (rust-toolchain.toml)
```

No `duckdb` CLI needed — and **do not install one to poke the database**. The
`duckdb` crate is pinned exactly (`=1.10505.0`); an arbitrary CLI version
opening `adsb_history.db` can migrate its on-disk format irreversibly. Use
`driver.sh purge`, which goes through the workspace's own pinned build.

## Run (agent path)

```bash
cd rust/adsb-pulsar-client-desktop
S=.claude/skills/run-adsb-desktop

$S/driver.sh backup       # copy DB + config to /tmp/adsb-backup first
$S/driver.sh baseline     # record row counts, to compare after purge
$S/driver.sh feed         # mock dump1090 on :30003, 6 aircraft, backgrounded

npm run tauri dev &       # ~40s: compiles the Rust crates, then opens a window

$S/driver.sh wait         # blocks — CLICK "Start" IN THE APP WINDOW NOW
$S/driver.sh verify       # the real assertion (see below)
$S/driver.sh summary      # lists the 6 mock aircraft and position counts
```

Then stop the app (it holds DuckDB's exclusive lock) and clean up:

```bash
$S/driver.sh purge        # deletes TST00* rows, refuses to run while app is up
$S/driver.sh baseline     # should match the earlier baseline exactly
```

### Checking the checker

`selftest` runs the parsers against captured fixtures and needs no app, no
feed and no click — run it after touching `verify_merge.py` or `summarize.py`:

```bash
$S/driver.sh selftest
```

It asserts the failure paths too, which is the part that matters: a detector
that never fails detects nothing. `fixtures/trajectory_broken_merge.json` is
the healthy response with `latitude`/`longitude` nulled — exactly what a
regressed merge produces — and `verify` must reject it.

### What `verify` actually proves

The mock interleaves **MSG3** (position), **MSG1** (callsign) and **MSG4**
(speed/track) for each aircraft inside one 500 ms flush window. A correct
`merge_into_buffer` lands all three on **one** record:

```
  PASS  position (from MSG3)
  PASS  callsign (from MSG1)
  PASS  speed+track (from MSG4)
```

This is the regression test for the ingest path. If the merge breaks, the
failure is silent and specific: `latitude: None`, because MSG1's nulls
overwrote the fix MSG3 established — aircraft with callsigns but no position,
so markers vanish from the map while the row count still climbs.

### What only a human can check

Look at the window: six aircraft labelled `CLAUDE1`–`CLAUDE6`, each with an
altitude and ground speed. That is the only check on
`EmitSink` → `adsb:message` → map, which no test reaches.

## Run (human path)

`npm run tauri dev`, click Start. Needs a real dump1090 at the configured
`socket_host:socket_port`, or run `driver.sh feed` first.

## Test

```bash
cd rust && cargo test --workspace && cargo clippy --workspace -- -D warnings && cargo fmt --all --check
cd rust/adsb-pulsar-client-desktop && npm test && npm run lint
```

Note `cargo clippy --workspace -- -D warnings` is the real gate. Adding
`--all-targets` fails with ~32 pre-existing lints in test code, on `main` too.

## Gotchas

- **`.claude/` is gitignored** (`.gitignore:366`). This skill is committable
  only because of a targeted negation at the end of `.gitignore`. Git will not
  descend into an excluded directory, so re-including the parent *first* is
  required — a bare `!…/skills/` does nothing.
- **The mock writes into your real history DB.** Recording defaults to on
  (`state.rs`). Always `driver.sh backup` first. Mock hex idents are `TST00*`
  so `purge` can remove them precisely.
- **`purge` requires the app stopped.** DuckDB holds an exclusive file lock;
  the driver refuses rather than failing obscurely.
- **`message_count` is `None` in trajectory queries.** Not a bug — the
  `positions` table has no such column; it is a live-feed-only field for the
  webview emit.
- **`test_mode: true` in `config.json`** lets the app run with no Pulsar
  broker. Keep it for verification runs.
- **A "client connected / disconnected" pair in the mock log** with no data is
  usually a format probe, not the app.
- **Piping cargo to `tail` hides failures**: `cargo clippy … | tail -5` reports
  `tail`'s exit code, always 0. Redirect to a file and check `$?`.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `FAIL: tool server not answering on localhost:8787` | App isn't running, or still compiling. Wait for `Running \`…/adsb-pulsar-client-desktop\`` in the dev log. |
| `wait` times out after 6 min | You didn't click Start; the app never auto-starts the feed. |
| `could not create image from display` | Expected. No Screen Recording permission for this shell; there is no screenshot path. |
| `open database` panics in `purge` | The app still holds the lock. Stop it first. |
| Port 30003 already in use | An earlier `driver.sh feed` is still running: `pkill -f mock_dump1090.py`. |

## Files

| File | Role |
|---|---|
| `driver.sh` | entry point; all commands above |
| `mock_dump1090.py` | mock SBS-1 feed, 6 aircraft orbiting the configured receiver |
| `verify_merge.py` | the merge assertion (reads a `getTrajectory` response) |
| `summarize.py` | formats a `getAircraftSummary` response; exits 1 unless all 6 are present |
| `fixtures/` | captured real responses, plus a deliberately-broken one for `selftest` |
| `purge_test_rows.rs` | copied into `adsb-data-engine/examples/` by `purge`, then removed |

## Verification status of this skill

Confirmed working in the session that authored it (macOS 15, Node 22,
Rust 1.92): `backup`, `baseline`, `feed`, `purge`, `selftest`, and the full
manual flow — app launched, feed consumed, six aircraft rendered on the map,
merge assertions passing against live `getTrajectory` output, rows purged back
to an exact row-count match with the pre-run baseline.

`wait` has been confirmed on its timeout path; its success path and
`verify`/`summary` against a live app were exercised manually rather than
through the driver, and their parsers are covered by `selftest` fixtures taken
from real responses.

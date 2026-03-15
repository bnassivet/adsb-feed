# Rolling Persistence Database — Swap DB to Snapshot

## Context

The DuckDB database (`adsb_history.db`) grows continuously as aircraft positions are recorded. Users need a way to "rotate" the database — archiving the current data as a timestamped snapshot and starting fresh — so snapshots can be moved to external storage. This is analogous to log rotation.

Currently, the app supports **release/reclaim** (drop and reopen the same DB) and **export** (copy via ATTACH without stopping). The new "swap" operation needs: checkpoint → swap to pre-created fresh DB → rename old file to snapshot. **Zero data loss required** — no batches dropped during the swap.

## Approach

### Zero-Loss Atomic Swap

The `relay_messages` task in `bridge.rs` calls `persist_batch(&storage, ...)` every 500ms, taking a read-lock on `SharedStorage`. Between flushes, messages accumulate in its in-memory `HashMap` buffer (and in the `broadcast::channel`).

**Key insight**: If we swap the `StorageHandle` atomically (old → new, never `None`), `persist_batch` always has a valid handle — zero batches dropped.

### Pre-Created Fresh DB

The fresh empty DB is opened at a **staging path** (`adsb_history_next.db`) *before* taking the write-lock. This way the write-lock is held only for the instant of swapping the two handles — the expensive work (schema creation, file I/O) happens outside the lock.

### Rename, Don't Copy

Since `snapshots/` is a subdirectory of `app_data_dir` (same filesystem), `fs::rename()` is atomic and instant regardless of DB size.

### Swap Sequence (detail)

```
1. Pre-create fresh StorageHandle at staging path (adsb_history_next.db)
2. Write-lock SharedStorage:
   a. Take out old handle (Option::take)
   b. Insert pre-created handle
   → relay_messages immediately persists to new DB on next flush
3. Release write-lock
4. Checkpoint old handle (async, outside lock — no rush)
5. Drop old handle (closes connection, releases file lock on adsb_history.db)
6. Rename adsb_history.db → snapshots/adsb_history_{timestamp}.db
7. Rename adsb_history_next.db → adsb_history.db
   (Unix: safe to rename under open fd — connection still works via inode)
8. Return snapshot path
```

**Why this is zero-loss**: The `SharedStorage` is never `None`. Step 2a→2b is a single write-lock operation swapping `Some(old)` → `Some(new)`. The relay task's next `persist_batch` call takes a read-lock and writes to the new DB. Any batches accumulated during the lock wait are preserved in the HashMap buffer.

## Implementation

### Step 1: `move_database_to_snapshot()` in adsb-data-engine

**File:** `adsb-data-engine/src/storage.rs`

Add a free function (not a method — the connection must be closed before calling):

```rust
pub fn move_database_to_snapshot(
    db_path: &Path,
    snapshot_path: &Path,
) -> Result<(), StorageError>
```

Logic:
1. Create parent dirs for `snapshot_path`
2. `fs::rename(db_path, snapshot_path)`
3. Also rename `.wal` file if it exists (`db_path.with_extension("db.wal")`)

**Re-export** from `adsb-data-engine/src/lib.rs`: `pub use storage::move_database_to_snapshot;`

**Tests** (4 unit tests in `storage.rs`):
- `test_move_database_to_snapshot_renames_file`
- `test_move_database_to_snapshot_creates_parent_dirs`
- `test_move_database_to_snapshot_moves_wal_file`
- `test_move_database_to_snapshot_missing_source_returns_error`

### Step 2: `swap_database` Tauri command

**File:** `src-tauri/src/commands.rs`

```rust
#[tauri::command]
pub async fn swap_database(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<String, String>  // Returns snapshot path
```

Sequence:
1. Read `db_path` from `state.storage_config` (bail if None or in-memory)
2. Build snapshot path: `{db_parent}/snapshots/adsb_history_{timestamp}.db` (`%Y-%m-%dT%H-%M-%S%.3f`)
3. Build staging path: `{db_parent}/adsb_history_next.db`
4. **Pre-create**: `StorageHandle::open(staging_config)` — fresh empty DB with schema, outside any lock
5. **Write-lock `state.storage`**:
   - `let old_handle = guard.take()` — extract old handle
   - `*guard = Some(new_handle)` — insert pre-created handle
6. **Release write-lock** — relay_messages resumes immediately with new DB
7. If old_handle exists: `old_handle.checkpoint().await` (flushes WAL)
8. Drop old_handle (closes connection, releases file lock)
9. `spawn_blocking` → `move_database_to_snapshot(db_path, snapshot_path)` (rename old DB)
10. `spawn_blocking` → `fs::rename(staging_path, db_path)` (rename staging → canonical)
11. Emit `adsb:storage-status` → `Available` (in case UI needs refresh)
12. Return snapshot path

**Register** in `lib.rs` invoke_handler: `commands::swap_database,`

Uses `chrono` (already a dependency) for timestamp formatting.

### Step 3: TypeScript command wrapper

**File:** `src/lib/commands.ts`

```typescript
export async function swapDatabase(): Promise<string> {
  return invoke("swap_database");
}
```

**Test** in `src/lib/__tests__/commands.test.ts`: verify it invokes correctly and returns the snapshot path.

### Step 4: "Swap DB" button in MetricsBar

**File:** `src/components/MetricsBar.tsx`

New props: `onSwapDatabase?: () => void`, `isSwapping?: boolean`

Button rendered when `storageStatus === "available"`, between DB release and Export buttons. Shows a rotate/swap icon + "Swap DB" label (or "Swapping..." when active).

**Tests** in `src/components/__tests__/MetricsBar.test.tsx` (4 tests):
- Shows button when storage available
- Calls callback on click
- Shows "Swapping..." text and disables during swap
- Hides button when storage is released

### Step 5: Wire up in page.tsx

**File:** `src/app/page.tsx`

- Add `isSwapping` state
- Add `handleSwapDatabase` callback that calls `swapDatabase()`, manages loading state
- Pass `onSwapDatabase` and `isSwapping` to `MetricsBar`

## Critical Files

| File | Change |
|------|--------|
| `adsb-data-engine/src/storage.rs` | Add `move_database_to_snapshot()` + 4 tests |
| `adsb-data-engine/src/lib.rs` | Re-export `move_database_to_snapshot` |
| `src-tauri/src/commands.rs` | Add `swap_database` command |
| `src-tauri/src/lib.rs` | Register `swap_database` in invoke_handler |
| `src/lib/commands.ts` | Add `swapDatabase()` wrapper |
| `src/lib/__tests__/commands.test.ts` | Test for `swapDatabase` |
| `src/components/MetricsBar.tsx` | Add Swap DB button |
| `src/components/__tests__/MetricsBar.test.tsx` | 4 button tests |
| `src/app/page.tsx` | Wire handler + state |

## Edge Cases

- **Zero data loss**: `SharedStorage` is never `None` during swap — old→new handle swap is atomic under write-lock. Batches accumulated during the brief lock wait are preserved in the relay_messages HashMap buffer and flushed to the new DB.
- **Pre-created DB performance**: Fresh DB opened at staging path before taking write-lock. Schema creation and file I/O don't block the relay task.
- **WAL file**: Explicitly handled — renamed alongside the main `.db` file.
- **Rename under open fd** (step 10): Safe on Unix — DuckDB connection holds an fd to the inode, not the pathname. After renaming staging→canonical, the connection still works and subsequent reclaim/swap uses the correct `adsb_history.db` path.
- **Naming collision**: Millisecond-precision timestamp (`%.3f`) makes collisions practically impossible.
- **Concurrent clicks**: `isSwapping` disables the button. On the Rust side, the write-lock serializes concurrent swap attempts.
- **Disk space**: `rename` is a metadata op — no extra space needed (only the staging DB adds ~few KB for empty schema).
- **Crash between steps 9-10**: Old DB already in snapshots, staging file at `adsb_history_next.db`. On next app launch, `init_storage` opens `adsb_history.db` — if missing, it creates a fresh one. Staging file is orphaned but harmless.

## Verification

1. `cargo test -p adsb-data-engine` — new `move_database_to_snapshot` tests pass
2. `cargo test --workspace && cargo clippy --workspace -- -D warnings && cargo fmt --workspace --check`
3. `npm test` — new commands + MetricsBar tests pass
4. Manual: `npm run tauri dev` → start feed → record data → click "Swap DB" → verify:
   - New empty DB created at original path (stats show 0 rows)
   - Snapshot file exists in `snapshots/` directory with previous data
   - Recording resumes into fresh DB immediately
   - No gap in recorded data (compare last timestamp in snapshot vs first in new DB)

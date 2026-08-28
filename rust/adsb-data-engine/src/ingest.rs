//! Shared SBS-1 ingest pipeline.
//!
//! This is the parse → merge → throttle → persist path that turns a stream of
//! raw SBS-1 lines into `AircraftPosition` batches. It lives here, in the data
//! engine, rather than in any one consumer, because **two** processes need it
//! and they must not drift: the Tauri desktop app and the headless
//! `adsb-data-server` daemon on the Raspberry Pi.
//!
//! The only thing the two consumers disagree about is what to do with a flushed
//! batch — the desktop emits it to the webview, the daemon does not — so that
//! single difference is abstracted behind [`BatchSink`]. Everything else, in
//! particular [`merge_into_buffer`], is shared.
//!
//! # Why the buffer merges rather than inserts
//!
//! SBS-1 splits one aircraft's state across message subtypes (MSG1 carries the
//! callsign, MSG3 the position, MSG4 the speed). A blind `HashMap::insert`
//! would overwrite a MSG3's latitude/longitude with the `None`s of a MSG1
//! arriving later in the same flush window. `merge_into_buffer` keeps the
//! best-known state per aircraft, which is why it is the most test-covered
//! function in this module.

use crate::sbs_parser::{
    AircraftPosition, extract_sbs_timestamp, parse_sbs_message, parse_sbs_raw_fields,
};
use crate::storage::StorageHandle;
use crate::types::RawSbsRecord;
use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use tokio::sync::{RwLock, broadcast};
use tokio::time::{Duration, Instant, interval};
use tracing::warn;

/// Shared DuckDB storage: `Arc<RwLock<Option<StorageHandle>>>`.
///
/// `None` means storage is unavailable or was intentionally released; every
/// write path treats that as a silent no-op rather than an error, so the feed
/// keeps running in real-time-only mode.
pub type SharedStorage = Arc<RwLock<Option<StorageHandle>>>;

/// Receives each flushed batch of merged aircraft positions.
///
/// The one place the desktop app and the headless daemon differ: the desktop
/// emits the batch to the webview, the daemon discards it (it has already been
/// persisted). Implementations must not block — they run on the flush path.
pub trait BatchSink: Send {
    /// Called once per flush with the merged positions for that window.
    fn on_positions(&self, batch: &[AircraftPosition]);
}

/// A [`BatchSink`] that discards batches. Used by the headless daemon, whose
/// only consumer of the data is DuckDB.
pub struct NoopSink;

impl BatchSink for NoopSink {
    fn on_positions(&self, _batch: &[AircraftPosition]) {}
}

/// Static configuration for an [`IngestPipeline`].
#[derive(Debug, Clone)]
pub struct IngestConfig {
    /// Identifier for this receiver, stamped onto every raw record.
    pub source_id: String,
    /// Timezone of the dump1090 timestamps, passed through to storage.
    pub dump1090_tz: String,
    /// How often the buffer is flushed. 500 ms in production (~2 updates/sec).
    pub flush_interval: Duration,
}

impl Default for IngestConfig {
    fn default() -> Self {
        Self {
            source_id: String::new(),
            dump1090_tz: "Local".to_string(),
            flush_interval: Duration::from_millis(500),
        }
    }
}

/// Parses, merges and persists a stream of raw SBS-1 lines.
pub struct IngestPipeline {
    storage: SharedStorage,
    config: IngestConfig,
    record_positions: Arc<AtomicBool>,
    record_raw: Arc<AtomicBool>,
    messages_parsed: Arc<AtomicU64>,
    last_message_time: Arc<RwLock<Instant>>,
}

impl IngestPipeline {
    /// Creates a pipeline writing to `storage`.
    ///
    /// Both recording toggles start enabled; callers that expose them in a UI
    /// should share the handles returned by [`Self::record_positions`] and
    /// [`Self::record_raw`].
    pub fn new(storage: SharedStorage, config: IngestConfig) -> Self {
        Self {
            storage,
            config,
            record_positions: Arc::new(AtomicBool::new(true)),
            record_raw: Arc::new(AtomicBool::new(true)),
            messages_parsed: Arc::new(AtomicU64::new(0)),
            last_message_time: Arc::new(RwLock::new(Instant::now())),
        }
    }

    /// Replaces the position-recording toggle with a caller-owned handle.
    pub fn with_record_positions(mut self, flag: Arc<AtomicBool>) -> Self {
        self.record_positions = flag;
        self
    }

    /// Replaces the raw-recording toggle with a caller-owned handle.
    pub fn with_record_raw(mut self, flag: Arc<AtomicBool>) -> Self {
        self.record_raw = flag;
        self
    }

    /// Replaces the parsed-message counter with a caller-owned handle.
    pub fn with_messages_parsed(mut self, counter: Arc<AtomicU64>) -> Self {
        self.messages_parsed = counter;
        self
    }

    /// Replaces the activity clock with a caller-owned handle.
    ///
    /// Consumers drive connection-liveness UI from this: it is updated on every
    /// received line, whether or not the line parses.
    pub fn with_last_message_time(mut self, clock: Arc<RwLock<Instant>>) -> Self {
        self.last_message_time = clock;
        self
    }

    /// Handle to the position-recording toggle.
    pub fn record_positions(&self) -> Arc<AtomicBool> {
        Arc::clone(&self.record_positions)
    }

    /// Handle to the raw-recording toggle.
    pub fn record_raw(&self) -> Arc<AtomicBool> {
        Arc::clone(&self.record_raw)
    }

    /// Handle to the parsed-message counter.
    pub fn messages_parsed(&self) -> Arc<AtomicU64> {
        Arc::clone(&self.messages_parsed)
    }

    /// Handle to the activity clock.
    pub fn last_message_time(&self) -> Arc<RwLock<Instant>> {
        Arc::clone(&self.last_message_time)
    }

    /// The pipeline's configuration.
    pub fn config(&self) -> &IngestConfig {
        &self.config
    }

    /// Runs until the message channel closes.
    ///
    /// Buffers incoming lines by `hex_ident`, keeping the best-known state per
    /// aircraft, and flushes every `flush_interval`. Each flush persists to
    /// DuckDB (when the corresponding toggle is on and storage is attached) and
    /// hands the batch to `sink`.
    pub async fn run(self, mut rx: broadcast::Receiver<Vec<u8>>, sink: impl BatchSink) {
        let mut flush_interval = interval(self.config.flush_interval);
        let mut buffer: HashMap<String, AircraftPosition> = HashMap::new();
        let mut message_counts: HashMap<String, u64> = HashMap::new();
        let mut raw_buffer: Vec<RawSbsRecord> = Vec::new();

        loop {
            tokio::select! {
                msg = rx.recv() => {
                    match msg {
                        Ok(data) => {
                            *self.last_message_time.write().await = Instant::now();
                            self.absorb(&data, &mut buffer, &mut message_counts, &mut raw_buffer);
                        }
                        Err(broadcast::error::RecvError::Lagged(n)) => {
                            warn!("Ingest lagged, skipped {} messages", n);
                        }
                        Err(broadcast::error::RecvError::Closed) => {
                            self.flush(&mut buffer, &mut message_counts, &mut raw_buffer, &sink).await;
                            break;
                        }
                    }
                }
                _ = flush_interval.tick() => {
                    self.flush(&mut buffer, &mut message_counts, &mut raw_buffer, &sink).await;
                }
            }
        }
    }

    /// Parses one received line into the position and raw buffers.
    fn absorb(
        &self,
        data: &[u8],
        buffer: &mut HashMap<String, AircraftPosition>,
        message_counts: &mut HashMap<String, u64>,
        raw_buffer: &mut Vec<RawSbsRecord>,
    ) {
        let Ok(line) = std::str::from_utf8(data) else {
            return;
        };

        // Collect the raw message for audit/replay before parsing, so a line
        // that fails position parsing is still recoverable from the archive.
        if let Some((hex, msg_type, trans_type)) = parse_sbs_raw_fields(line)
            && let Some(ts) = extract_sbs_timestamp(line)
        {
            raw_buffer.push(RawSbsRecord {
                hex_ident: hex,
                msg_type,
                transmission_type: trans_type,
                timestamp: ts,
                timestamp_ms: 0,
                raw_message: line.to_string(),
                source_id: self.config.source_id.clone(),
            });
        }

        if let Some(pos) = parse_sbs_message(line) {
            self.messages_parsed.fetch_add(1, Ordering::Relaxed);
            *message_counts.entry(pos.hex_ident.clone()).or_insert(0) += 1;
            merge_into_buffer(buffer, pos);
        }
    }

    /// Drains both buffers: persists, then hands positions to the sink.
    async fn flush(
        &self,
        buffer: &mut HashMap<String, AircraftPosition>,
        message_counts: &mut HashMap<String, u64>,
        raw_buffer: &mut Vec<RawSbsRecord>,
        sink: &impl BatchSink,
    ) {
        if !buffer.is_empty() {
            let mut batch: Vec<AircraftPosition> = buffer.drain().map(|(_, v)| v).collect();
            for pos in &mut batch {
                if let Some(count) = message_counts.remove(&pos.hex_ident) {
                    pos.message_count = count;
                }
            }
            if self.record_positions.load(Ordering::Relaxed) {
                self.persist_batch(&batch).await;
            }
            sink.on_positions(&batch);
        }

        if self.record_raw.load(Ordering::Relaxed) {
            self.persist_raw_batch(raw_buffer).await;
        }
        raw_buffer.clear();
    }

    /// Persists positions to DuckDB. Non-fatal: a failure is logged, and a
    /// released or unavailable store silently drops the batch so the live feed
    /// never stalls on the recorder.
    async fn persist_batch(&self, batch: &[AircraftPosition]) {
        let guard = self.storage.read().await;
        if let Some(ref s) = *guard
            && let Err(e) = s
                .insert_batch(batch.to_vec(), self.config.dump1090_tz.clone())
                .await
        {
            warn!("Storage insert failed: {e}");
        }
    }

    /// Persists raw SBS-1 records to DuckDB (non-fatal on failure).
    async fn persist_raw_batch(&self, batch: &[RawSbsRecord]) {
        if batch.is_empty() {
            return;
        }
        let guard = self.storage.read().await;
        if let Some(ref s) = *guard
            && let Err(e) = s
                .insert_raw_batch(batch.to_vec(), self.config.dump1090_tz.clone())
                .await
        {
            warn!("Raw storage insert failed: {e}");
        }
    }
}

/// Merges a newly parsed SBS position into the buffer, preserving non-null
/// fields from the existing entry.
///
/// SBS-1 splits aircraft data across message subtypes (MSG1 = callsign,
/// MSG3 = position, MSG4 = speed). A blind `insert` would overwrite a MSG3's
/// lat/lon with nulls if a MSG1 arrives afterward in the same flush window.
/// This keeps the best-known state per aircraft.
pub fn merge_into_buffer(buffer: &mut HashMap<String, AircraftPosition>, new: AircraftPosition) {
    match buffer.get_mut(&new.hex_ident) {
        Some(existing) => {
            existing.callsign = new.callsign.or(existing.callsign.take());
            existing.altitude = new.altitude.or(existing.altitude);
            existing.ground_speed = new.ground_speed.or(existing.ground_speed);
            existing.track = new.track.or(existing.track);
            existing.latitude = new.latitude.or(existing.latitude);
            existing.longitude = new.longitude.or(existing.longitude);
            existing.vertical_rate = new.vertical_rate.or(existing.vertical_rate);
            existing.squawk = new.squawk.or(existing.squawk.take());
            existing.is_on_ground = new.is_on_ground.or(existing.is_on_ground);
            existing.timestamp = new.timestamp;
        }
        None => {
            buffer.insert(new.hex_ident.clone(), new);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    use crate::types::{RawMessageQuery, StorageConfig};

    const SAMPLE_MSG3: &str = "MSG,3,1,1,A1B2C3,1,2024/01/15,10:30:00.000,2024/01/15,10:30:00.000,,35000,,,45.5017,-73.5673,,,,,,0";
    const SAMPLE_MSG1: &str =
        "MSG,1,1,1,A1B2C3,1,2024/01/15,10:30:01.000,2024/01/15,10:30:01.000,AFR123 ,,,,,,,,,,,0";

    fn make_pos(hex: &str) -> AircraftPosition {
        AircraftPosition {
            hex_ident: hex.to_string(),
            callsign: None,
            altitude: None,
            ground_speed: None,
            track: None,
            latitude: None,
            longitude: None,
            vertical_rate: None,
            squawk: None,
            is_on_ground: None,
            timestamp: "2024-01-01 00:00:00".to_string(),
            message_count: 0,
        }
    }

    #[test]
    fn merge_inserts_new_aircraft() {
        let mut buffer = HashMap::new();
        let pos = AircraftPosition {
            latitude: Some(48.8),
            longitude: Some(2.3),
            ..make_pos("ABC123")
        };
        merge_into_buffer(&mut buffer, pos);

        assert_eq!(buffer.len(), 1);
        let entry = &buffer["ABC123"];
        assert_eq!(entry.latitude, Some(48.8));
        assert_eq!(entry.longitude, Some(2.3));
    }

    #[test]
    fn merge_preserves_position_when_non_position_msg_arrives() {
        // MSG3 arrives with lat/lon, then MSG1 arrives with callsign but no lat/lon
        let mut buffer = HashMap::new();

        let msg3 = AircraftPosition {
            latitude: Some(48.8),
            longitude: Some(2.3),
            altitude: Some(35000.0),
            timestamp: "2024-01-01 00:00:00".to_string(),
            ..make_pos("ABC123")
        };
        merge_into_buffer(&mut buffer, msg3);

        let msg1 = AircraftPosition {
            callsign: Some("BAW123".to_string()),
            timestamp: "2024-01-01 00:00:01".to_string(),
            ..make_pos("ABC123")
        };
        merge_into_buffer(&mut buffer, msg1);

        let entry = &buffer["ABC123"];
        assert_eq!(entry.latitude, Some(48.8), "lat must survive MSG1 merge");
        assert_eq!(entry.longitude, Some(2.3), "lon must survive MSG1 merge");
        assert_eq!(entry.altitude, Some(35000.0), "alt must survive MSG1 merge");
        assert_eq!(
            entry.callsign.as_deref(),
            Some("BAW123"),
            "callsign from MSG1"
        );
        assert_eq!(entry.timestamp, "2024-01-01 00:00:01", "timestamp updated");
    }

    #[test]
    fn merge_updates_position_with_newer_values() {
        let mut buffer = HashMap::new();

        let first = AircraftPosition {
            latitude: Some(48.8),
            longitude: Some(2.3),
            ..make_pos("ABC123")
        };
        merge_into_buffer(&mut buffer, first);

        let second = AircraftPosition {
            latitude: Some(49.0),
            longitude: Some(2.5),
            timestamp: "2024-01-01 00:00:02".to_string(),
            ..make_pos("ABC123")
        };
        merge_into_buffer(&mut buffer, second);

        let entry = &buffer["ABC123"];
        assert_eq!(entry.latitude, Some(49.0));
        assert_eq!(entry.longitude, Some(2.5));
    }

    #[test]
    fn merge_preserves_squawk_string_field() {
        let mut buffer = HashMap::new();

        let msg = AircraftPosition {
            squawk: Some("7700".to_string()),
            ..make_pos("ABC123")
        };
        merge_into_buffer(&mut buffer, msg);

        // Next message has no squawk
        let msg2 = AircraftPosition {
            altitude: Some(10000.0),
            ..make_pos("ABC123")
        };
        merge_into_buffer(&mut buffer, msg2);

        let entry = &buffer["ABC123"];
        assert_eq!(entry.squawk.as_deref(), Some("7700"), "squawk must survive");
        assert_eq!(entry.altitude, Some(10000.0));
    }

    #[test]
    fn merge_handles_multiple_aircraft_independently() {
        let mut buffer = HashMap::new();

        merge_into_buffer(
            &mut buffer,
            AircraftPosition {
                latitude: Some(48.8),
                ..make_pos("AAA")
            },
        );
        merge_into_buffer(
            &mut buffer,
            AircraftPosition {
                latitude: Some(51.5),
                ..make_pos("BBB")
            },
        );

        assert_eq!(buffer.len(), 2);
        assert_eq!(buffer["AAA"].latitude, Some(48.8));
        assert_eq!(buffer["BBB"].latitude, Some(51.5));
    }

    // --- Pipeline behaviour (extracted from bridge.rs::relay_messages) ---

    /// Records every batch a pipeline flushes, so tests can assert on the
    /// throttled output without a Tauri AppHandle or a DuckDB file.
    #[derive(Clone, Default)]
    struct RecordingSink {
        batches: Arc<std::sync::Mutex<Vec<Vec<AircraftPosition>>>>,
    }

    impl RecordingSink {
        fn batches(&self) -> Vec<Vec<AircraftPosition>> {
            self.batches.lock().unwrap().clone()
        }
    }

    impl BatchSink for RecordingSink {
        fn on_positions(&self, batch: &[AircraftPosition]) {
            self.batches.lock().unwrap().push(batch.to_vec());
        }
    }

    fn test_pipeline(storage: SharedStorage) -> IngestPipeline {
        IngestPipeline::new(
            storage,
            IngestConfig {
                source_id: "test-node".to_string(),
                dump1090_tz: "UTC".to_string(),
                flush_interval: Duration::from_millis(20),
            },
        )
    }

    fn no_storage() -> SharedStorage {
        Arc::new(RwLock::new(None))
    }

    #[tokio::test]
    async fn pipeline_flushes_parsed_positions_to_sink() {
        let (tx, rx) = broadcast::channel(64);
        let sink = RecordingSink::default();
        let pipeline = test_pipeline(no_storage());
        let sink_for_assert = sink.clone();

        tx.send(SAMPLE_MSG3.as_bytes().to_vec()).unwrap();
        drop(tx); // closes the channel so run() flushes and returns

        pipeline.run(rx, sink).await;

        let batches = sink_for_assert.batches();
        assert_eq!(batches.len(), 1, "expected one flush, got {:?}", batches);
        assert_eq!(batches[0].len(), 1);
        assert_eq!(batches[0][0].hex_ident, "A1B2C3");
    }

    #[tokio::test]
    async fn pipeline_merges_multiple_subtypes_into_one_aircraft() {
        // The whole point of the buffer: MSG1 (callsign) must not erase the
        // position a MSG3 established in the same flush window.
        let (tx, rx) = broadcast::channel(64);
        let sink = RecordingSink::default();
        let sink_for_assert = sink.clone();

        tx.send(SAMPLE_MSG3.as_bytes().to_vec()).unwrap();
        tx.send(SAMPLE_MSG1.as_bytes().to_vec()).unwrap();
        drop(tx);

        test_pipeline(no_storage()).run(rx, sink).await;

        let batches = sink_for_assert.batches();
        let flat: Vec<_> = batches.into_iter().flatten().collect();
        assert_eq!(flat.len(), 1, "two subtypes must merge into one aircraft");
        assert!(flat[0].latitude.is_some(), "MSG1 erased the MSG3 position");
        assert!(flat[0].callsign.is_some(), "callsign was lost");
    }

    #[tokio::test]
    async fn pipeline_attaches_message_counts() {
        let (tx, rx) = broadcast::channel(64);
        let sink = RecordingSink::default();
        let sink_for_assert = sink.clone();

        for _ in 0..3 {
            tx.send(SAMPLE_MSG3.as_bytes().to_vec()).unwrap();
        }
        drop(tx);

        test_pipeline(no_storage()).run(rx, sink).await;

        let flat: Vec<_> = sink_for_assert.batches().into_iter().flatten().collect();
        assert_eq!(flat.len(), 1);
        assert_eq!(flat[0].message_count, 3);
    }

    #[tokio::test]
    async fn pipeline_counts_parsed_messages() {
        let (tx, rx) = broadcast::channel(64);
        let pipeline = test_pipeline(no_storage());
        let counter = pipeline.messages_parsed();

        tx.send(SAMPLE_MSG3.as_bytes().to_vec()).unwrap();
        tx.send(b"not an sbs line".to_vec()).unwrap();
        drop(tx);

        pipeline.run(rx, RecordingSink::default()).await;

        assert_eq!(counter.load(Ordering::Relaxed), 1, "only valid lines count");
    }

    #[tokio::test]
    async fn pipeline_survives_unparseable_input() {
        let (tx, rx) = broadcast::channel(64);
        let sink = RecordingSink::default();
        let sink_for_assert = sink.clone();

        tx.send(b"garbage".to_vec()).unwrap();
        tx.send(vec![0xff, 0xfe]).unwrap(); // invalid UTF-8
        tx.send(SAMPLE_MSG3.as_bytes().to_vec()).unwrap();
        drop(tx);

        test_pipeline(no_storage()).run(rx, sink).await;

        let flat: Vec<_> = sink_for_assert.batches().into_iter().flatten().collect();
        assert_eq!(flat.len(), 1, "valid line must still arrive");
    }

    #[tokio::test]
    async fn pipeline_updates_last_message_time() {
        let (tx, rx) = broadcast::channel(64);
        let pipeline = test_pipeline(no_storage());
        let last_seen = pipeline.last_message_time();
        let before = *last_seen.read().await;

        tokio::time::sleep(Duration::from_millis(5)).await;
        tx.send(SAMPLE_MSG3.as_bytes().to_vec()).unwrap();
        drop(tx);

        pipeline.run(rx, RecordingSink::default()).await;

        assert!(
            *last_seen.read().await > before,
            "watchdog clock must advance on traffic"
        );
    }

    #[tokio::test]
    async fn pipeline_respects_record_positions_toggle() {
        // With no storage attached this only proves the toggle is readable and
        // does not panic; persistence itself is covered by storage tests.
        let (tx, rx) = broadcast::channel(64);
        let pipeline = test_pipeline(no_storage());
        pipeline.record_positions().store(false, Ordering::Relaxed);
        let sink = RecordingSink::default();
        let sink_for_assert = sink.clone();

        tx.send(SAMPLE_MSG3.as_bytes().to_vec()).unwrap();
        drop(tx);

        pipeline.run(rx, sink).await;

        // The sink still receives the batch: the toggle gates DuckDB writes,
        // not the live UI feed.
        assert_eq!(sink_for_assert.batches().len(), 1);
    }

    /// The desktop app used to write `source_id: String::new()` on every raw
    /// record. A multi-node fleet cannot tell receivers apart that way, so the
    /// pipeline stamps the configured id — proven here by round-tripping
    /// through a real in-memory DuckDB rather than by inspecting config.
    #[tokio::test]
    async fn raw_records_carry_the_configured_source_id() {
        let storage = StorageHandle::open(StorageConfig {
            db_path: None,
            source_id: "test-node".to_string(),
            gap_threshold_ms: 3_600_000,
            share: None,
        })
        .expect("in-memory storage");
        let shared: SharedStorage = Arc::new(RwLock::new(Some(storage.clone())));

        let (tx, rx) = broadcast::channel(64);
        tx.send(SAMPLE_MSG3.as_bytes().to_vec()).unwrap();
        drop(tx);

        test_pipeline(shared).run(rx, NoopSink).await;

        let raw = storage
            .query_raw_messages_sync(RawMessageQuery {
                hex_ident: "A1B2C3".to_string(),
                start_ms: 0,
                end_ms: i64::MAX,
            })
            .expect("query raw messages");

        assert!(!raw.is_empty(), "raw message was not persisted");
        assert_eq!(raw[0].source_id, "test-node");
    }
}

//! Wires a live SBS-1 source to the shared ingest pipeline.

use adsb_data_engine::{
    IngestConfig, IngestPipeline, NoopSink, SharedStorage, StorageConfig, StorageHandle,
};
use adsb_pulsar_client::source::MessageSource;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::RwLock;
use tracing::{info, warn};

/// Configuration for a [`Recorder`].
#[derive(Debug, Clone)]
pub struct RecorderConfig {
    /// Where DuckDB writes. `None` is in-memory (tests).
    pub storage: StorageConfig,
    /// Timezone of the incoming dump1090 timestamps.
    pub dump1090_tz: String,
    /// How often to checkpoint DuckDB. `None` disables the maintenance loop.
    pub checkpoint_interval: Option<Duration>,
    /// Drop positions older than this on each maintenance tick. `None` keeps
    /// everything — the right default for an edge recorder whose whole purpose
    /// is history.
    pub retention: Option<Duration>,
}

impl Default for RecorderConfig {
    fn default() -> Self {
        Self {
            storage: StorageConfig::default(),
            dump1090_tz: "Local".to_string(),
            checkpoint_interval: Some(Duration::from_secs(300)),
            retention: None,
        }
    }
}

/// Owns the database and records whatever a [`MessageSource`] delivers.
pub struct Recorder {
    storage: SharedStorage,
    config: RecorderConfig,
}

impl Recorder {
    /// Opens the database and prepares to record.
    ///
    /// Opening is the point at which this process takes DuckDB's exclusive
    /// lock, so a failure here is fatal rather than degraded: unlike the
    /// desktop app, a recorder with no storage has no reason to exist.
    pub fn open(config: RecorderConfig) -> Result<Self, adsb_data_engine::StorageError> {
        let handle = StorageHandle::open(config.storage.clone())?;
        info!(
            "Opened database at {}",
            config
                .storage
                .db_path
                .as_ref()
                .map(|p| p.display().to_string())
                .unwrap_or_else(|| "<in-memory>".to_string())
        );
        Ok(Self {
            storage: Arc::new(RwLock::new(Some(handle))),
            config,
        })
    }

    /// Handle to the shared storage, for the serving surfaces.
    pub fn storage(&self) -> SharedStorage {
        Arc::clone(&self.storage)
    }

    /// Runs the source and the ingest pipeline until the source ends.
    ///
    /// The pipeline uses [`NoopSink`]: a recorder has no second consumer for a
    /// flushed batch — it has already been persisted. The desktop app supplies
    /// an emit sink instead; that is the only difference between the two.
    pub async fn run(&self, mut source: impl MessageSource + 'static) -> anyhow::Result<()> {
        let rx = source.subscribe(4096);

        let pipeline = IngestPipeline::new(
            self.storage(),
            IngestConfig {
                source_id: self.config.storage.source_id.clone(),
                dump1090_tz: self.config.dump1090_tz.clone(),
                flush_interval: Duration::from_millis(500),
            },
        );

        let name = source.name().to_string();
        info!("Recording from '{}' source", name);

        let ingest = tokio::spawn(async move { pipeline.run(rx, NoopSink).await });
        let maintenance = self.spawn_maintenance();

        let result = source.run().await;
        ingest.abort();
        maintenance.abort();

        result.map_err(Into::into)
    }

    /// Periodic `CHECKPOINT`, and pruning when a retention window is set.
    ///
    /// Checkpointing matters more here than in the desktop app: an edge node
    /// can lose power without a clean shutdown, and an unbounded WAL is both
    /// slow to replay and awkward for anything reading the file over Quack.
    fn spawn_maintenance(&self) -> tokio::task::JoinHandle<()> {
        let Some(interval) = self.config.checkpoint_interval else {
            return tokio::spawn(async {});
        };
        let storage = self.storage();
        let retention = self.config.retention;

        tokio::spawn(async move {
            let mut tick = tokio::time::interval(interval);
            tick.tick().await; // the first tick fires immediately; skip it
            loop {
                tick.tick().await;
                let guard = storage.read().await;
                let Some(s) = guard.as_ref() else { continue };

                if let Some(window) = retention {
                    let cutoff = chrono_now_ms() - window.as_millis() as i64;
                    match s.prune(cutoff).await {
                        Ok(n) if n > 0 => info!("Pruned {n} rows older than retention"),
                        Ok(_) => {}
                        Err(e) => warn!("Prune failed: {e}"),
                    }
                }
                if let Err(e) = s.checkpoint().await {
                    warn!("Checkpoint failed: {e}");
                }
            }
        })
    }
}

fn chrono_now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use adsb_data_engine::{BboxQuery, RawMessageQuery};
    use adsb_pulsar_client::source::{MessageSource, SourceStatus};
    use tokio::sync::{broadcast, watch};

    const MSG3: &str = "MSG,3,1,1,A1B2C3,1,2024/01/15,10:30:00.000,2024/01/15,10:30:00.000,,35000,,,45.5017,-73.5673,,,,,,0";
    const MSG1: &str =
        "MSG,1,1,1,A1B2C3,1,2024/01/15,10:30:01.000,2024/01/15,10:30:01.000,AFR123 ,,,,,,,,,,,0";

    /// A source that replays canned lines then ends, standing in for MQTT.
    struct ScriptedSource {
        lines: Vec<&'static str>,
        tx: Option<broadcast::Sender<Vec<u8>>>,
        status: watch::Sender<SourceStatus>,
        status_rx: watch::Receiver<SourceStatus>,
    }

    impl ScriptedSource {
        fn new(lines: Vec<&'static str>) -> Self {
            let (status, status_rx) = watch::channel(SourceStatus::Disconnected);
            Self {
                lines,
                tx: None,
                status,
                status_rx,
            }
        }
    }

    #[async_trait::async_trait]
    impl MessageSource for ScriptedSource {
        fn subscribe(&mut self, capacity: usize) -> broadcast::Receiver<Vec<u8>> {
            let (tx, rx) = broadcast::channel(capacity);
            self.tx = Some(tx);
            rx
        }
        fn status(&self) -> watch::Receiver<SourceStatus> {
            self.status_rx.clone()
        }
        async fn run(&mut self) -> adsb_pulsar_client::error::Result<()> {
            let _ = self.status.send(SourceStatus::Connected);
            if let Some(tx) = &self.tx {
                for l in &self.lines {
                    let _ = tx.send(l.as_bytes().to_vec());
                }
            }
            // Let the pipeline flush before the source ends.
            tokio::time::sleep(Duration::from_millis(700)).await;
            Ok(())
        }
        fn shutdown(&self) {}
        fn name(&self) -> &str {
            "scripted"
        }
    }

    fn in_memory() -> RecorderConfig {
        RecorderConfig {
            storage: StorageConfig {
                db_path: None,
                source_id: "test-edge".to_string(),
                gap_threshold_ms: 3_600_000,
                share: None,
                remote: None,
            },
            dump1090_tz: "UTC".to_string(),
            checkpoint_interval: None,
            retention: None,
        }
    }

    #[tokio::test]
    async fn recorder_opens_storage() {
        let r = Recorder::open(in_memory()).expect("open");
        assert!(r.storage().read().await.is_some());
    }

    #[tokio::test]
    async fn recorder_persists_positions_from_a_source() {
        let r = Recorder::open(in_memory()).expect("open");
        r.run(ScriptedSource::new(vec![MSG3])).await.expect("run");

        let storage = r.storage();
        let guard = storage.read().await;
        let rows = guard
            .as_ref()
            .unwrap()
            .query_bbox_sync(BboxQuery {
                north: 90.0,
                south: -90.0,
                east: 180.0,
                west: -180.0,
                start_ms: None,
                end_ms: None,
                limit: 100,
            })
            .expect("query");
        assert_eq!(rows.len(), 1, "position was not recorded");
        assert_eq!(rows[0].hex_ident, "A1B2C3");
    }

    #[tokio::test]
    async fn recorder_merges_subtypes_like_the_desktop_app() {
        // Same invariant the desktop app relies on: MSG1's nulls must not
        // erase the position MSG3 established in the same flush window.
        let r = Recorder::open(in_memory()).expect("open");
        r.run(ScriptedSource::new(vec![MSG3, MSG1]))
            .await
            .expect("run");

        let storage = r.storage();
        let guard = storage.read().await;
        let rows = guard
            .as_ref()
            .unwrap()
            .query_bbox_sync(BboxQuery {
                north: 90.0,
                south: -90.0,
                east: 180.0,
                west: -180.0,
                start_ms: None,
                end_ms: None,
                limit: 100,
            })
            .expect("query");
        assert_eq!(rows.len(), 1, "subtypes must merge into one record");
        // A broken merge shows up here as either a missing row (the record
        // never had a position, so the bbox query cannot match it) or 0.0.
        assert!(
            (rows[0].latitude - 45.5017).abs() < 1e-6,
            "MSG1 erased the MSG3 position: lat={}",
            rows[0].latitude
        );
        assert_eq!(
            rows[0].callsign.as_deref().map(str::trim),
            Some("AFR123"),
            "callsign from MSG1 was lost"
        );
    }

    #[tokio::test]
    async fn recorder_stamps_source_id_on_raw_records() {
        let r = Recorder::open(in_memory()).expect("open");
        r.run(ScriptedSource::new(vec![MSG3])).await.expect("run");

        let storage = r.storage();
        let guard = storage.read().await;
        let raw = guard
            .as_ref()
            .unwrap()
            .query_raw_messages_sync(RawMessageQuery {
                hex_ident: "A1B2C3".to_string(),
                start_ms: 0,
                end_ms: i64::MAX,
            })
            .expect("query raw");
        assert!(!raw.is_empty(), "raw message was not recorded");
        assert_eq!(raw[0].source_id, "test-edge");
    }
}

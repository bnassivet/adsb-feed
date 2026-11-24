//! Several receivers through one recorder.
//!
//! Feeds that publish to `<topic>/<source_id>` arrive as [`SourcedLine`]s.
//! [`demux`] gives each receiver its own [`IngestPipeline`], started the
//! first time that receiver is heard: the per-aircraft merge must never mix
//! two receivers' fixes, and every row must be stored under the receiver
//! that heard it. Lines on the base topic (feeds that do not name themselves)
//! belong to the recorder's own id, exactly as before.
//!
//! [`record_announcement`] turns a feed's retained location announcement into
//! an observation in that receiver's location history.

use adsb_data_engine::{
    ChangeStamp, HistoryError, IngestConfig, IngestPipeline, LocationChange, LocationOrigin,
    LocationPeriod, NoopSink, ReceiverPosition, SharedStorage, StorageError, StorageHandle,
};
use adsb_pulsar_client::receiver_location::ReceiverLocationMessage;
use adsb_pulsar_client::source::mqtt_source::{Announcement, SourcedLine};
use std::collections::HashMap;
use std::time::Duration;
use tokio::sync::broadcast;
use tokio::task::JoinSet;
use tracing::{info, warn};

/// Lines buffered per receiver between the demux and its pipeline.
const PER_RECEIVER_CAPACITY: usize = 4096;

/// Routes each line to its receiver's pipeline until `lines` closes, then
/// lets every pipeline flush and finish.
///
/// Dropping (aborting) this future aborts the pipelines with it: they live
/// in a [`JoinSet`] it owns.
pub async fn demux(
    storage: SharedStorage,
    default_source_id: String,
    dump1090_tz: String,
    mut lines: broadcast::Receiver<SourcedLine>,
) {
    let mut routes: HashMap<String, broadcast::Sender<Vec<u8>>> = HashMap::new();
    let mut pipelines = JoinSet::new();
    loop {
        let SourcedLine { receiver, line } = match lines.recv().await {
            Ok(sourced) => sourced,
            Err(broadcast::error::RecvError::Lagged(n)) => {
                warn!("Receiver demux lagged, skipped {n} messages");
                continue;
            }
            Err(broadcast::error::RecvError::Closed) => break,
        };
        let id = receiver.as_deref().unwrap_or(&default_source_id);
        if !routes.contains_key(id) {
            info!("Recording receiver '{id}'");
            let (tx, rx) = broadcast::channel(PER_RECEIVER_CAPACITY);
            let pipeline = IngestPipeline::new(
                storage.clone(),
                IngestConfig {
                    source_id: id.to_string(),
                    attribute_source_id: true,
                    dump1090_tz: dump1090_tz.clone(),
                    flush_interval: Duration::from_millis(500),
                },
            );
            pipelines.spawn(pipeline.run(rx, NoopSink));
            routes.insert(id.to_string(), tx);
        }
        // Fire-and-forget, as on every live path: a pipeline that lags
        // drops lines rather than stalling the others.
        let _ = routes[id].send(line);
    }

    // Closing each pipeline's channel makes it flush and return.
    drop(routes);
    while pipelines.join_next().await.is_some() {}
}

/// Applies one announcement to the announcing receiver's history.
///
/// Dated from the feed's `since_ms` (never later than `now_ms`), so a
/// recorder that was down when the receiver moved still dates the move from
/// when the feed started with it. If the history already has a period
/// starting after that -- set by hand, or by this recorder's own config --
/// the announcement is dated `now_ms` instead: the newer record wins.
pub async fn record_announcement(
    storage: &StorageHandle,
    announcement: &Announcement,
    now_ms: i64,
) -> Result<Option<Vec<LocationPeriod>>, StorageError> {
    let msg = ReceiverLocationMessage::parse(&announcement.payload).map_err(|e| {
        StorageError::Query(format!(
            "unreadable location announcement from '{}': {e}",
            announcement.receiver
        ))
    })?;
    let position = ReceiverPosition::new(msg.latitude, msg.longitude, msg.altitude_ft);
    let stamp = ChangeStamp {
        origin: LocationOrigin::Mqtt,
        recorded_at_ms: now_ms,
        note: None,
    };
    let observe = |at_ms| LocationChange::Observe { position, at_ms };
    let receiver = announcement.receiver.clone();

    match storage
        .apply_receiver_change(
            receiver.clone(),
            observe(msg.since_ms.min(now_ms)),
            stamp.clone(),
        )
        .await
    {
        Err(StorageError::History(HistoryError::StaleObservation { .. })) => {
            storage
                .apply_receiver_change(receiver, observe(now_ms), stamp)
                .await
        }
        other => other,
    }
}

/// Records every announcement `rx` delivers until it closes.
pub async fn record_announcements(
    storage: SharedStorage,
    mut rx: broadcast::Receiver<Announcement>,
) {
    loop {
        let announcement = match rx.recv().await {
            Ok(a) => a,
            Err(broadcast::error::RecvError::Lagged(n)) => {
                // Retained and re-sent on every reconnect: a skipped one
                // comes round again.
                warn!("Skipped {n} receiver announcements");
                continue;
            }
            Err(broadcast::error::RecvError::Closed) => break,
        };
        let guard = storage.read().await;
        let Some(s) = guard.as_ref() else { continue };
        match record_announcement(s, &announcement, now_ms()).await {
            Ok(Some(_)) => info!(
                "Receiver '{}' announced a new location",
                announcement.receiver
            ),
            Ok(None) => {}
            Err(e) => warn!(
                "Location announcement from '{}' not recorded: {e}",
                announcement.receiver
            ),
        }
    }
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use adsb_data_engine::{RawMessageQuery, StorageConfig};
    use std::sync::Arc;
    use tokio::sync::RwLock;

    fn storage() -> StorageHandle {
        StorageHandle::open(StorageConfig {
            db_path: None,
            source_id: "central".to_string(),
            gap_threshold_ms: 3_600_000,
            share: None,
            remote: None,
        })
        .unwrap()
    }

    fn announcement(receiver: &str, lat: f64, since_ms: i64) -> Announcement {
        Announcement {
            receiver: receiver.to_string(),
            payload: ReceiverLocationMessage {
                latitude: lat,
                longitude: -2.3,
                altitude_ft: None,
                since_ms,
            }
            .to_json(),
        }
    }

    #[tokio::test]
    async fn an_announcement_opens_the_receiver_s_history_from_its_since() {
        let s = storage();
        record_announcement(&s, &announcement("pi-a", 46.7, 1_000), 5_000)
            .await
            .unwrap();
        let history = s.receiver_locations_sync("pi-a").unwrap();
        assert_eq!(history.len(), 1);
        assert_eq!(history[0].valid_from_ms, 1_000);
        assert_eq!(history[0].origin, LocationOrigin::Mqtt);
        assert_eq!(history[0].recorded_at_ms, 5_000);
    }

    #[tokio::test]
    async fn a_replayed_announcement_is_a_no_op() {
        let s = storage();
        let a = announcement("pi-a", 46.7, 1_000);
        record_announcement(&s, &a, 5_000).await.unwrap();
        assert_eq!(record_announcement(&s, &a, 9_000).await.unwrap(), None);
    }

    #[tokio::test]
    async fn a_since_in_the_future_is_clamped_to_now() {
        let s = storage();
        record_announcement(&s, &announcement("pi-a", 46.7, 99_000), 5_000)
            .await
            .unwrap();
        assert_eq!(
            s.receiver_locations_sync("pi-a").unwrap()[0].valid_from_ms,
            5_000
        );
    }

    #[tokio::test]
    async fn a_newer_period_than_the_since_dates_the_move_now() {
        let s = storage();
        record_announcement(&s, &announcement("pi-a", 46.7, 3_000), 4_000)
            .await
            .unwrap();
        // The feed restarted long ago at a new place, but the history already
        // has a period from 3 000: the move is dated when it is learnt.
        let out = record_announcement(&s, &announcement("pi-a", 47.0, 1_000), 8_000)
            .await
            .unwrap()
            .unwrap();
        let spans: Vec<_> = out
            .iter()
            .map(|p| (p.valid_from_ms, p.valid_to_ms))
            .collect();
        assert_eq!(spans, vec![(3_000, Some(8_000)), (8_000, None)]);
    }

    #[tokio::test]
    async fn a_garbled_announcement_is_refused_and_writes_nothing() {
        let s = storage();
        let bad = Announcement {
            receiver: "pi-a".into(),
            payload: b"{nope".to_vec(),
        };
        assert!(record_announcement(&s, &bad, 5_000).await.is_err());
        assert!(s.list_receivers_sync().unwrap().is_empty());
    }

    const MSG3: &str = "MSG,3,1,1,{HEX},1,2024/01/15,10:30:00.000,2024/01/15,10:30:00.000,,35000,,,45.5017,-73.5673,,,,,,0";

    fn line(receiver: Option<&str>, hex: &str) -> SourcedLine {
        SourcedLine {
            receiver: receiver.map(Arc::from),
            line: MSG3.replace("{HEX}", hex).into_bytes(),
        }
    }

    fn raw_source(s: &StorageHandle, hex: &str) -> String {
        s.query_raw_messages_sync(RawMessageQuery {
            hex_ident: hex.to_string(),
            start_ms: 0,
            end_ms: i64::MAX,
        })
        .unwrap()[0]
            .source_id
            .clone()
    }

    #[tokio::test]
    async fn each_receiver_s_lines_are_stored_under_its_own_id() {
        let s = storage();
        let shared: SharedStorage = Arc::new(RwLock::new(Some(s.clone())));
        let (tx, rx) = broadcast::channel(64);
        tx.send(line(Some("pi-a"), "AAAAAA")).unwrap();
        tx.send(line(Some("pi-b"), "BBBBBB")).unwrap();
        tx.send(line(None, "CCCCCC")).unwrap();
        drop(tx);

        tokio::time::timeout(
            Duration::from_secs(5),
            demux(shared, "central".into(), "UTC".into(), rx),
        )
        .await
        .expect("demux ends when its input closes");

        assert_eq!(raw_source(&s, "AAAAAA"), "pi-a");
        assert_eq!(raw_source(&s, "BBBBBB"), "pi-b");
        assert_eq!(
            raw_source(&s, "CCCCCC"),
            "central",
            "the base topic is ours"
        );
        let ids: Vec<_> = s
            .list_receivers_sync()
            .unwrap()
            .into_iter()
            .map(|r| r.source_id)
            .collect();
        assert_eq!(ids, vec!["central", "pi-a", "pi-b"]);
    }
}

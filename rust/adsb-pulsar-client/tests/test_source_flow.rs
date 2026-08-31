//! Integration tests for the [`MessageSource`] input abstraction.
//!
//! `SocketSource` must deliver exactly what a bare `ADSBFeedClient` tap
//! delivers — the trait is a wrapper, not a behaviour change — and it must
//! report transport state through the shared `SourceStatus` watch so a
//! consumer can drive its UI from either source kind identically.

mod common;

use adsb_pulsar_client::source::{MessageSource, SourceStatus, socket_source::SocketSource};
use common::{
    MockDump1090, SBS_MSG1_CALLSIGN, SBS_MSG3_POSITION, SBS_MSG4_SPEED, test_config_for_port,
};
use std::time::Duration;

#[tokio::test]
async fn test_socket_source_delivers_lines_to_subscriber() {
    let mock = MockDump1090::new().await;
    let mut source = SocketSource::new(test_config_for_port(mock.port())).unwrap();
    let mut rx = source.subscribe(100);

    let handle = tokio::spawn(async move {
        let _ = source.run().await;
    });

    mock.send_lines(vec![
        SBS_MSG3_POSITION.to_string(),
        SBS_MSG1_CALLSIGN.to_string(),
        SBS_MSG4_SPEED.to_string(),
    ])
    .await;

    let mut received = Vec::new();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    while received.len() < 3 && tokio::time::Instant::now() < deadline {
        if let Ok(Ok(msg)) = tokio::time::timeout(Duration::from_millis(200), rx.recv()).await {
            received.push(String::from_utf8(msg).unwrap());
        }
    }

    handle.abort();

    assert_eq!(received.len(), 3, "expected 3 lines, got {:?}", received);
    assert!(received[0].starts_with("MSG,3"));
}

#[tokio::test]
async fn test_socket_source_reports_status_transitions() {
    let mock = MockDump1090::new().await;
    let mut source = SocketSource::new(test_config_for_port(mock.port())).unwrap();
    let _rx = source.subscribe(16);
    let status = source.status();

    assert_eq!(*status.borrow(), SourceStatus::Disconnected);

    let handle = tokio::spawn(async move {
        let _ = source.run().await;
    });

    // run() moves out of Disconnected as soon as it starts.
    let mut seen_connecting = false;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    while tokio::time::Instant::now() < deadline {
        if *status.borrow() == SourceStatus::Connecting {
            seen_connecting = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }

    handle.abort();
    assert!(seen_connecting, "source never reported Connecting");
}

#[tokio::test]
async fn test_multiple_subscribers_all_receive() {
    let mock = MockDump1090::new().await;
    let mut source = SocketSource::new(test_config_for_port(mock.port())).unwrap();
    let mut rx_a = source.subscribe(100);
    let mut rx_b = source.subscribe(100);

    let handle = tokio::spawn(async move {
        let _ = source.run().await;
    });

    mock.send_lines(vec![SBS_MSG3_POSITION.to_string()]).await;

    let a = tokio::time::timeout(Duration::from_secs(5), rx_a.recv()).await;
    let b = tokio::time::timeout(Duration::from_secs(5), rx_b.recv()).await;

    handle.abort();

    // Both subscribers share one broadcast channel, so each sees every line.
    assert_eq!(a.unwrap().unwrap(), b.unwrap().unwrap());
}

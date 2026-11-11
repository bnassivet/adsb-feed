//! Integration tests for end-to-end message flow.
//!
//! These tests use a mock dump1090 server (TCP listener) to verify
//! that the client correctly receives, buffers, and delivers messages.

mod common;

use adsb_pulsar_client::ADSBFeedClient;
use adsb_pulsar_client::forwarder::NoopForwarder;
use common::{
    MockDump1090, SBS_HEARTBEAT, SBS_MSG1_CALLSIGN, SBS_MSG3_POSITION, SBS_MSG4_SPEED,
    test_config_for_port,
};
use std::time::Duration;
use tokio::io::AsyncWriteExt;

#[tokio::test]
async fn test_client_connects_receives_messages() {
    let mock = MockDump1090::new().await;
    let port = mock.port();

    let config = test_config_for_port(port);
    let mut client = ADSBFeedClient::new(config, vec![Box::new(NoopForwarder)]).unwrap();
    let mut tap = client.with_message_tap(100);

    let lines = vec![
        SBS_MSG3_POSITION.to_string(),
        SBS_MSG1_CALLSIGN.to_string(),
        SBS_MSG4_SPEED.to_string(),
    ];

    let client_handle = tokio::spawn(async move {
        let _ = client.run().await;
    });

    mock.send_lines(lines).await;

    let mut received = Vec::new();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    while received.len() < 3 {
        tokio::select! {
            msg = tap.recv() => {
                match msg {
                    Ok(data) => received.push(data),
                    Err(_) => break,
                }
            }
            _ = tokio::time::sleep_until(deadline) => break,
        }
    }

    assert_eq!(received.len(), 3, "should receive all 3 messages");

    client_handle.abort();
}

#[tokio::test]
async fn test_message_tap_delivers_all() {
    let mock = MockDump1090::new().await;
    let port = mock.port();

    let config = test_config_for_port(port);
    let mut client = ADSBFeedClient::new(config, vec![Box::new(NoopForwarder)]).unwrap();
    let mut tap = client.with_message_tap(200);

    let n = 10;
    let lines: Vec<String> = (0..n)
        .map(|i| format!(
            "MSG,3,1,1,HEX{:03},1,2024/01/15,10:30:00.000,2024/01/15,10:30:00.000,,{},,,45.5,-73.5,,,,,,0",
            i, 30000 + i * 1000
        ))
        .collect();

    let client_handle = tokio::spawn(async move {
        let _ = client.run().await;
    });

    mock.send_lines(lines).await;

    let mut count = 0;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    loop {
        tokio::select! {
            msg = tap.recv() => {
                match msg {
                    Ok(_) => count += 1,
                    Err(_) => break,
                }
                if count >= n { break; }
            }
            _ = tokio::time::sleep_until(deadline) => break,
        }
    }

    assert_eq!(count, n, "all {} messages should arrive via tap", n);

    client_handle.abort();
}

#[tokio::test]
async fn test_client_shutdown_stops_cleanly() {
    let mock = MockDump1090::new().await;
    let port = mock.port();

    let config = test_config_for_port(port);
    let mut client = ADSBFeedClient::new(config, vec![Box::new(NoopForwarder)]).unwrap();

    // Keep mock alive to accept connection and keep sending
    let mock_handle = tokio::spawn(async move {
        let (mut stream, _) = mock.listener.accept().await.unwrap();
        loop {
            let data = format!("{}\n", SBS_MSG3_POSITION);
            if stream.write_all(data.as_bytes()).await.is_err() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    });

    let metrics = client.metrics();

    let client_handle = tokio::spawn(async move { client.run().await });

    // Let it run briefly and receive some messages
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert!(
        metrics.messages_sent() > 0,
        "should have processed some messages"
    );

    client_handle.abort();
    mock_handle.abort();
}

#[tokio::test]
async fn test_client_handles_disconnect() {
    let mock = MockDump1090::new().await;
    let port = mock.port();

    let config = test_config_for_port(port);
    let mut client = ADSBFeedClient::new(config, vec![Box::new(NoopForwarder)]).unwrap();
    let metrics = client.metrics();

    let lines = vec![SBS_MSG3_POSITION.to_string()];

    let client_handle = tokio::spawn(async move {
        let _ = client.run().await;
    });

    // Mock sends one line then disconnects
    mock.send_lines(lines).await;

    // Give client time to process the disconnect
    tokio::time::sleep(Duration::from_millis(500)).await;

    assert!(
        metrics.messages_sent() >= 1,
        "should have sent at least 1 message"
    );

    client_handle.abort();
}

#[tokio::test]
async fn test_large_burst() {
    let mock = MockDump1090::new().await;
    let port = mock.port();

    let config = test_config_for_port(port);
    let mut client = ADSBFeedClient::new(config, vec![Box::new(NoopForwarder)]).unwrap();
    let mut tap = client.with_message_tap(500);

    let n = 100;
    let lines: Vec<String> = (0..n)
        .map(|i| format!(
            "MSG,3,1,1,HEX{:04},1,2024/01/15,10:30:00.000,2024/01/15,10:30:00.000,,{},,,45.5,-73.5,,,,,,0",
            i, 30000 + i * 100
        ))
        .collect();

    let client_handle = tokio::spawn(async move {
        let _ = client.run().await;
    });

    mock.send_lines(lines).await;

    let mut count = 0;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    loop {
        tokio::select! {
            msg = tap.recv() => {
                match msg {
                    Ok(_) => count += 1,
                    Err(_) => break,
                }
                if count >= n { break; }
            }
            _ = tokio::time::sleep_until(deadline) => break,
        }
    }

    assert_eq!(count, n, "all {} burst messages should arrive", n);

    client_handle.abort();
}

#[tokio::test]
async fn test_heartbeat_messages_forwarded_and_counted() {
    let mock = MockDump1090::new().await;
    let port = mock.port();

    let config = test_config_for_port(port);
    let mut client = ADSBFeedClient::new(config, vec![Box::new(NoopForwarder)]).unwrap();
    let mut tap = client.with_message_tap(100);
    let metrics = client.metrics();

    // Mix of heartbeat and real data messages
    let lines = vec![
        SBS_MSG3_POSITION.to_string(),
        SBS_HEARTBEAT.to_string(),
        SBS_MSG1_CALLSIGN.to_string(),
        SBS_HEARTBEAT.to_string(),
        SBS_MSG4_SPEED.to_string(),
    ];

    let client_handle = tokio::spawn(async move {
        let _ = client.run().await;
    });

    mock.send_lines(lines).await;

    // All 5 messages (including heartbeats) should arrive via tap
    let mut received = Vec::new();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    while received.len() < 5 {
        tokio::select! {
            msg = tap.recv() => {
                match msg {
                    Ok(data) => received.push(data),
                    Err(_) => break,
                }
            }
            _ = tokio::time::sleep_until(deadline) => break,
        }
    }

    assert_eq!(
        received.len(),
        5,
        "all 5 messages (including heartbeats) should arrive via tap"
    );
    // messages_received should count all lines
    assert_eq!(
        metrics.messages_received(),
        5,
        "messages_received should count all lines"
    );
    // messages_sent counts forwarded messages (same as received in noop mode)
    assert_eq!(
        metrics.messages_sent(),
        5,
        "messages_sent should count all forwarded lines"
    );

    client_handle.abort();
}

/// Accepts connections forever, counting them, and writes `payload` to each
/// every `every` (or nothing when `payload` is empty), keeping it open.
fn spawn_counting_mock(
    mock: MockDump1090,
    payload: &'static [u8],
    every: Duration,
) -> (
    std::sync::Arc<std::sync::atomic::AtomicUsize>,
    tokio::task::JoinHandle<()>,
) {
    use std::sync::atomic::{AtomicUsize, Ordering};
    let accepts = std::sync::Arc::new(AtomicUsize::new(0));
    let counter = accepts.clone();
    let handle = tokio::spawn(async move {
        loop {
            let (mut stream, _) = mock.listener.accept().await.unwrap();
            counter.fetch_add(1, Ordering::SeqCst);
            tokio::spawn(async move {
                loop {
                    if !payload.is_empty() && stream.write_all(payload).await.is_err() {
                        break;
                    }
                    tokio::time::sleep(every).await;
                }
            });
        }
    });
    (accepts, handle)
}

/// dump1090-fa sends its SBS heartbeat as a bare CRLF. A link carrying only
/// those must not be declared stale and torn down.
#[tokio::test]
async fn test_crlf_heartbeat_keeps_connection_alive() {
    let mock = MockDump1090::new().await;
    let mut config = test_config_for_port(mock.port());
    config.heartbeat_timeout_secs = 1;
    config.socket_read_timeout_secs = 0;
    let (accepts, mock_handle) = spawn_counting_mock(mock, b"\r\n", Duration::from_millis(250));

    let mut client = ADSBFeedClient::new(config, vec![Box::new(NoopForwarder)]).unwrap();
    let client_handle = tokio::spawn(async move { client.run().await });

    tokio::time::sleep(Duration::from_millis(3000)).await;
    assert_eq!(
        accepts.load(std::sync::atomic::Ordering::SeqCst),
        1,
        "CRLF heartbeats should keep the first connection alive"
    );

    client_handle.abort();
    mock_handle.abort();
}

/// A connection that delivers no bytes at all must be dropped once
/// `socket_read_timeout_secs` elapses, even though the housekeeping and
/// stats ticks keep winning the `select!` in between.
#[tokio::test]
async fn test_socket_read_timeout_fires_on_silent_connection() {
    let mock = MockDump1090::new().await;
    let mut config = test_config_for_port(mock.port());
    config.heartbeat_timeout_secs = 0;
    config.socket_read_timeout_secs = 2;
    let (accepts, mock_handle) = spawn_counting_mock(mock, b"", Duration::from_millis(100));

    let mut client = ADSBFeedClient::new(config, vec![Box::new(NoopForwarder)]).unwrap();
    let client_handle = tokio::spawn(async move { client.run().await });

    // 2s timeout + 1s initial retry delay, with margin.
    tokio::time::sleep(Duration::from_millis(4500)).await;
    assert!(
        accepts.load(std::sync::atomic::Ordering::SeqCst) >= 2,
        "a silent connection should time out and reconnect"
    );

    client_handle.abort();
    mock_handle.abort();
}

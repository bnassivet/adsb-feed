//! Integration tests for end-to-end message flow.
//!
//! These tests use a mock dump1090 server (TCP listener) to verify
//! that the client correctly receives, buffers, and delivers messages.

mod common;

use adsb_pulsar_client::forwarder::NoopForwarder;
use adsb_pulsar_client::ADSBFeedClient;
use common::{
    test_config_for_port, MockDump1090, SBS_HEARTBEAT, SBS_MSG1_CALLSIGN, SBS_MSG3_POSITION,
    SBS_MSG4_SPEED,
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

//! A minimal Prometheus endpoint for the feed client.
//!
//! # Why this is not axum
//!
//! Every other service in this workspace serves `/metrics` from the axum
//! router it already had. The feed client has no HTTP server at all, and it is
//! the one binary deliberately kept small: `rumqttc` with
//! `default-features = false`, `pulsar` optional so the edge build needs no
//! `protoc`, a 32-bit armv7 target where the recorder cannot go, a
//! `MemoryMax=100M` unit, and a measured ~2.1 MB artifact.
//!
//! Pulling axum + hyper + tower in to answer one path on loopback would add
//! roughly half a megabyte to exactly the binary whose size is a design
//! constraint. The protocol needed here is small enough to state completely:
//! one method, one path, a fixed content type, no body, no keep-alive.
//!
//! What that costs is that the parsing is ours, so it is specified by tests:
//! the head is bounded and time-limited, unknown paths are 404, other methods
//! are 405, a malformed request line is 400 and never a panic, and one stalled
//! client cannot block the next.

use crate::metrics::Metrics;
use crate::metrics_export::{Exporter, content_type};
use std::net::{IpAddr, SocketAddr};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tracing::{info, warn};

/// The only path served.
pub const METRICS_PATH: &str = "/metrics";

/// Largest request head accepted, headers included.
///
/// A scrape sends a few hundred bytes. Anything past this is not a scraper,
/// and reading it to the end would be the whole attack.
const MAX_HEAD_BYTES: usize = 8 * 1024;

/// How long a connection may take to send its head before it is dropped.
const HEAD_TIMEOUT: Duration = Duration::from_secs(5);

/// What a request line asks for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Answer {
    /// `GET /metrics`
    Metrics,
    /// A path we do not serve.
    NotFound,
    /// `/metrics`, but not with `GET`.
    MethodNotAllowed,
    /// Not a request line at all.
    BadRequest,
}

/// Classify an HTTP request line (`GET /metrics HTTP/1.1`).
///
/// Pure, so the protocol rules are testable without a socket.
pub fn classify(request_line: &str) -> Answer {
    let mut parts = request_line.split_whitespace();
    let (Some(method), Some(target)) = (parts.next(), parts.next()) else {
        return Answer::BadRequest;
    };

    // Prometheus sends no query string, but a person curling with one should
    // not get a 404 for what is plainly the metrics path.
    let path = target.split('?').next().unwrap_or(target);
    if path != METRICS_PATH {
        return Answer::NotFound;
    }

    if method == "GET" {
        Answer::Metrics
    } else {
        Answer::MethodNotAllowed
    }
}

/// Render the feed client's metrics.
pub fn render(version: &str, source_id: &str, metrics: &Metrics) -> String {
    let exporter = Exporter::new("feed", version, source_id);

    exporter.counter(
        "adsb_feed_messages_received_total",
        "SBS-1 lines read from the source, heartbeats included.",
        metrics.messages_received(),
    );
    exporter.counter(
        "adsb_feed_messages_sent_total",
        "Messages accepted by a forwarder.",
        metrics.messages_sent(),
    );
    exporter.counter(
        "adsb_feed_errors_total",
        "Socket and forwarder errors.",
        metrics.errors(),
    );
    exporter.counter(
        "adsb_feed_bytes_received_total",
        "Bytes read from the source socket.",
        metrics.bytes_received(),
    );
    exporter.counter(
        "adsb_feed_bytes_sent_total",
        "Bytes handed to the forwarders.",
        metrics.bytes_sent(),
    );
    exporter.counter(
        "adsb_feed_reconnections_total",
        "Source reconnection attempts.",
        metrics.reconnection_attempts(),
    );

    // A depth, not a total: it goes down as well as up.
    exporter.int_gauge(
        "adsb_feed_retry_queue_messages",
        "Messages waiting in the forwarder retry queues.",
        i64::try_from(metrics.retry_queue_size()).unwrap_or(i64::MAX),
    );

    // The one that catches a feed that is connected and silent -- which every
    // other metric here reports as perfectly healthy.
    exporter.gauge(
        "adsb_feed_last_meaningful_message_seconds",
        "Seconds since the last heartbeat or data line.",
        metrics.since_last_meaningful_message().as_secs_f64(),
    );

    // Derived rather than stored: the client keeps a monotonic start, and the
    // wall-clock instant it corresponds to is only needed once per scrape.
    // Exported as a start time rather than an uptime so it does not change
    // between scrapes -- `time() - start` gives the uptime anyway.
    if let Ok(now) = SystemTime::now().duration_since(UNIX_EPOCH) {
        exporter.gauge(
            "adsb_feed_start_time_seconds",
            "Unix time at which this process started.",
            now.as_secs_f64() - metrics.elapsed().as_secs_f64(),
        );
    }

    exporter.encode()
}

/// Build a complete HTTP/1.1 response.
///
/// `Connection: close` always: a scraper opens a connection per scrape, and
/// keep-alive would mean tracking idle connections for no benefit.
fn response(status: &str, headers: &str, body: &str) -> String {
    format!(
        "HTTP/1.1 {status}\r\n{headers}Content-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    )
}

/// Answer one connection, then drop it.
async fn handle(mut stream: TcpStream, version: &str, source_id: &str, metrics: &Metrics) {
    let mut head = Vec::with_capacity(512);
    let mut buf = [0u8; 1024];

    // Read only until the end of the head. The body is never read: no request
    // this serves has one.
    let read_head = async {
        loop {
            let n = match stream.read(&mut buf).await {
                Ok(0) => return false,
                Ok(n) => n,
                Err(_) => return false,
            };
            head.extend_from_slice(&buf[..n]);
            if head.windows(4).any(|w| w == b"\r\n\r\n") {
                return true;
            }
            if head.len() > MAX_HEAD_BYTES {
                return false;
            }
        }
    };

    match tokio::time::timeout(HEAD_TIMEOUT, read_head).await {
        Ok(true) => {}
        // A client that sends nothing, sends too much, or hangs up gets no
        // reply and, more to the point, frees the task.
        Ok(false) | Err(_) => return,
    }

    let request_line = String::from_utf8_lossy(&head);
    let request_line = request_line.lines().next().unwrap_or_default();

    let reply = match classify(request_line) {
        Answer::Metrics => {
            let body = render(version, source_id, metrics);
            response(
                "200 OK",
                &format!("Content-Type: {}\r\n", content_type()),
                &body,
            )
        }
        Answer::NotFound => response("404 Not Found", "", "not found\n"),
        Answer::MethodNotAllowed => response("405 Method Not Allowed", "Allow: GET\r\n", ""),
        Answer::BadRequest => response("400 Bad Request", "", ""),
    };

    let _ = stream.write_all(reply.as_bytes()).await;
    let _ = stream.flush().await;
}

/// Serve on an already-bound listener.
///
/// Split from [`serve`] so tests can bind port 0 and still learn the address —
/// the same reason `adsb-data-server` hands its future to the caller.
pub async fn serve_on(listener: TcpListener, metrics: Metrics, version: String, source_id: String) {
    loop {
        let (stream, _peer) = match listener.accept().await {
            Ok(accepted) => accepted,
            // One failed accept must not end the endpoint for good.
            Err(e) => {
                warn!("Metrics endpoint: accept failed: {e}");
                continue;
            }
        };
        let metrics = metrics.clone();
        let version = version.clone();
        let source_id = source_id.clone();
        // Per connection, so one stalled scraper cannot hold up the next.
        tokio::spawn(async move {
            handle(stream, &version, &source_id, &metrics).await;
        });
    }
}

/// Bind `bind:port` and serve `/metrics` until the task is dropped.
///
/// A bind failure is logged, not fatal: losing the endpoint must never stop a
/// feed from forwarding messages.
pub async fn serve(bind: IpAddr, port: u16, metrics: Metrics, version: String, source_id: String) {
    let addr = SocketAddr::new(bind, port);
    let listener = match TcpListener::bind(addr).await {
        Ok(listener) => listener,
        Err(e) => {
            warn!("Metrics endpoint could not bind {addr} (metrics unavailable): {e}");
            return;
        }
    };
    if bind.is_loopback() {
        info!("Metrics endpoint listening on http://{addr}{METRICS_PATH}");
    } else {
        warn!(
            "Metrics endpoint listening on http://{addr}{METRICS_PATH}: reachable from the \
             network, with no authentication"
        );
    }
    serve_on(listener, metrics, version, source_id).await;
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn start() -> (String, Metrics) {
        let metrics = Metrics::new();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let served = metrics.clone();
        tokio::spawn(serve_on(
            listener,
            served,
            "0.1.0".to_string(),
            "pi-kitchen-prod".to_string(),
        ));
        (format!("127.0.0.1:{}", addr.port()), metrics)
    }

    /// Send a raw request and read the whole reply.
    async fn raw(addr: &str, request: &str) -> String {
        let mut stream = TcpStream::connect(addr).await.unwrap();
        stream.write_all(request.as_bytes()).await.unwrap();
        let mut reply = String::new();
        stream.read_to_string(&mut reply).await.unwrap();
        reply
    }

    async fn get(addr: &str, path: &str) -> String {
        raw(addr, &format!("GET {path} HTTP/1.1\r\nHost: x\r\n\r\n")).await
    }

    #[test]
    fn a_get_on_the_metrics_path_is_served() {
        assert_eq!(classify("GET /metrics HTTP/1.1"), Answer::Metrics);
    }

    #[test]
    fn a_query_string_does_not_hide_the_path() {
        // Prometheus appends no query by default, but a human curling with one
        // should not get a 404.
        assert_eq!(classify("GET /metrics?foo=1 HTTP/1.1"), Answer::Metrics);
    }

    #[test]
    fn another_path_is_not_found() {
        assert_eq!(classify("GET / HTTP/1.1"), Answer::NotFound);
        assert_eq!(classify("GET /metricsx HTTP/1.1"), Answer::NotFound);
    }

    #[test]
    fn another_method_on_the_metrics_path_is_not_allowed() {
        assert_eq!(classify("POST /metrics HTTP/1.1"), Answer::MethodNotAllowed);
        assert_eq!(
            classify("DELETE /metrics HTTP/1.1"),
            Answer::MethodNotAllowed
        );
    }

    #[test]
    fn a_malformed_request_line_is_a_bad_request() {
        assert_eq!(classify(""), Answer::BadRequest);
        assert_eq!(classify("GET"), Answer::BadRequest);
        assert_eq!(classify("nonsense"), Answer::BadRequest);
    }

    #[test]
    fn the_exposition_carries_identity_and_every_counter() {
        let metrics = Metrics::new();
        metrics.inc_messages_received();
        metrics.inc_messages_sent();
        metrics.inc_errors();
        metrics.add_bytes_received(1024);
        metrics.add_bytes_sent(512);
        metrics.inc_reconnection_attempts();
        metrics.set_retry_queue_size(3);

        let body = render("0.1.0", "pi-kitchen-prod", &metrics);

        assert!(body.contains(r#"service="feed""#), "{body}");
        assert!(body.contains(r#"stage="prod""#), "{body}");
        assert!(
            body.contains("adsb_feed_messages_received_total 1"),
            "{body}"
        );
        assert!(body.contains("adsb_feed_messages_sent_total 1"), "{body}");
        assert!(body.contains("adsb_feed_errors_total 1"), "{body}");
        assert!(
            body.contains("adsb_feed_bytes_received_total 1024"),
            "{body}"
        );
        assert!(body.contains("adsb_feed_bytes_sent_total 512"), "{body}");
        assert!(body.contains("adsb_feed_reconnections_total 1"), "{body}");
        assert!(body.contains("adsb_feed_retry_queue_messages 3"), "{body}");
    }

    #[test]
    fn totals_are_counters_and_the_queue_is_a_gauge() {
        // rate() over a gauge is meaningless; a counter that only ever grows
        // is the wrong shape for a queue depth. The types say which is which.
        let body = render("0.1.0", "pi-dev", &Metrics::new());
        assert!(
            body.contains("# TYPE adsb_feed_messages_received_total counter"),
            "{body}"
        );
        assert!(
            body.contains("# TYPE adsb_feed_retry_queue_messages gauge"),
            "{body}"
        );
    }

    #[test]
    fn the_silence_gauge_is_exported() {
        // The metric that turns "connected but receiving nothing" into an
        // alert instead of a surprise.
        let body = render("0.1.0", "pi-dev", &Metrics::new());
        assert!(
            body.contains("# TYPE adsb_feed_last_meaningful_message_seconds gauge"),
            "{body}"
        );
        assert!(body.contains("adsb_feed_start_time_seconds"), "{body}");
    }

    #[tokio::test]
    async fn a_scrape_returns_the_exposition_with_its_content_type() {
        let (addr, _metrics) = start().await;
        let reply = get(&addr, METRICS_PATH).await;

        assert!(reply.starts_with("HTTP/1.1 200 OK\r\n"), "{reply}");
        assert!(
            reply.contains("Content-Type: text/plain; version=0.0.4"),
            "{reply}"
        );
        assert!(reply.contains("Content-Length: "), "{reply}");
        assert!(reply.contains("adsb_build_info"), "{reply}");
    }

    #[tokio::test]
    async fn counters_incremented_after_binding_appear_in_the_next_scrape() {
        // Proves the server holds the shared handle rather than a snapshot
        // taken at startup.
        let (addr, metrics) = start().await;
        assert!(
            get(&addr, METRICS_PATH)
                .await
                .contains("adsb_feed_messages_sent_total 0")
        );

        metrics.inc_messages_sent();
        metrics.inc_messages_sent();

        assert!(
            get(&addr, METRICS_PATH)
                .await
                .contains("adsb_feed_messages_sent_total 2")
        );
    }

    #[tokio::test]
    async fn an_unknown_path_is_404_and_a_post_is_405() {
        let (addr, _metrics) = start().await;
        assert!(get(&addr, "/").await.starts_with("HTTP/1.1 404"));

        let reply = raw(&addr, "POST /metrics HTTP/1.1\r\nHost: x\r\n\r\n").await;
        assert!(reply.starts_with("HTTP/1.1 405"), "{reply}");
        assert!(reply.contains("Allow: GET"), "{reply}");
    }

    #[tokio::test]
    async fn a_malformed_request_is_400_and_the_server_survives_it() {
        let (addr, _metrics) = start().await;
        let reply = raw(&addr, "garbage\r\n\r\n").await;
        assert!(reply.starts_with("HTTP/1.1 400"), "{reply}");

        // Still serving: one bad client must not end the endpoint.
        assert!(get(&addr, METRICS_PATH).await.starts_with("HTTP/1.1 200"));
    }

    #[tokio::test]
    async fn an_oversized_head_is_dropped_and_the_server_survives_it() {
        let (addr, _metrics) = start().await;
        let mut stream = TcpStream::connect(&addr).await.unwrap();
        // No terminator, well past the cap.
        let flood = "GET /metrics HTTP/1.1\r\nX: ".to_string() + &"a".repeat(MAX_HEAD_BYTES * 2);
        let _ = stream.write_all(flood.as_bytes()).await;
        drop(stream);

        assert!(get(&addr, METRICS_PATH).await.starts_with("HTTP/1.1 200"));
    }
}

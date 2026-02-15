//! Shared test infrastructure for integration tests.

use adsb_pulsar_client::Config;
use std::net::SocketAddr;
use tokio::io::AsyncWriteExt;
use tokio::net::TcpListener;

/// Sample SBS-1 MSG,3 position message.
pub const SBS_MSG3_POSITION: &str =
    "MSG,3,1,1,A1B2C3,1,2024/01/15,10:30:00.000,2024/01/15,10:30:00.000,,35000,,120.5,45.5017,-73.5673,,1234,,,,0";

/// Sample SBS-1 MSG,1 callsign message.
pub const SBS_MSG1_CALLSIGN: &str =
    "MSG,1,1,1,A1B2C3,1,2024/01/15,10:30:00.000,2024/01/15,10:30:00.000,AIR123,,,,,,,,,,,";

/// Sample SBS-1 MSG,4 speed message.
pub const SBS_MSG4_SPEED: &str =
    "MSG,4,1,1,D4E5F6,1,2024/01/15,10:30:00.000,2024/01/15,10:30:00.000,,,450.5,275.3,,,,,,,,,0";

/// A mock dump1090 server that sends configurable SBS-1 lines.
pub struct MockDump1090 {
    pub listener: TcpListener,
    addr: SocketAddr,
}

impl MockDump1090 {
    /// Binds to an ephemeral port on localhost.
    pub async fn new() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        Self { listener, addr }
    }

    /// Returns the port this mock is listening on.
    pub fn port(&self) -> u16 {
        self.addr.port()
    }

    /// Accepts one connection and sends all provided lines (each terminated with \n),
    /// then closes the connection.
    pub async fn send_lines(self, lines: Vec<String>) {
        let (mut stream, _) = self.listener.accept().await.unwrap();
        for line in &lines {
            let data = format!("{}\n", line);
            stream.write_all(data.as_bytes()).await.unwrap();
        }
        // Small delay to allow the client to process before connection closes
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        let _ = stream.shutdown().await;
    }
}

/// Creates a test config pointing to localhost on the given port.
pub fn test_config_for_port(port: u16) -> Config {
    let mut config = Config::default();
    config.socket_host = "127.0.0.1".to_string();
    config.socket_port = port;
    config.test_mode = true;
    config.socket_timeout_secs = 5;
    config.socket_read_timeout_secs = 2;
    config.initial_retry_delay_secs = 1;
    config.max_retry_delay_secs = 2;
    config
}

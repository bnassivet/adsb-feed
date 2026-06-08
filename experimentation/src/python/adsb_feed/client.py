#!/usr/bin/env python3
"""
ADS-B Feed Client - Improved Version
Connects to dump1090 TCP socket and forwards SBS-1 messages to Apache Pulsar.

Improvements over original:
- Line buffering to prevent message fragmentation
- Connection retry logic with exponential backoff
- Socket timeouts to prevent hanging
- Proper resource cleanup
- Pulsar connection recovery
- Structured logging with sampling
- Performance optimizations
"""

import argparse
import logging
import signal
import socket
import sys
import time
from enum import Enum
from typing import Optional

from pulsar import Client, Producer
from _pulsar import PartitionsRoutingMode


# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
    handlers=[
        logging.StreamHandler(sys.stdout)
    ]
)
logger = logging.getLogger(__name__)


class ConnectionMode(Enum):
    """Socket connection mode"""
    CLIENT = "client"
    SERVER = "server"


class ADSBFeedClient:
    """ADS-B Feed Client that forwards dump1090 messages to Pulsar"""

    def __init__(
        self,
        source_id: str,
        socket_host: str,
        socket_port: int,
        pulsar_broker: str,
        pulsar_topic: str,
        connection_mode: ConnectionMode = ConnectionMode.CLIENT,
        socket_timeout: int = 30,
        recv_buffer_size: int = 8192,
        initial_retry_delay: float = 1.0,
        max_retry_delay: float = 60.0,
        log_sample_rate: int = 100,
    ):
        self.source_id = source_id
        self.socket_host = socket_host
        self.socket_port = socket_port
        self.pulsar_broker = pulsar_broker
        self.pulsar_topic = pulsar_topic
        self.connection_mode = connection_mode
        self.socket_timeout = socket_timeout
        self.recv_buffer_size = recv_buffer_size
        self.initial_retry_delay = initial_retry_delay
        self.max_retry_delay = max_retry_delay
        self.log_sample_rate = log_sample_rate

        # State
        self.socket: Optional[socket.socket] = None
        self.pulsar_client: Optional[Client] = None
        self.pulsar_producer: Optional[Producer] = None
        self.running = False
        self.message_count = 0
        self.error_count = 0
        self.line_buffer = ""  # Buffer for incomplete lines

        # Setup signal handlers for graceful shutdown
        signal.signal(signal.SIGINT, self._signal_handler)
        signal.signal(signal.SIGTERM, self._signal_handler)

    def _signal_handler(self, signum, frame):
        """Handle shutdown signals gracefully"""
        logger.info(f"Received signal {signum}, shutting down gracefully...")
        self.running = False

    def _connect_socket_with_retry(self) -> socket.socket:
        """
        Connect to dump1090 socket with exponential backoff retry logic.

        Returns:
            Connected socket

        Raises:
            Exception: If unable to connect after retries
        """
        retry_delay = self.initial_retry_delay
        attempt = 0

        while self.running:
            attempt += 1
            try:
                logger.info(
                    f"Attempting to connect to dump1090 at {self.socket_host}:{self.socket_port} "
                    f"(attempt {attempt})"
                )

                sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
                sock.settimeout(self.socket_timeout)

                if self.connection_mode == ConnectionMode.CLIENT:
                    sock.connect((self.socket_host, self.socket_port))
                    logger.info(f"Successfully connected to {self.socket_host}:{self.socket_port}")
                else:
                    sock.bind((self.socket_host, self.socket_port))
                    sock.listen(1)
                    logger.info(f"Listening on {self.socket_host}:{self.socket_port}")

                return sock

            except socket.error as e:
                logger.warning(
                    f"Failed to connect to {self.socket_host}:{self.socket_port}: {e}. "
                    f"Retrying in {retry_delay:.1f}s..."
                )
                time.sleep(retry_delay)
                retry_delay = min(retry_delay * 2, self.max_retry_delay)
            except Exception as e:
                logger.error(f"Unexpected error during socket connection: {e}")
                time.sleep(retry_delay)
                retry_delay = min(retry_delay * 2, self.max_retry_delay)

        raise RuntimeError("Socket connection cancelled")

    def _connect_pulsar(self) -> tuple[Client, Producer]:
        """
        Connect to Pulsar broker and create producer.

        Returns:
            Tuple of (Client, Producer)

        Raises:
            Exception: If unable to connect to Pulsar
        """
        retry_delay = self.initial_retry_delay
        attempt = 0

        while self.running:
            attempt += 1
            try:
                logger.info(f"Connecting to Pulsar broker at {self.pulsar_broker} (attempt {attempt})")

                client = Client(
                    self.pulsar_broker,
                    connection_timeout_ms=30_000,
                )

                producer = client.create_producer(
                    topic=self.pulsar_topic,
                    send_timeout_millis=30_000,
                    producer_name=self.source_id,
                    batching_enabled=True,
                    batching_max_publish_delay_ms=10,
                    batching_max_messages=1000,
                    message_routing_mode=PartitionsRoutingMode.UseSinglePartition,
                )

                logger.info(
                    f"Successfully connected to Pulsar broker. "
                    f"Topic: {self.pulsar_topic}, Producer: {self.source_id}"
                )
                return client, producer

            except Exception as e:
                logger.warning(
                    f"Failed to connect to Pulsar at {self.pulsar_broker}: {e}. "
                    f"Retrying in {retry_delay:.1f}s..."
                )
                time.sleep(retry_delay)
                retry_delay = min(retry_delay * 2, self.max_retry_delay)

        raise RuntimeError("Pulsar connection cancelled")

    def _send_to_pulsar(self, message: bytes) -> bool:
        """
        Send a message to Pulsar with error handling.

        Args:
            message: The message bytes to send

        Returns:
            True if successful, False otherwise
        """
        try:
            # Use time.time() instead of datetime for better performance
            timestamp_ms = int(time.time() * 1000)

            self.pulsar_producer.send(
                message,
                properties={
                    "src_id": self.source_id,
                    "event_timestamp": str(timestamp_ms)
                }
            )

            self.message_count += 1

            # Sample logging to avoid I/O bottleneck
            if self.message_count % self.log_sample_rate == 0:
                logger.info(
                    f"Messages sent: {self.message_count}, Errors: {self.error_count}"
                )

            return True

        except Exception as e:
            self.error_count += 1
            logger.error(f"Failed to send message to Pulsar: {e}")

            # Try to reconnect to Pulsar
            try:
                logger.info("Attempting to reconnect to Pulsar...")
                if self.pulsar_producer:
                    try:
                        self.pulsar_producer.close()
                    except:
                        pass
                if self.pulsar_client:
                    try:
                        self.pulsar_client.close()
                    except:
                        pass

                self.pulsar_client, self.pulsar_producer = self._connect_pulsar()
                logger.info("Pulsar reconnection successful")
                return False  # Message was lost, but we're reconnected

            except Exception as reconnect_error:
                logger.error(f"Failed to reconnect to Pulsar: {reconnect_error}")
                return False

    def _process_buffer(self, new_data: bytes) -> list[bytes]:
        """
        Process incoming data with line buffering to prevent message fragmentation.

        Args:
            new_data: New bytes received from socket

        Returns:
            List of complete messages (newline-terminated)
        """
        # Decode and add to buffer
        try:
            decoded = new_data.decode('utf-8', errors='replace')
        except Exception as e:
            logger.warning(f"Failed to decode data: {e}")
            return []

        self.line_buffer += decoded

        # Split on newlines
        lines = self.line_buffer.split('\n')

        # Last element is incomplete (no trailing newline yet), keep it in buffer
        self.line_buffer = lines[-1]

        # Return complete lines (exclude empty strings and the incomplete last line)
        complete_messages = [
            line.encode('utf-8')
            for line in lines[:-1]
            if line.strip()  # Filter out empty lines
        ]

        return complete_messages

    def _receive_and_forward(self):
        """
        Main loop: receive data from socket and forward to Pulsar.
        Handles socket reconnection on errors.
        """
        conn = self.socket

        try:
            while self.running:
                try:
                    # For server mode, accept connections
                    if self.connection_mode == ConnectionMode.SERVER:
                        logger.info("Waiting for client connection...")
                        conn, client_info = self.socket.accept()
                        conn.settimeout(self.socket_timeout)
                        logger.info(f"Client connected from {client_info}")

                    # Receive data
                    data = conn.recv(self.recv_buffer_size)

                    if not data:
                        logger.warning("No data received, connection may be closed")
                        if self.connection_mode == ConnectionMode.CLIENT:
                            raise socket.error("Connection closed by remote host")
                        else:
                            # In server mode, wait for new connection
                            continue

                    # Process messages with line buffering
                    messages = self._process_buffer(data)

                    # Forward each complete message to Pulsar
                    for message in messages:
                        self._send_to_pulsar(message)

                except socket.timeout:
                    logger.debug("Socket timeout (no data received)")
                    # This is normal, just continue
                    continue

                except socket.error as e:
                    logger.error(f"Socket error: {e}")
                    if self.connection_mode == ConnectionMode.CLIENT:
                        # Reconnect in client mode
                        logger.info("Reconnecting to dump1090...")
                        if self.socket:
                            try:
                                self.socket.close()
                            except:
                                pass
                        self.socket = self._connect_socket_with_retry()
                        conn = self.socket
                        self.line_buffer = ""  # Clear buffer on reconnect
                    else:
                        # In server mode, wait for new connection
                        if conn != self.socket:
                            try:
                                conn.close()
                            except:
                                pass
                        continue

        except KeyboardInterrupt:
            logger.info("Interrupted by user")
        except Exception as e:
            logger.error(f"Unexpected error in receive loop: {e}", exc_info=True)
        finally:
            if conn and conn != self.socket:
                try:
                    conn.close()
                except:
                    pass

    def run(self):
        """
        Main entry point. Connect to resources and start forwarding messages.
        """
        try:
            self.running = True

            # Connect to Pulsar first
            self.pulsar_client, self.pulsar_producer = self._connect_pulsar()

            # Connect to dump1090 socket
            self.socket = self._connect_socket_with_retry()

            logger.info("Starting message forwarding...")
            logger.info(
                f"Configuration: source_id={self.source_id}, "
                f"socket={self.socket_host}:{self.socket_port}, "
                f"pulsar={self.pulsar_broker}, topic={self.pulsar_topic}"
            )

            # Start receiving and forwarding
            self._receive_and_forward()

        except Exception as e:
            logger.error(f"Fatal error: {e}", exc_info=True)
            sys.exit(1)
        finally:
            self.cleanup()

    def cleanup(self):
        """Clean up resources"""
        logger.info("Cleaning up resources...")

        logger.info(
            f"Final statistics: Messages sent: {self.message_count}, "
            f"Errors: {self.error_count}"
        )

        if self.socket:
            try:
                self.socket.close()
                logger.info("Socket closed")
            except Exception as e:
                logger.warning(f"Error closing socket: {e}")

        if self.pulsar_producer:
            try:
                self.pulsar_producer.close()
                logger.info("Pulsar producer closed")
            except Exception as e:
                logger.warning(f"Error closing Pulsar producer: {e}")

        if self.pulsar_client:
            try:
                self.pulsar_client.close()
                logger.info("Pulsar client closed")
            except Exception as e:
                logger.warning(f"Error closing Pulsar client: {e}")


def main():
    """CLI entry point"""
    parser = argparse.ArgumentParser(
        description='ADS-B Feed Client - Forward dump1090 SBS-1 messages to Apache Pulsar'
    )
    parser.add_argument(
        '--source_id',
        type=str,
        default="kraspberryPi",
        help='Unique identifier for this data source (default: kraspberryPi)'
    )
    parser.add_argument(
        '--first_socket_host',
        type=str,
        default="10.0.0.200",
        help='dump1090 host address (default: 10.0.0.200)'
    )
    parser.add_argument(
        '--first_socket_port',
        type=int,
        default=30003,
        help='dump1090 SBS-1 port (default: 30003)'
    )
    parser.add_argument(
        '--pulsar_broker',
        type=str,
        default="pulsar://localhost:6650",
        help='Pulsar broker URL (default: pulsar://localhost:6650)'
    )
    parser.add_argument(
        '--pulsar_topic',
        type=str,
        default="persistent://kradsb/adsb/sbs-topic",
        help='Pulsar topic name (default: persistent://kradsb/adsb/sbs-topic)'
    )
    parser.add_argument(
        '--connection_mode',
        type=str,
        choices=['client', 'server'],
        default='client',
        help='Socket connection mode (default: client)'
    )
    parser.add_argument(
        '--socket_timeout',
        type=int,
        default=30,
        help='Socket timeout in seconds (default: 30)'
    )
    parser.add_argument(
        '--recv_buffer_size',
        type=int,
        default=8192,
        help='Socket receive buffer size in bytes (default: 8192)'
    )
    parser.add_argument(
        '--log_level',
        type=str,
        choices=['DEBUG', 'INFO', 'WARNING', 'ERROR'],
        default='INFO',
        help='Logging level (default: INFO)'
    )
    parser.add_argument(
        '--log_sample_rate',
        type=int,
        default=100,
        help='Log statistics every N messages (default: 100)'
    )

    args = parser.parse_args()

    # Set log level
    logging.getLogger().setLevel(getattr(logging, args.log_level))

    # Create and run client
    client = ADSBFeedClient(
        source_id=args.source_id,
        socket_host=args.first_socket_host,
        socket_port=args.first_socket_port,
        pulsar_broker=args.pulsar_broker,
        pulsar_topic=args.pulsar_topic,
        connection_mode=ConnectionMode(args.connection_mode),
        socket_timeout=args.socket_timeout,
        recv_buffer_size=args.recv_buffer_size,
        log_sample_rate=args.log_sample_rate,
    )

    client.run()


if __name__ == "__main__":
    main()

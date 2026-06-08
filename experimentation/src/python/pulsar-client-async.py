#!/usr/bin/env python3
"""
ADS-B Feed Client - Enhanced Version
Connects to dump1090 TCP socket and forwards SBS-1 messages to Apache Pulsar.

Enhancements:
- Line buffering to prevent message fragmentation
- Connection retry logic with exponential backoff
- Socket timeouts to prevent hanging
- Proper resource cleanup
- Pulsar connection recovery
- Structured logging with sampling
- Performance optimizations (larger buffer, faster timestamps)
"""

import argparse
import logging
import signal
import socket
import sys
import time
from collections import deque
from enum import Enum
from time import perf_counter
from typing import Optional

from pulsar import Client, Producer
from _pulsar import PartitionsRoutingMode


# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
    handlers=[logging.StreamHandler(sys.stdout)]
)
logger = logging.getLogger(__name__)


# Configuration constants
PULSAR_CONN_TIMEOUT_MS = 30_000
PULSAR_SEND_TIMEOUT_MS = 30_000
PULSAR_BATCH_DELAY_MS = 100  # 100ms for better batching efficiency
PULSAR_BATCH_MAX_MESSAGES = 100  # Rely more on time-based batching
DEFAULT_RECV_BUFFER_SIZE = 65536  # 64KB for better throughput
DEFAULT_SOCKET_TIMEOUT = 30
MAX_LINE_BUFFER_SIZE = 100_000  # Max characters to prevent memory exhaustion
RETRY_QUEUE_MAX_SIZE = 1000  # Max messages to queue for retry
TIMESTAMP_UPDATE_INTERVAL = 10  # Update timestamp every N messages


class SourceCnxMode(Enum):
    """Socket connection mode"""
    CLIENT_MODE = 0
    SERVER_MODE = 1


class ADSBFeedClient:
    """ADS-B Feed Client that forwards dump1090 messages to Pulsar"""

    def __init__(
        self,
        source_id: str,
        socket_host: str,
        socket_port: int,
        pulsar_broker: str,
        pulsar_topic: str,
        connection_mode: SourceCnxMode = SourceCnxMode.CLIENT_MODE,
        socket_timeout: int = 30,
        recv_buffer_size: int = 8192,
        initial_retry_delay: float = 1.0,
        max_retry_delay: float = 60.0,
        log_sample_rate: int = 100,
        test_mode: bool = False,
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
        self.test_mode = test_mode

        # State
        self.socket: Optional[socket.socket] = None
        self.pulsar_client: Optional[Client] = None
        self.pulsar_producer: Optional[Producer] = None
        self.running = False
        self.message_count = 0
        self.error_count = 0
        self.line_buffer = b""  # Buffer for incomplete lines (as bytes)

        # Retry queue for failed Pulsar messages
        self.retry_queue: deque = deque(maxlen=RETRY_QUEUE_MAX_SIZE)

        # Connection tracking for server mode
        self.active_connections: list[socket.socket] = []

        # Metrics tracking
        self.start_time = perf_counter()
        self.bytes_received = 0
        self.bytes_sent = 0
        self.last_timestamp_ms = int(time.time() * 1000)
        self.timestamp_update_counter = 0

        # Setup signal handlers for graceful shutdown
        signal.signal(signal.SIGINT, self._signal_handler)
        signal.signal(signal.SIGTERM, self._signal_handler)

    def _signal_handler(self, signum, _frame):
        """Handle shutdown signals gracefully"""
        logger.info("Received signal %d, shutting down gracefully...", signum)
        self.running = False

    def _connect_socket_with_retry(self) -> socket.socket:
        """
        Connect to dump1090 socket with exponential backoff retry logic.

        Returns:
            Connected socket
        """
        retry_delay = self.initial_retry_delay
        attempt = 0

        while self.running:
            attempt += 1
            try:
                logger.info(
                    "Attempting to connect to dump1090 at %s:%d (attempt %d)",
                    self.socket_host, self.socket_port, attempt
                )

                sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
                sock.settimeout(self.socket_timeout)

                if self.connection_mode == SourceCnxMode.CLIENT_MODE:
                    sock.connect((self.socket_host, self.socket_port))
                    logger.info("Successfully connected to %s:%d",
                               self.socket_host, self.socket_port)
                else:
                    sock.bind((self.socket_host, self.socket_port))
                    sock.listen(1)
                    logger.info("Listening on %s:%d",
                               self.socket_host, self.socket_port)

                return sock

            except socket.error as e:
                logger.warning(
                    "Failed to connect to %s:%d: %s. Retrying in %.1fs...",
                    self.socket_host, self.socket_port, e, retry_delay
                )
                time.sleep(retry_delay)
                retry_delay = min(retry_delay * 2, self.max_retry_delay)
            except Exception as e:
                logger.error("Unexpected error during socket connection: %s", e)
                time.sleep(retry_delay)
                retry_delay = min(retry_delay * 2, self.max_retry_delay)

        raise RuntimeError("Socket connection cancelled")

    def _connect_pulsar(self) -> tuple[Client, Producer]:
        """
        Connect to Pulsar broker and create producer.

        Returns:
            Tuple of (Client, Producer)
        """
        retry_delay = self.initial_retry_delay
        attempt = 0

        while self.running:
            attempt += 1
            try:
                logger.info("Connecting to Pulsar broker at %s (attempt %d)",
                           self.pulsar_broker, attempt)

                client = Client(
                    self.pulsar_broker,
                    connection_timeout_ms=PULSAR_CONN_TIMEOUT_MS,
                )

                producer = client.create_producer(
                    topic=self.pulsar_topic,
                    send_timeout_millis=PULSAR_SEND_TIMEOUT_MS,
                    producer_name=self.source_id,
                    batching_enabled=True,
                    batching_max_publish_delay_ms=PULSAR_BATCH_DELAY_MS,
                    batching_max_messages=PULSAR_BATCH_MAX_MESSAGES,
                    message_routing_mode=PartitionsRoutingMode.UseSinglePartition,
                )

                logger.info(
                    "Successfully connected to Pulsar broker. Topic: %s, Producer: %s",
                    self.pulsar_topic, self.source_id
                )
                return client, producer

            except Exception as e:
                logger.warning(
                    "Failed to connect to Pulsar at %s: %s. Retrying in %.1fs...",
                    self.pulsar_broker, e, retry_delay
                )
                time.sleep(retry_delay)
                retry_delay = min(retry_delay * 2, self.max_retry_delay)

        raise RuntimeError("Pulsar connection cancelled")

    def _drain_retry_queue(self) -> int:
        """
        Attempt to send queued messages that failed previously.

        Returns:
            Number of messages successfully sent from the queue
        """
        if not self.retry_queue or not self.pulsar_producer:
            return 0

        sent_count = 0
        failed_messages = []

        # Try to send all queued messages
        while self.retry_queue:
            message = self.retry_queue.popleft()
            try:
                # Update timestamp for cached value
                if self.timestamp_update_counter % TIMESTAMP_UPDATE_INTERVAL == 0:
                    self.last_timestamp_ms = int(time.time() * 1000)
                self.timestamp_update_counter += 1

                self.pulsar_producer.send(
                    message,
                    properties={
                        "src_id": self.source_id,
                        "event_timestamp": str(self.last_timestamp_ms)
                    }
                )

                sent_count += 1
                self.bytes_sent += len(message)

            except Exception as e:
                # Put it back in the failed list
                failed_messages.append(message)
                logger.debug("Failed to send queued message: %s", e)
                break  # Stop trying if we hit an error

        # Put failed messages back in the queue
        for msg in failed_messages:
            self.retry_queue.append(msg)

        if sent_count > 0:
            logger.info("Successfully sent %d queued messages", sent_count)

        return sent_count

    def _send_to_pulsar(self, message: bytes) -> bool:
        """
        Send a message to Pulsar with error handling, or log it in test mode.
        Uses retry queue for failed messages and optimized timestamp caching.

        Args:
            message: The message bytes to send

        Returns:
            True if successful, False otherwise
        """
        # Test mode: just log the message
        if self.test_mode:
            self.message_count += 1

            # Log every message with content in test mode
            try:
                decoded = message.decode('utf-8', errors='replace')
                logger.info("[TEST MODE] Message %d: %s", self.message_count, decoded)
            except Exception as e:
                self.error_count += 1
                logger.warning("[TEST MODE] Could not decode message %d: %s",
                              self.message_count, e)

            # Log statistics at sample rate
            if self.message_count % self.log_sample_rate == 0:
                logger.info(
                    "[TEST MODE] === Statistics: %d messages received, %d errors ===",
                    self.message_count, self.error_count
                )

            return True

        # Normal mode: send to Pulsar
        try:
            # Try to drain retry queue first if it has messages
            if self.retry_queue:
                self._drain_retry_queue()

            # Update timestamp cache periodically for better performance
            if self.timestamp_update_counter % TIMESTAMP_UPDATE_INTERVAL == 0:
                self.last_timestamp_ms = int(time.time() * 1000)
            self.timestamp_update_counter += 1

            self.pulsar_producer.send(
                message,
                properties={
                    "src_id": self.source_id,
                    "event_timestamp": str(self.last_timestamp_ms)
                }
            )

            self.message_count += 1
            self.bytes_sent += len(message)

            # Sample logging to avoid I/O bottleneck
            if self.message_count % self.log_sample_rate == 0:
                logger.info(
                    "Messages sent: %d, Errors: %d, Queue: %d",
                    self.message_count, self.error_count, len(self.retry_queue)
                )

            return True

        except Exception as e:
            self.error_count += 1
            logger.error("Failed to send message to Pulsar: %s", e)

            # Add message to retry queue to prevent data loss
            self.retry_queue.append(message)
            if len(self.retry_queue) >= RETRY_QUEUE_MAX_SIZE:
                logger.warning("Retry queue full (%d messages), oldest messages may be dropped",
                              len(self.retry_queue))

            # Try to reconnect to Pulsar
            try:
                logger.info("Attempting to reconnect to Pulsar...")
                if self.pulsar_producer:
                    try:
                        self.pulsar_producer.close()
                    except Exception as e:
                        logger.debug("Error closing producer during reconnect: %s", e)
                if self.pulsar_client:
                    try:
                        self.pulsar_client.close()
                    except Exception as e:
                        logger.debug("Error closing client during reconnect: %s", e)

                self.pulsar_client, self.pulsar_producer = self._connect_pulsar()
                logger.info("Pulsar reconnection successful")
                return False

            except Exception as reconnect_error:
                logger.error("Failed to reconnect to Pulsar: %s", reconnect_error)
                return False

    def _process_buffer(self, new_data: bytes) -> list[bytes]:
        """
        Process incoming data with line buffering to prevent message fragmentation.
        Works directly with bytes for optimal performance (no decode/encode cycle).

        Args:
            new_data: New bytes received from socket

        Returns:
            List of complete messages (newline-terminated)
        """
        # Update metrics
        self.bytes_received += len(new_data)

        # Append new data to buffer
        self.line_buffer += new_data

        # Buffer overflow protection
        if len(self.line_buffer) > MAX_LINE_BUFFER_SIZE:
            logger.warning(
                "Line buffer overflow (%d bytes), clearing buffer to prevent memory exhaustion",
                len(self.line_buffer)
            )
            self.line_buffer = b""
            self.error_count += 1
            return []

        # Split on newlines (working with bytes)
        lines = self.line_buffer.split(b'\n')

        # Last element is incomplete (no trailing newline yet), keep it in buffer
        self.line_buffer = lines[-1]

        # Return complete lines (exclude empty lines)
        complete_messages = [line for line in lines[:-1] if line.strip()]

        return complete_messages

    def _receive_and_forward(self):
        """
        Main loop: receive data from socket and forward to Pulsar.
        Handles socket reconnection on errors.
        """
        active_conn = self.socket

        try:
            while self.running:
                try:
                    # For server mode, accept connections
                    if self.connection_mode == SourceCnxMode.SERVER_MODE:
                        logger.info("Waiting for client connection...")
                        # No timeout for accept - wait indefinitely for connections
                        self.socket.settimeout(None)
                        active_conn, client_info = self.socket.accept()
                        # Set timeout for data reception
                        active_conn.settimeout(self.socket_timeout)
                        # Track this connection for cleanup
                        self.active_connections.append(active_conn)
                        logger.info("Client connected from %s", client_info)

                    # Receive data
                    data = active_conn.recv(self.recv_buffer_size)

                    if not data:
                        logger.warning("No data received, connection may be closed")
                        if self.connection_mode == SourceCnxMode.CLIENT_MODE:
                            raise socket.error("Connection closed by remote host")
                        else:
                            continue

                    # Process messages with line buffering
                    messages = self._process_buffer(data)

                    # Forward each complete message to Pulsar
                    for message in messages:
                        self._send_to_pulsar(message)

                except socket.timeout:
                    # Timeout is normal, just continue
                    continue

                except socket.error as e:
                    logger.error("Socket error: %s", e)
                    if self.connection_mode == SourceCnxMode.CLIENT_MODE:
                        # Reconnect in client mode
                        logger.info("Reconnecting to dump1090...")
                        if self.socket:
                            try:
                                self.socket.close()
                            except Exception as e:
                                logger.debug("Error closing socket during reconnect: %s", e)
                        self.socket = self._connect_socket_with_retry()
                        active_conn = self.socket
                        self.line_buffer = b""  # Clear buffer on reconnect
                    else:
                        # In server mode, wait for new connection
                        if active_conn != self.socket:
                            try:
                                active_conn.close()
                            except Exception as e:
                                logger.debug("Error closing connection in server mode: %s", e)
                        continue

        except KeyboardInterrupt:
            logger.info("Interrupted by user")
        except Exception as e:
            logger.error("Unexpected error in receive loop: %s", e, exc_info=True)
        finally:
            if active_conn and active_conn != self.socket:
                try:
                    active_conn.close()
                except Exception as e:
                    logger.debug("Error closing connection in finally block: %s", e)

    def run(self):
        """Main entry point. Connect to resources and start forwarding messages."""
        try:
            self.running = True

            # Connect to Pulsar first (skip in test mode)
            if self.test_mode:
                logger.info("Running in TEST MODE - Pulsar connection disabled")
            else:
                self.pulsar_client, self.pulsar_producer = self._connect_pulsar()

            # Connect to dump1090 socket
            self.socket = self._connect_socket_with_retry()

            if self.test_mode:
                logger.info("Starting message reception (test mode - displaying messages only)...")
                logger.info(
                    "Configuration: source_id=%s, socket=%s:%d",
                    self.source_id, self.socket_host, self.socket_port
                )
            else:
                logger.info("Starting message forwarding...")
                logger.info(
                    "Configuration: source_id=%s, socket=%s:%d, pulsar=%s, topic=%s",
                    self.source_id, self.socket_host, self.socket_port,
                    self.pulsar_broker, self.pulsar_topic
                )

            # Start receiving and forwarding
            self._receive_and_forward()

        except Exception as e:
            logger.error("Fatal error: %s", e, exc_info=True)
            sys.exit(1)
        finally:
            self.cleanup()

    def cleanup(self):
        """Clean up resources"""
        logger.info("Cleaning up resources...")

        # Log final statistics with metrics
        elapsed = perf_counter() - self.start_time
        msg_per_sec = self.message_count / elapsed if elapsed > 0 else 0
        mb_sent = self.bytes_sent / 1024 / 1024
        mb_received = self.bytes_received / 1024 / 1024

        logger.info(
            "Final statistics: Messages sent: %d, Errors: %d, "
            "Throughput: %.1f msg/s, Sent: %.2f MB, Received: %.2f MB",
            self.message_count, self.error_count, msg_per_sec, mb_sent, mb_received
        )

        # Close all active connections (server mode)
        for conn in self.active_connections:
            try:
                conn.close()
                logger.debug("Closed active connection")
            except Exception as e:
                logger.debug("Error closing active connection: %s", e)

        if self.socket:
            try:
                self.socket.close()
                logger.info("Socket closed")
            except Exception as e:
                logger.warning("Error closing socket: %s", e)

        if self.pulsar_producer:
            try:
                logger.info("Flushing pending messages...")
                self.pulsar_producer.flush()
                self.pulsar_producer.close()
                logger.info("Pulsar producer closed")
            except Exception as e:
                logger.warning("Error closing Pulsar producer: %s", e)

        if self.pulsar_client:
            try:
                self.pulsar_client.close()
                logger.info("Pulsar client closed")
            except Exception as e:
                logger.warning("Error closing Pulsar client: %s", e)


# Parse the command-line arguments
parser = argparse.ArgumentParser(
    description='ADS-B Feed Client - Forward dump1090 SBS-1 messages to Apache Pulsar'
)
parser.add_argument(
    '--source_id',
    dest='source_id',
    type=str,
    nargs='?',
    default="kraspberryPi",
    help='Unique identifier for this data source (default: kraspberryPi)'
)
parser.add_argument(
    '--first_socket_host',
    dest='first_socket_host',
    type=str,
    nargs='?',
    default="10.0.0.200",
    help='dump1090 host address (default: 10.0.0.200)'
)
parser.add_argument(
    '--first_socket_port',
    dest='first_socket_port',
    type=int,
    nargs='?',
    default=30003,
    help='dump1090 SBS-1 port (default: 30003)'
)
parser.add_argument(
    '--pulsar_broker',
    dest='pulsar_broker',
    type=str,
    nargs='?',
    default="pulsar://localhost:6650",
    help='Pulsar broker URL (default: pulsar://localhost:6650)'
)
parser.add_argument(
    '--pulsar_topic',
    dest='pulsar_topic',
    type=str,
    nargs='?',
    default="persistent://kradsb/adsb/sbs-topic",
    help='Pulsar topic name (default: persistent://kradsb/adsb/sbs-topic)'
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
parser.add_argument(
    '--test-mode',
    dest='test_mode',
    action='store_true',
    help='Run in test mode without Pulsar (just display messages with logger)'
)

args = parser.parse_args()

# Set log level
logging.getLogger().setLevel(getattr(logging, args.log_level))


def validate_args(args):
    """Validate command-line arguments"""
    # Validate port number
    if not (1 <= args.first_socket_port <= 65535):
        parser.error("Port must be between 1-65535")

    # Validate source_id
    if not args.source_id or not args.source_id.strip():
        parser.error("source_id cannot be empty")

    # Validate Pulsar broker URL
    if not args.pulsar_broker.startswith(('pulsar://', 'pulsar+ssl://')):
        parser.error("Invalid Pulsar broker URL format (must start with pulsar:// or pulsar+ssl://)")


# Validate arguments
validate_args(args)


# Create and run client
if __name__ == "__main__":
    try:
        client = ADSBFeedClient(
            source_id=args.source_id,
            socket_host=args.first_socket_host,
            socket_port=args.first_socket_port,
            pulsar_broker=args.pulsar_broker,
            pulsar_topic=args.pulsar_topic,
            connection_mode=SourceCnxMode.CLIENT_MODE,
            socket_timeout=DEFAULT_SOCKET_TIMEOUT,
            recv_buffer_size=DEFAULT_RECV_BUFFER_SIZE,
            log_sample_rate=args.log_sample_rate,
            test_mode=args.test_mode,
        )

        client.run()

    except KeyboardInterrupt:
        logger.info("KeyboardInterrupt -> closing connection to %s:%d",
                    args.first_socket_host, args.first_socket_port)
        sys.exit(0)

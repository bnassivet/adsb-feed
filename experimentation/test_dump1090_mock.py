#!/usr/bin/env python3
"""
Mock dump1090 server for testing the adsb-feed client.
Sends sample SBS-1 messages on port 30003.
"""

import socket
import time

# Sample SBS-1 messages (from dump1090 format)
SAMPLE_MESSAGES = [
    "MSG,3,1,1,A12345,1,2025/12/30,13:05:00.000,2025/12/30,13:05:00.000,,36000,,,48.8566,2.3522,,,0,0,0,0",
    "MSG,4,1,1,A12345,1,2025/12/30,13:05:01.000,2025/12/30,13:05:01.000,,,400,180,,,0,,,,,",
    "MSG,3,1,1,B67890,1,2025/12/30,13:05:02.000,2025/12/30,13:05:02.000,,38000,,,51.5074,-0.1278,,,0,0,0,0",
    "MSG,1,1,1,C11111,1,2025/12/30,13:05:03.000,2025/12/30,13:05:03.000,AFR123,,,,,,,,,,",
    "MSG,3,1,1,D22222,1,2025/12/30,13:05:04.000,2025/12/30,13:05:04.000,,40000,,,40.7128,-74.0060,,,0,0,0,0",
]

def run_mock_server(host='localhost', port=30003, message_delay=0.5):
    """Run a mock dump1090 server"""
    server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    server.bind((host, port))
    server.listen(1)

    print(f"Mock dump1090 server listening on {host}:{port}")
    print("Waiting for connection...")

    try:
        while True:
            client, address = server.accept()
            print(f"Client connected from {address}")

            try:
                message_num = 0
                while True:
                    # Send messages in a loop
                    for message in SAMPLE_MESSAGES:
                        message_num += 1
                        full_message = message + "\n"
                        client.send(full_message.encode('utf-8'))
                        print(f"Sent message {message_num}: {message[:50]}...")
                        time.sleep(message_delay)

            except (BrokenPipeError, ConnectionResetError):
                print("Client disconnected")
                client.close()

    except KeyboardInterrupt:
        print("\nShutting down mock server...")
        server.close()

if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description='Mock dump1090 server for testing')
    parser.add_argument('--host', default='localhost', help='Host to bind to')
    parser.add_argument('--port', type=int, default=30003, help='Port to bind to')
    parser.add_argument('--delay', type=float, default=0.5, help='Delay between messages in seconds')

    args = parser.parse_args()

    run_mock_server(args.host, args.port, args.delay)

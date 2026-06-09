#!/usr/bin/env python3
"""
Diagnostic script to test dump1090 connectivity.
Helps identify connection issues compared to nc.
"""

import socket
import sys
import time

def test_connection(host, port, timeout=5):
    """Test TCP connection to dump1090"""
    print(f"\n{'='*60}")
    print(f"Testing connection to {host}:{port}")
    print(f"{'='*60}")

    # Test 1: Basic socket creation
    print("\n[Test 1] Creating socket...")
    try:
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        print("✓ Socket created successfully")
    except Exception as e:
        print(f"✗ Failed to create socket: {e}")
        return False

    # Test 2: Set socket timeout
    print(f"\n[Test 2] Setting timeout to {timeout}s...")
    try:
        sock.settimeout(timeout)
        print(f"✓ Timeout set to {timeout}s")
    except Exception as e:
        print(f"✗ Failed to set timeout: {e}")
        sock.close()
        return False

    # Test 3: Socket options (like nc uses)
    print("\n[Test 3] Setting socket options...")
    try:
        # Set SO_KEEPALIVE (like nc)
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_KEEPALIVE, 1)
        print("✓ SO_KEEPALIVE enabled")
    except Exception as e:
        print(f"⚠ Warning: Could not set SO_KEEPALIVE: {e}")

    # Test 4: Resolve hostname
    print(f"\n[Test 4] Resolving hostname '{host}'...")
    try:
        ip = socket.gethostbyname(host)
        print(f"✓ Resolved to IP: {ip}")
    except socket.gaierror as e:
        print(f"✗ Failed to resolve hostname: {e}")
        sock.close()
        return False

    # Test 5: Attempt connection
    print(f"\n[Test 5] Attempting to connect to {host}:{port}...")
    start_time = time.time()
    try:
        sock.connect((host, port))
        connect_time = time.time() - start_time
        print(f"✓ Connected successfully in {connect_time:.3f}s")
    except socket.timeout:
        print(f"✗ Connection timed out after {timeout}s")
        print("  Possible causes:")
        print("  - Server is not responding")
        print("  - Firewall blocking connection")
        print("  - Network routing issue")
        sock.close()
        return False
    except ConnectionRefusedError:
        print("✗ Connection refused")
        print("  Possible causes:")
        print("  - dump1090 is not running")
        print("  - dump1090 is not listening on this port")
        print("  - Port number is incorrect")
        sock.close()
        return False
    except OSError as e:
        print(f"✗ Connection failed: {e}")
        if "No route to host" in str(e):
            print("  Possible causes:")
            print("  - Host is not on the network")
            print("  - Incorrect IP address")
            print("  - Firewall or routing issue")
        sock.close()
        return False
    except Exception as e:
        print(f"✗ Unexpected error: {e}")
        sock.close()
        return False

    # Test 6: Receive data
    print("\n[Test 6] Attempting to receive data...")
    try:
        sock.settimeout(5)  # 5 second timeout for receive
        data = sock.recv(1024)
        if data:
            print(f"✓ Received {len(data)} bytes")
            # Try to decode and show first message
            try:
                decoded = data.decode('utf-8', errors='replace')
                lines = decoded.split('\n')
                if lines and lines[0]:
                    print(f"  First message: {lines[0][:80]}...")
            except:
                print("  (Could not decode data)")
        else:
            print("⚠ Connected but no data received (yet)")
    except socket.timeout:
        print("⚠ No data received within 5 seconds")
        print("  This might be normal if no aircraft are nearby")
    except Exception as e:
        print(f"✗ Error receiving data: {e}")

    # Test 7: Socket info
    print("\n[Test 7] Socket information...")
    try:
        local_addr = sock.getsockname()
        remote_addr = sock.getpeername()
        print(f"  Local address:  {local_addr[0]}:{local_addr[1]}")
        print(f"  Remote address: {remote_addr[0]}:{remote_addr[1]}")
    except Exception as e:
        print(f"⚠ Could not get socket info: {e}")

    # Clean up
    print("\n[Cleanup] Closing socket...")
    try:
        sock.close()
        print("✓ Socket closed")
    except Exception as e:
        print(f"⚠ Error closing socket: {e}")

    print(f"\n{'='*60}")
    print("✓ All tests passed - connection is working!")
    print(f"{'='*60}\n")
    return True

def compare_with_nc():
    """Show equivalent nc command"""
    print("\nEquivalent nc command:")
    print("  nc -v 10.0.0.200 30003")
    print("\nOr with timeout:")
    print("  nc -w 5 10.0.0.200 30003")
    print()

if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(
        description='Diagnose dump1090 TCP connection',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  python diagnose_connection.py
  python diagnose_connection.py --host 10.0.0.200 --port 30003
  python diagnose_connection.py --host localhost --port 30003 --timeout 10
        """
    )
    parser.add_argument('--host', default='10.0.0.200', help='dump1090 host')
    parser.add_argument('--port', type=int, default=30003, help='dump1090 port')
    parser.add_argument('--timeout', type=int, default=5, help='Connection timeout in seconds')

    args = parser.parse_args()

    compare_with_nc()

    success = test_connection(args.host, args.port, args.timeout)

    if success:
        print("Connection test successful!")
        print("\nYou can now run the adsb-feed client:")
        print(f"  python src/python/pulsar-client-async.py \\")
        print(f"    --test-mode \\")
        print(f"    --first_socket_host {args.host} \\")
        print(f"    --first_socket_port {args.port}")
        sys.exit(0)
    else:
        print("\n" + "="*60)
        print("Connection test failed!")
        print("="*60)
        print("\nTroubleshooting steps:")
        print("1. Verify dump1090 is running:")
        print("   ps aux | grep dump1090")
        print("\n2. Check dump1090 is listening on the port:")
        print(f"   netstat -an | grep {args.port}")
        print("   (or: lsof -i :{args.port})")
        print("\n3. Try nc to confirm connectivity:")
        print(f"   nc -v {args.host} {args.port}")
        print("\n4. Check firewall rules:")
        print("   sudo iptables -L (Linux)")
        print("   sudo pfctl -s rules (macOS)")
        print("\n5. Check dump1090 configuration:")
        print("   Look for --net-bind-address and --net-sbs-port options")
        sys.exit(1)

# Test Mode Feature

## Overview

Test mode allows you to run the ADS-B feed client **without Apache Pulsar**, making it perfect for:
- Testing dump1090 connectivity
- Debugging message reception
- Development without full infrastructure
- Validating dump1090 configuration
- Learning the SBS-1 message format

## Usage

```bash
python src/python/pulsar-client-async.py \
  --test-mode \
  --source_id test-client \
  --first_socket_host localhost \
  --first_socket_port 30003 \
  --log_level INFO
```

## What Test Mode Does

### ✅ Enabled
- Connects to dump1090 TCP socket
- Receives SBS-1 messages
- Line buffering (prevents message fragmentation)
- Socket reconnection on failures
- Graceful shutdown handling
- Message statistics tracking
- Structured logging to console

### ❌ Disabled
- Pulsar client instantiation (skipped entirely)
- Network connection to Pulsar broker
- Message forwarding to Pulsar
- Pulsar authentication

## Output Format

### Startup
```
2025-12-30 13:07:45,415 - __main__ - INFO - Running in TEST MODE - Pulsar connection disabled
2025-12-30 13:07:45,415 - __main__ - INFO - Attempting to connect to dump1090 at localhost:30003 (attempt 1)
2025-12-30 13:07:45,417 - __main__ - INFO - Successfully connected to localhost:30003
2025-12-30 13:07:45,417 - __main__ - INFO - Starting message reception (test mode - displaying messages only)...
2025-12-30 13:07:45,417 - __main__ - INFO - Configuration: source_id=test-client, socket=localhost:30003
```

### Message Display

**All messages are shown in full:**
```
2025-12-30 14:15:46,014 - __main__ - INFO - [TEST MODE] Message 1: MSG,3,1,1,A12345,1,2025/12/30,13:05:00.000,2025/12/30,13:05:00.000,,36000,,,48.8566,2.3522,,,0,0,0,0
2025-12-30 14:15:46,319 - __main__ - INFO - [TEST MODE] Message 2: MSG,4,1,1,A12345,1,2025/12/30,13:05:01.000,2025/12/30,13:05:01.000,,,400,180,,,0,,,,,
2025-12-30 14:15:46,623 - __main__ - INFO - [TEST MODE] Message 3: MSG,3,1,1,B67890,1,2025/12/30,13:05:02.000,2025/12/30,13:05:02.000,,38000,,,51.5074,-0.1278,,,0,0,0,0
...
2025-12-30 14:15:51,190 - __main__ - INFO - [TEST MODE] Message 18: MSG,3,1,1,B67890,1,2025/12/30,13:05:02.000,2025/12/30,13:05:02.000,,38000,,,51.5074,-0.1278,,,0,0,0,0
```

**Statistics are shown at sample rate intervals:**
```
2025-12-30 14:15:48,752 - __main__ - INFO - [TEST MODE] === Statistics: 10 messages received, 0 errors ===
2025-12-30 14:15:50,252 - __main__ - INFO - [TEST MODE] === Statistics: 20 messages received, 0 errors ===
```

### Shutdown
```
2025-12-30 13:07:50,354 - __main__ - INFO - Received signal 15, shutting down gracefully...
2025-12-30 13:07:50,530 - __main__ - INFO - Cleaning up resources...
2025-12-30 13:07:50,531 - __main__ - INFO - Final statistics: Messages sent: 26, Errors: 0
2025-12-30 13:07:50,531 - __main__ - INFO - Socket closed
```

## Configuration Options

### Log Sampling
Control how often statistics are displayed:

```bash
# Show stats every 10 messages
--log_sample_rate 10

# Show stats every 100 messages (default)
--log_sample_rate 100

# Show stats every message (verbose)
--log_sample_rate 1
```

### Log Level
Control verbosity:

```bash
# Minimal output (warnings and errors only)
--log_level WARNING

# Normal output (default)
--log_level INFO

# Detailed output
--log_level DEBUG
```

## Testing Scenarios

### Scenario 1: Test dump1090 Connection
```bash
python src/python/pulsar-client-async.py \
  --test-mode \
  --first_socket_host 10.0.0.200 \
  --first_socket_port 30003
```
**Purpose:** Verify you can connect to dump1090 and receive messages

### Scenario 2: Debug Message Format
```bash
python src/python/pulsar-client-async.py \
  --test-mode \
  --log_level DEBUG \
  --log_sample_rate 1
```
**Purpose:** See every message in detail to understand SBS-1 format

### Scenario 3: Performance Testing
```bash
python src/python/pulsar-client-async.py \
  --test-mode \
  --log_sample_rate 1000 \
  --log_level WARNING
```
**Purpose:** Measure message throughput without Pulsar overhead

### Scenario 4: Connection Reliability Test
```bash
# Run for extended period
python src/python/pulsar-client-async.py \
  --test-mode \
  --log_sample_rate 100
```
**Purpose:** Verify socket reconnection works over time

## Mock Server for Testing

A mock dump1090 server is included for testing without real hardware:

```bash
# Terminal 1: Start mock server
python test_dump1090_mock.py --port 30003 --delay 0.2

# Terminal 2: Run client in test mode
python src/python/pulsar-client-async.py \
  --test-mode \
  --first_socket_host localhost \
  --first_socket_port 30003
```

### Mock Server Options
```bash
python test_dump1090_mock.py \
  --host localhost \
  --port 30003 \
  --delay 0.5  # Delay between messages in seconds
```

## Understanding SBS-1 Message Format

Test mode helps you understand the SBS-1 format used by dump1090:

```
MSG,3,1,1,A12345,1,2025/12/30,13:05:00.000,2025/12/30,13:05:00.000,,36000,,,48.8566,2.3522,,,0,0,0,0
```

Fields:
- `MSG`: Message type
- `3`: Transmission type (position message)
- Aircraft ID: `A12345`
- Altitude: `36000` feet
- Position: `48.8566, 2.3522` (lat, lon)

## Troubleshooting

### "Connection refused"
```
Failed to connect to localhost:30003: [Errno 61] Connection refused
```
**Solution:** Make sure dump1090 is running and listening on port 30003

### No messages received
```
Successfully connected to localhost:30003
[no message output]
```
**Solution:**
- Check if dump1090 is actually receiving ADS-B signals
- Verify dump1090 is configured to output SBS-1 format on port 30003
- Check firewall rules

### Want to reduce output verbosity
```
[Too many messages displayed]
```
**Solution:** Increase the sample rate to reduce statistics frequency: `--log_sample_rate 1000`
Note: All messages will still be logged individually. To reduce overall output, consider using `--log_level WARNING`

## Comparison: Normal vs Test Mode

| Feature | Normal Mode | Test Mode |
|---------|-------------|-----------|
| Pulsar Connection | ✅ Required | ❌ Disabled |
| dump1090 Connection | ✅ Yes | ✅ Yes |
| Message Forwarding | ✅ To Pulsar | ❌ Logged only |
| Dependencies | Pulsar broker needed | None (standalone) |
| Use Case | Production | Development/Testing |
| Performance Impact | Network I/O | Console I/O only |

## Benefits

1. **No Infrastructure Required**: Test without setting up Pulsar
2. **Fast Feedback**: Immediately see if dump1090 connection works
3. **Learning Tool**: Understand SBS-1 message structure
4. **Debugging**: Isolate dump1090 issues from Pulsar issues
5. **Development**: Iterate quickly without full stack

## Transition to Production

Once test mode confirms everything works:

1. Remove `--test-mode` flag
2. Ensure Pulsar broker is accessible
3. Configure `--pulsar_broker` and `--pulsar_topic`
4. Messages will now forward to Pulsar instead of logging

Example:
```bash
# Test mode
python src/python/pulsar-client-async.py --test-mode --first_socket_host localhost

# Production mode (just remove --test-mode)
python src/python/pulsar-client-async.py --first_socket_host localhost \
  --pulsar_broker pulsar://production:6650
```

## Implementation Details

- Test mode is implemented at the client initialization level
- Pulsar client objects (`Client`, `Producer`) are never created in test mode
- All reliability features (reconnection, line buffering, signal handling) work in both modes
- The only difference is message handling: `_send_to_pulsar()` logs instead of forwarding
- Zero performance overhead when not in test mode

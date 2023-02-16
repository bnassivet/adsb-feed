#!/usr/bin/env python3

import socket
import time
HOST = "127.0.0.1"  # The server's hostname or IP address
PORT = 33201  # The port used by the server


with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
    try:
        s.connect((HOST, PORT))
        index = 0
        msg = "msg#"
        while True:
            msg_sent = f"{msg}{index}"
            print(f"Sending {msg_sent}")
            s.sendall(msg_sent.encode(encoding="utf-8"))
            index += 1
            time.sleep(1)
        data = s.recv(1024)

        
    except KeyboardInterrupt:
    # Close the sockets when finished
        s.close()
    finally:
        s.close()

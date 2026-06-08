import socket
import logging

from flask_login import LOGIN_MESSAGE_CATEGORY

logger = logging.Logger("forwarder", logging.INFO)

# First socket to connect to
#HOST1 = "localhost"
#PORT1 = 33201
HOST1 = "10.0.0.200"
PORT1 = 30002
SOURCE_CNX_MODE = 0 # 0 - Client / 1 - Server

# Second socket to forward messages to
HOST2 = "localhost"
PORT2 = 33202

# Create the first socket
s1 = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
if not SOURCE_CNX_MODE:
    s1.connect((HOST1, PORT1))
else:
    s1.bind((HOST1, PORT1))
    s1.listen()
# Create the second socket
s2 = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
# client mode
s2.connect((HOST2, PORT2))
s2.setblocking(0)
#server mode
#s2.bind((HOST2, PORT2))
#s2.listen()

# Continuously receive data from the first socket and send it to the second socket
try:
    while True:
        if SOURCE_CNX_MODE:
            conn, info = s1.accept()
        else: 
            conn = s1
        data = conn.recv(1024)

        print(f"data received {data.decode()}")
        s2.sendall(data)
        while data:           
            print(f"data received - forwarding: {data.decode()}")
            s2.sendall(data)
            data = conn.recv(1024)
            
except KeyboardInterrupt:
# Close the sockets when finished
    s1.close()
    s2.close()

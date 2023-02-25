import argparse
import socket
from xmlrpc.client import DateTime
from pulsar import Client, Producer
import asyncio
from datetime import datetime

# Parse the command-line arguments
parser = argparse.ArgumentParser(description='Connect to a TCP socket in client mode and forward the received messages to a Pulsar broker.')
parser.add_argument('--source_id', dest='source_id', type=str, nargs='?', default="kraspberryPi", help='The dump1090 source id e.g. hostname')
parser.add_argument('--first_socket_host', dest='first_socket_host', type=str, nargs='?', default="10.0.0.200", help='The host of the first socket')
parser.add_argument('--first_socket_port', dest='first_socket_port', type=int, nargs='?', default=30003, help='The port of the first socket')
parser.add_argument('--pulsar_broker', dest='pulsar_broker', type=str, nargs='?', default="pulsar://localhost:6650", help='The URL of the Apache Pulsar broker')
parser.add_argument('--pulsar_topic', dest='pulsar_topic', type=str, nargs='?', default="persistent://kradsb/adsb/sbs-topic", help='The name of the topic to publish messages to')
args = parser.parse_args()

SOURCE_CNX_MODE = 0 # 0 - Client / 1 - Server

SOURCE_ID=args.source_id
# First socket to connect to
HOST1 = args.first_socket_host
PORT1 = args.first_socket_port

# Apache Pulsar broker to forward messages to
PULSAR_BROKER = args.pulsar_broker
TOPIC = args.pulsar_topic

# Other Constants


# Create the first socket
s1 = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
if not SOURCE_CNX_MODE:
    s1.connect((HOST1, PORT1))
else:
    s1.bind((HOST1, PORT1))
    s1.listen()

# Create a Pulsar client and get a reference to the desired topic
client = Client(PULSAR_BROKER)
producer = client.create_producer(TOPIC)

def send_to_pulsar(data):
    producer.send(data, properties={"src_id": SOURCE_ID, "event_timestamp" : str(datetime.now().timestamp() * 1000)})
    

# Continuously receive data from the first socket, display it in the console,
# and forward it to the Pulsar broker
try:
    while True:
        if SOURCE_CNX_MODE:
            conn, info = s1.accept()
        else: 
            conn = s1
        data = conn.recv(1024)

#       print(f"data received {data.decode()}")
#      send_to_pulsar(data)
        while data:           
            print(f"data received - forwarding: {data.decode()}")
            send_to_pulsar(data)
            data = conn.recv(1024)
            
except KeyboardInterrupt:
# Close the sockets when finished
    s1.close()
    client.close()


import socket
from pulsar import Client

# First socket to connect to
HOST1 = "localhost"
PORT1 = 8080

# Apache Pulsar broker to forward messages to
PULSAR_BROKER = "pulsar://localhost:6650"
TOPIC = "your-topic"

# Create the first socket
sock1 = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
sock1.connect((HOST1, PORT1))

# Create a Pulsar client and get a reference to the desired topic
client = Client(PULSAR_BROKER)
producer = client.create_producer(TOPIC)

def display_message(message):
    """Process and display the received message"""
    # Perform any desired processing on the message
    processed_message = message + " (processed)"

    # Display the processed message
    print("Received:", processed_message)

# Continuously receive data from the first socket, display it in the console,
# and forward it to the Pulsar broker
while True:
    data = sock1.recv(1024)
    if not data:
        break
    display_message(data.decode("utf-8"))
    producer.send(data)

# Close the socket and the Pulsar client when finished
sock1.close()
client.close()

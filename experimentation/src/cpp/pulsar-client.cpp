#include <iostream>
#include <string>
#include <pulsar/Client.h>
#include <sys/socket.h>
#include <netinet/in.h>
#include <unistd.h>

int main(int argc, char* argv[]) {
    // First socket to connect to
    const char* HOST1 = "localhost";
    int PORT1 = 8080;

    // Apache Pulsar broker to forward messages to
    const char* PULSAR_BROKER = "pulsar://localhost:6650";
    const char* TOPIC = "your-topic";

    // Create the first socket
    int sock1 = socket(AF_INET, SOCK_STREAM, 0);
    if (sock1 < 0) {
        std::cerr << "Error creating socket" << std::endl;
        return 1;
    }

    struct sockaddr_in server1;
    server1.sin_family = AF_INET;
    server1.sin_port = htons(PORT1);
    server1.sin_addr.s_addr = inet_addr(HOST1);

    if (connect(sock1, (struct sockaddr *) &server1, sizeof(server1)) < 0) {
        std::cerr << "Error connecting to socket" << std::endl;
        return 1;
    }

    // Create a Pulsar client and get a reference to the desired topic
    pulsar::Client client(PULSAR_BROKER);
    pulsar::Producer producer;
    client.createProducer(TOPIC, producer);

    // Continuously receive data from the first socket and send it to the Pulsar broker
    while (true) {
        char buffer[1024];
        int n = read(sock1, buffer, 1024);
        if (n <= 0) {
            break;
        }
        pulsar::Message msg(std::string(buffer, n));
        producer.send(msg);
    }

    // Close the socket and the Pulsar client when finished
    close(sock1);
    return 0;
}

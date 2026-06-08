/*
In this code, we use the Boost.Asio library for the socket I/O, and Boost.Fiber for the asynchronous handling. The first socket is created and connected in the same way as in the previous code, but instead of reading data from the socket in a blocking manner, we create a Boost.Fiber that reads data from the socket and displays it in the console in an asynchronous manner.

The fiber object is created with a lambda function that continuously reads data from the socket using the asio::read_until function, which reads data from the socket until a specified delimiter is encountered (in this case, a newline character). The received data is displayed in the console using the cout stream.

Finally, the fiber1.join() function is called to start the fiber and run it until it finishes.
*/

#include <iostream>
#include <cstring>
#include <boost/asio.hpp>
#include <pulsar/Client.h>
#include <boost/fiber/all.hpp>

using namespace std;
using namespace boost;
using namespace pulsar;

// The host and port of the first socket
const string HOST1 = "localhost";
const int PORT1 = 8080;

// The URL of the Pulsar broker
const string PULSAR_BROKER_URL = "pulsar://localhost:6650";

int main()
{
    // Create the first socket
    asio::io_context io_context1;
    asio::ip::tcp::socket sock1(io_context1);
    asio::ip::tcp::endpoint endpoint1(asio::ip::make_address(HOST1), PORT1);
    sock1.connect(endpoint1);

    // Continuously receive data from the first socket
    asio::streambuf streambuf1;
    boost::fibers::fiber fiber1([&]() {
        while (true)
        {
            // Read data from the socket
            asio::read_until(sock1, streambuf1, "\n");

            // Forward the received data to the Pulsar broker
            Client client(PULSAR_BROKER_URL);
            Result result = client.Connect();
            if (result != ResultOk) {
                cout << "Failed to connect to Pulsar broker: " << result << endl;
                return;
            }

            Producer producer;
            result = client.CreateProducer("persistent://sample/standalone/ns1/my-topic", producer);
            if (result != ResultOk) {
                cout << "Failed to create producer: " << result << endl;
                return;
            }

            // Send the message asynchronously
            string message = asio::buffer_cast<const char*>(streambuf1.data());
            producer.SendAsync(Message(message), [&](Result result) {
                if (result != ResultOk) {
                    cout << "Failed to send message: " << result << endl;
                }
            });

            // Clear the streambuf for the next iteration
            streambuf1.consume(streambuf1.size());
        }
    });

    // Start the fiber
    fiber1.join();

    return 0;
}


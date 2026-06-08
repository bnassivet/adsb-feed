CC=g++
CFLAGS=-std=c++17 -pthread
LIBS=-lpulsar -lboost_system -lssl -lcrypto

all: forwarder

forwarder: forwarder.cpp
	$(CC) $(CFLAGS) forwarder.cpp $(LIBS) -o forwarder

clean:
	rm -f forwarder

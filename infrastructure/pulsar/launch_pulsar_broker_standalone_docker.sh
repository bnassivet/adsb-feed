#!/bin/bash
docker run -it -p 6650:6650 -p 8080:8080 --name pulsar_standalone apachepulsar/pulsar:latest bin/pulsar standalone
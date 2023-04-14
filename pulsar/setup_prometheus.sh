#setup prometheus & grafana dashboard 
# see instructions: https://github.com/streamnative/apache-pulsar-grafana-dashboard
export PULSAR_PROMETHEUS_URL="http://172.17.0.3.:9090"
export PULSAR_CLUSTER=standalone

#docker run -p 9090:9090 -v prometheus_standalone.yml:/etc/prometheus/prometheus.yml prom/prometheus
docker run -p 9090:9090 -v prometheus_pulsar_config:/etc/prometheus/  --mount type=bind,source="$(pwd)"/prometheus_pulsar_config/prometheus.yml,target=/etc/prometheus/prometheus.yml,readonly prom/prometheus
# http://localhost:9090/targets

#Grafana config
export PULSAR_PROMETHEUS_URL=http://$(ifconfig | grep "inet " | grep -v 127.0.0.1 | awk '{ print $2 }'):9090
export PULSAR_CLUSTER=standalone
docker run -it -p 3000:3000 -e PULSAR_PROMETHEUS_URL="${PULSAR_PROMETHEUS_URL}" -e PULSAR_CLUSTER="${PULSAR_CLUSTER}" streamnative/apache-pulsar-grafana-dashboard:latest 
# http://localhost:3000 - admin/happypulsaring


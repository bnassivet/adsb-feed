docker exec -it pulsar_stdalone /pulsar/bin/pulsar-admin tenants create kradsb
docker exec -it pulsar_stdalone /pulsar/bin/pulsar-admin namespaces create kradsb/adsb
docker exec -it pulsar_stdalone /pulsar/bin/pulsar-admin topics create persistent://kradsb/adsb/sbs-topic


# check config
docker exec -it pulsar_stdalone /pulsar/bin/pulsar-admin tenants list
docker exec -it pulsar_stdalone /pulsar/bin/pulsar-admin namespaces list kradsb
docker exec -it pulsar_stdalone /pulsar/bin/pulsar-admin topics list kradsb/adsb
docker exec -it pulsar_stdalone /pulsar/bin/pulsar-admin clusters list


# for a pulsar-io netty-source-connector
mv netty-source-config.yaml netty-source-config-kraspberry-adsb-30003.yaml
docker cp netty-source-config-kraspberry-adsb-30003.yaml pulsar_stdalone:/pulsar/conf
docker exec -it pulsar_stdalone /pulsar/bin/pulsar-admin sources localrun --archive pulsar-io-2.8.1.nar --tenant kradsb --namespace adsb --name netty --destination-topic-name sbs-topic --source-config-file netty-source-config-kraspberry-adsb-30003.yaml --parallelism 1


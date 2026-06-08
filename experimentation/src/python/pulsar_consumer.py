import pulsar
import atexit


def sbs_message_listener(consumer, msg):
    try:
        data = msg.data().decode('utf-8')
        print(f"Received message: {msg.message_id()} - {data}")
        consumer.acknowledge(msg)
    except:
        consumer.negative_acknowledge(msg)


client = pulsar.Client('pulsar://localhost:6650')
atexit.register(client.close)

consumer = client.subscribe(topic='persistent://kradsb/adsb/sbs-topic',
                            subscription_name='test_python_consumer',
                            consumer_type=pulsar.ConsumerType.Exclusive, 
                            receiver_queue_size=1024,
                            initial_position=pulsar.InitialPosition.Latest, 
                            message_listener=sbs_message_listener,
                            unacked_messages_timeout_ms=60000,
                            negative_ack_redelivery_delay_ms=60000
)





# while True:
#     msg = consumer.receive()
#     try:
#         data = msg.data().decode('utf-8')
#         print(f"Received message: {msg.message_id()} - {data}")
#         consumer.acknowledge(msg)
#     except:
#         consumer.negative_acknowledge(msg)

#consumer.close()    
#client.close()
import akka.actor.ActorSystem
import akka.io.Tcp._
import akka.stream.scaladsl.Tcp.{IncomingConnection, OutgoingConnection, ServerBinding}
import akka.stream.{ActorMaterializer, SystemMaterializer}
import akka.stream.scaladsl._
import akka.util.ByteString
import akka.NotUsed

import java.net.InetSocketAddress
import scala.concurrent.ExecutionContextExecutor
import com.sksamuel.pulsar4s.{DefaultProducerMessage, ProducerMessage, EventTime, ProducerConfig, PulsarAsyncClient, PulsarClient, PulsarClientConfig, Topic}
import com.sksamuel.pulsar4s.akka.streams._
import io.circe.generic.auto._
import com.sksamuel.pulsar4s.circe._

import scala.concurrent.ExecutionContext.Implicits.global
import java.util.Calendar


case class ADSBEvent(rawMsg: String)

case class Config(
                   firstSocketHost: String = "",
                   firstSocketPort: Int = 0,
                   pulsarBroker: String = "",
                   pulsarTopic: String = ""
                 )


object Main extends App {
  implicit val system: ActorSystem = ActorSystem()
  implicit val materializer: ActorMaterializer = ActorMaterializer()

  implicit val executor: ExecutionContextExecutor = system.dispatcher

  val parser = new scopt.OptionParser[Config]("pulsar-client") {
    opt[String]("first-socket-host").required().action((x, c) => c.copy(firstSocketHost = x))
    opt[Int]("first-socket-port").required().action((x, c) => c.copy(firstSocketPort = x))
    opt[String]("pulsar-broker").required().action((x, c) => c.copy(pulsarBroker = x))
    opt[String]("pulsar-topic").required().action((x, c) => c.copy(pulsarTopic = x))
  }

/*  val config: Config = (firstSocketHost="localhost",
    firstSocketPort=30003,
    pulsarBroker="pulsar://localhost:6650",
    pulsarTopic="topicName"
  )*/
  val sensorId = "42"
  parser.parse(args, Config()) match {
    case Some(config) =>
      val pulsarClient: PulsarAsyncClient = PulsarClient("config.pulsarBroker")
      val producer = pulsarClient.producer[ADSBEvent](
        ProducerConfig(
          Topic(config.pulsarTopic),
          producerName = Some("MacKraProducer"),
          enableBatching = Some(false),
          blockIfQueueFull = Some(true)))

      // Akka Source: TCP
      val address = new InetSocketAddress(config.firstSocketHost, config.firstSocketPort)
      val connection: Source[OutgoingConnection, NotUsed] = Tcp(system).outgoingConnection(remoteAddress = address)
      // : Source[OutgoingConnection, NotUsed]

      // Akka Sink: Pulsar Producer
      val producerFn = () => producer

      val pulsarSink = sink(producerFn)

      val mapflow = Flow[ByteString].map(data =>
          DefaultProducerMessage(
          Some(sensorId),
          ADSBEvent(data.utf8String.toString),
          eventTime=Some(EventTime(System.currentTimeMillis))))


        //producer.sendAsync(message)
      val flowGraph = connection.to(mapflow)
      flowGraph.runWith(pulsarSink)

    case None =>
      println("Bad config!!!")
      System.exit(1)
  }
}





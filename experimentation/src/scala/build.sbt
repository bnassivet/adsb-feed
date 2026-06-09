name := "tcp-socket-to-pulsar"

version := "0.1"

scalaVersion := "2.13.0"
val akkaVersion = "2.6.10"
val pulsar4sVersion = "2.7.3"
val scalaTestVersion = "3.2.0"

libraryDependencies ++= Seq(
  "com.typesafe.akka" %% "akka-actor" % akkaVersion,
  "com.typesafe.akka" %% "akka-stream" % akkaVersion,
  "com.sksamuel.pulsar4s" %% "pulsar4s-core" % pulsar4sVersion,
  "com.sksamuel.pulsar4s" %% "pulsar4s-akka-streams" % pulsar4sVersion,
  "com.sksamuel.pulsar4s" %% "pulsar4s-circe" % pulsar4sVersion,
  "com.github.scopt" %% "scopt" % "4.1.0",
  "org.scalatest" %% "scalatest" % scalaTestVersion
)

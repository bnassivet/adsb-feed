#!/usr/bin/env python3
"""Tests for the fleet renderer in scripts/render-config.py.

Stdlib unittest, no pytest: this must run from a bare checkout with nothing
installed, the same way `make render` does.

    python3 scripts/tests/test_render_fleet.py
"""
import importlib.util
import sys
import tomllib
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]

spec = importlib.util.spec_from_file_location(
    "render_config", REPO / "scripts" / "render-config.py"
)
rc = importlib.util.module_from_spec(spec)
spec.loader.exec_module(rc)


FLEET = {
    "stage": "prod",
    "site": {"id": "pi-roof", "latitude": 46.7, "longitude": -2.3},
    "broker": {"host": "pi4.lan", "port": 1883},
    "nodes": {
        "feed": {"host": "pi3.lan", "dump1090_host": "127.0.0.1",
                 "dump1090_port": 30003},
        "recorder": {"host": "pi4.lan", "db_path": "/var/lib/adsb/adsb.db",
                     "http_port": 8787, "share": True,
                     "share_uri": "quack:0.0.0.0:9494",
                     "share_token": "s3cret"},
    },
}


def parse(text):
    return tomllib.loads(text)


class StageComposition(unittest.TestCase):
    def test_source_id_carries_the_stage(self):
        feed = parse(rc.render_fleet_feed(FLEET))
        self.assertEqual(feed["source_id"], "pi-roof-prod")

    def test_both_nodes_get_the_SAME_source_id(self):
        # The recorder stamps its own source_id onto every stored record. A
        # mismatch makes the data claim the wrong receiver, and it is silent.
        feed = parse(rc.render_fleet_feed(FLEET))
        rec = parse(rc.render_fleet_server(FLEET))
        self.assertEqual(feed["source_id"], rec["source_id"])

    def test_topic_is_stage_scoped_and_shared(self):
        feed = parse(rc.render_fleet_feed(FLEET))
        rec = parse(rc.render_fleet_server(FLEET))
        self.assertEqual(feed["mqtt_topic"], "adsb/prod/sbs/raw")
        self.assertEqual(feed["mqtt_topic"], rec["mqtt_topic"])

    def test_changing_stage_moves_both_files_together(self):
        # The whole reason one file renders two: they cannot drift.
        dev = dict(FLEET, stage="dev")
        feed, rec = parse(rc.render_fleet_feed(dev)), parse(rc.render_fleet_server(dev))
        self.assertEqual(feed["source_id"], "pi-roof-dev")
        self.assertEqual(rec["source_id"], "pi-roof-dev")
        self.assertEqual(feed["mqtt_topic"], "adsb/dev/sbs/raw")
        self.assertEqual(rec["mqtt_topic"], "adsb/dev/sbs/raw")

    def test_explicit_topic_overrides_the_derived_one(self):
        f = dict(FLEET, broker=dict(FLEET["broker"], topic="legacy/raw"))
        self.assertEqual(parse(rc.render_fleet_feed(f))["mqtt_topic"], "legacy/raw")


class BrokerAddressing(unittest.TestCase):
    def test_recorder_uses_loopback_when_it_hosts_the_broker(self):
        # The durable leg must not depend on the network when it does not have
        # to: co-located means loopback.
        self.assertEqual(parse(rc.render_fleet_server(FLEET))["mqtt_broker"],
                         "127.0.0.1")

    def test_recorder_uses_the_lan_address_when_the_broker_is_elsewhere(self):
        f = dict(FLEET, broker={"host": "broker.lan", "port": 1883})
        self.assertEqual(parse(rc.render_fleet_server(f))["mqtt_broker"],
                         "broker.lan")

    def test_feed_always_uses_the_broker_host(self):
        self.assertEqual(parse(rc.render_fleet_feed(FLEET))["mqtt_broker"],
                         "pi4.lan")


class FeedContent(unittest.TestCase):
    def test_mqtt_only_by_default(self):
        # An edge binary built without the pulsar feature REJECTS a "pulsar"
        # entry, so it must not appear unless asked for.
        self.assertEqual(parse(rc.render_fleet_feed(FLEET))["forwarders"], ["mqtt"])

    def test_pulsar_leg_is_added_when_configured(self):
        f = dict(FLEET, pulsar={"enabled": True, "broker": "pulsar://a:6650",
                                "topic": "persistent://k/a/t"})
        feed = parse(rc.render_fleet_feed(f))
        self.assertEqual(feed["forwarders"], ["mqtt", "pulsar"])
        self.assertEqual(feed["pulsar_broker"], "pulsar://a:6650")

    def test_receiver_position_comes_from_the_site(self):
        feed = parse(rc.render_fleet_feed(FLEET))
        self.assertAlmostEqual(feed["receiver_latitude"], 46.7)
        self.assertAlmostEqual(feed["receiver_longitude"], -2.3)

    def test_dump1090_address_is_the_feed_node_s_own(self):
        feed = parse(rc.render_fleet_feed(FLEET))
        self.assertEqual(feed["socket_host"], "127.0.0.1")
        self.assertEqual(feed["socket_port"], 30003)


class ServerContent(unittest.TestCase):
    def test_share_token_emitted_when_sharing(self):
        self.assertEqual(parse(rc.render_fleet_server(FLEET))["share_token"], "s3cret")

    def test_share_token_omitted_when_not_sharing(self):
        f = dict(FLEET, nodes=dict(FLEET["nodes"],
                                   recorder=dict(FLEET["nodes"]["recorder"],
                                                 share=False)))
        self.assertNotIn("share_token", parse(rc.render_fleet_server(f)))

    def test_db_path_is_left_absolute(self):
        # Unlike the dev stack, a fleet path is the PI's path and must not be
        # resolved against this machine's repo root.
        self.assertEqual(parse(rc.render_fleet_server(FLEET))["db_path"],
                         "/var/lib/adsb/adsb.db")


class Safety(unittest.TestCase):
    def test_outputs_are_marked_generated(self):
        for text in (rc.render_fleet_feed(FLEET), rc.render_fleet_server(FLEET)):
            self.assertIn("DO NOT EDIT", text)

    def test_missing_stage_is_a_clear_error(self):
        with self.assertRaises(KeyError):
            rc.render_fleet_feed({k: v for k, v in FLEET.items() if k != "stage"})

    def test_node_dir_is_the_short_hostname(self):
        self.assertEqual(rc.node_dir("pi3.lan"), "pi3")
        self.assertEqual(rc.node_dir("raspberrypi.local"), "raspberrypi")
        self.assertEqual(rc.node_dir("192.168.1.10"), "192.168.1.10")


if __name__ == "__main__":
    unittest.main(verbosity=2)

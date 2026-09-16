#!/usr/bin/env python3
"""Tests for scripts/render-config.py -- both the stack and fleet modes.

Stdlib unittest, no pytest: this must run from a bare checkout with nothing
installed, the same way `make render` does.

    python3 scripts/tests/test_render_config.py
"""
import importlib.util
import sys
import tempfile
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


STACK = {
    "receiver": {"id": "dev-laptop-dev", "latitude": 46.7, "longitude": -2.3},
    "dump1090": {"host": "127.0.0.1", "port": 30003, "mock": True},
    "mqtt": {"host": "localhost", "port": 1883, "topic": "adsb/dev/sbs/raw"},
    "storage": {"db_path": ".run/adsb.db", "http_port": 8787, "share": True,
                "share_uri": "quack:localhost:9494", "share_token": "t"},
    "pulsar": {"enabled": False},
}


class StackDbPathScoping(unittest.TestCase):
    """Two named stacks must not share one DuckDB file.

    They would not merely mix data: DuckDB takes an exclusive lock, so the
    second stack's recorder simply fails to open and degrades silently.
    """

    def test_default_run_dir_is_unchanged(self):
        # The pre-existing layout must survive byte-for-byte, or every existing
        # checkout's database moves out from under it.
        out = REPO / ".run"
        rec = parse(rc.render_server(STACK, out))
        self.assertEqual(rec["db_path"], str(REPO / ".run" / "adsb.db"))

    def test_named_stack_gets_its_own_database(self):
        rec = parse(rc.render_server(STACK, REPO / ".run" / "prod"))
        self.assertEqual(rec["db_path"], str(REPO / ".run" / "prod" / "adsb.db"))

    def test_two_named_stacks_do_not_collide(self):
        a = parse(rc.render_server(STACK, REPO / ".run" / "prod"))["db_path"]
        b = parse(rc.render_server(STACK, REPO / ".run" / "lab"))["db_path"]
        self.assertNotEqual(a, b)

    def test_absolute_db_path_is_respected_verbatim(self):
        cfg = dict(STACK, storage=dict(STACK["storage"], db_path="/var/lib/adsb/x.db"))
        rec = parse(rc.render_server(cfg, REPO / ".run" / "prod"))
        self.assertEqual(rec["db_path"], "/var/lib/adsb/x.db")

    def test_a_non_run_relative_path_is_left_repo_relative(self):
        # Only the `.run/` prefix is stack-scoped; anything else the user wrote
        # deliberately is theirs.
        cfg = dict(STACK, storage=dict(STACK["storage"], db_path="data/x.db"))
        rec = parse(rc.render_server(cfg, REPO / ".run" / "prod"))
        self.assertEqual(rec["db_path"], str(REPO / "data" / "x.db"))


WEATHER_STACK = dict(
    STACK,
    weather={"enabled": True, "radius_nm": 250, "spacing_deg": 0.5,
             "levels": [300, 250], "refresh_minutes": 90, "model": "icon_eu",
             "cache_path": ".run/weather-cache.json"},
)


class WeatherContent(unittest.TestCase):
    """The weather service shares identity, broker and position with the feed.

    The same reason the feed and the recorder render from one file: a weather
    service on another broker looks healthy and draws nothing, and one on
    another receiver position draws winds over the wrong place.
    """

    def render(self, cfg=WEATHER_STACK, out=REPO / ".run"):
        return parse(rc.render_weather(cfg, out))

    def test_identity_and_broker_match_the_feed(self):
        weather, feed = self.render(), parse(rc.render_feed(WEATHER_STACK))
        self.assertEqual(weather["source_id"], feed["source_id"])
        self.assertEqual(weather["mqtt_broker"], feed["mqtt_broker"])
        self.assertEqual(weather["mqtt_port"], feed["mqtt_port"])

    def test_receiver_position_is_the_feed_s(self):
        weather = self.render()
        self.assertAlmostEqual(weather["receiver_latitude"], 46.7)
        self.assertAlmostEqual(weather["receiver_longitude"], -2.3)

    def test_topic_is_derived_from_the_feed_topic_by_default(self):
        # The stage carries over, so a dev weather service cannot publish into
        # a prod desktop. The desktop derives the same topic from the same rule.
        self.assertEqual(self.render()["mqtt_topic"], "adsb/dev/weather/grid")

    def test_a_topic_without_the_sbs_suffix_gets_a_sibling(self):
        cfg = dict(WEATHER_STACK, mqtt=dict(STACK["mqtt"], topic="legacy/raw"))
        self.assertEqual(self.render(cfg)["mqtt_topic"], "legacy/raw/weather")

    def test_explicit_topic_wins(self):
        cfg = dict(WEATHER_STACK,
                   weather=dict(WEATHER_STACK["weather"], topic="lab/wx"))
        self.assertEqual(self.render(cfg)["mqtt_topic"], "lab/wx")

    def test_grid_and_schedule_settings_pass_through(self):
        weather = self.render()
        self.assertEqual(weather["radius_nm"], 250)
        self.assertEqual(weather["spacing_deg"], 0.5)
        self.assertEqual(weather["levels"], [300, 250])
        self.assertEqual(weather["refresh_minutes"], 90)
        self.assertEqual(weather["model"], "icon_eu")

    def test_cache_path_is_stack_scoped_like_the_database(self):
        # Two stacks must not replay each other's grid after a restart.
        self.assertEqual(self.render()["cache_path"],
                         str(REPO / ".run" / "weather-cache.json"))
        self.assertEqual(self.render(out=REPO / ".run" / "prod")["cache_path"],
                         str(REPO / ".run" / "prod" / "weather-cache.json"))

    def test_the_control_api_is_loopback_by_default(self):
        # No authentication: only an explicit http_bind opens it to the LAN.
        weather = parse(rc.render_weather(STACK, REPO / ".run"))
        self.assertEqual(weather["http_port"], 8789)
        self.assertEqual(weather["http_bind"], "127.0.0.1")

    def test_control_api_settings_render_when_given(self):
        cfg = {**STACK, "weather": {"http_port": 9000, "http_bind": "0.0.0.0"}}
        weather = parse(rc.render_weather(cfg, REPO / ".run"))
        self.assertEqual(weather["http_port"], 9000)
        self.assertEqual(weather["http_bind"], "0.0.0.0")

    def test_state_path_is_stack_scoped_like_the_cache(self):
        # A disable in the dev stack must not pause the prod stack's service.
        self.assertEqual(self.render()["state_path"],
                         str(REPO / ".run" / "weather-state.json"))
        self.assertEqual(self.render(out=REPO / ".run" / "prod")["state_path"],
                         str(REPO / ".run" / "prod" / "weather-state.json"))

    def test_a_config_from_before_the_weather_layer_still_renders(self):
        # Every adsb-stack.toml created before this feature has no [weather]
        # section; `make render` must not start failing for all of them.
        weather = parse(rc.render_weather(STACK, REPO / ".run"))
        self.assertEqual(weather["mqtt_topic"], "adsb/dev/weather/grid")
        self.assertEqual(weather["levels"], [850, 700, 500, 300, 250, 200])
        self.assertEqual(weather["refresh_minutes"], 60)
        self.assertEqual(weather["model"], "best_match")
        self.assertEqual(weather["cache_path"],
                         str(REPO / ".run" / "weather-cache.json"))

    def test_render_stack_writes_weather_toml(self):
        with tempfile.TemporaryDirectory() as d:
            stack = Path(d) / "adsb-stack.toml"
            stack.write_text(
                '[receiver]\nid = "dev-laptop-dev"\nlatitude = 46.7\n'
                'longitude = -2.3\n'
                '[dump1090]\nhost = "127.0.0.1"\nport = 30003\n'
                '[mqtt]\nhost = "localhost"\nport = 1883\n'
                'topic = "adsb/dev/sbs/raw"\n'
                '[storage]\ndb_path = ".run/adsb.db"\n'
                '[pulsar]\nenabled = false\n'
            )
            out = Path(d) / "run"
            self.assertEqual(rc.render_stack(stack, out), 0)
            weather = tomllib.loads((out / "weather.toml").read_text())
            self.assertEqual(weather["source_id"], "dev-laptop-dev")


class MetricsContent(unittest.TestCase):
    """The feed client's scrape endpoint.

    Every other service serves /metrics on a port it already has, so this is
    the only one the renderer carries -- and therefore the only one that can be
    lost silently between adsb-stack.toml and .run/feed.toml.
    """

    def test_metrics_settings_reach_the_feed(self):
        cfg = {**STACK, "metrics": {"feed_port": 8790, "feed_bind": "0.0.0.0"}}
        feed = parse(rc.render_feed(cfg))
        self.assertEqual(feed["metrics_port"], 8790)
        self.assertEqual(feed["metrics_bind"], "0.0.0.0")

    def test_a_config_from_before_the_metrics_section_renders_it_off(self):
        # Every adsb-stack.toml created before this feature has no [metrics].
        # They must keep rendering, and must not gain a listening socket that
        # nobody asked for.
        feed = parse(rc.render_feed(STACK))
        self.assertEqual(feed["metrics_port"], 0)
        self.assertEqual(feed["metrics_bind"], "127.0.0.1")

    def test_the_fleet_feed_carries_its_own_node_s_port(self):
        # Per node: one Pi may be scraped and another not.
        f = dict(FLEET, nodes=dict(
            FLEET["nodes"],
            feed=dict(FLEET["nodes"]["feed"], metrics_port=8790,
                      metrics_bind="0.0.0.0"),
        ))
        feed = parse(rc.render_fleet_feed(f))
        self.assertEqual(feed["metrics_port"], 8790)
        self.assertEqual(feed["metrics_bind"], "0.0.0.0")

    def test_a_fleet_node_without_the_keys_renders_it_off(self):
        self.assertEqual(parse(rc.render_fleet_feed(FLEET))["metrics_port"], 0)

    def test_the_other_services_get_no_metrics_keys(self):
        # The recorder and the weather service serve /metrics on the port they
        # already have. A copy-paste of these lines into render_server or
        # render_weather would add a setting that does nothing, and a second
        # port for an operator to reserve and `doctor` to check for nothing.
        cfg = {**STACK, "metrics": {"feed_port": 8790}}
        recorder = parse(rc.render_server(cfg, REPO / ".run"))
        weather = parse(rc.render_weather(cfg, REPO / ".run"))
        self.assertNotIn("metrics_port", recorder)
        self.assertNotIn("metrics_bind", recorder)
        self.assertNotIn("metrics_port", weather)
        self.assertNotIn("metrics_bind", weather)


if __name__ == "__main__":
    unittest.main(verbosity=2)

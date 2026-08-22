"""The A2A agent card — how `adsb-agent` discovers what this service can do.

Card shape follows a2a-sdk v1.x: protobuf types, `supported_interfaces` rather
than a bare `url`, and modes declared on the card rather than on capabilities.
"""

from __future__ import annotations

from adsb_simulation_agent.agent_card import (
    SKILL_GENERATE_TRAJECTORY,
    build_agent_card,
)

BASE_URL = "http://localhost:8300"


class TestCardIdentity:
    def test_has_a_name_and_version(self):
        card = build_agent_card(BASE_URL)
        assert card.name
        assert card.version

    def test_description_mentions_what_it_makes(self):
        card = build_agent_card(BASE_URL)
        lowered = card.description.lower()
        assert "trajector" in lowered or "flight" in lowered


class TestInterfaces:
    def test_declares_a_jsonrpc_interface_at_the_given_url(self):
        """v1.0 replaced AgentCard.url with a supported_interfaces list."""
        card = build_agent_card(BASE_URL)
        assert len(card.supported_interfaces) >= 1
        iface = card.supported_interfaces[0]
        assert iface.url.startswith(BASE_URL)
        assert iface.protocol_binding == "JSONRPC"

    def test_url_tracks_the_base_url_argument(self):
        card = build_agent_card("http://192.168.1.50:9000")
        assert card.supported_interfaces[0].url.startswith("http://192.168.1.50:9000")


class TestSkills:
    def test_exposes_the_trajectory_generation_skill(self):
        card = build_agent_card(BASE_URL)
        ids = [s.id for s in card.skills]
        assert SKILL_GENERATE_TRAJECTORY in ids

    def test_skill_documents_its_inputs_in_the_description(self):
        card = build_agent_card(BASE_URL)
        skill = next(s for s in card.skills if s.id == SKILL_GENERATE_TRAJECTORY)
        lowered = skill.description.lower()
        assert "origin" in lowered
        assert "categor" in lowered

    def test_skill_carries_examples_for_discovery(self):
        """v1.0 moved `examples` from the card onto the skill."""
        card = build_agent_card(BASE_URL)
        skill = next(s for s in card.skills if s.id == SKILL_GENERATE_TRAJECTORY)
        assert len(skill.examples) >= 1

    def test_skill_is_tagged(self):
        card = build_agent_card(BASE_URL)
        skill = next(s for s in card.skills if s.id == SKILL_GENERATE_TRAJECTORY)
        assert "simulation" in skill.tags


class TestModes:
    def test_speaks_json_in_both_directions(self):
        card = build_agent_card(BASE_URL)
        assert "application/json" in card.default_input_modes
        assert "application/json" in card.default_output_modes

    def test_does_not_claim_streaming(self):
        """Generation is a single synchronous computation; nothing to stream."""
        assert build_agent_card(BASE_URL).capabilities.streaming is False


class TestSerialization:
    def test_card_round_trips_through_protobuf(self):
        """Protobuf messages must serialize — the route handler returns this."""
        card = build_agent_card(BASE_URL)
        raw = card.SerializeToString()
        assert raw

        from a2a.types import AgentCard

        restored = AgentCard()
        restored.ParseFromString(raw)
        assert restored.name == card.name

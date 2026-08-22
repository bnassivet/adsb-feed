"""The A2A agent card — this service's public capability description.

Served at ``/.well-known/agent-card.json`` (note: a2a-sdk v1.x renamed this from
the older ``agent.json``). ``adsb-agent`` fetches it to discover the endpoint and
skill before sending work.

Card shape follows a2a-sdk v1.x, which differs substantially from pre-1.0:
protobuf types rather than Pydantic, ``supported_interfaces`` rather than a bare
``url`` field, and input/output modes declared on the card rather than on
``AgentCapabilities``.
"""

from __future__ import annotations

from a2a.types import AgentCapabilities, AgentCard, AgentInterface, AgentSkill

SKILL_GENERATE_TRAJECTORY = "generate_trajectory"

AGENT_NAME = "adsb-simulation-agent"
AGENT_VERSION = "0.1.0"

AGENT_DESCRIPTION = (
    "Generates kinematically plausible simulated aircraft trajectories for the "
    "ADS-B desktop tracker's demo mode. Turns a natural-language route request "
    "into timed waypoints that respect real flight-dynamics limits."
)

SKILL_DESCRIPTION = (
    "Given an origin (receiver latitude/longitude), an aircraft category "
    "(airliner, ga, helicopter or fighter), and an optional free-text route "
    "hint, produce one or more aircraft each with timed waypoints carrying "
    "latitude, longitude, altitude, speed, heading and phase of flight. "
    "Turn rates, climb/descent rates and speeds are constrained to the "
    "requested category's performance envelope."
)

SKILL_EXAMPLES = [
    "police helicopter circling the old port at 1200 feet",
    "airliner on final approach from the west",
    "fighter doing an aerobatic display overhead",
    "three general aviation aircraft transiting the area",
]


def build_agent_card(base_url: str) -> AgentCard:
    """Build the agent card advertising this service at ``base_url``."""
    return AgentCard(
        name=AGENT_NAME,
        description=AGENT_DESCRIPTION,
        version=AGENT_VERSION,
        # v1.0: the bare `url` field was replaced by a list of interfaces, so a
        # single agent can expose several protocol bindings.
        supported_interfaces=[AgentInterface(url=base_url.rstrip("/"), protocol_binding="JSONRPC")],
        capabilities=AgentCapabilities(streaming=False, push_notifications=False),
        default_input_modes=["application/json"],
        default_output_modes=["application/json"],
        skills=[
            AgentSkill(
                id=SKILL_GENERATE_TRAJECTORY,
                name="Generate Flight Trajectory",
                description=SKILL_DESCRIPTION,
                tags=["simulation", "flight-dynamics", "adsb", "trajectory"],
                # v1.0 moved `examples` off the card and onto the skill.
                examples=SKILL_EXAMPLES,
                input_modes=["application/json"],
                output_modes=["application/json"],
            )
        ],
    )

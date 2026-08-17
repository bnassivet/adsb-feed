"""Entry point: python -m adsb_simulation_agent  (or uv run python -m adsb_simulation_agent)."""

import logging

from dotenv import load_dotenv

load_dotenv()  # populate os.environ before Settings() is instantiated

import uvicorn

from adsb_simulation_agent.config import settings
from adsb_simulation_agent.server import build_app, build_llm
from adsb_simulation_agent.tracing import setup_tracing

logging.basicConfig(level=logging.INFO)

# Before build_llm(): openai autolog patches the OpenAI SDK, so it has to run
# before ChatOpenAI constructs its client or LLM calls go untraced.
setup_tracing()

app = build_app(base_url=f"http://localhost:{settings.port}", llm=build_llm())

if __name__ == "__main__":
    uvicorn.run(app, host=settings.host, port=settings.port, timeout_graceful_shutdown=3)

"""Entry point: python -m adsb_agent  (or uv run python -m adsb_agent)."""
from dotenv import load_dotenv

load_dotenv()  # populate os.environ from .env before Settings() is instantiated

from adsb_agent.tracing import setup_tracing  # noqa: E402

setup_tracing()

import uvicorn  # noqa: E402

uvicorn.run(
    "adsb_agent.main:app",
    host="0.0.0.0",
    port=8000,
    reload=False,
    timeout_graceful_shutdown=3,
)

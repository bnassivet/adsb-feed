"""Entry point: python -m adsb_agent  (or uv run python -m adsb_agent)."""
import uvicorn

uvicorn.run(
    "adsb_agent.main:app",
    host="0.0.0.0",
    port=8000,
    reload=False,
    timeout_graceful_shutdown=3,
)

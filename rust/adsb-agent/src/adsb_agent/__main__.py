"""Entry point: python -m adsb_agent  (or uv run python -m adsb_agent)."""

from dotenv import load_dotenv

load_dotenv()  # populate os.environ from .env before Settings() is instantiated

import uvicorn  # noqa: E402

from adsb_agent.config import settings  # noqa: E402
from adsb_agent.tracing import setup_tracing  # noqa: E402


def main() -> None:
    """Serve the agent on its CONFIGURED address.

    `host` and `port` come from Settings, so `ADSB_AGENT_PORT` -- which
    `stack.sh` exports per stack -- is honoured. They used to be literals, which
    meant a second stack's agent bound :8000 whatever its config said: the
    `agent_port = 8010` in adsb-stack-prod.toml was simply not true, and a
    scrape job or a desktop pointed at 8010 would have found nothing there.

    `setup_tracing()` runs here rather than at import so that importing this
    module has no side effects -- it used to start a server and configure
    MLflow merely by being imported, which is also why nothing tested it.
    It still runs before `uvicorn.run` resolves "adsb_agent.main:app", which is
    the ordering that matters: openai autolog must patch the SDK before the app
    module constructs any client.
    """
    setup_tracing()
    uvicorn.run(
        "adsb_agent.main:app",
        host=settings.host,
        port=settings.port,
        reload=False,
        timeout_graceful_shutdown=3,
    )


if __name__ == "__main__":
    main()

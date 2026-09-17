"""The entry point serves on its CONFIGURED address, not a hardcoded one.

`stack.sh` exports ADSB_AGENT_PORT per stack, and adsb-stack-prod.toml sets
`agent_port = 8010`. Both were ignored: __main__ passed literal 8000, so a
second stack's agent bound the first stack's port and the config was a lie.
"""

import adsb_agent.__main__ as entrypoint
from adsb_agent.config import Settings


class _Recorder:
    """Stands in for uvicorn.run, capturing what it was asked to serve."""

    def __init__(self):
        self.calls = []

    def __call__(self, app, **kwargs):
        self.calls.append((app, kwargs))


def test_main_serves_on_the_configured_address(monkeypatch):
    recorder = _Recorder()
    monkeypatch.setattr(entrypoint, "uvicorn", type("_U", (), {"run": recorder})())
    monkeypatch.setattr(entrypoint, "setup_tracing", lambda: None)
    monkeypatch.setattr(
        entrypoint, "settings", Settings(_env_file=None, port=8010, host="127.0.0.1")
    )

    entrypoint.main()

    assert len(recorder.calls) == 1
    app, kwargs = recorder.calls[0]
    assert app == "adsb_agent.main:app"
    assert kwargs["port"] == 8010, "the port must come from Settings, not a literal"
    assert kwargs["host"] == "127.0.0.1"


def test_the_port_comes_from_the_environment(monkeypatch):
    # _env_file=None so a developer's .env cannot mask the variable.
    monkeypatch.setenv("ADSB_AGENT_PORT", "8010")
    assert Settings(_env_file=None).port == 8010


def test_the_host_comes_from_the_environment(monkeypatch):
    monkeypatch.setenv("ADSB_AGENT_HOST", "127.0.0.1")
    assert Settings(_env_file=None).host == "127.0.0.1"


def test_importing_the_entrypoint_starts_no_server():
    # It used to call uvicorn.run() at module level with no __main__ guard, so
    # merely importing it served the app and configured MLflow -- which is both
    # why it drifted and why nothing tested it. The import at the top of this
    # file is the assertion; `main` being callable is the proof it moved.
    assert callable(entrypoint.main)


def test_tracing_is_configured_before_serving(monkeypatch):
    # uvicorn.run resolves "adsb_agent.main:app" by import, and openai autolog
    # must patch the SDK before that module builds any client.
    order = []
    monkeypatch.setattr(entrypoint, "setup_tracing", lambda: order.append("tracing"))
    monkeypatch.setattr(
        entrypoint,
        "uvicorn",
        type("_U", (), {"run": lambda *a, **k: order.append("serve")})(),
    )

    entrypoint.main()

    assert order == ["tracing", "serve"]

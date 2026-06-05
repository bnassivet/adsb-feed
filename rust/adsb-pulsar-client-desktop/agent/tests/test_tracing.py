"""Tests for adsb_agent.tracing — MLflow tracing setup.

TDD sequence:
  1. Red: run these tests → all fail (tracing module doesn't exist yet)
  2. Green: implement tracing.py + config fields to make them pass
  3. Refactor: clean up without breaking tests

Mocking strategy:
  - mlflow is mocked via sys.modules injection so tests never require a real
    MLflow server or even the mlflow package to be importable.
  - Settings fields are overridden via monkeypatch on the singleton instance.
"""

from __future__ import annotations

import sys
from unittest.mock import MagicMock, call


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_mlflow_mock() -> MagicMock:
    """Build a minimal mlflow mock satisfying all setup_tracing() calls."""
    m = MagicMock(name="mlflow")
    m.openai = MagicMock(name="mlflow.openai")
    m.openai.autolog = MagicMock()
    m.set_tracking_uri = MagicMock()
    m.set_experiment = MagicMock()
    return m


def _inject(mock: MagicMock) -> None:
    sys.modules["mlflow"] = mock
    sys.modules["mlflow.openai"] = mock.openai


def _eject() -> None:
    sys.modules.pop("mlflow", None)
    sys.modules.pop("mlflow.openai", None)


# ---------------------------------------------------------------------------
# Config defaults and env-var overrides
# ---------------------------------------------------------------------------

class TestConfigMLflowFields:
    def test_mlflow_enabled_default_true(self, monkeypatch):
        monkeypatch.delenv("ADSB_AGENT_MLFLOW_ENABLED", raising=False)
        from adsb_agent.config import Settings
        assert Settings().mlflow_enabled is True

    def test_mlflow_tracking_uri_default(self, monkeypatch):
        monkeypatch.delenv("ADSB_AGENT_MLFLOW_TRACKING_URI", raising=False)
        from adsb_agent.config import Settings
        assert Settings().mlflow_tracking_uri == "http://localhost:5010"

    def test_mlflow_experiment_default(self, monkeypatch):
        monkeypatch.delenv("ADSB_AGENT_MLFLOW_EXPERIMENT", raising=False)
        from adsb_agent.config import Settings
        assert Settings().mlflow_experiment == "adsb-agent"

    def test_mlflow_enabled_overridden_by_env(self, monkeypatch):
        monkeypatch.setenv("ADSB_AGENT_MLFLOW_ENABLED", "false")
        from adsb_agent.config import Settings
        assert Settings().mlflow_enabled is False

    def test_mlflow_tracking_uri_overridden_by_env(self, monkeypatch):
        monkeypatch.setenv("ADSB_AGENT_MLFLOW_TRACKING_URI", "http://remote:5000")
        from adsb_agent.config import Settings
        assert Settings().mlflow_tracking_uri == "http://remote:5000"

    def test_mlflow_experiment_overridden_by_env(self, monkeypatch):
        monkeypatch.setenv("ADSB_AGENT_MLFLOW_EXPERIMENT", "my-exp")
        from adsb_agent.config import Settings
        assert Settings().mlflow_experiment == "my-exp"


# ---------------------------------------------------------------------------
# setup_tracing() — disabled path
# ---------------------------------------------------------------------------

class TestSetupTracingDisabled:
    def setup_method(self):
        sys.modules.pop("adsb_agent.tracing", None)
        _eject()

    def teardown_method(self):
        sys.modules.pop("adsb_agent.tracing", None)
        _eject()

    def test_disabled_does_not_import_mlflow(self, monkeypatch):
        from adsb_agent.config import settings
        monkeypatch.setattr(settings, "mlflow_enabled", False)

        # Poison the import — any real mlflow import would raise
        poison = MagicMock(side_effect=ImportError("must not be imported"))
        sys.modules["mlflow"] = poison  # type: ignore[assignment]

        from adsb_agent.tracing import setup_tracing
        setup_tracing()  # must not raise

        poison.set_experiment.assert_not_called()
        poison.openai.autolog.assert_not_called()

    def test_disabled_returns_none(self, monkeypatch):
        from adsb_agent.config import settings
        monkeypatch.setattr(settings, "mlflow_enabled", False)

        from adsb_agent.tracing import setup_tracing
        assert setup_tracing() is None


# ---------------------------------------------------------------------------
# setup_tracing() — enabled path
# ---------------------------------------------------------------------------

class TestSetupTracingEnabled:
    def setup_method(self):
        sys.modules.pop("adsb_agent.tracing", None)
        _eject()

    def teardown_method(self):
        sys.modules.pop("adsb_agent.tracing", None)
        _eject()

    def test_calls_openai_autolog(self, monkeypatch):
        from adsb_agent.config import settings
        monkeypatch.setattr(settings, "mlflow_enabled", True)
        monkeypatch.setattr(settings, "mlflow_tracking_uri", "")
        monkeypatch.setattr(settings, "mlflow_experiment", "adsb-agent")

        mock = _make_mlflow_mock()
        _inject(mock)

        from adsb_agent.tracing import setup_tracing
        setup_tracing()

        mock.openai.autolog.assert_called_once()

    def test_does_not_enable_langchain_autolog(self, monkeypatch):
        # The graph is instrumented manually; langchain autolog is intentionally
        # left off so its callback-based span tree doesn't fight our fluent spans.
        from adsb_agent.config import settings
        monkeypatch.setattr(settings, "mlflow_enabled", True)
        monkeypatch.setattr(settings, "mlflow_tracking_uri", "")
        monkeypatch.setattr(settings, "mlflow_experiment", "adsb-agent")

        mock = _make_mlflow_mock()
        _inject(mock)

        from adsb_agent.tracing import setup_tracing
        setup_tracing()

        mock.langchain.autolog.assert_not_called()

    def test_sets_experiment_name(self, monkeypatch):
        from adsb_agent.config import settings
        monkeypatch.setattr(settings, "mlflow_enabled", True)
        monkeypatch.setattr(settings, "mlflow_tracking_uri", "")
        monkeypatch.setattr(settings, "mlflow_experiment", "my-custom-experiment")

        mock = _make_mlflow_mock()
        _inject(mock)

        from adsb_agent.tracing import setup_tracing
        setup_tracing()

        mock.set_experiment.assert_called_once_with("my-custom-experiment")

    def test_custom_tracking_uri_applied(self, monkeypatch):
        from adsb_agent.config import settings
        monkeypatch.setattr(settings, "mlflow_enabled", True)
        monkeypatch.setattr(settings, "mlflow_tracking_uri", "http://mlflow.local:5000")
        monkeypatch.setattr(settings, "mlflow_experiment", "adsb-agent")

        mock = _make_mlflow_mock()
        _inject(mock)

        from adsb_agent.tracing import setup_tracing
        setup_tracing()

        mock.set_tracking_uri.assert_called_once_with("http://mlflow.local:5000")

    def test_empty_tracking_uri_skips_set_tracking_uri(self, monkeypatch):
        from adsb_agent.config import settings
        monkeypatch.setattr(settings, "mlflow_enabled", True)
        monkeypatch.setattr(settings, "mlflow_tracking_uri", "")
        monkeypatch.setattr(settings, "mlflow_experiment", "adsb-agent")

        mock = _make_mlflow_mock()
        _inject(mock)

        from adsb_agent.tracing import setup_tracing
        setup_tracing()

        mock.set_tracking_uri.assert_not_called()

    def test_call_order_uri_then_experiment_then_autolog(self, monkeypatch):
        from adsb_agent.config import settings
        monkeypatch.setattr(settings, "mlflow_enabled", True)
        monkeypatch.setattr(settings, "mlflow_tracking_uri", "sqlite:///mlflow.db")
        monkeypatch.setattr(settings, "mlflow_experiment", "adsb-agent")

        manager = MagicMock()
        mock = _make_mlflow_mock()
        mock.set_tracking_uri = manager.set_tracking_uri
        mock.set_experiment = manager.set_experiment
        mock.openai.autolog = manager.autolog
        _inject(mock)

        from adsb_agent.tracing import setup_tracing
        setup_tracing()

        assert manager.mock_calls == [
            call.set_tracking_uri("sqlite:///mlflow.db"),
            call.set_experiment("adsb-agent"),
            call.autolog(),
        ]

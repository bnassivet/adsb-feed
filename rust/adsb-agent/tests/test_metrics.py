"""The /metrics endpoint, and the logging it must not trigger."""

import logging
import sys

from fastapi.testclient import TestClient

from adsb_agent.main import app

client = TestClient(app)


def test_metrics_endpoint_returns_prometheus_text():
    response = client.get("/metrics")
    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/plain")
    assert "adsb_build_info" in response.text


def test_the_identity_series_names_this_service():
    body = client.get("/metrics").text
    assert 'service="adsb-agent"' in body


def test_runtime_metrics_come_for_free():
    body = client.get("/metrics").text
    # The GC collector is cross-platform.
    assert "python_gc_objects_collected_total" in body

    # The process collector is NOT: prometheus_client reads /proc for it, so
    # RSS exists on Linux and simply does not on macOS. That matters because
    # it is where the SSE-stream leak class of bug shows up first -- and the
    # deployments that would suffer it are Linux, while the laptop this is
    # usually developed on is not. Asserted where it is real, so its absence
    # elsewhere is a documented fact rather than a surprise.
    if sys.platform.startswith("linux"):
        assert "process_resident_memory_bytes" in body


def test_metrics_is_absent_from_the_openapi_schema():
    # include_in_schema=False. test_openapi.py asserts over the whole path set,
    # so a text/plain scrape surface appearing there would quietly change what
    # those assertions mean.
    schema = client.get("/openapi.json").json()
    assert "/metrics" not in schema["paths"]


def test_a_scrape_is_not_logged_by_the_request_middleware(caplog):
    # The middleware pretty-prints whole non-SSE response bodies. Unskipped,
    # a 15-second scrape would write the entire exposition into the log
    # forever and bury every real request.
    with caplog.at_level(logging.DEBUG, logger="adsb_agent"):
        client.get("/metrics")
    assert "========== REQUEST ==========" not in caplog.text


def test_health_is_not_logged_either(caplog):
    with caplog.at_level(logging.DEBUG, logger="adsb_agent"):
        client.get("/health")
    assert "========== REQUEST ==========" not in caplog.text


def test_ordinary_requests_are_still_logged(caplog):
    # The skip must be selective; a blanket disable would be a regression in
    # its own right.
    with caplog.at_level(logging.DEBUG, logger="adsb_agent"):
        client.get("/definitely-not-a-route")
    assert "========== REQUEST ==========" in caplog.text

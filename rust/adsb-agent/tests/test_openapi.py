"""Schema-level tests verifying that /openapi.json is complete and correct.

These tests do not exercise business logic — they assert that FastAPI generates
a fully-typed spec from the response/request models wired into each endpoint.
"""

from __future__ import annotations

import pytest
from httpx import ASGITransport, AsyncClient

from adsb_agent.main import app


@pytest.fixture
async def schema():
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as client:
        resp = await client.get("/openapi.json")
        assert resp.status_code == 200
        yield resp.json()


@pytest.fixture
async def client():
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as c:
        yield c


# ---------------------------------------------------------------------------
# Docs availability
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_openapi_json_available(client):
    resp = await client.get("/openapi.json")
    assert resp.status_code == 200


@pytest.mark.asyncio
async def test_docs_available(client):
    resp = await client.get("/docs")
    assert resp.status_code == 200


# ---------------------------------------------------------------------------
# Metadata
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_title(schema):
    assert schema["info"]["title"] == "ADS-B AG-UI Agent"


@pytest.mark.asyncio
async def test_version_present(schema):
    assert "version" in schema["info"]
    assert schema["info"]["version"]


@pytest.mark.asyncio
async def test_description_present(schema):
    assert "description" in schema["info"]
    assert schema["info"]["description"]


# ---------------------------------------------------------------------------
# Tags
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_health_tag(schema):
    op = schema["paths"]["/health"]["get"]
    assert "health" in op.get("tags", [])


@pytest.mark.asyncio
async def test_agui_info_tag(schema):
    op = schema["paths"]["/ag-ui/info"]["get"]
    assert "ag-ui" in op.get("tags", [])


@pytest.mark.asyncio
async def test_agui_chat_tag(schema):
    op = schema["paths"]["/ag-ui/chat"]["post"]
    assert "ag-ui" in op.get("tags", [])


@pytest.mark.asyncio
async def test_voice_backends_tag(schema):
    op = schema["paths"]["/voice/backends"]["get"]
    assert "voice" in op.get("tags", [])


@pytest.mark.asyncio
async def test_voice_start_tag(schema):
    op = schema["paths"]["/voice/start"]["post"]
    assert "voice" in op.get("tags", [])


@pytest.mark.asyncio
async def test_voice_status_tag(schema):
    op = schema["paths"]["/voice/status"]["get"]
    assert "voice" in op.get("tags", [])


@pytest.mark.asyncio
async def test_voice_transcript_tag(schema):
    op = schema["paths"]["/voice/transcript"]["get"]
    assert "voice" in op.get("tags", [])


# ---------------------------------------------------------------------------
# Response schemas on JSON endpoints
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_health_has_json_response_schema(schema):
    op = schema["paths"]["/health"]["get"]
    content = op["responses"]["200"].get("content", {})
    assert "application/json" in content


@pytest.mark.asyncio
async def test_agui_info_has_json_response_schema(schema):
    op = schema["paths"]["/ag-ui/info"]["get"]
    content = op["responses"]["200"].get("content", {})
    assert "application/json" in content


@pytest.mark.asyncio
async def test_voice_backends_has_json_response_schema(schema):
    op = schema["paths"]["/voice/backends"]["get"]
    content = op["responses"]["200"].get("content", {})
    assert "application/json" in content


@pytest.mark.asyncio
async def test_voice_stop_has_json_response_schema(schema):
    op = schema["paths"]["/voice/stop"]["post"]
    content = op["responses"]["200"].get("content", {})
    assert "application/json" in content


@pytest.mark.asyncio
async def test_voice_status_has_json_response_schema(schema):
    op = schema["paths"]["/voice/status"]["get"]
    content = op["responses"]["200"].get("content", {})
    assert "application/json" in content


# ---------------------------------------------------------------------------
# SSE endpoints documented with text/event-stream
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_agui_chat_documents_sse(schema):
    op = schema["paths"]["/ag-ui/chat"]["post"]
    content = op["responses"]["200"].get("content", {})
    assert "text/event-stream" in content


@pytest.mark.asyncio
async def test_agui_agent_run_documents_sse(schema):
    op = schema["paths"]["/ag-ui/agent/{agent_id}/run"]["post"]
    content = op["responses"]["200"].get("content", {})
    assert "text/event-stream" in content


@pytest.mark.asyncio
async def test_voice_transcript_documents_sse(schema):
    op = schema["paths"]["/voice/transcript"]["get"]
    content = op["responses"]["200"].get("content", {})
    assert "text/event-stream" in content


# ---------------------------------------------------------------------------
# Request body schemas on POST endpoints
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_voice_start_has_request_body(schema):
    op = schema["paths"]["/voice/start"]["post"]
    assert "requestBody" in op
    content = op["requestBody"]["content"]
    assert "application/json" in content


@pytest.mark.asyncio
async def test_agui_post_has_request_body(schema):
    op = schema["paths"]["/ag-ui"]["post"]
    assert "requestBody" in op


@pytest.mark.asyncio
async def test_agui_chat_has_request_body(schema):
    op = schema["paths"]["/ag-ui/chat"]["post"]
    assert "requestBody" in op


@pytest.mark.asyncio
async def test_agui_agent_run_has_request_body(schema):
    op = schema["paths"]["/ag-ui/agent/{agent_id}/run"]["post"]
    assert "requestBody" in op


# ---------------------------------------------------------------------------
# Components/schemas populated
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_components_schemas_non_empty(schema):
    schemas = schema.get("components", {}).get("schemas", {})
    assert len(schemas) >= 5


@pytest.mark.asyncio
async def test_health_response_in_components(schema):
    schemas = schema.get("components", {}).get("schemas", {})
    assert "HealthResponse" in schemas


@pytest.mark.asyncio
async def test_voice_start_request_in_components(schema):
    schemas = schema.get("components", {}).get("schemas", {})
    assert "VoiceStartRequest" in schemas


@pytest.mark.asyncio
async def test_runtime_info_response_in_components(schema):
    schemas = schema.get("components", {}).get("schemas", {})
    assert "RuntimeInfoResponse" in schemas

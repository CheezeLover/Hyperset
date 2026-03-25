#!/usr/bin/env python3

from typing import (
    Any,
    Dict,
    List,
    Optional,
    Tuple,
    AsyncIterator,
    Callable,
    TypeVar,
    Awaitable,
)
import os
import uuid
import httpx
import base64
import hashlib
import hmac as hmac_lib
import time
import sys
import datetime
import asyncio
import re
from contextlib import asynccontextmanager
from dataclasses import dataclass
from functools import wraps
from fastapi import HTTPException
from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.routing import Route
from mcp.server.fastmcp import FastMCP, Context
from mcp.server.transport_security import TransportSecuritySettings
from dotenv import load_dotenv
import json
import logging
from pathlib import Path
import redis.asyncio as aioredis

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(levelname)s - %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)

logger = logging.getLogger(__name__)

"""
Superset MCP Integration

This module provides a Model Control Protocol (MCP) server for Apache Superset,
enabling AI assistants to interact with and control a Superset instance programmatically.
"""

# Load environment variables from .env file
load_dotenv()

# ── Redis client (JTI replay cache — shared across replicas) ─────────────────
_REDIS_URL = os.getenv("REDIS_URL")
if not _REDIS_URL:
    raise RuntimeError(
        "REDIS_URL must be set for the JTI replay cache. "
        "Example: redis://hyperset-superset-redis:6379/3"
    )
_redis: aioredis.Redis = aioredis.Redis.from_url(
    _REDIS_URL,
    decode_responses=True,
    socket_connect_timeout=2,
    socket_timeout=2,
)

# ===== Security: SQL Validation =====
# Block ALL write operations (INSERT, UPDATE, DELETE) and DDL (DROP, ALTER, etc.)
# Allow ONLY read operations (SELECT, WITH, EXPLAIN, SHOW, DESCRIBE, etc.)
FORBIDDEN_SQL_PATTERNS = [
    r'\bINSERT\b',
    r'\bUPDATE\b',
    r'\bDELETE\b',
    r'\bMERGE\b',
    r'\bUPSERT\b',
    r'\b(DROP|TRUNCATE)\s+(TABLE|DATABASE|SCHEMA|INDEX|VIEW)\b',
    r'\bALTER\s+(TABLE|DATABASE|SCHEMA|USER|ROLE|INDEX|VIEW|COLUMN)\b',
    r'\bCREATE\s+(TABLE|DATABASE|SCHEMA|INDEX|VIEW|USER|ROLE|FUNCTION|PROCEDURE|TRIGGER)\b',
    r'\b(GRANT|REVOKE)\b',
    r';.*;',  # Multiple statements (prevents chained attacks)
]

def validate_sql(sql: str) -> None:
    """
    Validate SQL query for dangerous patterns.
    Raises ValueError if forbidden patterns are detected.
    """
    sql_upper = sql.upper()
    for pattern in FORBIDDEN_SQL_PATTERNS:
        if re.search(pattern, sql_upper):
            raise ValueError(f"Forbidden SQL pattern detected. Query rejected for security reasons.")
    
    # Additional checks
    if len(sql) > 50000:  # Prevent extremely large queries
        raise ValueError("SQL query too large (max 50KB)")

def sanitize_header(value: str) -> str:
    """
    Sanitize header values to prevent header injection attacks.
    Removes newlines, control characters, and limits length.
    """
    if not value:
        return ""
    # Remove CR, LF, and other control characters
    sanitized = re.sub(r'[\r\n\x00-\x1f\x7f]', '', str(value))
    # Limit length to prevent abuse
    return sanitized[:256]

# Load chart type catalog
_CHART_CATALOG: Dict[str, Any] = {}
_CHART_CATALOG_PATH = Path(__file__).parent / "chart_type.json"
try:
    with open(_CHART_CATALOG_PATH) as _f:
        _CHART_CATALOG = json.load(_f)
    logger.info("Loaded chart catalog: %s types", len(_CHART_CATALOG.get("types", {})))
except Exception as _e:
    logger.warning("Could not load chart_type.json: %s", _e)

# Constants
_superset_upstream = os.getenv("SUPERSET_UPSTREAM") or os.getenv("SUPERSET_BASE_URL")
if not _superset_upstream:
    raise RuntimeError(
        "SUPERSET_UPSTREAM (or SUPERSET_BASE_URL) must be set. "
        "Example: http://hyperset-superset:8088"
    )
SUPERSET_BASE_URL = _superset_upstream

# Public URL used to build browser-accessible embed links.
# Must be reachable by the end-user's browser (not an internal upstream address).
# Derived automatically from HYPERSET_DOMAIN if not explicitly set.
_superset_public_url_env = os.getenv("SUPERSET_PUBLIC_URL", "")
_hyperset_domain = os.getenv("HYPERSET_DOMAIN", "")
if _superset_public_url_env:
    _superset_public = _superset_public_url_env.strip()
    if not re.match(r"^https?://", _superset_public, flags=re.IGNORECASE):
        _superset_public = f"https://{_superset_public}"
    SUPERSET_PUBLIC_URL = _superset_public.rstrip("/")
elif _hyperset_domain:
    SUPERSET_PUBLIC_URL = f"https://superset.{_hyperset_domain}"
else:
    SUPERSET_PUBLIC_URL = SUPERSET_BASE_URL

# ── AI chart cleanup identity ───────────────────────────────────────────────
# Superset user that the auto-cleanup job impersonates when deleting stale charts.
# Must exist as a valid Superset user (admin recommended).
# Override via env vars if your admin account has a different name/email.
CLEANUP_USER  = os.getenv("HYPERSET_CLEANUP_USER",  "admin@HYPERSET.local")
CLEANUP_EMAIL = os.getenv("HYPERSET_CLEANUP_EMAIL", "admin@HYPERSET.local")

# ── Portal URL (for fetching runtime admin settings) ──────────────────────
# Derived automatically from HYPERSET_DOMAIN (already required by the stack).
# Override with HYPERSET_PORTAL_URL only if your portal runs on a non-standard
# host (e.g. http://localhost:3000 in local dev without the domain setup).
# If neither is set the cleanup job falls back to HYPERSET_CLEANUP_DELAY_MINUTES.
_hyperset_domain = os.getenv("HYPERSET_DOMAIN", "")


def _normalize_url_with_default_https(raw_url: str) -> str:
    """
    Normalize service URLs from env vars.
    If protocol is missing, default to https://.
    """
    url = (raw_url or "").strip()
    if not url:
        return ""
    if not re.match(r"^https?://", url, flags=re.IGNORECASE):
        url = f"https://{url}"
    return url.rstrip("/")


PORTAL_URL = _normalize_url_with_default_https(
    os.getenv("HYPERSET_PORTAL_URL")
    or (f"https://{_hyperset_domain}" if _hyperset_domain else "")
)


def _portal_url_candidates() -> list[str]:
    """Return portal base URLs to try, in priority order."""
    candidates: list[str] = []

    explicit = _normalize_url_with_default_https(os.getenv("HYPERSET_PORTAL_URL", ""))
    if explicit:
        candidates.append(explicit)

    if _hyperset_domain:
        candidates.append(_normalize_url_with_default_https(f"https://{_hyperset_domain}"))

    if not candidates:
        logger.warning(
            "Neither HYPERSET_PORTAL_URL nor HYPERSET_DOMAIN is set. "
            "The cleanup job will fall back to HYPERSET_CLEANUP_DELAY_MINUTES. "
            "Set HYPERSET_PORTAL_URL to enable runtime configuration."
        )

    # De-duplicate while preserving order
    seen: set[str] = set()
    ordered: list[str] = []
    for c in candidates:
        if c and c not in seen:
            seen.add(c)
            ordered.append(c)
    return ordered

# Regex to extract the ISO timestamp written into AI chart descriptions.
_AI_STAMP_RE = re.compile(
    r'\[HYPERSET-AI-TEMPORARY\]\s+(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z)'
)

# ── Token verification ─────────────────────────────────────────
_MCP_SECRET = os.getenv("MCP_SERVICE_SECRET", "")
if not _MCP_SECRET or len(_MCP_SECRET) < 32:
    raise RuntimeError("MCP_SERVICE_SECRET must be set and >= 32 chars")
_SECRET_BYTES = _MCP_SECRET.encode()

@dataclass
class VerifiedIdentity:
    username: str
    email: str
    roles: list[str]

# ── JTI replay cache — prevents token reuse within the token's lifetime ──────
# Uses Redis SET NX (set-if-not-exists) for atomic check-and-set that is safe
# across multiple replicas. Key format: mcp:jti:<jti>  TTL = token remaining lifetime.

async def _claim_jti(jti: str, exp_ms: float) -> None:
    """Mark a JTI as consumed; raises ValueError if already seen (replay)."""
    now_ms = time.time() * 1000
    ttl_seconds = max(1, int((exp_ms - now_ms) / 1000) + 1)
    was_set = await _redis.set(f"mcp:jti:{jti}", "1", nx=True, ex=ttl_seconds)
    if not was_set:
        raise ValueError("Token replay detected")

def _b64url_decode(s: str) -> bytes:
    padding = 4 - len(s) % 4
    return base64.urlsafe_b64decode(s + "=" * (padding % 4))

async def verify_mcp_token(token: str) -> VerifiedIdentity:
    parts = token.split(".")
    if len(parts) != 2:
        raise ValueError("Malformed token")
    encoded, sig = parts
    expected = hmac_lib.new(_SECRET_BYTES, encoded.encode(), hashlib.sha256)
    expected_b64 = base64.urlsafe_b64encode(expected.digest()).rstrip(b"=").decode()
    if not hmac_lib.compare_digest(sig, expected_b64):
        raise ValueError("Invalid signature")
    try:
        payload = json.loads(_b64url_decode(encoded))
    except Exception:
        raise ValueError("Cannot decode payload")
    if time.time() * 1000 > payload.get("exp", 0):
        raise ValueError("Token expired")
    jti = payload.get("jti")
    if not jti:
        raise ValueError("Missing 'jti' claim")
    await _claim_jti(jti, payload.get("exp", 0))
    username = payload.get("sub")
    if not username:
        raise ValueError("Missing 'sub' claim")
    return VerifiedIdentity(
        username=username,
        email=payload.get("email", ""),
        roles=payload.get("roles", []),
    )

async def extract_identity(request) -> VerifiedIdentity:
    # Cache the verified identity on request.state so verify_mcp_token (and
    # therefore _claim_jti) is only called ONCE per HTTP request.  Without this
    # cache, tools like superset_analyze_data that call superset_request()
    # multiple times internally would re-run _claim_jti with the same JTI on
    # every sub-call, causing "Token replay detected" on call #2 onwards.
    if not hasattr(request.state, "_verified_identity"):
        auth = request.headers.get("authorization", "")
        if not auth.startswith("Bearer "):
            raise ValueError("Missing Authorization header")
        request.state._verified_identity = await verify_mcp_token(auth[7:])
    return request.state._verified_identity

# ── Health endpoint (Starlette-native, injected into the MCP app's router) ───
async def _health_endpoint(request: Request) -> JSONResponse:
    """Liveness and readiness probe for K8s / orchestrators."""
    try:
        await _redis.ping()
        redis_ok = True
    except Exception:
        redis_ok = False
    return JSONResponse(
        {
            "status": "ok" if redis_ok else "degraded",
            "service": "superset-mcp",
            "redis": "ok" if redis_ok else "error",
        },
        status_code=200 if redis_ok else 503,
    )

# Shared HTTP client and context
_shared_client: Optional[httpx.AsyncClient] = None
_shared_ctx: Optional["SupersetContext"] = None

# Dedicated client for the background cleanup job (separate cookie jar from user sessions)
_cleanup_client: Optional[httpx.AsyncClient] = None
_cleanup_task: Optional[asyncio.Task] = None

@dataclass
class SupersetContext:
    """Typed context for the Superset MCP server"""
    client: httpx.AsyncClient
    base_url: str

@asynccontextmanager
async def superset_lifespan(server: FastMCP) -> AsyncIterator[SupersetContext]:
    """Manage application lifecycle for Superset integration."""
    global _shared_client, _shared_ctx, _cleanup_client, _cleanup_task

    if _shared_ctx is None:
        logger.info(f"Initializing Superset MCP ({SUPERSET_BASE_URL})")
        client = httpx.AsyncClient(base_url=SUPERSET_BASE_URL, timeout=30.0)
        _shared_ctx = SupersetContext(client=client, base_url=SUPERSET_BASE_URL)
        _shared_client = client
        # Separate client for cleanup so its session cookies never collide with user sessions
        _cleanup_client = httpx.AsyncClient(base_url=SUPERSET_BASE_URL, timeout=30.0)

    # Start background cleanup task (idempotent — only one runs at a time).
    # IMPORTANT: do NOT cancel this task in the finally block.
    # With stateless HTTP transport the lifespan is re-entered on every request;
    # cancelling in finally would kill the task after the very first request and
    # the cleanup loop would never get to run.  The task is a process-level
    # resource and is intentionally left running until the process exits.
    if _cleanup_task is None or _cleanup_task.done():
        _cleanup_task = asyncio.create_task(_cleanup_ai_charts_loop())
        logger.info("AI chart cleanup background task started")

    yield _shared_ctx

# Allow the portal container to reach the MCP server by its container hostname.
# The Host header sent by the portal will be "hyperset-superset-mcp:8000" (or
# whatever the compose service is named).  Both bare-hostname and hostname:port
# variants must be listed because HTTP clients may or may not include the port.
_mcp_host_port = int(os.getenv("MCP_PORT", "8000"))
_mcp_container  = os.getenv("MCP_CONTAINER_NAME", "hyperset-superset-mcp")

# Initialize FastMCP server
mcp = FastMCP(
    "superset",
    lifespan=superset_lifespan,
    dependencies=["fastapi", "uvicorn", "python-dotenv", "httpx"],
    stateless_http=True,
    transport_security=TransportSecuritySettings(
        enable_dns_rebinding_protection=True,
        allowed_hosts=[
            "localhost",
            f"localhost:{_mcp_host_port}",
            "127.0.0.1",
            f"127.0.0.1:{_mcp_host_port}",
            _mcp_container,
            f"{_mcp_container}:{_mcp_host_port}",
        ],
    ),
)

# Type variables
T = TypeVar("T")
R = TypeVar("R")

# ===== Helper Functions =====

def handle_api_errors(
    func: Callable[..., Awaitable[Dict[str, Any]]],
) -> Callable[..., Awaitable[Dict[str, Any]]]:
    """Decorator to handle API errors in a consistent way"""

    @wraps(func)
    async def wrapper(ctx: Context, *args, **kwargs) -> Dict[str, Any]:
        try:
            return await func(ctx, *args, **kwargs)
        except Exception as e:
            function_name = func.__name__
            return {"error": f"Error in {function_name}: {str(e)}"}

    return wrapper

async def superset_request(
    ctx: Context,
    method: str,
    endpoint: str,
    data: dict = None,
    params: dict = None,
) -> dict:
    sc: SupersetContext = ctx.request_context.lifespan_context
    try:
        identity = await extract_identity(ctx.request_context.request)
    except ValueError as e:
        return {"error": f"Authentication failed: {e}"}
    logger.info("MCP call: %s %s (user=%s)", method.upper(), endpoint, identity.username)
    
    # Headers locaux à cet appel - SECURITY: Sanitize to prevent header injection
    req_headers = {
        "X-Webauth-User": sanitize_header(identity.username),
        "X-Webauth-Email": sanitize_header(identity.email),
        "X-Webauth-Groups": sanitize_header(" ".join(identity.roles)),
    }
    
    if method.lower() != "get":
        csrf_resp = await sc.client.get(
            "/api/v1/security/csrf_token/",
            headers=req_headers,
        )
        if csrf_resp.status_code == 200:
            req_headers["X-CSRFToken"] = csrf_resp.json().get("result", "")
    
    if method.lower() == "get":
        resp = await sc.client.get(endpoint, params=params, headers=req_headers)
    elif method.lower() == "post":
        resp = await sc.client.post(endpoint, json=data, params=params, headers=req_headers)
    elif method.lower() == "put":
        resp = await sc.client.put(endpoint, json=data, headers=req_headers)
    elif method.lower() == "delete":
        resp = await sc.client.delete(endpoint, headers=req_headers)
    else:
        return {"error": f"Unsupported method: {method}"}
    
    if resp.status_code not in [200, 201]:
        return {"error": f"Superset {resp.status_code}: {resp.text}"}
    return resp.json()

# ===== Slim list helpers =====
# Superset API list endpoints return 30+ fields per item.  These helpers keep
# only the fields the model needs so tool results stay small for low-context models.

def _slim_dashboards(raw: Dict[str, Any]) -> Dict[str, Any]:
    result = raw.get("result", [])
    return {
        "count": raw.get("count", len(result)),
        "result": [
            {"id": d.get("id"), "title": d.get("dashboard_title"), "status": d.get("status")}
            for d in result
        ],
    }

def _slim_charts(raw: Dict[str, Any]) -> Dict[str, Any]:
    result = raw.get("result", [])
    return {
        "count": raw.get("count", len(result)),
        "result": [
            {
                "id": c.get("id"),
                "slice_name": c.get("slice_name"),
                "viz_type": c.get("viz_type"),
                "datasource_id": c.get("datasource_id"),
            }
            for c in result
        ],
    }

def _slim_datasets(raw: Dict[str, Any]) -> Dict[str, Any]:
    result = raw.get("result", [])
    return {
        "count": raw.get("count", len(result)),
        "result": [
            {
                "id": d.get("id"),
                "table_name": d.get("table_name"),
                "schema": d.get("schema"),
                "database_id": (d.get("database") or {}).get("id"),
            }
            for d in result
        ],
    }

def _slim_databases(raw: Dict[str, Any]) -> Dict[str, Any]:
    result = raw.get("result", [])
    return {
        "count": raw.get("count", len(result)),
        "result": [
            {"id": db.get("id"), "database_name": db.get("database_name"), "backend": db.get("backend")}
            for db in result
        ],
    }


# ===== AI chart provenance helpers =====

async def _direct_superset_request(
    method: str,
    endpoint: str,
    data: dict = None,
    params: dict = None,
) -> dict:
    """
    Make a Superset API call using the cleanup identity, without going through the
    MCP context.  Uses a dedicated httpx client so its session cookies never
    interfere with per-user sessions.
    """
    if _cleanup_client is None:
        return {"error": "Cleanup client not initialized"}
    req_headers = {
        "X-Webauth-User":  CLEANUP_USER,
        "X-Webauth-Email": CLEANUP_EMAIL,
    }
    try:
        if method.lower() != "get":
            csrf_resp = await _cleanup_client.get(
                "/api/v1/security/csrf_token/", headers=req_headers
            )
            if csrf_resp.status_code == 200:
                req_headers["X-CSRFToken"] = csrf_resp.json().get("result", "")
        if method.lower() == "get":
            resp = await _cleanup_client.get(endpoint, params=params, headers=req_headers)
        elif method.lower() == "delete":
            resp = await _cleanup_client.delete(endpoint, headers=req_headers)
        elif method.lower() == "put":
            resp = await _cleanup_client.put(endpoint, json=data, headers=req_headers)
        else:
            return {"error": f"Unsupported method: {method}"}
        if resp.status_code == 204 or not resp.content:
            return {"ok": True}
        if resp.status_code not in (200, 201):
            return {"error": f"Superset {resp.status_code}: {resp.text[:200]}"}
        return resp.json()
    except Exception as e:
        return {"error": f"Request failed: {e}"}


def _extract_chart_ids_from_dashboard_data(data: Any) -> set:
    """
    Recursively scan dashboard create/update payload for all referenced chart IDs.
    Handles both the simple ``charts: [id, ...]`` format and the nested
    Superset ``position_json`` layout tree (where charts live as
    ``{"type": "CHART", "meta": {"chartId": N}}``) — including when
    ``position_json`` is an embedded JSON string.
    """
    chart_ids: set = set()
    if isinstance(data, dict):
        # CHART node in a position layout
        if data.get("type") == "CHART":
            meta = data.get("meta", {})
            if isinstance(meta, dict):
                try:
                    chart_ids.add(int(meta["chartId"]))
                except (KeyError, TypeError, ValueError):
                    pass
        # Simple charts list: {"charts": [1, 2, 3]}
        charts_list = data.get("charts")
        if isinstance(charts_list, list):
            for cid in charts_list:
                try:
                    chart_ids.add(int(cid))
                except (TypeError, ValueError):
                    pass
        # Recurse into every value; try JSON-parsing string values (position_json)
        for v in data.values():
            if isinstance(v, (dict, list)):
                chart_ids |= _extract_chart_ids_from_dashboard_data(v)
            elif isinstance(v, str) and len(v) > 10:
                try:
                    parsed = json.loads(v)
                    if isinstance(parsed, (dict, list)):
                        chart_ids |= _extract_chart_ids_from_dashboard_data(parsed)
                except (json.JSONDecodeError, ValueError):
                    pass
    elif isinstance(data, list):
        for item in data:
            chart_ids |= _extract_chart_ids_from_dashboard_data(item)
    return chart_ids


async def _promote_ai_charts_to_permanent(ctx: Context, chart_ids: set) -> None:
    """
    For each chart ID, if the chart description contains ``[HYPERSET-AI-TEMPORARY]``
    (but not ``[HYPERSET-AI-PERMANENT]``), promote it to permanent so the
    cleanup job will no longer delete it.  Errors are logged and skipped —
    dashboard creation is never blocked by a promotion failure.
    """
    for chart_id in chart_ids:
        try:
            chart_resp = await superset_request(ctx, "get", f"/api/v1/chart/{chart_id}")
            if "error" in chart_resp:
                continue
            desc = chart_resp.get("result", {}).get("description") or ""
            if "[HYPERSET-AI-TEMPORARY]" in desc and "[HYPERSET-AI-PERMANENT]" not in desc:
                new_desc = desc.replace("[HYPERSET-AI-TEMPORARY]", "[HYPERSET-AI-PERMANENT]")
                await superset_request(
                    ctx, "put", f"/api/v1/chart/{chart_id}",
                    data={"description": new_desc},
                )
                logger.info("Promoted AI chart %d to permanent (added to dashboard)", chart_id)
        except Exception as e:
            logger.warning("Failed to promote chart %d to permanent: %s", chart_id, e)


async def _get_cleanup_delay_minutes() -> float:
    """
    Return the configured temporary-chart lifetime in minutes.

    Tries to read it from the portal's ``/api/cleanup-config`` endpoint first
    (so admin-panel changes take effect without restarting the MCP server).
    Falls back to the ``HYPERSET_CLEANUP_DELAY_MINUTES`` environment variable,
    then to a hardcoded default of 120 minutes (2 hours).
    """
    default = float(os.getenv("HYPERSET_CLEANUP_DELAY_MINUTES", "120"))
    mcp_secret = os.getenv("MCP_SERVICE_SECRET", "")
    headers = {"Authorization": f"Bearer {mcp_secret}"} if mcp_secret else {}
    for portal_base in _portal_url_candidates():
        try:
            async with httpx.AsyncClient(timeout=5.0) as c:
                r = await c.get(f"{portal_base}/api/cleanup-config", headers=headers)
                if r.status_code == 200:
                    minutes = float(r.json().get("cleanupDelayMinutes", default))
                    return max(1.0, min(10080.0, minutes))
        except Exception as e:
            logger.debug(
                "Could not fetch cleanup delay from portal (%s): %s",
                portal_base,
                e,
            )
    logger.debug("Using default cleanup delay %.0f min (portal unreachable)", default)
    return default


async def _run_ai_chart_cleanup(delay_minutes: float) -> None:
    """
    Delete all ``[HYPERSET-AI-TEMPORARY]`` charts whose embedded timestamp is
    older than ``delay_minutes``.  Charts flagged ``[HYPERSET-AI-PERMANENT]`` are
    never touched.  Uses the dedicated cleanup client / identity so it never
    disrupts user sessions.
    """
    cutoff = datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(minutes=delay_minutes)
    page = 0
    total_deleted = 0

    while True:
        q = json.dumps({
            "filters": [{"col": "description", "opr": "ct", "value": "[HYPERSET-AI-TEMPORARY]"}],
            "page": page,
            "page_size": 100,
        })
        resp = await _direct_superset_request("get", "/api/v1/chart/", params={"q": q})
        if "error" in resp:
            logger.warning("AI cleanup: chart list query failed: %s", resp["error"])
            break

        charts = resp.get("result", [])
        if not charts:
            break

        for chart in charts:
            desc = chart.get("description") or ""
            if "[HYPERSET-AI-PERMANENT]" in desc:
                continue  # user kept this one explicitly
            if "[HYPERSET-AI-TEMPORARY]" not in desc:
                continue  # filter returned a false positive — skip

            m = _AI_STAMP_RE.search(desc)
            if not m:
                continue  # malformed stamp — leave alone

            try:
                ts = datetime.datetime.fromisoformat(m.group(1).replace("Z", "+00:00"))
            except ValueError:
                continue

            if ts >= cutoff:
                continue  # not yet past the configured delay — keep

            chart_id = chart.get("id")
            if chart_id is None:
                continue

            result = await _direct_superset_request("delete", f"/api/v1/chart/{chart_id}")
            if "error" not in result:
                total_deleted += 1
                logger.info("AI cleanup: deleted chart %d (stamped %s)", chart_id, ts.isoformat())
            else:
                logger.warning(
                    "AI cleanup: failed to delete chart %d: %s", chart_id, result["error"]
                )

        page += 1
        if len(charts) < 100:
            break  # last page reached

    if total_deleted:
        logger.info("AI chart cleanup complete — deleted %d chart(s)", total_deleted)
    else:
        logger.debug("AI chart cleanup complete — nothing to delete")


async def _cleanup_ai_charts_loop() -> None:
    """
    Background coroutine: wait 60 s for Superset to finish initialising,
    then run the cleanup every 5 minutes.  The deletion cutoff is fetched
    dynamically from the portal on every cycle so admin-panel changes are
    picked up without restarting the server.
    """
    await asyncio.sleep(60)
    while True:
        try:
            delay_minutes = await _get_cleanup_delay_minutes()
            logger.debug("AI chart cleanup: using delay of %.0f minute(s)", delay_minutes)
            await _run_ai_chart_cleanup(delay_minutes)
        except Exception as e:
            logger.error("AI chart cleanup loop error: %s", e)
        await asyncio.sleep(300)  # 5 minutes


# ===== Dashboard Tools =====

@mcp.tool()
@handle_api_errors
async def superset_dashboard_list(ctx: Context) -> Dict[str, Any]:
    """
    Get a list of dashboards from Superset (id, title, status only).

    Returns:
        count and result list with id, title, status
    """
    raw = await superset_request(ctx, "get", "/api/v1/dashboard/")
    if "error" in raw:
        return raw
    return _slim_dashboards(raw)

@mcp.tool()
@handle_api_errors
async def superset_dashboard_get_by_id(
    ctx: Context, dashboard_id: int
) -> Dict[str, Any]:
    """
    Get details for a specific dashboard

    Args:
        dashboard_id: ID of the dashboard to retrieve

    Returns:
        A dictionary with complete dashboard information including components and layout
    """
    return await superset_request(ctx, "get", f"/api/v1/dashboard/{dashboard_id}")

@mcp.tool()
@handle_api_errors
async def superset_dashboard_create(
    ctx: Context, dashboard_title: str, json_metadata: Dict[str, Any] = None
) -> Dict[str, Any]:
    """
    Create a new dashboard in Superset

    Args:
        dashboard_title: Title of the dashboard
        json_metadata: Optional JSON metadata for dashboard configuration

    Returns:
        A dictionary with the created dashboard information including its ID
    """
    payload = {"dashboard_title": dashboard_title}
    if json_metadata:
        payload["json_metadata"] = json_metadata

    result = await superset_request(ctx, "post", "/api/v1/dashboard/", data=payload)

    # Auto-promote any AI charts referenced in the dashboard layout
    if not result.get("error") and json_metadata:
        chart_ids = _extract_chart_ids_from_dashboard_data(
            json_metadata if isinstance(json_metadata, dict) else {"_jm": json_metadata}
        )
        if chart_ids:
            await _promote_ai_charts_to_permanent(ctx, chart_ids)

    return result

@mcp.tool()
@handle_api_errors
async def superset_dashboard_update(
    ctx: Context, dashboard_id: int, data: Dict[str, Any]
) -> Dict[str, Any]:
    """
    Update an existing dashboard

    Args:
        dashboard_id: ID of the dashboard to update
        data: Data to update, can include dashboard_title, slug, owners, position, and metadata

    Returns:
        A dictionary with the updated dashboard information
    """
    result = await superset_request(ctx, "put", f"/api/v1/dashboard/{dashboard_id}", data=data)

    # Auto-promote any AI charts that appear in the updated layout
    if not result.get("error") and isinstance(data, dict):
        chart_ids = _extract_chart_ids_from_dashboard_data(data)
        if chart_ids:
            await _promote_ai_charts_to_permanent(ctx, chart_ids)

    return result

@mcp.tool()
@handle_api_errors
async def superset_dashboard_add_charts(
    ctx: Context,
    dashboard_id: int,
    chart_ids: List[int],
) -> Dict[str, Any]:
    """
    Add charts to an existing dashboard by generating the correct position_json layout.
    Arranges charts in a grid (up to 3 per row, width 4 each out of 12 columns).
    Always call this after superset_dashboard_create to populate a new dashboard with charts.

    Args:
        dashboard_id: ID of the dashboard to update
        chart_ids: List of chart IDs to add to the dashboard

    Returns:
        A dictionary with the updated dashboard information
    """
    if not chart_ids:
        return {"error": "No chart IDs provided"}

    # ── Validate that every chart ID actually exists ──────────────────────────
    # If the LLM lost chart IDs from context and hallucinated IDs, Superset will
    # silently store the layout but show "no chart definition" for each slot.
    # Detecting this early returns an actionable error so the LLM can self-correct.
    missing_ids: List[int] = []
    for cid in chart_ids:
        check = await superset_request(ctx, "get", f"/api/v1/chart/{cid}")
        if check.get("error") or "result" not in check:
            missing_ids.append(cid)

    if missing_ids:
        return {
            "error": (
                f"Charts not found in Superset: {missing_ids}. "
                "These chart IDs do not exist — they may have been hallucinated "
                "because chart_create results scrolled off the context window. "
                "Call superset_chart_list (results are sorted newest-first) to "
                "find the charts you just created by name, then retry "
                "superset_dashboard_add_charts with the correct IDs."
            ),
            "missing_chart_ids": missing_ids,
        }

    # ── Fetch chart UUIDs for the position_json ──────────────────────────────
    # Superset 6.0+ requires UUIDs for chart components
    chart_uuids: Dict[int, str] = {}
    for cid in chart_ids:
        chart_resp = await superset_request(ctx, "get", f"/api/v1/chart/{cid}")
        if not chart_resp.get("error") and "result" in chart_resp:
            chart_uuid = chart_resp["result"].get("uuid")
            if chart_uuid:
                chart_uuids[cid] = str(chart_uuid)

    # ── All IDs verified — proceed to build the layout ────────────────────────
    # Superset 6.0+ uses UUID-based IDs and requires COLUMN wrapper

    charts_per_row = 3
    chart_width = 4   # Superset grid is 12 columns wide
    chart_height = 50

    position: Dict[str, Any] = {
        "ROOT_ID": {
            "id": "ROOT_ID",
            "type": "ROOT",
            "children": ["GRID_ID"],
            "parents": [],
        },
        "GRID_ID": {
            "id": "GRID_ID",
            "type": "GRID",
            "children": [],
            "parents": ["ROOT_ID"],
        },
    }

    row_ids: List[str] = []
    for row_idx, row_start in enumerate(range(0, len(chart_ids), charts_per_row)):
        row_chart_ids = chart_ids[row_start : row_start + charts_per_row]
        # Use UUID-based IDs for Superset 6.0+ compatibility
        row_id = f"ROW-{uuid.uuid4().hex[:8]}"
        column_ids: List[str] = []

        position[row_id] = {
            "id": row_id,
            "type": "ROW",
            "children": [],
            "parents": ["ROOT_ID", "GRID_ID"],
            "meta": {"background": "BACKGROUND_TRANSPARENT"},
        }
        row_ids.append(row_id)

        for cid in row_chart_ids:
            # Each chart needs a COLUMN wrapper in Superset 6.0+
            column_id = f"COLUMN-{uuid.uuid4().hex[:8]}"
            column_ids.append(column_id)
            chart_node_id = f"CHART-{cid}"

            position[column_id] = {
                "id": column_id,
                "type": "COLUMN",
                "children": [chart_node_id],
                "parents": ["ROOT_ID", "GRID_ID", row_id],
                "meta": {
                    "background": "BACKGROUND_TRANSPARENT",
                    "width": chart_width,
                },
            }

            # Get the UUID for this chart, fallback to generated UUID
            chart_uuid = chart_uuids.get(cid, f"chart-{cid}")

            position[chart_node_id] = {
                "id": chart_node_id,
                "type": "CHART",
                "children": [],
                "parents": ["ROOT_ID", "GRID_ID", row_id, column_id],
                "meta": {
                    "chartId": cid,
                    "height": chart_height,
                    "width": chart_width,
                    "uuid": chart_uuid,
                },
            }

        # Update ROW children to include COLUMN IDs
        position[row_id]["children"] = column_ids

    position["GRID_ID"]["children"] = row_ids

    # First get existing dashboard to preserve metadata
    existing = await superset_request(ctx, "get", f"/api/v1/dashboard/{dashboard_id}")
    existing_metadata = {}
    if not existing.get("error") and "result" in existing:
        existing_json = existing["result"].get("json_metadata")
        if existing_json:
            try:
                existing_metadata = json.loads(existing_json) if isinstance(existing_json, str) else existing_json
            except (json.JSONDecodeError, ValueError):
                pass

    # Update metadata to disable caching
    existing_metadata["refresh_frequency"] = 0
    
    data = {
        "position_json": json.dumps(position),
        "json_metadata": json.dumps(existing_metadata),
    }
    result = await superset_request(
        ctx, "put", f"/api/v1/dashboard/{dashboard_id}", data=data
    )

    # Log the chart properties to debug "on dashboard" issue
    if not result.get("error"):
        for cid in chart_ids:
            chart_resp = await superset_request(ctx, "get", f"/api/v1/chart/{cid}")
            if not chart_resp.get("error") and "result" in chart_resp:
                chart_data = chart_resp["result"]
                dashboards = chart_data.get("dashboards")
                print(f"=== DEBUG: Chart {cid} properties ===")
                print(f"dashboards field: {dashboards}")
                print(f"full chart data keys: {list(chart_data.keys())}")
                sys.stdout.flush()

    # Trigger cache invalidation - force Superset to refresh the dashboard
    if not result.get("error"):
        try:
            await superset_request(
                ctx, "get", f"/api/v1/dashboard/{dashboard_id}/cache", 
            )
        except Exception:
            pass

    if not result.get("error"):
        await _promote_ai_charts_to_permanent(ctx, set(chart_ids))

    # Link charts to this dashboard - required for charts to display properly
    # The GitHub issue #32966 shows that charts need their dashboards field updated
    if not result.get("error"):
        for cid in chart_ids:
            try:
                # Get current chart data
                chart_resp = await superset_request(ctx, "get", f"/api/v1/chart/{cid}")
                if chart_resp.get("error") or "result" not in chart_resp:
                    continue
                
                chart_data = chart_resp["result"]
                current_dashboards = chart_data.get("dashboards", [])
                
                # Check if dashboard is already in the list
                dashboard_ids = [d.get("id") if isinstance(d, dict) else d for d in current_dashboards]
                if dashboard_id not in dashboard_ids:
                    # Add this dashboard to the chart's dashboards list
                    new_dashboards = dashboard_ids + [dashboard_id]
                    await superset_request(
                        ctx, "put", f"/api/v1/chart/{cid}",
                        data={"dashboards": new_dashboards}
                    )
            except Exception:
                # Don't fail the whole operation if one chart update fails
                pass

    return result


@mcp.tool()
@handle_api_errors
async def superset_dashboard_delete(ctx: Context, dashboard_id: int) -> Dict[str, Any]:
    """
    Delete a dashboard

    Args:
        dashboard_id: ID of the dashboard to delete

    Returns:
        A dictionary with deletion confirmation message
    """
    response = await superset_request(
        ctx, "delete", f"/api/v1/dashboard/{dashboard_id}"
    )

    if not response.get("error"):
        return {"message": f"Dashboard {dashboard_id} deleted successfully"}

    return response

# ===== Chart Tools =====

@mcp.tool()
@handle_api_errors
async def superset_chart_list(ctx: Context) -> Dict[str, Any]:
    """
    Get a list of charts from Superset (id, slice_name, viz_type, datasource_id only).
    Results are sorted by id descending (newest charts first) so recently created
    charts appear at the top — useful for recovering correct chart IDs after a
    superset_dashboard_add_charts validation error.

    Returns:
        count and result list with id, slice_name, viz_type, datasource_id
    """
    q = json.dumps({"order_column": "id", "order_direction": "desc", "page_size": 100})
    raw = await superset_request(ctx, "get", "/api/v1/chart/", params={"q": q})
    if "error" in raw:
        return raw
    return _slim_charts(raw)

@mcp.tool()
@handle_api_errors
async def superset_chart_get_by_id(ctx: Context, chart_id: int) -> Dict[str, Any]:
    """
    Get details for a specific chart

    Args:
        chart_id: ID of the chart to retrieve

    Returns:
        A dictionary with complete chart information including visualization configuration
    """
    return await superset_request(ctx, "get", f"/api/v1/chart/{chart_id}")

@mcp.tool()
async def superset_chart_types(ctx: Context) -> Dict[str, Any]:
    """
    Return the chart type catalog: all supported viz_type values with required/optional
    params and metric examples. Call this before superset_chart_create to know
    exactly what to pass.

    Returns:
        The full chart_type.json catalog (types, metric_examples, notes)
    """
    if not _CHART_CATALOG:
        return {"error": "Chart catalog not loaded (chart_type.json missing)"}
    return _CHART_CATALOG


def _validate_chart_params(viz_type: str, params: Dict[str, Any]) -> Optional[str]:
    """Return an error string if params are invalid, else None."""
    types = _CHART_CATALOG.get("types", {})
    if viz_type not in types:
        return f"Unknown viz_type '{viz_type}'. Valid types: {list(types.keys())}"
    missing = [k for k in types[viz_type].get("req", {}) if k not in params]
    if missing:
        return f"Missing required params for '{viz_type}': {missing}"
    # Validate metrics — reject plain strings and empty arrays
    examples = _CHART_CATALOG.get("metric_examples", {})
    hint = f"See metric_examples: {examples}"
    for key in ("metric", "metrics"):
        val = params.get(key)
        if val is None:
            continue
        if key == "metrics" and isinstance(val, list) and len(val) == 0:
            return f"'metrics' is empty — add at least one metric object. {hint}"
        items = [val] if key == "metric" else (val if isinstance(val, list) else [val])
        _VALID_EXPR_TYPES = {"SIMPLE", "SAVED", "SQL"}
        for item in items:
            if isinstance(item, str):
                return (
                    f"Invalid metric: '{item}' is a plain string. "
                    f"Metrics must be objects with expressionType/column/aggregate/label/optionName. "
                    f"{hint}"
                )
            if isinstance(item, dict):
                expr_type = item.get("expressionType")
                if expr_type is not None and expr_type not in _VALID_EXPR_TYPES:
                    return (
                        f"Invalid metric expressionType '{expr_type}'. "
                        f"Must be one of: {sorted(_VALID_EXPR_TYPES)}. "
                        f"Use 'SIMPLE' for column+aggregate, 'SQL' for custom SQL expressions. "
                        f"{hint}"
                    )
    # Validate x_axis is not duplicated in groupby or columns
    # Superset automatically places x_axis on the chart; including it again in
    # groupby or columns raises "Duplicate column/metric labels".
    x_axis = params.get("x_axis")
    if x_axis:
        groupby = params.get("groupby", [])
        if isinstance(groupby, list) and x_axis in groupby:
            return (
                f"x_axis '{x_axis}' must NOT appear in groupby — Superset adds it automatically "
                f"and will raise 'Duplicate column/metric labels'. Remove '{x_axis}' from groupby."
            )
        columns = params.get("columns", [])
        if isinstance(columns, list) and x_axis in columns:
            return (
                f"x_axis '{x_axis}' must NOT appear in columns — Superset adds it automatically "
                f"and will raise 'Duplicate column/metric labels'. Remove '{x_axis}' from columns."
            )
    return None


@mcp.tool()
@handle_api_errors
async def superset_chart_create(
    ctx: Context,
    slice_name: str,
    datasource_id: int,
    viz_type: str,
    params: Dict[str, Any],
    datasource_type: str = "table",
    description: str = "",
) -> Dict[str, Any]:
    """
    Create a new chart in Superset.

    Call superset_chart_types first to get valid viz_type values and required params.
    Chart creation will be rejected if viz_type is unknown or required params are missing.

    Args:
        slice_name: Chart title
        datasource_id: Dataset ID (from superset_dataset_list)
        viz_type: Chart type (must be a key from superset_chart_types)
        params: Visualization params (keys/values per superset_chart_types definition)
        datasource_type: Datasource kind — defaults to 'table'
        description: Optional chart description (an AI provenance stamp is always appended automatically)

    Returns:
        Created chart info including its ID, or an error with the validation failure
    """
    err = _validate_chart_params(viz_type, params)
    if err:
        return {"error": err}

    # ── Column existence check ──────────────────────────────────────────────
    # Fetch the dataset schema and verify every column referenced in params
    # actually exists.  Returns a clear error listing valid columns so the
    # model can self-correct without needing an extra tool call.
    ds_resp = await superset_request(ctx, "get", f"/api/v1/dataset/{datasource_id}")
    if "error" not in ds_resp:
        ds_result = ds_resp.get("result", {})
        # Build a case-insensitive lookup: lowercase_name → exact_name
        col_lookup: dict[str, str] = {
            col.get("column_name", "").lower(): col.get("column_name", "")
            for col in ds_result.get("columns", [])
            if col.get("column_name")
        }
        valid_columns = set(col_lookup.values())

        # Collect every plain-string column reference used in params
        refs: list[str] = []
        for key in ("x_axis", "x", "y"):
            val = params.get(key)
            if isinstance(val, str):
                refs.append(val)
        for key in ("groupby", "columns", "series"):
            val = params.get(key)
            if isinstance(val, list):
                refs.extend(v for v in val if isinstance(v, str))
        # Also check column names nested inside metric objects
        # e.g. {"expressionType":"SIMPLE","column":{"column_name":"SH_DTH_MMRT"},...}
        for key in ("metric", "metrics"):
            val = params.get(key)
            if val is None:
                continue
            items = [val] if key == "metric" else (val if isinstance(val, list) else [val])
            for item in items:
                if isinstance(item, dict):
                    col_obj = item.get("column")
                    if isinstance(col_obj, dict):
                        col_name = col_obj.get("column_name")
                        if col_name:
                            refs.append(col_name)

        corrections: list[str] = []
        missing: list[str] = []
        for c in refs:
            if not c or c in valid_columns:
                continue  # exact match — fine
            if c.lower() in col_lookup:
                corrections.append(f"'{c}' → '{col_lookup[c.lower()]}' (wrong case)")
            else:
                missing.append(c)

        if corrections or missing:
            parts: list[str] = []
            if corrections:
                parts.append(f"Case mismatch (use exact name): {corrections}")
            if missing:
                parts.append(f"Column(s) not found: {missing}")
            parts.append(f"All valid column names: {sorted(valid_columns)}")
            return {"error": ". ".join(parts)}

        # ── Auto-quote uppercase column names in SQL expression metrics ──────
        # PostgreSQL folds unquoted identifiers to lowercase.  Columns that
        # were created with double-quotes (e.g. "CANCELLED") are stored as
        # uppercase and must be quoted in raw SQL expressions or the query
        # will fail with "column 'cancelled' does not exist".
        # We silently fix this by wrapping every such column name that appears
        # unquoted inside a SQL expression metric.
        columns_needing_quotes = [c for c in valid_columns if c != c.lower()]
        if columns_needing_quotes:
            def _quote_cols_in_sql(sql: str) -> str:
                result = sql
                # Process longest names first to avoid partial replacements
                for col in sorted(columns_needing_quotes, key=len, reverse=True):
                    # Replace only unquoted occurrences (not already inside "…")
                    pattern = r'(?<!")\b' + re.escape(col) + r'\b(?!")'
                    result = re.sub(pattern, f'"{col}"', result)
                return result

            for key in ("metric", "metrics"):
                val = params.get(key)
                if val is None:
                    continue
                items = [val] if key == "metric" else (val if isinstance(val, list) else [val])
                for item in items:
                    if isinstance(item, dict) and item.get("expressionType") == "SQL":
                        sql_expr = item.get("sqlExpression", "")
                        if sql_expr:
                            item["sqlExpression"] = _quote_cols_in_sql(sql_expr)
                            logger.debug(
                                "Auto-quoted SQL expression: %s → %s",
                                sql_expr, item["sqlExpression"],
                            )

    # ── AI provenance stamp ──────────────────────────────────────────────────
    # Always append a machine-readable stamp so AI-generated charts are easy
    # to find and clean up.  Format: [HYPERSET-AI-TEMPORARY] {ISO-datetime} | {user}
    stamp_ts = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    try:
        _identity = await extract_identity(ctx.request_context.request)
        stamp_user = _identity.username
    except Exception:
        stamp_user = "unknown"
    ai_stamp = f"[HYPERSET-AI-TEMPORARY] {stamp_ts} | {stamp_user}"
    full_description = f"{description}\n{ai_stamp}".strip() if description else ai_stamp

    payload = {
        "slice_name": slice_name,
        "datasource_id": datasource_id,
        "datasource_type": datasource_type,
        "viz_type": viz_type,
        "params": json.dumps(params),
        "description": full_description,
    }

    result = await superset_request(ctx, "post", "/api/v1/chart/", data=payload)

    # Return a concise response so the LLM can reliably extract the chart_id
    # even when the full Superset response is truncated by the context window.
    # chart_id is the field the LLM must pass to superset_dashboard_add_charts.
    if not result.get("error"):
        chart_id = result.get("id")
        return {
            "chart_id": chart_id,
            "id": chart_id,
            "slice_name": slice_name,
            "viz_type": viz_type,
            "status": "created",
        }
    return result

@mcp.tool()
@handle_api_errors
async def superset_chart_update(
    ctx: Context, chart_id: int, data: Dict[str, Any]
) -> Dict[str, Any]:
    """
    Update an existing chart

    Args:
        chart_id: ID of the chart to update
        data: Data to update, can include slice_name, description, viz_type, params, etc.

    Returns:
        A dictionary with the updated chart information
    """
    # Run the same param validation as chart_create when params are being updated
    viz_type = data.get("viz_type")
    params = data.get("params")
    if viz_type and params is not None:
        # params may arrive as a JSON string (Superset API format) or already a dict
        if isinstance(params, str):
            try:
                params_dict = json.loads(params)
            except json.JSONDecodeError:
                params_dict = {}
        else:
            params_dict = params
        err = _validate_chart_params(viz_type, params_dict)
        if err:
            return {"error": err}

    return await superset_request(
        ctx, "put", f"/api/v1/chart/{chart_id}", data=data
    )

@mcp.tool()
@handle_api_errors
async def superset_chart_delete(ctx: Context, chart_id: int) -> Dict[str, Any]:
    """
    Delete a chart

    Args:
        chart_id: ID of the chart to delete

    Returns:
        A dictionary with deletion confirmation message
    """
    response = await superset_request(
        ctx, "delete", f"/api/v1/chart/{chart_id}"
    )

    if not response.get("error"):
        return {"message": f"Chart {chart_id} deleted successfully"}

    return response

# ===== Database Tools =====

@mcp.tool()
@handle_api_errors
async def superset_database_list(ctx: Context) -> Dict[str, Any]:
    """
    Get a list of databases from Superset (id, database_name, backend only).

    Returns:
        count and result list with id, database_name, backend
    """
    raw = await superset_request(ctx, "get", "/api/v1/database/")
    if "error" in raw:
        return raw
    return _slim_databases(raw)

@mcp.tool()
@handle_api_errors
async def superset_database_get_by_id(ctx: Context, database_id: int) -> Dict[str, Any]:
    """
    Get details for a specific database

    Args:
        database_id: ID of the database to retrieve

    Returns:
        A dictionary with complete database configuration information
    """
    return await superset_request(ctx, "get", f"/api/v1/database/{database_id}")

@mcp.tool()
@handle_api_errors
async def superset_database_create(
    ctx: Context,
    engine: str,
    configuration_method: str,
    database_name: str,
    sqlalchemy_uri: str,
) -> Dict[str, Any]:
    """
    Create a new database connection in Superset

    Args:
        engine: Database engine (e.g., 'postgresql', 'mysql', etc.)
        configuration_method: Method used for configuration (typically 'sqlalchemy_form')
        database_name: Name for the database connection
        sqlalchemy_uri: SQLAlchemy URI for the connection

    Returns:
        A dictionary with the created database connection information including its ID
    """
    payload = {
        "engine": engine,
        "configuration_method": configuration_method,
        "database_name": database_name,
        "sqlalchemy_uri": sqlalchemy_uri,
        "allow_dml": False,
        "allow_cvas": False,
        "allow_ctas": False,
        "expose_in_sqllab": True,
    }

    return await superset_request(ctx, "post", "/api/v1/database/", data=payload)

# ===== Dataset Tools =====

@mcp.tool()
@handle_api_errors
async def superset_dataset_list(ctx: Context) -> Dict[str, Any]:
    """
    Get a list of datasets from Superset (id, table_name, schema, database_id only).

    Returns:
        count and result list with id, table_name, schema, database_id
    """
    raw = await superset_request(ctx, "get", "/api/v1/dataset/")
    if "error" in raw:
        return raw
    return _slim_datasets(raw)

@mcp.tool()
@handle_api_errors
async def superset_dataset_get_by_id(ctx: Context, dataset_id: int) -> Dict[str, Any]:
    """
    Get column names (exact casing) and basic info for a dataset.
    Always call this before superset_chart_create to get the exact column names.

    Args:
        dataset_id: ID of the dataset to retrieve

    Returns:
        id, table_name, schema, database_id, and the exact list of column names
    """
    raw = await superset_request(ctx, "get", f"/api/v1/dataset/{dataset_id}")
    if "error" in raw:
        return raw
    result = raw.get("result", {})
    # Return only the essentials — column names are the critical output.
    # Exact casing is preserved so the model can copy-paste them directly.
    return {
        "id": result.get("id"),
        "table_name": result.get("table_name"),
        "schema": result.get("schema"),
        "database_id": (result.get("database") or {}).get("id"),
        "columns": [
            col.get("column_name")
            for col in result.get("columns", [])
            if col.get("column_name")
        ],
    }

# ===== SQL Lab Tools =====

@mcp.tool()
@handle_api_errors
async def superset_sqllab_execute_query(
    ctx: Context, database_id: int, sql: str
) -> Dict[str, Any]:
    """
    Execute a SQL query in SQL Lab

    Args:
        database_id: ID of the database to query
        sql: SQL query to execute

    Returns:
        A dictionary with query results or execution status for async queries
    """
    # SECURITY: Validate SQL before execution
    try:
        validate_sql(sql)
    except ValueError as e:
        return {"error": f"SQL validation failed: {str(e)}"}
    
    payload = {
        "database_id": database_id,
        "sql": sql,
        "schema": "",
        "tab": "MCP Query",
        "runAsync": False,
        "select_as_cta": False,
    }

    return await superset_request(ctx, "post", "/api/v1/sqllab/execute/", data=payload)

# ===== User Tools =====

@mcp.tool()
@handle_api_errors
async def superset_user_get_current(ctx: Context) -> Dict[str, Any]:
    """
    Get information about the currently authenticated user

    Returns:
        A dictionary with user profile data
    """
    return await superset_request(ctx, "get", "/api/v1/me/")

@mcp.tool()
@handle_api_errors
async def superset_user_get_roles(ctx: Context) -> Dict[str, Any]:
    """
    Get roles for the current user

    Returns:
        A dictionary with user role information
    """
    return await superset_request(ctx, "get", "/api/v1/me/roles/")

# ===== Configuration Tools =====

@mcp.tool()
@handle_api_errors
async def superset_config_get_base_url(ctx: Context) -> Dict[str, Any]:
    """
    Get the base URL of the Superset instance

    Returns:
        A dictionary with the Superset base URL
    """
    superset_ctx: SupersetContext = ctx.request_context.lifespan_context

    return {
        "base_url": superset_ctx.base_url,
        "message": f"Connected to Superset instance at: {superset_ctx.base_url}",
    }


# ===== Embed / iframe Tools =====
# NOTE: These tools return [iframe](url) format which creates an INLINE embedded
# chart/dashboard directly inside the chat bubble.  Use them when the user wants
# to see the chart right here in the conversation.
#
# For a simple clickable link that opens the chart in the Superset panel without
# embedding it, use superset_get_chart_link / superset_get_dashboard_link below.

@mcp.tool()
@handle_api_errors
async def superset_get_chart_embed(
    ctx: Context,
    chart_id: int,
    title: str = "",
) -> Dict[str, Any]:
    """
    Get a ready-to-use iframe embed markdown string for a Superset chart.

    IMPORTANT: NEVER construct embed URLs manually. ALWAYS call this tool —
    it uses the real Superset instance URL. Hardcoding any domain (including
    placeholder domains) will result in broken embeds.

    The tool returns 'embed_markdown' which looks like:
        [iframe](<real-superset-url>/superset/explore/?slice_id=<id>&standalone=1) <title>

    Copy 'embed_markdown' verbatim into your response — the chat UI renders it
    as an inline embedded chart.

    Args:
        chart_id: ID of the chart to embed
        title: Display title shown above the iframe (fetched automatically if omitted)

    Returns:
        A dictionary with embed_markdown (paste verbatim), embed_url, chart_id, title
    """
    # Always fetch chart to get title (if missing) AND to check AI provenance
    is_ai_temporary = False
    chart_resp = await superset_request(ctx, "get", f"/api/v1/chart/{chart_id}")
    if "error" not in chart_resp:
        res = chart_resp.get("result", {})
        if not title:
            title = res.get("slice_name", f"Chart {chart_id}")
        desc = res.get("description") or ""
        if "[HYPERSET-AI-TEMPORARY]" in desc and "[HYPERSET-AI-PERMANENT]" not in desc:
            is_ai_temporary = True
    else:
        if not title:
            title = f"Chart {chart_id}"

    embed_url = (
        f"{SUPERSET_PUBLIC_URL}/superset/explore/"
        f"?slice_id={chart_id}&standalone=1"
    )
    # Temporary AI charts use a special token so the portal can show the
    # "Keep permanently" toggle button next to the embedded chart.
    if is_ai_temporary:
        embed_markdown = f"[iframe-ai:{chart_id}]({embed_url}) {title}"
    else:
        embed_markdown = f"[iframe]({embed_url}) {title}"

    return {
        "chart_id": chart_id,
        "title": title,
        "embed_url": embed_url,
        "embed_markdown": embed_markdown,
        "usage": (
            "Include embed_markdown verbatim in your response to display "
            "the chart inline in the chat."
        ),
    }


@mcp.tool()
@handle_api_errors
async def superset_get_dashboard_embed(
    ctx: Context,
    dashboard_id: int,
    title: str = "",
) -> Dict[str, Any]:
    """
    Get a ready-to-use iframe embed markdown string for a Superset dashboard.

    IMPORTANT: NEVER construct embed URLs manually. ALWAYS call this tool —
    it uses the real Superset instance URL. Hardcoding any domain (including
    placeholder domains) will result in broken embeds.

    The tool returns 'embed_markdown' which looks like:
        [iframe](<real-superset-url>/superset/dashboard/<id>/?standalone=2) <title>

    Copy 'embed_markdown' verbatim into your response — the chat UI renders it
    as an inline embedded dashboard.

    Args:
        dashboard_id: ID of the dashboard to embed
        title: Display title shown above the iframe (fetched automatically if omitted)

    Returns:
        A dictionary with embed_markdown (paste verbatim), embed_url, dashboard_id, title
    """
    if not title:
        dashboard_resp = await superset_request(
            ctx, "get", f"/api/v1/dashboard/{dashboard_id}"
        )
        if "error" not in dashboard_resp:
            title = dashboard_resp.get("result", {}).get(
                "dashboard_title", f"Dashboard {dashboard_id}"
            )
        else:
            title = f"Dashboard {dashboard_id}"

    embed_url = (
        f"{SUPERSET_PUBLIC_URL}/superset/dashboard/{dashboard_id}/?standalone=2"
    )
    embed_markdown = f"[iframe]({embed_url}) {title}"

    return {
        "dashboard_id": dashboard_id,
        "title": title,
        "embed_url": embed_url,
        "embed_markdown": embed_markdown,
        "usage": (
            "Include embed_markdown verbatim in your response to display "
            "the dashboard inline in the chat."
        ),
    }


# ===== Link Tools =====
# These tools return a plain markdown [text](url) link — NOT an iframe embed.
# Clicking the link in the chat opens the chart/dashboard in the main Superset
# panel with the full Superset UI (navigation bar, sidebar, etc.).


@mcp.tool()
@handle_api_errors
async def superset_get_chart_link(
    ctx: Context,
    chart_id: int,
    title: str = "",
) -> Dict[str, Any]:
    """
    Get a ready-to-use markdown link for a Superset chart that opens in the
    Superset panel.

    IMPORTANT: NEVER construct chart URLs manually. ALWAYS call this tool —
    it uses the real Superset instance URL. Hardcoding any domain (including
    placeholder domains) will produce broken links.

    The tool returns 'link_markdown' which looks like:
        [<title>](<real-superset-url>/superset/explore/?slice_id=<id>)

    Include link_markdown verbatim in your text — clicking it navigates the
    Superset panel to the chart (full UI, not standalone mode).

    Args:
        chart_id: ID of the chart to link to
        title: Link text shown to the user (fetched automatically if omitted)

    Returns:
        A dictionary with link_markdown (paste verbatim), link_url, chart_id, title
    """
    if not title:
        chart_resp = await superset_request(ctx, "get", f"/api/v1/chart/{chart_id}")
        if "error" not in chart_resp:
            title = chart_resp.get("result", {}).get("slice_name", f"Chart {chart_id}")
        else:
            title = f"Chart {chart_id}"

    # No standalone param — loads the full Superset UI in the panel
    link_url = f"{SUPERSET_PUBLIC_URL}/superset/explore/?slice_id={chart_id}"
    link_markdown = f"[{title}]({link_url})"

    return {
        "chart_id": chart_id,
        "title": title,
        "link_url": link_url,
        "link_markdown": link_markdown,
        "usage": (
            "Include link_markdown inline in your text to create a clickable link "
            "that opens the chart in the Superset panel.  Unlike embed_markdown, "
            "this does not create an inline iframe — it appears as a text hyperlink."
        ),
    }


@mcp.tool()
@handle_api_errors
async def superset_get_dashboard_link(
    ctx: Context,
    dashboard_id: int,
    title: str = "",
) -> Dict[str, Any]:
    """
    Get a ready-to-use markdown link for a Superset dashboard that opens in the
    Superset panel.

    IMPORTANT: NEVER construct dashboard URLs manually. ALWAYS call this tool —
    it uses the real Superset instance URL. Hardcoding any domain (including
    placeholder domains) will produce broken links.

    The tool returns 'link_markdown' which looks like:
        [<title>](<real-superset-url>/superset/dashboard/<id>/)

    Include link_markdown verbatim in your text — clicking it navigates the
    Superset panel to the dashboard (full UI, not standalone mode).

    Args:
        dashboard_id: ID of the dashboard to link to
        title: Link text shown to the user (fetched automatically if omitted)

    Returns:
        A dictionary with link_markdown (paste verbatim), link_url, dashboard_id, title
    """
    if not title:
        dashboard_resp = await superset_request(
            ctx, "get", f"/api/v1/dashboard/{dashboard_id}"
        )
        if "error" not in dashboard_resp:
            title = dashboard_resp.get("result", {}).get(
                "dashboard_title", f"Dashboard {dashboard_id}"
            )
        else:
            title = f"Dashboard {dashboard_id}"

    # No standalone param — loads the full Superset UI in the panel
    link_url = f"{SUPERSET_PUBLIC_URL}/superset/dashboard/{dashboard_id}/"
    link_markdown = f"[{title}]({link_url})"

    return {
        "dashboard_id": dashboard_id,
        "title": title,
        "link_url": link_url,
        "link_markdown": link_markdown,
        "usage": (
            "Include link_markdown inline in your text to create a clickable link "
            "that opens the dashboard in the Superset panel.  Unlike embed_markdown, "
            "this does not create an inline iframe — it appears as a text hyperlink."
        ),
    }


if __name__ == "__main__":
    # Support both stdio (default, for Claude Desktop etc.) and streamable-http (for portal integration)
    transport = os.getenv("MCP_TRANSPORT", "streamable-http")
    if transport == "streamable-http":
        import uvicorn
        host = os.getenv("MCP_HOST", "0.0.0.0")
        port = int(os.getenv("MCP_PORT", "8000"))
        logger.info(f"Starting Superset MCP server on {host}:{port} (streamable-http)...")
        # Get the MCP's own Starlette app (preserves its lifespan / httpx client init)
        # and inject the /health route at position 0 so it is matched before /mcp.
        _mcp_app = mcp.streamable_http_app()
        _mcp_app.router.routes.insert(0, Route("/health", _health_endpoint, methods=["GET"]))
        uvicorn.run(_mcp_app, host=host, port=port)
    else:
        logger.info("Starting Superset MCP server (stdio)...")
        mcp.run()

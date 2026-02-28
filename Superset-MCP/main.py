#!/usr/bin/env python3

from typing import (
    Any,
    Dict,
    List,
    Optional,
    AsyncIterator,
    Callable,
    TypeVar,
    Awaitable,
)
import os
import httpx
import base64
import hashlib
import hmac as hmac_lib
import time
from contextlib import asynccontextmanager
from dataclasses import dataclass
from functools import wraps
from fastapi import FastAPI, HTTPException
from mcp.server.fastmcp import FastMCP, Context
from mcp.server.transport_security import TransportSecuritySettings
from dotenv import load_dotenv
import json
import logging
from pathlib import Path

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
SUPERSET_BASE_URL = (
    os.getenv("SUPERSET_UPSTREAM")
    or os.getenv("SUPERSET_BASE_URL")
    or "http://localhost:8088"
)

# Public URL used to build browser-accessible embed links.
# Must be reachable by the end-user's browser (not an internal upstream address).
# Falls back to SUPERSET_BASE_URL only as a last resort — set SUPERSET_PUBLIC_URL
# explicitly in .env so embedded iframes resolve correctly.
SUPERSET_PUBLIC_URL = (
    os.getenv("SUPERSET_PUBLIC_URL")
    or SUPERSET_BASE_URL
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

def _b64url_decode(s: str) -> bytes:
    padding = 4 - len(s) % 4
    return base64.urlsafe_b64decode(s + "=" * (padding % 4))

def verify_mcp_token(token: str) -> VerifiedIdentity:
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
    username = payload.get("sub")
    if not username:
        raise ValueError("Missing 'sub' claim")
    return VerifiedIdentity(
        username=username,
        email=payload.get("email", ""),
        roles=payload.get("roles", []),
    )

def extract_identity(request) -> VerifiedIdentity:
    auth = request.headers.get("authorization", "")
    if not auth.startswith("Bearer "):
        raise ValueError("Missing Authorization header")
    return verify_mcp_token(auth[7:])

# Initialize FastAPI app
app = FastAPI(title="Superset MCP Server")

# Shared HTTP client and context
_shared_client: Optional[httpx.AsyncClient] = None
_shared_ctx: Optional["SupersetContext"] = None

@dataclass
class SupersetContext:
    """Typed context for the Superset MCP server"""
    client: httpx.AsyncClient
    base_url: str

@asynccontextmanager
async def superset_lifespan(server: FastMCP) -> AsyncIterator[SupersetContext]:
    """Manage application lifecycle for Superset integration."""
    global _shared_client, _shared_ctx

    if _shared_ctx is None:
        logger.info(f"Initializing Superset MCP ({SUPERSET_BASE_URL})")
        client = httpx.AsyncClient(
            base_url=SUPERSET_BASE_URL,
            timeout=30.0,
        )
        _shared_ctx = SupersetContext(client=client, base_url=SUPERSET_BASE_URL)
        _shared_client = client

    yield _shared_ctx

# Initialize FastMCP server
mcp = FastMCP(
    "superset",
    lifespan=superset_lifespan,
    dependencies=["fastapi", "uvicorn", "python-dotenv", "httpx"],
    stateless_http=True,
    transport_security=TransportSecuritySettings(enable_dns_rebinding_protection=False),
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
        identity = extract_identity(ctx.request_context.request)
    except ValueError as e:
        return {"error": f"Authentication failed: {e}"}
    logger.info("MCP call: %s %s (user=%s)", method.upper(), endpoint, identity.username)
    
    # Headers locaux à cet appel
    req_headers = {
        "X-Webauth-User": identity.username,
        "X-Webauth-Email": identity.email,
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

    return await superset_request(ctx, "post", "/api/v1/dashboard/", data=payload)

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
    return await superset_request(
        ctx, "put", f"/api/v1/dashboard/{dashboard_id}", data=data
    )

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

    Returns:
        count and result list with id, slice_name, viz_type, datasource_id
    """
    raw = await superset_request(ctx, "get", "/api/v1/chart/")
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
        for item in items:
            if isinstance(item, str):
                return (
                    f"Invalid metric: '{item}' is a plain string. "
                    f"Metrics must be objects with expressionType/column/aggregate/label/optionName. "
                    f"{hint}"
                )
    # Validate x_axis not duplicated in groupby
    x_axis = params.get("x_axis")
    groupby = params.get("groupby", [])
    if x_axis and isinstance(groupby, list) and x_axis in groupby:
        return (
            f"x_axis '{x_axis}' must NOT appear in groupby — Superset adds it automatically "
            f"and will raise 'Duplicate column/metric labels'. Remove '{x_axis}' from groupby."
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

    payload = {
        "slice_name": slice_name,
        "datasource_id": datasource_id,
        "datasource_type": datasource_type,
        "viz_type": viz_type,
        "params": json.dumps(params),
    }

    return await superset_request(ctx, "post", "/api/v1/chart/", data=payload)

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
        "allow_dml": True,
        "allow_cvas": True,
        "allow_ctas": True,
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

# ===== Data Analysis Tools =====

def _classify_column(col: Dict[str, Any]) -> str:
    """Classify a column into a semantic category based on its type."""
    if col.get("is_dttm"):
        return "datetime"
    col_type = (col.get("type") or "").lower()
    if any(t in col_type for t in ["int", "float", "double", "decimal", "numeric", "number"]):
        return "numeric"
    if any(t in col_type for t in ["varchar", "char", "text", "string"]):
        return "text"
    if any(t in col_type for t in ["bool"]):
        return "boolean"
    return "other"


@mcp.tool()
@handle_api_errors
async def superset_analyze_data(ctx: Context, question: str) -> Dict[str, Any]:
    """
    RECOMMENDED: Analyze data by automatically discovering schema and returning a structured JSON catalog.

    This tool combines schema discovery to answer data questions efficiently.
    It will:
    1. Get available databases and datasets
    2. Fetch detailed column information with data types
    3. Classify columns by category (datetime, numeric, text, boolean, other)
    4. Return a clean, structured JSON response

    Use this when you want to explore data without manual schema lookup.
    After reviewing the catalog, use superset_sqllab_execute_query to run SQL.

    Args:
        question: The data question to answer (e.g., 'What are the top 10 customers by revenue?')

    Returns:
        A structured dictionary with question, summary, databases (with datasets and typed columns)
    """
    # Step 1: Get databases
    db_response = await superset_request(ctx, "get", "/api/v1/database/")
    if "error" in db_response:
        return {"error": f"Failed to fetch databases: {db_response['error']}"}

    databases_raw = db_response.get("result", [])

    # Step 2: Get datasets
    ds_response = await superset_request(ctx, "get", "/api/v1/dataset/")
    if "error" in ds_response:
        return {"error": f"Failed to fetch datasets: {ds_response['error']}"}

    datasets_raw = ds_response.get("result", [])

    # Step 3: Group datasets by database id
    datasets_by_db: Dict[int, list] = {}
    for ds in datasets_raw:
        db_id = (
            ds.get("database", {}).get("id")
            if isinstance(ds.get("database"), dict)
            else ds.get("database_id")
        )
        if db_id is not None:
            datasets_by_db.setdefault(db_id, []).append(ds)

    # Step 4: Build structured catalog
    databases_out: List[Dict[str, Any]] = []
    total_datasets = 0

    for db in databases_raw:
        db_id = db.get("id")
        db_datasets: List[Dict[str, Any]] = []

        for ds in datasets_by_db.get(db_id, []):
            ds_id = ds.get("id")

            # Fetch detailed dataset info including columns
            ds_detail = await superset_request(ctx, "get", f"/api/v1/dataset/{ds_id}")
            detail_result = (
                ds_detail.get("result", ds_detail)
                if not ds_detail.get("error")
                else {}
            )

            # Build classified columns
            columns_by_category: Dict[str, List[Dict[str, str]]] = {}
            for col in detail_result.get("columns", []):
                col_entry = {
                    "name": col.get("column_name", col.get("name", "unknown")),
                    "type": col.get("type", "UNKNOWN"),
                }
                category = _classify_column({**col_entry, "is_dttm": col.get("is_dttm", False)})
                columns_by_category.setdefault(category, []).append(col_entry)

            # Flatten to a single list and cap at 40 columns to keep the
            # response small for low-context models.
            all_cols = [c for cols in columns_by_category.values() for c in cols]
            MAX_COLS = 40
            cols_out = all_cols[:MAX_COLS]
            truncated = len(all_cols) > MAX_COLS

            db_datasets.append({
                "dataset_id": ds_id,
                "table_name": ds.get("table_name", "unknown"),
                "schema": ds.get("schema") or None,
                "column_count": len(all_cols),
                "columns": cols_out,
                **({"columns_truncated": True} if truncated else {}),
            })

        total_datasets += len(db_datasets)

        databases_out.append({
            "database_id": db_id,
            "database_name": db.get("database_name", "Unknown"),
            "backend": db.get("backend", "Unknown"),
            "allow_run_async": db.get("allow_run_async", False),
            "dataset_count": len(db_datasets),
            "datasets": db_datasets,
        })

    return {
        "question": question,
        "summary": {
            "total_databases": len(databases_out),
            "total_datasets": total_datasets,
        },
        "databases": databases_out,
        "next_steps": [
            "Review the schema above to identify relevant tables and columns",
            "Use superset_sqllab_execute_query(database_id, sql) to run SQL against the appropriate database",
        ],
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
    if not title:
        chart_resp = await superset_request(ctx, "get", f"/api/v1/chart/{chart_id}")
        if "error" not in chart_resp:
            title = chart_resp.get("result", {}).get("slice_name", f"Chart {chart_id}")
        else:
            title = f"Chart {chart_id}"

    embed_url = (
        f"{SUPERSET_PUBLIC_URL}/superset/explore/"
        f"?slice_id={chart_id}&standalone=1"
    )
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
        host = os.getenv("MCP_HOST", "0.0.0.0")
        port = int(os.getenv("MCP_PORT", "8000"))
        logger.info(f"Starting Superset MCP server on {host}:{port} (streamable-http)...")
        mcp.settings.host = host
        mcp.settings.port = port
        mcp.run(transport="streamable-http")
    else:
        logger.info("Starting Superset MCP server (stdio)...")
        mcp.run()


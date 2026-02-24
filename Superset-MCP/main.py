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

# Constants
SUPERSET_BASE_URL = (
    os.getenv("SUPERSET_UPSTREAM")
    or os.getenv("SUPERSET_BASE_URL")
    or "http://localhost:8088"
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

# ===== Dashboard Tools =====

@mcp.tool()
@handle_api_errors
async def superset_dashboard_list(ctx: Context) -> Dict[str, Any]:
    """
    Get a list of dashboards from Superset

    Returns:
        A dictionary containing dashboard data including id, title, url, and metadata
    """
    return await superset_request(ctx, "get", "/api/v1/dashboard/")

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
    Get a list of charts from Superset

    Returns:
        A dictionary containing chart data including id, slice_name, viz_type, and datasource info
    """
    return await superset_request(ctx, "get", "/api/v1/chart/")

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
@handle_api_errors
async def superset_chart_create(
    ctx: Context,
    slice_name: str,
    datasource_id: int,
    datasource_type: str,
    viz_type: str,
    params: Dict[str, Any],
) -> Dict[str, Any]:
    """
    Create a new chart in Superset

    Args:
        slice_name: Name/title of the chart
        datasource_id: ID of the dataset or SQL table
        datasource_type: Type of datasource ('table' for datasets, 'query' for SQL)
        viz_type: Visualization type (e.g., 'bar', 'line', 'pie', 'big_number', etc.)
        params: Visualization parameters including metrics, groupby, time_range, etc.

    Returns:
        A dictionary with the created chart information including its ID
    """
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
    Get a list of databases from Superset

    Returns:
        A dictionary containing database connection information including id, name, and configuration
    """
    return await superset_request(ctx, "get", "/api/v1/database/")

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

@mcp.tool()
@handle_api_errors
async def superset_database_get_tables(
    ctx: Context, database_id: int
) -> Dict[str, Any]:
    """
    Get a list of tables for a given database

    Args:
        database_id: ID of the database

    Returns:
        A dictionary with list of tables including schema and table name information
    """
    return await superset_request(ctx, "get", f"/api/v1/database/{database_id}/tables/")

@mcp.tool()
@handle_api_errors
async def superset_database_schemas(ctx: Context, database_id: int) -> Dict[str, Any]:
    """
    Get schemas for a specific database

    Args:
        database_id: ID of the database

    Returns:
        A dictionary with list of schema names
    """
    return await superset_request(
        ctx, "get", f"/api/v1/database/{database_id}/schemas/"
    )

@mcp.tool()
@handle_api_errors
async def superset_database_test_connection(
    ctx: Context, database_data: Dict[str, Any]
) -> Dict[str, Any]:
    """
    Test a database connection

    Args:
        database_data: Database connection details including sqlalchemy_uri and other parameters

    Returns:
        A dictionary with connection test results
    """
    return await superset_request(
        ctx, "post", "/api/v1/database/test_connection", data=database_data
    )

@mcp.tool()
@handle_api_errors
async def superset_database_update(
    ctx: Context, database_id: int, data: Dict[str, Any]
) -> Dict[str, Any]:
    """
    Update an existing database connection

    Args:
        database_id: ID of the database to update
        data: Data to update, can include database_name, sqlalchemy_uri, password, and extra configs

    Returns:
        A dictionary with the updated database information
    """
    return await superset_request(
        ctx, "put", f"/api/v1/database/{database_id}", data=data
    )

@mcp.tool()
@handle_api_errors
async def superset_database_delete(ctx: Context, database_id: int) -> Dict[str, Any]:
    """
    Delete a database connection

    Args:
        database_id: ID of the database to delete

    Returns:
        A dictionary with deletion confirmation message
    """
    response = await superset_request(
        ctx, "delete", f"/api/v1/database/{database_id}"
    )

    if not response.get("error"):
        return {"message": f"Database {database_id} deleted successfully"}

    return response

# ===== Dataset Tools =====

@mcp.tool()
@handle_api_errors
async def superset_dataset_list(ctx: Context) -> Dict[str, Any]:
    """
    Get a list of datasets from Superset

    Returns:
        A dictionary containing dataset information including id, table_name, and database
    """
    return await superset_request(ctx, "get", "/api/v1/dataset/")

@mcp.tool()
@handle_api_errors
async def superset_dataset_get_by_id(ctx: Context, dataset_id: int) -> Dict[str, Any]:
    """
    Get details for a specific dataset

    Args:
        dataset_id: ID of the dataset to retrieve

    Returns:
        A dictionary with complete dataset information
    """
    return await superset_request(ctx, "get", f"/api/v1/dataset/{dataset_id}")

@mcp.tool()
@handle_api_errors
async def superset_dataset_create(
    ctx: Context,
    table_name: str,
    database_id: int,
    schema: str = None,
    owners: List[int] = None,
) -> Dict[str, Any]:
    """
    Create a new dataset in Superset

    Args:
        table_name: Name of the physical table in the database
        database_id: ID of the database where the table exists
        schema: Optional database schema name where the table is located
        owners: Optional list of user IDs who should own this dataset

    Returns:
        A dictionary with the created dataset information including its ID
    """
    payload = {
        "table_name": table_name,
        "database": database_id,
    }

    if schema:
        payload["schema"] = schema

    if owners:
        payload["owners"] = owners

    return await superset_request(ctx, "post", "/api/v1/dataset/", data=payload)

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

@mcp.tool()
@handle_api_errors
async def superset_sqllab_get_saved_queries(ctx: Context) -> Dict[str, Any]:
    """
    Get a list of saved queries from SQL Lab

    Returns:
        A dictionary containing saved query information including id, label, and database
    """
    return await superset_request(ctx, "get", "/api/v1/saved_query/")

@mcp.tool()
@handle_api_errors
async def superset_sqllab_format_sql(ctx: Context, sql: str) -> Dict[str, Any]:
    """
    Format a SQL query for better readability

    Args:
        sql: SQL query to format

    Returns:
        A dictionary with the formatted SQL
    """
    payload = {"sql": sql}
    return await superset_request(
        ctx, "post", "/api/v1/sqllab/format_sql", data=payload
    )

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
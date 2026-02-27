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

# ===== Chart Viz-Type Registry & Params Templates =====

# Maps viz_type string → human description.
# These are the ONLY valid viz_type values recognised by modern Superset (4.x+).
# Legacy types 'bar', 'line', 'area', 'scatter' have been REMOVED — they are
# not supported in Superset 4.x and will produce "This visualization type is
# not supported." Use the ECharts equivalents listed below instead.
VIZ_TYPES: Dict[str, str] = {
    # ── Bar charts ──────────────────────────────────────────────────────────
    "echarts_timeseries_bar": (
        "Bar Chart (ECharts) — works for BOTH time-series AND categorical bars. "
        "For time data set x_axis to a date/time column and add time_grain_sqla. "
        "For ranked/top-N categorical bars (e.g. top 10 countries) set x_axis to "
        "the category column and omit time_grain_sqla. "
        "DO NOT use the legacy 'bar' type — it is not supported."
    ),
    "dist_bar": (
        "Distribution Bar Chart — categorical bar chart driven by 'groupby' (no x_axis). "
        "Use for ranked/top-N bars when a groupby-only approach is preferred. "
        "Supports stacking via a second 'columns' groupby."
    ),
    # ── Line / area charts ──────────────────────────────────────────────────
    "echarts_timeseries_line": (
        "Line Chart (ECharts) — trend over time or ordered dimension. "
        "Requires x_axis. DO NOT use the legacy 'line' type."
    ),
    "echarts_timeseries_smooth": "Smooth Line Chart (ECharts) — same as echarts_timeseries_line with Bezier curves.",
    "echarts_area": (
        "Area Chart (ECharts) — filled area below a line, optional stacking. "
        "Requires x_axis. DO NOT use the legacy 'area' type."
    ),
    # ── Single-value KPIs ───────────────────────────────────────────────────
    "big_number":       "Big Number with Trendline — single KPI with a sparkline. Requires a time column.",
    "big_number_total": "Big Number — single KPI value, no trendline.",
    # ── Tables ──────────────────────────────────────────────────────────────
    "table":          "Data Table — rows and columns, optional conditional formatting.",
    "pivot_table_v2": "Pivot Table — cross-tabulation of two dimensions and a metric.",
    # ── Part-to-whole ───────────────────────────────────────────────────────
    "pie":        "Pie / Donut Chart — part-to-whole proportions.",
    "treemap_v2": "Treemap — hierarchical part-to-whole rectangles.",
    "funnel":     "Funnel Chart — ordered conversion/flow stages.",
    "sunburst_v2":"Sunburst — hierarchical radial drill-down chart.",
    # ── Distribution / statistics ───────────────────────────────────────────
    "histogram": "Histogram — frequency distribution of a numeric column.",
    "box_plot":  "Box Plot — statistical distribution (median, quartiles, outliers).",
    # ── X-Y relationships ───────────────────────────────────────────────────
    "bubble_v2": (
        "Bubble / Scatter Chart — x/y scatter with bubble size as a third metric. "
        "DO NOT use the legacy 'scatter' type."
    ),
    # ── Spatial / grid ──────────────────────────────────────────────────────
    "heatmap":    "Heatmap — color-coded grid for two dimensions and a metric.",
    "cal_heatmap":"Calendar Heatmap — daily metric values on a calendar grid.",
    # ── Other ───────────────────────────────────────────────────────────────
    "gauge_chart": "Gauge Chart — circular gauge for a single value vs. a range.",
    "word_cloud":  "Word Cloud — text size proportional to a metric.",
    "rose":        "Nightingale Rose Chart — polar bar chart.",
    "sankey_v2":   "Sankey Diagram — flow/quantity between named nodes.",
}

def _simple_metric(column: str, agg: str = "COUNT") -> Dict[str, Any]:
    """Build a simple aggregation metric object."""
    return {
        "expressionType": "SIMPLE",
        "column": {"column_name": column},
        "aggregate": agg,
        "label": f"{agg}({column})",
        "optionName": f"metric_{agg.lower()}_{column}",
    }

# Per-viz_type params templates.  Placeholder column names are descriptive
# so the LLM knows what kind of column to substitute.
_VIZ_PARAMS_TEMPLATES: Dict[str, Dict[str, Any]] = {
    # NOTE: legacy 'bar', 'line', 'area', 'scatter' have been intentionally
    # omitted — they are not supported in Superset 4.x.  Use the ECharts
    # equivalents: echarts_timeseries_bar, echarts_timeseries_line,
    # echarts_area, bubble_v2.
    "dist_bar": {
        "viz_type": "dist_bar",
        "metrics": [_simple_metric("id", "COUNT")],
        "groupby": ["dimension_column"],
        "columns": [],
        "time_range": "No filter",
        "row_limit": 50,
        "bar_stacked": False,
        "color_scheme": "supersetColors",
        "adhoc_filters": [],
    },
    "echarts_timeseries_bar": {
        "viz_type": "echarts_timeseries_bar",
        "metrics": [_simple_metric("id", "COUNT")],
        "groupby": [],
        "x_axis": "date_column",
        "time_range": "Last year",
        "time_grain_sqla": "P1M",
        "row_limit": 10000,
        "orientation": "vertical",
        "show_legend": True,
        "color_scheme": "supersetColors",
        "adhoc_filters": [],
    },
    "echarts_timeseries_line": {
        "viz_type": "echarts_timeseries_line",
        "metrics": [_simple_metric("id", "COUNT")],
        "groupby": [],
        "x_axis": "date_column",
        "time_range": "Last year",
        "time_grain_sqla": "P1M",
        "row_limit": 10000,
        "show_legend": True,
        "color_scheme": "supersetColors",
        "adhoc_filters": [],
    },
    "echarts_timeseries_smooth": {
        "viz_type": "echarts_timeseries_smooth",
        "metrics": [_simple_metric("id", "COUNT")],
        "groupby": [],
        "x_axis": "date_column",
        "time_range": "Last year",
        "time_grain_sqla": "P1M",
        "row_limit": 10000,
        "show_legend": True,
        "color_scheme": "supersetColors",
        "adhoc_filters": [],
    },
    "echarts_area": {
        "viz_type": "echarts_area",
        "metrics": [_simple_metric("id", "COUNT")],
        "groupby": [],
        "x_axis": "date_column",
        "time_range": "Last year",
        "time_grain_sqla": "P1M",
        "stack": False,
        "row_limit": 10000,
        "show_legend": True,
        "color_scheme": "supersetColors",
        "adhoc_filters": [],
    },
    "pie": {
        "viz_type": "pie",
        "metric": _simple_metric("id", "COUNT"),
        "groupby": ["dimension_column"],
        "time_range": "No filter",
        "row_limit": 25,
        "donut": False,
        "show_legend": True,
        "show_labels": True,
        "labels_outside": True,
        "color_scheme": "supersetColors",
        "adhoc_filters": [],
    },
    "big_number": {
        "viz_type": "big_number",
        "metric": _simple_metric("id", "COUNT"),
        "time_range": "Last year",
        "time_grain_sqla": "P1M",
        "compare_lag": 1,
        "compare_suffix": "over last period",
        "adhoc_filters": [],
    },
    "big_number_total": {
        "viz_type": "big_number_total",
        "metric": _simple_metric("id", "COUNT"),
        "time_range": "No filter",
        "subheader": "Total count",
        "adhoc_filters": [],
    },
    "table": {
        "viz_type": "table",
        "metrics": [_simple_metric("id", "COUNT")],
        "groupby": ["dimension_column"],
        "time_range": "No filter",
        "row_limit": 100,
        "page_length": 25,
        "include_time": False,
        "order_desc": True,
        "adhoc_filters": [],
        "all_columns": [],
    },
    "pivot_table_v2": {
        "viz_type": "pivot_table_v2",
        "metrics": [_simple_metric("id", "COUNT")],
        "groupbyRows": ["row_dimension_column"],
        "groupbyColumns": ["col_dimension_column"],
        "time_range": "No filter",
        "row_limit": 10000,
        "adhoc_filters": [],
    },
    "histogram": {
        "viz_type": "histogram",
        "all_columns_x": ["numeric_column"],
        "time_range": "No filter",
        "link_length": 5,
        "x_axis_label": "",
        "adhoc_filters": [],
    },
    "bubble_v2": {
        "viz_type": "bubble_v2",
        "x": _simple_metric("x_column", "SUM"),
        "y": _simple_metric("y_column", "SUM"),
        "size": _simple_metric("size_column", "SUM"),
        "series": "label_column",
        "time_range": "No filter",
        "row_limit": 5000,
        "adhoc_filters": [],
    },
    "heatmap": {
        "viz_type": "heatmap",
        "all_columns_x": "x_dimension_column",
        "all_columns_y": "y_dimension_column",
        "metric": _simple_metric("value_column", "SUM"),
        "time_range": "No filter",
        "row_limit": 10000,
        "adhoc_filters": [],
    },
    "treemap_v2": {
        "viz_type": "treemap_v2",
        "metric": _simple_metric("value_column", "SUM"),
        "groupby": ["dimension_column"],
        "time_range": "No filter",
        "color_scheme": "supersetColors",
        "adhoc_filters": [],
    },
    "funnel": {
        "viz_type": "funnel",
        "metric": _simple_metric("id", "COUNT"),
        "groupby": ["stage_column"],
        "time_range": "No filter",
        "color_scheme": "supersetColors",
        "adhoc_filters": [],
    },
    "gauge_chart": {
        "viz_type": "gauge_chart",
        "metric": _simple_metric("value_column", "SUM"),
        "time_range": "No filter",
        "min_val": 0,
        "max_val": 100,
        "adhoc_filters": [],
    },
    "word_cloud": {
        "viz_type": "word_cloud",
        "metric": _simple_metric("id", "COUNT"),
        "series": "word_column",
        "time_range": "No filter",
        "row_limit": 100,
        "adhoc_filters": [],
    },
    "sunburst_v2": {
        "viz_type": "sunburst_v2",
        "metric": _simple_metric("id", "COUNT"),
        "groupby": ["outer_dimension_column", "inner_dimension_column"],
        "time_range": "No filter",
        "adhoc_filters": [],
    },
    "sankey_v2": {
        "viz_type": "sankey_v2",
        "source": "source_column",
        "target": "target_column",
        "metric": _simple_metric("value_column", "SUM"),
        "time_range": "No filter",
        "adhoc_filters": [],
    },
    "box_plot": {
        "viz_type": "box_plot",
        "metrics": [_simple_metric("value_column", "SUM")],
        "groupby": ["dimension_column"],
        "time_range": "No filter",
        "whisker_options": "Tukey",
        "adhoc_filters": [],
    },
    "rose": {
        "viz_type": "rose",
        "metrics": [_simple_metric("id", "COUNT")],
        "groupby": ["dimension_column"],
        "time_range": "No filter",
        "color_scheme": "supersetColors",
        "adhoc_filters": [],
    },
    "cal_heatmap": {
        "viz_type": "cal_heatmap",
        "metric": _simple_metric("id", "COUNT"),
        "time_range": "Last year",
        "adhoc_filters": [],
    },
}

_METRIC_FORMAT_NOTE = (
    "Each metric object must have these keys: "
    '"expressionType" ("SIMPLE" or "SQL"), '
    '"column" (object with "column_name" key, required for SIMPLE), '
    '"aggregate" (one of COUNT, SUM, AVG, MIN, MAX, COUNT_DISTINCT — for SIMPLE only), '
    '"label" (display string, e.g. "SUM(amount)"), '
    '"optionName" (unique string key, e.g. "metric_sum_amount"). '
    'For custom SQL: use "expressionType":"SQL", "sqlExpression":"COUNT(DISTINCT id)", '
    'omit "column" and "aggregate".'
)

_TIME_RANGE_VALUES = [
    "No filter", "Last day", "Last week", "Last 7 days", "Last 30 days",
    "Last month", "Last quarter", "Last year", "Last 5 years",
    "Previous week", "Previous month", "Previous quarter", "Previous year",
]

_TIME_GRAIN_VALUES = {
    "PT1S": "second", "PT1M": "minute", "PT5M": "5 minutes",
    "PT30M": "30 minutes", "PT1H": "hour",
    "P1D": "day", "P1W": "week", "P1M": "month",
    "P3M": "quarter", "P1Y": "year",
}


@mcp.tool()
async def superset_chart_list_viz_types(ctx: Context) -> Dict[str, Any]:
    """
    List all valid Superset visualization types (viz_type values) for chart creation.

    Call this FIRST when creating a chart to know which viz_type strings are accepted.
    Returns a mapping of viz_type → description.

    Returns:
        A dictionary with key 'viz_types' mapping each valid viz_type string to a
        human-readable description.
    """
    return {"viz_types": VIZ_TYPES}


@mcp.tool()
async def superset_chart_get_viz_params_template(
    ctx: Context, viz_type: str
) -> Dict[str, Any]:
    """
    Get a ready-to-customise params template for a specific Superset visualization type.

    Call this BEFORE superset_chart_create to obtain the correct params structure.
    Then replace ALL placeholder column names (e.g. 'id', 'dimension_column',
    'date_column', 'value_column') with real column names from the target dataset.

    Args:
        viz_type: The visualization type string. Call superset_chart_list_viz_types
            for the full list of valid values (e.g. 'bar', 'pie', 'big_number_total',
            'echarts_timeseries_bar').

    Returns:
        'template': params dict to fill in and pass to superset_chart_create.
        'notes': usage guidance including metric format, time_range values,
                 time_grain_sqla values.
        'error' + 'available_viz_types': returned when viz_type is unknown.
    """
    if viz_type not in _VIZ_PARAMS_TEMPLATES:
        return {
            "error": f"Unknown viz_type '{viz_type}'. Use superset_chart_list_viz_types to see valid options.",
            "available_viz_types": sorted(_VIZ_PARAMS_TEMPLATES.keys()),
        }

    return {
        "template": dict(_VIZ_PARAMS_TEMPLATES[viz_type]),
        "notes": {
            "metric_format": _METRIC_FORMAT_NOTE,
            "time_range_examples": _TIME_RANGE_VALUES,
            "time_grain_sqla_options": _TIME_GRAIN_VALUES,
            "reminder": (
                "Replace ALL placeholder column names with real column names from the dataset. "
                "The 'viz_type' key inside 'params' must match the viz_type argument you pass to superset_chart_create."
            ),
        },
    }


# ===== Chart Validation Helpers =====

def _extract_column_names(params: Dict[str, Any]) -> List[str]:
    """
    Walk a chart params dict and collect every column name that will be
    sent to Superset's query engine.  Covers all chart types in the registry.
    """
    found: List[str] = []

    def _from_metric(m: Any) -> None:
        if isinstance(m, dict) and m.get("expressionType") == "SIMPLE":
            col = m.get("column")
            if isinstance(col, dict):
                name = col.get("column_name")
                if isinstance(name, str) and name:
                    found.append(name)

    # Single metric
    if "metric" in params:
        _from_metric(params["metric"])

    # Metrics list
    for m in params.get("metrics", []) if isinstance(params.get("metrics"), list) else []:
        _from_metric(m)

    # Scatter / bubble axis metrics
    for key in ("x", "y", "size"):
        if key in params:
            _from_metric(params[key])

    # Plain column lists
    for key in ("groupby", "groupbyRows", "groupbyColumns", "columns", "all_columns",
                "all_columns_x"):
        val = params.get(key)
        if isinstance(val, list):
            found.extend(c for c in val if isinstance(c, str) and c)
        elif isinstance(val, str) and val:
            found.append(val)

    # Single-string column fields
    for key in ("x_axis", "all_columns_y", "series", "source", "target"):
        val = params.get(key)
        if isinstance(val, str) and val:
            found.append(val)

    # De-duplicate, preserve order
    seen: set = set()
    return [c for c in found if not (c in seen or seen.add(c))]  # type: ignore[func-returns-value]


async def _validate_chart_params(
    ctx: Context,
    viz_type: str,
    datasource_id: int,
    datasource_type: str,
    params: Dict[str, Any],
) -> Optional[Dict[str, Any]]:
    """
    Pre-flight validation for superset_chart_create.
    Returns an error dict the LLM can act on, or None when everything is fine.
    """
    errors: List[str] = []

    # ── 1. viz_type must exist in the registry ──────────────────────────────
    if viz_type not in VIZ_TYPES:
        return {
            "error": (
                f"Invalid viz_type '{viz_type}'. "
                f"Call superset_chart_list_viz_types to see valid options."
            ),
            "valid_viz_types": sorted(VIZ_TYPES.keys()),
        }

    # ── 2. viz_type inside params must match the argument ───────────────────
    params_viz = params.get("viz_type")
    if params_viz and params_viz != viz_type:
        errors.append(
            f"viz_type mismatch: argument is '{viz_type}' "
            f"but params['viz_type'] is '{params_viz}'. They must be identical."
        )

    # ── 3. metric vs metrics: check against the template ────────────────────
    template = _VIZ_PARAMS_TEMPLATES.get(viz_type, {})
    tmpl_has_list   = "metrics" in template and "metric" not in template
    tmpl_has_single = "metric"  in template and "metrics" not in template

    if tmpl_has_single and "metrics" in params and "metric" not in params:
        errors.append(
            f"Chart type '{viz_type}' expects a single 'metric' object, "
            f"not a 'metrics' list. "
            f"Call superset_chart_get_viz_params_template(viz_type='{viz_type}') "
            f"to see the correct structure."
        )
    if tmpl_has_list and "metric" in params and "metrics" not in params:
        errors.append(
            f"Chart type '{viz_type}' expects a 'metrics' list, "
            f"not a single 'metric' object. "
            f"Call superset_chart_get_viz_params_template(viz_type='{viz_type}') "
            f"to see the correct structure."
        )

    # ── 4. Required template keys are present ───────────────────────────────
    required_keys = [k for k in template if k not in ("viz_type", "adhoc_filters",
                     "row_limit", "color_scheme", "show_legend", "time_range",
                     "time_grain_sqla", "bar_stacked", "donut", "show_labels",
                     "labels_outside", "stack", "stacked_style", "page_length",
                     "include_time", "order_desc", "whisker_options",
                     "compare_lag", "compare_suffix", "subheader",
                     "orientation", "min_val", "max_val", "link_length",
                     "x_axis_label")]
    for rk in required_keys:
        if rk not in params:
            errors.append(
                f"Required field '{rk}' is missing from params for viz_type '{viz_type}'."
            )

    # ── 5. x_axis must NOT also appear in groupby ───────────────────────────
    # Superset automatically includes x_axis in the query; adding it to groupby
    # as well creates a duplicate label and causes "Duplicate column/metric labels".
    x_axis_val = params.get("x_axis")
    groupby_val = params.get("groupby", [])
    if (
        isinstance(x_axis_val, str)
        and x_axis_val
        and isinstance(groupby_val, list)
        and x_axis_val in groupby_val
    ):
        errors.append(
            f"Column '{x_axis_val}' is used as 'x_axis' AND also appears in 'groupby': {groupby_val}. "
            f"Remove '{x_axis_val}' from 'groupby' — Superset uses x_axis as the X dimension "
            f"automatically. 'groupby' should only contain extra dimension columns used to "
            f"split series (e.g. country, category), not the time/x column itself."
        )

    # ── 6. metrics / metric presence, type, and non-emptiness ───────────────
    # An empty, null, or wrongly-typed metrics value produces "Error: Empty query?".
    metrics_val = params.get("metrics")
    metric_val  = params.get("metric")
    _tmpl = f"Call superset_chart_get_viz_params_template(viz_type='{viz_type}') for the correct format."

    if "metrics" in template:
        if "metrics" not in params:
            errors.append(
                f"'metrics' is missing from params entirely for viz_type '{viz_type}'. {_tmpl}"
            )
        elif not isinstance(metrics_val, list):
            errors.append(
                f"'metrics' must be a JSON array (list), got {type(metrics_val).__name__}. {_tmpl}"
            )
        elif len(metrics_val) == 0:
            errors.append(
                f"'metrics' is an empty list — at least one metric object is required. {_tmpl}"
            )

    if "metric" in template:
        if "metric" not in params or metric_val is None:
            errors.append(
                f"'metric' is required for viz_type '{viz_type}' but is absent or null. {_tmpl}"
            )
        elif not isinstance(metric_val, dict):
            errors.append(
                f"'metric' must be a JSON object (dict), got {type(metric_val).__name__}. {_tmpl}"
            )

    # ── 7. Metric label / optionName uniqueness ──────────────────────────────
    # Duplicate labels across metrics (or between a metric and x_axis) trigger
    # "Duplicate column/metric labels" in Superset.
    all_metric_objs: List[Dict[str, Any]] = []
    if isinstance(metrics_val, list):
        all_metric_objs = [m for m in metrics_val if isinstance(m, dict)]
    elif isinstance(metric_val, dict):
        all_metric_objs = [metric_val]

    labels     = [m.get("label")      for m in all_metric_objs if m.get("label")]
    opt_names  = [m.get("optionName") for m in all_metric_objs if m.get("optionName")]

    dup_labels = [lbl for lbl in labels if labels.count(lbl) > 1]
    if dup_labels:
        errors.append(
            f"Duplicate metric 'label' values detected: {list(set(dup_labels))}. "
            f"Every metric must have a unique 'label' string."
        )

    dup_opts = [o for o in opt_names if opt_names.count(o) > 1]
    if dup_opts:
        errors.append(
            f"Duplicate metric 'optionName' values detected: {list(set(dup_opts))}. "
            f"Every metric must have a unique 'optionName' string."
        )

    # ── 8. Column existence check against the real dataset ──────────────────
    if datasource_type == "table":
        dataset_resp = await superset_request(
            ctx, "get", f"/api/v1/dataset/{datasource_id}"
        )
        if "error" in dataset_resp:
            errors.append(
                f"Could not fetch dataset {datasource_id} to validate columns: "
                f"{dataset_resp['error']}"
            )
        else:
            result = dataset_resp.get("result", {})
            dataset_columns: set = {
                col["column_name"]
                for col in result.get("columns", [])
                if isinstance(col.get("column_name"), str)
            }

            referenced = _extract_column_names(params)
            # Strip obvious placeholder names from the error list
            _PLACEHOLDERS = {
                "id", "dimension_column", "date_column", "value_column",
                "x_column", "y_column", "size_column", "label_column",
                "stage_column", "word_column", "source_column", "target_column",
                "numeric_column", "x_dimension_column", "y_dimension_column",
                "row_dimension_column", "col_dimension_column",
                "outer_dimension_column", "inner_dimension_column",
            }
            missing = [c for c in referenced if c not in dataset_columns]
            placeholders_used = [c for c in missing if c in _PLACEHOLDERS]
            real_missing      = [c for c in missing if c not in _PLACEHOLDERS]

            if placeholders_used:
                errors.append(
                    f"Placeholder column name(s) were used without being replaced: "
                    f"{placeholders_used}. "
                    f"You must substitute real column names from the dataset. "
                    f"Available columns: {sorted(dataset_columns)}."
                )
            if real_missing:
                errors.append(
                    f"Column(s) not found in dataset {datasource_id}: {real_missing}. "
                    f"Available columns: {sorted(dataset_columns)}."
                )

    if errors:
        return {
            "error": "Chart params validation failed — fix the issues below, then retry:",
            "issues": errors,
            "hint": (
                "Call superset_chart_get_viz_params_template to get the correct "
                "structure, then replace placeholder column names with real ones "
                "from the dataset (use superset_dataset_get_by_id to list columns)."
            ),
        }

    return None


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
    Create a new chart in Superset.

    MANDATORY WORKFLOW — always follow these steps to avoid errors:
    1. Call superset_chart_list_viz_types to pick a valid viz_type string.
    2. Call superset_chart_get_viz_params_template(viz_type=<chosen_type>) to get
       the correct params structure for that chart type.
    3. Inspect the target dataset's columns (via superset_dataset_get_by_id or
       superset_sql_execute) so you know real column names.
    4. Fill the template: replace every placeholder column name, set correct
       aggregates, then pass the completed dict as the 'params' argument here.

    Args:
        slice_name: Human-readable chart title.
        datasource_id: Numeric ID of the dataset (use superset_dataset_list to find it).
        datasource_type: 'table' for regular datasets; 'query' for SQL Lab virtual datasets.
        viz_type: Visualization type string — MUST be one of the values returned by
            superset_chart_list_viz_types (e.g. 'bar', 'echarts_timeseries_bar', 'line',
            'pie', 'big_number', 'big_number_total', 'table', 'heatmap', etc.).
            Do NOT invent names; use the exact string from the registry.
        params: Visualization parameters dict obtained from
            superset_chart_get_viz_params_template and filled with real column names.
            Critical rules:
            - params['viz_type'] must equal the viz_type argument.
            - Some charts use 'metric' (single object); others use 'metrics' (list).
              Check the template — never swap these.
            - 'groupby' items are plain column-name strings, NOT metric objects.
            - Metric objects require: expressionType, column (with column_name),
              aggregate, label, optionName.
            - 'time_range' must be a string like "No filter" or "Last year".
            - 'time_grain_sqla' must be one of: P1D, P1W, P1M, P3M, P1Y, PT1H, etc.

    Returns:
        A dictionary with the created chart information including its ID.
    """
    # Pre-flight validation: checks viz_type, metric/metrics structure,
    # required fields, and column existence against the real dataset.
    validation_error = await _validate_chart_params(
        ctx, viz_type, datasource_id, datasource_type, params
    )
    if validation_error:
        return validation_error

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

            db_datasets.append({
                "dataset_id": ds_id,
                "table_name": ds.get("table_name", "unknown"),
                "schema": ds.get("schema") or None,
                "column_count": sum(len(v) for v in columns_by_category.values()),
                "columns": columns_by_category,
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

    Returns a string in the format:
        [iframe](https://superset.example.com/superset/explore/?slice_id=42&standalone=1) My Chart

    Paste this string verbatim into your response — the chat UI will render it as
    an inline embedded chart.

    Args:
        chart_id: ID of the chart to embed
        title: Display title shown above the iframe (fetched automatically if omitted)

    Returns:
        A dictionary with embed_markdown (the string to include in the response),
        embed_url, chart_id, and title
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

    Returns a string in the format:
        [iframe](https://superset.example.com/superset/dashboard/5/?standalone=2) My Dashboard

    Paste this string verbatim into your response — the chat UI will render it as
    an inline embedded dashboard.

    Args:
        dashboard_id: ID of the dashboard to embed
        title: Display title shown above the iframe (fetched automatically if omitted)

    Returns:
        A dictionary with embed_markdown (the string to include in the response),
        embed_url, dashboard_id, and title
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

    Use this when you want to reference a chart as a clickable hyperlink rather
    than embedding it inline.  The returned link_markdown looks like:
        [Sales Chart](https://superset.example.com/superset/explore/?slice_id=42)

    Clicking the link in the chat navigates the main Superset panel to that chart
    with the full Superset UI (not embedded/standalone mode).

    Args:
        chart_id: ID of the chart to link to
        title: Link text shown to the user (fetched automatically if omitted)

    Returns:
        A dictionary with link_markdown (include this verbatim in your response)
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

    Use this when you want to reference a dashboard as a clickable hyperlink
    rather than embedding it inline.  The returned link_markdown looks like:
        [Sales Dashboard](https://superset.example.com/superset/dashboard/5/)

    Clicking the link in the chat navigates the main Superset panel to that
    dashboard with the full Superset UI (not embedded/standalone mode).

    Args:
        dashboard_id: ID of the dashboard to link to
        title: Link text shown to the user (fetched automatically if omitted)

    Returns:
        A dictionary with link_markdown (include this verbatim in your response)
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


"""
Integration utilities for tracking the currently opened Superset page.

This module provides functions to update the page tracker when navigation occurs.
It can be used by:
1. Frontend code that handles navigation (via postMessage interception)
2. Backend code after successful navigation tool calls
3. Direct calls from Superset if integrated there
"""
import os
import httpx
from typing import Optional
from datetime import datetime, timezone

_PAGES_SERVICE_URL = os.getenv("PAGES_SERVICE_URL", "http://pages-service:8000")


async def update_current_page(url: str, timestamp: Optional[str] = None) -> dict:
    """
    Update the tracked current page URL.
    
    Args:
        url: The full URL of the currently opened Superset page
        timestamp: ISO timestamp of when the navigation occurred (defaults to now)
    
    Returns:
        Response from the tracking service
    """
    if timestamp is None:
        timestamp = datetime.now(timezone.utc).isoformat()
    
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            resp = await client.post(
                f"{_PAGES_SERVICE_URL}/superset-tracker/api/current-page",
                json={"url": url, "timestamp": timestamp}
            )
            if resp.status_code == 200:
                return resp.json()
            else:
                return {
                    "error": f"Failed to update current page: HTTP {resp.status_code}",
                    "detail": resp.text
                }
    except Exception as e:
        return {
            "error": f"Could not connect to page tracking service: {str(e)}"
        }


async def get_current_page() -> dict:
    """
    Get the currently tracked page URL.
    
    Returns:
        Current page information from the tracking service
    """
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            resp = await client.get(
                f"{_PAGES_SERVICE_URL}/superset-tracker/api/current-page"
            )
            if resp.status_code == 200:
                return resp.json()
            else:
                return {
                    "error": f"Failed to get current page: HTTP {resp.status_code}",
                    "detail": resp.text
                }
    except Exception as e:
        return {
            "error": f"Could not connect to page tracking service: {str(e)}"
        }


def build_superset_dashboard_url(dashboard_id: int, base_url: Optional[str] = None) -> str:
    """Build the full URL for a Superset dashboard."""
    if base_url is None:
        base_url = os.getenv("SUPERSET_PUBLIC_URL", "http://localhost:8088")
    return f"{base_url}/superset/dashboard/{dashboard_id}/"


def build_superset_chart_url(chart_id: int, base_url: Optional[str] = None) -> str:
    """Build the full URL for a Superset chart."""
    if base_url is None:
        base_url = os.getenv("SUPERSET_PUBLIC_URL", "http://localhost:8088")
    return f"{base_url}/superset/explore/?slice_id={chart_id}"

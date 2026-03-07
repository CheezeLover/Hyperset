"""
Superset current page tracking backend.

This module provides endpoints to track and retrieve the currently opened
page in the Superset iframe. Used by the MCP tool superset_get_opened_page_link.
"""
from fastapi import APIRouter
from typing import Optional
from pydantic import BaseModel

router = APIRouter()

# Simple in-memory storage for the current page URL
# In a production environment with multiple instances, this should use Redis or similar
_current_superset_url: Optional[str] = None
_last_updated: Optional[str] = None


class CurrentPageRequest(BaseModel):
    url: str
    timestamp: Optional[str] = None


class CurrentPageResponse(BaseModel):
    url: Optional[str] = None
    last_updated: Optional[str] = None
    message: str


@router.post("/current-page")
async def set_current_page(req: CurrentPageRequest) -> CurrentPageResponse:
    """
    Update the currently opened Superset page URL.
    Called by frontend or other services when navigation occurs.
    """
    global _current_superset_url, _last_updated
    _current_superset_url = req.url
    _last_updated = req.timestamp or "unknown"
    return CurrentPageResponse(
        url=_current_superset_url,
        last_updated=_last_updated,
        message="Current page URL updated successfully"
    )


@router.get("/current-page")
async def get_current_page() -> CurrentPageResponse:
    """
    Get the currently opened Superset page URL.
    Called by the MCP tool superset_get_opened_page_link.
    """
    if _current_superset_url is None:
        return CurrentPageResponse(
            url=None,
            last_updated=None,
            message="No page is currently tracked. Navigate to a dashboard or chart first."
        )
    return CurrentPageResponse(
        url=_current_superset_url,
        last_updated=_last_updated,
        message="Current page URL retrieved successfully"
    )


@router.delete("/current-page")
async def clear_current_page() -> CurrentPageResponse:
    """Clear the currently tracked page URL."""
    global _current_superset_url, _last_updated
    _current_superset_url = None
    _last_updated = None
    return CurrentPageResponse(
        url=None,
        last_updated=None,
        message="Current page URL cleared"
    )

"""
Example backend for the 'hello' page.
Expose a `router = APIRouter()` — the main service mounts it at /{page_name}/api.
"""
from datetime import datetime, timezone
from fastapi import APIRouter

router = APIRouter()


@router.get("/hello")
async def hello():
    return {
        "message": "Hello from the hello-page backend!",
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }

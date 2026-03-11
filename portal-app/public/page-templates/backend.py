"""
Sample backend.py for custom page API endpoints.

This file provides custom API endpoints that will be mounted at /{page-name}/api/
"""

from fastapi import APIRouter

router = APIRouter()

@router.get("/hello")
def hello():
    """Example endpoint: returns a greeting."""
    return {"message": "Hello from custom page backend!"}

@router.get("/data")
def get_data():
    """Example endpoint: returns sample data."""
    return {
        "items": [
            {"id": 1, "name": "Item 1"},
            {"id": 2, "name": "Item 2"},
            {"id": 3, "name": "Item 3"},
        ]
    }

@router.post("/process")
def process_data(payload: dict):
    """Example endpoint: processes submitted data."""
    return {"result": f"Processed: {payload.get('data', 'nothing')}"}
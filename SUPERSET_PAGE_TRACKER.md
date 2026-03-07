# Superset Page Tracking Tool

This MCP tool (`superset_get_opened_page_link`) returns the link of the currently opened page in the Superset iframe.

## Components Created

### 1. MCP Tool: `superset_get_opened_page_link`
**Location:** `Superset-MCP/main.py`

A new MCP tool that:
- Returns a clickable markdown link to the currently opened Superset page
- Works like other MCP tools from the chat perspective
- Auto-tracks pages when `superset_get_chart_link` or `superset_get_dashboard_link` are called

**Usage:**
```
Call superset_get_opened_page_link to get the link of the currently opened page
```

**Returns:**
- `link_markdown`: Clickable markdown link (e.g., `[Chart 123](http://...)`)
- `link_url`: The full URL
- `title`: Page title (Chart/Dashboard + ID)
- `last_updated`: When the page was tracked
- `message`: Status message

### 2. Tracking Backend
**Location:** `Pages/superset-tracker/backend.py`

A FastAPI backend that:
- Provides endpoints to get/set the current page URL
- Stores the URL in memory (simple approach)
- Mounted at `/superset-tracker/api/current-page`

**Endpoints:**
- `POST /current-page` - Update the current page URL
- `GET /current-page` - Get the current page URL
- `DELETE /current-page` - Clear the tracked URL

### 3. Page Placeholder
**Location:** `Pages/superset-tracker/index.html`

A simple HTML page that serves as the frontend for the tracking service.

### 4. Integration Helper
**Location:** `Superset-MCP/page_tracker_integration.py`

Helper functions for updating/retrieving the tracked page:
- `update_current_page(url)` - Update the tracker
- `get_current_page()` - Get current tracked page
- URL builders for dashboards and charts

## How It Works

1. **Auto-tracking**: When `superset_get_chart_link` or `superset_get_dashboard_link` are called, they automatically update the tracker with the generated URL
2. **Retrieval**: `superset_get_opened_page_link` fetches the tracked URL and returns it as a clickable link
3. **No Chat Window Modifications**: All tracking happens server-side in the MCP and Pages services

## Configuration

Environment variables (optional):
- `PAGES_SERVICE_URL`: URL of the Pages service (default: `http://pages-service:8000`)

## Integration with Frontend (Optional)

If you want to track user navigation within the Superset iframe (not just MCP tool calls), you can:

1. Include a script in the Superset instance that posts messages on navigation
2. Add a listener in the portal that calls the tracking endpoint
3. Use the `page_tracker_integration.py` functions to update the tracker

Example JavaScript for Superset:
```javascript
// Track navigation in Superset
window.addEventListener('popstate', () => {
  parent.postMessage({
    type: 'superset-navigation',
    url: window.location.href
  }, '*');
});
```

## Testing

1. Start the Pages service (it will auto-discover the superset-tracker page)
2. Call `superset_get_chart_link` or `superset_get_dashboard_link` to track a page
3. Call `superset_get_opened_page_link` to retrieve the link

## Notes

- The tracking is best-effort: if the Pages service is unavailable, tracking fails silently
- Only one page is tracked at a time (the most recent one)
- For multi-instance deployments, consider using Redis instead of in-memory storage

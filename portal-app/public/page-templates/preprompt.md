# Page Creation Guide

## Overview
This guide helps you create custom additional pages for Hyperset.

## Page Structure
Each page must be a directory containing:
- `index.html` - Required. The main HTML file for your page.
- `backend.py` - Optional. Python FastAPI backend for custom API endpoints.

## Page Name Rules
- Only letters, numbers, underscores (_), and hyphens (-)
- Must start with a letter
- Examples: `docs`, `help-center`, `dashboard_v1`

## HTML Template
The blank.html template provides a starting point with:
- Responsive design
- Clean card-based layout
- Material-inspired styling

## Backend (Optional)
The backend.py template provides:
- FastAPI router structure
- Example GET and POST endpoints
- API mounted at `/your-page-name/api/`

## How to Use the AI to Build Your Page
When asking the AI to help create your page:

1. **HTML Page**: Ask it to customize the blank.html template with your specific content, styling, and interactive features.

2. **Backend**: If you need custom API endpoints, ask the AI to extend the backend.py template with your required endpoints.

3. **Testing**: After uploading, test your page by clicking on it in the sidebar. Check the browser console for any errors.

## Access Control
- By default, all users can see pages with no groups assigned
- You can restrict pages to specific user groups in the admin panel
- Deactivated pages are invisible to all users

## Tips
- Keep your HTML self-contained (inline CSS/JS) for simplicity
- Use relative URLs for any assets
- The page runs in an iframe within the Hyperset interface
- Communicate with the parent page via window.postMessage if needed
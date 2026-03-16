/**
 * /api/superset-opened-page
 *
 * The opened-page state has been moved to the browser (React state in
 * HypersetLayout) and is sent directly in each chat POST request.
 * This endpoint is kept as a stub so the Superset-MCP server does not
 * receive unexpected HTTP errors when calling superset_get_opened_page_link.
 *
 * GET  — returns {url: null} (MCP gracefully handles null as "unknown page")
 * POST — no-op 200 (browser may still call this; we just acknowledge it)
 */

import { NextResponse } from "next/server";

export async function GET() {
  return NextResponse.json(
    { url: null, updated_at: null },
    { headers: { "Cache-Control": "no-store" } },
  );
}

export async function POST() {
  return NextResponse.json({ ok: true });
}

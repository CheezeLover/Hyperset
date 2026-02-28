import { NextResponse } from "next/server";
import { getAdminSettings } from "@/lib/admin-settings";

/**
 * GET /api/cleanup-config
 *
 * Public endpoint consumed by the Superset-MCP background cleanup job to read
 * the current temporary-chart lifetime configured in the admin panel.
 * Returns a single value so the MCP server can honour admin-panel changes
 * without requiring a restart.
 *
 * No authentication required — the response contains no sensitive data.
 */
export async function GET() {
  const s = getAdminSettings();
  const cleanupDelayMinutes =
    s?.cleanupDelayMinutes ?? Number(process.env.HYPERSET_CLEANUP_DELAY_MINUTES ?? 120);

  return NextResponse.json(
    { cleanupDelayMinutes },
    { headers: { "Cache-Control": "no-store" } },
  );
}

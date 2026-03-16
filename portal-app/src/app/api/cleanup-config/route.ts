import { NextRequest, NextResponse } from "next/server";
import { getAdminSettings } from "@/lib/admin-settings";
import crypto from "crypto";

/**
 * GET /api/cleanup-config
 *
 * Internal endpoint consumed by the Superset-MCP background cleanup job to
 * read the current temporary-chart lifetime configured in the admin panel.
 * Returns a single value so the MCP server can honour admin-panel changes
 * without requiring a restart.
 *
 * Requires a Bearer token matching MCP_SERVICE_SECRET to prevent information
 * leakage to unauthenticated callers (least-privilege).
 */
export async function GET(request: NextRequest) {
  const secret = process.env.MCP_SERVICE_SECRET ?? "";
  if (!secret) {
    return NextResponse.json({ error: "Service not configured" }, { status: 503 });
  }

  const auth  = request.headers.get("Authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";

  // Timing-safe comparison: hash both values to a fixed-length digest so
  // timingSafeEqual never sees length differences that could leak information.
  const expected = crypto.createHmac("sha256", "cleanup-config").update(secret).digest();
  const received = crypto.createHmac("sha256", "cleanup-config").update(token).digest();
  if (!crypto.timingSafeEqual(expected, received)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const s = await getAdminSettings();
  const cleanupDelayMinutes =
    s?.cleanupDelayMinutes ?? Number(process.env.HYPERSET_CLEANUP_DELAY_MINUTES ?? 120);

  return NextResponse.json(
    { cleanupDelayMinutes },
    { headers: { "Cache-Control": "no-store" } },
  );
}

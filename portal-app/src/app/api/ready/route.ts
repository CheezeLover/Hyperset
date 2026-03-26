import { NextResponse } from "next/server";
import { sql, checkDbConfig } from "@/lib/db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Kubernetes readiness probe — returns 200 when the pod can serve traffic,
 * 503 when a required dependency is down.
 *
 * Separate from /api/health (liveness):
 *   - Liveness (/api/health): is the process alive?
 *   - Readiness (/api/ready): can it serve requests right now?
 *
 * K8s readinessProbe example:
 *   httpGet: { path: /api/ready, port: 3000 }
 *   initialDelaySeconds: 10
 *   periodSeconds: 10
 *   failureThreshold: 3
 */
export async function GET() {
  const checks: Record<string, string> = {};
  let ready = true;

  // PostgreSQL — required. Pod is not ready without DB.
  try {
    checkDbConfig();
    await sql`SELECT 1`;
    checks.postgres = "ok";
  } catch (err) {
    checks.postgres = `error: ${err instanceof Error ? err.message : String(err)}`;
    ready = false;
  }

  // MCP server — optional. Pod is still ready if MCP is absent;
  // the chat endpoint degrades gracefully without it.
  const mcpUrl = process.env.SUPERSET_MCP_URL;
  if (mcpUrl) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 2000);
      try {
        const res = await fetch(mcpUrl, { method: "GET", signal: controller.signal });
        // MCP stateless endpoint returns 405/406 on GET — both mean the server is alive.
        checks.mcp =
          res.ok || res.status === 405 || res.status === 406
            ? "ok"
            : `degraded (HTTP ${res.status})`;
      } finally {
        clearTimeout(timeout);
      }
    } catch {
      checks.mcp = "unreachable (non-critical)";
    }
  } else {
    checks.mcp = "not configured";
  }

  return NextResponse.json(
    { ready, service: "portal", checks },
    { status: ready ? 200 : 503 },
  );
}

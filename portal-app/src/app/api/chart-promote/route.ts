import { NextRequest, NextResponse } from "next/server";
import { callMcpTool } from "@/lib/mcp-client";
import { getUserFromRequest } from "@/lib/auth";

/**
 * POST /api/chart-promote
 * Body: { chartId: number }
 *
 * Promotes a temporary AI-generated chart to permanent by replacing
 * [HYPERSET-AI-TEMPORARY] with [HYPERSET-AI-PERMANENT] in its description.
 * This prevents the background cleanup job from deleting it.
 */
export const POST = async (req: NextRequest) => {
  const user = getUserFromRequest(req);
  if (!user.email) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let chartId: number;
  try {
    const body = await req.json();
    chartId = Number(body?.chartId);
    if (!Number.isInteger(chartId) || chartId <= 0) {
      return NextResponse.json({ error: "Invalid chartId" }, { status: 400 });
    }
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  try {
    // 1. Fetch the current chart to read its description
    const raw = await callMcpTool("superset_chart_get_by_id", { chart_id: chartId });
    let chartData: Record<string, unknown>;
    try {
      chartData = JSON.parse(typeof raw === "string" ? raw : JSON.stringify(raw));
    } catch {
      return NextResponse.json({ error: "Failed to parse chart data" }, { status: 500 });
    }

    const result = chartData?.result as Record<string, unknown> | undefined;
    const currentDesc = (result?.description as string) ?? "";

    // 2. Guard: nothing to do if already permanent or no AI stamp
    if (currentDesc.includes("[HYPERSET-AI-PERMANENT]")) {
      return NextResponse.json({ ok: true, message: "Already permanent" });
    }
    if (!currentDesc.includes("[HYPERSET-AI-TEMPORARY]")) {
      return NextResponse.json({ ok: true, message: "Not an AI-generated chart" });
    }

    // 3. Replace the flag and update the chart
    const newDesc = currentDesc.replace("[HYPERSET-AI-TEMPORARY]", "[HYPERSET-AI-PERMANENT]");
    await callMcpTool("superset_chart_update", {
      chart_id: chartId,
      data: { description: newDesc },
    });

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[chart-promote] Error:", err);
    return NextResponse.json({ error: "Failed to promote chart" }, { status: 500 });
  }
};

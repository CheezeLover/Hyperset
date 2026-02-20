import {
  CopilotRuntime,
  OpenAIAdapter,
  copilotRuntimeNextJSAppRouterEndpoint,
} from "@copilotkit/runtime";
import type { Parameter } from "@copilotkit/shared";
import OpenAI from "openai";
import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/auth";
import { listMcpTools, callMcpTool } from "@/lib/mcp-client";
import { getIronSession } from "iron-session";
import type { SessionData } from "@/lib/session";

const sessionOptions = {
  cookieName: "hyperset_session",
  password:
    process.env.SESSION_SECRET ??
    "change-me-to-a-very-long-random-secret-key-32chars",
  cookieOptions: {
    secure: process.env.NODE_ENV === "production",
    httpOnly: true,
    sameSite: "lax" as const,
    maxAge: 86400,
  },
};

function jsonSchemaToParameters(schema: Record<string, unknown>): Parameter[] {
  if (!schema || schema.type !== "object") return [];
  const props = schema.properties as
    | Record<string, { type?: string; description?: string }>
    | undefined;
  if (!props) return [];
  const required = (schema.required as string[]) ?? [];
  return Object.entries(props).map(([name, prop]) => {
    const type =
      prop.type === "number" || prop.type === "integer"
        ? "number"
        : prop.type === "boolean"
        ? "boolean"
        : "string";
    return {
      name,
      type,
      description: prop.description ?? "",
      required: required.includes(name),
    } satisfies Parameter;
  });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyAction = any;

// CopilotKit's <CopilotChat> widget makes a GET request on mount to verify
// the endpoint is reachable. Without a GET handler Next.js returns 405,
// which causes the widget to disable itself (greyed-out input).
export const GET = async (_req: NextRequest) => {
  return NextResponse.json({ ok: true });
};

export const POST = async (req: NextRequest) => {
  try {
    const user = getUserFromRequest(req);

    let apiUrl: string;
    let apiKey: string;
    let model: string;

    const dummyRes = new Response();
    const session = await getIronSession<SessionData>(
      req.clone() as NextRequest,
      dummyRes as never,
      sessionOptions
    );

    if (user.isAdmin) {
      // Admin uses adminSettings, falling back to env ADMIN_* vars
      apiUrl =
        session.adminSettings?.apiUrl ??
        process.env.ADMIN_API_URL ??
        "https://api.openai.com/v1";
      apiKey =
        session.adminSettings?.apiKey ?? process.env.ADMIN_API_KEY ?? "";
      model =
        session.adminSettings?.model ?? process.env.ADMIN_MODEL ?? "gpt-4o";
    } else {
      // Regular users use chatSettings, falling back to env CHAT_* vars
      apiUrl =
        session.chatSettings?.apiUrl ??
        process.env.CHAT_API_URL ??
        "https://api.openai.com/v1";
      apiKey =
        session.chatSettings?.apiKey ?? process.env.CHAT_API_KEY ?? "";
      model =
        session.chatSettings?.model ?? process.env.CHAT_MODEL ?? "gpt-4o";
    }

    console.log(
      `[chat] user=${user.email} isAdmin=${user.isAdmin} model=${model} url=${apiUrl}`
    );

    if (!apiKey) {
      console.error("[chat] No API key configured");
      return NextResponse.json(
        {
          error: "No API key configured",
          detail:
            "No LLM API key is set. " +
            (user.isAdmin
              ? "Open Admin Settings (gear icon) to configure one."
              : "Ask an admin to configure the chat API key."),
        },
        { status: 503 }
      );
    }

    const openai = new OpenAI({ apiKey, baseURL: apiUrl });

    // MCP may be unavailable (e.g. superset-mcp container not yet started).
    let mcpTools: Awaited<ReturnType<typeof listMcpTools>> = [];
    try {
      mcpTools = await listMcpTools();
    } catch (mcpErr) {
      console.warn("[chat] MCP unavailable, continuing without tools:", mcpErr);
    }

    const actions: AnyAction[] = mcpTools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: jsonSchemaToParameters(tool.inputSchema),
      handler: async (args: Record<string, unknown>) => {
        return await callMcpTool(tool.name, args);
      },
    }));

    actions.push({
      name: "navigate_superset_dashboard",
      description:
        "Navigate the Superset panel to show a specific dashboard. Use when user asks to open or navigate to a dashboard.",
      parameters: [
        {
          name: "dashboardId",
          type: "string",
          description: "The dashboard ID or slug to navigate to",
          required: true,
        },
      ] satisfies Parameter[],
      handler: async (args: Record<string, unknown>) => {
        return `Navigating Superset to dashboard ${args.dashboardId}`;
      },
    });

    actions.push({
      name: "navigate_superset_chart",
      description:
        "Navigate the Superset panel to show a specific chart in Explore view.",
      parameters: [
        {
          name: "chartId",
          type: "string",
          description: "The chart ID to navigate to",
          required: true,
        },
      ] satisfies Parameter[],
      handler: async (args: Record<string, unknown>) => {
        return `Opening chart ${args.chartId} in Superset Explore`;
      },
    });

    const serviceAdapter = new OpenAIAdapter({ openai, model });
    const runtime = new CopilotRuntime({ actions });

    const { handleRequest } = copilotRuntimeNextJSAppRouterEndpoint({
      runtime,
      serviceAdapter,
      endpoint: "/api/chat",
    });

    return handleRequest(req);
  } catch (err: unknown) {
    // Detect LLM API errors (OpenAI SDK wraps them with a .status field)
    const status = (err as { status?: number }).status;
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[chat] Error (HTTP ${status ?? "?"}):`, msg);

    const userFacing =
      status === 401
        ? "Authentication failed — the API key is invalid or expired."
        : status === 403
        ? "Access denied — the API key does not have permission for this model."
        : status === 429
        ? "Rate limit reached — too many requests or quota exceeded."
        : status === 404
        ? `Model not found: "${msg}". Check the model name in settings.`
        : status === 503 || status === 502
        ? "The LLM service is unavailable. Try again in a moment."
        : `LLM API error${status ? ` (HTTP ${status})` : ""}: ${msg}`;

    return NextResponse.json(
      { error: userFacing, detail: msg, status },
      { status: 502 }
    );
  }
};

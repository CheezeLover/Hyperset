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

// GET handler for two purposes:
// 1. CopilotKit probes this endpoint on mount to verify reachability.
//    Without a handler Next.js returns 405 which disables the widget.
// 2. Our own ChatPanel uses this to check if an API key is configured
//    and display an error banner before the user tries to type.
export const GET = async (req: NextRequest) => {
  const user = getUserFromRequest(req);

  // Read session to check for overrides
  const dummyRes = new Response();
  let apiKey = "";
  try {
    const session = await getIronSession<SessionData>(
      req.clone() as NextRequest,
      dummyRes as never,
      sessionOptions
    );
    apiKey = user.isAdmin
      ? (session.adminSettings?.apiKey ?? process.env.ADMIN_API_KEY ?? "")
      : (session.chatSettings?.apiKey ?? process.env.CHAT_API_KEY ?? "");
  } catch {
    // If session read fails, fall back to env vars
    apiKey = user.isAdmin
      ? (process.env.ADMIN_API_KEY ?? "")
      : (process.env.CHAT_API_KEY ?? "");
  }

  if (!apiKey) {
    return NextResponse.json(
      {
        error: "No API key configured",
        detail: user.isAdmin
          ? "No LLM API key is set. Open Admin Settings (gear icon) to configure one."
          : "The chat API key has not been configured. Ask an admin to set it up.",
      },
      { status: 503 }
    );
  }

  return NextResponse.json({ ok: true });
};

// Build the static set of actions (navigation helpers + MCP tools).
// This is called once per chat POST to get a fresh MCP tool list.
async function buildActions(): Promise<AnyAction[]> {
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

  return actions;
}

export const POST = async (req: NextRequest) => {
  try {
    // --- Peek at the body to detect the CopilotKit info/handshake request ---
    // CopilotKit sends { method: "info" } to discover available agents.
    // This must succeed regardless of API key configuration so that the
    // chat widget initialises correctly (chatReady = true).
    //
    // We clone the request here so we can read the body without consuming it
    // for the subsequent handleRequest call.
    const bodyClone = req.clone();
    let bodyMethod: string | undefined;
    try {
      const body = await bodyClone.json();
      bodyMethod = typeof body?.method === "string" ? body.method : undefined;
    } catch {
      // Non-JSON body (unlikely for info requests) — ignore
    }

    const isInfoRequest = bodyMethod === "info";

    // --- Resolve LLM settings (skipped for info requests) ---
    let apiUrl =
      process.env.ADMIN_API_URL ?? "https://api.openai.com/v1";
    let apiKey = process.env.ADMIN_API_KEY ?? "";
    let model = process.env.ADMIN_MODEL ?? "gpt-4o";
    let missingKeyError: string | undefined;

    if (!isInfoRequest) {
      const user = getUserFromRequest(req);

      const dummyRes = new Response();
      const session = await getIronSession<SessionData>(
        req.clone() as NextRequest,
        dummyRes as never,
        sessionOptions
      );

      if (user.isAdmin) {
        apiUrl =
          session.adminSettings?.apiUrl ??
          process.env.ADMIN_API_URL ??
          "https://api.openai.com/v1";
        apiKey =
          session.adminSettings?.apiKey ?? process.env.ADMIN_API_KEY ?? "";
        model =
          session.adminSettings?.model ?? process.env.ADMIN_MODEL ?? "gpt-4o";
      } else {
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
        missingKeyError =
          "No LLM API key is set. " +
          (user.isAdmin
            ? "Open Admin Settings (gear icon) to configure one."
            : "Ask an admin to configure the chat API key.");
      }
    }

    // --- Build CopilotKit runtime ---
    // For info requests, use a placeholder key (the key is never used for
    // actual LLM calls during an info round-trip).
    const effectiveKey = apiKey || "placeholder-for-info-request";
    const openai = new OpenAI({ apiKey: effectiveKey, baseURL: apiUrl });
    const actions = isInfoRequest ? [] : await buildActions();

    const serviceAdapter = new OpenAIAdapter({ openai, model });
    const runtime = new CopilotRuntime({ actions });

    const { handleRequest } = copilotRuntimeNextJSAppRouterEndpoint({
      runtime,
      serviceAdapter,
      endpoint: "/api/chat",
    });

    // For actual chat runs (not info), reject before forwarding if no key.
    // We still build the runtime above so that handleRequest can be called
    // for the info case.
    if (!isInfoRequest && missingKeyError) {
      console.error("[chat] No API key configured");
      return NextResponse.json(
        { error: "No API key configured", detail: missingKeyError },
        { status: 503 }
      );
    }

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

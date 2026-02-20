import {
  CopilotRuntime,
  OpenAIAdapter,
  copilotRuntimeNextJSAppRouterEndpoint,
} from "@copilotkit/runtime";
import type { Parameter } from "@copilotkit/shared";
import OpenAI from "openai";
import { NextRequest } from "next/server";
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

export const POST = async (req: NextRequest) => {
  const user = getUserFromRequest(req);

  let apiUrl: string;
  let apiKey: string;
  let model: string;

  if (user.isAdmin) {
    const dummyRes = new Response();
    const session = await getIronSession<SessionData>(
      req.clone() as NextRequest,
      dummyRes as never,
      sessionOptions
    );
    apiUrl =
      session.adminSettings?.apiUrl ??
      process.env.ADMIN_API_URL ??
      "https://api.openai.com/v1";
    apiKey =
      session.adminSettings?.apiKey ?? process.env.ADMIN_API_KEY ?? "";
    model =
      session.adminSettings?.model ?? process.env.ADMIN_MODEL ?? "gpt-4o";
  } else {
    apiUrl = process.env.CHAT_API_URL ?? "https://api.openai.com/v1";
    apiKey = process.env.CHAT_API_KEY ?? "";
    model = process.env.CHAT_MODEL ?? "gpt-4o";
  }

  const openai = new OpenAI({
    apiKey: apiKey || "placeholder",
    baseURL: apiUrl,
  });

  // MCP may be unreachable (e.g. superset-mcp not started, or direct port-3000 testing).
  // Degrade gracefully — chat still works, just without MCP tools.
  let mcpTools: Awaited<ReturnType<typeof listMcpTools>> = [];
  try {
    mcpTools = await listMcpTools();
  } catch {
    // MCP unavailable — continue without tools
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
};

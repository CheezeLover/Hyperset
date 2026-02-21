// Direct import without early environment setup
import {
  CopilotRuntime,
  copilotRuntimeNextJSAppRouterEndpoint,
} from "@copilotkit/runtime";
import OpenAI from "openai";
import type { Parameter } from "@copilotkit/shared";
import { TransformStream } from "stream/web";

// Create a proper OpenAI-compatible service adapter
// This implements the CopilotServiceAdapter interface that CopilotKit expects
class OpenAILikeServiceAdapter {
  private client: OpenAI;
  model: string;  // Make this public to match the interface
  
  provider: string = "openai"; // Default to openai for compatibility
  
  constructor(apiKey: string, baseURL: string, model: string) {
    // Create OpenAI client with proper configuration
    this.client = new OpenAI({
      apiKey: baseURL.includes("openai.com") ? apiKey : `sk-${apiKey}`,
      baseURL: baseURL,
      // For non-OpenAI providers, ensure proper headers
      ...(!baseURL.includes("openai.com") ? {
        defaultHeaders: {
          "Authorization": `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
      } : {}),
    });
    this.model = model;
    // Set provider explicitly to avoid "undefined" provider errors
    this.provider = "openai"; // Force openai provider for all cases
  }
  
  // Implement the process method that CopilotKit expects
  async process(params: {
    messages: any[];
    options?: Record<string, any>;
    functions?: any[];
    stream?: boolean;
  }) {
    try {
      const stream = params.stream ?? true;
      const response = await this.client.chat.completions.create({
        model: this.model,
        messages: params.messages,
        stream: stream,
        ...(params.options || {}),
        ...(params.functions ? { functions: params.functions } : {}),
      });
      
      // Transform the response to match CopilotKit's expected format
      if (stream) {
        // For streaming responses - handle the async iterable properly
        const transformedStream = new TransformStream<any, any>();
        const writer = transformedStream.writable.getWriter();
        
        (async () => {
          try {
            // Type the response properly as AsyncIterable
            const asyncIterable = response as AsyncIterable<any>;
            for await (const chunk of asyncIterable) {
              // Transform each chunk to CopilotKit format
              const transformedChunk = {
                id: chunk.id,
                object: chunk.object,
                created: chunk.created,
                model: chunk.model,
                choices: chunk.choices?.map((choice: { index: number; delta?: { content?: string }; finish_reason: string | null }) => ({
                  index: choice.index,
                  delta: choice.delta,
                  finish_reason: choice.finish_reason,
                })) || [],
                usage: chunk.usage,
                threadId: params.options?.threadId || `thread_${Date.now()}`,
              };
              await writer.write(transformedChunk);
            }
            await writer.close();
          } catch (error) {
            await writer.abort(error);
          }
        })();
        
        return {
          stream: transformedStream.readable,
          threadId: params.options?.threadId || `thread_${Date.now()}`,
        };
      } else {
        // For non-streaming responses - type as ChatCompletion
        const chatCompletion = response as {
          id: string;
          object: string;
          created: number;
          model: string;
          choices: any[];
          usage: any;
        };
        
        return {
          id: chatCompletion.id,
          object: chatCompletion.object,
          created: chatCompletion.created,
          model: chatCompletion.model,
          choices: chatCompletion.choices.map((choice: any) => ({
            index: choice.index,
            message: choice.message,
            finish_reason: choice.finish_reason,
          })),
          usage: chatCompletion.usage,
          threadId: params.options?.threadId || `thread_${Date.now()}`,
        };
      }
    } catch (error) {
      console.error("OpenAI-like adapter process error:", error);
      throw error;
    }
  }
  
  // Add other methods that might be expected
  getModel() {
    return this.model;
  }
  
  getClient() {
    return this.client;
  }
}
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

  // Check MCP availability (non-blocking — a missing MCP is a warning, not an error)
  let mcpWarning: string | undefined;
  try {
    const mcpUrl = process.env.SUPERSET_MCP_URL ?? "http://hyperset-superset-mcp:8000/mcp";
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2000);
    try {
      const res = await fetch(mcpUrl, { method: "GET", signal: controller.signal });
      // 405 Method Not Allowed and 406 Not Acceptable both mean the server is up
      // (stateless_http mode returns 406 on GET; stateful mode returns 405 or 200)
      if (res.status !== 200 && res.status !== 405 && res.status !== 406) {
        mcpWarning = `Superset MCP unavailable (HTTP ${res.status}) — data tools disabled.`;
      }
    } finally {
      clearTimeout(timeout);
    }
  } catch {
    mcpWarning = "Superset MCP unreachable — data tools disabled. Chat still works.";
  }

  return NextResponse.json({ ok: true, ...(mcpWarning ? { mcpWarning } : {}) });
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
  const reqStart = Date.now();
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
      const rawBody = await bodyClone.json();
      bodyMethod = typeof (rawBody as Record<string,unknown>)?.method === "string"
        ? (rawBody as Record<string,unknown>).method as string
        : undefined;
    } catch {
      // Non-JSON body (unlikely for info requests) — ignore
    }

    const isInfoRequest = bodyMethod === "info";
    console.log(`[chat] POST method=${bodyMethod ?? "(none)"} isInfo=${isInfoRequest}`);

    // --- Handle CopilotKit info/handshake request directly ---
    // CopilotKit (single-route transport) sends POST { method: "info" } and
    // expects { agents: { default: { description: "" } } } plain JSON back.
    // Forwarding to handleRequest() returns a GraphQL streaming response which
    // the client cannot parse → runtimeConnectionStatus stays "error" →
    // chatReady stays false → permanent spinner.
    // We must include a "default" agent entry or useAgent() throws.
    if (isInfoRequest) {
      console.log(`[chat] Returning info response with default agent`);
      return NextResponse.json({ agents: { default: { description: "" } } });
    }

    // --- Resolve LLM settings ---
    const user = getUserFromRequest(req);
    console.log(`[chat] user=${user.email} isAdmin=${user.isAdmin}`);

    const dummyRes = new Response();
    let session;
    try {
      session = await getIronSession<SessionData>(
        req.clone() as NextRequest,
        dummyRes as never,
        sessionOptions
      );
      console.log(`[chat] session resolved adminSettings=${!!session.adminSettings} chatSettings=${!!session.chatSettings}`);
    } catch (sessionErr) {
      console.error(`[chat] Failed to read session:`, sessionErr);
      session = {} as SessionData;
    }

    let apiUrl: string;
    let apiKey: string;
    let model: string;

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

    console.log(`[chat] apiUrl=${apiUrl} model=${model} hasKey=${!!apiKey}`);

    if (!apiKey) {
      const missingKeyError =
        "No LLM API key is set. " +
        (user.isAdmin
          ? "Open Admin Settings (gear icon) to configure one."
          : "Ask an admin to configure the chat API key.");
      console.warn(`[chat] missingKeyError: ${missingKeyError}`);
      return NextResponse.json(
        { error: "No API key configured", detail: missingKeyError },
        { status: 503 }
      );
    }

    // --- Build CopilotKit runtime ---
    console.log(`[chat] building service adapter for ${apiUrl}...`);
    
    // Try the CopilotKit approach first
    try {
      const actions = await buildActions();
      console.log(`[chat] actions built count=${actions.length}`);

      // Create our custom service adapter that works with any OpenAI-compatible API
      // Use a standard OpenAI model name to avoid provider detection issues
      console.log(`[chat] Original model: ${model}, apiUrl: ${apiUrl}`);
      
      // Always use a standard OpenAI model name for CopilotKit compatibility
      // Our adapter will handle the actual API endpoint and model mapping
      const copilotKitModel = "gpt-4"; // Use a standard OpenAI model name
      console.log(`[chat] Using CopilotKit-compatible model: ${copilotKitModel}`);
      
      const serviceAdapter = new OpenAILikeServiceAdapter(apiKey, apiUrl, model); // Use original model internally
      
      // Create the runtime
      const runtime = new CopilotRuntime({ actions });

      // Create the endpoint handler with our custom adapter
      const { handleRequest } = copilotRuntimeNextJSAppRouterEndpoint({
        runtime,
        serviceAdapter,
        endpoint: "/api/chat",
      });

      console.log(`[chat] calling handleRequest (elapsed ${Date.now() - reqStart}ms)`);
      const response = await handleRequest(req);
      console.log(`[chat] handleRequest returned status=${response.status} (elapsed ${Date.now() - reqStart}ms)`);
      return response;
    } catch (error) {
      console.error(`[chat] CopilotKit approach failed, trying direct approach:`, error);
      
      // Fallback: Handle the request directly if CopilotKit fails
      try {
        const body = await req.json();
        const serviceAdapter = new OpenAILikeServiceAdapter(apiKey, apiUrl, model);
        
        if (body.messages) {
          const result = await serviceAdapter.process({
            messages: body.messages,
            options: body.options,
            functions: body.functions,
            stream: body.stream,
          });
          
          return NextResponse.json(result);
        } else {
          return NextResponse.json({ error: "Invalid request format" }, { status: 400 });
        }
      } catch (directError) {
        console.error(`[chat] Direct approach also failed:`, directError);
        return NextResponse.json(
          { error: "Failed to process request with both approaches", detail: String(directError) },
          { status: 500 }
        );
      }
    }
  } catch (err: unknown) {
    // Detect LLM API errors (OpenAI SDK wraps them with a .status field)
    const status = (err as { status?: number }).status;
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[chat] UNHANDLED ERROR (HTTP ${status ?? "?"}) after ${Date.now() - reqStart}ms:`, msg);
    if (err instanceof Error) console.error(err.stack);

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

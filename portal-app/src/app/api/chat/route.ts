import {
  CopilotRuntime,
  OpenAIAdapter,
  copilotRuntimeNextJSAppRouterEndpoint,
} from "@copilotkit/runtime";
import OpenAI from "openai";
import type { Parameter } from "@copilotkit/shared";
import { NextRequest, NextResponse } from "next/server";
import { listMcpTools, callMcpTool } from "@/lib/mcp-client";
import { getIronSession } from "iron-session";
import type { SessionData } from "@/lib/session";

// ---------------------------------------------------------------------------
// Module-level fetch patch: proxy /responses ↔ /chat/completions
// ---------------------------------------------------------------------------
// The Vercel AI SDK v5 (@ai-sdk/openai ≥ 2.x) defaults to the OpenAI
// /responses endpoint, which most compatible providers (Mistral, Ollama, …)
// don't implement.  The "compatibility" option that would disable this does
// not exist in the version bundled with @copilotkit/runtime.
//
// Strategy: intercept fetch at module-load time, rewrite the *request* body
// from Responses-API format to Chat-Completions format, call the provider,
// then wrap the *response* stream so each SSE chunk is re-encoded as a
// Responses-API event that the AI SDK can parse.
//
// Responses-API SSE events the AI SDK stream parser looks for:
//   response.created          { response: { id, ... } }
//   response.output_item.added { output_index, item: { id, type, role?, ... } }
//   response.output_text.delta { item_id, output_index, content_index, delta }
//   response.output_text.done  { item_id, output_index, content_index, text }
//   response.output_item.done  { output_index, item: { ... } }
//   response.function_call_arguments.delta { item_id, output_index, delta }
//   response.function_call_arguments.done  { item_id, output_index, arguments }
//   response.completed        { response: { ... } }
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(function patchFetchForResponsesEndpoint() {
  const _original = globalThis.fetch;

  // Translate a /responses request body → /chat/completions request body
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function translateRequestBody(body: Record<string, any>): Record<string, any> {
    const out = { ...body };

    // input[] → messages[]
    if (Array.isArray(out.input)) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      out.messages = out.input.map((msg: any) => {
        if (typeof msg.content === "string") return msg;
        if (Array.isArray(msg.content)) {
          const allText = msg.content.every(
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (p: any) => p.type === "input_text" || p.type === "text"
          );
          if (allText) {
            return { role: msg.role, content: msg.content.map((p: { text?: string }) => p.text ?? "").join("") };
          }
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          return { role: msg.role, content: msg.content.map((p: any) => {
            if (p.type === "input_text") return { type: "text", text: p.text };
            if (p.type === "input_image") return { type: "image_url", image_url: { url: p.image_url } };
            return p;
          }) };
        }
        return msg;
      });
      delete out.input;
    }

    // tools[]: flat Responses-API → wrapped Chat-Completions format
    if (Array.isArray(out.tools)) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      out.tools = out.tools.map((t: any) => {
        if (t.type === "function" && t.function) return t;
        if (t.type === "function" && !t.function) {
          const { type: _type, strict: _strict, ...rest } = t;
          return { type: "function", function: rest };
        }
        return t;
      });
    }

    // Strip Responses-API-only fields
    delete out.previous_response_id;
    delete out.reasoning;
    delete out.truncation;
    delete out.store;
    delete out.metadata;

    return out;
  }

  // Wrap a /chat/completions SSE response stream as a /responses SSE stream
  function wrapResponseStream(chatStream: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();

    // State for building the synthetic Responses-API event sequence
    const responseId = "resp_" + Math.random().toString(36).slice(2);
    const itemId = "item_" + Math.random().toString(36).slice(2);
    let headerSent = false;
    let textStarted = false;
    let fullText = "";
    let toolCallState: Record<number, { id: string; name: string; args: string }> = {};

    function sseEvent(type: string, data: unknown): Uint8Array {
      return encoder.encode(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
    }

    const transform = new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        const text = decoder.decode(chunk, { stream: true });
        const lines = text.split("\n");

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const payload = line.slice(6).trim();
          if (payload === "[DONE]") continue;

          let parsed: Record<string, unknown>;
          try {
            parsed = JSON.parse(payload);
          } catch {
            continue;
          }

          // Send response.created once
          if (!headerSent) {
            headerSent = true;
            controller.enqueue(sseEvent("response.created", {
              type: "response.created",
              response: { id: responseId, object: "realtime.response", status: "in_progress", output: [] },
            }));
            controller.enqueue(sseEvent("response.output_item.added", {
              type: "response.output_item.added",
              output_index: 0,
              item: { id: itemId, object: "realtime.item", type: "message", role: "assistant", content: [] },
            }));
          }

          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const choices = (parsed as any).choices as Array<Record<string, unknown>> | undefined;
          if (!choices?.length) continue;

          const delta = choices[0].delta as Record<string, unknown> | undefined;
          const finishReason = choices[0].finish_reason as string | null;

          // Text delta
          const textContent = delta?.content;
          if (typeof textContent === "string" && textContent.length > 0) {
            if (!textStarted) {
              textStarted = true;
              controller.enqueue(sseEvent("response.content_part.added", {
                type: "response.content_part.added",
                item_id: itemId,
                output_index: 0,
                content_index: 0,
                part: { type: "text", text: "" },
              }));
            }
            fullText += textContent;
            controller.enqueue(sseEvent("response.output_text.delta", {
              type: "response.output_text.delta",
              item_id: itemId,
              output_index: 0,
              content_index: 0,
              delta: textContent,
            }));
          }

          // Tool call deltas
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const toolCalls = delta?.tool_calls as Array<any> | undefined;
          if (Array.isArray(toolCalls)) {
            for (const tc of toolCalls) {
              const idx: number = tc.index ?? 0;
              if (!toolCallState[idx]) {
                const tcItemId = "tc_" + Math.random().toString(36).slice(2);
                toolCallState[idx] = { id: tcItemId, name: "", args: "" };
                controller.enqueue(sseEvent("response.output_item.added", {
                  type: "response.output_item.added",
                  output_index: idx + 1,
                  item: { id: tcItemId, object: "realtime.item", type: "function_call", name: tc.function?.name ?? "", call_id: tc.id ?? tcItemId },
                }));
              }
              if (tc.function?.name) toolCallState[idx].name = tc.function.name;
              if (tc.function?.arguments) {
                toolCallState[idx].args += tc.function.arguments;
                controller.enqueue(sseEvent("response.function_call_arguments.delta", {
                  type: "response.function_call_arguments.delta",
                  item_id: toolCallState[idx].id,
                  output_index: idx + 1,
                  delta: tc.function.arguments,
                }));
              }
            }
          }

          // Finish
          if (finishReason === "stop" || finishReason === "tool_calls") {
            if (textStarted) {
              controller.enqueue(sseEvent("response.output_text.done", {
                type: "response.output_text.done",
                item_id: itemId,
                output_index: 0,
                content_index: 0,
                text: fullText,
              }));
              controller.enqueue(sseEvent("response.content_part.done", {
                type: "response.content_part.done",
                item_id: itemId,
                output_index: 0,
                content_index: 0,
                part: { type: "text", text: fullText },
              }));
              controller.enqueue(sseEvent("response.output_item.done", {
                type: "response.output_item.done",
                output_index: 0,
                item: { id: itemId, object: "realtime.item", type: "message", role: "assistant", status: "completed",
                        content: [{ type: "text", text: fullText }] },
              }));
            }
            for (const [tcIdx, tc] of Object.entries(toolCallState)) {
              const numIdx = Number(tcIdx) + 1;
              controller.enqueue(sseEvent("response.function_call_arguments.done", {
                type: "response.function_call_arguments.done",
                item_id: tc.id,
                output_index: numIdx,
                arguments: tc.args,
              }));
              controller.enqueue(sseEvent("response.output_item.done", {
                type: "response.output_item.done",
                output_index: numIdx,
                item: { id: tc.id, object: "realtime.item", type: "function_call", name: tc.name,
                        call_id: tc.id, arguments: tc.args, status: "completed" },
              }));
            }
            controller.enqueue(sseEvent("response.completed", {
              type: "response.completed",
              response: { id: responseId, object: "realtime.response", status: "completed",
                          output: [], usage: (parsed as Record<string,unknown>).usage ?? {} },
            }));
          }
        }
      },
      flush(controller) {
        // If stream ended without a finish_reason (unexpected), close cleanly
        if (!headerSent) return;
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      },
    });

    return chatStream.pipeThrough(transform);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  globalThis.fetch = async function (input: any, init?: RequestInit): Promise<Response> {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
        ? input.href
        : (input as Request).url;

    if (!url.endsWith("/responses")) {
      return _original(input, init);
    }

    // Rewrite URL: /responses → /chat/completions
    const rewritten = url.replace(/\/responses$/, "/chat/completions");

    // Translate request body
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let body: Record<string, any> = {};
    if (init?.body) {
      try {
        body = JSON.parse(init.body as string);
      } catch {
        return _original(rewritten, init);
      }
    }
    const translatedBody = translateRequestBody(body);

    console.log(`[fetch-patch] rewrote ${url} → ${rewritten}`);
    const chatResponse = await _original(rewritten, { ...init, body: JSON.stringify(translatedBody) });

    // If not a streaming response, pass through as-is
    if (!chatResponse.ok || !chatResponse.body) return chatResponse;
    const contentType = chatResponse.headers.get("content-type") ?? "";
    if (!contentType.includes("text/event-stream")) return chatResponse;

    // Wrap the response stream: translate chat.completion SSE → responses SSE
    const wrappedStream = wrapResponseStream(chatResponse.body);
    return new Response(wrappedStream, {
      status: chatResponse.status,
      headers: chatResponse.headers,
    });
  };
})();

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
  // Read session to check for overrides
  const dummyRes = new Response();
  let apiKey = "";
  try {
    const session = await getIronSession<SessionData>(
      req.clone() as NextRequest,
      dummyRes as never,
      sessionOptions
    );
    apiKey = session.llmSettings?.apiKey ?? process.env.LLM_API_KEY ?? "";
  } catch {
    // If session read fails, fall back to env vars
    apiKey = process.env.LLM_API_KEY ?? "";
  }

  if (!apiKey) {
    return NextResponse.json(
      {
        error: "No API key configured",
        detail: "No LLM API key is set. An admin can configure one via the settings (gear icon).",
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
    // CopilotKit sends POST { method: "info" } expecting { agents: {...} } JSON.
    // Forwarding to handleRequest() returns a GraphQL streaming response the
    // client cannot parse → permanent spinner.
    // We must include a "default" agent entry or the CopilotKit client throws.
    if (isInfoRequest) {
      console.log(`[chat] Returning info response`);
      return NextResponse.json({ agents: { default: { description: "" } } });
    }

    // --- Resolve LLM settings ---

    const dummyRes = new Response();
    let session;
    try {
      session = await getIronSession<SessionData>(
        req.clone() as NextRequest,
        dummyRes as never,
        sessionOptions
      );
      console.log(`[chat] session resolved llmSettings=${!!session.llmSettings}`);
    } catch (sessionErr) {
      console.error(`[chat] Failed to read session:`, sessionErr);
      session = {} as SessionData;
    }

    const apiUrl =
      session.llmSettings?.apiUrl ??
      process.env.LLM_API_URL ??
      "https://api.openai.com/v1";
    const apiKey =
      session.llmSettings?.apiKey ?? process.env.LLM_API_KEY ?? "";
    const model =
      session.llmSettings?.model ?? process.env.LLM_MODEL ?? "gpt-4o";

    console.log(`[chat] apiUrl=${apiUrl} model=${model} hasKey=${!!apiKey}`);

    if (!apiKey) {
      const missingKeyError = "No LLM API key is set. An admin can configure one via the settings (gear icon).";
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

      // Build an OpenAI-compatible client pointing at the configured endpoint
      // (works for Mistral, Ollama, vLLM, Together AI, or vanilla OpenAI).
      console.log(`[chat] model: ${model}, apiUrl: ${apiUrl}`);

      // OpenAI SDK client for OpenAIAdapter — uses /chat/completions directly.
      const openaiClient = new OpenAI({ apiKey, baseURL: apiUrl });
      const serviceAdapter = new OpenAIAdapter({ openai: openaiClient, model });

      // CopilotKit's agent runner uses @ai-sdk/openai internally and reads
      // OPENAI_API_KEY / OPENAI_BASE_URL from env at init time.
      // Set them per-request so the key check passes and requests go to the
      // right host.  The module-level fetch patch (above) rewrites /responses
      // → /chat/completions so the endpoint is also correct.
      process.env.OPENAI_API_KEY = apiKey;
      process.env.OPENAI_BASE_URL = apiUrl;

      // Create the runtime
      const runtime = new CopilotRuntime({ actions });

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
      console.error(`[chat] handleRequest failed:`, error);
      throw error;
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

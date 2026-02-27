import { NextRequest, NextResponse } from "next/server";
import { getIronSession } from "iron-session";
import type { SessionData } from "@/lib/session";
import { listMcpTools, callMcpTool } from "@/lib/mcp-client";
import OpenAI from "openai";

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

// ── GET: health / config check ───────────────────────────────────
export const GET = async (req: NextRequest) => {
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
    apiKey = process.env.LLM_API_KEY ?? "";
  }

  if (!apiKey) {
    return NextResponse.json(
      { error: "No API key configured", detail: "No LLM API key is set. An admin can configure one via the settings (gear icon)." },
      { status: 503 }
    );
  }

  // Non-blocking MCP probe
  let mcpWarning: string | undefined;
  try {
    const mcpUrl = process.env.SUPERSET_MCP_URL ?? "http://hyperset-superset-mcp:8000/mcp";
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2000);
    try {
      const res = await fetch(mcpUrl, { method: "GET", signal: controller.signal });
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

// ── Follow-up suggestion generation ────────────────────────────
const DEFAULT_FOLLOWUP_SYSTEM =
  "You are a helpful assistant that generates follow-up questions based on conversation context. " +
  "Always respond with only a valid JSON array of strings, with no additional text or explanation.";

async function generateFollowupSuggestions(
  openai: OpenAI,
  model: string,
  conversationHistory: OpenAI.Chat.ChatCompletionMessageParam[],
): Promise<string[]> {
  try {
    const historyText = conversationHistory
      .map((msg) => `${msg.role}: ${msg.content}`)
      .join("\n");

    const suggestionPrompt = `Based on the conversation history below, generate 3-4 concise, relevant follow-up questions that would help the user explore this topic further. Respond only with a valid JSON array of strings, with no additional text or explanation.\n\nConversation history:\n${historyText}\n\nFollow-up questions (JSON array only):`;

    // NOTE: Do NOT use response_format:"json_object" here — that forces the
    // root value to be a JSON *object* ({…}), which means Array.isArray()
    // will always be false and suggestions silently return empty.
    const response = await openai.chat.completions.create({
      model: model,
      messages: [
        { role: "system", content: DEFAULT_FOLLOWUP_SYSTEM },
        { role: "user",   content: suggestionPrompt },
      ],
      max_tokens: 300,
      temperature: 0.7,
    });

    const result = response.choices[0]?.message?.content?.trim();
    if (!result) return [];

    // Parse robustly: accept ["q1","q2"] OR {"questions":["q1","q2"]} OR
    // any object that has exactly one array-valued property.
    try {
      const parsed: unknown = JSON.parse(result);
      let arr: unknown[] | null = null;

      if (Array.isArray(parsed)) {
        arr = parsed;
      } else if (parsed !== null && typeof parsed === "object") {
        // Find the first array-valued property (handles {"questions":[…]},
        // {"followup":[…]}, {"0":"q1","1":"q2"} numeric-keyed objects, etc.)
        for (const v of Object.values(parsed as Record<string, unknown>)) {
          if (Array.isArray(v)) { arr = v; break; }
        }
      }

      if (arr) {
        return arr
          .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
          .slice(0, 4)
          .map((s) => s.trim().replace(/^["']|["']$/g, ""));
      }
    } catch {
      // JSON parse failed — model returned plain text.
      // Try quoted strings first, then numbered/bulleted lines.
      const quoted = result.match(/"([^"]+)"/g) ?? [];
      if (quoted.length > 0) {
        return quoted.slice(0, 4).map((m) => m.replace(/^"|"$/g, "").trim());
      }
      const lines = result
        .split("\n")
        .map((l) => l.replace(/^\s*[\d\-*•]+[.)]\s*/, "").trim())
        .filter((l) => l.length > 8);
      return lines.slice(0, 4);
    }

    return [];
  } catch (error) {
    console.error("Error generating follow-up suggestions:", error);
    return [];
  }
}

// ── POST: streaming chat completion ──────────────────────────────
// Body: { messages: [{role,content}], stream?: boolean }
export const POST = async (req: NextRequest) => {
  const dummyRes = new Response();
  let session: SessionData;
  try {
    const s = await getIronSession<SessionData>(
      req.clone() as NextRequest,
      dummyRes as never,
      sessionOptions
    );
    session = s;
  } catch {
    session = {};
  }

  const apiUrl = session.llmSettings?.apiUrl ?? process.env.LLM_API_URL ?? "https://api.openai.com/v1";
  const apiKey = session.llmSettings?.apiKey ?? process.env.LLM_API_KEY ?? "";
  const model  = session.llmSettings?.model  ?? process.env.LLM_MODEL  ?? "gpt-4o";
  const systemPrompt = session.llmSettings?.systemPrompt ?? process.env.LLM_SYSTEM_PROMPT ?? "";

  if (!apiKey) {
    return NextResponse.json({ error: "No API key configured" }, { status: 503 });
  }

  // Parse incoming messages from the client
  let body: { messages?: OpenAI.Chat.ChatCompletionMessageParam[] };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const userMessages: OpenAI.Chat.ChatCompletionMessageParam[] = body.messages ?? [];

  // Build the MCP tool definitions
  let mcpTools: OpenAI.Chat.ChatCompletionTool[] = [];
  try {
    const raw = await listMcpTools();
    mcpTools = raw.map((t) => ({
      type: "function" as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: t.inputSchema as Record<string, unknown>,
      },
    }));
  } catch {
    // MCP unavailable — proceed without tools
  }

  // Navigation tools (client-side effect, always available)
  const navTools: OpenAI.Chat.ChatCompletionTool[] = [
    {
      type: "function",
      function: {
        name: "navigate_superset_dashboard",
        description: "Navigate the Superset panel to show a specific dashboard. Use when user asks to open or navigate to a dashboard.",
        parameters: {
          type: "object",
          properties: { dashboardId: { type: "string", description: "The dashboard ID or slug to navigate to" } },
          required: ["dashboardId"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "navigate_superset_chart",
        description: "Navigate the Superset panel to show a specific chart in Explore view.",
        parameters: {
          type: "object",
          properties: { chartId: { type: "string", description: "The chart ID to navigate to" } },
          required: ["chartId"],
        },
      },
    },
  ];

  const tools = [...navTools, ...mcpTools];

  // Build message list with optional system prompt
  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    ...(systemPrompt
      ? [{ role: "system" as const, content: systemPrompt }]
      : [
          {
            role: "system" as const,
            content: `You are Hyperset, an intelligent assistant for Apache Superset analytics. You have access to the full Superset MCP API (dashboards, charts, SQL execution, datasets, databases). When users ask to navigate to a dashboard or chart, use navigate_superset_dashboard or navigate_superset_chart. Always present SQL query results clearly with key insights.

SUPERSET CONTENT — two ways to reference charts and dashboards:

1. INLINE EMBED (shows the chart/dashboard right inside the chat):
   - Call superset_get_chart_embed or superset_get_dashboard_embed.
   - Output the embed_markdown value on its own plain line, with no surrounding text on that line.
   - Format: [iframe](URL) Title
   - NEVER wrap it in backticks or a code block — it must be a raw standalone line.
   - Use this when the user explicitly asks to "show", "display", or "embed" a chart/dashboard.

2. CLICKABLE LINK (opens in the Superset panel when clicked):
   - Call superset_get_chart_link or superset_get_dashboard_link.
   - Output the link_markdown value inline in your sentence, just like a normal hyperlink.
   - Format: [Title](URL)  — no [iframe] prefix.
   - Use this when you want to reference a chart/dashboard without embedding it, e.g. "You can view the [Sales Dashboard](URL) for more details."

Examples:
  Embed:  [iframe](https://superset.example.com/superset/explore/?slice_id=42&standalone=1) Sales Chart
  Link:   [Sales Chart](https://superset.example.com/superset/explore/?slice_id=42)`,
          },
        ]),
    ...userMessages,
  ];

  // Parse model parameters if provided
  let modelParams = {};
  try {
    if (session.llmSettings?.modelParams) {
      modelParams = JSON.parse(session.llmSettings.modelParams);
    }
  } catch (e) {
    console.error("Invalid JSON in modelParams:", e);
  }

  const openai = new OpenAI({ apiKey, baseURL: apiUrl });

  // Agentic loop: keep calling the model until it stops requesting tool calls
  // We run up to 10 iterations to avoid infinite loops.
  const MAX_TURNS = 10;
  const accumulated: OpenAI.Chat.ChatCompletionMessageParam[] = [...messages];

  const encoder = new TextEncoder();

  // We stream back a custom NDJSON protocol:
  //   {"type":"delta","content":"..."}       — text delta
  //   {"type":"tool_call","name":"...","args":{}} — tool being called
  //   {"type":"tool_result","name":"...","result":"..."} — tool result
  //   {"type":"done"}                         — stream complete
  //   {"type":"error","message":"..."}        — error
  const stream = new ReadableStream({
    async start(controller) {
      function send(obj: unknown) {
        controller.enqueue(encoder.encode(JSON.stringify(obj) + "\n"));
      }

      try {
        for (let turn = 0; turn < MAX_TURNS; turn++) {
          const completion = await openai.chat.completions.create({
            model,
            messages: accumulated,
            tools: tools.length > 0 ? tools : undefined,
            tool_choice: tools.length > 0 ? "auto" : undefined,
            stream: true,
            ...modelParams, // Spread additional model parameters
          });

          // Accumulate this turn's response
          let assistantText = "";
          const toolCallMap: Record<number, { id: string; name: string; args: string }> = {};
          let finishReason: string | null = null;

          for await (const chunk of completion) {
            const choice = chunk.choices[0];
            if (!choice) continue;
            finishReason = choice.finish_reason ?? finishReason;

            const delta = choice.delta;

            // Stream text deltas
            if (delta.content) {
              assistantText += delta.content;
              send({ type: "delta", content: delta.content });
            }

            // Accumulate tool call deltas
            if (delta.tool_calls) {
              for (const tc of delta.tool_calls) {
                const idx = tc.index ?? 0;
                if (!toolCallMap[idx]) {
                  toolCallMap[idx] = { id: tc.id ?? "", name: "", args: "" };
                }
                if (tc.id) toolCallMap[idx].id = tc.id;
                if (tc.function?.name) toolCallMap[idx].name += tc.function.name;
                if (tc.function?.arguments) toolCallMap[idx].args += tc.function.arguments;
              }
            }
          }

          // Add assistant message to history
          const toolCalls = Object.values(toolCallMap);
          if (toolCalls.length > 0) {
            accumulated.push({
              role: "assistant",
              content: assistantText || null,
              tool_calls: toolCalls.map((tc) => ({
                id: tc.id,
                type: "function" as const,
                function: { name: tc.name, arguments: tc.args },
              })),
            });
          } else {
            accumulated.push({ role: "assistant", content: assistantText });
          }

          // If finish_reason is "stop" or no tool calls, we're done
          if (finishReason !== "tool_calls" || toolCalls.length === 0) {
            // Generate follow-up suggestions using the LLM
            if (assistantText) {
              try {
                const suggestions = await generateFollowupSuggestions(openai, model, accumulated);
                if (suggestions.length > 0) {
                  send({ type: "followup_suggestions", suggestions });
                }
              } catch (e) {
                console.error("Failed to generate follow-up suggestions:", e);
                // Continue even if suggestion generation fails
              }
            }
            break;
          }

          // Execute tool calls
          for (const tc of toolCalls) {
            let args: Record<string, unknown> = {};
            try { args = JSON.parse(tc.args || "{}"); } catch { /* keep empty */ }

            send({ type: "tool_call", name: tc.name, args });

            let result: string;
            if (tc.name === "navigate_superset_dashboard" || tc.name === "navigate_superset_chart") {
              // Navigation is handled client-side; just confirm
              result = `Navigation to ${tc.name === "navigate_superset_dashboard" ? "dashboard" : "chart"} ${Object.values(args)[0]} requested.`;
            } else {
              try {
                const raw = await callMcpTool(tc.name, args);
                result = typeof raw === "string" ? raw : JSON.stringify(raw);
              } catch (e) {
                result = `Error calling ${tc.name}: ${e instanceof Error ? e.message : String(e)}`;
              }
            }

            send({ type: "tool_result", name: tc.name, result });
            accumulated.push({
              role: "tool",
              tool_call_id: tc.id,
              content: result,
            });
          }
        }

        send({ type: "done" });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        send({ type: "error", message: msg });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson",
      "Cache-Control": "no-cache",
      "X-Accel-Buffering": "no",
    },
  });
};

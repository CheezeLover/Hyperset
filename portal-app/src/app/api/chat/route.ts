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
  "You are a helpful assistant that predicts what the user will ask next. " +
  "Generate questions phrased in the user's voice — as if the user is typing their next message to the assistant " +
  "(e.g. 'Can you show me a breakdown by year?', 'What does this trend mean?', 'Run a SQL query for the top 10 products.'). " +
  "Never phrase them as the assistant asking the user a question. " +
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

    const suggestionPrompt = `Based on the conversation history below, predict 3-4 questions the user is likely to ask next. Write each question in the user's voice, as if the user is typing their next message to the assistant (e.g. "Show me a chart for this", "What caused that spike?", "Can you filter by 2024?"). Do NOT write questions from the assistant's perspective. Respond only with a valid JSON array of strings, with no additional text.\n\nConversation history:\n${historyText}\n\nPredicted user questions (JSON array only):`;

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

SUPERSET CONTENT — CRITICAL RULES (violations break the UI):

RULE 1 — NEVER construct or hardcode Superset URLs. Always call the tool; it returns the real URL.

RULE 2 — DEFAULT IS EMBED. After creating a chart, always call superset_get_chart_embed and output the result as an embed (not a link), unless the user specifically asks for a link only.

RULE 3 — EMBED FORMAT: call superset_get_chart_embed → take the 'embed_markdown' string → output it EXACTLY as returned, on its own line, with NOTHING else on that line.
  Correct:   [iframe](https://real-url/...) Chart Title
  Wrong:     [Chart Title](https://real-url/...)   ← this is a link, not an embed
  Wrong:     - [iframe](https://real-url/...) ...  ← never put embed inside a list item
  Wrong:     \`[iframe](https://real-url/...)...\`  ← never wrap in backticks

RULE 4 — LINK FORMAT (only when user asks for a link): call superset_get_chart_link → paste 'link_markdown' verbatim inline in the sentence.

CHART CREATION — mandatory workflow (never skip steps):
1. Call superset_chart_types → read _rules first, then pick the exact viz_type and note its req/opt params.
2. Inspect the dataset columns (superset_dataset_get_by_id or a quick SQL query) to know real column names.
3. Build params from the chart catalog (metric_examples shape), then call superset_chart_create.
4. After creation succeeds, call superset_get_chart_embed (to show inline) or superset_get_chart_link (to link) — NEVER construct the URL yourself.
Rules:
- Follow all _rules from superset_chart_types before building params.
- Some charts use "metric" (single object); others use "metrics" (list) — follow req exactly.
- groupby items are plain column-name strings, not metric objects.
- Never invent a viz_type — only use values from superset_chart_types.`,
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

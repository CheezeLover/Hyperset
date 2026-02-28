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
    // Only use the last 4 messages for suggestion context — sending the full
    // history wastes tokens on a small-context model.
    const recentHistory = conversationHistory.slice(-2);
    const historyText = recentHistory
      .map((msg) => `${msg.role}: ${typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content)}`)
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

  // Strip nested property descriptions from a JSON schema to reduce token count.
  // Keeps type/properties/required/items so the model still knows the shape.
  function stripSchemaDescriptions(schema: Record<string, unknown>): Record<string, unknown> {
    if (!schema || typeof schema !== "object") return schema;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(schema)) {
      if (k === "description") continue; // drop nested descriptions
      if (k === "properties" && v && typeof v === "object") {
        const props: Record<string, unknown> = {};
        for (const [pk, pv] of Object.entries(v as Record<string, unknown>)) {
          props[pk] = stripSchemaDescriptions(pv as Record<string, unknown>);
        }
        out[k] = props;
      } else if (k === "items" && v && typeof v === "object") {
        out[k] = stripSchemaDescriptions(v as Record<string, unknown>);
      } else {
        out[k] = v;
      }
    }
    return out;
  }

  // Build the MCP tool definitions
  let mcpTools: OpenAI.Chat.ChatCompletionTool[] = [];
  try {
    const raw = await listMcpTools();
    mcpTools = raw.map((t) => ({
      type: "function" as const,
      function: {
        // Truncate top-level description to 120 chars — the name already conveys intent.
        name: t.name,
        description: t.description?.slice(0, 120),
        parameters: stripSchemaDescriptions(t.inputSchema as Record<string, unknown>),
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
        description: "Open a dashboard in the Superset panel.",
        parameters: {
          type: "object",
          properties: { dashboardId: { type: "string" } },
          required: ["dashboardId"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "navigate_superset_chart",
        description: "Open a chart in the Superset Explore panel.",
        parameters: {
          type: "object",
          properties: { chartId: { type: "string" } },
          required: ["chartId"],
        },
      },
    },
  ];

  const tools = [...navTools, ...mcpTools];

  // ── Intent-based tool filtering ───────────────────────────────────────────
  // Sending all 20+ tools on every turn overwhelms small models (Ministral,
  // Mistral, etc.) and wastes tokens on larger ones.  Analyse the last user
  // message and only include tools relevant to the current intent.
  // Core read / embed / navigate tools are always present.
  function filterToolsForContext(
    allTools: OpenAI.Chat.ChatCompletionTool[],
    userMsgs: OpenAI.Chat.ChatCompletionMessageParam[]
  ): OpenAI.Chat.ChatCompletionTool[] {
    const lastUser = [...userMsgs].reverse().find((m) => m.role === "user");
    const msg = (typeof lastUser?.content === "string" ? lastUser.content : "").toLowerCase();

    // Always-on: navigation + listing + embed/link (model always needs these)
    const include = new Set([
      "navigate_superset_dashboard",
      "navigate_superset_chart",
      "superset_dashboard_list",
      "superset_chart_list",
      "superset_dataset_list",
      "superset_database_list",
      "superset_get_chart_embed",
      "superset_get_dashboard_embed",
      "superset_get_chart_link",
      "superset_get_dashboard_link",
      "superset_analyze_data",
    ]);

    // Chart creation flow
    if (/creat|build|make|new chart|generat|visuali/.test(msg)) {
      include.add("superset_chart_types");
      include.add("superset_chart_create");
      include.add("superset_dataset_get_by_id");
    }

    // Chart / dashboard editing or deleting
    if (/updat|edit|modif|chang|delet|remov/.test(msg)) {
      include.add("superset_chart_update");
      include.add("superset_chart_delete");
      include.add("superset_chart_get_by_id");
      include.add("superset_dashboard_update");
      include.add("superset_dashboard_delete");
      include.add("superset_dashboard_get_by_id");
    }

    // Dashboard creation
    if (/new dashboard|creat.*dashboard|dashboard.*creat/.test(msg)) {
      include.add("superset_dashboard_create");
      include.add("superset_dashboard_get_by_id");
    }

    // SQL / data queries
    if (/sql|query|select|from |where |analyz|run.*query|execut/.test(msg)) {
      include.add("superset_sqllab_execute_query");
      include.add("superset_database_get_by_id");
      include.add("superset_dataset_get_by_id");
    }

    // Schema / column inspection
    if (/schema|column|field|dataset|table/.test(msg)) {
      include.add("superset_dataset_get_by_id");
      include.add("superset_database_get_by_id");
    }

    // User / config info
    if (/user|role|who am|config|base.?url/.test(msg)) {
      include.add("superset_user_get_current");
      include.add("superset_user_get_roles");
      include.add("superset_config_get_base_url");
    }

    return allTools.filter((t) => include.has(t.function.name));
  }

  // ── Ministral / Mistral model detection ──────────────────────────────────
  // Ministral (3B / 8B) handles sequential tool calls reliably but struggles
  // with parallel ones.  Disable parallel_tool_calls automatically.
  const isMistral = /ministral|mistral/i.test(model);
  const activeTools = filterToolsForContext(tools, userMessages);

  // Build message list with optional system prompt
  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    ...(systemPrompt
      ? [{ role: "system" as const, content: systemPrompt }]
      : [
          {
            role: "system" as const,
            content: `You are Hyperset, an AI assistant for Apache Superset. Use MCP tools for all data operations.

EMBED RULES (breaking these silently removes content from chat):
- NEVER hardcode or guess any URL. NEVER use "superset.example.com" or any placeholder domain.
- To embed a chart: call superset_get_chart_embed → the tool returns {"embed_markdown": "...", ...}.
  Copy ONLY the value of "embed_markdown" verbatim onto its own line. It is a [iframe](...) string with the real server URL — do NOT invent it. Do NOT wrap it in backticks, code fences, or any other formatting.
- To embed a dashboard: same with superset_get_dashboard_embed.
- For a clickable link: call superset_get_chart_link or superset_get_dashboard_link and paste the VALUE of "link_markdown" inline.

CHART CREATION — mandatory steps (superset_chart_create will reject bad columns server-side):
1. superset_chart_types → pick viz_type and note required params.
2. superset_dataset_get_by_id → read actual column names. ONLY use columns that appear in the response.
3. superset_chart_create (will return an error listing valid columns if any are wrong — fix and retry).
4. superset_get_chart_embed → paste embed_markdown value verbatim.
- groupby = plain strings. metric/metrics = objects (see metric_examples). Never invent a viz_type.
- METRICS — always prefer expressionType "SIMPLE" (column + aggregate). Only use expressionType "SQL" when SIMPLE cannot express the logic.
- CUSTOM SQL RULE: PostgreSQL folds unquoted identifiers to lowercase. Always double-quote every column name in custom SQL: SUM(CASE WHEN "DEPARTURE_DELAY" <= 15 THEN 1 ELSE 0 END). Never write bare uppercase column names in SQL strings.

NAVIGATION: use navigate_superset_dashboard or navigate_superset_chart when user asks to open one.

STYLE:
- Do NOT narrate steps or announce what you are about to do. Call tools silently.
- When all charts/tasks are done, write a meaningful narrative: explain what the data shows, highlight trends, anomalies, or comparisons. Give the user insights, not just a list of chart links.
- Structure multi-chart responses with a brief intro, per-chart insight (1-2 sentences each), and a closing takeaway.`,
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

  // Agentic loop: keep calling the model until it stops requesting tool calls.
  // 25 turns supports complex multi-chart tasks (each chart needs ~4 tool calls:
  // chart_types → dataset_get_by_id → chart_create → get_chart_embed).
  const MAX_TURNS = 40;
  // Max chars for a single tool result stored in history (prevents huge blobs from
  // consuming most of a small model's context window).
  const MAX_TOOL_RESULT_CHARS = 3000;
  // Max non-system messages kept in the sliding window sent to the model.
  // Keeps the system prompt + last N messages to bound context growth.
  const MAX_HISTORY_MESSAGES = 20;

  function windowedMessages(
    msgs: OpenAI.Chat.ChatCompletionMessageParam[]
  ): OpenAI.Chat.ChatCompletionMessageParam[] {
    const system = msgs.filter((m) => m.role === "system");
    const rest = msgs.filter((m) => m.role !== "system");
    const sliced = rest.slice(-MAX_HISTORY_MESSAGES);
    // Never start the window in the middle of a tool-call sequence.
    // An orphaned tool/assistant-tool_calls message (without its pair) causes
    // the API to error and kills the stream.  Advance to the first user message
    // so the window always starts at a clean conversation boundary.
    const firstUserIdx = sliced.findIndex((m) => m.role === "user");
    const trimmed = firstUserIdx > 0 ? sliced.slice(firstUserIdx) : sliced;
    return [...system, ...trimmed];
  }

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
            messages: windowedMessages(accumulated),
            tools: activeTools.length > 0 ? activeTools : undefined,
            tool_choice: activeTools.length > 0 ? "auto" : undefined,
            // Ministral/Mistral models handle sequential tool calls reliably
            // but trip up on parallel ones — disable them automatically.
            ...(isMistral ? { parallel_tool_calls: false } : {}),
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
            // Truncate stored result to avoid bloating the context window.
            const storedResult =
              result.length > MAX_TOOL_RESULT_CHARS
                ? result.slice(0, MAX_TOOL_RESULT_CHARS) +
                  `\n…[truncated ${result.length - MAX_TOOL_RESULT_CHARS} chars]`
                : result;
            accumulated.push({
              role: "tool",
              tool_call_id: tc.id,
              content: storedResult,
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

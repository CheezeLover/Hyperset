import { NextRequest, NextResponse } from "next/server";
import { listMcpTools, callMcpTool } from "@/lib/mcp-client";
import OpenAI from "openai";
import { getAdminSettings } from "@/lib/admin-settings";
import { getUserFromRequest } from "@/lib/auth";
import { DEFAULT_SYSTEM_PROMPT } from "@/lib/default-system-prompt";
import {
  getKnowledgeBaseRoutingContext,
  getKnowledgeDocuments,
  getKnowledgeBaseStats,
  searchKnowledgeBase,
  semanticSearch,
  getKnowledgeDocumentContent,
  DEFAULT_EMBEDDING_MODEL,
} from "@/lib/knowledge-base";

// ── Helper functions ───────────────────────────────────────────────────────
function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
}
const _rateLimitMap = new Map<string, number[]>();
const RATE_LIMIT      = 20;
const RATE_WINDOW_MS  = 60_000;

function checkRateLimit(email: string): boolean {
  const now = Date.now();
  const timestamps = _rateLimitMap.get(email) ?? [];
  const recent = timestamps.filter((t) => now - t < RATE_WINDOW_MS);
  if (recent.length >= RATE_LIMIT) {
    _rateLimitMap.set(email, recent);
    return false;
  }
  recent.push(now);
  _rateLimitMap.set(email, recent);
  return true;
}

// ── Message history normalisation ───────────────────────────────────────────
// ChatPanel strips tool_calls when building the history it sends to the server,
// leaving {role:"assistant", content:null} ghost messages that confuse the LLM.
// It also maps role:"tool" → role:"user", so consecutive user messages can appear
// when the last tool result from a prior turn is followed by a new user message.
function normalizeMessageRoles(
  msgs: OpenAI.Chat.ChatCompletionMessageParam[]
): OpenAI.Chat.ChatCompletionMessageParam[] {
  // 1. Remove empty assistant messages (no content, no tool_calls).
  const filtered = msgs.filter((m) => {
    if (m.role !== "assistant") return true;
    const hasContent = m.content !== null && m.content !== "" && m.content !== undefined;
    const tc = (m as { tool_calls?: unknown[] }).tool_calls;
    return hasContent || (Array.isArray(tc) && tc.length > 0);
  });

  // 2. Merge consecutive role:"user" messages.
  const result: OpenAI.Chat.ChatCompletionMessageParam[] = [];
  for (const msg of filtered) {
    const last = result[result.length - 1];
    if (msg.role === "user" && last?.role === "user") {
      const prev = typeof last.content === "string" ? last.content : JSON.stringify(last.content);
      const curr = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);
      result[result.length - 1] = { role: "user" as const, content: prev + "\n\n" + curr };
    } else {
      result.push(msg);
    }
  }
  return result;
}

// ── Allowed modelParams keys ────────────────────────────────────────────────
// Prevents arbitrary LLM provider options from being injected via admin config.
const ALLOWED_MODEL_PARAMS = new Set([
  "temperature", "top_p", "max_tokens", "frequency_penalty",
  "presence_penalty", "stop", "logit_bias", "n", "seed",
  "random_seed", "response_format",
]);

// ── GET: health / config check ───────────────────────────────────
export const GET = async (req: NextRequest) => {
  const s = await getAdminSettings();
  const apiKey = s?.apiKey ?? process.env.LLM_API_KEY ?? "";

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
  const requestUser = getUserFromRequest(req);
  if (!requestUser.email) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (!checkRateLimit(requestUser.email)) {
    return NextResponse.json({ error: "Rate limit exceeded. Please wait before sending more messages." }, { status: 429 });
  }

  const s = await getAdminSettings();
  const apiUrl      = s?.apiUrl       ?? process.env.LLM_API_URL       ?? "https://api.openai.com/v1";
  const apiKey      = s?.apiKey       ?? process.env.LLM_API_KEY       ?? "";
  const model       = s?.model        ?? process.env.LLM_MODEL        ?? "gpt-4o";
  const systemPrompt = s?.systemPrompt ?? process.env.LLM_SYSTEM_PROMPT ?? "";

  if (!apiKey) {
    return NextResponse.json({ error: "No API key configured" }, { status: 503 });
  }

  // Parse incoming messages from the client
  let body: { messages?: OpenAI.Chat.ChatCompletionMessageParam[]; currentSupersetUrl?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const userMessages: OpenAI.Chat.ChatCompletionMessageParam[] = body.messages ?? [];
  const currentSupersetUrl = typeof body.currentSupersetUrl === "string" ? body.currentSupersetUrl : undefined;

  // Input size validation — reject oversized payloads early
  if (userMessages.length > 100) {
    return NextResponse.json({ error: "Too many messages in history" }, { status: 400 });
  }
  const totalChars = userMessages.reduce((acc, m) => {
    const content = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
    return acc + content.length;
  }, 0);
  if (totalChars > 100_000) {
    return NextResponse.json({ error: "Message history is too large" }, { status: 400 });
  }

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

  // Knowledge base tools - allows LLM to explicitly query the knowledge base
  const knowledgeBaseTools: OpenAI.Chat.ChatCompletionTool[] = [
    {
      type: "function",
      function: {
        name: "knowledge_base_list",
        description: "List all documents in the company knowledge base with their descriptions and sizes. Use this to check what company-specific information is available.",
        parameters: {
          type: "object",
          properties: {},
        },
      },
    },
    {
      type: "function",
      function: {
        name: "knowledge_base_search",
        description: "Semantically search the company knowledge base. Returns the most relevant text passages matching the query by meaning — not just keywords. Use this for any company-specific question before answering from memory.",
        parameters: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description: "The question or topic to search for (e.g., 'Q3 revenue metrics', 'safety procedures for night operations')",
            },
          },
          required: ["query"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "knowledge_base_get",
        description: "Get the full content of a specific document by its ID. Use this after finding the document ID from knowledge_base_search or knowledge_base_list.",
        parameters: {
          type: "object",
          properties: {
            id: { 
              type: "string", 
              description: "The document ID (e.g., '01abc123')" 
            },
          },
          required: ["id"],
        },
      },
    },
  ];

  const tools = [...navTools, ...mcpTools, ...knowledgeBaseTools];

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

    // Always-on: navigation + listing + embed/link + knowledge base (model always needs these)
    // Knowledge base tools MUST be available for every request so they can be called FIRST
    const include = new Set([
      "navigate_superset_dashboard",
      "navigate_superset_chart",
      "knowledge_base_list",
      "knowledge_base_search",
      "knowledge_base_get",
      "superset_dashboard_list",
      "superset_chart_list",
      "superset_dataset_list",
      "superset_database_list",
      "superset_get_chart_embed",
      "superset_get_dashboard_embed",
      "superset_get_chart_link",
      "superset_get_dashboard_link",
    ]);

    // Chart creation flow
    if (/creat|build|make|new chart|generat|visuali/.test(msg)) {
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

    // Dashboard creation (also needs chart creation tools since charts are built first)
    if (/new dashboard|creat.*dashboard|dashboard.*creat|make.*dashboard|build.*dashboard/.test(msg)) {
      include.add("superset_chart_create");
      include.add("superset_dataset_get_by_id");
      include.add("superset_dashboard_create");
      include.add("superset_dashboard_get_by_id");
      include.add("superset_dashboard_update");
      include.add("superset_dashboard_add_charts"); // populates position_json after creation
      // ⛔ Remove per-chart embed tools during dashboard creation.
      // The LLM calling superset_get_chart_embed after each chart adds ~12 extra
      // messages for a 6-chart dashboard, pushing early chart_create results off
      // the context window.  The LLM then halluccinates wrong IDs when calling
      // superset_dashboard_add_charts.  Only the final dashboard embed is needed.
      include.delete("superset_get_chart_embed");
      include.delete("superset_get_chart_link");
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

  const routingContext = await getKnowledgeBaseRoutingContext();
  const kbStats = await getKnowledgeBaseStats();
  
  const knowledgeBaseSection = routingContext || kbStats.documentCount > 0
    ? `
---
## 📚 COMPANY KNOWLEDGE BASE — YOUR PRIMARY SOURCE OF TRUTH

**Status**: ${kbStats.documentCount} documents loaded (${kbStats.totalSizeFormatted} / ${kbStats.maxSizeFormatted} used)

The following documents are your **BIBLE** — your absolute, definitive, and only source of truth for company-specific information. You are FORBIDDEN from using your training data for any topic covered in these documents.

### ⛔ ABSOLUTE RULES (VIOLATION = WRONG ANSWER):
1. **KNOWLEDGE BASE IS LAW**: If the knowledge base contains information on a topic, you MUST use it exclusively. Your training data on that topic is INVALID and FORBIDDEN.

2. **CITE YOUR SOURCES**: Every fact, definition, metric, or procedure from the knowledge base MUST include the document name (e.g., "According to airline-metrics.md..." or "Per regulatory-compliance.md...").

3. **CONFLICT RESOLUTION**: If your training data contradicts the knowledge base, the knowledge base is CORRECT. Your training data is WRONG. Period.

4. **TRAINING DATA BAN**: For any topic covered in these documents, your internal knowledge is IRRELEVANT and PROHIBITED. You know NOTHING except what these documents tell you.

5. **UNKNOWN = SAY SO**: If the knowledge base doesn't cover a topic, explicitly state: "This topic is not covered in the company knowledge base." Do NOT fill gaps with training data.

### 📖 AVAILABLE DOCUMENTS:
${routingContext || "No documents configured."}

### 🔧 HOW TO USE KNOWLEDGE BASE (REQUIRED - Follow these exact steps):
1. **Use knowledge_base_search** with relevant keywords to find documents (e.g., "safety", "metrics", "policy")
2. **Use knowledge_base_list** to see all available documents if needed
3. **Use knowledge_base_get with the document ID** to fetch the FULL content of relevant documents
4. **READ the full document content** before answering - never answer from search results alone!
5. **Cite sources** with document name for every fact (e.g., "Per employee-handbook.md...")
6. If KB doesn't cover the topic, admit it — don't improvise

⚠️ **IMPORTANT**: You MUST call knowledge_base_get after finding a relevant document. The search results only show titles/descriptions - the actual content is in the document file!

### 🚫 FORBIDDEN:
- Using training data when KB has the answer
- Guessing, estimating, or "probably" when KB covers the topic
- Citing "industry standards" from memory when KB defines your standards
- Filling gaps with general knowledge when KB doesn't cover it
---
`
    : `
---
## 📚 COMPANY KNOWLEDGE BASE

**Status**: Knowledge base is empty. No company-specific documents have been uploaded yet.

Administrators can upload documents through the Admin Settings > Knowledge Base panel.
---
`;

  // Build message list with optional system prompt
  const baseSystemContent = systemPrompt
    ? systemPrompt
    : DEFAULT_SYSTEM_PROMPT;

  // Append current Superset page if known (sent by the browser on each request)
  const currentPageSection = currentSupersetUrl
    ? `\n\n---\nThe user currently has this Superset URL open: ${currentSupersetUrl}\n---`
    : "";

  // Prepend knowledge base section if available
  const fullSystemContent = baseSystemContent + knowledgeBaseSection + currentPageSection;

  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    { role: "system" as const, content: fullSystemContent },
    ...normalizeMessageRoles(userMessages),
  ];

  // Parse model parameters if provided — only allow keys in ALLOWED_MODEL_PARAMS
  // to prevent arbitrary provider options from being injected via admin config.
  let modelParams: Record<string, unknown> = {};
  try {
    if (s?.modelParams) {
      const parsed = JSON.parse(s.modelParams);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        for (const [k, v] of Object.entries(parsed)) {
          if (ALLOWED_MODEL_PARAMS.has(k)) {
            modelParams[k] = v;
          }
        }
      }
    }
  } catch (e) {
    console.error("Invalid JSON in modelParams:", e);
  }

  const openai = new OpenAI({ apiKey, baseURL: apiUrl });

  // Context-control constants — configurable by admin via the settings panel.
  // Env vars (LLM_MAX_TURNS etc.) serve as deployment-level defaults;
  // admin UI overrides take precedence when set.
  // chart_types → dataset_get_by_id → chart_create → get_chart_embed ≈ 4 turns/chart.
  const MAX_TURNS             = s?.maxTurns            ?? Number(process.env.LLM_MAX_TURNS             ?? 40);
  const MAX_TOOL_RESULT_CHARS = s?.maxToolResultChars  ?? Number(process.env.LLM_MAX_TOOL_RESULT_CHARS ?? 3000);
  // 40 messages (~20 tool call pairs) is enough for a 6-chart dashboard without rolling
  // off early chart IDs: analyze(2) + dataset(2) + 6×chart_create(12) + dashboard(2) + add_charts(2) = 20
  const MAX_HISTORY_MESSAGES  = s?.maxHistoryMessages  ?? Number(process.env.LLM_MAX_HISTORY_MESSAGES  ?? 40);

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
    if (firstUserIdx === -1) {
      // The window contains no user message — the current user turn is outside
      // the slice (happens when a long conversation + many in-flight tool calls
      // exceeds MAX_HISTORY_MESSAGES). Fall back to the most recent user message
      // in the full history so the API always receives a clean context.
      const lastUserInRest = [...rest].reduceRight<number>(
        (found, m, i) => (found === -1 && m.role === "user" ? i : found),
        -1,
      );
      if (lastUserInRest !== -1) return [...system, ...rest.slice(lastUserInRest)];
      return [...system, ...sliced];
    }
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
        let hitTurnLimit = true;
        for (let turn = 0; turn < MAX_TURNS; turn++) {
          const completion = await openai.chat.completions.create({
            model,
            messages: windowedMessages(accumulated),
            tools: activeTools.length > 0 ? activeTools : undefined,
            tool_choice: activeTools.length > 0 ? "auto" : undefined,
            // Ministral/Mistral models handle sequential tool calls reliably
            // but trip up on parallel ones — disable them automatically.
            ...(isMistral ? { parallel_tool_calls: false } : {}),
            // temperature: 0.05 → near-deterministic output.
            // Seed pins the RNG so identical queries produce identical tool calls.
            // Mistral uses "random_seed"; OpenAI-compatible providers use "seed".
            temperature: 0.05,
            ...(isMistral ? { random_seed: 42 } : { seed: 42 }),
            stream: true,
            ...modelParams, // Admin overrides (including temperature) take priority
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
            hitTurnLimit = false;
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
            } else if (tc.name === "knowledge_base_list") {
              // Knowledge base list tool - return the list of documents with stats
              try {
                const stats = await getKnowledgeBaseStats();
                const docs = await getKnowledgeDocuments();
                if (docs.length === 0) {
                  result = `Knowledge Base Status: Empty (${stats.documentCount} documents, ${stats.totalSizeFormatted} / ${stats.maxSizeFormatted} used)\n\nNo company-specific documents have been uploaded yet. Administrators can add documents through Admin Settings > Knowledge Base.`;
                } else {
                  const docList = docs.map(d => `- **${d.name}** (ID: ${d.id}, ${formatBytes(d.size)}): ${d.description || 'No description'}`).join('\n');
                  result = `Knowledge Base Status: ${stats.documentCount} documents, ${stats.totalSizeFormatted} / ${stats.maxSizeFormatted} used (${stats.utilizationPercent}%)\n\nAvailable documents:\n${docList}\n\nTo get document content, use knowledge_base_get with the document ID.`;
                }
              } catch (e) {
                result = `Error accessing knowledge base: ${e instanceof Error ? e.message : String(e)}`;
              }
            } else if (tc.name === "knowledge_base_search") {
              // Semantic RAG search with text-search fallback
              const searchQuery = args.query as string;
              if (!searchQuery) {
                result = "Error: No search query provided.";
              } else {
                try {
                  const embeddingConfig = {
                    // Empty apiUrl → use local ONNX model (no key needed).
                    // Do NOT fall back to chatApiUrl — that would force API mode.
                    apiUrl:  s?.embeddingApiUrl ?? process.env.LLM_EMBEDDING_API_URL ?? "",
                    apiKey:  process.env.LLM_EMBEDDING_API_KEY ?? apiKey,
                    embeddingModel: s?.embeddingModel ?? process.env.LLM_EMBEDDING_MODEL ?? DEFAULT_EMBEDDING_MODEL,
                  };
                  const chunks = await semanticSearch(searchQuery, 6, embeddingConfig);

                  if (chunks.length === 0) {
                    // No vector chunks yet — fall back to text search on name/description
                    const textMatches = await searchKnowledgeBase(searchQuery);
                    if (textMatches.length === 0) {
                      result = `No relevant content found for "${searchQuery}". The knowledge base may not cover this topic.`;
                    } else {
                      const docList = textMatches
                        .map((m) => `- **${m.doc.name}** (ID: ${m.doc.id}): ${m.doc.description || "No description"}`)
                        .join("\n");
                      result = `Found documents related to "${searchQuery}" (text match — semantic index not yet built):\n${docList}\n\nUse knowledge_base_get with the document ID to read full content.`;
                    }
                  } else {
                    // Group chunks by source document, preserving relevance order
                    const seen = new Map<string, { name: string; contents: string[] }>();
                    for (const chunk of chunks) {
                      if (!seen.has(chunk.docId)) seen.set(chunk.docId, { name: chunk.docName, contents: [] });
                      seen.get(chunk.docId)!.contents.push(chunk.content);
                    }
                    const sections = [...seen.values()].map(({ name, contents }) =>
                      `### Source: ${name}\n\n${contents.join("\n\n---\n\n")}`
                    );
                    result = `Relevant knowledge base content for "${searchQuery}":\n\n${sections.join("\n\n---\n\n")}`;
                  }
                } catch (embErr) {
                  // Embedding API unavailable — graceful text search fallback
                  console.error("[chat] Semantic search failed, falling back to text search:", embErr);
                  try {
                    const textMatches = await searchKnowledgeBase(searchQuery);
                    if (textMatches.length === 0) {
                      result = `No documents found matching "${searchQuery}".`;
                    } else {
                      const docList = textMatches
                        .map((m) => `- **${m.doc.name}** (ID: ${m.doc.id}): ${m.doc.description || "No description"}`)
                        .join("\n");
                      result = `Found documents (text search) for "${searchQuery}":\n${docList}\n\nUse knowledge_base_get with the document ID to read full content.`;
                    }
                  } catch (e) {
                    result = `Error searching knowledge base: ${e instanceof Error ? e.message : String(e)}`;
                  }
                }
              }
            } else if (tc.name === "knowledge_base_get") {
              // Get full document content by ID
              try {
                const docId = args.id as string;
                if (!docId) {
                  result = "Error: No document ID provided.";
                } else {
                  const content = await getKnowledgeDocumentContent(docId);
                  if (!content) {
                    result = `Document not found: ${docId}`;
                  } else {
                    const doc = (await getKnowledgeDocuments()).find(d => d.id === docId);
                    result = `--- ${doc?.name || docId} ---\n\n${content}`;
                  }
                }
              } catch (e) {
                result = `Error: ${e instanceof Error ? e.message : String(e)}`;
              }
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

        // If the turn limit was hit the model was cut off mid-task.
        // Make one final tool-free call so it can summarise what was done
        // and tell the user what still needs to happen.
        if (hitTurnLimit) {
          try {
            const wrapUpCompletion = await openai.chat.completions.create({
              model,
              messages: [
                ...windowedMessages(accumulated),
                {
                  role: "user" as const,
                  content:
                    "You have reached the maximum number of tool calls allowed per response. " +
                    "Do NOT call any more tools. " +
                    "Write a short summary of what was accomplished so far, " +
                    "then clearly list any steps that still need to be done so the user can ask you to continue.",
                },
              ],
              // No tools — force a plain text wrap-up
              stream: true,
            });
            send({ type: "delta", content: "\n\n---\n" });
            let wrapUpText = "";
            for await (const chunk of wrapUpCompletion) {
              const delta = chunk.choices[0]?.delta;
              if (delta?.content) {
                wrapUpText += delta.content;
                send({ type: "delta", content: delta.content });
              }
            }
            // Offer follow-up suggestions based on what remains
            if (wrapUpText) {
              try {
                const suggestions = await generateFollowupSuggestions(
                  openai, model,
                  [...accumulated, { role: "assistant" as const, content: wrapUpText }],
                );
                if (suggestions.length > 0) send({ type: "followup_suggestions", suggestions });
              } catch { /* non-fatal */ }
            }
          } catch (wrapErr) {
            // If the wrap-up call itself fails, at least inform the user
            send({
              type: "delta",
              content: "\n\n⚠️ The task reached the tool call limit and could not be completed in one response. Please ask me to continue.",
            });
          }
        }

        send({ type: "done" });
      } catch (err) {
        console.error("[chat] Stream error:", err);
        send({ type: "error", message: "An internal error occurred. Please try again." });
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

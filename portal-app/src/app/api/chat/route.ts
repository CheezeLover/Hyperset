import { NextRequest, NextResponse } from "next/server";
import { listMcpTools, callMcpTool } from "@/lib/mcp-client";
import OpenAI from "openai";
import { getAdminSettings } from "@/lib/admin-settings";
import { getUserFromRequest } from "@/lib/auth";
import { 
  getKnowledgeBaseContext, 
  getKnowledgeDocuments,
  getKnowledgeBaseStats,
  searchKnowledgeBase
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

// ── Allowed modelParams keys ────────────────────────────────────────────────
// Prevents arbitrary LLM provider options from being injected via admin config.
const ALLOWED_MODEL_PARAMS = new Set([
  "temperature", "top_p", "max_tokens", "frequency_penalty",
  "presence_penalty", "stop", "logit_bias", "n", "seed",
  "random_seed", "response_format",
]);

// ── GET: health / config check ───────────────────────────────────
export const GET = async (req: NextRequest) => {
  const s = getAdminSettings();
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

  const s = getAdminSettings();
  const apiUrl      = s?.apiUrl       ?? process.env.LLM_API_URL       ?? "https://api.openai.com/v1";
  const apiKey      = s?.apiKey       ?? process.env.LLM_API_KEY       ?? "";
  const model       = s?.model        ?? process.env.LLM_MODEL        ?? "gpt-4o";
  const systemPrompt = s?.systemPrompt ?? process.env.LLM_SYSTEM_PROMPT ?? "";

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
        description: "Search for documents by name or description. Provide keywords to find relevant documents. Returns matching document names.",
        parameters: {
          type: "object",
          properties: {
            query: { 
              type: "string", 
              description: "Search keywords (e.g., 'safety', 'metrics', 'procedures')" 
            },
          },
          required: ["query"],
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

  // Load pre-computed knowledge base context (FAST - no CPU scoring)
  const knowledgeBaseContent = getKnowledgeBaseContext();
  const kbStats = getKnowledgeBaseStats();
  
  const knowledgeBaseSection = knowledgeBaseContent
    ? `
---
## 📚 COMPANY KNOWLEDGE BASE — READ THIS FIRST

**Status**: ${kbStats.documentCount} documents loaded (${kbStats.totalSizeFormatted} / ${kbStats.maxSizeFormatted} used)

The following documents contain company-specific information, vocabulary, procedures, and domain expertise. You MUST actively reference this knowledge when answering questions.

### When to Use Knowledge Base:
- User asks about company procedures, terminology, or policies
- User uses industry-specific jargon or abbreviations you don't recognize
- Questions about operational metrics, KPIs, or benchmarks
- Regulatory, compliance, or safety questions
- Any request requiring company-specific context

### How to Use Knowledge Base:
1. Check if the knowledge base contains relevant information
2. Reference specific sections when appropriate
3. Use company terminology and definitions consistently
4. If knowledge base contradicts your training data, prioritize the knowledge base
5. Always cite the specific document name when using information from it
6. Use the knowledge_base_list tool to see all available documents

${knowledgeBaseContent}
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
    : `# Hyperset — Data Analyst Assistant (Apache Superset)
You are Hyperset, a SQL-grounded data analyst with access to Apache Superset. Execute immediately — never ask for confirmation before running queries or creating charts.

---
## ⚠️ ABSOLUTE RULE — ALL FACTS MUST COME FROM SQL QUERIES
This rule overrides everything else in this prompt.

**You are PROHIBITED from stating any number, value, percentage, count, average, ranking, trend, or factual assertion about data unless it appears verbatim in a \`superset_sqllab_execute_query\` result from the current conversation.**

This includes — but is not limited to:
- Row counts, totals, averages, min/max, percentages
- Rankings ("X is the top…", "Y has the most…")
- Comparisons ("A is higher than B", "grew by X%")
- Trends ("increasing", "declining", "stable")
- Any claim that sounds factual about the dataset

**Your training knowledge about the world is IRRELEVANT and FORBIDDEN as a data source.** You do not know what is in the user's database. You have never seen their data. Every claim must be proven by a query.

**Self-check before writing your response:** For every sentence that contains a number or assertion — can you point to the exact query result row that proves it? If not, run the query first. No exceptions.

If a query fails or returns no data, say so. Do not fill the gap with estimates or general knowledge.

---
## 📊 WHEN USERS ASK ABOUT DATA
1. **Understand the data** — call \`superset_analyze_data\` to identify available databases, datasets, and columns.
2. **Run the query immediately** — call \`superset_sqllab_execute_query\`. Do NOT ask first.
3. **Present results** — copy numbers verbatim from the query output. Do not round, estimate, reinterpret, or add context from training knowledge. If additional numbers are needed to answer the question, run additional queries.
4. **Show methodology** (if relevant) — always use this exact block, copy-pasted verbatim. Never change the summary text or emoji. No formatting inside \`<summary>\` — plain text only:

<details>
<summary>🔎 How we got this</summary>
Plain English explanation of the approach, then the SQL code block.
</details>

---
## 📈 WHEN USERS WANT CHARTS OR DASHBOARDS
Follow this workflow **in order — do not skip steps**:

### Step 1 — Understand the data
Call \`superset_analyze_data\` → identify datasets, columns, and data types.

### Step 2 — Validate chart types (MANDATORY)
Call \`superset_chart_types\` → get the exact list of supported viz_types and their required params.
**NEVER invent a viz_type.** Use only strings returned by this tool.

**Common chart types:**
- \`echarts_timeseries_line\` — trends over time
- \`echarts_timeseries_bar\` — time series OR categorical bar charts (versatile — works for both)
- \`echarts_area\` — volume / stacked areas over time
- \`echarts_timeseries_scatter\` — scatter / correlation
- \`table\` — detailed data view
- \`pivot_table_v2\` — multi-dimensional aggregations
- \`big_number\` — single KPI
- \`big_number_total\` — KPI with trend sparkline
- \`pie\` — proportions (max 7 slices)

For **categorical bar charts** (e.g. "sales by category"): use \`echarts_timeseries_bar\` with \`x_axis\` set to the category column and no \`time_grain_sqla\`.

### Step 3 — Get real column names (MANDATORY)
Call \`superset_dataset_get_by_id\` → read the exact column names. **Only use columns that appear in the response.** Never invent column names.

### Step 4 — Build params correctly

**groupby / columns** = plain strings.
**metric / metrics** = adhoc metric objects — never plain strings.

✅ **CORRECT metric format:**
\`\`\`json
{ "expressionType": "SIMPLE", "column": {"column_name": "amount"}, "aggregate": "SUM", "label": "Total Amount" }
{ "expressionType": "SQL", "sqlExpression": "COUNT(*)", "label": "Count" }
\`\`\`
❌ **WRONG (will be rejected):**
\`\`\`json
"COUNT(*)"
\`\`\`

**Valid expressionType values:** \`"SIMPLE"\` (prefer this), \`"SQL"\` (custom expressions only), \`"SAVED"\`.

**Common metrics:**
- Count rows: \`{"expressionType": "SQL", "sqlExpression": "COUNT(*)", "label": "Count"}\`
- Sum: \`{"expressionType": "SIMPLE", "column": {"column_name": "col"}, "aggregate": "SUM", "label": "Total"}\`
- Average: \`{"expressionType": "SIMPLE", "column": {"column_name": "col"}, "aggregate": "AVG", "label": "Avg"}\`
- Count distinct: \`{"expressionType": "SIMPLE", "column": {"column_name": "col"}, "aggregate": "COUNT_DISTINCT", "label": "Unique"}\`

**DUPLICATE LABEL RULE:** NEVER include the \`x_axis\` column in \`groupby\` or \`columns\` — Superset adds it automatically and will error.

**PostgreSQL SQL rule:** Always double-quote column names in SQL expressions: \`SUM(CASE WHEN "DEPARTURE_DELAY" <= 15 THEN 1 ELSE 0 END)\` — never bare uppercase identifiers.

### Step 5 — Create the chart
Call \`superset_chart_create\`. It validates params server-side and returns a clear error if anything is wrong — fix and retry.

### Step 6 — Embed the chart
Call \`superset_get_chart_embed\` → the response contains \`{"embed_markdown": "[iframe](...)", ...}\`.
Copy **only the value** of \`embed_markdown\` verbatim onto its own line. Do NOT wrap it in backticks or code fences. Do NOT invent any URL.

For a **clickable link only**: call \`superset_get_chart_link\` and paste the value of \`"link_markdown"\` inline.
For a **dashboard embed**: use \`superset_get_dashboard_embed\` the same way.

---
## 🧭 NAVIGATION
Use \`navigate_superset_dashboard\` or \`navigate_superset_chart\` when the user asks to open or go to something.

---
## 🎨 STYLE
- **Zero narration between tool calls.** Output NO text while working — not a single word. The user sees a live tool progress indicator; any text you add mid-task is noise.
  - ❌ "I'll now query the database…" ❌ "Let me correct the column names…" ❌ "It seems there was an issue…" ❌ "Let me re-run the query…"
  - ✅ Call the next tool immediately. If something fails, fix it and retry — silently.
- **After all tools complete**, write your response:
  - Data answers: lead with the key finding, then a table or list, then \`<details>\` methodology if relevant. **Before writing, verify: every number and assertion in your response must trace back to a specific cell in a query result. If it does not, run the query first.**
  - Chart responses: embed the chart(s), then a 1–2 sentence insight drawn strictly from the query results. Do not editorialize with industry context, benchmarks, or general knowledge.
- **Multi-chart responses:** brief intro → one query-grounded insight per chart → closing takeaway.
- Use emojis, tables, bold text, and headers to make results visually clear. Ensure every markdown element is on its own line with proper spacing.

---
## 🚫 NEVER DO
- ❌ **State any number, percentage, count, average, ranking, trend, or data assertion without a query result from this session proving it** — this is the most important rule
- ❌ Use training knowledge as a data source under any circumstances — you do not know what is in the user's database
- ❌ Write "typically", "usually", "generally", "on average" or similar hedges to sneak in training-data estimates
- ❌ Round, approximate, or paraphrase a value that was not explicitly returned by a query
- ❌ Assume a query result implies something it does not directly state — if it's not in the output, query for it
- ❌ Ask "Would you like me to run this?" — just run it
- ❌ Use a viz_type not returned by \`superset_chart_types\` (no \`bar\`, \`line\`, \`dist_bar\`, etc.)
- ❌ Use plain string metrics like \`["COUNT(*)"]\` — always use adhoc objects
- ❌ Use \`"CUSTOM"\` as expressionType — valid values are \`"SIMPLE"\`, \`"SQL"\`, \`"SAVED"\`
- ❌ Put the x_axis column in groupby or columns (duplicate label error)
- ❌ Invent column names — only use what \`superset_dataset_get_by_id\` returns
- ❌ Hardcode or guess any URL — always get embeds from the tool response
- ❌ Wrap \`[iframe]\` embeds in backticks or code fences
- ❌ Create dashboards before creating the charts that go in them`;

  // Prepend knowledge base section if available
  const fullSystemContent = baseSystemContent + knowledgeBaseSection;

  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    { role: "system" as const, content: fullSystemContent },
    ...userMessages,
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
  const MAX_HISTORY_MESSAGES  = s?.maxHistoryMessages  ?? Number(process.env.LLM_MAX_HISTORY_MESSAGES  ?? 20);

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
                const stats = getKnowledgeBaseStats();
                const docs = getKnowledgeDocuments();
                if (docs.length === 0) {
                  result = `Knowledge Base Status: Empty (${stats.documentCount} documents, ${stats.totalSizeFormatted} / ${stats.maxSizeFormatted} used)\n\nNo company-specific documents have been uploaded yet. Administrators can add documents through Admin Settings > Knowledge Base.`;
                } else {
                  const docList = docs.map(d => `- **${d.name}** (${formatBytes(d.size)}${d.chunks ? `, ${d.chunks} chunks` : ''}): ${d.description || 'No description'}`).join('\n');
                  result = `Knowledge Base Status: ${stats.documentCount} documents, ${stats.totalSizeFormatted} / ${stats.maxSizeFormatted} used (${stats.utilizationPercent}%)\n\nAvailable documents:\n${docList}\n\nTo search for specific content, use the knowledge_base_search tool with relevant keywords.`;
                }
              } catch (e) {
                result = `Error accessing knowledge base: ${e instanceof Error ? e.message : String(e)}`;
              }
            } else if (tc.name === "knowledge_base_search") {
              // Knowledge base search - simple name/description only
              try {
                const searchQuery = args.query as string;
                if (!searchQuery) {
                  result = "Error: No search query provided.";
                } else {
                  const matches = searchKnowledgeBase(searchQuery);
                  if (matches.length === 0) {
                    result = `No documents found matching "${searchQuery}".`;
                  } else {
                    const docList = matches.map(m => `- ${m.doc.name}: ${m.doc.description || 'No description'}`).join('\n');
                    result = `Found ${matches.length} document(s) matching "${searchQuery}":\n${docList}`;
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

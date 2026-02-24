/**
 * Lightweight MCP client that talks to the Superset MCP server via plain
 * JSON-RPC POST requests, bypassing the TypeScript SDK's StreamableHTTP
 * transport.  The SDK transport opens a GET /mcp SSE stream on connect()
 * which the server (running stateless_http=True) returns 406 on, causing
 * connect() to throw and leaving the CopilotKit widget permanently greyed.
 *
 * The MCP Streamable HTTP spec says every request can be a standalone POST,
 * so we skip the persistent session entirely — fire one POST for
 * tools/list and one POST per tool call.
 */

const MCP_URL =
  process.env.SUPERSET_MCP_URL ?? "http://hyperset-superset-mcp:8000/mcp";

// Required by the MCP Streamable HTTP spec
const MCP_HEADERS = {
  "Content-Type": "application/json",
  Accept: "application/json, text/event-stream",
};

let _cachedToken: string | null = null;
let _tokenExpiry: number = 0;

async function getAuthHeaders(): Promise<Record<string, string>> {
  // Si nous avons un token valide en cache, le réutiliser
  if (_cachedToken && Date.now() < _tokenExpiry) {
    return {
      ...MCP_HEADERS,
      Authorization: `Bearer ${_cachedToken}`,
    };
  }

  // Sinon, créer un nouveau token
  try {
    const { getUserFromHeaders } = await import("./auth");
    const { createMcpToken } = await import("./mcp-auth");
    
    const user = await getUserFromHeaders();
    const token = createMcpToken(user.username, user.email, user.roles);
    
    // Mettre en cache le token pour 50 secondes (il expire en 60s)
    _cachedToken = token;
    _tokenExpiry = Date.now() + 50_000;
    
    return {
      ...MCP_HEADERS,
      Authorization: `Bearer ${token}`,
    };
  } catch (error) {
    console.error("[mcp-client] Failed to create auth token:", error);
    // Retourner les headers de base sans authentification
    return MCP_HEADERS;
  }
}

let _requestId = 1;
function nextId() {
  return _requestId++;
}

async function mcpPost(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: nextId(),
    method,
    params,
  });

  const authHeaders = await getAuthHeaders();
  
  const res = await fetch(MCP_URL, {
    method: "POST",
    headers: authHeaders,
    body,
  });

  if (!res.ok) {
    throw new Error(`MCP POST ${method} failed: HTTP ${res.status}`);
  }

  // The server may reply with application/json or text/event-stream.
  // In stateless mode it always returns application/json.
  const contentType = res.headers.get("content-type") ?? "";
  if (contentType.includes("text/event-stream")) {
    // Parse the first data: line from the SSE stream
    const text = await res.text();
    const dataLine = text.split("\n").find((l) => l.startsWith("data:"));
    if (!dataLine) throw new Error("MCP SSE response contained no data line");
    const json = JSON.parse(dataLine.slice(5).trim());
    if (json.error) throw new Error(`MCP error: ${JSON.stringify(json.error)}`);
    return json.result;
  }

  const json = await res.json();
  if (json.error) throw new Error(`MCP error: ${JSON.stringify(json.error)}`);
  return json.result;
}

export interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export async function listMcpTools(): Promise<McpTool[]> {
  try {
    const result = await mcpPost("tools/list") as { tools: Array<{ name: string; description?: string; inputSchema: unknown }> };
    return (result.tools ?? []).map((t) => ({
      name: t.name,
      description: t.description ?? "",
      inputSchema: t.inputSchema as Record<string, unknown>,
    }));
  } catch (err) {
    console.error("[mcp-client] listTools failed:", err);
    return [];
  }
}

export async function callMcpTool(
  name: string,
  args: Record<string, unknown>
): Promise<string> {
  try {
    const result = await mcpPost("tools/call", { name, arguments: args }) as {
      content?: Array<{ type: string; text?: string }>;
    };
    const content = result.content;
    if (Array.isArray(content)) {
      return content
        .map((c) => (c.type === "text" ? (c.text ?? "") : JSON.stringify(c)))
        .join("\n");
    }
    return JSON.stringify(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return `Error calling tool ${name}: ${message}`;
  }
}

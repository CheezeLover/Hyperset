import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const MCP_URL =
  process.env.SUPERSET_MCP_URL ?? "http://hyperset-superset-mcp:8000/mcp";

let _client: Client | null = null;

async function getMcpClient(): Promise<Client> {
  if (_client) return _client;

  const transport = new StreamableHTTPClientTransport(new URL(MCP_URL));
  const client = new Client({ name: "hyperset-portal", version: "1.0.0" });
  await client.connect(transport);
  _client = client;
  return client;
}

export interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export async function listMcpTools(): Promise<McpTool[]> {
  try {
    const client = await getMcpClient();
    const result = await client.listTools();
    return result.tools.map((t) => ({
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
    const client = await getMcpClient();
    const result = await client.callTool({ name, arguments: args });
    const content = result.content;
    if (Array.isArray(content)) {
      return content
        .map((c) => (c.type === "text" ? c.text : JSON.stringify(c)))
        .join("\n");
    }
    return JSON.stringify(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return `Error calling tool ${name}: ${message}`;
  }
}

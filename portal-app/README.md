# Hyperset Portal

The Next.js frontend for Hyperset. Provides the main UI, the AI chat interface, Superset iframe embedding, and the admin settings panel.

---

## Stack

- **Next.js 16** (App Router, TypeScript)
- **iron-session** for encrypted session cookies
- **OpenAI SDK** for LLM streaming

---

## Development

```bash
cd portal-app
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

When running locally without Caddy, all auth headers are absent — the portal treats this as admin access (direct access mode). The MCP server must also be running locally, or set `SUPERSET_MCP_URL` to point to a remote instance.

---

## Environment Variables

Copy the root `.env` and ensure these are available to the Next.js process. In production they are injected by `podman-compose`; in local dev create a `.env.local` file in this directory.

| Variable | Default | Description |
|----------|---------|-------------|
| `HYPERSET_DOMAIN` | `hyperset.internal` | Base domain. Used to derive Superset and Pages URLs when the explicit URL vars are not set. |
| `SUPERSET_PUBLIC_URL` | `https://superset.{HYPERSET_DOMAIN}` | Browser-accessible Superset URL. Returned to the frontend for iframe embedding. |
| `PAGES_PUBLIC_URL` | `https://pages.{HYPERSET_DOMAIN}` | Browser-accessible Pages service URL. |
| `SESSION_SECRET` | _(required)_ | Min-32-char secret for iron-session encryption. |
| `MCP_SERVICE_SECRET` | _(required)_ | Min-32-char HMAC secret shared with the MCP server for token signing. |
| `SUPERSET_MCP_URL` | `http://hyperset-superset-mcp:8000/mcp` | Internal URL of the MCP server. Override in local dev: `http://localhost:8000/mcp`. |
| `LLM_API_URL` | `https://api.openai.com/v1` | OpenAI-compatible LLM API base URL. |
| `LLM_API_KEY` | _(required)_ | API key for the LLM provider. |
| `LLM_MODEL` | `gpt-4o` | Default model. |
| `LLM_SYSTEM_PROMPT` | _(built-in)_ | Override the default AI system prompt. |
| `LLM_MAX_TURNS` | `40` | Max agentic turns per message. Range: 1–200. |
| `LLM_MAX_TOOL_RESULT_CHARS` | `3000` | Max characters per MCP tool result. Range: 500–50000. |
| `LLM_MAX_HISTORY_MESSAGES` | `20` | Max history messages sent to the LLM. Range: 4–200. |
| `HYPERSET_CLEANUP_DELAY_MINUTES` | `120` | Default AI chart cleanup delay in minutes. Range: 1–10080. |
| `PORTAL_DATABASE_URL` | `postgresql://portal:…@hyperset-superset-db:5432/superset` | Connection string for the portal role. Admin settings, pages config, and knowledge base are stored here. |
| `PORTAL_SETUP_DATABASE_URL` | _(set in compose)_ | Admin connection string used once on first boot to provision the `vector` extension, `portal` role, and `portal` schema. Omit on cloud providers where provisioning is done externally. |

All LLM settings can be overridden at runtime by admins via the gear icon in the chat UI without restarting the server. Runtime values take priority over environment variables.

---

## API Routes

| Method | Route | Description |
|--------|-------|-------------|
| `GET` | `/api/config` | Public config: Superset URL, Pages URL, current user info |
| `GET` | `/api/chat` | Health check, MCP reachability probe |
| `POST` | `/api/chat` | Streaming chat completion with MCP tool calls |
| `GET` | `/api/admin` | Effective LLM settings (admin only) |
| `POST` | `/api/admin` | Save runtime LLM settings (admin only) |
| `DELETE` | `/api/admin` | Reset to env defaults (admin only) |
| `PATCH` | `/api/admin` | Validate LLM API credentials (admin only) |
| `GET` | `/api/cleanup-config` | Cleanup delay in minutes (consumed by MCP server) |
| `POST` | `/api/chart-promote` | Promote an AI temporary chart to permanent |
| `GET` | `/api/auth/logout` | Clear session and redirect to auth portal |

---

## Build

```bash
npm run build
npm start
```

In production the app is containerised — see the root `podman-compose.yml`.

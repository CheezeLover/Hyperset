import { getIronSession, IronSession } from "iron-session";
import { cookies } from "next/headers";
import { NextRequest, NextResponse } from "next/server";

export interface LlmSettings {
  apiUrl?: string;
  apiKey?: string;
  model?: string;
  /** System prompt prepended to every conversation */
  systemPrompt?: string;
  /** Additional model parameters as JSON string */
  modelParams?: string;

  // ── Chat context controls ────────────────────────────────────────
  /** Max agentic tool-call turns per response (default: 40) */
  maxTurns?: number;
  /** Max characters stored per tool result in history (default: 3000) */
  maxToolResultChars?: number;
  /** Max non-system messages kept in the sliding context window (default: 20) */
  maxHistoryMessages?: number;

  // ── AI chart cleanup ─────────────────────────────────────────────
  /** Minutes before a [HYPERSET-AI-TEMPORARY] chart is auto-deleted (default: 120) */
  cleanupDelayMinutes?: number;

  // ── Knowledge base RAG ───────────────────────────────────────────
  /** Embedding model for knowledge base RAG (default: text-embedding-3-small) */
  embeddingModel?: string;
  /** Separate API URL for embeddings — falls back to apiUrl if unset */
  embeddingApiUrl?: string;
  /** Separate API key for embeddings — falls back to apiKey if unset */
  embeddingApiKey?: string;
}

export interface SessionData {
  /** Runtime override for the LLM API (set by admin, applies to all users) */
  llmSettings?: LlmSettings;
}

const _rawSecret = process.env.SESSION_SECRET ?? "";
if (
  !_rawSecret ||
  _rawSecret.length < 32 ||
  _rawSecret.startsWith("change-me")
) {
  throw new Error(
    "SESSION_SECRET env var is missing, too short (< 32 chars), or still set to " +
    "the default placeholder. Generate a value with: openssl rand -base64 32"
  );
}

const sessionOptions = {
  cookieName: "hyperset_session",
  password: _rawSecret,
  cookieOptions: {
    secure: process.env.NODE_ENV === "production",
    httpOnly: true,
    sameSite: "strict" as const,
    maxAge: 86400, // 24h
  },
};

export async function getSession(): Promise<IronSession<SessionData>> {
  const cookieStore = await cookies();
  return getIronSession<SessionData>(cookieStore, sessionOptions);
}

export async function getSessionFromRequest(
  req: NextRequest,
  res: NextResponse
): Promise<IronSession<SessionData>> {
  return getIronSession<SessionData>(req, res, sessionOptions);
}

import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/auth";
import OpenAI from "openai";
import {
  getAdminSettings,
  setAdminSettings,
  clearAdminSettings,
} from "@/lib/admin-settings";

function requireAdmin(request: NextRequest) {
  const user = getUserFromRequest(request);
  if (!user.isAdmin) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  return null;
}

/** GET /api/admin — return current effective LLM settings */
export async function GET(request: NextRequest) {
  const denied = requireAdmin(request);
  if (denied) return denied;

  const s = getAdminSettings();

  return NextResponse.json({
    apiUrl:              s?.apiUrl              ?? process.env.LLM_API_URL       ?? "",
    apiKey:              s?.apiKey              ? "***" : "",
    model:               s?.model               ?? process.env.LLM_MODEL        ?? "gpt-4o",
    systemPrompt:        s?.systemPrompt        ?? process.env.LLM_SYSTEM_PROMPT ?? "",
    modelParams:         s?.modelParams         ?? "",
    maxTurns:            s?.maxTurns            ?? Number(process.env.LLM_MAX_TURNS           ?? 40),
    maxToolResultChars:  s?.maxToolResultChars  ?? Number(process.env.LLM_MAX_TOOL_RESULT_CHARS ?? 3000),
    maxHistoryMessages:  s?.maxHistoryMessages  ?? Number(process.env.LLM_MAX_HISTORY_MESSAGES ?? 20),
    cleanupDelayHours:   s?.cleanupDelayHours   ?? Number(process.env.HYPERSET_CLEANUP_DELAY_HOURS ?? 2),
    isCustom: !!(s?.apiUrl || s?.apiKey || s?.model || s?.systemPrompt || s?.modelParams),
  });
}

/** POST /api/admin — save LLM settings (admin-only, applies to ALL users) */
export async function POST(request: NextRequest) {
  const denied = requireAdmin(request);
  if (denied) return denied;

  const body = await request.json();
  const prev = getAdminSettings() ?? {};

  const clamp = (v: unknown, min: number, max: number, fallback: number): number => {
    const n = Number(v);
    if (!isFinite(n)) return fallback;
    return Math.max(min, Math.min(max, Math.round(n)));
  };

  // Round cleanupDelayHours to nearest 0.5, clamp to [0.5, 168]
  const clampHours = (v: unknown, fallback: number): number => {
    const n = Number(v);
    if (!isFinite(n)) return fallback;
    return Math.max(0.5, Math.min(168, Math.round(n * 2) / 2));
  };

  setAdminSettings({
    apiUrl:             body.apiUrl             !== undefined ? body.apiUrl             : prev.apiUrl,
    apiKey:             body.apiKey && body.apiKey !== "***" ? body.apiKey              : prev.apiKey,
    model:              body.model              !== undefined ? body.model              : prev.model,
    systemPrompt:       body.systemPrompt       !== undefined ? body.systemPrompt       : prev.systemPrompt,
    modelParams:        body.modelParams        !== undefined ? body.modelParams        : prev.modelParams,
    maxTurns:           body.maxTurns           !== undefined ? clamp(body.maxTurns,          1, 200,   40) : prev.maxTurns,
    maxToolResultChars: body.maxToolResultChars !== undefined ? clamp(body.maxToolResultChars, 500, 50000, 3000) : prev.maxToolResultChars,
    maxHistoryMessages: body.maxHistoryMessages !== undefined ? clamp(body.maxHistoryMessages, 4, 200,   20) : prev.maxHistoryMessages,
    cleanupDelayHours:  body.cleanupDelayHours  !== undefined ? clampHours(body.cleanupDelayHours, 2) : prev.cleanupDelayHours,
  });

  return NextResponse.json({ ok: true });
}

/** DELETE /api/admin — reset runtime overrides back to env defaults */
export async function DELETE(request: NextRequest) {
  const denied = requireAdmin(request);
  if (denied) return denied;

  clearAdminSettings();
  return NextResponse.json({ ok: true });
}

/** PATCH /api/admin — validate an API config by making a minimal call */
export async function PATCH(request: NextRequest) {
  const denied = requireAdmin(request);
  if (denied) return denied;

  const body = await request.json() as { apiUrl: string; apiKey: string; model: string };

  if (!body.apiUrl || !body.apiKey || !body.model) {
    return NextResponse.json({ ok: false, error: "apiUrl, apiKey and model are required" }, { status: 400 });
  }

  try {
    const openai = new OpenAI({ apiKey: body.apiKey, baseURL: body.apiUrl });
    const res = await openai.chat.completions.create({
      model: body.model,
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 1,
    });
    const replied = !!res.choices?.[0]?.message;
    return NextResponse.json({ ok: replied, model: res.model });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    const status = (err as { status?: number }).status;
    return NextResponse.json(
      { ok: false, error: msg, status },
      { status: 200 } // always 200 so the client gets the body
    );
  }
}

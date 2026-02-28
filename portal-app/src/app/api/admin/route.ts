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
    apiUrl:       s?.apiUrl       ?? process.env.LLM_API_URL       ?? "",
    apiKey:       s?.apiKey       ? "***" : "",
    model:        s?.model        ?? process.env.LLM_MODEL        ?? "gpt-4o",
    systemPrompt: s?.systemPrompt ?? process.env.LLM_SYSTEM_PROMPT ?? "",
    modelParams:  s?.modelParams  ?? "",
    isCustom: !!(s?.apiUrl || s?.apiKey || s?.model || s?.systemPrompt || s?.modelParams),
  });
}

/** POST /api/admin — save LLM settings (admin-only, applies to ALL users) */
export async function POST(request: NextRequest) {
  const denied = requireAdmin(request);
  if (denied) return denied;

  const body = await request.json();
  const prev = getAdminSettings() ?? {};

  setAdminSettings({
    apiUrl:       body.apiUrl       !== undefined ? body.apiUrl       : prev.apiUrl,
    apiKey:       body.apiKey && body.apiKey !== "***" ? body.apiKey : prev.apiKey,
    model:        body.model        !== undefined ? body.model        : prev.model,
    systemPrompt: body.systemPrompt !== undefined ? body.systemPrompt : prev.systemPrompt,
    modelParams:  body.modelParams  !== undefined ? body.modelParams  : prev.modelParams,
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

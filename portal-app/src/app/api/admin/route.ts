import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/auth";
import { getIronSession } from "iron-session";
import type { SessionData } from "@/lib/session";
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

function requireAdmin(request: NextRequest) {
  const user = getUserFromRequest(request);
  if (!user.isAdmin) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  return null;
}

/** GET /api/admin — return current effective LLM settings */
export async function GET(request: NextRequest) {
  const denied = requireAdmin(request);
  if (denied) return denied;

  const response = NextResponse.json({});
  const session = await getIronSession<SessionData>(request, response, sessionOptions);

  return NextResponse.json({
    apiUrl: session.llmSettings?.apiUrl ?? process.env.LLM_API_URL ?? "",
    apiKey: session.llmSettings?.apiKey ? "***" : "",
    model: session.llmSettings?.model ?? process.env.LLM_MODEL ?? "gpt-4o",
    isCustom: !!(session.llmSettings?.apiUrl || session.llmSettings?.apiKey || session.llmSettings?.model),
  });
}

/** POST /api/admin — save LLM settings (admin-only, applies to all users) */
export async function POST(request: NextRequest) {
  const denied = requireAdmin(request);
  if (denied) return denied;

  const body = await request.json();
  const response = NextResponse.json({ ok: true });
  const session = await getIronSession<SessionData>(request, response, sessionOptions);

  const prev = session.llmSettings ?? {};
  session.llmSettings = {
    apiUrl: body.apiUrl || prev.apiUrl,
    apiKey:
      body.apiKey && body.apiKey !== "***"
        ? body.apiKey
        : prev.apiKey,
    model: body.model || prev.model,
  };

  await session.save();
  return response;
}

/** DELETE /api/admin — reset runtime overrides back to env defaults */
export async function DELETE(request: NextRequest) {
  const denied = requireAdmin(request);
  if (denied) return denied;

  const response = NextResponse.json({ ok: true });
  const session = await getIronSession<SessionData>(request, response, sessionOptions);

  session.llmSettings = undefined;

  await session.save();
  return response;
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

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

/** GET /api/admin — return current effective settings for both APIs */
export async function GET(request: NextRequest) {
  const denied = requireAdmin(request);
  if (denied) return denied;

  const response = NextResponse.json({});
  const session = await getIronSession<SessionData>(request, response, sessionOptions);

  return NextResponse.json({
    admin: {
      apiUrl: session.adminSettings?.apiUrl ?? process.env.ADMIN_API_URL ?? "",
      apiKey: session.adminSettings?.apiKey ? "***" : "",
      model: session.adminSettings?.model ?? process.env.ADMIN_MODEL ?? "gpt-4o",
      isCustom: !!(session.adminSettings?.apiUrl || session.adminSettings?.apiKey || session.adminSettings?.model),
    },
    chat: {
      apiUrl: session.chatSettings?.apiUrl ?? process.env.CHAT_API_URL ?? "",
      apiKey: session.chatSettings?.apiKey ? "***" : "",
      model: session.chatSettings?.model ?? process.env.CHAT_MODEL ?? "gpt-4o",
      isCustom: !!(session.chatSettings?.apiUrl || session.chatSettings?.apiKey || session.chatSettings?.model),
    },
  });
}

/** POST /api/admin — save settings for admin and/or chat API */
export async function POST(request: NextRequest) {
  const denied = requireAdmin(request);
  if (denied) return denied;

  const body = await request.json();
  const response = NextResponse.json({ ok: true });
  const session = await getIronSession<SessionData>(request, response, sessionOptions);

  // Update admin settings if provided
  if (body.admin) {
    const prev = session.adminSettings ?? {};
    session.adminSettings = {
      apiUrl: body.admin.apiUrl || prev.apiUrl,
      apiKey:
        body.admin.apiKey && body.admin.apiKey !== "***"
          ? body.admin.apiKey
          : prev.apiKey,
      model: body.admin.model || prev.model,
    };
  }

  // Update chat settings if provided
  if (body.chat) {
    const prev = session.chatSettings ?? {};
    session.chatSettings = {
      apiUrl: body.chat.apiUrl || prev.apiUrl,
      apiKey:
        body.chat.apiKey && body.chat.apiKey !== "***"
          ? body.chat.apiKey
          : prev.apiKey,
      model: body.chat.model || prev.model,
    };
  }

  await session.save();
  return response;
}

/** DELETE /api/admin — reset all runtime overrides back to env defaults */
export async function DELETE(request: NextRequest) {
  const denied = requireAdmin(request);
  if (denied) return denied;

  const { searchParams } = new URL(request.url);
  const target = searchParams.get("target"); // "admin" | "chat" | null (both)

  const response = NextResponse.json({ ok: true });
  const session = await getIronSession<SessionData>(request, response, sessionOptions);

  if (!target || target === "admin") session.adminSettings = undefined;
  if (!target || target === "chat") session.chatSettings = undefined;

  await session.save();
  return response;
}

/** POST /api/admin/test — validate an API config by making a minimal call */
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
    // Extract HTTP status if present
    const status = (err as { status?: number }).status;
    return NextResponse.json(
      { ok: false, error: msg, status },
      { status: 200 } // always 200 so the client gets the body
    );
  }
}

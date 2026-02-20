import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/auth";
import { getIronSession } from "iron-session";
import type { SessionData } from "@/lib/session";

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

export async function GET(request: NextRequest) {
  const user = getUserFromRequest(request);
  if (!user.isAdmin) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const response = NextResponse.json({});
  const session = await getIronSession<SessionData>(
    request,
    response,
    sessionOptions
  );

  return NextResponse.json({
    apiUrl: session.adminSettings?.apiUrl ?? process.env.ADMIN_API_URL ?? "",
    apiKey: session.adminSettings?.apiKey ? "***" : "",
    model:
      session.adminSettings?.model ??
      process.env.ADMIN_MODEL ??
      "gpt-4o",
    // Whether the key is overridden from env default
    isCustom: !!session.adminSettings?.apiKey,
  });
}

export async function POST(request: NextRequest) {
  const user = getUserFromRequest(request);
  if (!user.isAdmin) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = await request.json();
  const response = NextResponse.json({ ok: true });
  const session = await getIronSession<SessionData>(
    request,
    response,
    sessionOptions
  );

  session.adminSettings = {
    apiUrl: body.apiUrl || undefined,
    apiKey: body.apiKey && body.apiKey !== "***" ? body.apiKey : session.adminSettings?.apiKey,
    model: body.model || undefined,
  };

  await session.save();
  return response;
}

export async function DELETE(request: NextRequest) {
  const user = getUserFromRequest(request);
  if (!user.isAdmin) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const response = NextResponse.json({ ok: true });
  const session = await getIronSession<SessionData>(
    request,
    response,
    sessionOptions
  );
  session.adminSettings = undefined;
  await session.save();
  return response;
}

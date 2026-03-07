import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";
import { getUserFromRequest } from "@/lib/auth";
import {
  getOpenedPageForKey,
  setOpenedPageForUser,
} from "@/lib/superset-opened-page-store";

function isAuthorizedServiceRequest(request: NextRequest): boolean {
  const secret = process.env.MCP_SERVICE_SECRET ?? "";
  if (!secret) return false;

  const auth = request.headers.get("Authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";

  const expected = crypto.createHmac("sha256", "superset-opened-page").update(secret).digest();
  const received = crypto.createHmac("sha256", "superset-opened-page").update(token).digest();
  return crypto.timingSafeEqual(expected, received);
}

export async function GET(request: NextRequest) {
  if (!isAuthorizedServiceRequest(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const key = request.nextUrl.searchParams.get("key") ?? "";
  if (!key.trim()) {
    return NextResponse.json({ error: "Missing key parameter" }, { status: 400 });
  }

  const entry = getOpenedPageForKey(key);
  if (!entry) {
    return NextResponse.json(
      { url: null, updated_at: null },
      { headers: { "Cache-Control": "no-store" } },
    );
  }

  return NextResponse.json(
    { url: entry.url, updated_at: entry.updatedAt, reason: entry.reason ?? null },
    { headers: { "Cache-Control": "no-store" } },
  );
}

export async function POST(request: NextRequest) {
  const user = getUserFromRequest(request);
  if (!user.email) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: { url?: unknown; reason?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (typeof body.url !== "string") {
    return NextResponse.json({ error: "Missing or invalid url" }, { status: 400 });
  }

  const reason = typeof body.reason === "string" ? body.reason : undefined;
  const saved = setOpenedPageForUser([user.id, user.email], body.url, reason);
  if (!saved) {
    return NextResponse.json({ error: "Invalid URL" }, { status: 400 });
  }

  return NextResponse.json({ ok: true, url: saved.url, updated_at: saved.updatedAt, reason: saved.reason ?? null });
}

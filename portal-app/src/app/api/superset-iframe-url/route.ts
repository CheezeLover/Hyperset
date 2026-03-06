import { NextRequest, NextResponse } from "next/server";

let currentIframeUrl = "";

export const GET = async () => {
  return NextResponse.json({ url: currentIframeUrl });
};

export const POST = async (req: NextRequest) => {
  try {
    const body = await req.json();
    currentIframeUrl = body.url || "";
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }
};

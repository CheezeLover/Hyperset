import { NextResponse } from "next/server";
import { sql } from "@/lib/db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  try {
    await sql`SELECT 1`;
    return NextResponse.json(
      { status: "ok", service: "portal" },
      { status: 200 },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { status: "error", service: "portal", detail: message },
      { status: 503 },
    );
  }
}

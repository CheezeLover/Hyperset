import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/auth";

export async function GET(request: NextRequest) {
  const user = getUserFromRequest(request);
  const domain = process.env.HYPERSET_DOMAIN ?? "hyperset.internal";
  const supersetUrl =
    (process.env.SUPERSET_PUBLIC_URL || "").trim() ||
    `https://superset.${domain}`;
  const pagesUrl =
    (process.env.PAGES_PUBLIC_URL || "").trim() ||
    `https://pages.${domain}`;

  return NextResponse.json({
    supersetUrl,
    pagesUrl,
    user: {
      id: user.id,
      email: user.email,
      roles: user.roles,
      isAdmin: user.isAdmin,
    },
  });
}

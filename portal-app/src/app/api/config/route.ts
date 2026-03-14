import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/auth";

export async function GET(request: NextRequest) {
  const user = getUserFromRequest(request);
  const domain = (process.env.HYPERSET_DOMAIN || "").trim() || "hyperset.internal";
  const explicitSupersetUrl = (process.env.SUPERSET_PUBLIC_URL || "").trim();
  const explicitPagesUrl = (process.env.PAGES_PUBLIC_URL || "").trim();
  
  const supersetUrl = explicitSupersetUrl || `https://superset.${domain}`;
  const pagesUrl = explicitPagesUrl || `https://pages.${domain}`;

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

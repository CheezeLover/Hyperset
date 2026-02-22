import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/auth";

export async function GET(request: NextRequest) {
  const user = getUserFromRequest(request);
  const supersetUrl =
    process.env.SUPERSET_PUBLIC_URL ??
    `https://superset.${process.env.HYPERSET_DOMAIN ?? "hyperset.internal"}`;
  const pagesUrl =
    process.env.PAGES_PUBLIC_URL ??
    `https://pages.${process.env.HYPERSET_DOMAIN ?? "hyperset.internal"}`;

  // Include raw roles header for diagnostics
  const rawRoles = request.headers.get("x-token-user-roles");

  return NextResponse.json({
    supersetUrl,
    pagesUrl,
    user: {
      id: user.id,
      email: user.email,
      roles: user.roles,
      isAdmin: user.isAdmin,
      rawRolesHeader: rawRoles,
    },
  });
}

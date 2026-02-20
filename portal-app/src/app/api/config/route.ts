import { NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/auth";

export async function GET(request: Request) {
  const user = getUserFromRequest(request);
  const supersetUrl =
    process.env.SUPERSET_PUBLIC_URL ??
    `https://superset.${process.env.HYPERSET_DOMAIN ?? "hyperset.internal"}`;
  const pagesUrl =
    process.env.PAGES_PUBLIC_URL ??
    `https://pages.${process.env.HYPERSET_DOMAIN ?? "hyperset.internal"}`;

  return NextResponse.json({
    supersetUrl,
    pagesUrl,
    user: {
      id: user.id,
      email: user.email,
      isAdmin: user.isAdmin,
    },
  });
}

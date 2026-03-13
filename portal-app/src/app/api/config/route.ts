import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/auth";
import { getPagesPublicUrl, getSupersetPublicUrl } from "@/lib/public-urls";

export async function GET(request: NextRequest) {
  const user = getUserFromRequest(request);
  const supersetUrl = getSupersetPublicUrl();
  const pagesUrl = getPagesPublicUrl();

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

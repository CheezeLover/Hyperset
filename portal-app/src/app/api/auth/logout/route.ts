import { NextResponse } from "next/server";
import { cookies } from "next/headers";

export async function GET() {
  try {
    // Clear the authentication cookie
    const cookieStore = cookies();
    cookieStore.delete("Auth-Session");
    
    // Redirect to the auth portal to fully log out
    const domain = process.env.HYPERSET_DOMAIN ?? "hyperset.internal";
    const authUrl = `https://auth.${domain}/.auth/logout`;
    
    return NextResponse.redirect(authUrl);
  } catch (error) {
    console.error("Logout error:", error);
    return NextResponse.json(
      { error: "Logout failed" },
      { status: 500 }
    );
  }
}
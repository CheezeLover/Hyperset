import { NextResponse } from "next/server";

export async function GET() {
  try {
    // Redirect to the auth portal to fully log out
    const domain = process.env.HYPERSET_DOMAIN ?? "hyperset.internal";
    const authUrl = `https://auth.${domain}/.auth/logout`;
    
    // Create a response that clears cookies and redirects
    const response = NextResponse.redirect(authUrl);
    
    // Clear the Auth-Session cookie by setting it to expire in the past.
    // sameSite and secure must match the attributes set by caddy-security
    // (samesite lax, insecure off) so the browser treats this as the same
    // cookie and evicts it rather than creating a separate zero-value entry.
    response.cookies.set("Auth-Session", "", {
      expires: new Date(0),
      path: "/",
      sameSite: "lax",
      secure: true,
    });

    // Also clear the iron-session admin cookie
    response.cookies.set("hyperset_session", "", {
      expires: new Date(0),
      path: "/",
      httpOnly: true,
    });

    return response;
  } catch (error) {
    console.error("Logout error:", error);
    return NextResponse.json(
      { error: "Logout failed" },
      { status: 500 }
    );
  }
}
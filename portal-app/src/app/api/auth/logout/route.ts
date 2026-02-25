import { NextResponse } from "next/server";

export async function GET() {
  try {
    // Redirect to the auth portal to fully log out
    const domain = process.env.HYPERSET_DOMAIN ?? "hyperset.internal";
    const authUrl = `https://auth.${domain}/.auth/logout`;
    
    // Create a response that clears cookies and redirects
    const response = NextResponse.redirect(authUrl);
    
    // Clear the Auth-Session cookie by setting it to expire in the past
    response.cookies.set("Auth-Session", "", {
      expires: new Date(0),
      path: "/",
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
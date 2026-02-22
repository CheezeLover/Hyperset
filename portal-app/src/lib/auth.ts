import { headers } from "next/headers";

export interface HypersetUser {
  id: string;
  email: string;
  roles: string[];
  isAdmin: boolean;
}

/**
 * Parse the x-token-user-roles header injected by caddy-security.
 *
 * Admin detection rules:
 *  - "hyperset/admin"  — explicit Hyperset admin role
 *  - "authp/admin"     — caddy-security's own admin role (injected when no
 *                        custom role transform is configured)
 *  - no roles header   — request came through without Caddy (direct port
 *                        access, local dev, etc.) → treat as admin so the
 *                        app stays usable
 */
function parseRoles(rolesHeader: string | null): {
  roles: string[];
  isAdmin: boolean;
} {
  if (rolesHeader === null) {
    // No Caddy auth headers → direct access / dev mode → grant admin
    return { roles: [], isAdmin: true };
  }
  // caddy-security injects roles separated by spaces (not commas).
  // Split on any whitespace or comma to be safe.
  const roles = rolesHeader
    .split(/[\s,]+/)
    .map((r) => r.trim())
    .filter(Boolean);
  const isAdmin =
    roles.includes("hyperset/admin") || roles.includes("authp/admin");
  return { roles, isAdmin };
}

export async function getCurrentUser(): Promise<HypersetUser> {
  const headersList = await headers();
  const id = headersList.get("x-token-user-id") ?? "anonymous";
  const email = headersList.get("x-token-user-email") ?? "";
  const { roles, isAdmin } = parseRoles(
    headersList.get("x-token-user-roles")
  );
  return { id, email, roles, isAdmin };
}

export function getUserFromRequest(request: Request): HypersetUser {
  const id = request.headers.get("x-token-user-id") ?? "anonymous";
  const email = request.headers.get("x-token-user-email") ?? "";
  const { roles, isAdmin } = parseRoles(
    request.headers.get("x-token-user-roles")
  );
  return { id, email, roles, isAdmin };
}

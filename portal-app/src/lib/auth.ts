import { headers } from "next/headers";

export interface HypersetUser {
  id: string;
  email: string;
  roles: string[];
  isAdmin: boolean;
}

function parseRoles(rolesRaw: string): { roles: string[]; isAdmin: boolean } {
  const roles = rolesRaw
    .split(",")
    .map((r) => r.trim())
    .filter(Boolean);
  // Accept either the Hyperset application role or the caddy-security built-in role.
  // When accessed directly (no Caddy proxy, e.g. port 3000 dev testing), treat as admin.
  const isAdmin =
    roles.includes("hyperset/admin") ||
    roles.includes("authp/admin") ||
    roles.length === 0; // no auth headers = direct access = dev mode
  return { roles, isAdmin };
}

export async function getCurrentUser(): Promise<HypersetUser> {
  const headersList = await headers();
  const id = headersList.get("x-token-user-id") ?? "anonymous";
  const email = headersList.get("x-token-user-email") ?? "";
  const rolesRaw = headersList.get("x-token-user-roles") ?? "";
  const { roles, isAdmin } = parseRoles(rolesRaw);
  return { id, email, roles, isAdmin };
}

export function getUserFromRequest(request: Request): HypersetUser {
  const id = request.headers.get("x-token-user-id") ?? "anonymous";
  const email = request.headers.get("x-token-user-email") ?? "";
  const rolesRaw = request.headers.get("x-token-user-roles") ?? "";
  const { roles, isAdmin } = parseRoles(rolesRaw);
  return { id, email, roles, isAdmin };
}

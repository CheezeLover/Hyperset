import { headers } from "next/headers";

export interface HypersetUser {
  id: string;
  email: string;
  roles: string[];
  isAdmin: boolean;
}

export interface UserContext {
  username: string;
  email: string;
  roles: string[];
}

/**
 * Parse the x-token-user-roles header injected by caddy-security.
 *
 * Admin detection rules:
 *  - "hyperset/admin"  — explicit Hyperset admin role
 *  - "authp/admin"     — caddy-security's own admin role (injected when no
 *                        custom role transform is configured)
 *  - no roles header   — fail closed (isAdmin: false, unauthenticated).
 *                        Set DEV_ADMIN=true only in local dev without Caddy.
 * 
 * SECURITY: DEV_ADMIN is strictly development-only and requires:
 * 1. DEV_ADMIN=true environment variable
 * 2. NODE_ENV=development (production fails closed regardless)
 */
function parseRoles(rolesHeader: string | null): {
  roles: string[];
  isAdmin: boolean;
} {
  if (rolesHeader === null) {
    // No Caddy auth headers present — fail closed by default so that direct
    // access to the Next.js port (3000) never grants elevated privileges.
    // Set DEV_ADMIN=true only in local development without Caddy.
    
    // SECURITY FIX: Only allow DEV_ADMIN in development mode
    const isDevelopment = process.env.NODE_ENV === "development";
    const devAdminEnabled = process.env.DEV_ADMIN === "true";
    
    if (devAdminEnabled && isDevelopment) {
      console.warn("[AUTH] DEV_ADMIN enabled - granting admin access for development");
      return { roles: [], isAdmin: true };
    }
    
    // In production or if DEV_ADMIN not set, fail closed
    if (devAdminEnabled && !isDevelopment) {
      console.error("[AUTH] DEV_ADMIN ignored in production - failing closed");
    }
    
    return { roles: [], isAdmin: false };
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

export async function getUserFromHeaders(): Promise<UserContext> {
  const h = await headers();
  // Utiliser l'email comme username car X-Token-User-Id n'est pas disponible
  const email = h.get("x-token-user-email");

  if (!email) {
    throw new Error("Unauthenticated: missing X-Token-User-Email header");
  }

  // Pour les roles, utiliser X-Token-User-Roles
  const rolesRaw = h.get("x-token-user-roles") ?? "";
  const roles = rolesRaw.split(",").map((r) => r.trim()).filter(Boolean);

  // Retourner l'email comme username
  return { username: email, email, roles };
}

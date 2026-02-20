import { headers } from "next/headers";

export interface HypersetUser {
  id: string;
  email: string;
  roles: string[];
  isAdmin: boolean;
}

export async function getCurrentUser(): Promise<HypersetUser> {
  const headersList = await headers();
  const id = headersList.get("x-token-user-id") ?? "anonymous";
  const email = headersList.get("x-token-user-email") ?? "";
  const rolesRaw = headersList.get("x-token-user-roles") ?? "";
  const roles = rolesRaw
    .split(",")
    .map((r) => r.trim())
    .filter(Boolean);
  const isAdmin = roles.includes("hyperset/admin");
  return { id, email, roles, isAdmin };
}

export function getUserFromRequest(request: Request): HypersetUser {
  const id = request.headers.get("x-token-user-id") ?? "anonymous";
  const email = request.headers.get("x-token-user-email") ?? "";
  const rolesRaw = request.headers.get("x-token-user-roles") ?? "";
  const roles = rolesRaw
    .split(",")
    .map((r) => r.trim())
    .filter(Boolean);
  const isAdmin = roles.includes("hyperset/admin");
  return { id, email, roles, isAdmin };
}

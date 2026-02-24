import { createHmac, timingSafeEqual, randomUUID } from "crypto";

const SECRET = process.env.MCP_SERVICE_SECRET ?? "";

if (!SECRET || SECRET.length < 32) {
  throw new Error("MCP_SERVICE_SECRET must be set and at least 32 characters");
}

export interface McpToken {
  sub: string;
  email: string;
  roles: string[];
  iat: number;
  exp: number;
  jti: string;
}

export function createMcpToken(
  username: string,
  email: string,
  roles: string[]
): string {
  const payload: McpToken = {
    sub: username,
    email,
    roles,
    iat: Date.now(),
    exp: Date.now() + 60_000,   // 60s — suffisant pour un aller-retour MCP
    jti: randomUUID(),           // nonce anti-rejeu
  };

  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = createHmac("sha256", SECRET)
    .update(encoded)
    .digest("base64url");

  return `${encoded}.${sig}`;
}
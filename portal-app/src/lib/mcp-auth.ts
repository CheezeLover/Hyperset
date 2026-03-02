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

/**
 * Verify an MCP token's signature and validity.
 * 
 * SECURITY NOTE: This is primarily for client-side debugging. The actual
 * token verification happens server-side in the Python MCP server to prevent
 * token forgery. This function can be used for client-side token inspection
 * but should NOT be relied upon for security decisions.
 * 
 * @param token The Bearer token to verify
 * @returns The decoded token payload
 * @throws Error if token is malformed, expired, or has invalid signature
 */
export function verifyMcpToken(token: string): McpToken {
  const parts = token.split(".");
  if (parts.length !== 2) {
    throw new Error("Malformed token: expected 2 parts");
  }

  const [encoded, signature] = parts;

  // Verify signature
  const expectedSig = createHmac("sha256", SECRET)
    .update(encoded)
    .digest("base64url");

  // Timing-safe comparison
  const sigBuf = Buffer.from(signature, "base64url");
  const expectedBuf = Buffer.from(expectedSig, "base64url");
  
  if (sigBuf.length !== expectedBuf.length || !timingSafeEqual(sigBuf, expectedBuf)) {
    throw new Error("Invalid token signature");
  }

  // Decode payload
  let payload: McpToken;
  try {
    payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch {
    throw new Error("Cannot decode token payload");
  }

  // Verify expiration
  if (Date.now() > payload.exp) {
    throw new Error("Token expired");
  }

  // Verify required claims
  if (!payload.jti) {
    throw new Error("Missing 'jti' claim");
  }
  if (!payload.sub) {
    throw new Error("Missing 'sub' claim");
  }

  return payload;
}

/**
 * Decode an MCP token without verification (for debugging only).
 * 
 * WARNING: This does NOT verify the signature! Only use this for debugging
 * or logging. For security decisions, always use verifyMcpToken().
 * 
 * @param token The token to decode
 * @returns The decoded payload (unverified)
 */
export function decodeMcpToken(token: string): McpToken | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 2) return null;
    return JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
  } catch {
    return null;
  }
}
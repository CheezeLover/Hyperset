/**
 * Server-side admin settings store — PostgreSQL backed.
 *
 * Admin settings (API key, model, system prompt, etc.) must apply to ALL users
 * and ALL portal instances.  They are persisted in the shared portal-db so
 * every replica reads the same values.
 *
 * An in-memory cache (per-instance) is kept for fast reads; it is invalidated
 * on every write so a newly written value is visible on the next read from the
 * same instance.  Other instances will serve a slightly stale cache until their
 * next write — this is acceptable for low-frequency admin configuration changes.
 */

import crypto from "crypto";
import { sql, ensureSchema } from "./db";
import type { LlmSettings } from "./session";

// ── AES-256-GCM encryption for the API key at rest ────────────────────────────
const _encKey = (() => {
  const secret = process.env.SESSION_SECRET ?? "";
  return crypto.createHash("sha256").update(secret).digest();
})();

function encryptString(plaintext: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", _encKey, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [iv.toString("base64"), authTag.toString("base64"), encrypted.toString("base64")].join(":");
}

function decryptString(ciphertext: string): string {
  const parts = ciphertext.split(":");
  if (parts.length !== 3) throw new Error("Invalid ciphertext format");
  const [ivB64, tagB64, encB64] = parts;
  const iv = Buffer.from(ivB64, "base64");
  const authTag = Buffer.from(tagB64, "base64");
  const encrypted = Buffer.from(encB64, "base64");
  const decipher = crypto.createDecipheriv("aes-256-gcm", _encKey, iv);
  decipher.setAuthTag(authTag);
  return decipher.update(encrypted).toString("utf8") + decipher.final("utf8");
}

// ── In-memory cache (per-instance) ───────────────────────────────────────────
// undefined = not yet loaded; null = loaded, no override set
let _cache: LlmSettings | null | undefined = undefined;

/** Return the active admin override settings, or null if none are set. */
export async function getAdminSettings(): Promise<LlmSettings | null> {
  if (_cache !== undefined) return _cache;
  await ensureSchema();
  const rows = await sql<{ value: string }[]>`
    SELECT value FROM hyperset_admin_settings WHERE key = 'settings' LIMIT 1
  `;
  if (rows.length === 0) {
    _cache = null;
    return null;
  }
  const settings = JSON.parse(rows[0].value) as LlmSettings;
  if (settings.apiKey) {
    try {
      settings.apiKey = decryptString(settings.apiKey);
    } catch {
      // Legacy plaintext — leave as-is; next write will encrypt it.
    }
  }
  _cache = settings;
  return settings;
}

/** Persist a new set of admin override settings (applies to all users). */
export async function setAdminSettings(settings: LlmSettings): Promise<void> {
  _cache = settings;
  await ensureSchema();
  const toStore: LlmSettings = { ...settings };
  if (toStore.apiKey) {
    toStore.apiKey = encryptString(toStore.apiKey);
  }
  await sql`
    INSERT INTO hyperset_admin_settings (key, value)
    VALUES ('settings', ${JSON.stringify(toStore)})
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
  `;
}

/** Clear all admin overrides — fall back to env vars for all users. */
export async function clearAdminSettings(): Promise<void> {
  _cache = null;
  await ensureSchema();
  await sql`DELETE FROM hyperset_admin_settings WHERE key = 'settings'`;
}

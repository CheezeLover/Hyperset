/**
 * Server-side admin settings store.
 *
 * Admin settings (API key, model, system prompt, etc.) must apply to ALL users,
 * not just the admin who saved them. Storing them in iron-session cookies is
 * wrong because each user has their own cookie — other users would never see
 * the admin's changes.
 *
 * This module keeps settings in:
 *  1. An in-memory cache (fast, shared across all requests in the same process).
 *  2. A JSON file on disk (survives process restarts).
 *
 * The file path defaults to <cwd>/data/admin-settings.json and can be
 * overridden via the ADMIN_SETTINGS_PATH environment variable.
 */

import fs from "fs";
import path from "path";
import crypto from "crypto";
import type { LlmSettings } from "./session";

// ── AES-256-GCM encryption for the API key at rest ────────────────────────────
// Key is derived from SESSION_SECRET (already required to be >= 32 chars).
// Using SHA-256 of the secret as the 32-byte AES key is safe here because
// SESSION_SECRET is already a high-entropy random value.
const _encKey = (() => {
  const secret = process.env.SESSION_SECRET ?? "";
  return crypto.createHash("sha256").update(secret).digest();
})();

function encryptString(plaintext: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", _encKey, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  // Format: iv:authTag:ciphertext — all base64-encoded, colon-delimited
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

const SETTINGS_FILE =
  process.env.ADMIN_SETTINGS_PATH ??
  path.join(process.cwd(), "data", "admin-settings.json");

// In-memory singleton — shared across all API route invocations in this process.
// undefined = not yet loaded from disk; null = loaded but no override set.
let _cache: LlmSettings | null | undefined = undefined;

function readFromDisk(): LlmSettings | null {
  try {
    const raw = fs.readFileSync(SETTINGS_FILE, "utf-8");
    const settings = JSON.parse(raw) as LlmSettings;
    if (settings.apiKey) {
      try {
        settings.apiKey = decryptString(settings.apiKey);
      } catch (e) {
        // Decryption failed — key was stored as legacy plaintext.
        // Use as-is to avoid a hard break during migration.
        console.warn(
          "[admin-settings] Failed to decrypt apiKey — falling back to legacy " +
          "plaintext mode. If this is unexpected, rotate SESSION_SECRET and " +
          "re-save the API key via the admin panel.",
          e
        );
      }
    }
    return settings;
  } catch {
    return null;
  }
}

function writeToDisk(settings: LlmSettings): void {
  try {
    fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
    const toWrite: LlmSettings = { ...settings };
    if (toWrite.apiKey) {
      toWrite.apiKey = encryptString(toWrite.apiKey);
    }
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(toWrite, null, 2), "utf-8");
  } catch (e) {
    console.warn("[admin-settings] Could not persist settings to disk:", e);
  }
}

function deleteFromDisk(): void {
  try {
    fs.unlinkSync(SETTINGS_FILE);
  } catch {
    // File may not exist — that's fine.
  }
}

/** Return the active admin override settings, or null if none are set. */
export function getAdminSettings(): LlmSettings | null {
  if (_cache === undefined) {
    _cache = readFromDisk();
  }
  return _cache;
}

/** Persist a new set of admin override settings (applies to all users). */
export function setAdminSettings(settings: LlmSettings): void {
  _cache = settings;
  writeToDisk(settings);
}

/** Clear all admin overrides — fall back to env vars for all users. */
export function clearAdminSettings(): void {
  _cache = null;
  deleteFromDisk();
}

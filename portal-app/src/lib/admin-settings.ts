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
import type { LlmSettings } from "./session";

const SETTINGS_FILE =
  process.env.ADMIN_SETTINGS_PATH ??
  path.join(process.cwd(), "data", "admin-settings.json");

// In-memory singleton — shared across all API route invocations in this process.
// undefined = not yet loaded from disk; null = loaded but no override set.
let _cache: LlmSettings | null | undefined = undefined;

function readFromDisk(): LlmSettings | null {
  try {
    const raw = fs.readFileSync(SETTINGS_FILE, "utf-8");
    return JSON.parse(raw) as LlmSettings;
  } catch {
    return null;
  }
}

function writeToDisk(settings: LlmSettings): void {
  try {
    fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2), "utf-8");
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

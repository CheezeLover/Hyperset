/**
 * Page settings store — PostgreSQL backed.
 *
 * Each page (active flag, allowed groups, icon) is stored as a JSONB row.
 * An in-memory cache per instance avoids redundant DB round-trips on reads.
 * Writes invalidate only the updated entry so other entries stay cached.
 */

import { sql, ensureSchema } from "./db";

export interface PageSettings {
  active: boolean;
  allowedGroups: string[];
  icon?: string;
  iconColor?: string;
}

export interface PageMetadata extends PageSettings {
  name: string;
  hasBackend: boolean;
}

// Per-instance cache; null = not loaded yet
let _cache: Record<string, PageSettings> | null = null;

export async function getAllPageSettings(): Promise<Record<string, PageSettings>> {
  if (_cache !== null) return _cache;
  await ensureSchema();
  const rows = await sql<{ name: string; settings: unknown }[]>`
    SELECT name, settings FROM hyperset_page_settings
  `;
  const result: Record<string, PageSettings> = {};
  for (const row of rows) {
    // postgres may return JSONB as a pre-parsed object or as a raw string
    // depending on the query path — handle both defensively
    const parsed: PageSettings =
      typeof row.settings === "string"
        ? (JSON.parse(row.settings) as PageSettings)
        : (row.settings as PageSettings);
    result[row.name] = parsed;
  }
  _cache = result;
  return result;
}

export async function getPageSettings(name: string): Promise<PageSettings> {
  const all = await getAllPageSettings();
  return all[name] ?? { active: true, allowedGroups: [] };
}

export async function setPageSettings(name: string, settings: PageSettings): Promise<void> {
  await ensureSchema();
  await sql`
    INSERT INTO hyperset_page_settings (name, settings)
    VALUES (${name}, ${JSON.stringify(settings)}::jsonb)
    ON CONFLICT (name) DO UPDATE SET settings = EXCLUDED.settings
  `;
  // Update cache in place so callers in the same process see the new value
  if (_cache) _cache[name] = settings;
}

export async function deletePageSettings(name: string): Promise<void> {
  await ensureSchema();
  await sql`DELETE FROM hyperset_page_settings WHERE name = ${name}`;
  if (_cache) delete _cache[name];
}

export async function canUserViewPage(name: string, userRoles: string[]): Promise<boolean> {
  const settings = await getPageSettings(name);
  if (!settings.active) return false;
  if (settings.allowedGroups.length === 0) return true;
  return userRoles.some((role) => settings.allowedGroups.includes(role));
}

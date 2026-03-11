import fs from "fs";
import path from "path";

export interface PageSettings {
  active: boolean;
  allowedGroups: string[];
}

export interface PageMetadata extends PageSettings {
  name: string;
  hasBackend: boolean;
}

const SETTINGS_FILE =
  process.env.PAGE_SETTINGS_PATH ??
  path.join(process.cwd(), "data", "page-settings.json");

let _cache: Record<string, PageSettings> | null = null;

function readFromDisk(): Record<string, PageSettings> {
  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      const raw = fs.readFileSync(SETTINGS_FILE, "utf-8");
      return JSON.parse(raw);
    }
  } catch {
    // File doesn't exist or is invalid - return empty
  }
  return {};
}

function writeToDisk(settings: Record<string, PageSettings>): void {
  try {
    fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2), { encoding: "utf-8", mode: 0o600 });
    fs.chmodSync(SETTINGS_FILE, 0o600);
  } catch (e) {
    console.warn("[page-settings] Could not persist settings to disk:", e);
  }
}

function _ensureCache(): Record<string, PageSettings> {
  if (_cache === null) {
    _cache = readFromDisk();
  }
  return _cache;
}

export function getPageSettings(name: string): PageSettings {
  const settings = _ensureCache();
  return settings[name] ?? { active: true, allowedGroups: [] };
}

export function getAllPageSettings(): Record<string, PageSettings> {
  return _ensureCache();
}

export function setPageSettings(name: string, settings: PageSettings): void {
  const all = _ensureCache();
  all[name] = settings;
  _cache = all;
  writeToDisk(all);
}

export function deletePageSettings(name: string): void {
  const all = _ensureCache();
  delete all[name];
  _cache = all;
  writeToDisk(all);
}

export function canUserViewPage(name: string, userRoles: string[]): boolean {
  const settings = getPageSettings(name);
  if (!settings.active) return false;
  if (settings.allowedGroups.length === 0) return true;
  return userRoles.some((role) => settings.allowedGroups.includes(role));
}
interface OpenedPageEntry {
  url: string;
  updatedAt: string;
}

const _openedPages = new Map<string, OpenedPageEntry>();
const MAX_URL_LENGTH = 2048;
const RETENTION_MS = 1000 * 60 * 60 * 12; // 12 hours

function normalizeUrl(raw: string): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > MAX_URL_LENGTH) return null;
  try {
    const u = new URL(trimmed);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u.toString();
  } catch {
    return null;
  }
}

function isGenericHomeUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    const p = (u.pathname || "/").replace(/\/+$/, "") || "/";
    return (
      (p === "/" || p === "/superset" || p === "/superset/welcome" || p === "/welcome") &&
      !u.search &&
      !u.hash
    );
  } catch {
    return false;
  }
}

function pruneExpired(nowMs: number): void {
  for (const [key, value] of _openedPages.entries()) {
    const ts = Date.parse(value.updatedAt);
    if (!Number.isFinite(ts) || nowMs - ts > RETENTION_MS) {
      _openedPages.delete(key);
    }
  }
}

function normalizeKey(raw: string | undefined): string {
  return (raw ?? "").trim().toLowerCase();
}

export function setOpenedPageForUser(keys: Array<string | undefined>, rawUrl: string): OpenedPageEntry | null {
  const url = normalizeUrl(rawUrl);
  if (!url) return null;

  const now = new Date();
  const nowIso = now.toISOString();
  const nowMs = now.getTime();
  pruneExpired(nowMs);

  const entry: OpenedPageEntry = { url, updatedAt: nowIso };
  for (const key of keys) {
    const normalizedKey = normalizeKey(key);
    if (!normalizedKey) continue;

    // Prevent noisy "home" updates from overwriting a more specific page URL.
    const previous = _openedPages.get(normalizedKey);
    if (previous && !isGenericHomeUrl(previous.url) && isGenericHomeUrl(url)) {
      continue;
    }

    _openedPages.set(normalizedKey, entry);
  }

  return entry;
}

export function getOpenedPageForKey(key: string): OpenedPageEntry | null {
  const normalizedKey = normalizeKey(key);
  if (!normalizedKey) return null;

  const nowMs = Date.now();
  pruneExpired(nowMs);

  return _openedPages.get(normalizedKey) ?? null;
}

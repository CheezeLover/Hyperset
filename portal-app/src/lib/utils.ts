// ── Shared formatting helpers ──────────────────────────────────────────────────

export function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
}

// ── Sliding-window rate limiter ────────────────────────────────────────────────
// Each caller maintains its own Map<key → timestamps[]>.
// Returns true if the request is allowed, false if the limit is exceeded.

export function checkRateLimit(
  map: Map<string, number[]>,
  limit: number,
  windowMs: number,
  key: string,
): boolean {
  const now = Date.now();
  const timestamps = map.get(key) ?? [];
  const recent = timestamps.filter((t) => now - t < windowMs);
  if (recent.length >= limit) {
    map.set(key, recent);
    return false;
  }
  recent.push(now);
  map.set(key, recent);
  return true;
}

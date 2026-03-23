// ── Shared formatting helpers ──────────────────────────────────────────────────

export function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
}

// ── Redis-backed sliding-window rate limiter ───────────────────────────────────
// Uses a sorted set per (namespace, key): score = timestamp, member = unique request id.
// Fails open on Redis errors so a cache outage never blocks legitimate users.
// Returns true if the request is allowed, false if the limit is exceeded.

import { redis } from "./redis";

export async function checkRateLimit(
  namespace: string,
  limit: number,
  windowMs: number,
  key: string,
): Promise<boolean> {
  const redisKey = `ratelimit:${namespace}:${key}`;
  const now = Date.now();
  const windowStart = now - windowMs;
  try {
    await redis.zremrangebyscore(redisKey, 0, windowStart);
    const count = await redis.zcard(redisKey);
    if (count >= limit) return false;
    await redis.zadd(redisKey, now, `${now}-${Math.random()}`);
    await redis.expire(redisKey, Math.ceil(windowMs / 1000) + 1);
    return true;
  } catch {
    return true; // fail open — Redis unavailable
  }
}

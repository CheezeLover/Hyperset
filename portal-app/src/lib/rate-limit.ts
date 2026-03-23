// Server-only — never import this from client components.
// Uses ioredis (Node.js net/tls) which cannot be bundled for the browser.
import { redis } from "./redis";

// ── Redis-backed sliding-window rate limiter ───────────────────────────────────
// Uses a sorted set per (namespace, key): score = timestamp, member = unique id.
// Fails open on Redis errors so a cache outage never blocks legitimate users.
// Returns true if the request is allowed, false if the limit is exceeded.

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

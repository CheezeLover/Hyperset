import "server-only";
import { Redis } from "ioredis";

declare global {
  // eslint-disable-next-line no-var
  var __redis: Redis | undefined;
}

function createRedis(): Redis {
  const url = process.env.REDIS_URL ?? "redis://localhost:6379";
  return new Redis(url, {
    lazyConnect: true,       // don't connect at module load — safe during next build
    maxRetriesPerRequest: 1, // fail fast if Redis is down
    enableOfflineQueue: false,
  });
}

export const redis: Redis =
  globalThis.__redis ?? createRedis();

// Preserve connection across hot-reloads in development
if (process.env.NODE_ENV !== "production") {
  globalThis.__redis = redis;
}

import Redis from 'ioredis';
import { env } from '../config/env';

export const redis = new Redis(env.REDIS_URL, {
  maxRetriesPerRequest: 3,
  enableReadyCheck: true,
  lazyConnect: true,
});

redis.on('error', (err) => {
  console.error('[Redis] Connection error:', err.message);
});

redis.on('connect', () => {
  console.log('[Redis] Connected');
});

// ─── Key builders ─────────────────────────────────────────────────────────────
export const KEYS = {
  cardCatalog: () => 'swipesmart:cards:catalog',
  cardBySlug: (slug: string) => `swipesmart:cards:slug:${slug}`,
  session: (sessionId: string) => `swipesmart:session:${sessionId}`,
  rateLimit: (ip: string) => `swipesmart:rl:${ip}`,
  // AI response cache — key is a SHA-256 hash of (message + context)
  chatResponse: (hash: string) => `swipesmart:chat:response:${hash}`,
  // Per-session AI usage counter (TTL = 24h)
  aiUsage: (sessionId: string) => `swipesmart:chat:ai_usage:${sessionId}`,
};

// ─── Typed helpers ────────────────────────────────────────────────────────────
export async function getJson<T>(key: string): Promise<T | null> {
  const raw = await redis.get(key);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export async function setJson<T>(key: string, value: T, ttlSeconds?: number): Promise<void> {
  const serialized = JSON.stringify(value);
  if (ttlSeconds) {
    await redis.set(key, serialized, 'EX', ttlSeconds);
  } else {
    await redis.set(key, serialized);
  }
}

import { LRUCache } from "lru-cache";
import { env } from "@/lib/env";

type CacheRecord<T> = {
  value: T;
  createdAt: number;
};

export function createCache<T>(options?: { max?: number; ttlMs?: number }) {
  const cache = new LRUCache<string, CacheRecord<T>>({
    max: options?.max ?? 500,
    ttl: options?.ttlMs ?? env.CACHE_TTL_MS,
  });

  return {
    get(key: string): T | undefined {
      const rec = cache.get(key);
      return rec?.value;
    },
    set(key: string, value: T, ttlMs?: number): void {
      cache.set(key, { value, createdAt: Date.now() }, { ttl: ttlMs ?? env.CACHE_TTL_MS });
    },
    has(key: string): boolean {
      return cache.has(key);
    },
    delete(key: string): void {
      cache.delete(key);
    },
  };
}

export const tokenCache = createCache<{ accessToken: string; expiresAt: number }>({ max: 5, ttlMs: env.CACHE_TTL_MS });
export const sellerCache = createCache<unknown>({ max: 200, ttlMs: env.CACHE_TTL_MS });



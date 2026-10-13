import type { FilePayload } from './types.js';

export function estimatePayloadMemoryBytes(payload: FilePayload): number {
  return payload.content ? Buffer.byteLength(payload.content, 'utf-8') : 0;
}

function trimCacheByBudget<T extends { memoryBytes: number }>(
  cache: Map<string, T>,
  limit: number,
  maxBytes: number,
): void {
  let totalBytes = 0;
  cache.forEach((entry) => {
    totalBytes += entry.memoryBytes;
  });

  while (cache.size > limit || totalBytes > maxBytes) {
    const oldestKey = cache.keys().next().value;
    if (!oldestKey) break;
    const oldestEntry = cache.get(oldestKey);
    if (!oldestEntry) {
      cache.delete(oldestKey);
      continue;
    }
    totalBytes -= oldestEntry.memoryBytes;
    cache.delete(oldestKey);
  }
}

export function rememberCacheEntry<T extends { memoryBytes: number }>(
  cache: Map<string, T>,
  key: string,
  value: T,
  limit: number,
  maxBytes: number,
): T {
  if (cache.has(key)) cache.delete(key);
  cache.set(key, value);
  trimCacheByBudget(cache, limit, maxBytes);
  return value;
}

export function rememberLimitedEntry<T>(
  cache: Map<string, T>,
  key: string,
  value: T,
  limit: number,
): T {
  if (cache.has(key)) cache.delete(key);
  cache.set(key, value);
  while (cache.size > limit) {
    const oldestKey = cache.keys().next().value;
    if (!oldestKey) break;
    cache.delete(oldestKey);
  }
  return value;
}

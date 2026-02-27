type CacheEntry<T = unknown> = {
  data: T;
  fetchedAt: number;
  expiresAt: number;
};

type InFlightEntry = {
  promise: Promise<Response>;
  controller: AbortController;
};

const DEFAULT_TTL_MS = 8_000;
const MAX_ENTRIES = 512;

const cache = new Map<string, CacheEntry>();
const inFlight = new Map<string, InFlightEntry>();

function evictStale(): void {
  const now = Date.now();
  for (const [key, entry] of cache) {
    if (entry.expiresAt <= now) cache.delete(key);
  }
  if (cache.size > MAX_ENTRIES) {
    const sorted = [...cache.entries()].sort((a, b) => a[1].fetchedAt - b[1].fetchedAt);
    const excess = sorted.slice(0, cache.size - MAX_ENTRIES);
    for (const [key] of excess) cache.delete(key);
  }
}

function buildCacheKey(url: string, init?: RequestInit): string {
  const method = (init?.method ?? 'GET').toUpperCase();
  if (method !== 'GET' && method !== 'HEAD') return '';
  return `${method}:${url}`;
}

export interface CachedFetchOptions extends RequestInit {
  ttlMs?: number;
  skipCache?: boolean;
}

export async function cachedFetch(
  url: string,
  options: CachedFetchOptions = {}
): Promise<Response> {
  const { ttlMs = DEFAULT_TTL_MS, skipCache = false, ...init } = options;
  const key = buildCacheKey(url, init);

  if (key && !skipCache) {
    const hit = cache.get(key);
    if (hit && hit.expiresAt > Date.now()) {
      return new Response(JSON.stringify(hit.data), {
        status: 200,
        headers: { 'content-type': 'application/json', 'x-cache': 'hit' },
      });
    }
  }

  if (key && !skipCache) {
    const existing = inFlight.get(key);
    if (existing && !existing.controller.signal.aborted) {
      return existing.promise.then((r) => r.clone());
    }
  }

  const controller = new AbortController();
  const parentSignal = init.signal;
  if (parentSignal) {
    if (parentSignal.aborted) {
      controller.abort();
    } else {
      parentSignal.addEventListener('abort', () => controller.abort(), { once: true });
    }
  }

  const fetchPromise = fetch(url, { ...init, signal: controller.signal }).then((response) => {
    if (key && response.ok) {
      response
        .clone()
        .json()
        .then((data: unknown) => {
          cache.set(key, {
            data,
            fetchedAt: Date.now(),
            expiresAt: Date.now() + ttlMs,
          });
          evictStale();
        })
        .catch(() => {});
    }
    return response;
  });

  if (key && !skipCache) {
    inFlight.set(key, { promise: fetchPromise, controller });
    fetchPromise.finally(() => {
      if (inFlight.get(key)?.promise === fetchPromise) {
        inFlight.delete(key);
      }
    });
  }

  return fetchPromise;
}

export function invalidateCache(urlPattern?: string | RegExp): void {
  if (!urlPattern) {
    cache.clear();
    return;
  }
  for (const key of cache.keys()) {
    const url = key.replace(/^[A-Z]+:/, '');
    if (typeof urlPattern === 'string') {
      if (url.includes(urlPattern)) cache.delete(key);
    } else {
      if (urlPattern.test(url)) cache.delete(key);
    }
  }
}

export function getCacheStats(): {
  entries: number;
  inFlight: number;
  maxEntries: number;
} {
  return {
    entries: cache.size,
    inFlight: inFlight.size,
    maxEntries: MAX_ENTRIES,
  };
}

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

const store = new Map<string, RateLimitEntry>();

function pruneExpired(now: number): void {
  for (const [key, entry] of store) {
    if (now > entry.resetAt) store.delete(key);
  }
}

export function rateLimit(
  key: string,
  maxRequests: number,
  windowMs: number
): { allowed: boolean; remaining: number } {
  if (!Number.isFinite(maxRequests) || maxRequests <= 0) {
    return { allowed: false, remaining: 0 };
  }
  if (!Number.isFinite(windowMs) || windowMs <= 0) {
    return { allowed: false, remaining: 0 };
  }

  const now = Date.now();

  // Bound stale in-memory state without scanning on every request.
  if (store.size > 1000) pruneExpired(now);

  const entry = store.get(key);
  if (!entry || now > entry.resetAt) {
    store.set(key, { count: 1, resetAt: now + windowMs });
    return { allowed: true, remaining: maxRequests - 1 };
  }

  if (entry.count >= maxRequests) {
    return { allowed: false, remaining: 0 };
  }

  entry.count++;
  return { allowed: true, remaining: maxRequests - entry.count };
}

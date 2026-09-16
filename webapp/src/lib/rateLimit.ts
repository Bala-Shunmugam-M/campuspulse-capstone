import { RateLimitedError } from "@/lib/errors";

type Bucket = { count: number; resetAt: number };
const buckets = new Map<string, Bucket>();

/**
 * In-memory fixed-window limiter. Sufficient for a single-process deployment;
 * several instances need a shared store, which the README states rather than
 * pretending away.
 */
export function assertRateLimit(key: string, limit: number, windowMs: number): void {
  const now = Date.now();
  const bucket = buckets.get(key);

  if (!bucket || bucket.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return;
  }
  if (bucket.count >= limit) {
    throw new RateLimitedError("Too many attempts. Try again shortly.");
  }
  bucket.count += 1;
}

export function resetRateLimits(): void {
  buckets.clear();
}

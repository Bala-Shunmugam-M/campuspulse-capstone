import { createHmac } from "node:crypto";
import { prisma } from "@/lib/db";
import { RateLimitedError } from "@/lib/errors";

/**
 * The rate-limit identity of a request: a peppered HMAC of the client IP and
 * the UTC day. It lands in rate_limit_buckets, which the sweep in
 * assertRateLimit empties after an hour, and the day in the HMAC means even a
 * surviving row cannot be linked to the same address on another day.
 *
 * The RIGHTMOST X-Forwarded-For hop is used: a proxy appends the address it
 * saw, so that entry is the one a client cannot forge. Next itself only fills
 * the header when it is absent, so a client that reaches Next directly can
 * still choose its key -- deploy behind a proxy that appends or overwrites the
 * header. The global AI cap in draftReport bounds spend either way.
 *
 * Null without a pepper or an address; callers then share one bucket rather
 * than go unlimited.
 */
export function clientKeyFrom(headers: Headers, at: Date): string | null {
  const pepper = process.env.IP_HASH_PEPPER;
  const ip =
    headers.get("x-forwarded-for")?.split(",").at(-1)?.trim() || headers.get("x-real-ip")?.trim();
  if (!pepper || !ip) return null;
  return createHmac("sha256", pepper)
    .update(`${at.toISOString().slice(0, 10)}|${ip}`)
    .digest("hex");
}

/**
 * Fixed-window limiter backed by Postgres rather than process memory. The
 * in-memory version this replaces was correct for one instance and wrong for
 * two: behind a load balancer each process granted the full allowance, so a
 * five-per-window limit became five per instance.
 *
 * Postgres rather than Redis because the database is already here and already
 * transactional; adding an infrastructure dependency to fix a single-process
 * assumption trades one operational problem for a larger one.
 */
export async function assertRateLimit(
  key: string,
  limit: number,
  windowMs: number,
): Promise<void> {
  const [row] = await prisma.$queryRaw<{ bump_rate_limit: number }[]>`
    SELECT compliance.bump_rate_limit(${key}, ${windowMs}::bigint)`;

  // ponytail: opportunistic sweep, about one call in fifty, so expired buckets
  // (keyed by hashed client addresses) do not accumulate; move to a scheduled
  // job if traffic makes the delete noticeable.
  if (Math.random() < 0.02) void sweepRateLimits().catch(() => {});

  if (row.bump_rate_limit > limit) {
    throw new RateLimitedError("Too many attempts. Try again shortly.");
  }
}

/** Test seam. Clears every bucket. */
export async function resetRateLimits(): Promise<void> {
  await prisma.rateLimitBucket.deleteMany({});
}

/**
 * Drops windows that closed over an hour ago. Called opportunistically rather
 * than on a schedule; the table is small and this keeps it that way without
 * introducing a job runner.
 */
export async function sweepRateLimits(): Promise<number> {
  const cutoff = new Date(Date.now() - 3_600_000);
  const { count } = await prisma.rateLimitBucket.deleteMany({
    where: { windowStart: { lt: cutoff } },
  });
  return count;
}

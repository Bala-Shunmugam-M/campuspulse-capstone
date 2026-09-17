import { prisma } from "@/lib/db";
import { RateLimitedError } from "@/lib/errors";

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

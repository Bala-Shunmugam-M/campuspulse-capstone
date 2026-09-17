import { beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { prisma } from "../src/lib/db";
import { assertRateLimit, resetRateLimits, sweepRateLimits } from "../src/lib/rateLimit";

const key = () => `test:${randomUUID()}`;

beforeEach(async () => {
  await resetRateLimits();
});

describe("assertRateLimit", () => {
  it("allows up to the limit and refuses past it", async () => {
    const k = key();
    for (let i = 0; i < 3; i++) {
      await expect(assertRateLimit(k, 3, 60_000)).resolves.toBeUndefined();
    }
    await expect(assertRateLimit(k, 3, 60_000)).rejects.toThrow(/too many attempts/i);
  });

  it("counts each key separately", async () => {
    const a = key();
    const b = key();
    await assertRateLimit(a, 1, 60_000);
    await expect(assertRateLimit(a, 1, 60_000)).rejects.toThrow();
    await expect(assertRateLimit(b, 1, 60_000)).resolves.toBeUndefined();
  });

  it("starts a new window once the old one has closed", async () => {
    const k = key();
    await assertRateLimit(k, 1, 60_000);
    await expect(assertRateLimit(k, 1, 60_000)).rejects.toThrow();

    // Age the window rather than sleeping through it.
    await prisma.rateLimitBucket.update({
      where: { key: k },
      data: { windowStart: new Date(Date.now() - 120_000) },
    });

    await expect(assertRateLimit(k, 1, 60_000)).resolves.toBeUndefined();
  });

  it("keeps its count in the database, not in this process", async () => {
    // This is the cross-process property stated plainly. The in-memory limiter
    // this replaces passed every other test in this file and could not pass
    // this one: its counter lived in a Map, so a second process started from
    // zero and granted the whole allowance again.
    const k = key();
    await assertRateLimit(k, 5, 60_000);
    await assertRateLimit(k, 5, 60_000);

    const row = await prisma.rateLimitBucket.findUniqueOrThrow({ where: { key: k } });
    expect(row.count).toBe(2);
  });
});

describe("sweepRateLimits", () => {
  it("drops windows older than an hour and keeps current ones", async () => {
    const stale = key();
    const fresh = key();
    await assertRateLimit(stale, 5, 60_000);
    await assertRateLimit(fresh, 5, 60_000);
    await prisma.rateLimitBucket.update({
      where: { key: stale },
      data: { windowStart: new Date(Date.now() - 7_200_000) },
    });

    const removed = await sweepRateLimits();

    expect(removed).toBeGreaterThanOrEqual(1);
    expect(await prisma.rateLimitBucket.findUnique({ where: { key: stale } })).toBeNull();
    expect(await prisma.rateLimitBucket.findUnique({ where: { key: fresh } })).not.toBeNull();
  });
});

import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { prisma } from "../src/lib/db";
import { resetRateLimits } from "../src/lib/rateLimit";
import { lookupAnonymousReport, submitAnonymousReport } from "../src/server/reports";

const meta = () => ({ requestId: randomUUID(), ipHash: null, userAgent: "vitest" });
const WRONG = "WRONGWRONGWRONGWRONGWRONGWRONGWRONGWRONGWRONGWRONGWR";
let referenceCode: string;
let accessSecret: string;

beforeAll(async () => {
  const inst = await prisma.institution.findFirstOrThrow({ where: { code: "NGU" } });
  const result = await submitAnonymousReport(
    inst.id,
    {
      title: "Anonymous lookup fixture",
      description: "A description long enough to satisfy the validation rules for a report.",
      severitySelfReported: "moderate",
      categoryId: null,
      locationId: null,
      occurredAt: null,
    },
    meta(),
  );
  referenceCode = result.referenceCode;
  accessSecret = result.accessSecret;
});

beforeEach(() => resetRateLimits());

describe("lookupAnonymousReport", () => {
  it("returns the status when code and secret both match", async () => {
    const view = await lookupAnonymousReport(referenceCode, accessSecret, meta());
    expect(view.referenceCode).toBe(referenceCode);
    expect(view.status).toBe("received");
  });

  it("accepts the secret without its grouping hyphens", async () => {
    const view = await lookupAnonymousReport(referenceCode, accessSecret.replace(/-/g, ""), meta());
    expect(view.referenceCode).toBe(referenceCode);
  });

  it("refuses a correct code with a wrong secret", async () => {
    await expect(lookupAnonymousReport(referenceCode, WRONG, meta())).rejects.toThrow(/no report was found/i);
  });

  it("gives the same error for an unknown code as for a wrong secret", async () => {
    await expect(lookupAnonymousReport("CR-ZZZZ-ZZZZ", accessSecret, meta())).rejects.toThrow(
      /no report was found/i,
    );
  });

  it("never exposes the description", async () => {
    const view = await lookupAnonymousReport(referenceCode, accessSecret, meta());
    expect(Object.keys(view)).not.toContain("description");
  });

  it("rate limits repeated attempts against one code", async () => {
    for (let i = 0; i < 5; i++) {
      await expect(lookupAnonymousReport(referenceCode, WRONG, meta())).rejects.toThrow();
    }
    await expect(lookupAnonymousReport(referenceCode, accessSecret, meta())).rejects.toThrow(
      /too many attempts/i,
    );
  });
});

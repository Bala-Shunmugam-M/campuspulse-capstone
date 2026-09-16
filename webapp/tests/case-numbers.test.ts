import { beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { prisma } from "../src/lib/db";
import { submitAnonymousReport } from "../src/server/reports";
import { triageReport } from "../src/server/cases";
import type { Actor } from "../src/lib/auth/rbac";

const meta = () => ({ requestId: randomUUID(), ipHash: null, userAgent: "vitest" });
const CONCURRENCY = 20;

let institutionId: string;
let officer: Actor;

async function aReport(): Promise<string> {
  const { referenceCode } = await submitAnonymousReport(
    institutionId,
    {
      title: "Concurrent triage fixture",
      description: "A description that comfortably exceeds the minimum length requirement.",
      severitySelfReported: "moderate",
      categoryId: null,
      locationId: null,
      occurredAt: null,
    },
    meta(),
  );
  const report = await prisma.report.findUniqueOrThrow({ where: { referenceCode } });
  return report.id;
}

beforeAll(async () => {
  const inst = await prisma.institution.findFirstOrThrow({ where: { code: "NGU" } });
  institutionId = inst.id;
  const account = await prisma.userAccount.findFirstOrThrow({
    where: { institutionId, roles: { some: { role: "officer", revokedAt: null } } },
    include: { roles: { where: { revokedAt: null } } },
  });
  officer = { accountId: account.id, institutionId, roles: account.roles.map((r) => r.role) };
});

describe("case number allocation under concurrency", () => {
  it("gives every concurrent triage a distinct case number", async () => {
    const reportIds = await Promise.all(
      Array.from({ length: CONCURRENCY }, () => aReport()),
    );

    // The whole point: these run at once. Allocation that reads a count and
    // adds one gives every caller the same answer.
    const results = await Promise.all(
      reportIds.map((id) =>
        triageReport(
          officer,
          id,
          { severity: "moderate", title: "Concurrent", confidentiality: "standard" },
          meta(),
        ),
      ),
    );

    const numbers = results.map((r) => r.caseNumber);
    expect(new Set(numbers).size).toBe(CONCURRENCY);
  });

  it("keeps case numbers unique per institution and year in the database", async () => {
    const dupes = await prisma.$queryRaw<{ n: bigint }[]>`
      SELECT count(*) AS n FROM (
        SELECT institution_id, case_number, count(*) AS c
        FROM compliance.cases
        GROUP BY institution_id, case_number
        HAVING count(*) > 1
      ) d`;
    expect(Number(dupes[0].n)).toBe(0);
  });
});

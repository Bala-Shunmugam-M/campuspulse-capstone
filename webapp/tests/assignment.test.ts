import { beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { prisma } from "../src/lib/db";
import { submitAnonymousReport } from "../src/server/reports";
import { assignCase, changeCaseStatus, listCases, triageReport } from "../src/server/cases";
import type { Actor } from "../src/lib/auth/rbac";

const meta = () => ({ requestId: randomUUID(), ipHash: null, userAgent: "vitest" });

let institutionId: string;
let admin: Actor;
let officerAccountId: string;
let foreignAccountId: string;

async function aCase(): Promise<string> {
  const { referenceCode } = await submitAnonymousReport(
    institutionId,
    {
      title: "Assignment fixture",
      description: "A description that comfortably exceeds the minimum length requirement.",
      severitySelfReported: "moderate",
      categoryId: null,
      locationId: null,
      occurredAt: null,
    },
    meta(),
  );
  const report = await prisma.report.findUniqueOrThrow({ where: { referenceCode } });
  const { caseNumber } = await triageReport(
    admin,
    report.id,
    { severity: "moderate", title: "Assignment fixture", confidentiality: "standard" },
    meta(),
  );
  const kase = await prisma.case.findFirstOrThrow({ where: { institutionId, caseNumber } });
  return kase.id;
}

beforeAll(async () => {
  const inst = await prisma.institution.findFirstOrThrow({ where: { code: "NGU" } });
  institutionId = inst.id;

  const adminAccount = await prisma.userAccount.findFirstOrThrow({
    where: { institutionId, roles: { some: { role: "admin", revokedAt: null } } },
  });
  admin = { accountId: adminAccount.id, institutionId, roles: ["admin"] };

  const officer = await prisma.userAccount.findFirstOrThrow({
    where: { institutionId, roles: { some: { role: "officer", revokedAt: null } } },
  });
  officerAccountId = officer.id;

  // Any account belonging to a different institution.
  const foreign = await prisma.userAccount.findFirstOrThrow({
    where: { institutionId: { not: institutionId } },
  });
  foreignAccountId = foreign.id;
});

describe("assignCase", () => {
  it("assigns and audits before and after", async () => {
    const id = await aCase();
    await assignCase(admin, id, officerAccountId, meta());

    const kase = await prisma.case.findUniqueOrThrow({ where: { id } });
    expect(kase.assignedOfficerId).toBe(officerAccountId);

    const audit = await prisma.auditEvent.findFirstOrThrow({
      where: { entityId: id, action: "case.assigned" },
      orderBy: { occurredAt: "desc" },
    });
    expect(audit.before).toMatchObject({ assignedOfficerId: null });
    expect(audit.after).toMatchObject({ assignedOfficerId: officerAccountId });
  });

  it("refuses an assignee from another institution", async () => {
    const id = await aCase();
    await expect(assignCase(admin, id, foreignAccountId, meta())).rejects.toThrow(
      /not permitted/i,
    );

    const kase = await prisma.case.findUniqueOrThrow({ where: { id } });
    expect(kase.assignedOfficerId).toBeNull();
  });

  it("allows unassignment and audits it", async () => {
    const id = await aCase();
    await assignCase(admin, id, officerAccountId, meta());
    await assignCase(admin, id, null, meta());

    const kase = await prisma.case.findUniqueOrThrow({ where: { id } });
    expect(kase.assignedOfficerId).toBeNull();
    expect(
      await prisma.auditEvent.count({ where: { entityId: id, action: "case.unassigned" } }),
    ).toBe(1);
  });
});

describe("first_response_at", () => {
  it("is set by the first assignment and never moved", async () => {
    const id = await aCase();
    expect((await prisma.case.findUniqueOrThrow({ where: { id } })).firstResponseAt).toBeNull();

    await assignCase(admin, id, officerAccountId, meta());
    const first = (await prisma.case.findUniqueOrThrow({ where: { id } })).firstResponseAt;
    expect(first).not.toBeNull();

    await assignCase(admin, id, null, meta());
    await changeCaseStatus(admin, id, "triaged", null, meta());

    const after = (await prisma.case.findUniqueOrThrow({ where: { id } })).firstResponseAt;
    expect(after?.getTime()).toBe(first?.getTime());
  });

  it("is set by a first status change when no assignment came first", async () => {
    const id = await aCase();
    await changeCaseStatus(admin, id, "triaged", null, meta());
    expect((await prisma.case.findUniqueOrThrow({ where: { id } })).firstResponseAt).not.toBeNull();
  });
});

describe("listCases assignee filter", () => {
  it("returns only cases assigned to the named account", async () => {
    const mine = await aCase();
    await aCase(); // left unassigned
    await assignCase(admin, mine, officerAccountId, meta());

    const rows = await listCases(admin, { assignedTo: officerAccountId });
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((c) => c.assignedOfficerId === officerAccountId)).toBe(true);
    expect(rows.map((c) => c.id)).toContain(mine);
  });

  it("returns only unassigned cases for \"unassigned\"", async () => {
    const loose = await aCase();
    const rows = await listCases(admin, { assignedTo: "unassigned" });
    expect(rows.every((c) => c.assignedOfficerId === null)).toBe(true);
    expect(rows.map((c) => c.id)).toContain(loose);
  });
});

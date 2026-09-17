import { beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { prisma } from "../src/lib/db";
import { submitAnonymousReport } from "../src/server/reports";
import { getCase, listCases, triageReport } from "../src/server/cases";
import type { Actor } from "../src/lib/auth/rbac";

const meta = () => ({ requestId: randomUUID(), ipHash: null, userAgent: "vitest" });
let institutionId: string;
let officer: Actor;
let reporter: Actor;

async function anActorWith(role: "officer" | "reporter"): Promise<Actor> {
  const account = await prisma.userAccount.findFirstOrThrow({
    where: { institutionId, roles: { some: { role, revokedAt: null } } },
    include: { roles: { where: { revokedAt: null } } },
  });
  return { accountId: account.id, institutionId, roles: account.roles.map((r) => r.role) };
}

async function aReport(): Promise<string> {
  const { referenceCode } = await submitAnonymousReport(
    institutionId,
    {
      title: "Case fixture report",
      description: "A description that comfortably exceeds the minimum length requirement.",
      severitySelfReported: "high",
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
  officer = await anActorWith("officer");
  reporter = await anActorWith("reporter");
});

describe("triageReport", () => {
  it("creates a case, links the report, and records the opening history row", async () => {
    const reportId = await aReport();
    const { caseNumber } = await triageReport(
      officer,
      reportId,
      { severity: "high", title: "Suspected paper leak", confidentiality: "standard" },
      meta(),
    );

    const kase = await prisma.case.findFirstOrThrow({
      where: { institutionId, caseNumber },
      include: { reports: true, statusHistory: true },
    });

    expect(kase.reports.map((r) => r.reportId)).toContain(reportId);
    expect(kase.statusHistory.map((h) => h.toStatus)).toContain("submitted");
    expect(kase.slaDueAt.getTime()).toBeGreaterThan(kase.openedAt.getTime());

    const report = await prisma.report.findUniqueOrThrow({ where: { id: reportId } });
    expect(report.status).toBe("triaged");
  });

  it("sets the SLA from severity, not from a constant", async () => {
    const severe = await triageReport(officer, await aReport(),
      { severity: "severe", title: "Severe", confidentiality: "standard" }, meta());
    const low = await triageReport(officer, await aReport(),
      { severity: "low", title: "Low", confidentiality: "standard" }, meta());

    const [s, l] = await Promise.all([
      prisma.case.findFirstOrThrow({ where: { institutionId, caseNumber: severe.caseNumber } }),
      prisma.case.findFirstOrThrow({ where: { institutionId, caseNumber: low.caseNumber } }),
    ]);

    const hours = (c: { openedAt: Date; slaDueAt: Date }) =>
      (c.slaDueAt.getTime() - c.openedAt.getTime()) / 3_600_000;

    expect(Math.round(hours(s))).toBe(24);
    expect(Math.round(hours(l))).toBe(336);
  });

  it("refuses a reporter", async () => {
    await expect(
      triageReport(reporter, await aReport(),
        { severity: "low", title: "Nope", confidentiality: "standard" }, meta()),
    ).rejects.toThrow(/not permitted/i);
  });
});

describe("listCases", () => {
  it("refuses a reporter", async () => {
    await expect(listCases(reporter, {})).rejects.toThrow(/not permitted/i);
  });

  it("returns only the actor's own institution", async () => {
    const { rows } = await listCases(officer, {});
    expect(rows.every((c) => c.institutionId === institutionId)).toBe(true);
  });
});

describe("getCase", () => {
  it("refuses a sealed case to an admin and allows it to a dpo", async () => {
    const { caseNumber } = await triageReport(officer, await aReport(),
      { severity: "high", title: "Sealed matter", confidentiality: "sealed" }, meta());
    const kase = await prisma.case.findFirstOrThrow({ where: { institutionId, caseNumber } });

    const adminActor: Actor = { ...officer, roles: ["admin"] };
    const dpoActor: Actor = { ...officer, roles: ["dpo"] };

    await expect(getCase(adminActor, kase.id)).rejects.toThrow(/not permitted/i);
    await expect(getCase(dpoActor, kase.id)).resolves.toBeDefined();
  });
});

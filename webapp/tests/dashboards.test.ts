import { beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { prisma } from "../src/lib/db";
import { submitAnonymousReport } from "../src/server/reports";
import { listCases, triageReport } from "../src/server/cases";
import { officerDashboard } from "../src/server/dashboards";
import { isOverdue } from "../src/lib/cases/sla";
import { ForbiddenError } from "../src/lib/errors";
import type { Actor } from "../src/lib/auth/rbac";

const meta = () => ({ requestId: randomUUID(), ipHash: null, userAgent: "vitest" });

let institutionId: string;
let officer: Actor;
let reporter: Actor;
let foreignOfficer: Actor;

async function actorWithRole(institutionCode: string, role: string): Promise<Actor> {
  const inst = await prisma.institution.findFirstOrThrow({ where: { code: institutionCode } });
  const account = await prisma.userAccount.findFirstOrThrow({
    where: {
      institutionId: inst.id,
      roles: { some: { role: role as never, revokedAt: null } },
    },
    include: { roles: { where: { revokedAt: null } } },
  });
  return {
    accountId: account.id,
    institutionId: inst.id,
    email: account.email,
    roles: account.roles.map((r) => r.role),
  };
}

async function aCase(title: string): Promise<string> {
  const { referenceCode } = await submitAnonymousReport(
    institutionId,
    {
      title,
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
    officer,
    report.id,
    { severity: "moderate", title, confidentiality: "standard" },
    meta(),
  );
  const kase = await prisma.case.findFirstOrThrow({ where: { institutionId, caseNumber } });
  return kase.id;
}

beforeAll(async () => {
  officer = await actorWithRole("NGU", "officer");
  reporter = await actorWithRole("NGU", "reporter");
  foreignOfficer = await actorWithRole("RIT", "officer");
  institutionId = officer.institutionId;

  // A known shape: one long overdue, one due soon, one far off and unassigned,
  // and one with a first response two hours after it opened.
  const marker = randomUUID().slice(0, 8);
  const overdue = await aCase(`DASH ${marker} overdue`);
  const soon = await aCase(`DASH ${marker} soon`);
  const later = await aCase(`DASH ${marker} later`);
  const responded = await aCase(`DASH ${marker} responded`);

  const now = Date.now();
  await prisma.case.update({
    where: { id: overdue },
    data: { slaDueAt: new Date("2020-01-01T00:00:00.000Z"), assignedOfficerId: officer.accountId },
  });
  await prisma.case.update({
    where: { id: soon },
    data: { slaDueAt: new Date(now + 6 * 3_600_000), assignedOfficerId: officer.accountId },
  });
  await prisma.case.update({
    where: { id: later },
    data: { slaDueAt: new Date(now + 30 * 24 * 3_600_000), assignedOfficerId: null },
  });
  await prisma.case.update({
    where: { id: responded },
    data: {
      openedAt: new Date("2026-03-01T09:00:00.000Z"),
      firstResponseAt: new Date("2026-03-01T11:00:00.000Z"),
      slaDueAt: new Date("2026-03-08T09:00:00.000Z"),
    },
  });
});

describe("officerDashboard", () => {
  it("refuses a reporter", async () => {
    await expect(officerDashboard(reporter)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("matches direct queries for every count", async () => {
    const dash = await officerDashboard(officer);

    // now() AT TIME ZONE 'UTC', not a bare now(): sla_due_at is `timestamp`
    // without time zone holding the UTC wall clock, so a bare now() compares it
    // against the session's local time and calls cases overdue hours early.
    const [direct] = await prisma.$queryRaw<
      { mine: bigint; overdue: bigint; due_soon: bigint; unassigned: bigint }[]
    >`
      SELECT
        count(*) FILTER (WHERE assigned_officer_id = ${officer.accountId}::uuid
                           AND status NOT IN ('resolved','closed')) AS mine,
        count(*) FILTER (WHERE sla_due_at < (now() AT TIME ZONE 'UTC')
                           AND status NOT IN ('resolved','closed')) AS overdue,
        count(*) FILTER (WHERE sla_due_at >= (now() AT TIME ZONE 'UTC')
                           AND sla_due_at < (now() AT TIME ZONE 'UTC') + interval '24 hours'
                           AND status NOT IN ('resolved','closed')) AS due_soon,
        count(*) FILTER (WHERE assigned_officer_id IS NULL
                           AND status NOT IN ('resolved','closed')) AS unassigned
      FROM compliance.cases
      WHERE institution_id = ${institutionId}::uuid
        AND deleted_at IS NULL
        AND confidentiality <> 'sealed'`;

    expect(dash.mine).toBe(Number(direct.mine));
    expect(dash.overdue).toBe(Number(direct.overdue));
    expect(dash.unassigned).toBe(Number(direct.unassigned));
    // dueSoon is a moving window, so allow the clock to have ticked between the
    // two queries rather than asserting an equality that can only be flaky.
    expect(Math.abs(dash.dueSoon - Number(direct.due_soon))).toBeLessThanOrEqual(1);

    expect(dash.overdue).toBeGreaterThan(0);
    expect(dash.unassigned).toBeGreaterThan(0);
  });

  it("counts every status, and the total matches the visible cases", async () => {
    const dash = await officerDashboard(officer);
    const total = dash.byStatus.reduce((sum, row) => sum + row.count, 0);

    const [direct] = await prisma.$queryRaw<{ n: bigint }[]>`
      SELECT count(*) AS n FROM compliance.cases
      WHERE institution_id = ${institutionId}::uuid
        AND deleted_at IS NULL AND confidentiality <> 'sealed'`;

    expect(total).toBe(Number(direct.n));
    expect(dash.byStatus.length).toBeGreaterThan(0);
  });

  it("agrees with listCases about which cases are overdue", async () => {
    // The whole point of sharing one predicate: the headline figure and the
    // list it links to must not disagree.
    const asOf = new Date();
    const dash = await officerDashboard(officer);

    let counted = 0;
    let cursor: string | undefined;
    for (let guard = 0; guard < 200; guard++) {
      const page = await listCases(officer, { cursor, limit: 500 });
      counted += page.rows.filter((c) => isOverdue(c.slaDueAt, c.status, asOf)).length;
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }

    expect(counted).toBe(dash.overdue);
  });

  it("reports the median first response in hours", async () => {
    const dash = await officerDashboard(officer);
    expect(dash.medianFirstResponseHours).not.toBeNull();
    expect(dash.medianFirstResponseHours).toBeGreaterThan(0);

    const [direct] = await prisma.$queryRaw<{ median_hours: number | null }[]>`
      SELECT percentile_cont(0.5) WITHIN GROUP (
        ORDER BY EXTRACT(EPOCH FROM (first_response_at - opened_at)) / 3600.0
      ) AS median_hours
      FROM compliance.cases
      WHERE institution_id = ${institutionId}::uuid
        AND deleted_at IS NULL AND confidentiality <> 'sealed'
        AND first_response_at IS NOT NULL`;

    expect(dash.medianFirstResponseHours).toBeCloseTo(Number(direct.median_hours), 6);
  });

  it("shows an officer only their own institution", async () => {
    const mine = await officerDashboard(officer);
    const theirs = await officerDashboard(foreignOfficer);

    const [mineDirect] = await prisma.$queryRaw<{ n: bigint }[]>`
      SELECT count(*) AS n FROM compliance.cases
      WHERE institution_id = ${institutionId}::uuid
        AND deleted_at IS NULL AND confidentiality <> 'sealed'`;
    const [theirsDirect] = await prisma.$queryRaw<{ n: bigint }[]>`
      SELECT count(*) AS n FROM compliance.cases
      WHERE institution_id = ${foreignOfficer.institutionId}::uuid
        AND deleted_at IS NULL AND confidentiality <> 'sealed'`;

    expect(mine.byStatus.reduce((s, r) => s + r.count, 0)).toBe(Number(mineDirect.n));
    expect(theirs.byStatus.reduce((s, r) => s + r.count, 0)).toBe(Number(theirsDirect.n));
  });

  it("excludes sealed cases, so a count cannot betray one", async () => {
    const before = await officerDashboard(officer);

    const { referenceCode } = await submitAnonymousReport(
      institutionId,
      {
        title: "Sealed dashboard fixture",
        description: "A description that comfortably exceeds the minimum length requirement.",
        severitySelfReported: "severe",
        categoryId: null,
        locationId: null,
        occurredAt: null,
      },
      meta(),
    );
    const report = await prisma.report.findUniqueOrThrow({ where: { referenceCode } });
    await triageReport(
      officer,
      report.id,
      { severity: "severe", title: "Sealed dashboard fixture", confidentiality: "sealed" },
      meta(),
    );

    const after = await officerDashboard(officer);
    expect(after.byStatus.reduce((s, r) => s + r.count, 0)).toBe(
      before.byStatus.reduce((s, r) => s + r.count, 0),
    );
  });
});

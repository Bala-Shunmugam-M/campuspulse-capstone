import { beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { prisma } from "../src/lib/db";
import { submitAnonymousReport } from "../src/server/reports";
import { changeCaseStatus, listCases, triageReport } from "../src/server/cases";
import { recordOutcome } from "../src/server/outcomes";
import { adminDashboard, officerDashboard } from "../src/server/dashboards";
import { isOverdue } from "../src/lib/cases/sla";
import { ForbiddenError } from "../src/lib/errors";
import type { Actor } from "../src/lib/auth/rbac";

const meta = () => ({ requestId: randomUUID(), ipHash: null, userAgent: "vitest", at: new Date() });

let institutionId: string;
let officer: Actor;
let reporter: Actor;
let foreignOfficer: Actor;
let admin: Actor;
/** A case closed after its SLA fell due, and one closed before. */
let breachedCaseId: string;

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

/**
 * Take a case all the way to closed through the real transitions.
 *
 * Setting status = 'closed' with an UPDATE is quicker and produces a case with
 * no status history and no outcome -- data that looks plausible and is
 * structurally impossible, which is exactly what verify.ts exists to catch and
 * exactly why the simulator drives endpoints rather than writing rows.
 */
async function closeProperly(caseId: string): Promise<void> {
  await changeCaseStatus(officer, caseId, "triaged", null, meta());
  await changeCaseStatus(officer, caseId, "under_investigation", null, meta());
  await changeCaseStatus(officer, caseId, "pending_decision", null, meta());
  await recordOutcome(
    officer,
    caseId,
    { finding: "upheld", rationale: "Recorded by the dashboard fixture." },
    meta(),
  );
  await changeCaseStatus(officer, caseId, "closed", null, meta());
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
    data: {
      // openedAt moves with it: an SLA that falls due before its case opened is
      // an invariant violation, not a fixture.
      openedAt: new Date("2019-12-25T00:00:00.000Z"),
      slaDueAt: new Date("2020-01-01T00:00:00.000Z"),
      assignedOfficerId: officer.accountId,
    },
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

  admin = await actorWithRole("NGU", "admin");

  // One case resolved after its stored SLA fell due, one comfortably before.
  breachedCaseId = await aCase(`DASH ${marker} breached`);
  const met = await aCase(`DASH ${marker} met`);
  await closeProperly(breachedCaseId);
  await closeProperly(met);

  // Only the dates are rewritten afterwards, never the status: the history rows
  // and the outcome the transitions produced stay exactly as they were.
  await prisma.case.update({
    where: { id: breachedCaseId },
    data: {
      severity: "low",
      openedAt: new Date("2026-02-01T09:00:00.000Z"),
      slaDueAt: new Date("2026-02-02T09:00:00.000Z"),
      firstResponseAt: new Date("2026-02-01T10:00:00.000Z"),
      resolvedAt: new Date("2026-02-20T09:00:00.000Z"),
      closedAt: new Date("2026-02-21T09:00:00.000Z"),
    },
  });
  await prisma.case.update({
    where: { id: met },
    data: {
      severity: "low",
      openedAt: new Date("2026-02-01T09:00:00.000Z"),
      slaDueAt: new Date("2026-02-20T09:00:00.000Z"),
      firstResponseAt: new Date("2026-02-01T10:00:00.000Z"),
      resolvedAt: new Date("2026-02-02T09:00:00.000Z"),
      closedAt: new Date("2026-02-03T09:00:00.000Z"),
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

describe("adminDashboard", () => {
  it("is open to admin and dpo and closed to everyone else", async () => {
    await expect(adminDashboard(admin)).resolves.toBeDefined();
    await expect(adminDashboard(officer)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(adminDashboard(reporter)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("computes the breach rate from stored values, not current severity policy", async () => {
    const before = await adminDashboard(admin);
    expect(before.slaBreachRate.total).toBeGreaterThan(0);
    expect(before.slaBreachRate.count).toBeGreaterThan(0);

    // Re-grade the case as severely as the vocabulary allows. Under an
    // implementation that recomputed the due date from today's SLA_HOURS this
    // would flip whether the case breached; reading the stored sla_due_at, it
    // cannot.
    await prisma.case.update({ where: { id: breachedCaseId }, data: { severity: "severe" } });
    const afterSeverity = await adminDashboard(admin);
    expect(afterSeverity.slaBreachRate).toEqual(before.slaBreachRate);

    // And the policy table itself: multiply every SLA by a thousand and the
    // figure still does not move, because the dashboard never consults it.
    vi.resetModules();
    vi.doMock("../src/server/cases", async (importOriginal) => {
      const original = await importOriginal<typeof import("../src/server/cases")>();
      return {
        ...original,
        SLA_HOURS: { severe: 24_000, high: 72_000, moderate: 168_000, low: 336_000 },
      };
    });
    const reloaded = await import("../src/server/dashboards");
    const afterPolicy = await reloaded.adminDashboard(admin);
    vi.doUnmock("../src/server/cases");
    vi.resetModules();

    expect(afterPolicy.slaBreachRate).toEqual(before.slaBreachRate);
  });

  it("matches a direct query for the breach rate", async () => {
    const dash = await adminDashboard(admin);

    const [direct] = await prisma.$queryRaw<{ closed: bigint; breached: bigint }[]>`
      SELECT count(*) AS closed,
             count(*) FILTER (WHERE resolved_at > sla_due_at) AS breached
      FROM compliance.cases
      WHERE institution_id = ${institutionId}::uuid
        AND deleted_at IS NULL AND confidentiality <> 'sealed'
        AND status IN ('resolved','closed') AND resolved_at IS NOT NULL`;

    expect(dash.slaBreachRate.total).toBe(Number(direct.closed));
    expect(dash.slaBreachRate.count).toBe(Number(direct.breached));
    expect(dash.slaBreachRate.percent).toBeCloseTo(
      (Number(direct.breached) / Number(direct.closed)) * 100,
      6,
    );
  });

  it("carries the denominator with every percentage", async () => {
    const dash = await adminDashboard(admin);

    // A bare "68%" invites the wrong conclusion when n is 12, so no proportion
    // is reported without the count it came from.
    for (const s of [dash.slaBreachRate, dash.anonymousShare]) {
      expect(s).toHaveProperty("count");
      expect(s).toHaveProperty("total");
      expect(s.count).toBeLessThanOrEqual(s.total);
      expect(s.percent).toBeCloseTo((s.count / s.total) * 100, 6);
    }

    for (const row of dash.outcomeMix) {
      expect(row.total).toBeGreaterThan(0);
      expect(row.percent).toBeCloseTo((row.count / row.total) * 100, 6);
    }
    expect(dash.outcomeMix.reduce((s, r) => s + r.count, 0)).toBe(
      dash.outcomeMix[0]?.total ?? 0,
    );

    for (const row of dash.policyCoverage) {
      expect(row.required).toBeGreaterThan(0);
      expect(row.done).toBeLessThanOrEqual(row.required);
      expect(row.percent).toBeCloseTo((row.done / row.required) * 100, 6);
    }
  });

  it("reports nothing rather than 0% when there is nothing to report", async () => {
    // 0/0 is not zero per cent. An institution with no reports must not be shown
    // a confident "0% anonymous".
    const inst = await prisma.institution.findFirstOrThrow({ where: { code: "WFC" } });
    const account = await prisma.userAccount.findFirstOrThrow({
      where: { institutionId: inst.id, roles: { some: { role: "admin", revokedAt: null } } },
    });
    const wfcAdmin: Actor = {
      accountId: account.id,
      institutionId: inst.id,
      email: account.email,
      roles: ["admin"],
    };

    const dash = await adminDashboard(wfcAdmin);
    for (const s of [dash.slaBreachRate, dash.anonymousShare]) {
      if (s.total === 0) expect(s.percent).toBeNull();
    }
  });

  it("reports the anonymous share against every report in the institution", async () => {
    const dash = await adminDashboard(admin);

    const [direct] = await prisma.$queryRaw<{ anonymous: bigint; total: bigint }[]>`
      SELECT count(*) FILTER (WHERE is_anonymous) AS anonymous, count(*) AS total
      FROM compliance.reports
      WHERE institution_id = ${institutionId}::uuid AND deleted_at IS NULL`;

    expect(dash.anonymousShare.count).toBe(Number(direct.anonymous));
    expect(dash.anonymousShare.total).toBe(Number(direct.total));
  });

  it("lists every officer's workload, including officers holding nothing", async () => {
    const dash = await adminDashboard(admin);

    const [officers] = await prisma.$queryRaw<{ n: bigint }[]>`
      SELECT count(DISTINCT ua.id) AS n
      FROM compliance.user_accounts ua
      JOIN compliance.role_assignments ra
        ON ra.user_account_id = ua.id AND ra.revoked_at IS NULL AND ra.role = 'officer'
      WHERE ua.institution_id = ${institutionId}::uuid AND ua.deleted_at IS NULL`;

    expect(dash.officerWorkload.length).toBe(Number(officers.n));
    expect(dash.officerWorkload.every((w) => w.email.includes("@"))).toBe(true);
    expect(dash.officerWorkload.every((w) => w.overdue <= w.open)).toBe(true);

    // Sorted by load, heaviest first, so the page reads top-down.
    const loads = dash.officerWorkload.map((w) => w.open);
    expect([...loads].sort((a, b) => b - a)).toEqual(loads);
  });

  it("plots intake by week and covers every policy in force", async () => {
    const dash = await adminDashboard(admin);

    expect(dash.intakeByWeek.length).toBeGreaterThan(0);
    expect(dash.intakeByWeek.every((w) => w.reports > 0)).toBe(true);
    const weeks = dash.intakeByWeek.map((w) => w.weekStarting.getTime());
    expect([...weeks].sort((a, b) => a - b)).toEqual(weeks);

    const [live] = await prisma.$queryRaw<{ n: bigint }[]>`
      SELECT count(*) AS n FROM compliance.policies p
      WHERE p.institution_id = ${institutionId}::uuid AND p.is_active
        AND EXISTS (
          SELECT 1 FROM compliance.policy_versions v
          WHERE v.policy_id = p.id AND v.published_at IS NOT NULL
            AND v.effective_from <= current_date
            AND (v.effective_to IS NULL OR v.effective_to > current_date))`;
    expect(dash.policyCoverage.length).toBe(Number(live.n));
    expect(dash.policyCoverage.some((p) => p.code === "ACAD-01")).toBe(true);
  });

  it("shows an admin only their own institution", async () => {
    const other = await prisma.institution.findFirstOrThrow({ where: { code: "RIT" } });
    const account = await prisma.userAccount.findFirstOrThrow({
      where: { institutionId: other.id, roles: { some: { role: "admin", revokedAt: null } } },
    });
    const ritAdmin: Actor = {
      accountId: account.id,
      institutionId: other.id,
      email: account.email,
      roles: ["admin"],
    };

    const mine = await adminDashboard(admin);
    const theirs = await adminDashboard(ritAdmin);

    const mineIds = mine.officerWorkload.map((w) => w.accountId);
    expect(theirs.officerWorkload.every((w) => !mineIds.includes(w.accountId))).toBe(true);
    expect(theirs.anonymousShare.total).not.toBe(mine.anonymousShare.total);
  });
});

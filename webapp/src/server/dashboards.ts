import { Prisma, type CaseStatus } from "@prisma/client";
import { prisma } from "@/lib/db";
import { requireRole, type Actor } from "@/lib/auth/rbac";
import { SETTLED_STATUSES } from "@/lib/cases/sla";

/**
 * Dashboard aggregates.
 *
 * Every figure below is computed by Postgres. Fetching every case and counting
 * them in a loop is the version that works on seed data and dies on simulator
 * data, and these numbers exist precisely to be looked at once there are
 * thousands of cases.
 */

/** A case due inside this many hours is "due soon" rather than merely open. */
const DUE_SOON_HOURS = 24;

export type OfficerDashboard = {
  mine: number;
  overdue: number;
  dueSoon: number;
  unassigned: number;
  byStatus: { status: CaseStatus; count: number }[];
  /** null when no case has had a first response yet. */
  medianFirstResponseHours: number | null;
};

/**
 * The rows any dashboard counts: this institution, not deleted, not sealed.
 *
 * Sealed cases are excluded for the same reason the queue excludes them -- a
 * count that includes them lets someone infer the existence of a case they are
 * not permitted to see, which is most of what sealing is for.
 */
function visibleCases(institutionId: string): Prisma.Sql {
  return Prisma.sql`
    FROM compliance.cases c
    WHERE c.institution_id = ${institutionId}::uuid
      AND c.deleted_at IS NULL
      AND c.confidentiality <> 'sealed'`;
}

/**
 * "The SLA clock is still running." The statuses come from the same constant
 * isOverdue uses in TypeScript, so the dashboard cannot drift away from the
 * queue it links to -- which is what two hand-written copies of this predicate
 * would eventually do.
 */
const stillRunning = Prisma.sql`NOT (c.status::text = ANY(${SETTLED_STATUSES}))`;

/**
 * A moment, expressed the way the timestamp columns actually hold time.
 *
 * cases.sla_due_at is `timestamp` WITHOUT time zone and Prisma writes the UTC
 * wall clock into it. A bare `now()`, or a JS Date sent as timestamptz, makes
 * Postgres reinterpret those naive values in the session's time zone -- on a
 * machine at UTC+05:30 that declared five cases overdue five and a half hours
 * early, and the dashboard disagreed with the queue it links to. Converting the
 * instant to its UTC wall clock compares like with like.
 */
function atUtc(moment: Date): Prisma.Sql {
  return Prisma.sql`(${moment}::timestamptz AT TIME ZONE 'UTC')`;
}

export async function officerDashboard(actor: Actor): Promise<OfficerDashboard> {
  requireRole(actor, ["officer", "investigator", "admin", "dpo"]);

  const asOf = atUtc(new Date());
  const dueSoonBy = atUtc(new Date(Date.now() + DUE_SOON_HOURS * 3_600_000));
  const scope = visibleCases(actor.institutionId);

  const [counts] = await prisma.$queryRaw<
    { mine: bigint; overdue: bigint; due_soon: bigint; unassigned: bigint }[]
  >(Prisma.sql`
    SELECT
      count(*) FILTER (
        WHERE c.assigned_officer_id = ${actor.accountId}::uuid AND ${stillRunning}
      ) AS mine,
      count(*) FILTER (
        WHERE c.sla_due_at < ${asOf} AND ${stillRunning}
      ) AS overdue,
      count(*) FILTER (
        WHERE c.sla_due_at >= ${asOf} AND c.sla_due_at < ${dueSoonBy} AND ${stillRunning}
      ) AS due_soon,
      count(*) FILTER (
        WHERE c.assigned_officer_id IS NULL AND ${stillRunning}
      ) AS unassigned
    ${scope}`);

  const byStatus = await prisma.$queryRaw<{ status: string; n: bigint }[]>(Prisma.sql`
    SELECT c.status::text AS status, count(*) AS n
    ${scope}
    GROUP BY c.status
    ORDER BY c.status`);

  // Median rather than mean: one case left open over a holiday should not move
  // the headline number, and with a long tail the mean reports a latency nobody
  // actually experienced.
  const [median] = await prisma.$queryRaw<{ median_hours: number | null }[]>(Prisma.sql`
    SELECT percentile_cont(0.5) WITHIN GROUP (
      ORDER BY EXTRACT(EPOCH FROM (c.first_response_at - c.opened_at)) / 3600.0
    ) AS median_hours
    ${scope}
      AND c.first_response_at IS NOT NULL`);

  return {
    mine: Number(counts.mine),
    overdue: Number(counts.overdue),
    dueSoon: Number(counts.due_soon),
    unassigned: Number(counts.unassigned),
    byStatus: byStatus.map((r) => ({ status: r.status as CaseStatus, count: Number(r.n) })),
    medianFirstResponseHours:
      median?.median_hours === null || median?.median_hours === undefined
        ? null
        : Number(median.median_hours),
  };
}

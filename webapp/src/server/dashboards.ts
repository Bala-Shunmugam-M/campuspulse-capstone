import { Prisma, type CaseStatus } from "@prisma/client";
import { prisma } from "@/lib/db";
import { requireRole, type Actor } from "@/lib/auth/rbac";
import { SETTLED_STATUSES } from "@/lib/cases/sla";
import { now } from "@/lib/clock";

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

/** A proportion that always travels with the denominator it was drawn from. */
export type Share = {
  count: number;
  total: number;
  /** null when total is 0: 0/0 is not 0%, it is "nothing to report". */
  percent: number | null;
};

export type AdminDashboard = {
  intakeByWeek: { weekStarting: Date; reports: number }[];
  slaBreachRate: Share;
  officerWorkload: { accountId: string; email: string; open: number; overdue: number }[];
  outcomeMix: { finding: string; count: number; total: number; percent: number | null }[];
  policyCoverage: {
    policyId: string;
    code: string;
    title: string;
    versionNo: number;
    done: number;
    required: number;
    percent: number | null;
  }[];
  anonymousShare: Share;
};

function share(count: number, total: number): Share {
  return { count, total, percent: total === 0 ? null : (count / total) * 100 };
}

export async function officerDashboard(actor: Actor): Promise<OfficerDashboard> {
  requireRole(actor, ["officer", "investigator", "admin", "dpo"]);

  const asOf = atUtc(now());
  const dueSoonBy = atUtc(new Date(now().getTime() + DUE_SOON_HOURS * 3_600_000));
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

/** How many weeks of intake the admin dashboard plots. */
const INTAKE_WEEKS = 12;

export async function adminDashboard(actor: Actor): Promise<AdminDashboard> {
  requireRole(actor, ["admin", "dpo"]);

  const institutionId = actor.institutionId;
  const scope = visibleCases(institutionId);
  const since = atUtc(new Date(now().getTime() - INTAKE_WEEKS * 7 * 24 * 3_600_000));

  const intake = await prisma.$queryRaw<{ week_starting: Date; n: bigint }[]>(Prisma.sql`
    SELECT date_trunc('week', r.submitted_at) AS week_starting, count(*) AS n
    FROM compliance.reports r
    WHERE r.institution_id = ${institutionId}::uuid
      AND r.deleted_at IS NULL
      AND r.submitted_at >= ${since}
    GROUP BY 1
    ORDER BY 1`);

  // Breach is read from what was stored when the case was opened: sla_due_at
  // against resolved_at. Phase 1 stored sla_due_at precisely so that changing
  // the severity policy later cannot rewrite whether past cases breached. A
  // dashboard that recomputed the due date from today's SLA_HOURS would throw
  // that away and quietly restate history every time the policy is tuned.
  const [breach] = await prisma.$queryRaw<{ closed: bigint; breached: bigint }[]>(Prisma.sql`
    SELECT
      count(*) AS closed,
      count(*) FILTER (WHERE c.resolved_at > c.sla_due_at) AS breached
    ${scope}
      AND c.status IN ('resolved', 'closed')
      AND c.resolved_at IS NOT NULL`);

  const workload = await prisma.$queryRaw<
    { account_id: string; email: string; open: bigint; overdue: bigint }[]
  >(Prisma.sql`
    SELECT ua.id AS account_id, ua.email,
           count(c.id) FILTER (WHERE ${stillRunning}) AS open,
           count(c.id) FILTER (
             WHERE ${stillRunning} AND c.sla_due_at < ${atUtc(now())}
           ) AS overdue
    FROM compliance.user_accounts ua
    JOIN compliance.role_assignments ra
      ON ra.user_account_id = ua.id AND ra.revoked_at IS NULL AND ra.role = 'officer'
    LEFT JOIN compliance.cases c
      ON c.assigned_officer_id = ua.id
     AND c.deleted_at IS NULL
     AND c.confidentiality <> 'sealed'
    WHERE ua.institution_id = ${institutionId}::uuid AND ua.deleted_at IS NULL
    GROUP BY ua.id, ua.email
    ORDER BY open DESC, ua.email`);

  const outcomes = await prisma.$queryRaw<{ finding: string; n: bigint }[]>(Prisma.sql`
    SELECT o.finding::text AS finding, count(*) AS n
    FROM compliance.outcomes o
    JOIN compliance.cases c ON c.id = o.case_id
    WHERE c.institution_id = ${institutionId}::uuid
      AND c.deleted_at IS NULL
      AND c.confidentiality <> 'sealed'
    GROUP BY o.finding
    ORDER BY n DESC`);

  const [anonymous] = await prisma.$queryRaw<{ anonymous: bigint; total: bigint }[]>(Prisma.sql`
    SELECT count(*) FILTER (WHERE r.is_anonymous) AS anonymous, count(*) AS total
    FROM compliance.reports r
    WHERE r.institution_id = ${institutionId}::uuid AND r.deleted_at IS NULL`);

  const [accounts] = await prisma.$queryRaw<{ n: bigint }[]>(Prisma.sql`
    SELECT count(*) AS n FROM compliance.user_accounts
    WHERE institution_id = ${institutionId}::uuid AND deleted_at IS NULL`);
  const required = Number(accounts.n);

  // Coverage is measured against the version live today, so it resets when a
  // policy is superseded -- the only honest reading of "has everyone read the
  // current rules".
  const coverage = await prisma.$queryRaw<
    { policy_id: string; code: string; title: string; version_no: number; done: bigint }[]
  >(Prisma.sql`
    SELECT p.id AS policy_id, p.code, p.title, v.version_no,
           (SELECT count(*) FROM compliance.policy_acknowledgements a
             WHERE a.policy_version_id = v.id) AS done
    FROM compliance.policies p
    JOIN LATERAL (
      SELECT id, version_no FROM compliance.policy_versions
      WHERE policy_id = p.id
        AND published_at IS NOT NULL
        AND effective_from <= current_date
        AND (effective_to IS NULL OR effective_to > current_date)
      ORDER BY version_no DESC LIMIT 1
    ) v ON true
    WHERE p.institution_id = ${institutionId}::uuid AND p.is_active
    ORDER BY p.code`);

  const outcomeTotal = outcomes.reduce((sum, row) => sum + Number(row.n), 0);

  return {
    intakeByWeek: intake.map((r) => ({
      weekStarting: r.week_starting,
      reports: Number(r.n),
    })),
    slaBreachRate: share(Number(breach.breached), Number(breach.closed)),
    officerWorkload: workload.map((r) => ({
      accountId: r.account_id,
      email: r.email,
      open: Number(r.open),
      overdue: Number(r.overdue),
    })),
    outcomeMix: outcomes.map((r) => {
      const s = share(Number(r.n), outcomeTotal);
      return { finding: r.finding, count: s.count, total: s.total, percent: s.percent };
    }),
    policyCoverage: coverage.map((r) => {
      const s = share(Number(r.done), required);
      return {
        policyId: r.policy_id,
        code: r.code,
        title: r.title,
        versionNo: Number(r.version_no),
        done: s.count,
        required: s.total,
        percent: s.percent,
      };
    }),
    anonymousShare: share(Number(anonymous.anonymous), Number(anonymous.total)),
  };
}

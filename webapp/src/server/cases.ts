import type { CaseStatus, Confidentiality, Severity } from "@prisma/client";
import { prisma } from "@/lib/db";
import { withAudit } from "@/lib/audit/withAudit";
import { requireRole, requireSameInstitution, type Actor } from "@/lib/auth/rbac";
import { ForbiddenError, InvalidTransitionError, NotFoundError } from "@/lib/errors";
import { canTransition } from "@/lib/cases/transitions";
import { caseAudience, notify } from "@/lib/notify";
import { decodeCursor, pageSize, toPage, type Page } from "@/lib/pagination";
import { now } from "@/lib/clock";
import type { RequestMeta } from "@/server/accounts";

/** Hours allowed before a case is overdue, by severity. */
/**
 * Exported so a test can change it and show that figures drawn from stored
 * sla_due_at do not move. This table is the policy applied at triage; it has no
 * say over cases already opened, and the dashboards must not consult it.
 */
export const SLA_HOURS: Record<Severity, number> = {
  severe: 24,
  high: 72,
  moderate: 168,
  low: 336,
};

export type TriageInput = {
  severity: Severity;
  title: string;
  confidentiality: Confidentiality;
};

export type CaseFilter = {
  status?: CaseStatus;
  severity?: Severity;
  /** An account id, "me" for the actor, or "unassigned". */
  assignedTo?: string;
  /** Opaque keyset cursor from a previous page's nextCursor. */
  cursor?: string;
  limit?: number;
};

// "Overdue" is defined once, in @/lib/cases/sla, and shared by the queue, the
// case page and the dashboards.

export type CaseSummary = {
  id: string;
  institutionId: string;
  caseNumber: string;
  title: string;
  severity: Severity;
  status: CaseStatus;
  slaDueAt: Date;
  assignedOfficerId: string | null;
};

export async function triageReport(
  actor: Actor,
  reportId: string,
  input: TriageInput,
  meta: RequestMeta,
): Promise<{ caseNumber: string }> {
  requireRole(actor, ["officer", "admin"]);

  const report = await prisma.report.findFirst({ where: { id: reportId, deletedAt: null } });
  if (!report) throw new NotFoundError("That report does not exist.");
  requireSameInstitution(actor, report.institutionId);

  const openedAt = now();
  const year = openedAt.getUTCFullYear();
  const slaDueAt = new Date(openedAt.getTime() + SLA_HOURS[input.severity] * 3_600_000);

  const caseNumber = await prisma.$transaction(async (tx) => {
    // Allocated by the database rather than by counting rows. A count-and-add-one
    // hands every concurrent triage the same answer; the function takes a row
    // lock on the counter, so callers serialise instead of colliding.
    const [allocated] = await tx.$queryRaw<{ next_case_number: string }[]>`
      SELECT compliance.next_case_number(${report.institutionId}::uuid, ${year}::int) AS next_case_number`;
    const number = allocated.next_case_number;

    const created = await tx.case.create({
      data: {
        institutionId: report.institutionId,
        caseNumber: number,
        title: input.title,
        categoryId: report.categoryId,
        severity: input.severity,
        confidentiality: input.confidentiality,
        status: "submitted",
        openedAt,
        slaDueAt,
      },
    });

    await tx.caseReport.create({
      data: { caseId: created.id, reportId: report.id, isPrimary: true },
    });
    await tx.report.update({ where: { id: report.id }, data: { status: "triaged" } });
    await tx.caseStatusHistory.create({
      data: {
        caseId: created.id,
        fromStatus: null,
        toStatus: "submitted",
        changedById: actor.accountId,
        changedAt: openedAt,
      },
    });
    await withAudit(
      tx,
      {
        actorAccountId: actor.accountId,
        actorLabel: actor.email,
        institutionId: report.institutionId,
        requestId: meta.requestId,
        ipHash: meta.ipHash,
        userAgent: meta.userAgent,
      },
      {
        action: "case.opened",
        entityType: "case",
        entityId: created.id,
        after: { caseNumber: number, severity: input.severity, slaDueAt },
      },
    );

    return number;
  });

  return { caseNumber };
}

function assigneeWhere(actor: Actor, assignedTo: string | undefined) {
  if (!assignedTo) return {};
  if (assignedTo === "unassigned") return { assignedOfficerId: null };
  return { assignedOfficerId: assignedTo === "me" ? actor.accountId : assignedTo };
}

/**
 * A page of the case queue, most urgent first.
 *
 * Ordered by (sla_due_at, id) and walked by keyset rather than OFFSET: the queue
 * reorders as SLAs pass and as cases are triaged, and offset paging over a
 * moving list drops rows. The id is part of the order so that cases sharing a
 * due date have one definite sequence rather than whatever the planner chose
 * this time.
 */
export async function listCases(
  actor: Actor,
  filter: CaseFilter,
): Promise<Page<CaseSummary>> {
  requireRole(actor, ["officer", "investigator", "admin"]);

  const limit = pageSize(filter.limit);
  const cursor = decodeCursor(filter.cursor);
  const after = cursor ? new Date(cursor.key) : null;
  const usable = after && !Number.isNaN(after.getTime()) ? { at: after, id: cursor!.id } : null;

  const rows = await prisma.case.findMany({
    where: {
      institutionId: actor.institutionId,
      deletedAt: null,
      status: filter.status,
      severity: filter.severity,
      ...assigneeWhere(actor, filter.assignedTo),
      // Sealed cases never appear in a queue; only a dpo reaches them by id.
      confidentiality: { not: "sealed" },
      ...(usable
        ? {
            OR: [
              { slaDueAt: { gt: usable.at } },
              { slaDueAt: usable.at, id: { gt: usable.id } },
            ],
          }
        : {}),
    },
    orderBy: [{ slaDueAt: "asc" }, { id: "asc" }],
    // One more than asked for: the extra row is how we know a further page
    // exists, without a COUNT that could disagree with this query.
    take: limit + 1,
  });

  return toPage(
    rows.map((c) => ({
      id: c.id,
      institutionId: c.institutionId,
      caseNumber: c.caseNumber,
      title: c.title,
      severity: c.severity,
      status: c.status,
      slaDueAt: c.slaDueAt,
      assignedOfficerId: c.assignedOfficerId,
    })),
    limit,
    (row) => ({ key: row.slaDueAt.toISOString(), id: row.id }),
  );
}

export async function getCase(actor: Actor, caseId: string) {
  requireRole(actor, ["officer", "investigator", "admin", "dpo"]);

  const kase = await prisma.case.findFirst({
    where: { id: caseId, deletedAt: null },
    include: { statusHistory: { orderBy: { changedAt: "asc" } } },
  });
  if (!kase) throw new NotFoundError("That case does not exist.");
  requireSameInstitution(actor, kase.institutionId);

  // A seal an admin can lift is decorative, and the cases most worth sealing
  // are the ones involving an admin.
  if (kase.confidentiality === "sealed" && !actor.roles.includes("dpo")) {
    throw new ForbiddenError("You are not permitted to access this record.");
  }

  return {
    id: kase.id,
    institutionId: kase.institutionId,
    caseNumber: kase.caseNumber,
    title: kase.title,
    severity: kase.severity,
    status: kase.status,
    slaDueAt: kase.slaDueAt,
    assignedOfficerId: kase.assignedOfficerId,
    statusHistory: kase.statusHistory.map((h) => ({
      fromStatus: h.fromStatus,
      toStatus: h.toStatus,
      changedAt: h.changedAt,
    })),
  };
}

/**
 * Move a case to a new status. The whole change -- the status, its history row,
 * the audit event and any notifications -- happens in one transaction, so a
 * case never ends up in a state its own history does not record.
 */
export async function changeCaseStatus(
  actor: Actor,
  caseId: string,
  to: CaseStatus,
  reason: string | null,
  meta: RequestMeta,
): Promise<void> {
  requireRole(actor, ["officer", "investigator", "admin", "dpo"]);

  const kase = await prisma.case.findFirst({ where: { id: caseId, deletedAt: null } });
  if (!kase) throw new NotFoundError("That case does not exist.");
  requireSameInstitution(actor, kase.institutionId);

  if (!canTransition(kase.status, to, actor.roles)) {
    throw new InvalidTransitionError(
      `A case cannot move from ${kase.status} to ${to}.`,
    );
  }

  // Resolving is not a bare status change: "resolved" asserts that a decision
  // was reached, and a resolved case with no recorded finding is the gap the
  // outcomes table exists to close. recordOutcome writes both together.
  if (to === "resolved") {
    throw new InvalidTransitionError(
      "A case is resolved by recording its outcome, not by changing its status.",
    );
  }

  const at = now();

  await prisma.$transaction(async (tx) => {
    await tx.case.update({
      where: { id: kase.id },
      data: {
        status: to,
        // resolvedAt is not set here: "resolved" is unreachable through this
        // function, and recordOutcome owns that stamp.
        // closedAt is stamped once, on first entry. A closed case can be
        // appealed and closed again; the original closing date is the true one.
        closedAt: to === "closed" && !kase.closedAt ? at : kase.closedAt,
        firstResponseAt: kase.firstResponseAt ?? at,
      },
    });

    await tx.caseStatusHistory.create({
      data: {
        caseId: kase.id,
        fromStatus: kase.status,
        toStatus: to,
        changedById: actor.accountId,
        reason,
        changedAt: at,
      },
    });

    await withAudit(
      tx,
      {
        actorAccountId: actor.accountId,
        actorLabel: actor.email,
        institutionId: kase.institutionId,
        requestId: meta.requestId,
        ipHash: meta.ipHash,
        userAgent: meta.userAgent,
      },
      {
        action: "case.status_changed",
        entityType: "case",
        entityId: kase.id,
        before: { status: kase.status },
        after: { status: to, reason },
      },
    );

    // Inside the transaction, like the audit row. A notification announcing a
    // change that then rolled back describes something that never happened.
    await notify(tx, await caseAudience(tx, kase.id), {
      caseId: kase.id,
      subject: `${kase.caseNumber} is now ${to.replaceAll("_", " ")}`,
      body: reason ?? `The case moved from ${kase.status} to ${to}.`,
    });
  });
}

/**
 * Assign a case, or clear its assignment with null. The institution check is
 * against the ASSIGNEE's account, not the actor's -- an officer passing a
 * colleague's id from another tenant is the case that matters here.
 */
export async function assignCase(
  actor: Actor,
  caseId: string,
  officerAccountId: string | null,
  meta: RequestMeta,
): Promise<void> {
  requireRole(actor, ["officer", "admin"]);

  const kase = await prisma.case.findFirst({ where: { id: caseId, deletedAt: null } });
  if (!kase) throw new NotFoundError("That case does not exist.");
  requireSameInstitution(actor, kase.institutionId);

  if (officerAccountId !== null) {
    const assignee = await prisma.userAccount.findFirst({
      where: { id: officerAccountId, deletedAt: null },
      select: { institutionId: true },
    });
    if (!assignee) throw new NotFoundError("That account does not exist.");
    if (assignee.institutionId !== kase.institutionId) {
      throw new ForbiddenError("You are not permitted to access this record.");
    }
  }

  const at = now();

  await prisma.$transaction(async (tx) => {
    await tx.case.update({
      where: { id: kase.id },
      data: {
        assignedOfficerId: officerAccountId,
        // First officer action, whichever came first. A product definition
        // rather than a data one, so it lives here and not in a trigger.
        firstResponseAt: kase.firstResponseAt ?? at,
      },
    });
    await withAudit(
      tx,
      {
        actorAccountId: actor.accountId,
        actorLabel: actor.email,
        institutionId: kase.institutionId,
        requestId: meta.requestId,
        ipHash: meta.ipHash,
        userAgent: meta.userAgent,
      },
      {
        action: officerAccountId ? "case.assigned" : "case.unassigned",
        entityType: "case",
        entityId: kase.id,
        before: { assignedOfficerId: kase.assignedOfficerId },
        after: { assignedOfficerId: officerAccountId },
      },
    );

    if (officerAccountId) {
      await notify(tx, [officerAccountId], {
        caseId: kase.id,
        subject: `${kase.caseNumber} has been assigned to you`,
        body: kase.title,
      });
    }
  });
}

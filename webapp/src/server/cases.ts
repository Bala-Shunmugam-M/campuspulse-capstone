import type { CaseStatus, Confidentiality, Severity } from "@prisma/client";
import { prisma } from "@/lib/db";
import { withAudit } from "@/lib/audit/withAudit";
import { requireRole, requireSameInstitution, type Actor } from "@/lib/auth/rbac";
import { ForbiddenError, NotFoundError } from "@/lib/errors";
import type { RequestMeta } from "@/server/accounts";

/** Hours allowed before a case is overdue, by severity. */
const SLA_HOURS: Record<Severity, number> = {
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

export type CaseFilter = { status?: CaseStatus; severity?: Severity };

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

  const year = new Date().getFullYear();
  const openedAt = new Date();
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
      },
    });
    await withAudit(
      tx,
      {
        actorAccountId: actor.accountId,
        actorLabel: actor.accountId,
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

export async function listCases(actor: Actor, filter: CaseFilter): Promise<CaseSummary[]> {
  requireRole(actor, ["officer", "investigator", "admin"]);

  const rows = await prisma.case.findMany({
    where: {
      institutionId: actor.institutionId,
      deletedAt: null,
      status: filter.status,
      severity: filter.severity,
      // Sealed cases never appear in a queue; only a dpo reaches them by id.
      confidentiality: { not: "sealed" },
    },
    orderBy: { slaDueAt: "asc" },
    take: 200,
  });

  return rows.map((c) => ({
    id: c.id,
    institutionId: c.institutionId,
    caseNumber: c.caseNumber,
    title: c.title,
    severity: c.severity,
    status: c.status,
    slaDueAt: c.slaDueAt,
    assignedOfficerId: c.assignedOfficerId,
  }));
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

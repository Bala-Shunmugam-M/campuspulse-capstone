import type { ReportStatus } from "@prisma/client";
import { prisma } from "@/lib/db";
import { withAudit } from "@/lib/audit/withAudit";
import { requireRole, requireSameInstitution, type Actor } from "@/lib/auth/rbac";
import {
  generateAccessSecret,
  generateReferenceCode,
  hashAccessSecret,
  verifyAccessSecret,
} from "@/lib/reference/codes";
import { assertRateLimit } from "@/lib/rateLimit";
import { NotFoundError } from "@/lib/errors";
import { reportInputSchema, type ReportInput } from "@/lib/validation/report";
import type { RequestMeta } from "@/server/accounts";

export async function submitReport(
  actor: Actor,
  input: ReportInput,
  meta: RequestMeta,
): Promise<{ referenceCode: string }> {
  requireRole(actor, ["reporter", "officer", "investigator", "admin", "dpo"]);
  requireSameInstitution(actor, actor.institutionId);

  const parsed = reportInputSchema.parse(input);
  const referenceCode = generateReferenceCode();

  await prisma.$transaction(async (tx) => {
    const report = await tx.report.create({
      data: {
        institutionId: actor.institutionId,
        referenceCode,
        isAnonymous: false,
        reporterUserId: actor.accountId,
        channel: "web",
        ipHash: meta.ipHash,
        userAgent: meta.userAgent,
        ...parsed,
      },
    });
    await withAudit(
      tx,
      {
        actorAccountId: actor.accountId,
        actorLabel: actor.accountId,
        institutionId: actor.institutionId,
        requestId: meta.requestId,
        ipHash: meta.ipHash,
        userAgent: meta.userAgent,
      },
      {
        action: "report.submitted",
        entityType: "report",
        entityId: report.id,
        after: { referenceCode, isAnonymous: false },
      },
    );
  });

  return { referenceCode };
}

/**
 * No actor by definition, so the authorisation test exempts it. Abuse is
 * controlled by rate limiting rather than identity.
 */
export async function submitAnonymousReport(
  institutionId: string,
  input: ReportInput,
  meta: RequestMeta,
): Promise<{ referenceCode: string; accessSecret: string }> {
  const parsed = reportInputSchema.parse(input);
  const referenceCode = generateReferenceCode();
  const accessSecret = generateAccessSecret();
  const accessSecretHash = await hashAccessSecret(accessSecret);

  await prisma.$transaction(async (tx) => {
    const report = await tx.report.create({
      data: {
        institutionId,
        referenceCode,
        accessSecretHash,
        isAnonymous: true,
        reporterUserId: null,
        channel: "web",
        ipHash: meta.ipHash,
        userAgent: meta.userAgent,
        ...parsed,
      },
    });
    await withAudit(
      tx,
      {
        actorAccountId: null,
        actorLabel: "anonymous",
        institutionId,
        requestId: meta.requestId,
        ipHash: meta.ipHash,
        userAgent: meta.userAgent,
      },
      {
        action: "report.submitted",
        entityType: "report",
        entityId: report.id,
        after: { referenceCode, isAnonymous: true },
      },
    );
  });

  // Returned once. Never stored, never logged, never emailed.
  return { referenceCode, accessSecret };
}

export type ReportStatusView = {
  referenceCode: string;
  status: ReportStatus;
  submittedAt: Date;
  title: string;
};

/**
 * Authorised by reference code plus access secret rather than by session, so the
 * authorisation test exempts it. Rate limited because the secret is the only
 * thing standing between a guessed code and the report.
 */
export async function lookupAnonymousReport(
  referenceCode: string,
  accessSecret: string,
  meta: RequestMeta,
): Promise<ReportStatusView> {
  const code = referenceCode.trim().toUpperCase();
  assertRateLimit(`lookup:${code}`, 5, 15 * 60_000);

  const report = await prisma.report.findFirst({
    where: { referenceCode: code, isAnonymous: true, deletedAt: null },
  });

  // One error for both failures: distinguishing them confirms which codes exist.
  const deny = () => new NotFoundError("No report was found for that code and access code.");

  if (!report?.accessSecretHash) throw deny();

  if (!(await verifyAccessSecret(report.accessSecretHash, accessSecret))) {
    await prisma.$transaction((tx) =>
      withAudit(
        tx,
        {
          actorAccountId: null,
          actorLabel: "anonymous",
          institutionId: report.institutionId,
          requestId: meta.requestId,
          ipHash: meta.ipHash,
          userAgent: meta.userAgent,
        },
        { action: "report.lookup_failed", entityType: "report", entityId: report.id },
      ),
    );
    throw deny();
  }

  return {
    referenceCode: report.referenceCode,
    status: report.status,
    submittedAt: report.submittedAt,
    title: report.title,
  };
}

export type UntriagedReport = {
  id: string;
  referenceCode: string;
  title: string;
  severitySelfReported: string;
  submittedAt: Date;
  isAnonymous: boolean;
};

/** The officer's inbox: reports in this institution that have not become cases. */
export async function listUntriagedReports(actor: Actor): Promise<UntriagedReport[]> {
  requireRole(actor, ["officer", "admin"]);

  const rows = await prisma.report.findMany({
    where: { institutionId: actor.institutionId, status: "received", deletedAt: null },
    orderBy: { submittedAt: "asc" },
    take: 100,
  });

  return rows.map((r) => ({
    id: r.id,
    referenceCode: r.referenceCode,
    title: r.title,
    severitySelfReported: r.severitySelfReported,
    submittedAt: r.submittedAt,
    isAnonymous: r.isAnonymous,
  }));
}

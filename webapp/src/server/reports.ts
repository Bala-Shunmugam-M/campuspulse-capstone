import { prisma } from "@/lib/db";
import { withAudit } from "@/lib/audit/withAudit";
import { requireRole, requireSameInstitution, type Actor } from "@/lib/auth/rbac";
import {
  generateAccessSecret,
  generateReferenceCode,
  hashAccessSecret,
} from "@/lib/reference/codes";
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

import { prisma } from "@/lib/db";
import { withAudit } from "@/lib/audit/withAudit";
import { now } from "@/lib/clock";
import { requireRole, requireSameInstitution, type Actor } from "@/lib/auth/rbac";
import { ForbiddenError, NotFoundError } from "@/lib/errors";
import type { RequestMeta } from "@/server/accounts";

export type Coverage = {
  /** Accounts expected to acknowledge: every live account in the institution. */
  required: number;
  done: number;
  /** The version the figures describe, or null when nothing is live today. */
  liveVersionId: string | null;
  liveVersionNo: number | null;
};

/**
 * Record that this person has read this version.
 *
 * Idempotent by ON CONFLICT DO NOTHING rather than by a read-then-write: a user
 * who double-clicks has not done anything wrong, and two concurrent clicks must
 * not turn into a unique-violation error page. The audit row is written only
 * when a row was actually inserted, so the log does not fill with repetitions of
 * a decision someone made once.
 */
export async function acknowledge(
  actor: Actor,
  versionId: string,
  meta: RequestMeta,
): Promise<void> {
  requireRole(actor, ["reporter", "officer", "investigator", "admin", "dpo"]);

  const version = await prisma.policyVersion.findUnique({
    where: { id: versionId },
    include: { policy: true },
  });
  if (!version) throw new NotFoundError("That policy version does not exist.");
  requireSameInstitution(actor, version.policy.institutionId);

  // A draft is not yet the rules. Acknowledging one would record agreement to
  // text that can still change underneath it.
  if (version.publishedAt === null) {
    throw new ForbiddenError("A draft policy version cannot be acknowledged.");
  }

  await prisma.$transaction(async (tx) => {
    const inserted = await tx.$executeRaw`
      INSERT INTO compliance.policy_acknowledgements
        (id, policy_version_id, user_account_id, acknowledged_at)
      VALUES (gen_random_uuid(), ${versionId}::uuid, ${actor.accountId}::uuid, ${now()})
      ON CONFLICT (policy_version_id, user_account_id) DO NOTHING`;

    if (inserted === 0) return;

    await withAudit(
      tx,
      {
        actorAccountId: actor.accountId,
        actorLabel: actor.email,
        institutionId: version.policy.institutionId,
        requestId: meta.requestId,
        ipHash: meta.ipHash,
        userAgent: meta.userAgent,
      },
      {
        action: "policy.acknowledged",
        entityType: "policy",
        entityId: version.policyId,
        after: { versionId, versionNo: version.versionNo },
      },
    );
  });
}

/** Whether this actor has acknowledged a particular version. */
export async function hasAcknowledged(actor: Actor, versionId: string): Promise<boolean> {
  requireRole(actor, ["reporter", "officer", "investigator", "admin", "dpo"]);

  const row = await prisma.policyAcknowledgement.findUnique({
    where: {
      policyVersionId_userAccountId: {
        policyVersionId: versionId,
        userAccountId: actor.accountId,
      },
    },
    select: { id: true },
  });
  return row !== null;
}

/**
 * How much of the institution has acknowledged the version of this policy that
 * is live today.
 *
 * Coverage is measured against a VERSION, never a policy, so it resets when a
 * policy is superseded. Any other reading lets "everyone has acknowledged the
 * code of conduct" survive a rewrite of the code of conduct -- which is exactly
 * the reassurance nobody should be given.
 */
export async function acknowledgementCoverage(
  actor: Actor,
  policyId: string,
): Promise<Coverage> {
  requireRole(actor, ["admin", "dpo"]);

  const policy = await prisma.policy.findUnique({ where: { id: policyId } });
  if (!policy) throw new NotFoundError("That policy does not exist.");
  requireSameInstitution(actor, policy.institutionId);

  const required = await prisma.userAccount.count({
    where: { institutionId: policy.institutionId, deletedAt: null },
  });

  const [live] = await prisma.$queryRaw<{ id: string; version_no: number }[]>`
    SELECT id, version_no FROM compliance.policy_versions
    WHERE policy_id = ${policyId}::uuid
      AND published_at IS NOT NULL
      AND effective_from <= current_date
      AND (effective_to IS NULL OR effective_to > current_date)
    ORDER BY version_no DESC LIMIT 1`;

  if (!live) return { required, done: 0, liveVersionId: null, liveVersionNo: null };

  const done = await prisma.policyAcknowledgement.count({
    where: { policyVersionId: live.id },
  });

  return {
    required,
    done,
    liveVersionId: live.id,
    liveVersionNo: Number(live.version_no),
  };
}

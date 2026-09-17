import type { Prisma } from "@prisma/client";
import { now } from "@/lib/clock";

/**
 * Notification primitives. They live beside withAudit rather than in
 * src/server/ for the same reason it does: they take the caller's transaction
 * client and perform no authorisation of their own, because the service that
 * calls them has already done it. Keeping them here means the service-layer
 * authorisation test does not need an exemption for them.
 */

/**
 * Queue notifications inside the caller's transaction. A notification
 * announcing a change that then rolled back describes something that never
 * happened.
 */
export async function notify(
  tx: Prisma.TransactionClient,
  recipientIds: string[],
  payload: { caseId: string | null; subject: string; body: string },
): Promise<void> {
  const unique = [...new Set(recipientIds)].filter(Boolean);
  if (unique.length === 0) return;

  await tx.notification.createMany({
    data: unique.map((recipientId) => ({
      recipientId,
      caseId: payload.caseId,
      subject: payload.subject,
      body: payload.body,
      createdAt: now(),
    })),
  });
}

/**
 * Who hears about a change to this case: the assigned officer and any party
 * holding an account. Parties without an account have nowhere to be notified,
 * which is a limitation of in-app notifications rather than an oversight.
 */
export async function caseAudience(
  tx: Prisma.TransactionClient,
  caseId: string,
): Promise<string[]> {
  const [kase, parties] = await Promise.all([
    tx.case.findUnique({ where: { id: caseId }, select: { assignedOfficerId: true } }),
    tx.caseParty.findMany({
      where: { caseId, deletedAt: null, userAccountId: { not: null } },
      select: { userAccountId: true },
    }),
  ]);

  return [
    ...(kase?.assignedOfficerId ? [kase.assignedOfficerId] : []),
    ...parties.map((p) => p.userAccountId as string),
  ];
}

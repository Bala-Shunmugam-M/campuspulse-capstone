import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { requireRole, type Actor } from "@/lib/auth/rbac";
import { NotFoundError } from "@/lib/errors";

export type NotificationView = {
  id: string;
  caseId: string | null;
  subject: string;
  body: string;
  isRead: boolean;
  createdAt: Date;
};

export type ActivityEntry = {
  id: string;
  action: string;
  entityType: string;
  entityId: string;
  actorLabel: string;
  actorEmail: string | null;
  occurredAt: Date;
};

/**
 * Queue notifications inside the caller's transaction, exactly like withAudit.
 * A notification announcing something that then rolled back is a message about
 * an event that never happened.
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
    })),
  });
}

export async function listNotifications(
  actor: Actor,
  options: { unreadOnly?: boolean; limit?: number } = {},
): Promise<NotificationView[]> {
  requireRole(actor, ["reporter", "officer", "investigator", "admin", "dpo"]);

  const rows = await prisma.notification.findMany({
    where: {
      recipientId: actor.accountId,
      ...(options.unreadOnly ? { isRead: false } : {}),
    },
    orderBy: { createdAt: "desc" },
    take: Math.min(options.limit ?? 50, 200),
  });

  return rows.map((n) => ({
    id: n.id,
    caseId: n.caseId,
    subject: n.subject,
    body: n.body,
    isRead: n.isRead,
    createdAt: n.createdAt,
  }));
}

export async function unreadCount(actor: Actor): Promise<number> {
  requireRole(actor, ["reporter", "officer", "investigator", "admin", "dpo"]);
  return prisma.notification.count({
    where: { recipientId: actor.accountId, isRead: false },
  });
}

/** Scoped to the actor's own rows: marking someone else's notification read is not a thing. */
export async function markRead(actor: Actor, notificationId: string): Promise<void> {
  requireRole(actor, ["reporter", "officer", "investigator", "admin", "dpo"]);

  const updated = await prisma.notification.updateMany({
    where: { id: notificationId, recipientId: actor.accountId, isRead: false },
    data: { isRead: true, readAt: new Date() },
  });
  if (updated.count === 0) {
    const exists = await prisma.notification.count({
      where: { id: notificationId, recipientId: actor.accountId },
    });
    if (exists === 0) throw new NotFoundError("That notification does not exist.");
  }
}

/** The feed is a view over audit_events; this reads it, scoped to the tenant. */
export async function listActivity(actor: Actor, limit = 50): Promise<ActivityEntry[]> {
  requireRole(actor, ["officer", "investigator", "admin", "dpo"]);

  const rows = await prisma.$queryRaw<
    {
      id: bigint;
      action: string;
      entity_type: string;
      entity_id: string;
      actor_label: string;
      actor_email: string | null;
      occurred_at: Date;
    }[]
  >`
    SELECT id, action, entity_type, entity_id, actor_label, actor_email, occurred_at
    FROM compliance.activity_feed
    WHERE institution_id = ${actor.institutionId}::uuid
    ORDER BY occurred_at DESC
    LIMIT ${Math.min(limit, 200)}`;

  return rows.map((r) => ({
    id: r.id.toString(),
    action: r.action,
    entityType: r.entity_type,
    entityId: r.entity_id,
    actorLabel: r.actor_label,
    actorEmail: r.actor_email,
    occurredAt: r.occurred_at,
  }));
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

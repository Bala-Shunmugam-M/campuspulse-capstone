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

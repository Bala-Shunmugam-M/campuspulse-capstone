import { prisma } from "@/lib/db";
import { requireRole, type Actor } from "@/lib/auth/rbac";

export type AuditEventView = {
  id: string;
  institutionId: string;
  actorLabel: string;
  actorUserAccountId: string | null;
  action: string;
  entityType: string;
  entityId: string;
  occurredAt: Date;
};

export async function listAuditEvents(
  actor: Actor,
  filter: { entityType?: string; entityId?: string; limit?: number },
): Promise<AuditEventView[]> {
  requireRole(actor, ["admin", "dpo"]);

  const rows = await prisma.auditEvent.findMany({
    where: {
      institutionId: actor.institutionId,
      entityType: filter.entityType,
      entityId: filter.entityId,
    },
    orderBy: { occurredAt: "desc" },
    take: Math.min(filter.limit ?? 100, 500),
  });

  return rows.map((e) => ({
    // BigInt does not cross the server-component boundary; stringify here.
    id: e.id.toString(),
    institutionId: e.institutionId,
    actorLabel: e.actorLabel,
    actorUserAccountId: e.actorUserAccountId,
    action: e.action,
    entityType: e.entityType,
    entityId: e.entityId,
    occurredAt: e.occurredAt,
  }));
}

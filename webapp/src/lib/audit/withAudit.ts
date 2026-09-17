import type { Prisma } from "@prisma/client";
import { now } from "@/lib/clock";

export type AuditContext = {
  actorAccountId: string | null;
  /** Human-readable actor when there is no account: "anonymous", "system:simulator". */
  actorLabel: string;
  institutionId: string;
  requestId: string;
  ipHash: string | null;
  userAgent: string | null;
};

export type AuditEventInput = {
  /** Dotted verb phrase: "case.status_changed", "report.submitted". */
  action: string;
  entityType: string;
  entityId: string;
  before?: unknown;
  after?: unknown;
};

/**
 * Record an audit event. Must be called with the SAME transaction client as the
 * mutation it describes, so a failed mutation cannot leave a claim that it
 * happened.
 */
export async function withAudit(
  tx: Prisma.TransactionClient,
  ctx: AuditContext,
  event: AuditEventInput,
): Promise<void> {
  await tx.auditEvent.create({
    data: {
      institutionId: ctx.institutionId,
      actorUserAccountId: ctx.actorAccountId,
      actorLabel: ctx.actorLabel,
      action: event.action,
      entityType: event.entityType,
      entityId: event.entityId,
      before: (event.before ?? null) as Prisma.InputJsonValue,
      after: (event.after ?? null) as Prisma.InputJsonValue,
      requestId: ctx.requestId,
      ipHash: ctx.ipHash,
      userAgent: ctx.userAgent,
      // Stamped here rather than left to the column default. Postgres now() is
      // transaction time and cannot be moved, so a DB default would be the one
      // timestamp in the whole system that simulated time could never reach --
      // and an audit trail dated differently from the events it describes is
      // worse than no audit trail.
      occurredAt: now(),
    },
  });
}

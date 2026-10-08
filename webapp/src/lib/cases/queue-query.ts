import type { Prisma } from "@prisma/client";
import type { Actor } from "@/lib/auth/rbac";
import { decodeCursor } from "@/lib/pagination";
import { SETTLED_STATUSES } from "./sla";

export type QueueOptions = {
  status?: Prisma.CaseWhereInput["status"];
  severity?: Prisma.CaseWhereInput["severity"];
  assignedTo?: string;
  q?: string;
  deadline?: "open" | "overdue" | "soon";
  sort?: "asc" | "desc";
  cursor?: string;
};
/** Compose independent predicates with AND so search never overrides tenant or cursor scope. */
export function queueQuery(
  actor: Actor,
  filter: QueueOptions,
  at: Date,
): {
  where: Prisma.CaseWhereInput;
  orderBy: Prisma.CaseOrderByWithRelationInput[];
} {
  const direction = filter.sort === "desc" ? "desc" : "asc";
  const cursor = decodeCursor(filter.cursor);
  const date = cursor ? new Date(cursor.key) : null;
  const validCursor =
    date &&
    !Number.isNaN(date.getTime()) &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      cursor!.id,
    );
  const AND: Prisma.CaseWhereInput[] = [];
  if (filter.deadline) {
    AND.push({ status: { notIn: [...SETTLED_STATUSES] } });
    if (filter.deadline === "overdue") AND.push({ slaDueAt: { lt: at } });
    if (filter.deadline === "soon")
      AND.push({
        slaDueAt: { gte: at, lt: new Date(at.getTime() + 24 * 3600000) },
      });
  }
  const q = filter.q?.trim().slice(0, 200);
  if (q)
    AND.push({
      OR: [
        { title: { contains: q, mode: "insensitive" } },
        { caseNumber: { contains: q, mode: "insensitive" } },
      ],
    });
  if (validCursor)
    AND.push({
      OR: [
        { slaDueAt: { [direction === "asc" ? "gt" : "lt"]: date } },
        {
          slaDueAt: date,
          id: { [direction === "asc" ? "gt" : "lt"]: cursor!.id },
        },
      ],
    });
  return {
    where: {
      institutionId: actor.institutionId,
      deletedAt: null,
      confidentiality: { not: "sealed" },
      status: filter.status,
      severity: filter.severity,
      ...(filter.assignedTo
        ? {
            assignedOfficerId:
              filter.assignedTo === "me"
                ? actor.accountId
                : filter.assignedTo === "unassigned"
                  ? null
                  : filter.assignedTo,
          }
        : {}),
      AND,
    },
    orderBy: [{ slaDueAt: direction }, { id: direction }],
  };
}

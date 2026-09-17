import type { CaseStatus } from "@prisma/client";

/**
 * One definition of "overdue", for the queue, the case page and the dashboards.
 *
 * Two definitions would drift, and a dashboard that disagrees with the list it
 * links to teaches people to trust neither. It lives in lib/ rather than in
 * server/ because it touches no data and therefore cannot authorise, which is
 * the rule tests/service-authorisation.test.ts enforces on src/server/.
 */

/** Statuses at which the SLA clock has stopped. */
export const SETTLED_STATUSES: CaseStatus[] = ["resolved", "closed"];

export function isOverdue(slaDueAt: Date, status: CaseStatus, asOf: Date): boolean {
  return slaDueAt.getTime() < asOf.getTime() && !SETTLED_STATUSES.includes(status);
}

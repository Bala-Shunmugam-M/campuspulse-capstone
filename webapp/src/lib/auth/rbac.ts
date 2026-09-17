import type { ComplianceRole } from "@prisma/client";
import { ForbiddenError } from "@/lib/errors";

export type Actor = {
  accountId: string;
  institutionId: string;
  /**
   * The account's email, carried so every audit row can name its actor in a way
   * a person can read. Required rather than optional: an Actor without one would
   * silently fall back to writing a uuid, which is the defect this field exists
   * to fix. Read once at session load rather than once per audit row.
   */
  email: string;
  roles: ComplianceRole[];
};

export function requireRole(actor: Actor | null, allowed: ComplianceRole[]): Actor {
  if (!actor) throw new ForbiddenError("You must sign in to do that.");
  if (!actor.roles.some((held) => allowed.includes(held))) {
    throw new ForbiddenError("You are not permitted to perform this action.");
  }
  return actor;
}

/**
 * Tenant isolation. Deliberately not a role: no role, including admin, grants
 * access to another institution's records.
 */
export function requireSameInstitution(actor: Actor, institutionId: string): void {
  if (actor.institutionId !== institutionId) {
    throw new ForbiddenError("You are not permitted to access this record.");
  }
}

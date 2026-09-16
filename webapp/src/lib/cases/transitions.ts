import type { CaseStatus, ComplianceRole } from "@prisma/client";

export type Transition = {
  from: CaseStatus;
  to: CaseStatus;
  roles: ComplianceRole[];
};

/**
 * Every legal case transition and who may perform it (spec §6). This array is
 * the only definition: anything absent from it is refused, so adding a path
 * means adding a row here rather than loosening a check somewhere.
 */
export const TRANSITIONS: Transition[] = [
  { from: "submitted", to: "triaged", roles: ["officer", "admin"] },
  { from: "triaged", to: "under_investigation", roles: ["officer", "investigator", "admin"] },
  { from: "triaged", to: "dismissed", roles: ["officer", "admin"] },
  { from: "under_investigation", to: "pending_decision", roles: ["officer", "investigator", "admin"] },
  { from: "under_investigation", to: "dismissed", roles: ["officer", "admin"] },
  { from: "pending_decision", to: "resolved", roles: ["officer", "admin"] },
  { from: "pending_decision", to: "dismissed", roles: ["officer", "admin"] },
  { from: "resolved", to: "closed", roles: ["officer", "admin"] },
  { from: "closed", to: "appealed", roles: ["officer", "admin", "dpo"] },
  { from: "appealed", to: "under_investigation", roles: ["officer", "investigator", "admin"] },
];

export function findTransition(from: CaseStatus, to: CaseStatus): Transition | undefined {
  return TRANSITIONS.find((t) => t.from === from && t.to === to);
}

export function canTransition(
  from: CaseStatus,
  to: CaseStatus,
  roles: ComplianceRole[],
): boolean {
  const transition = findTransition(from, to);
  return Boolean(transition && roles.some((held) => transition.roles.includes(held)));
}

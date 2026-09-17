import type { Finding, SanctionType } from "@prisma/client";
import { prisma } from "@/lib/db";
import { withAudit } from "@/lib/audit/withAudit";
import { requireRole, requireSameInstitution, type Actor } from "@/lib/auth/rbac";
import { ForbiddenError, InvalidTransitionError, NotFoundError } from "@/lib/errors";
import { canTransition } from "@/lib/cases/transitions";
import { caseAudience, notify } from "@/server/notifications";
import type { RequestMeta } from "@/server/accounts";

export type OutcomeInput = {
  finding: Finding;
  rationale: string;
};

export type SanctionInput = {
  subjectPartyId: string;
  sanctionType: SanctionType;
  description: string;
  effectiveFrom: Date;
  effectiveTo?: Date | null;
};

async function caseForOutcome(actor: Actor, caseId: string) {
  const kase = await prisma.case.findFirst({ where: { id: caseId, deletedAt: null } });
  if (!kase) throw new NotFoundError("That case does not exist.");
  requireSameInstitution(actor, kase.institutionId);
  if (kase.confidentiality === "sealed" && !actor.roles.includes("dpo")) {
    throw new ForbiddenError("You are not permitted to access this record.");
  }
  return kase;
}

/**
 * Record the decision and resolve the case together. A case carrying an outcome
 * while still sitting in pending_decision is a state nobody intended, so the
 * two happen in one transaction or not at all.
 */
export async function recordOutcome(
  actor: Actor,
  caseId: string,
  input: OutcomeInput,
  meta: RequestMeta,
): Promise<string> {
  requireRole(actor, ["officer", "admin"]);
  const kase = await caseForOutcome(actor, caseId);

  // A decision only means anything from the state that was awaiting one.
  if (kase.status !== "pending_decision") {
    throw new InvalidTransitionError(
      `An outcome can only be recorded on a case awaiting decision, not one that is ${kase.status}.`,
    );
  }
  if (!canTransition(kase.status, "resolved", actor.roles)) {
    throw new InvalidTransitionError("A case cannot move from pending_decision to resolved.");
  }

  const rationale = input.rationale.trim();
  if (rationale.length < 1) throw new NotFoundError("An outcome needs a rationale.");

  const now = new Date();

  return prisma.$transaction(async (tx) => {
    const outcome = await tx.outcome.create({
      data: {
        caseId: kase.id,
        finding: input.finding,
        rationale,
        decidedBy: actor.accountId,
      },
    });

    await tx.case.update({
      where: { id: kase.id },
      data: {
        status: "resolved",
        resolvedAt: kase.resolvedAt ?? now,
        firstResponseAt: kase.firstResponseAt ?? now,
      },
    });
    await tx.caseStatusHistory.create({
      data: {
        caseId: kase.id,
        fromStatus: kase.status,
        toStatus: "resolved",
        changedById: actor.accountId,
        reason: `outcome recorded: ${input.finding}`,
      },
    });

    const ctx = {
      actorAccountId: actor.accountId,
      actorLabel: actor.accountId,
      institutionId: kase.institutionId,
      requestId: meta.requestId,
      ipHash: meta.ipHash,
      userAgent: meta.userAgent,
    };
    await withAudit(tx, ctx, {
      action: "case.outcome_recorded",
      entityType: "case",
      entityId: kase.id,
      after: { outcomeId: outcome.id, finding: input.finding },
    });
    await withAudit(tx, ctx, {
      action: "case.status_changed",
      entityType: "case",
      entityId: kase.id,
      before: { status: kase.status },
      after: { status: "resolved" },
    });

    await notify(tx, await caseAudience(tx, kase.id), {
      caseId: kase.id,
      subject: `${kase.caseNumber} has been decided`,
      body: `Finding: ${input.finding.replaceAll("_", " ")}.`,
    });

    return outcome.id;
  });
}

export async function getOutcome(actor: Actor, caseId: string) {
  requireRole(actor, ["officer", "investigator", "admin", "dpo"]);
  await caseForOutcome(actor, caseId);

  return prisma.outcome.findUnique({
    where: { caseId },
    include: { sanctions: { orderBy: { createdAt: "asc" } } },
  });
}

/**
 * Attach a sanction. The subject must be a party ON THIS CASE: the foreign key
 * to case_parties says the party exists, not that it belongs here, so a party
 * id from another case would otherwise be accepted.
 */
export async function addSanction(
  actor: Actor,
  outcomeId: string,
  input: SanctionInput,
  meta: RequestMeta,
): Promise<string> {
  requireRole(actor, ["officer", "admin"]);

  const outcome = await prisma.outcome.findUnique({ where: { id: outcomeId } });
  if (!outcome) throw new NotFoundError("That outcome does not exist.");
  const kase = await caseForOutcome(actor, outcome.caseId);

  const party = await prisma.caseParty.findFirst({
    where: { id: input.subjectPartyId, deletedAt: null },
  });
  if (!party) throw new NotFoundError("That party does not exist.");
  if (party.caseId !== outcome.caseId) {
    throw new ForbiddenError("That party does not belong to this case.");
  }

  return prisma.$transaction(async (tx) => {
    const sanction = await tx.sanction.create({
      data: {
        outcomeId,
        subjectPartyId: input.subjectPartyId,
        sanctionType: input.sanctionType,
        description: input.description.trim(),
        effectiveFrom: input.effectiveFrom,
        effectiveTo: input.effectiveTo ?? null,
      },
    });
    await withAudit(
      tx,
      {
        actorAccountId: actor.accountId,
        actorLabel: actor.accountId,
        institutionId: kase.institutionId,
        requestId: meta.requestId,
        ipHash: meta.ipHash,
        userAgent: meta.userAgent,
      },
      {
        action: "case.sanction_added",
        entityType: "case",
        entityId: kase.id,
        after: { sanctionId: sanction.id, sanctionType: input.sanctionType },
      },
    );
    return sanction.id;
  });
}

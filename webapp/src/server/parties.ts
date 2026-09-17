import type { PartyRole } from "@prisma/client";
import { prisma } from "@/lib/db";
import { withAudit } from "@/lib/audit/withAudit";
import { requireRole, requireSameInstitution, type Actor } from "@/lib/auth/rbac";
import { ForbiddenError, NotFoundError } from "@/lib/errors";
import type { RequestMeta } from "@/server/accounts";

export type PartyInput = {
  partyRole: PartyRole;
  userAccountId?: string | null;
  externalName?: string | null;
  isAnonymous?: boolean;
};

export type PartyView = {
  id: string;
  partyRole: PartyRole;
  userAccountId: string | null;
  externalName: string | null;
  isAnonymous: boolean;
};

/** Sealed cases are the dpo's alone, here as everywhere else. */
async function caseForParties(actor: Actor, caseId: string) {
  const kase = await prisma.case.findFirst({ where: { id: caseId, deletedAt: null } });
  if (!kase) throw new NotFoundError("That case does not exist.");
  requireSameInstitution(actor, kase.institutionId);
  if (kase.confidentiality === "sealed" && !actor.roles.includes("dpo")) {
    throw new ForbiddenError("You are not permitted to access this record.");
  }
  return kase;
}

export async function addParty(
  actor: Actor,
  caseId: string,
  input: PartyInput,
  meta: RequestMeta,
): Promise<string> {
  requireRole(actor, ["officer", "investigator", "admin", "dpo"]);
  const kase = await caseForParties(actor, caseId);

  // An account party must belong to this tenant. The foreign key alone does not
  // say which institution the account is in.
  if (input.userAccountId) {
    const account = await prisma.userAccount.findFirst({
      where: { id: input.userAccountId, deletedAt: null },
      select: { institutionId: true },
    });
    if (!account) throw new NotFoundError("That account does not exist.");
    if (account.institutionId !== kase.institutionId) {
      throw new ForbiddenError("You are not permitted to access this record.");
    }
  }

  return prisma.$transaction(async (tx) => {
    const party = await tx.caseParty.create({
      data: {
        caseId: kase.id,
        partyRole: input.partyRole,
        userAccountId: input.userAccountId ?? null,
        externalName: input.externalName ?? null,
        isAnonymous: input.isAnonymous ?? false,
      },
    });
    await withAudit(
      tx,
      {
        actorAccountId: actor.accountId,
        actorLabel: actor.email,
        institutionId: kase.institutionId,
        requestId: meta.requestId,
        ipHash: meta.ipHash,
        userAgent: meta.userAgent,
      },
      {
        action: "case.party_added",
        entityType: "case",
        entityId: kase.id,
        after: { partyId: party.id, partyRole: input.partyRole },
      },
    );
    return party.id;
  });
}

export async function listParties(actor: Actor, caseId: string): Promise<PartyView[]> {
  requireRole(actor, ["officer", "investigator", "admin", "dpo"]);
  await caseForParties(actor, caseId);

  const rows = await prisma.caseParty.findMany({
    where: { caseId, deletedAt: null },
    orderBy: { createdAt: "asc" },
  });
  return rows.map((p) => ({
    id: p.id,
    partyRole: p.partyRole,
    userAccountId: p.userAccountId,
    externalName: p.externalName,
    isAnonymous: p.isAnonymous,
  }));
}

/** Soft delete. A party who was on a case remains part of its history. */
export async function removeParty(
  actor: Actor,
  partyId: string,
  meta: RequestMeta,
): Promise<void> {
  requireRole(actor, ["officer", "admin", "dpo"]);

  const party = await prisma.caseParty.findFirst({ where: { id: partyId, deletedAt: null } });
  if (!party) throw new NotFoundError("That party does not exist.");
  const kase = await caseForParties(actor, party.caseId);

  await prisma.$transaction(async (tx) => {
    await tx.caseParty.update({ where: { id: partyId }, data: { deletedAt: new Date() } });
    await withAudit(
      tx,
      {
        actorAccountId: actor.accountId,
        actorLabel: actor.email,
        institutionId: kase.institutionId,
        requestId: meta.requestId,
        ipHash: meta.ipHash,
        userAgent: meta.userAgent,
      },
      {
        action: "case.party_removed",
        entityType: "case",
        entityId: kase.id,
        before: { partyId, partyRole: party.partyRole },
      },
    );
  });
}

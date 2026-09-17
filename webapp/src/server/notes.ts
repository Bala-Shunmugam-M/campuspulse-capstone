import type { NoteVisibility } from "@prisma/client";
import { prisma } from "@/lib/db";
import { withAudit } from "@/lib/audit/withAudit";
import { requireRole, requireSameInstitution, type Actor } from "@/lib/auth/rbac";
import { ForbiddenError, NotFoundError } from "@/lib/errors";
import type { RequestMeta } from "@/server/accounts";

const STAFF = ["officer", "investigator", "admin", "dpo"] as const;

export type NoteView = {
  id: string;
  authorId: string;
  body: string;
  visibility: NoteVisibility;
  createdAt: Date;
};

function isStaff(actor: Actor): boolean {
  return actor.roles.some((r) => (STAFF as readonly string[]).includes(r));
}

/**
 * Which visibilities this actor may see on this case. Returns a list for the
 * query rather than a predicate for filtering afterwards: a note that must not
 * be seen should never be in the result set to begin with.
 */
async function visibleTo(actor: Actor, caseId: string): Promise<NoteVisibility[]> {
  if (isStaff(actor)) return ["internal", "shared_with_parties", "reporter_visible"];

  const allowed: NoteVisibility[] = [];

  const asParty = await prisma.caseParty.count({
    where: { caseId, userAccountId: actor.accountId, deletedAt: null },
  });
  if (asParty > 0) allowed.push("shared_with_parties");

  // The attributed reporter of any report linked to this case.
  const asReporter = await prisma.report.count({
    where: {
      reporterUserId: actor.accountId,
      deletedAt: null,
      id: { in: (await prisma.caseReport.findMany({
        where: { caseId },
        select: { reportId: true },
      })).map((r) => r.reportId) },
    },
  });
  if (asReporter > 0) allowed.push("reporter_visible");

  return allowed;
}

async function caseForNotes(actor: Actor, caseId: string) {
  const kase = await prisma.case.findFirst({ where: { id: caseId, deletedAt: null } });
  if (!kase) throw new NotFoundError("That case does not exist.");
  requireSameInstitution(actor, kase.institutionId);
  if (kase.confidentiality === "sealed" && !actor.roles.includes("dpo")) {
    throw new ForbiddenError("You are not permitted to access this record.");
  }
  return kase;
}

export async function addNote(
  actor: Actor,
  caseId: string,
  body: string,
  visibility: NoteVisibility,
  meta: RequestMeta,
): Promise<string> {
  requireRole(actor, ["officer", "investigator", "admin", "dpo"]);
  const kase = await caseForNotes(actor, caseId);

  const text = body.trim();
  if (text.length < 1) throw new NotFoundError("A note cannot be empty.");

  return prisma.$transaction(async (tx) => {
    const note = await tx.caseNote.create({
      data: { caseId: kase.id, authorId: actor.accountId, body: text, visibility },
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
        action: "case.note_added",
        entityType: "case",
        entityId: kase.id,
        after: { noteId: note.id, visibility },
      },
    );
    return note.id;
  });
}

export async function listNotes(actor: Actor, caseId: string): Promise<NoteView[]> {
  requireRole(actor, ["reporter", "officer", "investigator", "admin", "dpo"]);
  await caseForNotes(actor, caseId);

  const visibilities = await visibleTo(actor, caseId);
  if (visibilities.length === 0) return [];

  const rows = await prisma.caseNote.findMany({
    where: { caseId, deletedAt: null, visibility: { in: visibilities } },
    orderBy: { createdAt: "asc" },
  });

  return rows.map((n) => ({
    id: n.id,
    authorId: n.authorId,
    body: n.body,
    visibility: n.visibility,
    createdAt: n.createdAt,
  }));
}

/** Editing keeps the trail: the audit row carries both bodies. */
export async function editNote(
  actor: Actor,
  noteId: string,
  body: string,
  meta: RequestMeta,
): Promise<void> {
  requireRole(actor, ["officer", "investigator", "admin", "dpo"]);

  const note = await prisma.caseNote.findFirst({ where: { id: noteId, deletedAt: null } });
  if (!note) throw new NotFoundError("That note does not exist.");
  const kase = await caseForNotes(actor, note.caseId);

  await prisma.$transaction(async (tx) => {
    await tx.caseNote.update({ where: { id: noteId }, data: { body: body.trim() } });
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
        action: "case.note_updated",
        entityType: "case",
        entityId: kase.id,
        before: { noteId, body: note.body },
        after: { noteId, body: body.trim() },
      },
    );
  });
}

/** Soft delete only. A note that existed is part of the record. */
export async function removeNote(
  actor: Actor,
  noteId: string,
  meta: RequestMeta,
): Promise<void> {
  requireRole(actor, ["officer", "admin", "dpo"]);

  const note = await prisma.caseNote.findFirst({ where: { id: noteId, deletedAt: null } });
  if (!note) throw new NotFoundError("That note does not exist.");
  const kase = await caseForNotes(actor, note.caseId);

  await prisma.$transaction(async (tx) => {
    await tx.caseNote.update({ where: { id: noteId }, data: { deletedAt: new Date() } });
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
      { action: "case.note_removed", entityType: "case", entityId: kase.id, before: { noteId } },
    );
  });
}

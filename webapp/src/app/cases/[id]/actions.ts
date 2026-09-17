"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import type {
  CaseStatus,
  Finding,
  NoteVisibility,
  PartyRole,
  SanctionType,
} from "@prisma/client";
import { currentActor } from "@/lib/auth/actor";
import { newRequestMeta } from "@/server/accounts";
import { assignCase, changeCaseStatus } from "@/server/cases";
import { addParty, removeParty } from "@/server/parties";
import { addNote, removeNote } from "@/server/notes";
import { attachEvidenceToCase } from "@/server/evidence";
import { addSanction, recordOutcome } from "@/server/outcomes";
import { DomainError } from "@/lib/errors";
import { RejectedUploadError } from "@/lib/upload/inspect";

/**
 * Runs one case action and returns to the case either way. A domain error or a
 * rejected upload is a message for the person and comes back on the query
 * string; anything else is a bug and rethrows rather than being flattened into
 * "something went wrong".
 */
async function run(caseId: string, work: () => Promise<void>): Promise<never> {
  try {
    await work();
  } catch (thrown) {
    if (thrown instanceof DomainError || thrown instanceof RejectedUploadError) {
      redirect(`/cases/${caseId}?error=${encodeURIComponent(thrown.message)}`);
    }
    throw thrown;
  }
  revalidatePath(`/cases/${caseId}`);
  redirect(`/cases/${caseId}`);
}

async function actorOrLogin() {
  const actor = await currentActor();
  if (!actor) redirect("/login");
  return actor;
}

export async function changeStatusAction(formData: FormData) {
  const caseId = String(formData.get("caseId") ?? "");
  const to = String(formData.get("to") ?? "") as CaseStatus;
  const reason = String(formData.get("reason") ?? "").trim() || null;

  return run(caseId, async () => {
    const actor = await actorOrLogin();
    await changeCaseStatus(actor, caseId, to, reason, newRequestMeta(await headers()));
  });
}

export async function assignAction(formData: FormData) {
  const caseId = String(formData.get("caseId") ?? "");
  const officer = String(formData.get("officerAccountId") ?? "");

  return run(caseId, async () => {
    const actor = await actorOrLogin();
    await assignCase(actor, caseId, officer || null, newRequestMeta(await headers()));
  });
}

export async function addPartyAction(formData: FormData) {
  const caseId = String(formData.get("caseId") ?? "");
  const partyRole = String(formData.get("partyRole") ?? "witness") as PartyRole;
  const kind = String(formData.get("kind") ?? "external");
  const userAccountId = String(formData.get("userAccountId") ?? "") || null;
  const externalName = String(formData.get("externalName") ?? "").trim() || null;

  return run(caseId, async () => {
    const actor = await actorOrLogin();
    await addParty(
      actor,
      caseId,
      kind === "account"
        ? { partyRole, userAccountId }
        : kind === "anonymous"
          ? { partyRole, isAnonymous: true }
          : { partyRole, externalName },
      newRequestMeta(await headers()),
    );
  });
}

export async function removePartyAction(formData: FormData) {
  const caseId = String(formData.get("caseId") ?? "");
  const partyId = String(formData.get("partyId") ?? "");

  return run(caseId, async () => {
    const actor = await actorOrLogin();
    await removeParty(actor, partyId, newRequestMeta(await headers()));
  });
}

export async function addNoteAction(formData: FormData) {
  const caseId = String(formData.get("caseId") ?? "");
  const body = String(formData.get("body") ?? "");
  const visibility = String(formData.get("visibility") ?? "internal") as NoteVisibility;

  return run(caseId, async () => {
    const actor = await actorOrLogin();
    await addNote(actor, caseId, body, visibility, newRequestMeta(await headers()));
  });
}

export async function removeNoteAction(formData: FormData) {
  const caseId = String(formData.get("caseId") ?? "");
  const noteId = String(formData.get("noteId") ?? "");

  return run(caseId, async () => {
    const actor = await actorOrLogin();
    await removeNote(actor, noteId, newRequestMeta(await headers()));
  });
}

export async function uploadEvidenceAction(formData: FormData) {
  const caseId = String(formData.get("caseId") ?? "");
  const file = formData.get("file");

  return run(caseId, async () => {
    const actor = await actorOrLogin();
    if (!(file instanceof File) || file.size === 0) {
      throw new RejectedUploadError("Choose a file to attach.");
    }
    const bytes = Buffer.from(await file.arrayBuffer());
    await attachEvidenceToCase(actor, caseId, bytes, file.name, newRequestMeta(await headers()));
  });
}

export async function recordOutcomeAction(formData: FormData) {
  const caseId = String(formData.get("caseId") ?? "");
  const finding = String(formData.get("finding") ?? "inconclusive") as Finding;
  const rationale = String(formData.get("rationale") ?? "");

  return run(caseId, async () => {
    const actor = await actorOrLogin();
    await recordOutcome(actor, caseId, { finding, rationale }, newRequestMeta(await headers()));
  });
}

export async function addSanctionAction(formData: FormData) {
  const caseId = String(formData.get("caseId") ?? "");
  const outcomeId = String(formData.get("outcomeId") ?? "");
  const subjectPartyId = String(formData.get("subjectPartyId") ?? "");
  const sanctionType = String(formData.get("sanctionType") ?? "warning") as SanctionType;
  const description = String(formData.get("description") ?? "");
  const effectiveFrom = String(formData.get("effectiveFrom") ?? "");
  const effectiveTo = String(formData.get("effectiveTo") ?? "");

  return run(caseId, async () => {
    const actor = await actorOrLogin();
    await addSanction(
      actor,
      outcomeId,
      {
        subjectPartyId,
        sanctionType,
        description,
        effectiveFrom: new Date(effectiveFrom),
        effectiveTo: effectiveTo ? new Date(effectiveTo) : null,
      },
      newRequestMeta(await headers()),
    );
  });
}

import { beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { prisma } from "../src/lib/db";
import { submitAnonymousReport, submitReport } from "../src/server/reports";
import { triageReport } from "../src/server/cases";
import { addParty } from "../src/server/parties";
import { addNote, editNote, listNotes, removeNote } from "../src/server/notes";
import type { Actor } from "../src/lib/auth/rbac";

const meta = () => ({ requestId: randomUUID(), ipHash: null, userAgent: "vitest" });

let institutionId: string;
let admin: Actor;
let officer: Actor;
let outsider: Actor;
let partyActor: Actor;
let reporterActor: Actor;

async function reporterAt(index: number): Promise<Actor> {
  const account = await prisma.userAccount.findFirstOrThrow({
    where: { institutionId, email: { startsWith: `reporter${index}@` } },
  });
  return { accountId: account.id, institutionId, roles: ["reporter"] };
}

/** A case with all three note visibilities on it. */
async function aCaseWithNotes(): Promise<string> {
  const { referenceCode } = await submitAnonymousReport(
    institutionId,
    {
      title: "Notes fixture",
      description: "A description that comfortably exceeds the minimum length requirement.",
      severitySelfReported: "moderate",
      categoryId: null, locationId: null, occurredAt: null,
    },
    meta(),
  );
  const report = await prisma.report.findUniqueOrThrow({ where: { referenceCode } });
  const { caseNumber } = await triageReport(
    admin, report.id,
    { severity: "moderate", title: "Notes fixture", confidentiality: "standard" },
    meta(),
  );
  const kase = await prisma.case.findFirstOrThrow({ where: { institutionId, caseNumber } });

  await addNote(officer, kase.id, "internal only", "internal", meta());
  await addNote(officer, kase.id, "for the parties", "shared_with_parties", meta());
  await addNote(officer, kase.id, "for the reporter", "reporter_visible", meta());
  return kase.id;
}

beforeAll(async () => {
  const inst = await prisma.institution.findFirstOrThrow({ where: { code: "NGU" } });
  institutionId = inst.id;

  const a = await prisma.userAccount.findFirstOrThrow({
    where: { institutionId, roles: { some: { role: "admin", revokedAt: null } } },
  });
  admin = { accountId: a.id, institutionId, roles: ["admin"] };

  const o = await prisma.userAccount.findFirstOrThrow({
    where: { institutionId, roles: { some: { role: "officer", revokedAt: null } } },
  });
  officer = { accountId: o.id, institutionId, roles: ["officer"] };

  outsider = await reporterAt(2);
  partyActor = await reporterAt(3);
  reporterActor = await reporterAt(4);
});

describe("visibility", () => {
  it("shows staff every note", async () => {
    const caseId = await aCaseWithNotes();
    const seen = await listNotes(officer, caseId);
    expect(seen.map((n) => n.visibility).sort()).toEqual(
      ["internal", "reporter_visible", "shared_with_parties"],
    );
  });

  it("shows an uninvolved reporter nothing at all", async () => {
    const caseId = await aCaseWithNotes();
    expect(await listNotes(outsider, caseId)).toEqual([]);
  });

  it("shows a party the shared note and not the internal one", async () => {
    const caseId = await aCaseWithNotes();
    await addParty(admin, caseId, { partyRole: "respondent", userAccountId: partyActor.accountId }, meta());

    const seen = await listNotes(partyActor, caseId);
    expect(seen.map((n) => n.visibility)).toEqual(["shared_with_parties"]);
    expect(seen.map((n) => n.body)).not.toContain("internal only");
  });

  it("shows the attributed reporter the reporter-visible note only", async () => {
    // An attributed report, triaged into its own case.
    const { referenceCode } = await submitReport(
      reporterActor,
      {
        title: "Attributed for notes",
        description: "A description that comfortably exceeds the minimum length requirement.",
        severitySelfReported: "moderate",
        categoryId: null, locationId: null, occurredAt: null,
      },
      meta(),
    );
    const report = await prisma.report.findUniqueOrThrow({ where: { referenceCode } });
    const { caseNumber } = await triageReport(
      admin, report.id,
      { severity: "moderate", title: "Attributed for notes", confidentiality: "standard" },
      meta(),
    );
    const kase = await prisma.case.findFirstOrThrow({ where: { institutionId, caseNumber } });

    await addNote(officer, kase.id, "internal only", "internal", meta());
    await addNote(officer, kase.id, "for the reporter", "reporter_visible", meta());

    const seen = await listNotes(reporterActor, kase.id);
    expect(seen.map((n) => n.visibility)).toEqual(["reporter_visible"]);
  });
});

describe("addNote", () => {
  it("refuses a reporter", async () => {
    const caseId = await aCaseWithNotes();
    await expect(
      addNote(outsider, caseId, "should not land", "internal", meta()),
    ).rejects.toThrow(/not permitted/i);
  });

  it("audits the addition", async () => {
    const caseId = await aCaseWithNotes();
    expect(
      await prisma.auditEvent.count({ where: { entityId: caseId, action: "case.note_added" } }),
    ).toBe(3);
  });
});

describe("editNote", () => {
  it("keeps both bodies in the audit trail", async () => {
    const caseId = await aCaseWithNotes();
    const id = await addNote(officer, caseId, "first wording", "internal", meta());

    await editNote(officer, id, "second wording", meta());

    const audit = await prisma.auditEvent.findFirstOrThrow({
      where: { entityId: caseId, action: "case.note_updated" },
      orderBy: { occurredAt: "desc" },
    });
    expect(audit.before).toMatchObject({ body: "first wording" });
    expect(audit.after).toMatchObject({ body: "second wording" });
  });
});

describe("removeNote", () => {
  it("hides the note but keeps the row", async () => {
    const caseId = await aCaseWithNotes();
    const id = await addNote(officer, caseId, "temporary", "internal", meta());

    await removeNote(officer, id, meta());

    expect((await listNotes(officer, caseId)).map((n) => n.id)).not.toContain(id);
    expect((await prisma.caseNote.findUniqueOrThrow({ where: { id } })).deletedAt).not.toBeNull();
  });
});

import { beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { prisma } from "../src/lib/db";
import { submitAnonymousReport } from "../src/server/reports";
import { triageReport } from "../src/server/cases";
import { attachEvidenceToCase, listEvidenceForCase, readEvidence } from "../src/server/evidence";
import { MAX_UPLOAD_BYTES, inspectUpload } from "../src/lib/upload/inspect";
import type { Actor } from "../src/lib/auth/rbac";

const meta = () => ({ requestId: randomUUID(), ipHash: null, userAgent: "vitest" });

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01, 0x02]);
const PDF = Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.from("body")]);
const EXE = Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00]); // "MZ" — a PE binary

let institutionId: string;
let admin: Actor;
let foreignActor: Actor;

async function aCase(): Promise<string> {
  const { referenceCode } = await submitAnonymousReport(
    institutionId,
    {
      title: "Evidence fixture",
      description: "A description that comfortably exceeds the minimum length requirement.",
      severitySelfReported: "moderate",
      categoryId: null, locationId: null, occurredAt: null,
    },
    meta(),
  );
  const report = await prisma.report.findUniqueOrThrow({ where: { referenceCode } });
  const { caseNumber } = await triageReport(
    admin, report.id,
    { severity: "moderate", title: "Evidence fixture", confidentiality: "standard" },
    meta(),
  );
  const kase = await prisma.case.findFirstOrThrow({ where: { institutionId, caseNumber } });
  return kase.id;
}

beforeAll(async () => {
  const inst = await prisma.institution.findFirstOrThrow({ where: { code: "NGU" } });
  institutionId = inst.id;
  const a = await prisma.userAccount.findFirstOrThrow({
    where: { institutionId, roles: { some: { role: "admin", revokedAt: null } } },
  });
  admin = { accountId: a.id, institutionId, email: a.email, roles: ["admin"] };

  const other = await prisma.userAccount.findFirstOrThrow({
    where: { institutionId: { not: institutionId } },
  });
  foreignActor = {
    accountId: other.id,
    institutionId: other.institutionId,
    email: other.email,
    roles: ["admin"],
  };
});

describe("inspectUpload", () => {
  it("accepts a PNG named .png", () => {
    expect(inspectUpload(PNG, "photo.png").mimeType).toBe("image/png");
  });

  it("rejects a PNG renamed .exe", () => {
    // Content is fine; the NAME is what a careless viewer acts on.
    expect(() => inspectUpload(PNG, "photo.exe")).toThrow(/ends in/i);
  });

  it("rejects an executable renamed .png", () => {
    // The one that matters: the declared type and extension both look harmless.
    expect(() => inspectUpload(EXE, "harmless.png")).toThrow(/Only PNG, JPEG/i);
  });

  it("rejects an archive and anything else unrecognised", () => {
    const zip = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00]);
    expect(() => inspectUpload(zip, "bundle.zip")).toThrow(/Only PNG, JPEG/i);
  });

  it("rejects an oversize file", () => {
    const big = Buffer.alloc(MAX_UPLOAD_BYTES + 1, 0x41);
    expect(() => inspectUpload(big, "big.txt")).toThrow(/MB or smaller/i);
  });

  it("rejects an empty file", () => {
    expect(() => inspectUpload(Buffer.alloc(0), "nothing.txt")).toThrow(/empty/i);
  });

  it("accepts plain text and refuses binary wearing a .txt name", () => {
    expect(inspectUpload(Buffer.from("hello notes"), "notes.txt").mimeType).toBe("text/plain");
    expect(() => inspectUpload(EXE, "notes.txt")).toThrow(/Only PNG, JPEG/i);
  });

  it("derives the storage key from randomness, not the filename", () => {
    const a = inspectUpload(PNG, "photo.png");
    const b = inspectUpload(PNG, "photo.png");
    expect(a.storageKey).not.toBe(b.storageKey);
    expect(a.storageKey).not.toContain("photo");
    expect(a.storageKey).toMatch(/^[0-9a-f]{32}$/);
  });

  it("gives identical bytes an identical digest", () => {
    expect(inspectUpload(PNG, "a.png").sha256).toBe(inspectUpload(PNG, "b.png").sha256);
  });
});

describe("attachEvidenceToCase", () => {
  it("stores the file and returns it in the listing", async () => {
    const caseId = await aCase();
    const id = await attachEvidenceToCase(admin, caseId, PDF, "statement.pdf", meta());

    const listed = await listEvidenceForCase(admin, caseId);
    expect(listed.map((f) => f.id)).toContain(id);
    expect(listed[0].mimeType).toBe("application/pdf");
    expect(listed[0].originalFilename).toBe("statement.pdf");
  });

  it("audits the upload with its digest", async () => {
    const caseId = await aCase();
    await attachEvidenceToCase(admin, caseId, PNG, "shot.png", meta());
    const audit = await prisma.auditEvent.findFirstOrThrow({
      where: { entityId: caseId, action: "evidence.uploaded" },
    });
    expect(audit.after).toMatchObject({ sha256: inspectUpload(PNG, "x.png").sha256 });
  });

  it("stores two rows for two identical uploads", async () => {
    const caseId = await aCase();
    await attachEvidenceToCase(admin, caseId, PNG, "one.png", meta());
    await attachEvidenceToCase(admin, caseId, PNG, "two.png", meta());
    expect(await listEvidenceForCase(admin, caseId)).toHaveLength(2);
  });

  it("refuses a rejected file and writes no row", async () => {
    const caseId = await aCase();
    await expect(
      attachEvidenceToCase(admin, caseId, EXE, "payload.png", meta()),
    ).rejects.toThrow(/Only PNG, JPEG/i);
    expect(await listEvidenceForCase(admin, caseId)).toHaveLength(0);
  });
});

describe("readEvidence", () => {
  it("returns the bytes that were stored", async () => {
    const caseId = await aCase();
    const id = await attachEvidenceToCase(admin, caseId, PDF, "statement.pdf", meta());

    const file = await readEvidence(admin, id);
    expect(file.bytes.equals(PDF)).toBe(true);
    expect(file.mimeType).toBe("application/pdf");
  });

  it("refuses a reader from another institution", async () => {
    const caseId = await aCase();
    const id = await attachEvidenceToCase(admin, caseId, PNG, "shot.png", meta());
    await expect(readEvidence(foreignActor, id)).rejects.toThrow(/not permitted/i);
  });

  it("refuses a file that has not cleared scanning", async () => {
    const caseId = await aCase();
    const id = await attachEvidenceToCase(admin, caseId, PNG, "shot.png", meta());
    await prisma.evidenceFile.update({ where: { id }, data: { scanStatus: "flagged" } });

    await expect(readEvidence(admin, id)).rejects.toThrow(/not cleared scanning/i);
  });
});

describe("the database refuses orphaned evidence", () => {
  it("rejects a row attached to neither a case nor a report", async () => {
    await expect(
      prisma.evidenceFile.create({
        data: {
          institutionId,
          storageKey: randomUUID().replace(/-/g, ""),
          originalFilename: "orphan.png",
          mimeType: "image/png",
          byteSize: BigInt(10),
          sha256: "a".repeat(64),
        },
      }),
    ).rejects.toThrow(/evidence_files_attached/);
  });
});

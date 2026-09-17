import { prisma } from "@/lib/db";
import { withAudit } from "@/lib/audit/withAudit";
import { requireRole, requireSameInstitution, type Actor } from "@/lib/auth/rbac";
import { ForbiddenError, NotFoundError } from "@/lib/errors";
import { inspectUpload } from "@/lib/upload/inspect";
import { storage } from "@/lib/storage";
import type { RequestMeta } from "@/server/accounts";

export type EvidenceView = {
  id: string;
  originalFilename: string;
  mimeType: string;
  byteSize: number;
  sha256: string;
  scanStatus: string;
  createdAt: Date;
};

/** Downloadable only once a scan has cleared it. */
const DOWNLOADABLE = ["clean", "skipped"];

async function caseForEvidence(actor: Actor, caseId: string) {
  const kase = await prisma.case.findFirst({ where: { id: caseId, deletedAt: null } });
  if (!kase) throw new NotFoundError("That case does not exist.");
  requireSameInstitution(actor, kase.institutionId);
  if (kase.confidentiality === "sealed" && !actor.roles.includes("dpo")) {
    throw new ForbiddenError("You are not permitted to access this record.");
  }
  return kase;
}

export async function attachEvidenceToCase(
  actor: Actor,
  caseId: string,
  bytes: Buffer,
  originalFilename: string,
  meta: RequestMeta,
): Promise<string> {
  requireRole(actor, ["officer", "investigator", "admin", "dpo"]);
  const kase = await caseForEvidence(actor, caseId);

  const inspected = inspectUpload(bytes, originalFilename);

  // The object is written first. A metadata row pointing at bytes that were
  // never stored is worse than bytes with no row: the row is what the interface
  // trusts, and the orphaned object is recoverable.
  await storage().put(inspected.storageKey, bytes, inspected.mimeType);

  try {
    return await prisma.$transaction(async (tx) => {
      const file = await tx.evidenceFile.create({
        data: {
          institutionId: kase.institutionId,
          caseId: kase.id,
          uploadedBy: actor.accountId,
          storageKey: inspected.storageKey,
          originalFilename,
          mimeType: inspected.mimeType,
          byteSize: BigInt(inspected.byteSize),
          sha256: inspected.sha256,
          // No scanner ships in phase 2. The gate exists anyway, so wiring one
          // in later is a change to this line rather than an audit of every
          // download path.
          scanStatus: "skipped",
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
          action: "evidence.uploaded",
          entityType: "case",
          entityId: kase.id,
          after: { evidenceId: file.id, sha256: inspected.sha256, bytes: inspected.byteSize },
        },
      );
      return file.id;
    });
  } catch (thrown) {
    await storage().remove(inspected.storageKey);
    throw thrown;
  }
}

export async function listEvidenceForCase(actor: Actor, caseId: string): Promise<EvidenceView[]> {
  requireRole(actor, ["officer", "investigator", "admin", "dpo"]);
  await caseForEvidence(actor, caseId);

  const rows = await prisma.evidenceFile.findMany({
    where: { caseId, deletedAt: null },
    orderBy: { createdAt: "asc" },
  });
  return rows.map((f) => ({
    id: f.id,
    originalFilename: f.originalFilename,
    mimeType: f.mimeType,
    byteSize: Number(f.byteSize),
    sha256: f.sha256,
    scanStatus: f.scanStatus,
    createdAt: f.createdAt,
  }));
}

/**
 * Authorises, then returns the bytes. Never a redirect to a signed URL: that
 * would outlive the check that produced it.
 */
export async function readEvidence(
  actor: Actor,
  evidenceId: string,
): Promise<{ bytes: Buffer; mimeType: string; filename: string }> {
  requireRole(actor, ["officer", "investigator", "admin", "dpo"]);

  const file = await prisma.evidenceFile.findFirst({
    where: { id: evidenceId, deletedAt: null },
  });
  if (!file) throw new NotFoundError("That file does not exist.");

  requireSameInstitution(actor, file.institutionId);
  if (file.caseId) await caseForEvidence(actor, file.caseId);

  if (!DOWNLOADABLE.includes(file.scanStatus)) {
    throw new ForbiddenError("That file has not cleared scanning yet.");
  }

  return {
    bytes: await storage().get(file.storageKey),
    mimeType: file.mimeType,
    filename: file.originalFilename,
  };
}

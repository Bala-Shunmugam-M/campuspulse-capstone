import { beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { prisma } from "../src/lib/db";
import { submitAnonymousReport, submitReport } from "../src/server/reports";
import type { Actor } from "../src/lib/auth/rbac";

const meta = () => ({ requestId: randomUUID(), ipHash: null, userAgent: "vitest" });
const input = {
  title: "Exam paper shared in a group chat",
  description: "A photograph of the question paper circulated the evening before the exam.",
  severitySelfReported: "high" as const,
  categoryId: null,
  locationId: null,
  occurredAt: null,
};

let institutionId: string;
let actor: Actor;

beforeAll(async () => {
  const inst = await prisma.institution.findFirstOrThrow({ where: { code: "NGU" } });
  institutionId = inst.id;
  const account = await prisma.userAccount.findFirstOrThrow({
    where: { institutionId, email: { startsWith: "reporter1@" } },
    include: { roles: { where: { revokedAt: null } } },
  });
  actor = {
    accountId: account.id,
    institutionId,
    email: account.email,
    roles: account.roles.map((r) => r.role),
  };
});

describe("submitReport", () => {
  it("stores an attributed report and audits it", async () => {
    const { referenceCode } = await submitReport(actor, input, meta());
    const report = await prisma.report.findUniqueOrThrow({ where: { referenceCode } });

    expect(report.isAnonymous).toBe(false);
    expect(report.reporterUserId).toBe(actor.accountId);
    expect(report.accessSecretHash).toBeNull();

    const audit = await prisma.auditEvent.findFirst({
      where: { entityId: report.id, action: "report.submitted" },
    });
    expect(audit?.actorUserAccountId).toBe(actor.accountId);
  });
});

describe("submitAnonymousReport", () => {
  it("stores no reporter and returns a secret", async () => {
    const { referenceCode, accessSecret } = await submitAnonymousReport(institutionId, input, meta());
    const report = await prisma.report.findUniqueOrThrow({ where: { referenceCode } });

    expect(report.isAnonymous).toBe(true);
    expect(report.reporterUserId).toBeNull();
    expect(report.accessSecretHash).not.toBeNull();
    expect(accessSecret.replace(/-/g, "").length).toBeGreaterThanOrEqual(52);
  });

  it("audits as anonymous, never naming an actor", async () => {
    const { referenceCode } = await submitAnonymousReport(institutionId, input, meta());
    const report = await prisma.report.findUniqueOrThrow({ where: { referenceCode } });
    const audit = await prisma.auditEvent.findFirstOrThrow({
      where: { entityId: report.id, action: "report.submitted" },
    });

    expect(audit.actorUserAccountId).toBeNull();
    expect(audit.actorLabel).toBe("anonymous");
  });
});

describe("the database refuses an incoherent report", () => {
  it("rejects an anonymous report carrying a reporter id", async () => {
    const account = await prisma.userAccount.findFirstOrThrow({ where: { institutionId } });
    await expect(
      prisma.report.create({
        data: {
          institutionId,
          referenceCode: `CR-BAD-${randomUUID().slice(0, 4).toUpperCase()}`,
          isAnonymous: true,
          reporterUserId: account.id, // incoherent, on purpose
          accessSecretHash: "x",
          title: input.title,
          description: input.description,
          severitySelfReported: "high",
          channel: "web",
        },
      }),
    ).rejects.toThrow(/reports_anonymity_coherent/);
  });
});

import { beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { prisma } from "../src/lib/db";
import { submitAnonymousReport } from "../src/server/reports";
import { changeCaseStatus, triageReport } from "../src/server/cases";
import { addParty } from "../src/server/parties";
import { addSanction, getOutcome, recordOutcome } from "../src/server/outcomes";
import type { Actor } from "../src/lib/auth/rbac";

const meta = () => ({ requestId: randomUUID(), ipHash: null, userAgent: "vitest" });

let institutionId: string;
let admin: Actor;
let localAccountId: string;

async function aCase(): Promise<string> {
  const { referenceCode } = await submitAnonymousReport(
    institutionId,
    {
      title: "Outcome fixture",
      description: "A description that comfortably exceeds the minimum length requirement.",
      severitySelfReported: "moderate",
      categoryId: null, locationId: null, occurredAt: null,
    },
    meta(),
  );
  const report = await prisma.report.findUniqueOrThrow({ where: { referenceCode } });
  const { caseNumber } = await triageReport(
    admin, report.id,
    { severity: "moderate", title: "Outcome fixture", confidentiality: "standard" },
    meta(),
  );
  const kase = await prisma.case.findFirstOrThrow({ where: { institutionId, caseNumber } });
  return kase.id;
}

/** A case walked to pending_decision, ready for a decision. */
async function aCaseAwaitingDecision(): Promise<string> {
  const id = await aCase();
  await changeCaseStatus(admin, id, "triaged", null, meta());
  await changeCaseStatus(admin, id, "under_investigation", null, meta());
  await changeCaseStatus(admin, id, "pending_decision", null, meta());
  return id;
}

beforeAll(async () => {
  const inst = await prisma.institution.findFirstOrThrow({ where: { code: "NGU" } });
  institutionId = inst.id;
  const a = await prisma.userAccount.findFirstOrThrow({
    where: { institutionId, roles: { some: { role: "admin", revokedAt: null } } },
  });
  admin = { accountId: a.id, institutionId, roles: ["admin"] };
  const local = await prisma.userAccount.findFirstOrThrow({
    where: { institutionId, roles: { some: { role: "reporter", revokedAt: null } } },
  });
  localAccountId = local.id;
});

describe("recordOutcome", () => {
  it("records the decision and resolves the case together", async () => {
    const caseId = await aCaseAwaitingDecision();
    await recordOutcome(admin, caseId, { finding: "upheld", rationale: "clear evidence" }, meta());

    const kase = await prisma.case.findUniqueOrThrow({
      where: { id: caseId },
      include: { outcome: true, statusHistory: true },
    });
    expect(kase.status).toBe("resolved");
    expect(kase.resolvedAt).not.toBeNull();
    expect(kase.outcome?.finding).toBe("upheld");
    expect(kase.statusHistory.map((h) => h.toStatus)).toContain("resolved");
  });

  it("refuses an outcome on a case that is not awaiting decision", async () => {
    const caseId = await aCase(); // still submitted
    await expect(
      recordOutcome(admin, caseId, { finding: "upheld", rationale: "too early" }, meta()),
    ).rejects.toThrow(/awaiting decision/i);

    expect(await prisma.outcome.findUnique({ where: { caseId } })).toBeNull();
  });

  it("refuses a second outcome, enforced by the database", async () => {
    const caseId = await aCaseAwaitingDecision();
    await recordOutcome(admin, caseId, { finding: "upheld", rationale: "first" }, meta());

    // Written through Prisma rather than the service: the guarantee must hold
    // even if a future endpoint forgets the status check.
    await expect(
      prisma.outcome.create({
        data: { caseId, finding: "not_upheld", rationale: "second", decidedBy: admin.accountId },
      }),
    ).rejects.toThrow(/Unique constraint|outcomes_case_id_key/i);
  });

  it("audits both the decision and the status change", async () => {
    const caseId = await aCaseAwaitingDecision();
    await recordOutcome(admin, caseId, { finding: "inconclusive", rationale: "unclear" }, meta());

    expect(
      await prisma.auditEvent.count({ where: { entityId: caseId, action: "case.outcome_recorded" } }),
    ).toBe(1);
    const statusAudits = await prisma.auditEvent.count({
      where: { entityId: caseId, action: "case.status_changed" },
    });
    expect(statusAudits).toBeGreaterThan(0);
  });
});

describe("addSanction", () => {
  it("attaches a sanction to a party on the case", async () => {
    const caseId = await aCaseAwaitingDecision();
    const partyId = await addParty(
      admin, caseId, { partyRole: "respondent", userAccountId: localAccountId }, meta(),
    );
    const outcomeId = await recordOutcome(
      admin, caseId, { finding: "upheld", rationale: "substantiated" }, meta(),
    );

    await addSanction(admin, outcomeId, {
      subjectPartyId: partyId,
      sanctionType: "written_reprimand",
      description: "Formal reprimand on file",
      effectiveFrom: new Date("2026-10-01"),
      effectiveTo: new Date("2027-10-01"),
    }, meta());

    const outcome = await getOutcome(admin, caseId);
    expect(outcome?.sanctions).toHaveLength(1);
    expect(outcome?.sanctions[0].sanctionType).toBe("written_reprimand");
  });

  it("refuses a subject party belonging to a different case", async () => {
    const caseA = await aCaseAwaitingDecision();
    const caseB = await aCase();
    const foreignParty = await addParty(
      admin, caseB, { partyRole: "witness", externalName: "Wrong Case" }, meta(),
    );
    const outcomeId = await recordOutcome(
      admin, caseA, { finding: "upheld", rationale: "substantiated" }, meta(),
    );

    await expect(
      addSanction(admin, outcomeId, {
        subjectPartyId: foreignParty,
        sanctionType: "warning",
        description: "should not attach",
        effectiveFrom: new Date("2026-10-01"),
      }, meta()),
    ).rejects.toThrow(/does not belong to this case/i);
  });

  it("refuses a sanction that ends before it begins", async () => {
    const caseId = await aCaseAwaitingDecision();
    const partyId = await addParty(
      admin, caseId, { partyRole: "respondent", externalName: "D. Subject" }, meta(),
    );
    const outcomeId = await recordOutcome(
      admin, caseId, { finding: "upheld", rationale: "substantiated" }, meta(),
    );

    await expect(
      addSanction(admin, outcomeId, {
        subjectPartyId: partyId,
        sanctionType: "suspension",
        description: "backwards range",
        effectiveFrom: new Date("2026-12-01"),
        effectiveTo: new Date("2026-11-01"),
      }, meta()),
    ).rejects.toThrow(/sanctions_effective_range/);
  });
});

import { beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { prisma } from "../src/lib/db";
import { submitAnonymousReport } from "../src/server/reports";
import { triageReport } from "../src/server/cases";
import { addParty, listParties, removeParty } from "../src/server/parties";
import type { Actor } from "../src/lib/auth/rbac";

const meta = () => ({ requestId: randomUUID(), ipHash: null, userAgent: "vitest" });

let institutionId: string;
let admin: Actor;
let dpo: Actor;
let localAccountId: string;
let foreignAccountId: string;

async function aCase(confidentiality: "standard" | "sealed" = "standard"): Promise<string> {
  const { referenceCode } = await submitAnonymousReport(
    institutionId,
    {
      title: "Parties fixture",
      description: "A description that comfortably exceeds the minimum length requirement.",
      severitySelfReported: "moderate",
      categoryId: null,
      locationId: null,
      occurredAt: null,
    },
    meta(),
  );
  const report = await prisma.report.findUniqueOrThrow({ where: { referenceCode } });
  const { caseNumber } = await triageReport(
    admin,
    report.id,
    { severity: "moderate", title: "Parties fixture", confidentiality },
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
  dpo = { accountId: a.id, institutionId, email: a.email, roles: ["dpo"] };

  const local = await prisma.userAccount.findFirstOrThrow({
    where: { institutionId, roles: { some: { role: "reporter", revokedAt: null } } },
  });
  localAccountId = local.id;

  const foreign = await prisma.userAccount.findFirstOrThrow({
    where: { institutionId: { not: institutionId } },
  });
  foreignAccountId = foreign.id;
});

describe("addParty", () => {
  it("adds a party identified by account", async () => {
    const caseId = await aCase();
    const id = await addParty(
      admin, caseId, { partyRole: "complainant", userAccountId: localAccountId }, meta(),
    );
    const parties = await listParties(admin, caseId);
    expect(parties.map((p) => p.id)).toContain(id);
    expect(parties[0].userAccountId).toBe(localAccountId);
  });

  it("adds a party identified only by name", async () => {
    const caseId = await aCase();
    await addParty(
      admin, caseId, { partyRole: "witness", externalName: "A. Visitor" }, meta(),
    );
    const parties = await listParties(admin, caseId);
    expect(parties[0].externalName).toBe("A. Visitor");
    expect(parties[0].userAccountId).toBeNull();
  });

  it("adds an anonymous party with neither account nor name", async () => {
    const caseId = await aCase();
    await addParty(admin, caseId, { partyRole: "complainant", isAnonymous: true }, meta());
    const parties = await listParties(admin, caseId);
    expect(parties[0].isAnonymous).toBe(true);
    expect(parties[0].userAccountId).toBeNull();
    expect(parties[0].externalName).toBeNull();
  });

  it("refuses an account party from another institution", async () => {
    const caseId = await aCase();
    await expect(
      addParty(admin, caseId, { partyRole: "respondent", userAccountId: foreignAccountId }, meta()),
    ).rejects.toThrow(/not permitted/i);
  });

  it("audits the addition", async () => {
    const caseId = await aCase();
    await addParty(admin, caseId, { partyRole: "advisor", externalName: "B. Adviser" }, meta());
    expect(
      await prisma.auditEvent.count({ where: { entityId: caseId, action: "case.party_added" } }),
    ).toBe(1);
  });
});

describe("the database refuses a half-identified party", () => {
  it("rejects a party carrying both an account and a name", async () => {
    const caseId = await aCase();
    // Written through Prisma, not the service: the guarantee must hold even if a
    // future endpoint forgets to check.
    await expect(
      prisma.caseParty.create({
        data: {
          caseId,
          partyRole: "witness",
          userAccountId: localAccountId,
          externalName: "Both At Once",
        },
      }),
    ).rejects.toThrow(/case_parties_identified/);
  });

  it("rejects a party with no identity and no anonymity flag", async () => {
    const caseId = await aCase();
    await expect(
      prisma.caseParty.create({ data: { caseId, partyRole: "witness" } }),
    ).rejects.toThrow(/case_parties_identified/);
  });
});

describe("sealed cases", () => {
  it("refuses parties to an admin and allows them to a dpo", async () => {
    const caseId = await aCase("sealed");
    await expect(listParties(admin, caseId)).rejects.toThrow(/not permitted/i);
    await expect(listParties(dpo, caseId)).resolves.toBeDefined();
  });
});

describe("removeParty", () => {
  it("soft deletes, keeping the row and the audit trail", async () => {
    const caseId = await aCase();
    const id = await addParty(
      admin, caseId, { partyRole: "witness", externalName: "C. Gone" }, meta(),
    );

    await removeParty(admin, id, meta());

    expect((await listParties(admin, caseId)).map((p) => p.id)).not.toContain(id);
    const row = await prisma.caseParty.findUniqueOrThrow({ where: { id } });
    expect(row.deletedAt).not.toBeNull();
    expect(
      await prisma.auditEvent.count({ where: { entityId: caseId, action: "case.party_removed" } }),
    ).toBe(1);
  });
});

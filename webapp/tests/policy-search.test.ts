import { beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { prisma } from "../src/lib/db";
import {
  createPolicy,
  draftVersion,
  publishVersion,
  searchPolicies,
  supersede,
} from "../src/server/policies";
import {
  acknowledge,
  acknowledgementCoverage,
  hasAcknowledged,
} from "../src/server/acknowledgements";
import { ForbiddenError } from "../src/lib/errors";
import type { Actor } from "../src/lib/auth/rbac";

const meta = () => ({ requestId: randomUUID(), ipHash: null, userAgent: "vitest" });

let admin: Actor;
let reporter: Actor;
let officer: Actor;
let otherAdmin: Actor;

async function actorWithRole(institutionCode: string, role: string): Promise<Actor> {
  const inst = await prisma.institution.findFirstOrThrow({ where: { code: institutionCode } });
  const account = await prisma.userAccount.findFirstOrThrow({
    where: {
      institutionId: inst.id,
      roles: { some: { role: role as never, revokedAt: null } },
    },
    include: { roles: { where: { revokedAt: null } } },
  });
  return {
    accountId: account.id,
    institutionId: inst.id,
    email: account.email,
    roles: account.roles.map((r) => r.role),
  };
}

/** A policy whose live version contains `body`. Returns both ids. */
async function publishedPolicy(
  actor: Actor,
  body: string,
): Promise<{ policyId: string; versionId: string }> {
  const policyId = await createPolicy(
    actor,
    {
      code: `SRCH-${randomUUID().slice(0, 8)}`,
      title: "Search fixture",
      ownerDepartment: null,
    },
    meta(),
  );
  const versionId = await draftVersion(
    actor,
    policyId,
    { bodyMarkdown: body, summary: null, effectiveFrom: new Date("2026-01-01") },
    meta(),
  );
  await publishVersion(actor, versionId, new Date("2020-01-01"), meta());
  return { policyId, versionId };
}

beforeAll(async () => {
  admin = await actorWithRole("NGU", "admin");
  reporter = await actorWithRole("NGU", "reporter");
  officer = await actorWithRole("NGU", "officer");
  otherAdmin = await actorWithRole("RIT", "admin");
});

describe("policy search", () => {
  it("finds a published body", async () => {
    const term = `zephyrine${randomUUID().slice(0, 6)}`;
    const { policyId } = await publishedPolicy(admin, `Riding a ${term} indoors is prohibited.`);

    const hits = await searchPolicies(admin, term);
    expect(hits.map((h) => h.policyId)).toContain(policyId);
  });

  it("does not find a draft", async () => {
    const term = `quixotic${randomUUID().slice(0, 6)}`;
    const policyId = await createPolicy(
      admin,
      { code: `SRCH-${randomUUID().slice(0, 8)}`, title: "Draft fixture", ownerDepartment: null },
      meta(),
    );
    await draftVersion(
      admin,
      policyId,
      {
        bodyMarkdown: `The word ${term} appears only in an unpublished draft.`,
        summary: null,
        effectiveFrom: new Date("2020-01-01"),
      },
      meta(),
    );

    expect(await searchPolicies(admin, term)).toEqual([]);
  });

  it("does not find text that has been superseded", async () => {
    const term = `obsolescent${randomUUID().slice(0, 6)}`;
    const { policyId } = await publishedPolicy(admin, `The ${term} rule applied until recently.`);

    // A search result answers "what are the rules", so text no longer in force
    // is worse than no answer at all.
    await supersede(
      admin,
      policyId,
      {
        bodyMarkdown: "Entirely different wording now applies.",
        summary: null,
        effectiveFrom: new Date("2020-06-01"),
      },
      meta(),
    );

    expect(await searchPolicies(admin, term)).toEqual([]);
  });

  it("is scoped to the actor's institution", async () => {
    const term = `borrowed${randomUUID().slice(0, 6)}`;
    const { policyId } = await publishedPolicy(otherAdmin, `A ${term} policy from elsewhere.`);

    expect((await searchPolicies(otherAdmin, term)).map((h) => h.policyId)).toContain(policyId);
    expect(await searchPolicies(admin, term)).toEqual([]);
  });

  it("ranks and marks up the snippet without emitting HTML", async () => {
    const term = `luminous${randomUUID().slice(0, 6)}`;
    await publishedPolicy(admin, `Corridors must remain ${term} at all hours of the night.`);

    const [hit] = await searchPolicies(admin, term);
    expect(hit.rank).toBeGreaterThan(0);
    expect(hit.snippet).toContain("[[HL]]");
    expect(hit.snippet).not.toContain("<b>");
  });

  it("returns nothing for an empty query rather than everything", async () => {
    expect(await searchPolicies(admin, "   ")).toEqual([]);
  });
});

describe("acknowledgements", () => {
  it("counts a double acknowledgement once", async () => {
    const { policyId, versionId } = await publishedPolicy(admin, "Body for double-click.");

    await acknowledge(officer, versionId, meta());
    await acknowledge(officer, versionId, meta());

    const rows = await prisma.policyAcknowledgement.count({
      where: { policyVersionId: versionId, userAccountId: officer.accountId },
    });
    expect(rows).toBe(1);

    const coverage = await acknowledgementCoverage(admin, policyId);
    expect(coverage.done).toBe(1);
  });

  it("writes one audit row for a repeated acknowledgement", async () => {
    const { policyId, versionId } = await publishedPolicy(admin, "Body for audit counting.");

    await acknowledge(officer, versionId, meta());
    await acknowledge(officer, versionId, meta());

    const audits = await prisma.auditEvent.count({
      where: { entityType: "policy", entityId: policyId, action: "policy.acknowledged" },
    });
    expect(audits).toBe(1);
  });

  it("refuses to acknowledge a draft", async () => {
    const policyId = await createPolicy(
      admin,
      { code: `SRCH-${randomUUID().slice(0, 8)}`, title: "Draft", ownerDepartment: null },
      meta(),
    );
    const draft = await draftVersion(
      admin,
      policyId,
      { bodyMarkdown: "Not yet the rules.", summary: null, effectiveFrom: new Date("2020-01-01") },
      meta(),
    );

    await expect(acknowledge(officer, draft, meta())).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("refuses an acknowledgement across a tenant boundary", async () => {
    const { versionId } = await publishedPolicy(otherAdmin, "Another institution's rules.");
    await expect(acknowledge(officer, versionId, meta())).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("drops coverage back when the policy is superseded", async () => {
    const { policyId, versionId } = await publishedPolicy(admin, "The original wording.");

    await acknowledge(officer, versionId, meta());
    await acknowledge(admin, versionId, meta());
    const before = await acknowledgementCoverage(admin, policyId);
    expect(before.done).toBe(2);
    expect(before.liveVersionNo).toBe(1);

    await supersede(
      admin,
      policyId,
      { bodyMarkdown: "The new wording.", summary: null, effectiveFrom: new Date("2020-06-01") },
      meta(),
    );

    // An acknowledgement names a version, so rewriting the text means nobody has
    // read what is now in force.
    const after = await acknowledgementCoverage(admin, policyId);
    expect(after.liveVersionNo).toBe(2);
    expect(after.done).toBe(0);
    expect(after.required).toBe(before.required);

    // The old acknowledgements are still recorded against the old version.
    expect(
      await prisma.policyAcknowledgement.count({ where: { policyVersionId: versionId } }),
    ).toBe(2);
    expect(await hasAcknowledged(officer, versionId)).toBe(true);
  });

  it("shows coverage only to admin and dpo", async () => {
    const { policyId } = await publishedPolicy(admin, "Coverage is a governance figure.");
    await expect(acknowledgementCoverage(officer, policyId)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(acknowledgementCoverage(reporter, policyId)).rejects.toBeInstanceOf(
      ForbiddenError,
    );
  });
});

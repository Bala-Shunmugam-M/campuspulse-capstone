import { beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { prisma } from "../src/lib/db";
import {
  createPolicy,
  draftVersion,
  getPolicy,
  listPolicies,
  publishVersion,
  supersede,
} from "../src/server/policies";
import { AlreadyPublishedError, ForbiddenError } from "../src/lib/errors";
import type { Actor } from "../src/lib/auth/rbac";

const meta = () => ({ requestId: randomUUID(), ipHash: null, userAgent: "vitest" });
const CONCURRENCY = 12;

let admin: Actor;
let reporter: Actor;
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
    roles: account.roles.map((r) => r.role),
  };
}

async function aPolicy(actor: Actor = admin): Promise<string> {
  return createPolicy(
    actor,
    {
      code: `POL-${randomUUID().slice(0, 8)}`,
      title: "Service-layer fixture",
      ownerDepartment: "Student Affairs",
    },
    meta(),
  );
}

beforeAll(async () => {
  admin = await actorWithRole("NGU", "admin");
  reporter = await actorWithRole("NGU", "reporter");
  otherAdmin = await actorWithRole("RIT", "admin");
});

describe("policy authoring", () => {
  it("allocates version numbers as max + 1", async () => {
    const policyId = await aPolicy();
    const ids = [];
    for (let i = 0; i < 3; i++) {
      ids.push(
        await draftVersion(
          admin,
          policyId,
          { bodyMarkdown: `Body ${i}`, summary: null, effectiveFrom: new Date("2026-02-01") },
          meta(),
        ),
      );
    }

    const { versions } = await getPolicy(admin, policyId);
    expect(versions.map((v) => v.versionNo)).toEqual([3, 2, 1]);
    expect(new Set(ids).size).toBe(3);
  });

  it("gives every concurrent draft a distinct version number", async () => {
    const policyId = await aPolicy();

    // The whole point: these run at once. Allocation that reads max(version_no)
    // into JavaScript and adds one hands every caller the same answer.
    await Promise.all(
      Array.from({ length: CONCURRENCY }, (_, i) =>
        draftVersion(
          admin,
          policyId,
          {
            bodyMarkdown: `Concurrent body ${i}`,
            summary: null,
            effectiveFrom: new Date("2026-02-01"),
          },
          meta(),
        ),
      ),
    );

    const { versions } = await getPolicy(admin, policyId);
    const numbers = versions.map((v) => v.versionNo);
    expect(new Set(numbers).size).toBe(CONCURRENCY);
    expect([...numbers].sort((a, b) => a - b)).toEqual(
      Array.from({ length: CONCURRENCY }, (_, i) => i + 1),
    );
  });

  it("refuses a reporter at every authoring entry point", async () => {
    const policyId = await aPolicy();
    const versionId = await draftVersion(
      admin,
      policyId,
      { bodyMarkdown: "Body", summary: null, effectiveFrom: new Date("2026-02-01") },
      meta(),
    );

    await expect(
      createPolicy(reporter, { code: "NOPE", title: "No", ownerDepartment: null }, meta()),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      draftVersion(
        reporter,
        policyId,
        { bodyMarkdown: "Body", summary: null, effectiveFrom: new Date("2026-02-01") },
        meta(),
      ),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      publishVersion(reporter, versionId, new Date("2026-02-01"), meta()),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      supersede(
        reporter,
        policyId,
        { bodyMarkdown: "Body", summary: null, effectiveFrom: new Date("2026-03-01") },
        meta(),
      ),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("refuses an admin from another institution", async () => {
    const policyId = await aPolicy();
    await expect(
      draftVersion(
        otherAdmin,
        policyId,
        { bodyMarkdown: "Body", summary: null, effectiveFrom: new Date("2026-02-01") },
        meta(),
      ),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe("publication", () => {
  it("stamps the publisher and the date, and refuses a second publication", async () => {
    const policyId = await aPolicy();
    const versionId = await draftVersion(
      admin,
      policyId,
      { bodyMarkdown: "Published body.", summary: "s", effectiveFrom: new Date("2026-02-01") },
      meta(),
    );

    await publishVersion(admin, versionId, new Date("2026-03-15"), meta());

    const row = await prisma.policyVersion.findUniqueOrThrow({ where: { id: versionId } });
    expect(row.publishedById).toBe(admin.accountId);
    expect(row.publishedAt).not.toBeNull();
    expect(row.effectiveFrom.toISOString().slice(0, 10)).toBe("2026-03-15");

    await expect(
      publishVersion(admin, versionId, new Date("2026-04-01"), meta()),
    ).rejects.toBeInstanceOf(AlreadyPublishedError);
  });

  it("leaves the published text beyond the reach of any later edit", async () => {
    const policyId = await aPolicy();
    const versionId = await draftVersion(
      admin,
      policyId,
      { bodyMarkdown: "Original text.", summary: null, effectiveFrom: new Date("2026-02-01") },
      meta(),
    );
    await publishVersion(admin, versionId, new Date("2026-02-01"), meta());

    await expect(
      prisma.policyVersion.update({
        where: { id: versionId },
        data: { bodyMarkdown: "Rewritten text." },
      }),
    ).rejects.toThrow(/immutable except for effective_to/);
  });

  it("writes an audit row for every authoring action", async () => {
    const policyId = await aPolicy();
    const versionId = await draftVersion(
      admin,
      policyId,
      { bodyMarkdown: "Body", summary: null, effectiveFrom: new Date("2026-02-01") },
      meta(),
    );
    await publishVersion(admin, versionId, new Date("2026-02-01"), meta());

    const actions = await prisma.auditEvent.findMany({
      where: { entityType: "policy", entityId: policyId },
      orderBy: { occurredAt: "asc" },
      select: { action: true },
    });
    expect(actions.map((a) => a.action)).toEqual([
      "policy.created",
      "policy.version_drafted",
      "policy.version_published",
    ]);
  });
});

describe("supersession", () => {
  it("leaves exactly one version live on any given date", async () => {
    const policyId = await aPolicy();
    const first = await draftVersion(
      admin,
      policyId,
      { bodyMarkdown: "The 2026 rules.", summary: null, effectiveFrom: new Date("2026-01-01") },
      meta(),
    );
    await publishVersion(admin, first, new Date("2026-01-01"), meta());
    await supersede(
      admin,
      policyId,
      { bodyMarkdown: "The revised rules.", summary: null, effectiveFrom: new Date("2026-06-01") },
      meta(),
    );
    await supersede(
      admin,
      policyId,
      {
        bodyMarkdown: "The revised rules, again.",
        summary: null,
        effectiveFrom: new Date("2026-09-01"),
      },
      meta(),
    );

    for (const day of [
      "2026-01-01",
      "2026-05-31",
      "2026-06-01",
      "2026-08-31",
      "2026-09-01",
      "2027-01-01",
    ]) {
      const [row] = await prisma.$queryRaw<{ n: bigint }[]>`
        SELECT count(*) AS n FROM compliance.policy_versions
        WHERE policy_id = ${policyId}::uuid
          AND published_at IS NOT NULL
          AND effective_from <= ${day}::date
          AND (effective_to IS NULL OR effective_to > ${day}::date)`;
      expect(Number(row.n), `on ${day}`).toBe(1);
    }

    // And nothing at all before the first version took effect.
    const [before] = await prisma.$queryRaw<{ n: bigint }[]>`
      SELECT count(*) AS n FROM compliance.policy_versions
      WHERE policy_id = ${policyId}::uuid
        AND published_at IS NOT NULL
        AND effective_from <= '2025-12-31'::date
        AND (effective_to IS NULL OR effective_to > '2025-12-31'::date)`;
    expect(Number(before.n)).toBe(0);
  });

  it("closes the predecessor on the successor's start date, touching nothing else", async () => {
    const policyId = await aPolicy();
    const first = await draftVersion(
      admin,
      policyId,
      { bodyMarkdown: "Original.", summary: "one", effectiveFrom: new Date("2026-01-01") },
      meta(),
    );
    await publishVersion(admin, first, new Date("2026-01-01"), meta());

    await supersede(
      admin,
      policyId,
      { bodyMarkdown: "Replacement.", summary: "two", effectiveFrom: new Date("2026-06-01") },
      meta(),
    );

    const previous = await prisma.policyVersion.findUniqueOrThrow({ where: { id: first } });
    expect(previous.effectiveTo?.toISOString().slice(0, 10)).toBe("2026-06-01");
    expect(previous.bodyMarkdown).toBe("Original.");
    expect(previous.summary).toBe("one");
  });

  it("names the live version on the policy view", async () => {
    const policyId = await aPolicy();
    const first = await draftVersion(
      admin,
      policyId,
      { bodyMarkdown: "Live text.", summary: null, effectiveFrom: new Date("2020-01-01") },
      meta(),
    );
    await publishVersion(admin, first, new Date("2020-01-01"), meta());

    const { policy } = await getPolicy(admin, policyId);
    expect(policy.liveVersionNo).toBe(1);

    const listed = (await listPolicies(admin)).find((p) => p.id === policyId);
    expect(listed?.liveVersionNo).toBe(1);
  });

  it("shows no live version while only a draft exists", async () => {
    const policyId = await aPolicy();
    await draftVersion(
      admin,
      policyId,
      { bodyMarkdown: "Unpublished.", summary: null, effectiveFrom: new Date("2020-01-01") },
      meta(),
    );

    const { policy } = await getPolicy(admin, policyId);
    expect(policy.liveVersionNo).toBeNull();
  });

  it("lists only the actor's own institution", async () => {
    const mine = await aPolicy(admin);
    const theirs = await aPolicy(otherAdmin);

    const ids = (await listPolicies(admin)).map((p) => p.id);
    expect(ids).toContain(mine);
    expect(ids).not.toContain(theirs);
  });
});

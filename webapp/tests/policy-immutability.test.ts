import { beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { prisma } from "../src/lib/db";

/**
 * The refusal is a database trigger, so these writes go through Prisma Client
 * directly rather than through src/server/policies.ts. A service can be
 * bypassed; that is the whole reason the rule lives in the database, and a test
 * that only exercised the service would not prove it.
 */

let institutionId: string;
let publisherId: string;

async function aPolicy(): Promise<string> {
  const policy = await prisma.policy.create({
    data: {
      institutionId,
      code: `IMMUT-${randomUUID().slice(0, 8)}`,
      title: "Immutability fixture",
      ownerDepartment: "Student Affairs",
    },
  });
  return policy.id;
}

beforeAll(async () => {
  const inst = await prisma.institution.findFirstOrThrow({ where: { code: "NGU" } });
  institutionId = inst.id;
  const account = await prisma.userAccount.findFirstOrThrow({
    where: { institutionId, roles: { some: { role: "admin", revokedAt: null } } },
  });
  publisherId = account.id;
});

describe("published policy versions are immutable in the database", () => {
  it("lets a draft be edited freely", async () => {
    const policyId = await aPolicy();
    const draft = await prisma.policyVersion.create({
      data: {
        policyId,
        versionNo: 1,
        bodyMarkdown: "The first draft.",
        summary: "draft",
        effectiveFrom: new Date("2026-01-01"),
      },
    });

    const edited = await prisma.policyVersion.update({
      where: { id: draft.id },
      data: { bodyMarkdown: "A second thought.", summary: "still a draft" },
    });

    expect(edited.bodyMarkdown).toBe("A second thought.");
  });

  it("refuses a body change once the version is published", async () => {
    const policyId = await aPolicy();
    const version = await prisma.policyVersion.create({
      data: {
        policyId,
        versionNo: 1,
        bodyMarkdown: "Students shall not misrepresent authorship.",
        summary: "academic integrity",
        effectiveFrom: new Date("2026-01-01"),
        publishedAt: new Date("2026-01-01T09:00:00Z"),
        publishedById: publisherId,
      },
    });

    await expect(
      prisma.policyVersion.update({
        where: { id: version.id },
        data: { bodyMarkdown: "Students may misrepresent authorship." },
      }),
    ).rejects.toThrow(/immutable except for effective_to/);

    const unchanged = await prisma.policyVersion.findUniqueOrThrow({ where: { id: version.id } });
    expect(unchanged.bodyMarkdown).toBe("Students shall not misrepresent authorship.");
  });

  it("refuses a change to the effective start, the publisher or the version number", async () => {
    const policyId = await aPolicy();
    const version = await prisma.policyVersion.create({
      data: {
        policyId,
        versionNo: 1,
        bodyMarkdown: "Published text.",
        effectiveFrom: new Date("2026-01-01"),
        publishedAt: new Date("2026-01-01T09:00:00Z"),
        publishedById: publisherId,
      },
    });

    for (const data of [
      { effectiveFrom: new Date("2025-06-01") },
      { publishedById: null },
      { versionNo: 7 },
      { summary: "a summary it never had" },
      { publishedAt: new Date("2020-01-01T00:00:00Z") },
    ]) {
      await expect(
        prisma.policyVersion.update({ where: { id: version.id }, data }),
      ).rejects.toThrow(/immutable except for effective_to/);
    }
  });

  it("accepts effective_to on its own, which is how supersession closes a version", async () => {
    const policyId = await aPolicy();
    const version = await prisma.policyVersion.create({
      data: {
        policyId,
        versionNo: 1,
        bodyMarkdown: "Published text.",
        effectiveFrom: new Date("2026-01-01"),
        publishedAt: new Date("2026-01-01T09:00:00Z"),
        publishedById: publisherId,
      },
    });

    const closed = await prisma.policyVersion.update({
      where: { id: version.id },
      data: { effectiveTo: new Date("2026-09-01") },
    });

    expect(closed.effectiveTo?.toISOString().slice(0, 10)).toBe("2026-09-01");
  });

  it("maintains body_tsv itself, so search cannot disagree with the text", async () => {
    const policyId = await aPolicy();
    const version = await prisma.policyVersion.create({
      data: {
        policyId,
        versionNo: 1,
        bodyMarkdown: "Unattended bicycles obstructing a fire escape will be removed.",
        summary: "obstruction",
        effectiveFrom: new Date("2026-01-01"),
      },
    });

    const [row] = await prisma.$queryRaw<{ hit: boolean }[]>`
      SELECT body_tsv @@ plainto_tsquery('english', 'bicycles obstructing') AS hit
      FROM compliance.policy_versions WHERE id = ${version.id}::uuid`;
    expect(row.hit).toBe(true);
  });
});

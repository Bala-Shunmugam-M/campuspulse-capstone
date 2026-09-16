import { beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../src/lib/db";
import { listAuditEvents } from "../src/server/audit";
import type { Actor } from "../src/lib/auth/rbac";

let base: Actor;

beforeAll(async () => {
  const inst = await prisma.institution.findFirstOrThrow({ where: { code: "NGU" } });
  const account = await prisma.userAccount.findFirstOrThrow({ where: { institutionId: inst.id } });
  base = { accountId: account.id, institutionId: inst.id, roles: [] };
});

describe("listAuditEvents", () => {
  it("allows admin and dpo", async () => {
    await expect(listAuditEvents({ ...base, roles: ["admin"] }, {})).resolves.toBeDefined();
    await expect(listAuditEvents({ ...base, roles: ["dpo"] }, {})).resolves.toBeDefined();
  });

  it("refuses officer, investigator and reporter", async () => {
    for (const role of ["officer", "investigator", "reporter"] as const) {
      await expect(listAuditEvents({ ...base, roles: [role] }, {})).rejects.toThrow(/not permitted/i);
    }
  });

  it("returns only the actor's institution", async () => {
    const events = await listAuditEvents({ ...base, roles: ["admin"] }, { limit: 200 });
    expect(events.every((e) => e.institutionId === base.institutionId)).toBe(true);
  });

  it("orders newest first", async () => {
    const events = await listAuditEvents({ ...base, roles: ["admin"] }, { limit: 50 });
    const times = events.map((e) => e.occurredAt.getTime());
    expect([...times].sort((a, b) => b - a)).toEqual(times);
  });

  it("returns the id as a string, not a BigInt", async () => {
    const [first] = await listAuditEvents({ ...base, roles: ["admin"] }, { limit: 1 });
    expect(typeof first.id).toBe("string");
  });
});

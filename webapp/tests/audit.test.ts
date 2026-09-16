import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { prisma } from "../src/lib/db";
import { withAudit, type AuditContext } from "../src/lib/audit/withAudit";

const ctx = (institutionId: string): AuditContext => ({
  actorAccountId: null,
  actorLabel: "test",
  institutionId,
  requestId: randomUUID(),
  ipHash: null,
  userAgent: null,
});

async function anInstitution(): Promise<string> {
  const row = await prisma.institution.findFirst();
  if (!row) throw new Error("run `npm run seed` first");
  return row.id;
}

describe("withAudit", () => {
  it("writes an audit row inside the caller's transaction", async () => {
    const institutionId = await anInstitution();
    const entityId = randomUUID();

    await prisma.$transaction(async (tx) => {
      await withAudit(tx, ctx(institutionId), {
        action: "test.performed",
        entityType: "test",
        entityId,
      });
    });

    const found = await prisma.auditEvent.findFirst({ where: { entityId } });
    expect(found?.action).toBe("test.performed");
  });

  it("discards the audit row when the transaction rolls back", async () => {
    const institutionId = await anInstitution();
    const entityId = randomUUID();

    await expect(
      prisma.$transaction(async (tx) => {
        await withAudit(tx, ctx(institutionId), {
          action: "test.performed",
          entityType: "test",
          entityId,
        });
        throw new Error("deliberate rollback");
      }),
    ).rejects.toThrow("deliberate rollback");

    const found = await prisma.auditEvent.findFirst({ where: { entityId } });
    expect(found).toBeNull();
  });

  it("refuses updates and deletes", async () => {
    const institutionId = await anInstitution();
    const entityId = randomUUID();

    await prisma.$transaction((tx) =>
      withAudit(tx, ctx(institutionId), {
        action: "test.performed",
        entityType: "test",
        entityId,
      }),
    );

    await expect(
      prisma.$executeRaw`UPDATE compliance.audit_events SET action = 'tampered' WHERE entity_id = ${entityId}::uuid`,
    ).rejects.toThrow(/append-only/);

    await expect(
      prisma.$executeRaw`DELETE FROM compliance.audit_events WHERE entity_id = ${entityId}::uuid`,
    ).rejects.toThrow(/append-only/);
  });
});

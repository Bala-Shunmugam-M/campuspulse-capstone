import { beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { prisma } from "../src/lib/db";
import { submitAnonymousReport } from "../src/server/reports";
import { triageReport } from "../src/server/cases";
import type { Actor } from "../src/lib/auth/rbac";

/**
 * An audit log is read by people. A wall of uuids is not a log anyone reads, so
 * actor_label carries the actor's email -- alongside actor_user_account_id,
 * which is what actually identifies the actor and is never a display concern.
 */

const meta = () => ({ requestId: randomUUID(), ipHash: null, userAgent: "vitest" });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

let institutionId: string;
let officer: Actor;

beforeAll(async () => {
  const inst = await prisma.institution.findFirstOrThrow({ where: { code: "NGU" } });
  institutionId = inst.id;
  const account = await prisma.userAccount.findFirstOrThrow({
    where: { institutionId, roles: { some: { role: "officer", revokedAt: null } } },
    include: { roles: { where: { revokedAt: null } } },
  });
  officer = {
    accountId: account.id,
    institutionId,
    email: account.email,
    roles: account.roles.map((r) => r.role),
  };
});

describe("audit actor labels", () => {
  it("names the actor by email on a new event", async () => {
    const { referenceCode } = await submitAnonymousReport(
      institutionId,
      {
        title: "Audit label fixture",
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
      officer,
      report.id,
      { severity: "moderate", title: "Audit label fixture", confidentiality: "standard" },
      meta(),
    );
    const kase = await prisma.case.findFirstOrThrow({ where: { institutionId, caseNumber } });

    const event = await prisma.auditEvent.findFirstOrThrow({
      where: { entityType: "case", entityId: kase.id, action: "case.opened" },
    });

    expect(event.actorLabel).toBe(officer.email);
    expect(event.actorLabel).not.toMatch(UUID);
    // The identifying column is untouched: the label is a second rendering of
    // it, not a replacement for it.
    expect(event.actorUserAccountId).toBe(officer.accountId);
  });

  it("still labels an actorless event 'anonymous'", async () => {
    const { referenceCode } = await submitAnonymousReport(
      institutionId,
      {
        title: "Anonymous label fixture",
        description: "A description that comfortably exceeds the minimum length requirement.",
        severitySelfReported: "low",
        categoryId: null,
        locationId: null,
        occurredAt: null,
      },
      meta(),
    );
    const report = await prisma.report.findUniqueOrThrow({ where: { referenceCode } });

    const event = await prisma.auditEvent.findFirstOrThrow({
      where: { entityType: "report", entityId: report.id, action: "report.submitted" },
    });
    expect(event.actorLabel).toBe("anonymous");
    expect(event.actorUserAccountId).toBeNull();
  });

  it("leaves no row anywhere labelled with its own actor id", async () => {
    // Covers the backfill as well as new writes: after the migration no row in
    // the table should still be naming its actor by uuid.
    const [row] = await prisma.$queryRaw<{ n: bigint }[]>`
      SELECT count(*) AS n FROM compliance.audit_events
      WHERE actor_user_account_id IS NOT NULL
        AND actor_label = actor_user_account_id::text`;
    expect(Number(row.n)).toBe(0);
  });

  it("keeps the append-only triggers the backfill had to drop and recreate", async () => {
    const [row] = await prisma.$queryRaw<{ n: bigint }[]>`
      SELECT count(*) AS n FROM pg_trigger t
      JOIN pg_class c ON c.oid = t.tgrelid
      WHERE c.relname = 'audit_events' AND NOT t.tgisinternal`;
    expect(Number(row.n)).toBe(2);

    const event = await prisma.auditEvent.findFirstOrThrow({ orderBy: { id: "desc" } });
    await expect(
      prisma.auditEvent.update({
        where: { id: event.id },
        data: { actorLabel: "someone else entirely" },
      }),
    ).rejects.toThrow(/append-only/);
  });
});

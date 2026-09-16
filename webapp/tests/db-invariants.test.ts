import { describe, expect, it } from "vitest";
import { prisma } from "../src/lib/db";

/**
 * Guarantees enforced in SQL rather than in the Prisma schema: composite keys,
 * partial indexes, CHECK constraints, triggers and generated columns.
 *
 * Prisma Migrate diffs the whole datasource against schema.prisma and drops
 * whatever it cannot see there. It has already done so once -- a generated
 * migration removed user_accounts_tenant_fk, and the tenant boundary was gone
 * for several commits before a test noticed. These assertions make that failure
 * loud and immediate rather than silent.
 */

async function count(sql: Promise<{ n: bigint }[]>): Promise<number> {
  return Number((await sql)[0].n);
}

describe("database invariants that Prisma cannot express", () => {
  it("keeps the composite tenant foreign key on user_accounts", async () => {
    const n = await count(prisma.$queryRaw<{ n: bigint }[]>`
      SELECT count(*) AS n FROM pg_constraint WHERE conname = 'user_accounts_tenant_fk'`);
    expect(n, "user_accounts_tenant_fk is missing; a migration dropped it").toBe(1);
  });

  it("keeps the live-grant partial unique index on role_assignments", async () => {
    const n = await count(prisma.$queryRaw<{ n: bigint }[]>`
      SELECT count(*) AS n FROM pg_indexes WHERE indexname = 'role_assignments_live_unique'`);
    expect(n).toBe(1);
  });

  it("keeps the anonymity CHECK constraint on reports", async () => {
    const n = await count(prisma.$queryRaw<{ n: bigint }[]>`
      SELECT count(*) AS n FROM pg_constraint WHERE conname = 'reports_anonymity_coherent'`);
    expect(n).toBe(1);
  });

  it("keeps both append-only triggers on audit_events", async () => {
    const n = await count(prisma.$queryRaw<{ n: bigint }[]>`
      SELECT count(*) AS n FROM pg_trigger t
      JOIN pg_class c ON c.oid = t.tgrelid
      WHERE c.relname = 'audit_events' AND NOT t.tgisinternal`);
    expect(n).toBe(2);
  });

  it("keeps the generated search column and its GIN index on reports", async () => {
    const column = await count(prisma.$queryRaw<{ n: bigint }[]>`
      SELECT count(*) AS n FROM information_schema.columns
      WHERE table_schema = 'compliance' AND table_name = 'reports' AND column_name = 'search_tsv'`);
    const index = await count(prisma.$queryRaw<{ n: bigint }[]>`
      SELECT count(*) AS n FROM pg_indexes WHERE indexname = 'reports_search_idx'`);
    expect({ column, index }).toEqual({ column: 1, index: 1 });
  });

  it("keeps the case-number allocator function", async () => {
    const n = await count(prisma.$queryRaw<{ n: bigint }[]>`
      SELECT count(*) AS n FROM pg_proc p
      JOIN pg_namespace ns ON ns.oid = p.pronamespace
      WHERE ns.nspname = 'compliance' AND p.proname = 'next_case_number'`);
    expect(n, "compliance.next_case_number is missing; a migration dropped it").toBe(1);
  });

  it("holds no cross-tenant accounts", async () => {
    const n = await count(prisma.$queryRaw<{ n: bigint }[]>`
      SELECT count(*) AS n FROM compliance.user_accounts ua
      LEFT JOIN campuspulse.users u
        ON u.id = ua.user_id AND u.institution_id = ua.institution_id
      WHERE u.id IS NULL`);
    expect(n).toBe(0);
  });
});

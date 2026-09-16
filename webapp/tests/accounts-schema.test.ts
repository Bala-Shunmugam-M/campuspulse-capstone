import { beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { prisma } from "../src/lib/db";

let institutionA: string;
let institutionB: string;
let userInB: string;

async function aUserIn(institutionId: string, name: string): Promise<string> {
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    INSERT INTO campuspulse.users (institution_id, full_name, email, is_active)
    VALUES (${institutionId}::uuid, ${name}, ${`${name}-${randomUUID()}@tenantb.edu`}, true)
    RETURNING id`;
  return rows[0].id;
}

beforeAll(async () => {
  const a = await prisma.institution.findFirstOrThrow();
  institutionA = a.id;
  const b = await prisma.$queryRaw<{ id: string }[]>`
    INSERT INTO campuspulse.institutions (name, code, domain, timezone, is_active)
    VALUES ('Tenant B', ${`TB${Math.floor(Math.random() * 9000 + 1000)}`}, 'tenantb.edu', 'Asia/Kolkata', true)
    RETURNING id`;
  institutionB = b[0].id;
  userInB = await aUserIn(institutionB, "PersonInB");
});

describe("user_accounts tenant safety", () => {
  it("refuses an account whose user belongs to another institution", async () => {
    await expect(
      prisma.userAccount.create({
        data: {
          userId: userInB,
          institutionId: institutionA, // mismatch, on purpose
          email: "mismatch@example.edu",
          passwordHash: "x",
        },
      }),
    ).rejects.toThrow(/user_accounts_tenant_fk/);
  });
});

describe("role_assignments live uniqueness", () => {
  it("allows re-granting a role after revocation", async () => {
    const account = await prisma.userAccount.create({
      data: {
        userId: await aUserIn(institutionB, "Regrant"),
        institutionId: institutionB,
        email: `r-${randomUUID()}@tenantb.edu`,
        passwordHash: "x",
      },
    });

    const first = await prisma.roleAssignment.create({
      data: { userAccountId: account.id, role: "officer" },
    });
    await prisma.roleAssignment.update({
      where: { id: first.id },
      data: { revokedAt: new Date() },
    });

    await expect(
      prisma.roleAssignment.create({ data: { userAccountId: account.id, role: "officer" } }),
    ).resolves.toBeDefined();
  });

  it("refuses two live grants of the same role", async () => {
    const account = await prisma.userAccount.create({
      data: {
        userId: await aUserIn(institutionB, "Dup"),
        institutionId: institutionB,
        email: `d-${randomUUID()}@tenantb.edu`,
        passwordHash: "x",
      },
    });

    await prisma.roleAssignment.create({ data: { userAccountId: account.id, role: "officer" } });

    // Prisma surfaces P2002 with the index's column list rather than its name,
    // so assert on the columns: they identify role_assignments_live_unique
    // specifically, because it is the only unique index carrying the COALESCE.
    const second = prisma.roleAssignment.create({
      data: { userAccountId: account.id, role: "officer" },
    });
    await expect(second).rejects.toMatchObject({ code: "P2002" });
    await expect(second).rejects.toMatchObject({
      meta: { target: ["user_account_id", "role", "COALESCE(scope_department", "''::text)"] },
    });
  });
});

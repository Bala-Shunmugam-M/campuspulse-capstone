import { beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { prisma } from "../src/lib/db";
import { hashPassword } from "../src/lib/auth/password";
import { authenticate } from "../src/server/accounts";

const meta = () => ({ requestId: randomUUID(), ipHash: null, userAgent: "vitest", at: new Date() });
const PASSWORD = "correct horse battery staple";
let email: string;

async function anAccount(address: string): Promise<string> {
  const inst = await prisma.institution.findFirstOrThrow();
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    INSERT INTO campuspulse.users (institution_id, full_name, email, is_active)
    VALUES (${inst.id}::uuid, 'Login Test', ${address}, true) RETURNING id`;
  const account = await prisma.userAccount.create({
    data: {
      userId: rows[0].id,
      institutionId: inst.id,
      email: address,
      passwordHash: await hashPassword(PASSWORD),
    },
  });
  return account.id;
}

beforeAll(async () => {
  email = `login-${randomUUID()}@northgate.edu`;
  const accountId = await anAccount(email);
  await prisma.roleAssignment.create({ data: { userAccountId: accountId, role: "officer" } });
});

describe("authenticate", () => {
  it("returns the account and its live roles", async () => {
    const result = await authenticate(email, PASSWORD, meta());
    expect(result.email).toBe(email);
    expect(result.roles).toContain("officer");
  });

  it("writes an audit event on success", async () => {
    const before = await prisma.auditEvent.count({ where: { action: "auth.login_succeeded" } });
    await authenticate(email, PASSWORD, meta());
    const after = await prisma.auditEvent.count({ where: { action: "auth.login_succeeded" } });
    expect(after).toBe(before + 1);
  });

  it("rejects a wrong password and audits the failure", async () => {
    const before = await prisma.auditEvent.count({ where: { action: "auth.login_failed" } });
    await expect(authenticate(email, "wrong password here", meta())).rejects.toThrow(
      /Invalid email or password/,
    );
    const after = await prisma.auditEvent.count({ where: { action: "auth.login_failed" } });
    expect(after).toBe(before + 1);
  });

  it("gives the same error for an unknown account as for a wrong password", async () => {
    await expect(
      authenticate(`nobody-${randomUUID()}@northgate.edu`, PASSWORD, meta()),
    ).rejects.toThrow(/Invalid email or password/);
  });

  it("locks the account after five consecutive failures", async () => {
    const lockEmail = `lock-${randomUUID()}@northgate.edu`;
    await anAccount(lockEmail);

    for (let i = 0; i < 5; i++) {
      await expect(authenticate(lockEmail, "wrong password here", meta())).rejects.toThrow();
    }
    // Correct password now, but the account is locked.
    await expect(authenticate(lockEmail, PASSWORD, meta())).rejects.toThrow(/locked/i);
  });
});

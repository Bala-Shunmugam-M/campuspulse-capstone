import { randomUUID } from "node:crypto";
import type { ComplianceRole } from "@prisma/client";
import { prisma } from "@/lib/db";
import { withAudit } from "@/lib/audit/withAudit";
import { hashPassword, verifyPassword } from "@/lib/auth/password";
import { AccountLockedError, InvalidCredentialsError } from "@/lib/errors";
import { adoptSimulatedTime, now } from "@/lib/clock";

export type RequestMeta = {
  requestId: string;
  ipHash: string | null;
  userAgent: string | null;
};

export type AuthenticatedAccount = {
  accountId: string;
  institutionId: string;
  email: string;
  roles: ComplianceRole[];
};

const MAX_FAILURES = 5;
const LOCK_MINUTES = 15;

/**
 * A valid Argon2id hash of a value no user will supply. Computed once at module
 * load so the unknown-account path costs the same as a real verification.
 */
const dummyHash = hashPassword(randomUUID());

/**
 * Verify credentials. Authentication is the one service that cannot begin with
 * an authorisation check -- it produces the identity everything else authorises
 * against.
 */
export async function authenticate(
  email: string,
  plain: string,
  meta: RequestMeta,
): Promise<AuthenticatedAccount> {
  const account = await prisma.userAccount.findFirst({
    where: { email: email.toLowerCase(), deletedAt: null },
    include: { roles: { where: { revokedAt: null } } },
  });

  if (!account) {
    // Hash anyway: a missing account must not be detectably faster than a wrong
    // password. Timing is an enumeration oracle too.
    await verifyPassword(await dummyHash, plain);
    throw new InvalidCredentialsError("Invalid email or password.");
  }

  if (account.lockedUntil && account.lockedUntil > now()) {
    throw new AccountLockedError(
      `This account is locked until ${account.lockedUntil.toISOString()}.`,
    );
  }

  const ctx = {
    actorAccountId: account.id,
    actorLabel: account.email,
    institutionId: account.institutionId,
    requestId: meta.requestId,
    ipHash: meta.ipHash,
    userAgent: meta.userAgent,
  };

  if (!(await verifyPassword(account.passwordHash, plain))) {
    const failures = account.failedLoginCount + 1;
    await prisma.$transaction(async (tx) => {
      await tx.userAccount.update({
        where: { id: account.id },
        data: {
          failedLoginCount: failures,
          lockedUntil:
            failures >= MAX_FAILURES
              ? new Date(now().getTime() + LOCK_MINUTES * 60_000)
              : account.lockedUntil,
        },
      });
      await withAudit(tx, ctx, {
        action: "auth.login_failed",
        entityType: "user_account",
        entityId: account.id,
        after: { failedLoginCount: failures, locked: failures >= MAX_FAILURES },
      });
    });
    throw new InvalidCredentialsError("Invalid email or password.");
  }

  await prisma.$transaction(async (tx) => {
    await tx.userAccount.update({
      where: { id: account.id },
      data: { failedLoginCount: 0, lockedUntil: null, lastLoginAt: now() },
    });
    await withAudit(tx, ctx, {
      action: "auth.login_succeeded",
      entityType: "user_account",
      entityId: account.id,
    });
  });

  return {
    accountId: account.id,
    institutionId: account.institutionId,
    email: account.email,
    roles: account.roles.map((r) => r.role),
  };
}

export function newRequestMeta(headers: Headers): RequestMeta {
  // Every server action starts here, so this is where a simulated request hands
  // the rest of its work a clock. Outside simulation mode the call is a no-op
  // and the header is never read.
  adoptSimulatedTime(headers);

  return {
    requestId: randomUUID(),
    ipHash: null,
    userAgent: headers.get("user-agent"),
  };
}

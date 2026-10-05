import { randomUUID } from "node:crypto";
import { prisma } from "../src/lib/db";
import { assertPasswordAcceptable, hashPassword } from "../src/lib/auth/password";
import { withAudit } from "../src/lib/audit/withAudit";

/**
 * Rotates the password of every seeded demo account to SEED_PASSWORD.
 *
 * For a database that was seeded with the repository's public default -- the
 * hosted Supabase copy -- before it goes on the internet. There is no default
 * here on purpose. Each reset signs that account out everywhere and writes an
 * audit row, like every other change this application makes.
 *
 *   SEED_PASSWORD='…' DATABASE_URL='…' npm run reset-demo-passwords
 */
const SEEDED = /^(admin|dpo|officer|investigator|reporter)\d+@(northgate|riverside|westfield)\.edu$/;

async function main() {
  const password = process.env.SEED_PASSWORD;
  if (!password) throw new Error("Set SEED_PASSWORD to the new demo password.");
  assertPasswordAcceptable(password);
  const passwordHash = await hashPassword(password);

  const accounts = (
    await prisma.userAccount.findMany({
      where: { deletedAt: null },
      select: { id: true, email: true, institutionId: true },
    })
  ).filter((a) => SEEDED.test(a.email));

  const at = new Date();
  const requestId = randomUUID();
  for (const account of accounts) {
    await prisma.$transaction(async (tx) => {
      await tx.userAccount.update({
        where: { id: account.id },
        data: { passwordHash, passwordChangedAt: at, failedLoginCount: 0, lockedUntil: null },
      });
      await tx.session.updateMany({
        where: { userAccountId: account.id, revokedAt: null },
        data: { revokedAt: at },
      });
      await withAudit(
        tx,
        {
          actorAccountId: null,
          actorLabel: "system:reset-demo-passwords",
          institutionId: account.institutionId,
          requestId,
          ipHash: null,
          userAgent: null,
          occurredAt: at,
        },
        {
          action: "account.password_reset",
          entityType: "user_account",
          entityId: account.id,
          after: { reason: "demo password rotated before public deployment" },
        },
      );
    });
  }
  console.log(`Reset ${accounts.length} demo accounts; their open sessions were signed out.`);
}

main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());

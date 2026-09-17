import type { Session } from "@prisma/client";
import { prisma } from "@/lib/db";
import { withAudit } from "@/lib/audit/withAudit";
import type { RequestMeta } from "@/server/accounts";

/** Eight hours, matching the cap Phase 1 put on the JWT. */
const SESSION_HOURS = 8;

/**
 * Sessions are kept on the real clock even under simulation, deliberately.
 *
 * A session is infrastructure rather than part of the record the simulator
 * produces -- spec 8.3 lists cases, notes, outcomes and audit rows, not
 * sessions. Dating them by simulated time would issue every simulated session
 * already months expired, and mixing the two would let last_seen_at fall after
 * revoked_at, which verify.ts rightly refuses. Everything a reader of this
 * dataset actually looks at is dated by the request's own clock; the machinery
 * that let the request in is not.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function issueSession(accountId: string, meta: RequestMeta): Promise<string> {
  const session = await prisma.session.create({
    data: {
      userAccountId: accountId,
      expiresAt: new Date(Date.now() + SESSION_HOURS * 3_600_000),
      ipHash: meta.ipHash,
      userAgent: meta.userAgent,
    },
  });
  return session.id;
}

/**
 * The live session, or null. Null covers every reason a caller must be treated
 * as signed out -- unknown, malformed, revoked or expired -- because the caller
 * should not behave differently for any of them.
 */
export async function loadSession(sessionId: string): Promise<Session | null> {
  // A junk cookie must read as "no session" rather than raising on an invalid
  // uuid cast.
  if (!UUID.test(sessionId)) return null;

  const session = await prisma.session.findFirst({
    where: { id: sessionId, revokedAt: null, expiresAt: { gt: new Date() } },
  });
  if (!session) return null;

  // Best-effort liveness. A failure here must not sign the user out.
  void prisma.session
    .update({ where: { id: session.id }, data: { lastSeenAt: new Date() } })
    .catch(() => undefined);

  return session;
}

export async function revokeSession(sessionId: string, meta: RequestMeta): Promise<void> {
  if (!UUID.test(sessionId)) return;

  const session = await prisma.session.findUnique({ where: { id: sessionId } });
  if (!session || session.revokedAt) return;

  const account = await prisma.userAccount.findUniqueOrThrow({
    where: { id: session.userAccountId },
    select: { institutionId: true, email: true },
  });

  await prisma.$transaction(async (tx) => {
    await tx.session.update({ where: { id: sessionId }, data: { revokedAt: new Date() } });
    await withAudit(
      tx,
      {
        actorAccountId: session.userAccountId,
        actorLabel: account.email,
        institutionId: account.institutionId,
        requestId: meta.requestId,
        occurredAt: meta.at,
        ipHash: meta.ipHash,
        userAgent: meta.userAgent,
      },
      { action: "session.revoked", entityType: "session", entityId: sessionId },
    );
  });
}

/** Every live session for one account: sign out everywhere, or lock an account out. */
export async function revokeAllForAccount(accountId: string, meta: RequestMeta): Promise<void> {
  const live = await prisma.session.findMany({
    where: { userAccountId: accountId, revokedAt: null },
    select: { id: true },
  });
  for (const session of live) {
    await revokeSession(session.id, meta);
  }
}

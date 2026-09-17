import { headers } from "next/headers";
import type { ComplianceRole } from "@prisma/client";
import { auth } from "@/lib/auth/config";
import { adoptSimulatedTime } from "@/lib/clock";
import type { Actor } from "@/lib/auth/rbac";

/**
 * The signed-in actor, or null. Lives outside src/server/ because it produces
 * identity rather than acting on it, the same reason authenticate() is exempt
 * from the service authorisation test.
 */
export async function currentActor(): Promise<Actor | null> {
  // Before auth(), not after: loading the session compares the session's expiry
  // against now(), so a simulated request that adopted its clock afterwards
  // would judge its own freshly issued session to have expired months ago.
  // Outside simulation mode this is a no-op and the header is never read.
  adoptSimulatedTime(await headers());

  const session = await auth();
  if (!session?.user?.accountId) return null;
  return {
    accountId: session.user.accountId,
    institutionId: session.user.institutionId,
    // The session callback reads this from the account on every request, so it
    // cannot go stale the way a value baked into the token would.
    email: session.user.email ?? session.user.accountId,
    roles: (session.user.roles ?? []) as ComplianceRole[],
  };
}

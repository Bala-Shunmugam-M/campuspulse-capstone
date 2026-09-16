import type { ComplianceRole } from "@prisma/client";
import { auth } from "@/lib/auth/config";
import type { Actor } from "@/lib/auth/rbac";

/**
 * The signed-in actor, or null. Lives outside src/server/ because it produces
 * identity rather than acting on it, the same reason authenticate() is exempt
 * from the service authorisation test.
 */
export async function currentActor(): Promise<Actor | null> {
  const session = await auth();
  if (!session?.user?.accountId) return null;
  return {
    accountId: session.user.accountId,
    institutionId: session.user.institutionId,
    roles: (session.user.roles ?? []) as ComplianceRole[],
  };
}

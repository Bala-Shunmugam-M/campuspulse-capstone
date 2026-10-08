import type { ReactNode } from "react";
import { redirect } from "next/navigation";
import { currentActor } from "@/lib/auth/actor";
import { signOut } from "@/lib/auth/config";
import { prisma } from "@/lib/db";
import {
  listNotifications,
  unreadCount,
  markRead,
} from "@/server/notifications";
import { AppShell } from "./AppShell";

export async function Workspace({ children }: { children: ReactNode }) {
  const actor = await currentActor();
  const [institution, notices, unread] = actor
    ? await Promise.all([
        prisma.institution.findUnique({
          where: { id: actor.institutionId },
          select: { name: true },
        }),
        actor.roles.length
          ? listNotifications(actor, { limit: 8 })
          : Promise.resolve([]),
        actor.roles.length ? unreadCount(actor) : Promise.resolve(0),
      ])
    : ([null, [], 0] as const);
  async function signOutAction() {
    "use server";
    await signOut({ redirect: false });
  }
  async function readAction(id: string) {
    "use server";
    const active = await currentActor();
    if (!active) redirect("/login");
    await markRead(active, id);
  }
  return (
    <AppShell
      email={actor?.email ?? null}
      roles={actor?.roles ?? []}
      institution={institution?.name ?? "Campus workspace"}
      notices={notices.map((n) => ({
        ...n,
        createdAt: n.createdAt.toISOString(),
      }))}
      unread={unread}
      signOutAction={signOutAction}
      readAction={readAction}
    >
      {children}
    </AppShell>
  );
}

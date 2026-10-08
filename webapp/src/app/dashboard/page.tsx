import { redirect } from "next/navigation";
import { currentActor } from "@/lib/auth/actor";
import { adminDashboard, officerDashboard } from "@/server/dashboards";
import { listCases } from "@/server/cases";
import { ForbiddenError } from "@/lib/errors";
import { now } from "@/lib/clock";
import { isOverdue } from "@/lib/cases/sla";
import { DashboardView } from "@/components/DashboardView";

export default async function DashboardPage() {
  const actor = await currentActor();
  if (!actor) redirect("/login");
  const governance = actor.roles.some((r) => r === "admin" || r === "dpo");
  const canQueue = actor.roles.some((r) =>
    ["admin", "officer", "investigator"].includes(r),
  );
  try {
    const [dash, admin, page] = await Promise.all([
      officerDashboard(actor),
      governance ? adminDashboard(actor) : Promise.resolve(null),
      canQueue
        ? listCases(actor, { limit: 5, deadline: "open" })
        : Promise.resolve(null),
    ]);
    const asOf = now();
    return (
      <DashboardView
        dash={dash}
        admin={
          admin
            ? {
                ...admin,
                intakeByWeek: admin.intakeByWeek.map((r) => ({
                  ...r,
                  weekStarting: r.weekStarting.toISOString(),
                })),
              }
            : null
        }
        cases={
          page?.rows.map((c) => ({
            ...c,
            slaDueAt: c.slaDueAt.toISOString(),
            overdue: isOverdue(c.slaDueAt, c.status, asOf),
          })) ?? []
        }
        canQueue={canQueue}
        asOf={asOf.toISOString()}
      />
    );
  } catch (error) {
    if (!(error instanceof ForbiddenError)) throw error;
    return (
      <main className="page-standard">
        <h1>Dashboard</h1>
        <p role="alert">You are not permitted to view the dashboard.</p>
      </main>
    );
  }
}

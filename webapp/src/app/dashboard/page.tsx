import Link from "next/link";
import { redirect } from "next/navigation";
import { currentActor } from "@/lib/auth/actor";
import { adminDashboard, officerDashboard, type Share } from "@/server/dashboards";
import { ForbiddenError } from "@/lib/errors";

/**
 * A proportion, never without its denominator. A bare "68%" invites the wrong
 * conclusion when n is 12, and 0/0 is "nothing to report" rather than 0%.
 */
function Proportion({ share, noun }: { share: Share; noun: string }) {
  if (share.percent === null) {
    return <span className="text-slate-600">no {noun} yet</span>;
  }
  return (
    <span>
      <strong>{share.percent.toFixed(1)}%</strong>{" "}
      <span className="text-slate-600">
        ({share.count} of {share.total} {noun})
      </span>
    </span>
  );
}

/** Weekly intake as a sparkline of bars. Twelve bars do not earn a dependency. */
function IntakeBars({ rows }: { rows: { weekStarting: Date; reports: number }[] }) {
  const max = Math.max(1, ...rows.map((r) => r.reports));
  return (
    <div className="mt-3 flex items-end gap-1" role="img" aria-label="Reports per week">
      {rows.map((r) => (
        <div key={r.weekStarting.toISOString()} className="flex flex-1 flex-col items-center gap-1">
          <span
            className="w-full rounded-t-sm bg-slate-700"
            style={{ height: `${Math.max(2, Math.round((r.reports / max) * 80))}px` }}
          />
          <span className="text-[10px] tabular-nums text-slate-600">{r.reports}</span>
          <span className="text-[10px] text-slate-600">
            {r.weekStarting.toISOString().slice(5, 10)}
          </span>
        </div>
      ))}
    </div>
  );
}

function Figure({
  label,
  value,
  href,
  tone,
}: {
  label: string;
  value: string;
  href?: string;
  tone?: "alarm";
}) {
  const body = (
    <div
      className={`rounded border p-4 ${
        tone === "alarm" ? "border-red-300 bg-red-50" : "border-slate-300"
      }`}
    >
      <div
        className={`text-2xl font-semibold ${
          tone === "alarm" ? "text-red-900" : "text-slate-900"
        }`}
      >
        {value}
      </div>
      <div className="mt-1 text-xs uppercase tracking-wide text-slate-600">{label}</div>
    </div>
  );
  return href ? (
    <Link href={href} className="block hover:opacity-80">
      {body}
    </Link>
  ) : (
    body
  );
}

/**
 * A bar per status, drawn with divs rather than a charting library. Six bars do
 * not earn a dependency, and this way the whole thing renders on the server.
 */
function StatusBars({ rows }: { rows: { status: string; count: number }[] }) {
  const max = Math.max(1, ...rows.map((r) => r.count));
  return (
    <ul className="mt-3 flex flex-col gap-2">
      {rows.map((r) => (
        <li key={r.status} className="flex items-center gap-3 text-sm">
          <span className="w-44 shrink-0 text-slate-700">{r.status.replaceAll("_", " ")}</span>
          <span
            className="h-4 rounded-sm bg-slate-700"
            style={{ width: `${Math.round((r.count / max) * 100)}%`, minWidth: "2px" }}
            aria-hidden
          />
          <span className="tabular-nums text-slate-600">{r.count}</span>
        </li>
      ))}
    </ul>
  );
}

export default async function DashboardPage() {
  const actor = await currentActor();
  if (!actor) redirect("/login");

  let dash;
  try {
    dash = await officerDashboard(actor);
  } catch (thrown) {
    // Only a refusal reads as a refusal. Anything else rethrows: swallowing it
    // here would report every bug as a permissions problem.
    if (!(thrown instanceof ForbiddenError)) throw thrown;
    return (
      <main className="mx-auto max-w-2xl px-4 py-10">
        <h1 className="text-2xl font-semibold text-slate-900">Dashboard</h1>
        <p
          role="alert"
          className="mt-4 rounded border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800"
        >
          You are not permitted to view the dashboard.
        </p>
      </main>
    );
  }

  const median = dash.medianFirstResponseHours;
  const isGovernance = actor.roles.some((r) => r === "admin" || r === "dpo");
  const admin = isGovernance ? await adminDashboard(actor) : null;

  return (
    <main className="mx-auto flex min-h-screen max-w-5xl flex-col gap-8 px-4 py-10">
      <header className="flex items-baseline justify-between">
        <h1 className="text-2xl font-semibold text-slate-900">Your workload</h1>
        <nav className="flex gap-4 text-sm text-slate-600">
          <Link className="underline" href="/cases">
            Case queue
          </Link>
          <Link className="underline" href="/policies">
            Policies
          </Link>
          <Link className="underline" href="/directory">
            Directory
          </Link>
        </nav>
      </header>

      <section className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <Figure label="Assigned to you" value={String(dash.mine)} href="/cases?assignedTo=me" />
        <Figure
          label="Overdue"
          value={String(dash.overdue)}
          href="/cases"
          tone={dash.overdue > 0 ? "alarm" : undefined}
        />
        <Figure label="Due in 24 hours" value={String(dash.dueSoon)} href="/cases" />
        <Figure
          label="Unassigned"
          value={String(dash.unassigned)}
          href="/cases?assignedTo=unassigned"
        />
      </section>

      <section>
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-600">
          Median first response
        </h2>
        <p className="mt-2 text-sm text-slate-800">
          {median === null ? (
            "No case has had a first response yet."
          ) : (
            <>
              <strong>{median.toFixed(1)} hours</strong> from a case opening to the first officer
              action on it.
              <span className="mt-1 block text-xs text-slate-600">
                The median, not the mean: one case left open over a holiday should not move this
                number.
              </span>
            </>
          )}
        </p>
      </section>

      <section>
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-600">
          Cases by status
        </h2>
        {dash.byStatus.length === 0 ? (
          <p className="mt-3 text-sm text-slate-600">No cases yet.</p>
        ) : (
          <StatusBars rows={dash.byStatus} />
        )}
        <p className="mt-3 text-xs text-slate-600">
          Sealed cases are excluded from every figure on this page, as they are from the queue.
        </p>
      </section>

      {admin ? (
        <>
          <hr className="border-slate-200" />
          <h2 className="text-xl font-semibold text-slate-900">Across the institution</h2>

          <section className="grid gap-6 md:grid-cols-2">
            <div className="rounded border border-slate-300 p-4">
              <h3 className="text-sm font-semibold uppercase tracking-wide text-slate-600">
                SLA breach rate
              </h3>
              <p className="mt-2 text-sm text-slate-800">
                <Proportion share={admin.slaBreachRate} noun="resolved cases" />
              </p>
              <p className="mt-2 text-xs text-slate-600">
                Measured from the due date stored when each case was opened, against when it was
                resolved. Changing the severity policy today does not restate whether past cases
                breached.
              </p>
            </div>

            <div className="rounded border border-slate-300 p-4">
              <h3 className="text-sm font-semibold uppercase tracking-wide text-slate-600">
                Anonymous reports
              </h3>
              <p className="mt-2 text-sm text-slate-800">
                <Proportion share={admin.anonymousShare} noun="reports" />
              </p>
              <p className="mt-2 text-xs text-slate-600">
                The share of intake submitted without a reporter identity.
              </p>
            </div>
          </section>

          <section>
            <h3 className="text-sm font-semibold uppercase tracking-wide text-slate-600">
              Intake by week
            </h3>
            {admin.intakeByWeek.length === 0 ? (
              <p className="mt-3 text-sm text-slate-600">No reports in this period.</p>
            ) : (
              <IntakeBars rows={admin.intakeByWeek} />
            )}
          </section>

          <section>
            <h3 className="text-sm font-semibold uppercase tracking-wide text-slate-600">
              Officer workload
            </h3>
            <table className="mt-3 w-full border-collapse text-sm">
              <thead>
                <tr className="border-b border-slate-300 text-left text-slate-600">
                  <th className="py-2 pr-3 font-medium">Officer</th>
                  <th className="py-2 pr-3 font-medium">Open</th>
                  <th className="py-2 pr-3 font-medium">Overdue</th>
                </tr>
              </thead>
              <tbody>
                {admin.officerWorkload.map((w) => (
                  <tr key={w.accountId} className="border-b border-slate-200">
                    <td className="py-2 pr-3 font-mono text-xs">{w.email}</td>
                    <td className="py-2 pr-3 tabular-nums">{w.open}</td>
                    <td className="py-2 pr-3 tabular-nums">
                      {w.overdue > 0 ? (
                        <span className="font-semibold text-red-800">{w.overdue}</span>
                      ) : (
                        w.overdue
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>

          <section>
            <h3 className="text-sm font-semibold uppercase tracking-wide text-slate-600">
              Outcome mix
            </h3>
            {admin.outcomeMix.length === 0 ? (
              <p className="mt-3 text-sm text-slate-600">No case has reached an outcome yet.</p>
            ) : (
              <ul className="mt-3 flex flex-col gap-1 text-sm">
                {admin.outcomeMix.map((o) => (
                  <li key={o.finding} className="border-b border-slate-200 py-1">
                    <span className="inline-block w-44 text-slate-700">
                      {o.finding.replaceAll("_", " ")}
                    </span>
                    <Proportion
                      share={{ count: o.count, total: o.total, percent: o.percent }}
                      noun="outcomes"
                    />
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section>
            <h3 className="text-sm font-semibold uppercase tracking-wide text-slate-600">
              Policy acknowledgement coverage
            </h3>
            {admin.policyCoverage.length === 0 ? (
              <p className="mt-3 text-sm text-slate-600">No policy is in force.</p>
            ) : (
              <table className="mt-3 w-full border-collapse text-sm">
                <thead>
                  <tr className="border-b border-slate-300 text-left text-slate-600">
                    <th className="py-2 pr-3 font-medium">Policy</th>
                    <th className="py-2 pr-3 font-medium">In force</th>
                    <th className="py-2 pr-3 font-medium">Acknowledged</th>
                  </tr>
                </thead>
                <tbody>
                  {admin.policyCoverage.map((p) => (
                    <tr key={p.policyId} className="border-b border-slate-200">
                      <td className="py-2 pr-3">
                        <Link className="underline" href={`/policies/${p.policyId}`}>
                          <span className="font-mono text-xs text-slate-600">{p.code}</span>{" "}
                          {p.title}
                        </Link>
                      </td>
                      <td className="py-2 pr-3 tabular-nums">v{p.versionNo}</td>
                      <td className="py-2 pr-3">
                        <Proportion
                          share={{ count: p.done, total: p.required, percent: p.percent }}
                          noun="accounts"
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <p className="mt-3 text-xs text-slate-600">
              Coverage is counted against the version in force. Superseding a policy resets it,
              because nobody has yet read the new text.
            </p>
          </section>
        </>
      ) : null}
    </main>
  );
}

import Link from "next/link";
import { redirect } from "next/navigation";
import { currentActor } from "@/lib/auth/actor";
import { officerDashboard } from "@/server/dashboards";
import { ForbiddenError } from "@/lib/errors";

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
      <div className="mt-1 text-xs uppercase tracking-wide text-slate-500">{label}</div>
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
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
          Median first response
        </h2>
        <p className="mt-2 text-sm text-slate-800">
          {median === null ? (
            "No case has had a first response yet."
          ) : (
            <>
              <strong>{median.toFixed(1)} hours</strong> from a case opening to the first officer
              action on it.
              <span className="mt-1 block text-xs text-slate-500">
                The median, not the mean: one case left open over a holiday should not move this
                number.
              </span>
            </>
          )}
        </p>
      </section>

      <section>
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
          Cases by status
        </h2>
        {dash.byStatus.length === 0 ? (
          <p className="mt-3 text-sm text-slate-600">No cases yet.</p>
        ) : (
          <StatusBars rows={dash.byStatus} />
        )}
        <p className="mt-3 text-xs text-slate-500">
          Sealed cases are excluded from every figure on this page, as they are from the queue.
        </p>
      </section>
    </main>
  );
}

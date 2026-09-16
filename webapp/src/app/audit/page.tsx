import { redirect } from "next/navigation";
import Link from "next/link";
import { currentActor } from "@/lib/auth/actor";
import { listAuditEvents } from "@/server/audit";
import { ForbiddenError } from "@/lib/errors";

const ENTITY_TYPES = ["user_account", "report", "case", "test"];

export default async function AuditPage({
  searchParams,
}: {
  searchParams: Promise<{ entityType?: string; action?: string }>;
}) {
  const actor = await currentActor();
  if (!actor) redirect("/login");

  const { entityType, action } = await searchParams;

  let events;
  try {
    events = await listAuditEvents(actor, {
      entityType: ENTITY_TYPES.includes(entityType ?? "") ? entityType : undefined,
      limit: 200,
    });
  } catch (thrown) {
    // Only a refusal reads as a refusal; anything else is a bug and rethrows.
    if (!(thrown instanceof ForbiddenError)) throw thrown;
    return (
      <main className="mx-auto max-w-2xl px-4 py-10">
        <h1 className="text-2xl font-semibold text-slate-900">Audit log</h1>
        <p
          role="alert"
          className="mt-4 rounded border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800"
        >
          You are not permitted to view the audit log.
        </p>
        <p className="mt-4 text-sm">
          <Link className="underline" href="/cases">
            Back to the queue
          </Link>
        </p>
      </main>
    );
  }

  // Action filtering is applied here rather than in the service, which takes
  // entity filters only; the set of actions is open-ended and grows per feature.
  const visible = action ? events.filter((e) => e.action === action) : events;
  const actions = [...new Set(events.map((e) => e.action))].sort();

  return (
    <main className="mx-auto flex min-h-screen max-w-5xl flex-col gap-6 px-4 py-10">
      <header className="flex items-baseline justify-between">
        <h1 className="text-2xl font-semibold text-slate-900">Audit log</h1>
        <Link className="text-sm text-slate-600 underline" href="/cases">
          Case queue
        </Link>
      </header>

      <p className="text-sm text-slate-600">
        Append-only. Rows cannot be edited or removed, including by an administrator.
      </p>

      <form method="GET" className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-slate-600">Entity type</span>
          <select
            name="entityType"
            defaultValue={entityType ?? ""}
            className="rounded border border-slate-300 px-2 py-1 text-sm"
          >
            <option value="">Any</option>
            {ENTITY_TYPES.map((t) => (
              <option key={t} value={t}>
                {t.replaceAll("_", " ")}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-slate-600">Action</span>
          <select
            name="action"
            defaultValue={action ?? ""}
            className="rounded border border-slate-300 px-2 py-1 text-sm"
          >
            <option value="">Any</option>
            {actions.map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </select>
        </label>
        <button
          type="submit"
          className="rounded border border-slate-300 px-3 py-1 text-sm hover:bg-slate-50"
        >
          Filter
        </button>
      </form>

      <section>
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
          {visible.length} event{visible.length === 1 ? "" : "s"} — newest first
        </h2>
        {visible.length === 0 ? (
          <p className="mt-3 text-sm text-slate-600">No events match.</p>
        ) : (
          <table className="mt-3 w-full border-collapse text-sm">
            <thead>
              <tr className="border-b border-slate-300 text-left text-slate-600">
                <th className="py-2 pr-3 font-medium">When</th>
                <th className="py-2 pr-3 font-medium">Actor</th>
                <th className="py-2 pr-3 font-medium">Action</th>
                <th className="py-2 pr-3 font-medium">Entity</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((e) => (
                <tr key={e.id} className="border-b border-slate-200 align-top">
                  <td className="whitespace-nowrap py-2 pr-3 font-mono text-xs text-slate-600">
                    {e.occurredAt.toISOString().replace("T", " ").slice(0, 19)}
                  </td>
                  <td className="py-2 pr-3">
                    {e.actorUserAccountId ? (
                      <span className="font-mono text-xs">{e.actorLabel}</span>
                    ) : (
                      // An unattributed event is labelled, not blank. A blank cell
                      // reads as missing data; "anonymous" is the actual finding.
                      <span className="rounded border border-slate-300 bg-slate-100 px-2 py-0.5 text-xs text-slate-700">
                        {e.actorLabel}
                      </span>
                    )}
                  </td>
                  <td className="py-2 pr-3 font-medium text-slate-900">{e.action}</td>
                  <td className="py-2 pr-3">
                    <span className="text-slate-700">{e.entityType.replaceAll("_", " ")}</span>
                    <span className="ml-2 font-mono text-xs text-slate-500">
                      {e.entityId.slice(0, 8)}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </main>
  );
}

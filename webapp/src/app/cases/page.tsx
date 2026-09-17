import { headers } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";
import type { CaseStatus, Confidentiality, Severity } from "@prisma/client";
import { currentActor } from "@/lib/auth/actor";
import { listCases, triageReport } from "@/server/cases";
import { isOverdue } from "@/lib/cases/sla";
import { listUntriagedReports } from "@/server/reports";
import { newRequestMeta } from "@/server/accounts";
import { ForbiddenError } from "@/lib/errors";

const SEVERITY_ORDER: Severity[] = ["severe", "high", "moderate", "low"];
const STATUSES: CaseStatus[] = [
  "submitted",
  "triaged",
  "under_investigation",
  "pending_decision",
  "resolved",
  "closed",
  "dismissed",
  "appealed",
];

const SEVERITY_STYLE: Record<string, string> = {
  severe: "bg-red-100 text-red-900 border-red-300",
  high: "bg-orange-100 text-orange-900 border-orange-300",
  moderate: "bg-amber-100 text-amber-900 border-amber-300",
  low: "bg-slate-100 text-slate-700 border-slate-300",
};

/** Small enough that the next-page link is exercised in ordinary use. */
const PAGE_SIZE = 50;

async function triage(formData: FormData) {
  "use server";
  const acting = await currentActor();
  if (!acting) redirect("/login");

  await triageReport(
    acting,
    String(formData.get("reportId") ?? ""),
    {
      severity: String(formData.get("severity") ?? "moderate") as Severity,
      title: String(formData.get("title") ?? "Untitled case"),
      confidentiality: String(formData.get("confidentiality") ?? "standard") as Confidentiality,
    },
    newRequestMeta(await headers()),
  );
  redirect("/cases");
}

export default async function CasesPage({
  searchParams,
}: {
  searchParams: Promise<{
    status?: string;
    severity?: string;
    assignedTo?: string;
    cursor?: string;
  }>;
}) {
  const actor = await currentActor();
  if (!actor) redirect("/login");

  const { status, severity, assignedTo, cursor } = await searchParams;
  const filter = {
    status: STATUSES.includes(status as CaseStatus) ? (status as CaseStatus) : undefined,
    severity: SEVERITY_ORDER.includes(severity as Severity) ? (severity as Severity) : undefined,
    assignedTo: assignedTo || undefined,
    cursor: cursor || undefined,
    limit: PAGE_SIZE,
  };

  const canTriage = actor.roles.some((r) => r === "officer" || r === "admin");

  let page;
  let untriaged;
  try {
    [page, untriaged] = await Promise.all([
      listCases(actor, filter),
      canTriage ? listUntriagedReports(actor) : Promise.resolve([]),
    ]);
  } catch (thrown) {
    // Only a refusal reads as a refusal. Anything else rethrows: swallowing it
    // here would report every bug as a permissions problem.
    if (!(thrown instanceof ForbiddenError)) throw thrown;
    return (
      <main className="mx-auto max-w-2xl px-4 py-10">
        <h1 className="text-2xl font-semibold text-slate-900">Case queue</h1>
        <p
          role="alert"
          className="mt-4 rounded border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800"
        >
          You are not permitted to view the case queue.
        </p>
      </main>
    );
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-5xl flex-col gap-8 px-4 py-10">
      <header className="flex items-baseline justify-between">
        <h1 className="text-2xl font-semibold text-slate-900">Case queue</h1>
        <nav className="flex gap-4 text-sm text-slate-600">
          <Link className="underline" href="/dashboard">
            Dashboard
          </Link>
          <Link className="underline" href="/policies">
            Policies
          </Link>
          <Link className="underline" href="/directory">
            Directory
          </Link>
          <Link className="underline" href="/audit">
            Audit log
          </Link>
        </nav>
      </header>

      <form method="GET" className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-slate-600">Status</span>
          <select
            name="status"
            defaultValue={filter.status ?? ""}
            className="rounded border border-slate-300 px-2 py-1 text-sm"
          >
            <option value="">Any</option>
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {s.replaceAll("_", " ")}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-slate-600">Severity</span>
          <select
            name="severity"
            defaultValue={filter.severity ?? ""}
            className="rounded border border-slate-300 px-2 py-1 text-sm"
          >
            <option value="">Any</option>
            {SEVERITY_ORDER.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-slate-600">Assignee</span>
          <select
            name="assignedTo"
            defaultValue={assignedTo ?? ""}
            className="rounded border border-slate-300 px-2 py-1 text-sm"
          >
            <option value="">Anyone</option>
            <option value="me">Mine</option>
            <option value="unassigned">Unassigned</option>
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
          Cases ({page.rows.length}) — most urgent first
        </h2>
        {page.rows.length === 0 ? (
          <p className="mt-3 text-sm text-slate-600">No cases match.</p>
        ) : (
          <table className="mt-3 w-full border-collapse text-sm">
            <thead>
              <tr className="border-b border-slate-300 text-left text-slate-600">
                <th className="py-2 pr-3 font-medium">Case</th>
                <th className="py-2 pr-3 font-medium">Title</th>
                <th className="py-2 pr-3 font-medium">Severity</th>
                <th className="py-2 pr-3 font-medium">Status</th>
                <th className="py-2 pr-3 font-medium">SLA due</th>
              </tr>
            </thead>
            <tbody>
              {page.rows.map((c) => (
                <tr key={c.id} className="border-b border-slate-200">
                  <td className="py-2 pr-3 font-mono">
                    <Link className="underline" href={`/cases/${c.id}`}>
                      {c.caseNumber}
                    </Link>
                  </td>
                  <td className="py-2 pr-3">{c.title}</td>
                  <td className="py-2 pr-3">
                    <span
                      className={`rounded border px-2 py-0.5 text-xs ${SEVERITY_STYLE[c.severity]}`}
                    >
                      {c.severity}
                    </span>
                  </td>
                  <td className="py-2 pr-3">{c.status.replaceAll("_", " ")}</td>
                  <td className="py-2 pr-3">
                    {c.slaDueAt.toISOString().slice(0, 10)}
                    {isOverdue(c.slaDueAt, c.status, new Date()) ? (
                      <span className="ml-2 rounded border border-red-300 bg-red-100 px-2 py-0.5 text-xs font-semibold text-red-900">
                        Overdue
                      </span>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {page.nextCursor ? (
          <p className="mt-4 text-sm">
            <Link
              className="underline"
              href={`/cases?${new URLSearchParams({
                ...(filter.status ? { status: filter.status } : {}),
                ...(filter.severity ? { severity: filter.severity } : {}),
                ...(assignedTo ? { assignedTo } : {}),
                cursor: page.nextCursor,
              }).toString()}`}
            >
              Next page →
            </Link>
          </p>
        ) : null}
        {cursor ? (
          <p className="mt-2 text-sm">
            <Link className="text-slate-600 underline" href="/cases">
              Back to the first page
            </Link>
          </p>
        ) : null}
      </section>

      {untriaged.length > 0 ? (
        <section>
          <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
            Untriaged reports ({untriaged.length})
          </h2>
          <ul className="mt-3 flex flex-col gap-3">
            {untriaged.map((r) => (
              <li key={r.id} className="rounded border border-slate-300 p-3">
                <div className="flex flex-wrap items-baseline gap-x-3 text-sm">
                  <span className="font-mono text-slate-600">{r.referenceCode}</span>
                  <span className="font-medium text-slate-900">{r.title}</span>
                  <span className="text-xs text-slate-500">
                    {r.isAnonymous ? "anonymous" : "attributed"} · reported{" "}
                    {r.severitySelfReported}
                  </span>
                </div>
                <form action={triage} className="mt-3 flex flex-wrap items-end gap-2">
                  <input type="hidden" name="reportId" value={r.id} />
                  <label className="flex flex-col gap-1">
                    <span className="text-xs text-slate-600">Case title</span>
                    <input
                      name="title"
                      required
                      defaultValue={r.title}
                      className="rounded border border-slate-300 px-2 py-1 text-sm"
                    />
                  </label>
                  <label className="flex flex-col gap-1">
                    <span className="text-xs text-slate-600">Severity</span>
                    <select
                      name="severity"
                      defaultValue={r.severitySelfReported}
                      className="rounded border border-slate-300 px-2 py-1 text-sm"
                    >
                      {SEVERITY_ORDER.map((s) => (
                        <option key={s} value={s}>
                          {s}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="flex flex-col gap-1">
                    <span className="text-xs text-slate-600">Confidentiality</span>
                    <select
                      name="confidentiality"
                      defaultValue="standard"
                      className="rounded border border-slate-300 px-2 py-1 text-sm"
                    >
                      <option value="standard">standard</option>
                      <option value="restricted">restricted</option>
                      <option value="sealed">sealed</option>
                    </select>
                  </label>
                  <button
                    type="submit"
                    className="rounded bg-slate-900 px-3 py-1 text-sm font-medium text-white hover:bg-slate-800"
                  >
                    Open case
                  </button>
                </form>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </main>
  );
}

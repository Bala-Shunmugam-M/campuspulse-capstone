import { redirect } from "next/navigation";
import { currentActor } from "@/lib/auth/actor";
import { getCase } from "@/server/cases";
import { prisma } from "@/lib/db";
import { ForbiddenError, NotFoundError } from "@/lib/errors";

const SEVERITY_STYLE: Record<string, string> = {
  severe: "bg-red-100 text-red-900 border-red-300",
  high: "bg-orange-100 text-orange-900 border-orange-300",
  moderate: "bg-amber-100 text-amber-900 border-amber-300",
  low: "bg-slate-100 text-slate-700 border-slate-300",
};

function Refusal({ message }: { message: string }) {
  return (
    <main className="mx-auto max-w-2xl px-4 py-10">
      <h1 className="text-2xl font-semibold text-slate-900">Case</h1>
      <p
        role="alert"
        className="mt-4 rounded border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800"
      >
        {message}
      </p>
      <p className="mt-4 text-sm">
        <a className="underline" href="/cases">
          Back to the queue
        </a>
      </p>
    </main>
  );
}

export default async function CaseDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const actor = await currentActor();
  if (!actor) redirect("/login");

  const { id } = await params;

  let kase;
  try {
    kase = await getCase(actor, id);
  } catch (thrown) {
    // A refusal reads as a refusal. A stack trace here would leak both the
    // existence of the case and the shape of the query that found it.
    if (thrown instanceof ForbiddenError) {
      return <Refusal message="You are not permitted to access this record." />;
    }
    if (thrown instanceof NotFoundError) {
      return <Refusal message="That case does not exist." />;
    }
    throw thrown;
  }

  const linked = await prisma.caseReport.findMany({
    where: { caseId: kase.id },
    orderBy: { isPrimary: "desc" },
  });
  const reports = await prisma.report.findMany({
    where: { id: { in: linked.map((l) => l.reportId) } },
    select: {
      id: true,
      referenceCode: true,
      title: true,
      isAnonymous: true,
      submittedAt: true,
      severitySelfReported: true,
    },
  });

  const overdue =
    kase.slaDueAt.getTime() < Date.now() &&
    kase.status !== "resolved" &&
    kase.status !== "closed";
  const hoursLeft = Math.round((kase.slaDueAt.getTime() - Date.now()) / 3_600_000);

  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col gap-8 px-4 py-10">
      <header>
        <p className="font-mono text-sm text-slate-600">{kase.caseNumber}</p>
        <h1 className="mt-1 text-2xl font-semibold text-slate-900">{kase.title}</h1>
        <div className="mt-3 flex flex-wrap items-center gap-2 text-sm">
          <span className={`rounded border px-2 py-0.5 text-xs ${SEVERITY_STYLE[kase.severity]}`}>
            {kase.severity}
          </span>
          <span className="rounded border border-slate-300 bg-slate-100 px-2 py-0.5 text-xs text-slate-700">
            {kase.status.replaceAll("_", " ")}
          </span>
          {overdue ? (
            <span className="rounded border border-red-300 bg-red-100 px-2 py-0.5 text-xs font-semibold text-red-900">
              Overdue
            </span>
          ) : null}
        </div>
      </header>

      <section className="rounded border border-slate-300 bg-slate-50 p-4">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">SLA</h2>
        <p className="mt-2 text-sm text-slate-800">
          Due {kase.slaDueAt.toISOString().replace("T", " ").slice(0, 16)} —{" "}
          {overdue ? `${Math.abs(hoursLeft)} hours overdue` : `${hoursLeft} hours remaining`}
        </p>
      </section>

      <section>
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
          Linked reports ({reports.length})
        </h2>
        <ul className="mt-3 flex flex-col gap-2">
          {reports.map((r) => (
            <li key={r.id} className="rounded border border-slate-300 p-3 text-sm">
              <div className="flex flex-wrap items-baseline gap-x-3">
                <span className="font-mono text-slate-600">{r.referenceCode}</span>
                <span className="font-medium text-slate-900">{r.title}</span>
                {linked.find((l) => l.reportId === r.id)?.isPrimary ? (
                  <span className="rounded border border-slate-300 bg-white px-2 py-0.5 text-xs text-slate-600">
                    primary
                  </span>
                ) : null}
              </div>
              <p className="mt-1 text-xs text-slate-500">
                {r.isAnonymous ? "anonymous" : "attributed"} · reported {r.severitySelfReported} ·
                submitted {r.submittedAt.toISOString().slice(0, 10)}
              </p>
            </li>
          ))}
        </ul>
      </section>

      <section>
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
          Status history
        </h2>
        <ol className="mt-3 flex flex-col gap-2">
          {kase.statusHistory.map((h, i) => (
            <li key={i} className="flex items-baseline gap-3 text-sm">
              <span className="font-mono text-xs text-slate-500">
                {h.changedAt.toISOString().replace("T", " ").slice(0, 16)}
              </span>
              <span className="text-slate-800">
                {h.fromStatus ? `${h.fromStatus.replaceAll("_", " ")} → ` : "opened as "}
                {h.toStatus.replaceAll("_", " ")}
              </span>
            </li>
          ))}
        </ol>
      </section>

      <p className="text-sm">
        <a className="underline" href="/cases">
          Back to the queue
        </a>
      </p>
    </main>
  );
}

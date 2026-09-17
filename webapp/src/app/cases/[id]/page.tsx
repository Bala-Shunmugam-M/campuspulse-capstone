import { redirect } from "next/navigation";
import Link from "next/link";
import type { CaseStatus, Finding, SanctionType } from "@prisma/client";
import { currentActor } from "@/lib/auth/actor";
import { getCase } from "@/server/cases";
import { listParties } from "@/server/parties";
import { listNotes } from "@/server/notes";
import { listEvidenceForCase } from "@/server/evidence";
import { getOutcome } from "@/server/outcomes";
import { prisma } from "@/lib/db";
import { TRANSITIONS } from "@/lib/cases/transitions";
import { ForbiddenError, NotFoundError } from "@/lib/errors";
import {
  addNoteAction,
  addPartyAction,
  addSanctionAction,
  assignAction,
  changeStatusAction,
  recordOutcomeAction,
  removeNoteAction,
  removePartyAction,
  uploadEvidenceAction,
} from "./actions";

const VISIBILITY_LABEL: Record<string, string> = {
  internal: "Internal only",
  shared_with_parties: "Shared with parties",
  reporter_visible: "Visible to the reporter",
};

const FINDINGS: Finding[] = ["upheld", "partially_upheld", "not_upheld", "inconclusive"];
const SANCTION_TYPES: SanctionType[] = [
  "warning", "written_reprimand", "probation", "suspension",
  "community_service", "restitution", "referral", "no_action",
];

const STAFF = ["officer", "investigator", "admin", "dpo"];
const label = "text-sm font-semibold uppercase tracking-wide text-slate-500";
const field = "rounded border border-slate-300 px-2 py-1 text-sm";
const button =
  "rounded bg-slate-900 px-3 py-1 text-sm font-medium text-white hover:bg-slate-800";

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
        <Link className="underline" href="/cases">
          Back to the queue
        </Link>
      </p>
    </main>
  );
}

export default async function CaseDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const actor = await currentActor();
  if (!actor) redirect("/login");

  const { id } = await params;
  const { error } = await searchParams;

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

  const isStaff = actor.roles.some((r) => STAFF.includes(r));
  const canDecide = actor.roles.some((r) => r === "officer" || r === "admin");

  const [linked, parties, notes, evidence, outcome, officers, accounts] = await Promise.all([
    prisma.caseReport.findMany({ where: { caseId: kase.id }, orderBy: { isPrimary: "desc" } }),
    listParties(actor, kase.id),
    listNotes(actor, kase.id),
    listEvidenceForCase(actor, kase.id),
    getOutcome(actor, kase.id),
    prisma.userAccount.findMany({
      where: {
        institutionId: kase.institutionId,
        deletedAt: null,
        roles: { some: { role: "officer", revokedAt: null } },
      },
      select: { id: true, email: true },
      orderBy: { email: "asc" },
    }),
    prisma.userAccount.findMany({
      where: { institutionId: kase.institutionId, deletedAt: null },
      select: { id: true, email: true },
      orderBy: { email: "asc" },
      take: 200,
    }),
  ]);

  // "resolved" is deliberately absent: it is reached by recording an outcome,
  // never by a status change, so offering it here would offer a dead button.
  const nextStatuses = TRANSITIONS.filter(
    (t) =>
      t.from === kase.status &&
      t.to !== "resolved" &&
      t.roles.some((role) => actor.roles.includes(role)),
  ).map((t) => t.to as CaseStatus);

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

      {error ? (
        <p
          role="alert"
          className="rounded border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800"
        >
          {error}
        </p>
      ) : null}

      {isStaff ? (
        <section className="rounded border border-slate-300 p-4">
          <h2 className={label}>Progress</h2>
          <div className="mt-3 flex flex-col gap-4">
            {nextStatuses.length > 0 ? (
              <form action={changeStatusAction} className="flex flex-wrap items-end gap-2">
                <input type="hidden" name="caseId" value={kase.id} />
                <label className="flex flex-col gap-1">
                  <span className="text-xs text-slate-600">Move to</span>
                  <select name="to" className={field}>
                    {nextStatuses.map((s) => (
                      <option key={s} value={s}>{s.replaceAll("_", " ")}</option>
                    ))}
                  </select>
                </label>
                <label className="flex flex-col gap-1">
                  <span className="text-xs text-slate-600">Reason (optional)</span>
                  <input name="reason" className={field} />
                </label>
                <button type="submit" className={button}>Change status</button>
              </form>
            ) : (
              <p className="text-sm text-slate-600">
                {kase.status === "pending_decision"
                  ? "This case is awaiting a decision — record its outcome below."
                  : "No status change is available to you from here."}
              </p>
            )}

            {canDecide ? (
              <form action={assignAction} className="flex flex-wrap items-end gap-2">
                <input type="hidden" name="caseId" value={kase.id} />
                <label className="flex flex-col gap-1">
                  <span className="text-xs text-slate-600">Assigned officer</span>
                  <select
                    name="officerAccountId"
                    defaultValue={kase.assignedOfficerId ?? ""}
                    className={field}
                  >
                    <option value="">Unassigned</option>
                    {officers.map((o) => (
                      <option key={o.id} value={o.id}>{o.email}</option>
                    ))}
                  </select>
                </label>
                <button type="submit" className={button}>Assign</button>
              </form>
            ) : null}
          </div>
        </section>
      ) : null}

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

      {isStaff ? (
        <section>
          <h2 className={label}>Parties ({parties.length})</h2>
          <ul className="mt-3 flex flex-col gap-2">
            {parties.length === 0 ? (
              <li className="text-sm text-slate-600">No parties recorded.</li>
            ) : null}
            {parties.map((p) => (
              <li
                key={p.id}
                className="flex items-baseline justify-between rounded border border-slate-300 p-3 text-sm"
              >
                <span>
                  <span className="font-medium text-slate-900">
                    {p.isAnonymous
                      ? "Anonymous party"
                      : (p.externalName ??
                        accounts.find((a) => a.id === p.userAccountId)?.email ??
                        "Account")}
                  </span>
                  <span className="ml-2 rounded border border-slate-300 bg-slate-100 px-2 py-0.5 text-xs text-slate-700">
                    {p.partyRole}
                  </span>
                </span>
                <form action={removePartyAction}>
                  <input type="hidden" name="caseId" value={kase.id} />
                  <input type="hidden" name="partyId" value={p.id} />
                  <button type="submit" className="text-xs text-slate-600 underline">
                    Remove
                  </button>
                </form>
              </li>
            ))}
          </ul>

          <form action={addPartyAction} className="mt-3 flex flex-wrap items-end gap-2">
            <input type="hidden" name="caseId" value={kase.id} />
            <label className="flex flex-col gap-1">
              <span className="text-xs text-slate-600">Role</span>
              <select name="partyRole" className={field}>
                <option value="complainant">complainant</option>
                <option value="respondent">respondent</option>
                <option value="witness">witness</option>
                <option value="advisor">advisor</option>
              </select>
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs text-slate-600">Identified by</span>
              <select name="kind" defaultValue="external" className={field}>
                <option value="account">an account</option>
                <option value="external">a name</option>
                <option value="anonymous">nothing (anonymous)</option>
              </select>
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs text-slate-600">Account</span>
              <select name="userAccountId" className={field}>
                <option value="">—</option>
                {accounts.map((a) => (
                  <option key={a.id} value={a.id}>{a.email}</option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs text-slate-600">Name</span>
              <input name="externalName" className={field} />
            </label>
            <button type="submit" className={button}>Add party</button>
          </form>
        </section>
      ) : null}

      <section>
        <h2 className={label}>Notes ({notes.length})</h2>
        <ul className="mt-3 flex flex-col gap-2">
          {notes.length === 0 ? (
            <li className="text-sm text-slate-600">No notes you can see.</li>
          ) : null}
          {notes.map((n) => (
            <li key={n.id} className="rounded border border-slate-300 p-3 text-sm">
              <div className="flex items-baseline justify-between gap-3">
                <span className="rounded border border-slate-300 bg-slate-100 px-2 py-0.5 text-xs text-slate-700">
                  {VISIBILITY_LABEL[n.visibility] ?? n.visibility}
                </span>
                <span className="font-mono text-xs text-slate-500">
                  {n.createdAt.toISOString().replace("T", " ").slice(0, 16)}
                </span>
              </div>
              <p className="mt-2 whitespace-pre-wrap text-slate-800">{n.body}</p>
              {isStaff ? (
                <form action={removeNoteAction} className="mt-2">
                  <input type="hidden" name="caseId" value={kase.id} />
                  <input type="hidden" name="noteId" value={n.id} />
                  <button type="submit" className="text-xs text-slate-600 underline">
                    Remove
                  </button>
                </form>
              ) : null}
            </li>
          ))}
        </ul>

        {isStaff ? (
          <form action={addNoteAction} className="mt-3 flex flex-col gap-2">
            <input type="hidden" name="caseId" value={kase.id} />
            <textarea name="body" rows={3} required placeholder="Add a note…" className={field} />
            <div className="flex flex-wrap items-end gap-2">
              <label className="flex flex-col gap-1">
                <span className="text-xs text-slate-600">Who can see it</span>
                <select name="visibility" className={field}>
                  <option value="internal">Internal only</option>
                  <option value="shared_with_parties">Shared with parties</option>
                  <option value="reporter_visible">Visible to the reporter</option>
                </select>
              </label>
              <button type="submit" className={button}>Add note</button>
            </div>
          </form>
        ) : null}
      </section>

      {isStaff ? (
        <section>
          <h2 className={label}>Evidence ({evidence.length})</h2>
          <ul className="mt-3 flex flex-col gap-2">
            {evidence.length === 0 ? (
              <li className="text-sm text-slate-600">Nothing attached.</li>
            ) : null}
            {evidence.map((f) => (
              <li
                key={f.id}
                className="flex flex-wrap items-baseline justify-between gap-2 rounded border border-slate-300 p-3 text-sm"
              >
                <span>
                  <Link className="font-medium underline" href={`/evidence/${f.id}`}>
                    {f.originalFilename}
                  </Link>
                  <span className="ml-2 text-xs text-slate-500">
                    {f.mimeType} · {Math.max(1, Math.round(f.byteSize / 1024))} KB · scan{" "}
                    {f.scanStatus}
                  </span>
                </span>
                <span className="font-mono text-xs text-slate-400">{f.sha256.slice(0, 12)}</span>
              </li>
            ))}
          </ul>

          <form action={uploadEvidenceAction} className="mt-3 flex flex-wrap items-end gap-2">
            <input type="hidden" name="caseId" value={kase.id} />
            <input type="file" name="file" required className="text-sm" />
            <button type="submit" className={button}>Attach</button>
          </form>
          <p className="mt-2 text-xs text-slate-500">
            PNG, JPEG, GIF, PDF or plain text, up to 10 MB. The type is read from the
            file&rsquo;s contents, not its name.
          </p>
        </section>
      ) : null}

      {isStaff ? (
        <section>
          <h2 className={label}>Outcome</h2>
          {outcome ? (
            <div className="mt-3 rounded border border-slate-300 p-4 text-sm">
              <p>
                <span className="font-semibold text-slate-900">
                  {outcome.finding.replaceAll("_", " ")}
                </span>
                <span className="ml-2 font-mono text-xs text-slate-500">
                  decided {outcome.decidedAt.toISOString().slice(0, 10)}
                </span>
              </p>
              <p className="mt-2 whitespace-pre-wrap text-slate-800">{outcome.rationale}</p>

              <h3 className="mt-4 text-xs font-semibold uppercase tracking-wide text-slate-500">
                Sanctions ({outcome.sanctions.length})
              </h3>
              <ul className="mt-2 flex flex-col gap-1">
                {outcome.sanctions.map((s) => (
                  <li key={s.id} className="text-slate-800">
                    <span className="font-medium">{s.sanctionType.replaceAll("_", " ")}</span>
                    {" — "}
                    {s.description}
                    <span className="ml-2 font-mono text-xs text-slate-500">
                      {s.effectiveFrom.toISOString().slice(0, 10)}
                      {s.effectiveTo ? ` → ${s.effectiveTo.toISOString().slice(0, 10)}` : ""}
                    </span>
                  </li>
                ))}
              </ul>

              {canDecide && parties.length > 0 ? (
                <form action={addSanctionAction} className="mt-3 flex flex-wrap items-end gap-2">
                  <input type="hidden" name="caseId" value={kase.id} />
                  <input type="hidden" name="outcomeId" value={outcome.id} />
                  <label className="flex flex-col gap-1">
                    <span className="text-xs text-slate-600">Subject</span>
                    <select name="subjectPartyId" required className={field}>
                      {parties.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.isAnonymous ? "Anonymous" : (p.externalName ?? "Account")} (
                          {p.partyRole})
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="flex flex-col gap-1">
                    <span className="text-xs text-slate-600">Sanction</span>
                    <select name="sanctionType" className={field}>
                      {SANCTION_TYPES.map((s) => (
                        <option key={s} value={s}>{s.replaceAll("_", " ")}</option>
                      ))}
                    </select>
                  </label>
                  <label className="flex flex-col gap-1">
                    <span className="text-xs text-slate-600">Description</span>
                    <input name="description" required className={field} />
                  </label>
                  <label className="flex flex-col gap-1">
                    <span className="text-xs text-slate-600">From</span>
                    <input name="effectiveFrom" type="date" required className={field} />
                  </label>
                  <label className="flex flex-col gap-1">
                    <span className="text-xs text-slate-600">To (optional)</span>
                    <input name="effectiveTo" type="date" className={field} />
                  </label>
                  <button type="submit" className={button}>Add sanction</button>
                </form>
              ) : null}
            </div>
          ) : canDecide && kase.status === "pending_decision" ? (
            <form action={recordOutcomeAction} className="mt-3 flex flex-col gap-2">
              <input type="hidden" name="caseId" value={kase.id} />
              <p className="text-sm text-slate-600">
                Recording the outcome resolves the case; the two happen together.
              </p>
              <label className="flex w-48 flex-col gap-1">
                <span className="text-xs text-slate-600">Finding</span>
                <select name="finding" className={field}>
                  {FINDINGS.map((f) => (
                    <option key={f} value={f}>{f.replaceAll("_", " ")}</option>
                  ))}
                </select>
              </label>
              <textarea
                name="rationale"
                rows={3}
                required
                placeholder="Why this finding…"
                className={field}
              />
              <div>
                <button type="submit" className={button}>Record outcome</button>
              </div>
            </form>
          ) : (
            <p className="mt-3 text-sm text-slate-600">
              No outcome recorded. A case is decided once it reaches pending decision.
            </p>
          )}
        </section>
      ) : null}

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
        <Link className="underline" href="/cases">
          Back to the queue
        </Link>
      </p>
    </main>
  );
}

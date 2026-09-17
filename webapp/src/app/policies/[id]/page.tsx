import Link from "next/link";
import { redirect } from "next/navigation";
import { currentActor } from "@/lib/auth/actor";
import { getPolicy } from "@/server/policies";
import { acknowledgementCoverage, hasAcknowledged } from "@/server/acknowledgements";
import { ForbiddenError, NotFoundError } from "@/lib/errors";
import { Markdown } from "@/components/Markdown";
import { acknowledgeAction } from "./actions";

const day = (value: Date | null) => (value ? value.toISOString().slice(0, 10) : "—");

function Refusal({ message }: { message: string }) {
  return (
    <main className="mx-auto max-w-2xl px-4 py-10">
      <h1 className="text-2xl font-semibold text-slate-900">Policy</h1>
      <p
        role="alert"
        className="mt-4 rounded border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800"
      >
        {message}
      </p>
      <p className="mt-4 text-sm">
        <Link className="underline" href="/policies">
          Back to the library
        </Link>
      </p>
    </main>
  );
}

export default async function PolicyDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string; version?: string }>;
}) {
  const actor = await currentActor();
  if (!actor) redirect("/login");

  const { id } = await params;
  const { error, version: requested } = await searchParams;

  let policy;
  let versions;
  try {
    ({ policy, versions } = await getPolicy(actor, id));
  } catch (thrown) {
    // Only a refusal or a missing record reads as one; anything else is a bug.
    if (thrown instanceof ForbiddenError) {
      return <Refusal message="You are not permitted to view this policy." />;
    }
    if (thrown instanceof NotFoundError) {
      return <Refusal message="That policy does not exist." />;
    }
    throw thrown;
  }

  const live = versions.find((v) => v.versionNo === policy.liveVersionNo) ?? null;
  const shown =
    versions.find((v) => String(v.versionNo) === requested) ?? live ?? versions[0] ?? null;

  const canSeeCoverage = actor.roles.some((r) => r === "admin" || r === "dpo");
  const coverage = canSeeCoverage ? await acknowledgementCoverage(actor, id) : null;

  // Acknowledgement binds to the version in force, never to the policy: that is
  // what makes coverage reset when the text is rewritten.
  const acknowledged = live ? await hasAcknowledged(actor, live.id) : false;

  return (
    <main className="mx-auto flex min-h-screen max-w-4xl flex-col gap-8 px-4 py-10">
      <header>
        <p className="text-sm">
          <Link className="text-slate-600 underline" href="/policies">
            Policy library
          </Link>
        </p>
        <h1 className="mt-2 text-2xl font-semibold text-slate-900">
          <span className="font-mono text-slate-500">{policy.code}</span> {policy.title}
        </h1>
        <p className="mt-1 text-sm text-slate-600">
          Owned by {policy.ownerDepartment ?? "no department"} ·{" "}
          {policy.liveVersionNo === null
            ? "nothing in force today"
            : `version ${policy.liveVersionNo} in force today`}
        </p>
      </header>

      {error ? (
        <p
          role="alert"
          className="rounded border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800"
        >
          {error}
        </p>
      ) : null}

      {coverage ? (
        <section className="rounded border border-slate-300 p-3">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
            Acknowledgement coverage
          </h2>
          {coverage.liveVersionId === null ? (
            <p className="mt-2 text-sm text-slate-600">
              Nothing is in force, so there is nothing to acknowledge.
            </p>
          ) : (
            <p className="mt-2 text-sm text-slate-800">
              <strong>{coverage.done}</strong> of <strong>{coverage.required}</strong> accounts
              have acknowledged version {coverage.liveVersionNo}
              {coverage.required > 0
                ? ` (${Math.round((coverage.done / coverage.required) * 100)}%)`
                : ""}
              .
              <span className="mt-1 block text-xs text-slate-500">
                Coverage is counted against the version in force. Superseding a policy resets it,
                because nobody has yet read the new text.
              </span>
            </p>
          )}
        </section>
      ) : null}

      {live ? (
        <section className="rounded border border-slate-300 p-3">
          {acknowledged ? (
            <p className="text-sm text-slate-700">
              You acknowledged version {live.versionNo} of this policy.
            </p>
          ) : (
            <form action={acknowledgeAction} className="flex flex-wrap items-center gap-3">
              <input type="hidden" name="policyId" value={policy.id} />
              <input type="hidden" name="versionId" value={live.id} />
              <span className="text-sm text-slate-700">
                You have not acknowledged version {live.versionNo}.
              </span>
              <button
                type="submit"
                className="rounded bg-slate-900 px-3 py-1 text-sm font-medium text-white hover:bg-slate-800"
              >
                I have read this policy
              </button>
            </form>
          )}
        </section>
      ) : null}

      <section>
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
          Version history ({versions.length})
        </h2>
        <table className="mt-3 w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-slate-300 text-left text-slate-600">
              <th className="py-2 pr-3 font-medium">Version</th>
              <th className="py-2 pr-3 font-medium">In force from</th>
              <th className="py-2 pr-3 font-medium">Until</th>
              <th className="py-2 pr-3 font-medium">Published</th>
            </tr>
          </thead>
          <tbody>
            {versions.map((v) => (
              <tr key={v.id} className="border-b border-slate-200">
                <td className="py-2 pr-3">
                  <Link
                    className="underline"
                    href={`/policies/${policy.id}?version=${v.versionNo}`}
                  >
                    {v.versionNo}
                  </Link>
                  {v.versionNo === policy.liveVersionNo ? (
                    <span className="ml-2 rounded border border-green-300 bg-green-100 px-2 py-0.5 text-xs font-semibold text-green-900">
                      In force
                    </span>
                  ) : null}
                </td>
                <td className="py-2 pr-3">{day(v.effectiveFrom)}</td>
                <td className="py-2 pr-3">{day(v.effectiveTo)}</td>
                <td className="py-2 pr-3 text-slate-600">
                  {v.publishedAt ? day(v.publishedAt) : "draft"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {shown ? (
        <section>
          <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
            Version {shown.versionNo}
            {shown.publishedAt === null ? " (draft)" : ""} · in force from{" "}
            {day(shown.effectiveFrom)}
            {shown.effectiveTo ? ` until ${day(shown.effectiveTo)}` : ""}
          </h2>
          {shown.summary ? (
            <p className="mt-2 text-sm italic text-slate-600">{shown.summary}</p>
          ) : null}
          <article className="mt-2 rounded border border-slate-200 p-4">
            <Markdown source={shown.bodyMarkdown} />
          </article>
        </section>
      ) : (
        <p className="text-sm text-slate-600">This policy has no versions yet.</p>
      )}
    </main>
  );
}

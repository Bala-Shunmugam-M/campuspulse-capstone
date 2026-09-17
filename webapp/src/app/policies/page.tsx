import Link from "next/link";
import { redirect } from "next/navigation";
import { currentActor } from "@/lib/auth/actor";
import { listPolicies, searchPolicies } from "@/server/policies";
import { ForbiddenError } from "@/lib/errors";
import { Snippet } from "@/components/Markdown";

export default async function PoliciesPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const actor = await currentActor();
  if (!actor) redirect("/login");

  const { q } = await searchParams;
  const query = (q ?? "").trim();

  let policies;
  let hits;
  try {
    [policies, hits] = await Promise.all([
      listPolicies(actor),
      query ? searchPolicies(actor, query) : Promise.resolve([]),
    ]);
  } catch (thrown) {
    // Only a refusal reads as a refusal. Anything else rethrows: swallowing it
    // here would report every bug as a permissions problem.
    if (!(thrown instanceof ForbiddenError)) throw thrown;
    return (
      <main className="mx-auto max-w-2xl px-4 py-10">
        <h1 className="text-2xl font-semibold text-slate-900">Policy library</h1>
        <p
          role="alert"
          className="mt-4 rounded border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800"
        >
          You are not permitted to view the policy library.
        </p>
      </main>
    );
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-4xl flex-col gap-8 px-4 py-10">
      <header className="flex items-baseline justify-between">
        <h1 className="text-2xl font-semibold text-slate-900">Policy library</h1>
        <Link className="text-sm text-slate-600 underline" href="/cases">
          Case queue
        </Link>
      </header>

      <form method="GET" className="flex items-end gap-2">
        <label className="flex flex-1 flex-col gap-1">
          <span className="text-xs font-medium text-slate-600">
            Search the policies in force today
          </span>
          <input
            name="q"
            defaultValue={query}
            placeholder="quiet hours, plagiarism, retention…"
            className="rounded border border-slate-300 px-2 py-1 text-sm"
          />
        </label>
        <button
          type="submit"
          className="rounded border border-slate-300 px-3 py-1 text-sm hover:bg-slate-50"
        >
          Search
        </button>
      </form>

      {query ? (
        <section>
          <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
            Results for “{query}” ({hits.length})
          </h2>
          {hits.length === 0 ? (
            <p className="mt-3 text-sm text-slate-600">
              Nothing in force today matches that. Superseded text is not searched.
            </p>
          ) : (
            <ul className="mt-3 flex flex-col gap-3">
              {hits.map((hit) => (
                <li key={hit.versionId} className="rounded border border-slate-300 p-3">
                  <div className="flex flex-wrap items-baseline gap-x-3 text-sm">
                    <span className="font-mono text-slate-600">{hit.code}</span>
                    <Link className="font-medium underline" href={`/policies/${hit.policyId}`}>
                      {hit.title}
                    </Link>
                    <span className="text-xs text-slate-500">version {hit.versionNo}</span>
                  </div>
                  <p className="mt-2 text-sm leading-6 text-slate-700">
                    <Snippet text={hit.snippet} />
                  </p>
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : null}

      <section>
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
          All policies ({policies.length})
        </h2>
        {policies.length === 0 ? (
          <p className="mt-3 text-sm text-slate-600">No policies have been published yet.</p>
        ) : (
          <table className="mt-3 w-full border-collapse text-sm">
            <thead>
              <tr className="border-b border-slate-300 text-left text-slate-600">
                <th className="py-2 pr-3 font-medium">Code</th>
                <th className="py-2 pr-3 font-medium">Title</th>
                <th className="py-2 pr-3 font-medium">Owner</th>
                <th className="py-2 pr-3 font-medium">In force</th>
              </tr>
            </thead>
            <tbody>
              {policies.map((p) => (
                <tr key={p.id} className="border-b border-slate-200">
                  <td className="py-2 pr-3 font-mono">
                    <Link className="underline" href={`/policies/${p.id}`}>
                      {p.code}
                    </Link>
                  </td>
                  <td className="py-2 pr-3">{p.title}</td>
                  <td className="py-2 pr-3 text-slate-600">{p.ownerDepartment ?? "—"}</td>
                  <td className="py-2 pr-3">
                    {p.liveVersionNo === null ? (
                      <span className="text-slate-500">draft only</span>
                    ) : (
                      <span>version {p.liveVersionNo}</span>
                    )}
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

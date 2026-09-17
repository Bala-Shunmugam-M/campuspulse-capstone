import Link from "next/link";
import { redirect } from "next/navigation";
import { currentActor } from "@/lib/auth/actor";
import { listCategories, listDepartments, listLocations, listPeople } from "@/server/directory";
import { ForbiddenError } from "@/lib/errors";

const PAGE_SIZE = 50;

export default async function DirectoryPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; department?: string; cursor?: string }>;
}) {
  const actor = await currentActor();
  if (!actor) redirect("/login");

  const { q, department, cursor } = await searchParams;
  const filter = {
    q: q || undefined,
    department: department || undefined,
    cursor: cursor || undefined,
    limit: PAGE_SIZE,
  };

  let people;
  let departments;
  let locations;
  let categories;
  try {
    [people, departments, locations, categories] = await Promise.all([
      listPeople(actor, filter),
      listDepartments(actor),
      listLocations(actor),
      listCategories(actor),
    ]);
  } catch (thrown) {
    // Only a refusal reads as a refusal. Anything else rethrows: swallowing it
    // here would report every bug as a permissions problem.
    if (!(thrown instanceof ForbiddenError)) throw thrown;
    return (
      <main className="mx-auto max-w-2xl px-4 py-10">
        <h1 className="text-2xl font-semibold text-slate-900">Campus directory</h1>
        <p
          role="alert"
          className="mt-4 rounded border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800"
        >
          You are not permitted to view the campus directory.
        </p>
      </main>
    );
  }

  const nextHref = people.nextCursor
    ? `/directory?${new URLSearchParams({
        ...(filter.q ? { q: filter.q } : {}),
        ...(filter.department ? { department: filter.department } : {}),
        cursor: people.nextCursor,
      }).toString()}`
    : null;

  return (
    <main className="mx-auto flex min-h-screen max-w-5xl flex-col gap-8 px-4 py-10">
      <header className="flex items-baseline justify-between">
        <h1 className="text-2xl font-semibold text-slate-900">Campus directory</h1>
        <Link className="text-sm text-slate-600 underline" href="/cases">
          Case queue
        </Link>
      </header>

      <p className="text-sm text-slate-600">
        People, places and categories as the campus records them. This view is read-only: these
        tables belong to the campus system, and nothing here writes to them.
      </p>

      <section>
        <form method="GET" className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-slate-600">Name or email</span>
            <input
              name="q"
              defaultValue={filter.q ?? ""}
              className="rounded border border-slate-300 px-2 py-1 text-sm"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-slate-600">Department</span>
            <select
              name="department"
              defaultValue={filter.department ?? ""}
              className="rounded border border-slate-300 px-2 py-1 text-sm"
            >
              <option value="">Any</option>
              {departments.map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
            </select>
          </label>
          <button
            type="submit"
            className="rounded border border-slate-300 px-3 py-1 text-sm hover:bg-slate-50"
          >
            Search
          </button>
        </form>

        <h2 className="mt-6 text-sm font-semibold uppercase tracking-wide text-slate-600">
          People ({people.rows.length})
        </h2>
        {people.rows.length === 0 ? (
          <p className="mt-3 text-sm text-slate-600">Nobody matches.</p>
        ) : (
          <table className="mt-3 w-full border-collapse text-sm">
            <thead>
              <tr className="border-b border-slate-300 text-left text-slate-600">
                <th className="py-2 pr-3 font-medium">Name</th>
                <th className="py-2 pr-3 font-medium">Email</th>
                <th className="py-2 pr-3 font-medium">Department</th>
                <th className="py-2 pr-3 font-medium">Status</th>
              </tr>
            </thead>
            <tbody>
              {people.rows.map((p) => (
                <tr key={p.id} className="border-b border-slate-200">
                  <td className="py-2 pr-3">{p.fullName}</td>
                  <td className="py-2 pr-3 font-mono text-xs">{p.email}</td>
                  <td className="py-2 pr-3 text-slate-600">{p.department ?? "—"}</td>
                  <td className="py-2 pr-3">
                    {p.isActive ? (
                      <span className="text-slate-600">active</span>
                    ) : (
                      <span className="rounded border border-slate-300 bg-slate-100 px-2 py-0.5 text-xs text-slate-700">
                        inactive
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {nextHref ? (
          <p className="mt-4 text-sm">
            <Link className="underline" href={nextHref}>
              Next page →
            </Link>
          </p>
        ) : null}
        {cursor ? (
          <p className="mt-2 text-sm">
            <Link className="text-slate-600 underline" href="/directory">
              Back to the first page
            </Link>
          </p>
        ) : null}
      </section>

      <section className="grid gap-8 md:grid-cols-2">
        <div>
          <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-600">
            Locations ({locations.length})
          </h2>
          <ul className="mt-3 flex flex-col gap-1 text-sm">
            {locations.map((l) => (
              <li key={l.id} className="border-b border-slate-200 py-1">
                <span className="font-medium text-slate-900">{l.name}</span>{" "}
                <span className="text-xs text-slate-600">
                  {l.locationType}
                  {l.parentName ? ` · in ${l.parentName}` : ""}
                  {l.code ? ` · ${l.code}` : ""}
                </span>
              </li>
            ))}
          </ul>
        </div>

        <div>
          <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-600">
            Categories ({categories.length})
          </h2>
          <ul className="mt-3 flex flex-col gap-1 text-sm">
            {categories.map((c) => (
              <li key={c.id} className="border-b border-slate-200 py-1">
                <span className="font-medium text-slate-900">{c.name}</span>{" "}
                <span className="text-xs text-slate-600">
                  {c.categoryType.replaceAll("_", " ")}
                  {c.slaHours === null ? "" : ` · ${c.slaHours}h target`}
                </span>
              </li>
            ))}
          </ul>
        </div>
      </section>
    </main>
  );
}

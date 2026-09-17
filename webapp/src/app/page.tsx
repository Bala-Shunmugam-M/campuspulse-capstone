import Link from "next/link";
import { currentActor } from "@/lib/auth/actor";

/**
 * The front door.
 *
 * Reachable signed out, because anonymous reporting is a first-class path
 * rather than a fallback: someone who will not sign in must still be able to
 * report, and to come back later and check what happened using only their
 * reference code.
 */

type Destination = {
  href: string;
  title: string;
  blurb: string;
};

const FOR_STAFF: Destination[] = [
  {
    href: "/dashboard",
    title: "Dashboard",
    blurb: "Your workload, what is overdue, and how long first responses are taking.",
  },
  {
    href: "/cases",
    title: "Case queue",
    blurb: "Open cases, most urgent first. Triage new reports from here.",
  },
  {
    href: "/directory",
    title: "Campus directory",
    blurb: "People, places and categories, as the campus system records them.",
  },
];

const FOR_GOVERNANCE: Destination[] = [
  {
    href: "/audit",
    title: "Audit log",
    blurb: "Every recorded action, in order, with the account that performed it.",
  },
];

const FOR_EVERYONE: Destination[] = [
  {
    href: "/policies",
    title: "Policy library",
    blurb: "The rules in force today, searchable, with the version you acknowledged.",
  },
];

function Card({ href, title, blurb }: Destination) {
  return (
    <Link
      href={href}
      className="rounded border border-slate-300 p-4 transition-colors hover:border-slate-400 hover:bg-slate-50"
    >
      <span className="block font-medium text-slate-900">{title}</span>
      <span className="mt-1 block text-sm leading-6 text-slate-600">{blurb}</span>
    </Link>
  );
}

export default async function Home() {
  const actor = await currentActor();

  const isStaff = actor?.roles.some(
    (r) => r === "officer" || r === "investigator" || r === "admin" || r === "dpo",
  );
  const isGovernance = actor?.roles.some((r) => r === "admin" || r === "dpo");

  const destinations = [
    ...(isStaff ? FOR_STAFF : []),
    ...FOR_EVERYONE,
    ...(isGovernance ? FOR_GOVERNANCE : []),
  ];

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-4xl flex-col gap-10 px-4 py-14">
      <header>
        <h1 className="text-3xl font-semibold tracking-tight text-slate-900">
          Campus Compliance
        </h1>
        <p className="mt-2 max-w-2xl text-base leading-7 text-slate-700">
          Report an incident, follow what happens to it, and read the policies in force at your
          institution.
        </p>
      </header>

      <section className="rounded border border-slate-300 bg-slate-50 p-5">
        <h2 className="text-lg font-semibold text-slate-900">Report an incident</h2>
        <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-700">
          You can report anonymously, without signing in. You will be given a reference code and a
          one-time access secret — keep both, because they are the only way back to an anonymous
          report, and the secret is shown exactly once.
        </p>
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <Link
            href="/report"
            className="rounded bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800"
          >
            Report an incident
          </Link>
          <Link
            href="/report/status"
            className="rounded border border-slate-300 bg-white px-4 py-2 text-sm hover:bg-slate-50"
          >
            Check a report I filed
          </Link>
        </div>
      </section>

      {actor ? (
        <section>
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-600">
              Signed in as {actor.email}
            </h2>
            <span className="text-xs text-slate-600">
              {actor.roles.length > 0 ? actor.roles.join(", ") : "no roles granted"}
            </span>
          </div>
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            {destinations.map((d) => (
              <Card key={d.href} {...d} />
            ))}
          </div>
        </section>
      ) : (
        <section>
          <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-600">
            Staff and students
          </h2>
          <p className="mt-3 max-w-2xl text-sm leading-6 text-slate-700">
            Sign in to file a report under your name, follow a case you are party to, or read and
            acknowledge the policy library.
          </p>
          <Link
            href="/login"
            className="mt-4 inline-block rounded border border-slate-300 px-4 py-2 text-sm hover:bg-slate-50"
          >
            Sign in
          </Link>
        </section>
      )}
    </main>
  );
}

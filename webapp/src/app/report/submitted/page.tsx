import { cookies } from "next/headers";
import { redirect } from "next/navigation";

/**
 * Reads the one-time cookies the submission set. src/middleware.ts expires them
 * on this same response, so a refresh or a shared link cannot show the access
 * secret a second time.
 */
export default async function SubmittedPage() {
  const jar = await cookies();
  const referenceCode = jar.get("cp_ref")?.value;
  const accessSecret = jar.get("cp_secret")?.value;

  if (!referenceCode) redirect("/report");

  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col gap-6 px-4 py-10">
      <header>
        <h1 className="text-2xl font-semibold text-slate-900">Report received</h1>
        <p className="mt-1 text-sm text-slate-600">
          Thank you. A compliance officer will review it.
        </p>
      </header>

      <section className="rounded border border-slate-300 bg-slate-50 p-4">
        <h2 className="font-semibold text-slate-900">Your reference code</h2>
        <p className="mt-1 text-sm text-slate-700">Quote this if you contact the compliance office.</p>
        <code className="mt-3 block rounded bg-white px-3 py-2 font-mono text-lg tracking-wider">
          {referenceCode}
        </code>
      </section>

      {accessSecret ? (
        <section role="alert" className="rounded border border-amber-300 bg-amber-50 p-4">
          <h2 className="font-semibold text-amber-900">Save this access code now</h2>
          <p className="mt-1 text-sm text-amber-900">
            This is the only time it will be shown. Without it, this report cannot be
            looked up again — we store only a one-way hash, so we cannot recover it for
            you. That is what keeps the report anonymous.
          </p>
          <code className="mt-3 block rounded bg-white px-3 py-2 font-mono text-lg tracking-wider">
            {accessSecret}
          </code>
        </section>
      ) : null}

      <p className="text-sm text-slate-600">
        {accessSecret ? (
          <a className="underline" href="/report/status">Check the status of this report</a>
        ) : (
          <a className="underline" href="/cases">Go to your dashboard</a>
        )}
      </p>
    </main>
  );
}

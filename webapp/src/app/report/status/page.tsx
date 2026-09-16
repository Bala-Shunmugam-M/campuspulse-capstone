import { StatusForm } from "./StatusForm";

/**
 * The codes are submitted in a POST body rather than a query string. A query
 * string lands in browser history, referrer headers and access logs, and the
 * access code is the only thing protecting the report.
 */
export default function StatusPage() {
  return (
    <main className="mx-auto flex min-h-screen max-w-xl flex-col gap-6 px-4 py-10">
      <header>
        <h1 className="text-2xl font-semibold text-slate-900">Check a report</h1>
        <p className="mt-1 text-sm text-slate-600">
          Enter the reference code and the access code you were given when you submitted.
        </p>
      </header>

      <StatusForm />
    </main>
  );
}

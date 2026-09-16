"use client";

import { useActionState } from "react";
import { checkStatus, type StatusResult } from "./actions";

const STATUS_LABEL: Record<string, string> = {
  received: "Received — waiting for review",
  triaged: "Triaged — assigned to a compliance officer",
  merged: "Merged into an existing case",
  rejected: "Closed without further action",
};

const initial: StatusResult = { state: "idle" };

export function StatusForm() {
  const [result, formAction, pending] = useActionState(checkStatus, initial);

  return (
    <>
      {result.state === "denied" ? (
        <p role="alert" className="rounded border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800">
          No report was found for that code and access code.
        </p>
      ) : null}

      {result.state === "found" ? (
        <section className="rounded border border-slate-300 bg-slate-50 p-4">
          <h2 className="font-semibold text-slate-900">{result.title}</h2>
          <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
            <dt className="text-slate-600">Reference</dt>
            <dd className="font-mono">{result.referenceCode}</dd>
            <dt className="text-slate-600">Status</dt>
            <dd>{STATUS_LABEL[result.status] ?? result.status}</dd>
            <dt className="text-slate-600">Submitted</dt>
            <dd>{result.submittedAt.slice(0, 10)}</dd>
          </dl>
        </section>
      ) : null}

      <form action={formAction} className="flex flex-col gap-4">
        <label className="flex flex-col gap-1">
          <span className="text-sm font-medium text-slate-700">Reference code</span>
          <input name="referenceCode" required placeholder="CR-XXXX-XXXX"
                 className="rounded border border-slate-300 px-3 py-2 font-mono" />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-sm font-medium text-slate-700">Access code</span>
          <input name="accessSecret" required autoComplete="off"
                 className="rounded border border-slate-300 px-3 py-2 font-mono" />
        </label>
        <button type="submit" disabled={pending}
                className="rounded bg-slate-900 px-4 py-2 font-medium text-white hover:bg-slate-800 disabled:opacity-60">
          {pending ? "Checking…" : "Check status"}
        </button>
      </form>
    </>
  );
}

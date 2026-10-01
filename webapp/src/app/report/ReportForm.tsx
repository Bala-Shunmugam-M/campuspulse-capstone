"use client";

import { useState, useTransition } from "react";
import { draftReportAction } from "./actions";

type Option = { id: string; name: string };
type Fields = {
  title: string;
  description: string;
  severity: string;
  categoryId: string;
  locationId: string;
  occurredAt: string;
};
type FieldName = keyof Fields;

const MIN_TEXT = 40;
const MAX_TEXT = 4000;
const INPUT = "rounded border border-slate-300 px-3 py-2";

function DraftedHint({ show }: { show: boolean }) {
  return show ? <span className="text-xs text-amber-700">Drafted by AI — check before submitting.</span> : null;
}

export function ReportForm({
  institutions,
  categories,
  locations,
  signedIn,
  aiEnabled,
  action,
}: {
  institutions: Option[];
  categories: Option[];
  locations: Option[];
  signedIn: boolean;
  aiEnabled: boolean;
  action: (formData: FormData) => Promise<void>;
}) {
  const [fields, setFields] = useState<Fields>({
    title: "",
    description: "",
    severity: "moderate",
    categoryId: "",
    locationId: "",
    occurredAt: "",
  });
  const [drafted, setDrafted] = useState<Set<FieldName>>(new Set());
  const [text, setText] = useState("");
  const [consent, setConsent] = useState(false);
  const [status, setStatus] = useState("");
  const [pending, startTransition] = useTransition();

  const textLength = text.trim().length;
  const canDraft = consent && textLength >= MIN_TEXT && textLength <= MAX_TEXT && !pending;

  // Editing a field by hand clears its "drafted" hint.
  function edit(name: FieldName, value: string) {
    setFields((f) => ({ ...f, [name]: value }));
    setDrafted((d) => {
      if (!d.has(name)) return d;
      const next = new Set(d);
      next.delete(name);
      return next;
    });
  }

  function draft() {
    setStatus("Drafting your report…");
    startTransition(async () => {
      let result;
      try {
        result = await draftReportAction(text);
      } catch {
        result = { ok: false as const, message: "We couldn't draft it — please fill in the form yourself." };
      }
      if (!result.ok) {
        setStatus(result.message);
        return;
      }
      const d = result.draft;
      // Only overwrite what the AI determined; anything it left null keeps
      // whatever the user already had.
      // The description is the reporter's own account: replace it only if it is
      // empty or still the text a previous draft put there, never words they
      // typed into the form themselves.
      const filled: Partial<Fields> = {};
      if (!fields.description.trim() || drafted.has("description")) filled.description = d.description;
      if (d.title) filled.title = d.title;
      if (d.severity) filled.severity = d.severity;
      if (d.occurredOn) filled.occurredAt = d.occurredOn;
      if (d.categoryId && categories.some((c) => c.id === d.categoryId)) filled.categoryId = d.categoryId;
      if (d.locationId && locations.some((l) => l.id === d.locationId)) filled.locationId = d.locationId;
      setFields((f) => ({ ...f, ...filled }));
      // Fields from an earlier draft that this one left alone still hold AI
      // values, so they keep their hint until the user edits them.
      setDrafted((prev) => new Set([...prev, ...(Object.keys(filled) as FieldName[])]));
      setStatus("Draft ready. Check every field below before submitting.");
    });
  }

  return (
    <>
      {aiEnabled ? (
        <section aria-labelledby="ai-helper-heading"
                 className="flex flex-col gap-3 rounded border border-slate-300 bg-slate-50 p-4">
          <h2 id="ai-helper-heading" className="font-semibold text-slate-900">Describe what happened</h2>
          <label className="flex flex-col gap-1">
            <span className="text-sm font-medium text-slate-700">In your own words</span>
            <textarea value={text} onChange={(e) => setText(e.target.value)} rows={5}
                      maxLength={MAX_TEXT} aria-describedby="ai-helper-count" className={INPUT} />
            <span id="ai-helper-count" className="text-xs text-slate-600">
              {text.length}/{MAX_TEXT} characters{textLength < MIN_TEXT ? ` (at least ${MIN_TEXT})` : ""}
            </span>
          </label>
          <label className="flex items-start gap-2 text-sm text-slate-700">
            <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)}
                   className="mt-1" />
            <span>
              I agree this text will be sent to Anthropic&apos;s Claude AI to draft the form below.
              Nothing is saved until I submit.
            </span>
          </label>
          <button type="button" onClick={draft} disabled={!canDraft}
                  className="self-start rounded bg-slate-900 px-4 py-2 font-medium text-white hover:bg-slate-800 disabled:opacity-60">
            {pending ? "Drafting…" : "Draft my report"}
          </button>
          <p aria-live="polite" className="text-sm text-slate-700">{status}</p>
        </section>
      ) : null}

      <form action={action} className="flex flex-col gap-4">
        {!signedIn ? (
          <label className="flex flex-col gap-1">
            <span className="text-sm font-medium text-slate-700">Institution</span>
            <select name="institutionId" required className={INPUT}>
              <option value="">Choose…</option>
              {institutions.map((i) => (
                <option key={i.id} value={i.id}>
                  {i.name}
                </option>
              ))}
            </select>
          </label>
        ) : null}

        <label className="flex flex-col gap-1">
          <span className="text-sm font-medium text-slate-700">Title</span>
          <input name="title" required minLength={8} maxLength={200} value={fields.title}
                 onChange={(e) => edit("title", e.target.value)} className={INPUT} />
          <DraftedHint show={drafted.has("title")} />
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-sm font-medium text-slate-700">What happened</span>
          <textarea name="description" required minLength={40} maxLength={10000} rows={8}
                    value={fields.description} onChange={(e) => edit("description", e.target.value)}
                    className={INPUT} />
          <DraftedHint show={drafted.has("description")} />
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-sm font-medium text-slate-700">How serious is it?</span>
          <select name="severity" value={fields.severity} onChange={(e) => edit("severity", e.target.value)}
                  className={INPUT}>
            <option value="low">Low</option>
            <option value="moderate">Moderate</option>
            <option value="high">High</option>
            <option value="severe">Severe</option>
          </select>
          <DraftedHint show={drafted.has("severity")} />
        </label>

        {signedIn && categories.length > 0 ? (
          <label className="flex flex-col gap-1">
            <span className="text-sm font-medium text-slate-700">Category (optional)</span>
            <select name="categoryId" value={fields.categoryId}
                    onChange={(e) => edit("categoryId", e.target.value)} className={INPUT}>
              <option value="">Not sure</option>
              {categories.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
            <DraftedHint show={drafted.has("categoryId")} />
          </label>
        ) : null}

        {signedIn && locations.length > 0 ? (
          <label className="flex flex-col gap-1">
            <span className="text-sm font-medium text-slate-700">Where (optional)</span>
            <select name="locationId" value={fields.locationId}
                    onChange={(e) => edit("locationId", e.target.value)} className={INPUT}>
              <option value="">Not sure</option>
              {locations.map((l) => (
                <option key={l.id} value={l.id}>{l.name}</option>
              ))}
            </select>
            <DraftedHint show={drafted.has("locationId")} />
          </label>
        ) : null}

        <label className="flex flex-col gap-1">
          <span className="text-sm font-medium text-slate-700">When did it happen? (optional)</span>
          <input name="occurredAt" type="date" value={fields.occurredAt}
                 onChange={(e) => edit("occurredAt", e.target.value)} className={INPUT} />
          <DraftedHint show={drafted.has("occurredAt")} />
        </label>

        <button type="submit"
                className="rounded bg-slate-900 px-4 py-2 font-medium text-white hover:bg-slate-800">
          Submit report
        </button>
      </form>
    </>
  );
}

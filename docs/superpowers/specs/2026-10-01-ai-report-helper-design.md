# AI report-filing helper — design

Date: 2026-10-01 · Status: approved by the project owner

## Goal

Regular users find `/report` hard to fill in. Let them describe what happened in
their own words and have Claude draft the structured fields, which they review
and submit as usual. In the same pass, rate-limit anonymous submission, which
`webapp/README.md` already claims and the code does not do.

## Decisions (made with the owner)

| Question | Decision |
|---|---|
| Interaction | One free-text box; one AI call drafts the existing form; the user reviews, edits, submits |
| Who may use it | Everyone, anonymous included, **opt-in each time** via a consent tickbox |
| What is sent | Only the typed text, plus category/location **names** for signed-in users. Never IP, account, email, or institution name |
| Description | **Kept verbatim** — the reporter's account is evidence and is never rewritten by the AI |
| Storage | The draft is not persisted and the text is not logged; only what the user submits is stored |

## User experience (`/report`)

1. Above the form: heading "Describe what happened", a textarea (20–4000
   characters), a tickbox *"I agree this text will be sent to Anthropic's Claude
   AI to draft the form below. Nothing is saved until I submit."*, and a
   **Draft my report** button (disabled until the box is ticked and the text
   is long enough).
2. On success the form fields fill in. Filled fields show "Drafted by AI —
   check before submitting." The description field receives the typed text
   unchanged. Fields the AI could not determine stay empty.
3. On any failure (no key, rate limit, timeout, refusal, invalid output) a
   message says *"We couldn't draft it — please fill in the form yourself."* The
   form is never blocked.
4. When `ANTHROPIC_API_KEY` is not set the panel is not rendered at all.
5. Accessible: labelled controls, `aria-live="polite"` status message, works
   with keyboard only. Without JavaScript the panel is inert and the plain form
   still submits.

Fields the AI fills:

| Field | Anonymous user | Signed-in user |
|---|---|---|
| Title (8–200 chars) | ✓ | ✓ |
| Severity (`low` / `moderate` / `high` / `severe`) | ✓ | ✓ |
| Date it happened (not in the future) | ✓ | ✓ |
| Category (from the institution's list) | — form has no field today | ✓ |
| Location (from the institution's list) | — form has no field today | ✓ |
| Description | the typed text, verbatim | the typed text, verbatim |

## Architecture

| Unit | Responsibility | Depends on |
|---|---|---|
| `src/lib/ai/client.ts` | `getAiClient(): Anthropic \| null` (null when no key) and `aiModel()` (`AI_MODEL` env, default `claude-opus-5-5`) | `@anthropic-ai/sdk` |
| `src/server/reportDraft.ts` | `draftReport(input, meta, deps?)` → `ReportDraft` or throws a `DomainError` | rate limiter, Prisma (read category/location names), AI client |
| `src/app/report/actions.ts` | Server action `draftReportAction(text)`: builds request meta and the caller's institution from the session, calls `draftReport`, returns `{ ok: true, draft } \| { ok: false, message }` | `draftReport`, auth |
| `src/app/report/ReportForm.tsx` | Client component: the existing form fields as controlled state + the AI panel | the server action |
| `src/app/report/page.tsx` | Unchanged responsibilities; renders `ReportForm` with institutions, categories, locations and `aiEnabled` | — |

### `draftReport`

```ts
type DraftInput = { text: string; institutionId: string | null };
type ReportDraft = {
  title: string | null;
  severity: "low" | "moderate" | "high" | "severe" | null;
  occurredOn: string | null;      // YYYY-MM-DD, never in the future
  categoryId: string | null;      // only when institutionId given and matched
  locationId: string | null;
  description: string;            // === input.text.trim()
};
draftReport(input, meta, deps = { client: getAiClient(), model: aiModel() })
```

Steps:

1. `assertRateLimit(\`ai-draft:${meta.ipHash ?? "unknown"}\`, 5, 15 * 60_000)`.
   This also satisfies the service-layer authorisation test.
2. Validate `text` with Zod (trimmed, 20–4000 chars).
3. If `deps.client` is null throw `AiUnavailableError`.
4. If `institutionId` is given, load `issue_category` names and location names
   for that institution (same queries as `page.tsx`'s `optionsFor`).
5. One `messages.create` call: `model` from deps, `max_tokens` 1024,
   `output_config: { effort: "low", format: <JSON schema> }`, server-side
   refusal fallback (`fallbacks: "default"` with beta
   `server-side-fallback-2026-07-01`), request timeout 20 s, `max_retries` 1.
   The schema constrains `severity` to the enum and `category` / `location` to
   the supplied names (or null). The reporter's text is placed inside
   `<report_text>` tags and the system prompt states it is untrusted data to be
   classified, never instructions; the model must leave a field null rather
   than guess.
6. Check `stop_reason`: anything other than `end_turn` (including `refusal`,
   `max_tokens`) → `AiUnavailableError`.
7. Parse and validate the JSON with Zod. Map names to ids by exact match;
   unknown names become null. Drop `occurredOn` if it is invalid or after
   `meta.at`. Clamp title to 200 chars; null if under 8.
8. Return the draft. Nothing is written except the rate-limit bucket; the text
   is not logged or audited.

New error: `AiUnavailableError extends DomainError` in `src/lib/errors.ts`.

### Rate limit on anonymous submission

`submitAnonymousReport` gains, first thing:
`assertRateLimit(\`submit:${meta.ipHash ?? "unknown"}\`, 10, 60 * 60_000)`.
A `RateLimitedError` must surface on `/report` as "Too many reports from this
connection. Try again later." rather than a 500.

## Configuration

`.env.example` gains:

```
# Optional. Enables the AI report-drafting helper on /report.
ANTHROPIC_API_KEY=""
# Optional. Defaults to claude-opus-5-5.
AI_MODEL=""
```

The owner adds their own key; it is never committed.

## Testing

All tests run without network or a key — the client is injected through `deps`.

- `tests/report-draft.test.ts`
  - fills title/severity/date from a valid model response
  - maps category/location names to ids; an invented name becomes null
  - drops a future date; drops an unparseable date
  - description equals the input text, trimmed, regardless of model output
  - `stop_reason: "refusal"` → `AiUnavailableError`
  - invalid JSON / schema mismatch → `AiUnavailableError`
  - client null → `AiUnavailableError`
  - sixth call within the window → `RateLimitedError`
  - the reporter's text appears in the request only inside `<report_text>`
- `tests/reports.test.ts` (existing file): the eleventh anonymous submission from
  one `ipHash` within an hour → `RateLimitedError`
- Existing `tests/service-authorisation.test.ts` passes unchanged.
- One manual live check with a real key after merge (≈ cents).

## Out of scope

Guided chat; an officer-side assistant; recording that a report was
AI-assisted; category/location fields for anonymous reporters; streaming.

## Documentation

`WEBAPP.md` §3 Reporting gains a paragraph on the helper and what it sends;
`webapp/README.md` §4 notes `draftReport` beside the rate-limited services and
corrects the anonymous-submission claim; `docs/APP_GUIDE.md` §7 finding 2 is
marked fixed.

## Changes made after code and security review (2026-10-01)

- **Rate-limit key.** `newRequestMeta` always set `ipHash: null`, so `meta.ipHash`
  would have made every limit one site-wide bucket. Limits now key on
  `meta.clientKey` = HMAC-SHA256(`IP_HASH_PEPPER`, UTC day + rightmost
  X-Forwarded-For hop), from `clientKeyFrom` in `src/lib/rateLimit.ts`. `ipHash`
  stays null: persisting an IP hash beside anonymous reports is left to the DPO.
- **Forgery.** The rightmost hop is the one a proxy appends; a client reaching
  Next directly can still choose its key, so drafting also has a site-wide cap
  of 300 per hour (`ai-draft:global`). Deploy behind a proxy that sets the header.
- **Retention.** Buckets are swept opportunistically (about 1 in 50 limiter
  calls) after an hour, and the day in the HMAC stops linking across days.
- **Submission limit** raised from 10 to 30 per hour: campus NAT puts many
  reporters behind one address.
- **Minimum helper text** raised from 20 to 40 characters, matching the
  description's own minimum so every draft can be submitted.
- **Closing-tag stripping** repeats until stable (a single pass could be
  reassembled). Model-call failures log error type and status only.
- **Form.** A second draft no longer drops the hint from fields an earlier draft
  filled, and the helper never overwrites a description the user typed.

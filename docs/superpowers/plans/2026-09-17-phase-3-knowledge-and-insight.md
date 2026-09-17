# Campus Compliance Platform — Phase 3 (Knowledge & Insight) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish the capstone as a data-generating system rather than a seeded demo — a versioned policy library people acknowledge, dashboards that tell officers and administrators something true, a campus directory, and a simulator that produces a realistic dataset by driving the real application.

**Architecture:** Unchanged. Route handlers and server actions delegate to `src/server/`; only that layer touches Prisma. Every mutation writes an audit row in the same transaction. The `campuspulse` schema stays read-only.

**Spec:** `docs/superpowers/specs/2026-09-16-campus-compliance-platform-design.md` (commit `71adc60`) — §4.5 policy library, §8.1–8.4 data generation and verification, and the dashboards and directory named in §2.

**Builds on:** Phase 1 (`ccdd67c`) and Phase 2 (`c76adc5`). 147 tests, 17 verification checks, 14 migrations.

---

## What Phase 2 left behind

Two items are recorded as known limitations in `webapp/README.md` §8 and are paid here, both because Phase 3 makes them worse.

| Debt | Why now |
|---|---|
| `listCases` caps at 200 with no pagination | The simulator will generate thousands of cases. A queue that silently truncates stops being a queue. |
| Audit labels carry an account id, not an email | The dashboards and the activity feed put actor names in front of people. A wall of UUIDs is not a feed anyone reads. |

Not paid here, and still true at the end of Phase 3: no malware scanner, and notifications are in-app only.

## Global Constraints

Everything in Phase 1 and Phase 2's Global Constraints still applies. In particular:

- **Prisma Migrate drops any SQL it cannot see in `schema.prisma`.** It proposed dropping `user_accounts_tenant_fk` on **every** Phase 2 migration. Generate with `npx prisma migrate dev --create-only`, **read the SQL**, delete anything that removes a hand-written object, apply with `npx prisma migrate deploy`. Never run bare `migrate dev` — it hangs on shadow-database cleanup holding an advisory lock.
- **Every hand-written constraint, function, view or partial index gets an assertion** in `webapp/tests/db-invariants.test.ts`, in the task that creates it. It currently guards 12.
- **Restart the dev server after `prisma generate`.**
- **Catch the specific domain error in pages and rethrow the rest.**
- Raw SQL through Prisma sends JS numbers as `bigint`; cast integers explicitly (`${n}::int`).
- Postgres on **5433** (not a Windows service — start it manually), dev server on **3100**.
- Commit messages carry **no `Co-Authored-By` trailer**.

---

## File Structure

| File | Responsibility |
|---|---|
| `webapp/src/lib/clock.ts` | The single source of "now"; the seam simulated time needs |
| `webapp/src/lib/pagination.ts` | Cursor helpers shared by the queue and the directory |
| `webapp/src/server/policies.ts` | Authoring, publication, supersession, search |
| `webapp/src/server/acknowledgements.ts` | Who has acknowledged which version |
| `webapp/src/server/directory.ts` | Read-only campus directory over `campuspulse` |
| `webapp/src/server/dashboards.ts` | Officer and admin aggregates |
| `webapp/src/app/policies/` | Library, one policy, version history, acknowledge |
| `webapp/src/app/directory/` | Campus directory |
| `webapp/src/app/dashboard/` | Officer and admin dashboards |
| `webapp/scripts/simulate.ts` | The simulator entry point |
| `webapp/scripts/sim/` | HTTP client, agents, distributions, text generation |
| `webapp/scripts/verify.ts` | **Extended**: Phase 3 invariants |

---

## Task 1: The policy library schema and its immutability trigger

**Files:** schema, migration; `webapp/tests/db-invariants.test.ts`

**Schema** (spec §4.5):
- `policies` — `id`, `institution_id`, `code`, `title`, `owner_department`, `is_active`, timestamps. `UNIQUE (institution_id, code)`.
- `policy_versions` — `id`, `policy_id`, `version_no int`, `body_markdown text`, `summary text`, `effective_from date`, `effective_to date NULL`, `published_by NULL`, `published_at NULL`, `body_tsv tsvector GENERATED STORED`. `UNIQUE (policy_id, version_no)`.
- `policy_acknowledgements` — `policy_version_id`, `user_account_id`, `acknowledged_at`. `UNIQUE (policy_version_id, user_account_id)`.

- [ ] **Step 1:** Add the models. Declare `body_tsv` as `Unsupported("tsvector")?` and its GIN index in `schema.prisma`, the way `reports.search_tsv` already is — undeclared, Prisma generates a migration that drops both.
- [ ] **Step 2:** Hand-write the generated column and GIN index, then the immutability trigger. **A published version is immutable except for `effective_to`:**

```sql
CREATE OR REPLACE FUNCTION compliance.policy_versions_immutable()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.published_at IS NULL THEN RETURN NEW; END IF;   -- drafts are editable
  IF NEW.body_markdown  IS DISTINCT FROM OLD.body_markdown
     OR NEW.summary        IS DISTINCT FROM OLD.summary
     OR NEW.version_no     IS DISTINCT FROM OLD.version_no
     OR NEW.effective_from IS DISTINCT FROM OLD.effective_from
     OR NEW.published_at   IS DISTINCT FROM OLD.published_at
     OR NEW.published_by   IS DISTINCT FROM OLD.published_by THEN
    RAISE EXCEPTION 'a published policy version is immutable except for effective_to'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
```

"The policy said something different when I signed it" is precisely the claim this table exists to refute, so the refusal lives in the database rather than in a service that could be bypassed.

- [ ] **Step 3:** Assert the trigger, the generated column and the GIN index in `db-invariants.test.ts`.
- [ ] **Step 4:** Test — a draft is editable; a published version refuses a body change written through Prisma directly; `effective_to` alone is accepted.
- [ ] **Step 5:** Commit — "Add the policy library with published versions the database refuses to alter".

---

## Task 2: Authoring, publication and supersession

**Files:** `webapp/src/server/policies.ts`; `webapp/tests/policies.test.ts`

**Interfaces:**
- `createPolicy(actor, input, meta): Promise<string>`
- `draftVersion(actor, policyId, input, meta): Promise<string>` — allocates `version_no` as `max + 1`
- `publishVersion(actor, versionId, effectiveFrom, meta): Promise<void>`
- `supersede(actor, policyId, input, meta): Promise<string>` — drafts *n+1* and closes *n*'s `effective_to`

- [ ] **Step 1:** Authoring is `admin` and `dpo` only. Every function authorises; the service-layer test enforces it.
- [ ] **Step 2:** Allocate `version_no` with the same lesson as case numbers: a `max + 1` read races. Do it in one statement inside the transaction, and **test it under concurrency** the way `tests/case-numbers.test.ts` does.
- [ ] **Step 3:** Publishing stamps `published_at` and `published_by` and is irreversible; superseding sets the previous version's `effective_to` to the new one's `effective_from` in the same transaction.
- [ ] **Step 4:** Tests — publish then attempt an edit (refused by the trigger); supersede leaves exactly one version live on any given date; concurrent drafting produces distinct version numbers; a reporter is refused throughout.
- [ ] **Step 5:** Commit — "Add policy authoring, publication and supersession".

---

## Task 3: Policy search and acknowledgements

**Files:** `webapp/src/server/policies.ts`, `webapp/src/server/acknowledgements.ts`; `webapp/src/app/policies/`; tests

**Interfaces:**
- `searchPolicies(actor, query, limit): Promise<PolicySearchHit[]>` — ranked with `ts_rank`
- `acknowledge(actor, versionId, meta): Promise<void>`
- `acknowledgementCoverage(actor, policyId): Promise<{ required: number; done: number }>`

- [ ] **Step 1:** Search the live version of each policy in the actor's institution only, ordered by `ts_rank`, with `ts_headline` for the snippet. Tenant scoping belongs in the query.
- [ ] **Step 2:** `acknowledge` is idempotent — acknowledging twice is not an error and does not double-count, because a user who double-clicks has not done anything wrong. `UNIQUE (policy_version_id, user_account_id)` backs it.
- [ ] **Step 3:** **An acknowledgement names a version, never a policy.** Coverage is therefore per version and resets when a policy is superseded, which is the only honest reading of "has everyone read the current rules".
- [ ] **Step 4:** Pages — library list, one policy with its version history and rendered Markdown, an acknowledge button, and a coverage figure for `admin`/`dpo`. Render Markdown without raw HTML; policy bodies are authored text, not trusted markup.
- [ ] **Step 5:** Tests — search finds a published body and not a draft; search is tenant-scoped; double acknowledgement counts once; superseding drops coverage back.
- [ ] **Step 6:** Commit — "Add policy search and per-version acknowledgements".

---

## Task 4: Pagination for the queue and the directory

Pays off a Phase 2 limitation before the simulator makes it obvious.

**Files:** `webapp/src/lib/pagination.ts`, `webapp/src/server/cases.ts`; `webapp/src/app/cases/page.tsx`; tests

- [ ] **Step 1:** Keyset pagination, not `OFFSET`. The queue orders by `sla_due_at`, and offset paging over a list that reorders as SLAs pass silently skips and repeats rows.
- [ ] **Step 2:** `listCases` gains `{ cursor?: string; limit?: number }` and returns `{ rows, nextCursor }`. The cursor encodes `(sla_due_at, id)` — the id breaks ties, without which two cases sharing a due date can bracket a page boundary and one is lost.
- [ ] **Step 3:** Existing callers keep working: `limit` defaults to the current 200 and `nextCursor` is ignored by callers that do not paginate.
- [ ] **Step 4:** Tests — walking every page yields every case exactly once, with no duplicates and no gaps, over a set large enough to span several pages; ties on `sla_due_at` are ordered stably.
- [ ] **Step 5:** Commit — "Page the case queue by keyset so it stops truncating at 200".

---

## Task 5: Readable audit labels

**Files:** `webapp/src/lib/audit/withAudit.ts` callers; migration (backfill); tests

Phase 2 wrote `actorLabel: actor.accountId`, so the audit viewer and activity feed show a UUID where an anonymous action shows `anonymous`.

- [ ] **Step 1:** Change every call site to pass the actor's email. `Actor` does not carry one, so add `email` to `Actor`, populated in `currentActor` and `authenticate`. One lookup at session load beats one per audit row.
- [ ] **Step 2:** Backfill existing rows in a migration:
  `UPDATE compliance.audit_events SET actor_label = ua.email FROM compliance.user_accounts ua WHERE ua.id = audit_events.actor_user_account_id AND actor_label = actor_user_account_id::text`.
  **`audit_events` has a trigger that refuses UPDATE**, so the migration must drop it, backfill, and recreate it, in one transaction, with a comment saying why. This is the only legitimate reason to do that, and the commit message must argue that correcting a display field is not rewriting history rather than assume it.
- [ ] **Step 3:** Assert the trigger still exists afterwards; the invariants test already covers it.
- [ ] **Step 4:** Commit — "Record audit actors by email so the log reads like a log".

---

## Task 6: The campus directory

**Files:** `webapp/src/server/directory.ts`; `webapp/src/app/directory/`; tests

Read-only over `campuspulse.users`, `locations` and `categories` — the tables the compliance schema references but never writes.

- [ ] **Step 1:** `listPeople(actor, { q, department, cursor })`, `listLocations(actor)`, `listCategories(actor)`. All tenant-scoped, all paginated via Task 4's helper.
- [ ] **Step 2:** `locations` and `categories` are `@@ignore`d in Prisma Client, so these read through `$queryRaw`. That is the boundary working as designed, not a workaround — say so in a comment, because the next person will otherwise "fix" it by un-ignoring the models and reopening the drop hazard.
- [ ] **Step 3:** Directory access is staff-only. A reporter does not get a searchable list of everyone on campus.
- [ ] **Step 4:** Tests — tenant scoping; a reporter is refused; search matches name and email; pagination is stable.
- [ ] **Step 5:** Commit — "Add the campus directory as a read-only view of campuspulse".

---

## Task 7: The officer dashboard

**Files:** `webapp/src/server/dashboards.ts`; `webapp/src/app/dashboard/`; tests

**Interface:** `officerDashboard(actor): Promise<{ mine, overdue, dueSoon, unassigned, byStatus, medianFirstResponseHours }>`

- [ ] **Step 1:** Aggregate in SQL, not in TypeScript. Fetching every case to count them in a loop is the version that works on seed data and dies on simulator data.
- [ ] **Step 2:** "Overdue" is `sla_due_at < now() AND status NOT IN ('resolved','closed')` — the same predicate the queue uses. Define it once and share it, because two definitions of overdue will diverge and the dashboard will disagree with the list it links to.
- [ ] **Step 3:** Median first response from `first_response_at - opened_at`, using `percentile_cont`. Median rather than mean: one case left open over a holiday should not move the headline number.
- [ ] **Step 4:** Tests — counts match direct queries against a known fixture; the overdue predicate agrees with `listCases`; an officer sees only their own institution.
- [ ] **Step 5:** Commit — "Add the officer dashboard, aggregated in the database".

---

## Task 8: The admin dashboard

**Files:** `webapp/src/server/dashboards.ts`; `webapp/src/app/dashboard/`; tests

**Interface:** `adminDashboard(actor): Promise<{ intakeByWeek, slaBreachRate, officerWorkload, outcomeMix, policyCoverage, anonymousShare }>`

- [ ] **Step 1:** `admin` and `dpo` only.
- [ ] **Step 2:** SLA breach rate is computed over **closed** cases from stored `sla_due_at` versus `resolved_at`, never recomputed from current severity policy. Phase 1 stored `sla_due_at` precisely so changing the policy later cannot rewrite whether past cases breached; a dashboard that recomputes it throws that away.
- [ ] **Step 3:** Anonymous share and outcome mix as percentages with the denominator shown. A bare "68%" invites the wrong conclusion when n is 12.
- [ ] **Step 4:** Charts are server-rendered SVG or a small client component; no charting dependency unless one earns its place.
- [ ] **Step 5:** Tests — the breach rate uses stored values, proven by altering `SLA_HOURS` and asserting the figure does not move; percentages carry their denominators.
- [ ] **Step 6:** Commit — "Add the admin dashboard without recomputing history".

---

## Task 9: Simulated time

The simulator needs a dataset spread over months. Driving live HTTP endpoints stamps everything `now()`, which produces a dataset with no SLA breaches, no ageing queue and no history — the dashboards would be uniformly, falsely green. This task creates the seam that fixes it, before the simulator needs it.

**Files:** `webapp/src/lib/clock.ts`; every service that stamps a time; `webapp/tests/clock.test.ts`

- [ ] **Step 1:** `now(): Date` in `src/lib/clock.ts`. Every service stamp — `openedAt`, `slaDueAt`, `resolvedAt`, `closedAt`, `firstResponseAt`, `revokedAt`, `decidedAt` — goes through it instead of `new Date()`.
- [ ] **Step 2:** **`withAudit` sets `occurredAt` explicitly** from `now()` rather than relying on the column default. Postgres `now()` is transaction time and cannot be overridden, so a DB default would be the one timestamp simulated time could not reach.
- [ ] **Step 3:** In simulation mode only, `now()` reads a per-request offset from an `X-Simulated-Now` header. Gated twice: the env flag `SIMULATION_MODE=1` **and** a hard refusal when `NODE_ENV === "production"`. A clock an HTTP header can move is a serious thing to ship; it must be impossible to enable by accident.
- [ ] **Step 4:** Tests — `now()` is real without the flag; the header is ignored without the flag; the header is ignored in production even with the flag; with both, a case opened through the API carries the simulated time in `opened_at`, `sla_due_at` **and** its audit row.
- [ ] **Step 5:** Commit — "Add a clock seam so simulated activity can be dated". Say plainly in the message why the header exists and what prevents it reaching production.

---

## Task 10: The simulator

**Files:** `webapp/scripts/simulate.ts`, `webapp/scripts/sim/{client,agents,distributions,text}.ts`

**It does not write to the database** (spec §8.1). It authenticates over HTTP as seeded users and drives the endpoints a browser drives, so generated data is by construction data the application could have produced — with the audit rows, history and notifications a real action leaves.

- [ ] **Step 1:** HTTP client. Auth.js credentials sign-in needs a CSRF token: `GET /api/auth/csrf`, then `POST /api/auth/callback/credentials` with the token and a cookie jar. Each agent holds its own jar, which is also the first real test of Phase 2's session work under many concurrent sessions.
- [ ] **Step 2:** `--seed` and `--anchor`, matching `02_Insert_Data.py`. One seeded RNG drives every draw so a run is reproducible; Faker takes the same seed.
- [ ] **Step 3:** Arrival model from spec §8.2 — by hour and weekday, weekday above weekend, clustering at class-change times, reusing the shape the Python generator already validated. Roughly a third of reports anonymous.
- [ ] **Step 4:** Agents. **Reporters** submit, some file a follow-up days later, some never return. **Officers** triage oldest and most severe first, assign, note, and move cases through the machine, with response latency drawn from a distribution rather than acting instantly — uniform latency is what makes SLA analytics meaningless. **Investigators** add notes and upload evidence across a case's life.
- [ ] **Step 5:** **Deliberate mess.** A minority of cases are dismissed at triage, appealed after closure, or reassigned mid-investigation. A dataset where every case flows cleanly to `closed` teaches nothing and makes the dashboards lie.
- [ ] **Step 6:** Free text from templated fragments composed with Faker, varying in length and register — not a handful of repeated strings.
- [ ] **Step 7:** The run **is** the integration test. Any non-2xx that is not an expected refusal fails the run loudly, printing the request that caused it. A run that completes has exercised every workflow end to end.
- [ ] **Step 8:** Finish by running `npm run verify`. A run that leaves the database failing its checks has found a bug and must exit non-zero.
- [ ] **Step 9:** Commit — "Add the simulator, which drives the application rather than the database".

---

## Task 11: Verification and documentation

- [ ] **Step 1:** Extend `webapp/scripts/verify.ts` with the remaining §8.4 invariants and Phase 3's own:
  1. every transition present in `case_status_history` is one `TRANSITIONS` permits — the check §8.4 names and that no phase has written yet;
  2. `resolved_at` precedes `closed_at` wherever both exist;
  3. no published policy version has been modified since publication;
  4. exactly one policy version is live per policy per date;
  5. every acknowledgement points at a published version, never a draft;
  6. no `version_no` repeats within a policy.
- [ ] **Step 2:** Break one deliberately, watch it exit 1, revert. Both previous phases did this, and Phase 2's checks found a real defect on their first run.
- [ ] **Step 3:** Run the simulator at a realistic size and record what it produces — cases, reports, notes, evidence, acknowledgements, audit rows — in the README, alongside the wall-clock time and the seed that reproduces it.
- [ ] **Step 4:** README: the policy library and its immutability rule, the dashboards and what each figure means, the directory, the simulator and its arguments, and the clock seam **with its production refusal stated plainly**. Update the limitations section: pagination and audit labels come off; anything Phase 3 leaves undone goes on.
- [ ] **Step 5:** Full gate — `npm test`, `npm run verify`, `npm run build`, `npx tsc --noEmit`, `npm run lint`.
- [ ] **Step 6:** Commit — "Add phase 3 verification and documentation".

---

## Self-Review

**Spec coverage.** §4.5 policy library → Tasks 1–3. §8.1 seed versus simulate → Task 10. §8.2 behavioural model → Task 10 steps 3–6. §8.3 what it produces → Task 10, recorded in Task 11 step 3. §8.4 verification → Task 11. Dashboards and directory from §2 → Tasks 6–8. Phase 2 debt → Tasks 4–5.

**Decided here rather than discovered later:**

1. **Simulated time needs a seam, and the seam is dangerous.** Driving real endpoints means real timestamps, and a dataset stamped entirely "now" has no overdue cases and no ageing queue — the dashboards would be uniformly green and wrong. Task 9 puts `now()` behind a flag refused outright in production. The alternative, rewriting timestamps afterwards, contradicts §8.1's whole argument for driving endpoints.
2. **`withAudit` must stamp `occurred_at` itself.** Postgres `now()` is transaction time and cannot be moved, so a column default would be the one timestamp the simulator could never reach.
3. **Backfilling audit labels requires dropping the append-only trigger.** Task 5 does it in one transaction and recreates it. This is a correction to a display field, not a rewrite of history, and the commit message must make that argument rather than assume it.
4. **Acknowledgements bind to a version, never a policy.** Coverage resets on supersession. Any other reading lets "everyone has acknowledged the code of conduct" survive a rewrite of the code of conduct.

**Ordering.** Tasks 1–3 are self-contained and may run first or in parallel. Task 4 precedes 6–8 because both the directory and the dashboards page results. Task 5 precedes 7–8 because both display actors. Task 9 must precede Task 10. Task 10 is the largest and depends on almost everything.

**Placeholders.** None. Where a task describes UI or aggregate SQL in prose, it names the function, its signature, its authorisation rule and its edge cases, and a test pins the behaviour first.

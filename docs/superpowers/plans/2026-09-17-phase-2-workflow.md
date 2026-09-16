# Campus Compliance Platform — Phase 2 (Workflow) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the Phase 1 spine into a system an officer can actually work a case in — assignment, guarded status transitions, parties, investigation notes, outcomes and sanctions, evidence, and notifications — and pay off the three debts Phase 1 recorded rather than carrying them into Phase 3.

**Architecture:** Unchanged from Phase 1. Route handlers and server actions validate and delegate to `src/server/`; only that layer touches Prisma. Every mutation writes an audit row in the same transaction. The `campuspulse` schema stays read-only.

**Tech Stack:** As Phase 1, plus `file-type` (content-based MIME sniffing) and a `StorageDriver` abstraction over local disk and Supabase Storage.

**Spec:** `docs/superpowers/specs/2026-09-16-campus-compliance-platform-design.md` (commit `71adc60`) — §4.4 cases and supporting tables, §4.6 evidence, §4.7 notifications, §6 case workflow, §7 storage.

**Builds on:** `docs/superpowers/plans/2026-09-16-phase-1-compliance-spine.md`, delivered at commit `ccdd67c`.

---

## What Phase 1 left behind

Three items are recorded as known limitations in `webapp/README.md` §6. They are Tasks 1, 2 and 10 here, deliberately placed where later work either depends on them or would multiply them.

| Debt | Why it is paid now |
|---|---|
| Case numbers allocated by counting rows | Phase 2 creates cases from several places; a race that was theoretical with one officer becomes ordinary with assignment and merging. |
| JWT sessions with no revocation | Phase 2 adds roles that matter more (who may decide an outcome). A revoked investigator who keeps working for eight hours is a finding. |
| In-memory, per-process rate limiter | Evidence upload adds a second unauthenticated-ish surface worth limiting. Doing it twice wrong is worse than doing it once right. |

## Global Constraints

Everything in Phase 1's Global Constraints still applies. These are the additions, each learned the hard way during Phase 1:

- **Prisma Migrate drops any SQL it cannot see in `schema.prisma`.** Generate with `npx prisma migrate dev --create-only`, **read the generated `migration.sql`**, delete any statement that removes a hand-written object, then apply with `npx prisma migrate deploy`. Never run bare `npx prisma migrate dev` — it hangs on shadow-database cleanup while holding an advisory lock, which blocks the next migration.
- **Every hand-written constraint gets an assertion** in `webapp/tests/db-invariants.test.ts` in the same task that creates it. That file is the reason the dropped tenant key was found; it only works if it keeps growing.
- **Restart the dev server after `prisma generate`.** A running Next.js process holds the old client, and the symptom (`prisma.X is undefined`) looks nothing like the cause.
- **Do not catch broadly in pages.** Catch the specific domain error and rethrow the rest. Phase 1's queue reported a stale Prisma client as a permissions failure.
- Postgres on **5433**, dev server on **3100**.
- Commit messages carry **no `Co-Authored-By` trailer**.

---

## File Structure

New and changed files, beyond Phase 1's.

| File | Responsibility |
|---|---|
| `webapp/src/lib/cases/transitions.ts` | The allowed-transition map and the role each requires |
| `webapp/src/lib/storage/driver.ts` | `StorageDriver` interface |
| `webapp/src/lib/storage/local.ts` | Local-disk driver for development |
| `webapp/src/lib/storage/supabase.ts` | Supabase Storage driver |
| `webapp/src/lib/upload/inspect.ts` | MIME sniffing, extension and type rejection, sha256 |
| `webapp/src/lib/rateLimit.ts` | **Rewritten**: Postgres-backed fixed window |
| `webapp/src/lib/auth/session.ts` | Session issue, load and revoke |
| `webapp/src/server/cases.ts` | **Extended**: assign, transition, close |
| `webapp/src/server/parties.ts` | Case parties |
| `webapp/src/server/notes.ts` | Investigation notes and their visibility |
| `webapp/src/server/outcomes.ts` | Outcomes and sanctions |
| `webapp/src/server/evidence.ts` | Evidence metadata, upload, authorised download |
| `webapp/src/server/notifications.ts` | Notification writes and reads |
| `webapp/src/app/cases/[id]/` | Case detail gains parties, notes, evidence, outcome, transition controls |
| `webapp/src/app/evidence/[id]/route.ts` | Authorised streaming download |
| `webapp/src/app/notifications/page.tsx` | Notification list and badge |
| `webapp/scripts/verify.ts` | **Extended**: Phase 2 invariants |

---

## Task 1: Case numbers from a sequence

Pays off the racy counter. First because every later task that creates a case inherits it.

**Files:** migration; `webapp/src/server/cases.ts`; `webapp/tests/case-numbers.test.ts`

**Interfaces:** `triageReport` keeps its signature. Allocation moves into the database.

- [ ] **Step 1:** Write a migration creating a per-institution, per-year allocator. A single sequence is wrong — numbering restarts each year and is per tenant. Use a counter table with an upsert that returns the new value atomically:

```sql
CREATE TABLE compliance.case_number_counters (
  institution_id uuid NOT NULL,
  year           int  NOT NULL,
  next_value     int  NOT NULL DEFAULT 1,
  PRIMARY KEY (institution_id, year)
);

CREATE FUNCTION compliance.next_case_number(p_institution uuid, p_year int)
RETURNS text LANGUAGE plpgsql AS $$
DECLARE v int;
BEGIN
  INSERT INTO compliance.case_number_counters (institution_id, year, next_value)
  VALUES (p_institution, p_year, 2)
  ON CONFLICT (institution_id, year)
    DO UPDATE SET next_value = compliance.case_number_counters.next_value + 1
  RETURNING next_value - 1 INTO v;
  RETURN 'CASE-' || p_year || '-' || lpad(v::text, 4, '0');
END;
$$;
```

`ON CONFLICT DO UPDATE` takes a row lock, so two concurrent callers serialise rather than colliding.

- [ ] **Step 2:** Seed the counters from existing cases so numbering continues rather than restarting over live rows.
- [ ] **Step 3:** Replace the `tx.case.count()` block in `triageReport` with `SELECT compliance.next_case_number($1, $2)` inside the existing transaction.
- [ ] **Step 4:** Test — fire 20 concurrent `triageReport` calls with `Promise.all` and assert 20 distinct case numbers and no unique-violation error. This test fails against the Phase 1 implementation; run it against the old code once to see it fail.
- [ ] **Step 5:** Add the function and counter table to `db-invariants.test.ts`.
- [ ] **Step 6:** Commit — "Allocate case numbers from the database, not from a count".

---

## Task 2: Revocable sessions

**Files:** migration; `webapp/src/lib/auth/session.ts`; `webapp/src/lib/auth/config.ts`; `webapp/src/lib/auth/actor.ts`; `webapp/tests/session-revocation.test.ts`

**The constraint that shapes this task:** Auth.js v5 **cannot** use `session: { strategy: "database" }` with the Credentials provider — that combination is unsupported, which is why Phase 1 shipped JWT. So do not attempt the stock database strategy.

Instead: keep the JWT as *transport* and move the *authority* into a row. The token carries a `sid` claim; the session callback loads `compliance.sessions` by that id on each request and refuses a revoked or expired row. This delivers the property the spec asks for — immediate revocation — and works with credentials.

- [ ] **Step 1:** Migration for `compliance.sessions`: `id uuid PK`, `user_account_id uuid NOT NULL → user_accounts`, `created_at`, `last_seen_at`, `expires_at`, `revoked_at NULL`, `ip_hash`, `user_agent`. Partial index `(user_account_id) WHERE revoked_at IS NULL`.
- [ ] **Step 2:** `issueSession(accountId, meta): Promise<string>`, `loadSession(sid): Promise<SessionRow | null>` (null when revoked or expired), `revokeSession(sid)`, `revokeAllForAccount(accountId)`. Each revoke writes an audit event.
- [ ] **Step 3:** In `config.ts`, `authorize` calls `issueSession` and returns the id; the `jwt` callback stores it as `token.sid`; the `session` callback calls `loadSession` and returns a session with no user when it is gone, so `currentActor()` yields `null`.
- [ ] **Step 4:** Roles are re-read from the database in the session callback rather than trusted from the token. A role revoked mid-session must take effect on the next request; that is the whole point.
- [ ] **Step 5:** Tests — a live session authorises; a revoked session does not; an expired session does not; revoking one session does not affect another for the same account; a role revoked mid-session is refused on the next call.
- [ ] **Step 6:** Sign-out revokes the row rather than only clearing the cookie.
- [ ] **Step 7:** Commit — "Make sessions revocable by putting their authority in a row". Note in the message why the stock database strategy is unavailable, so nobody re-litigates it.

**Cost note:** this adds one indexed primary-key read per authenticated request. That is the price of revocation and it should be paid knowingly, not discovered.

---

## Task 3: The transition map and guarded status changes

The core Phase 2 primitive. Everything after this is a transition with extra data attached.

**Files:** `webapp/src/lib/cases/transitions.ts`; `webapp/src/server/cases.ts`; `webapp/tests/transitions.test.ts`

**Interfaces:**
- `type Transition = { from: CaseStatus; to: CaseStatus; roles: ComplianceRole[] }`
- `canTransition(from, to, roles): boolean`
- `changeCaseStatus(actor, caseId, to, reason, meta): Promise<void>`

- [ ] **Step 1:** Encode spec §6 as one exported array — the only place transitions are defined:

```
submitted           → triaged                officer, admin
triaged             → under_investigation    officer, investigator, admin
triaged             → dismissed              officer, admin
under_investigation → pending_decision       officer, investigator, admin
under_investigation → dismissed              officer, admin
pending_decision    → resolved               officer, admin
pending_decision    → dismissed              officer, admin
resolved            → closed                 officer, admin
closed              → appealed               officer, admin, dpo
appealed            → under_investigation    officer, investigator, admin
```

- [ ] **Step 2:** `changeCaseStatus` does all of this in **one transaction**: authorise, re-read the case, reject the move if the map disallows it (`InvalidTransitionError`, which Phase 1 already defines and has never thrown), update `cases.status`, insert `case_status_history`, set `resolved_at`/`closed_at` when entering those states, write the audit event, and enqueue notifications (Task 9 fills the last in; leave the call site, not a TODO).
- [ ] **Step 3:** Tests, and these are the ones that matter:
  - every legal transition in the map succeeds for a permitted role;
  - **every transition not in the map is refused** — iterate the full cross-product of statuses, which catches a typo'd map entry that a hand-written test list would not;
  - a permitted transition with the wrong role is refused;
  - a failed transition writes **no** history row and **no** audit row (roll the transaction back mid-way and assert both counts are unchanged);
  - `closed_at` is set exactly once.
- [ ] **Step 4:** Commit — "Put every legal case transition in one map and refuse the rest".

---

## Task 4: Assignment and first response

**Files:** `webapp/src/server/cases.ts`; `webapp/src/app/cases/page.tsx`; `webapp/tests/assignment.test.ts`

**Interfaces:** `assignCase(actor, caseId, officerAccountId | null, meta)`; `listCases` filter gains `assignedTo?: string | "me" | "unassigned"`.

- [ ] **Step 1:** `assignCase` authorises (`officer`, `admin`), refuses an assignee from another institution (reuse `requireSameInstitution` against the *assignee's* account, not the actor's — the easy mistake here is checking the wrong subject), sets `assigned_officer_id`, and audits with before/after.
- [ ] **Step 2:** Set `first_response_at` on the first assignment or first status change, whichever comes first, and only when null. It is a service-level concern, not a trigger, because "first officer action" is a product definition rather than a data one.
- [ ] **Step 3:** Queue gains an assignee filter and a "mine" default for officers.
- [ ] **Step 4:** Tests — assignment audits before and after; cross-institution assignee refused; `first_response_at` set once and never moved; unassignment allowed and audited.
- [ ] **Step 5:** Commit — "Add case assignment and first-response tracking".

---

## Task 5: Case parties

Before notes and outcomes, both of which reference parties.

**Files:** schema, migration; `webapp/src/server/parties.ts`; case detail page; `webapp/tests/parties.test.ts`

**Schema** (spec §4.4): `case_parties` — `id`, `case_id → cases ON DELETE CASCADE`, `user_account_id NULL → user_accounts`, `external_name text NULL`, `party_role party_role`, `is_anonymous boolean NOT NULL DEFAULT false`, `created_at`, `deleted_at NULL`. New enum `party_role ('complainant','respondent','witness','advisor')`.

- [ ] **Step 1:** Add the enum and model. A party is either an account **or** an external name — enforce it:

```sql
ALTER TABLE compliance.case_parties
  ADD CONSTRAINT case_parties_identified CHECK (
    (user_account_id IS NOT NULL AND external_name IS NULL)
    OR (user_account_id IS NULL AND external_name IS NOT NULL)
    OR (is_anonymous AND user_account_id IS NULL AND external_name IS NULL)
  );
```

The third branch is the anonymous complainant — a real party with no identity, which is the case this system exists to handle.

- [ ] **Step 2:** `addParty`, `listParties`, `removeParty` (soft delete). Adding a party to a sealed case requires `dpo`, matching Phase 1's rule.
- [ ] **Step 3:** Add the CHECK to `db-invariants.test.ts`.
- [ ] **Step 4:** Tests — an account party and an external party both save; a party with both identities is refused by the database (write through Prisma, not the service, for the same reason Phase 1's anonymity test does); an anonymous party saves with neither.
- [ ] **Step 5:** Commit — "Add case parties, including parties with no identity".

---

## Task 6: Investigation notes with visibility

**Files:** schema, migration; `webapp/src/server/notes.ts`; case detail page; `webapp/tests/notes.test.ts`

**Schema:** `case_notes` — `id`, `case_id`, `author_id → user_accounts`, `body text`, `visibility note_visibility`, `created_at`, `updated_at`, `deleted_at NULL`. New enum `note_visibility ('internal','shared_with_parties','reporter_visible')`.

- [ ] **Step 1:** Schema and migration.
- [ ] **Step 2:** `addNote`, `listNotes(actor, caseId)` — and **the filtering is the feature**. `internal` is visible to officer/investigator/admin/dpo only; `shared_with_parties` additionally to accounts that are parties on that case; `reporter_visible` additionally to the attributed reporter. Filter in the **query**, not after fetching, so a rendering bug cannot leak a note the query never returned.
- [ ] **Step 3:** Notes are soft-deleted and never hard-deleted (spec §4.4). Editing a note keeps the audit trail: audit `note.updated` with before and after bodies.
- [ ] **Step 4:** Tests — each visibility level is returned to exactly the right actors and withheld from the rest, asserted per role; a deleted note disappears from `listNotes` but its row and audit history survive.
- [ ] **Step 5:** Commit — "Add investigation notes and enforce their visibility in the query".

---

## Task 7: Outcomes and sanctions

**Files:** schema, migration; `webapp/src/server/outcomes.ts`; case detail page; `webapp/tests/outcomes.test.ts`

**Schema:** `outcomes` — `id`, `case_id UNIQUE → cases`, `finding finding`, `rationale text`, `decided_by → user_accounts`, `decided_at`. `sanctions` — `id`, `outcome_id → outcomes ON DELETE CASCADE`, `subject_party_id → case_parties`, `sanction_type`, `description text`, `effective_from date`, `effective_to date NULL`, `status text`. New enums `finding`, `sanction_type` per spec §4.1.

- [ ] **Step 1:** Schema and migration. `UNIQUE (case_id)` — one outcome per case, enforced by the database.
- [ ] **Step 2:** `recordOutcome(actor, caseId, input, meta)` authorises `officer`/`admin`, and **refuses unless the case is in `pending_decision`**. An outcome on an untriaged case is not a workflow state anyone intended.
- [ ] **Step 3:** Recording an outcome and transitioning to `resolved` happen in one transaction, reusing `changeCaseStatus`'s logic rather than duplicating the status write.
- [ ] **Step 4:** `addSanction` requires the sanction's subject to be a party **on that case** — check it, because a foreign key to `case_parties` alone permits attaching a sanction to a party of a different case.
- [ ] **Step 5:** `effective_to` must be null or after `effective_from`; a CHECK, plus an invariants assertion.
- [ ] **Step 6:** Tests — one outcome per case enforced by the database; outcome from the wrong status refused; sanction against a party from another case refused; recording an outcome moves the case to `resolved` and writes both audit rows.
- [ ] **Step 7:** Commit — "Add outcomes and sanctions, with one outcome per case enforced in the schema".

---

## Task 8: Evidence upload and the storage driver

The largest task, and the one with the most ways to be quietly unsafe.

**Files:** schema, migration; `webapp/src/lib/storage/{driver,local,supabase}.ts`; `webapp/src/lib/upload/inspect.ts`; `webapp/src/server/evidence.ts`; `webapp/src/app/evidence/[id]/route.ts`; `webapp/tests/evidence.test.ts`

**Schema** (spec §4.6): `evidence_files` — `id`, `institution_id`, `case_id NULL`, `report_id NULL`, `uploaded_by NULL`, `storage_key text`, `original_filename text`, `mime_type text`, `byte_size bigint`, `sha256 char(64)`, `scan_status scan_status`, `created_at`, `deleted_at NULL`, plus `CHECK (case_id IS NOT NULL OR report_id IS NOT NULL)`.

- [ ] **Step 1:** Schema, migration, CHECK, and the invariants assertion.
- [ ] **Step 2:** `StorageDriver` — `put(key, bytes, contentType)`, `get(key): ReadableStream`, `delete(key)`. Local driver writes under a directory from `EVIDENCE_DIR`; Supabase driver wraps its Storage client. Chosen by env, never by request.
- [ ] **Step 3:** `inspectUpload(bytes, filename)` — **sniff the MIME type from content** with `file-type` and ignore the client's header entirely; reject by sniffed type *and* by extension (executables, archives, scripts); cap at `MAX_UPLOAD_BYTES`; compute sha256; return a **random** storage key. The original filename is metadata and never a path component.
- [ ] **Step 4:** `uploadEvidence` writes metadata and bytes; a failed storage write must not leave a metadata row, so write the object first and the row second, inside a transaction that the storage failure aborts.
- [ ] **Step 5:** `scan_status` starts `pending`. Phase 2 ships no scanner; a stub marks `skipped` and the README says so plainly. **Files with `scan_status IN ('pending','flagged')` are not downloadable** — the gate exists now even though the scanner does not, because adding the gate later means auditing every existing download path.
- [ ] **Step 6:** `GET /evidence/[id]` authorises against the case or report, then streams. Never a static path; never a redirect to a signed URL that outlives the check.
- [ ] **Step 7:** Tests, and these are the point of the task:
  - a `.png` renamed `.exe` is rejected (extension), and a `.exe` renamed `.png` is rejected (sniffed type) — the second is the one that matters;
  - oversize rejected;
  - the storage key is not derived from the filename;
  - a user from another institution gets 403 on download;
  - a `pending` or `flagged` file is refused;
  - two identical uploads produce the same sha256 and two rows.
- [ ] **Step 8:** Commit — "Add evidence upload with content-sniffed types and an authorised download path".

---

## Task 9: Notifications and the activity feed

**Files:** schema, migration; `webapp/src/server/notifications.ts`; `webapp/src/app/notifications/page.tsx`; `webapp/tests/notifications.test.ts`

**Schema:** `notifications` — `recipient_id → user_accounts`, `case_id NULL`, `channel report_channel`, `subject text`, `body text`, `is_read boolean DEFAULT false`, `read_at NULL`, `created_at`. Partial index `(recipient_id) WHERE is_read = false` (spec §4.8).

**The activity feed is a view over `audit_events`, not a table** (spec §4.7) — the same event written twice can disagree with itself.

- [ ] **Step 1:** Schema, migration, partial index, invariants assertion.
- [ ] **Step 2:** `notify(tx, recipients, payload)` — takes the caller's transaction client, exactly like `withAudit`, so a notification never announces something that rolled back.
- [ ] **Step 3:** Fill in the notification call sites left by Tasks 3, 4 and 7: assignment notifies the assignee; a status change notifies the assigned officer and any account parties; an outcome notifies the parties.
- [ ] **Step 4:** Create `compliance.activity_feed` as a **view** over `audit_events`, filtered to user-visible actions and joined to actor names. Declare it in `schema.prisma` as a view, or query it raw — either way add it to `db-invariants.test.ts`, because Prisma will propose dropping it.
- [ ] **Step 5:** `listNotifications`, `markRead`, `unreadCount`; badge in the header.
- [ ] **Step 6:** Tests — a rolled-back transition leaves **no** notification (the `withAudit` rollback test, repeated for this primitive because it is the same trap); notifications are scoped to recipient; unread count uses the partial index; the feed excludes internal-only actions.
- [ ] **Step 7:** Commit — "Add notifications inside the transaction and an activity feed view".

---

## Task 10: A shared-store rate limiter

**Files:** migration; `webapp/src/lib/rateLimit.ts`; `webapp/tests/rateLimit.test.ts`

Postgres rather than Redis: the database is already there, already transactional, and adding an infrastructure dependency to fix a single-instance assumption trades one operational problem for a larger one.

- [ ] **Step 1:** `compliance.rate_limit_buckets` — `key text PK`, `count int`, `window_start timestamptz`.
- [ ] **Step 2:** Rewrite `assertRateLimit` as an atomic upsert returning the post-increment count, throwing `RateLimitedError` above the limit. Keep the signature `(key, limit, windowMs)` so Phase 1's call sites and the authorisation test's `CHECKS` list are untouched. `resetRateLimits()` stays, for tests.
- [ ] **Step 3:** The function becomes `async`. Update `lookupAnonymousReport` and its tests accordingly — this is the only breaking change in the task.
- [ ] **Step 4:** Add a sweep for windows older than an hour, called opportunistically, so the table does not grow without bound.
- [ ] **Step 5:** Tests — the limit holds across two independently constructed limiter modules (simulating two processes), which is precisely what the in-memory version failed; the window expires; the sweep removes stale rows.
- [ ] **Step 6:** Commit — "Move the rate limiter into Postgres so it holds across processes".

---

## Task 11: Phase 2 verification and documentation

- [ ] **Step 1:** Extend `webapp/scripts/verify.ts` with Phase 2 invariants, each checking the whole database rather than a fixture:
  1. no case has more than one outcome;
  2. every `resolved` or `closed` case has an outcome;
  3. every sanction's subject party belongs to the sanction's case;
  4. every case status appears in its own history (already present — keep it);
  5. no `evidence_files` row is orphaned of both case and report;
  6. no evidence row has `scan_status = 'clean'` with a null sha256;
  7. every notification's recipient shares the institution of its case;
  8. no case number collides within an institution and year;
  9. no session is both revoked and later used (revoked rows have no `last_seen_at` after `revoked_at`).
- [ ] **Step 2:** Break one of them deliberately, confirm `verify` exits 1, and restore. A check never seen to fail is not evidence of anything — Phase 1's script was proved this way and Phase 2's should be too.
- [ ] **Step 3:** Update `webapp/README.md`: the routes table, the transition map, the evidence rules, and a rewritten **Known limitations** section. Items that leave it: JWT-without-revocation, the per-process limiter, racy case numbers. Items that join it: no malware scanner (uploads are marked `skipped` and gated), notifications are in-app only with no email delivery, and the session check costs one read per request.
- [ ] **Step 4:** Full gate — `npm test`, `npm run verify`, `npm run build`, `npx tsc --noEmit`, `npm run lint`.
- [ ] **Step 5:** Commit — "Add phase 2 verification and documentation".

---

## Self-Review

**Spec coverage.** §4.4 supporting tables → Tasks 5, 6, 7 (`case_parties`, `case_notes`, `outcomes`, `sanctions`; `case_reports` and `case_status_history` landed in Phase 1). §4.6 evidence → Task 8. §4.7 notifications and activity feed → Task 9. §4.8 indexing → Tasks 2, 9. §6 case workflow → Tasks 3, 4, 7. §7 storage → Task 8. §5.1 revocable sessions → Task 2. Phase 1 debt → Tasks 1, 2, 10.

**Deferred to Phase 3, per spec §2:** the versioned policy library with acknowledgements and search (§4.5), officer and admin dashboards, the campus directory, and the traffic simulator (§8.1–8.3).

**Known deviations from the spec, decided here rather than discovered later:**

1. **§5.1 database-backed sessions.** Auth.js v5 does not support `strategy: "database"` with the Credentials provider. Task 2 keeps the JWT as transport and moves authority into a `compliance.sessions` row checked on every request. This delivers immediate revocation — the property the spec wants — without replacing Auth.js. Recorded in the README rather than left as a silent divergence.
2. **§4.6 malware scanning.** No scanner ships in Phase 2. `scan_status` and the download gate ship now, defaulting to `skipped`, so wiring a scanner later is a change to one function rather than an audit of every download path.

**Ordering.** Tasks 1–2 pay debt that later tasks would otherwise multiply. Task 3 is the primitive Tasks 4 and 7 build on. Task 5 precedes 6 and 7 because notes and sanctions both reference parties. Task 8 is independent and may run in parallel. Task 9 fills call sites deliberately left by 3, 4 and 7 — those are call sites to a function that does not yet exist, not TODOs, and the plan says so at each point.

**Placeholders.** None. Where a task describes UI or a driver in prose rather than a full listing, it names the function, its signature, its authorisation rule and its edge cases, and a test pins the behaviour first.

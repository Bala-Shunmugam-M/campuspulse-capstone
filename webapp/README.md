# Campus Compliance — web platform

The case-management half of CampusPulse. The Python project in the repository
root owns the `campuspulse` schema — institutions, people, locations and
categories. This application owns the `compliance` schema and treats
`campuspulse` as read-only.

Three phases, all shipped:

- **Phase 1 — the spine.** Identity, authorisation, an audit trail, anonymous
  intake and the officer case queue.
- **Phase 2 — the workflow.** Assignment, guarded status transitions,
  investigation notes, outcomes and sanctions, evidence upload, notifications.
- **Phase 3 — knowledge and insight.** A versioned policy library with
  acknowledgements and search, officer and admin dashboards, the campus
  directory, and a traffic simulator that drives the application to produce a
  realistic dataset rather than a seeded one.

---

## 1. Prerequisites

- **Node 24** (the repository pins `@types/node@^24` to match).
- **PostgreSQL 17.** `docker-compose.yml` is provided and is the intended path.
  If Docker is unavailable, any local Postgres 17 works — see
  [§2.1](#21-without-docker).

## 2. Setup

```bash
cd webapp
npm install
docker compose up -d                 # Postgres 17 on localhost:5433
cp .env.example .env                 # then fill in the two secrets, below
```

Generate the two secrets — never commit them, `.env` is git-ignored:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

Use one value for `AUTH_SECRET` and a second, different one for
`IP_HASH_PEPPER`. Rotating the pepper breaks the ability to correlate
historical reports by reporter IP, so do not rotate it casually.

Then create the schema and seed it:

```bash
psql "$DATABASE_URL" -f prisma/fixtures/campuspulse_min.sql   # local only
npx prisma migrate deploy
npx prisma generate
npm run seed
npm run dev                          # http://localhost:3100
```

Restart the dev server after any `prisma generate`. A running Next process holds
the old client, and the symptom — `prisma.X is undefined` — looks nothing like
the cause.

The seed establishes the world and is idempotent: institutions, people,
departments, locations, categories, role assignments, and a starting policy
library of six published policies per institution. It writes directly to the
database, because a world is a fixture rather than an event. Activity is a
different matter — see §12.

The fixture recreates only the `campuspulse` tables this application
references, so foreign keys resolve offline. Against the real Supabase database
those tables already exist and the fixture is not run.

### 2.1 Without Docker

The compose file needs a working Docker engine. On a machine without one,
install PostgreSQL 17 directly, create a `compliance` role and database, and
point `DATABASE_URL` at it. Everything else is identical. The portable binaries
(no installer, no administrator rights) work well:

```bash
initdb -D <data-dir> -U compliance --auth=scram-sha-256 --pwfile=<file> -E UTF8
pg_ctl -D <data-dir> -o "-p 5433" -l <data-dir>/server.log start
createdb -h 127.0.0.1 -p 5433 -U compliance compliance
```

Port **5433**, not 5432, deliberately: it cannot be confused with an existing
local Postgres, and silently connecting to the wrong database is an expensive
afternoon.

The dev server runs on **3100** rather than 3000, because 3000 is commonly
already taken. `AUTH_URL` must match the port actually in use — signing in
against the wrong origin fails in ways that look like a credentials bug.

## 3. Seeded accounts

Three institutions (`NGU`, `RIT`, `WFC`), 40 people each, with this role mix per
institution:

| Role | Count | Example address |
| --- | --- | --- |
| `admin` | 1 | `admin1@northgate.edu` |
| `dpo` | 1 | `dpo1@northgate.edu` |
| `officer` | 3 | `officer1@northgate.edu` |
| `investigator` | 4 | `investigator1@northgate.edu` |
| `reporter` | 31 | `reporter1@northgate.edu` |

Every seeded account shares the passphrase **`capstone demo passphrase`** and
carries `must_change_password`, so a development convenience is never mistaken
for a deployment posture. The other institutions use `@riverside.edu` and
`@westfield.edu`.

The seed is idempotent: running it twice prints identical counts. A seed that
silently doubles on a second run surfaces much later as a number nobody can
explain.

## 4. Architecture

### The service-layer rule

Every exported function in `src/server/` performs an authorisation check.
`tests/service-authorisation.test.ts` walks the directory and fails the build if
one does not. The exemption list is short and explicit:

| Exempt | Why |
| --- | --- |
| `authenticate` | Produces identity; cannot require it. |
| `newRequestMeta` | Pure helper, touches no data. |
| `submitAnonymousReport` | Has no actor by definition; rate-limited instead. |
| `lookupAnonymousReport` | Authorised by reference code plus access secret. |

An exemption is therefore a decision someone reviewed, not a line nobody
noticed was missing.

### The audit guarantee

`withAudit(tx, ctx, event)` takes the caller's transaction client rather than
opening its own, so a mutation and its audit row commit or roll back together.
`compliance.audit_events` is append-only, enforced by trigger rather than by
revoking privileges — in development the application connects as the schema
owner, and an owner can grant privileges back to itself. A trigger binds
regardless of role.

Failed logins and failed anonymous lookups are audited, not only successes.
Failures are what an investigator actually needs and are usually the ones
missing.

### The read-only `campuspulse` boundary

`campuspulse` models are described in `schema.prisma` in full, but everything
this application has no business touching carries `@ignore` — `users.role`, and
the `locations` and `categories` models entirely. They stay in the database and
in migrations; they are absent from Prisma Client.

**This matters more than it looks.** Prisma Migrate diffs the whole datasource
against `schema.prisma` and drops whatever it cannot see. When the campuspulse
tables were modelled only partially, a generated migration contained
`DROP TABLE campuspulse.locations`, `DROP TABLE campuspulse.categories` and
`ALTER TABLE campuspulse.users DROP COLUMN role` — against Supabase that would
have deleted live tables.

### Invariants Prisma cannot express

Some guarantees exist only in SQL: the composite tenant foreign key, the
partial unique index on live role grants, the report anonymity `CHECK`, the
append-only triggers, the generated `search_tsv` and `body_tsv` columns with
their GIN indexes, and the trigger that refuses to let a published policy
version change.

Prisma proposes dropping these on **every** generated migration. Two habits keep
them:

1. Read every generated `migration.sql` before applying it and delete any
   statement that removes a hand-written object. The applied migrations record
   which lines were removed and why.
2. `tests/db-invariants.test.ts` asserts each one exists.

This is not hypothetical — `20260916181458_add_reports` dropped
`user_accounts_tenant_fk`, and the tenant boundary was missing until a test
caught it. `20260916190000_restore_tenant_fk` puts it back. It has not stopped
trying: both Phase 3 migrations proposed dropping the same constraint again, and
the second also proposed altering both generated `tsvector` columns. Each
migration file records at its head which statements were deleted from it by
hand.

One exception is recorded in `20260917130747_backfill_audit_actor_emails`, which
drops the append-only `UPDATE` trigger on `audit_events`, backfills, and puts it
back in one transaction. `actor_label` is a display field — a second rendering
of `actor_user_account_id`, which is what actually identifies the actor and
which the migration does not touch — so correcting it changes how an event
reads, not what it records. That is the only reason that justifies lifting the
trigger.

## 5. Running the checks

```bash
npm test         # 237 tests across 31 files
npm run verify   # 24 invariant checks against the live database
npm run build    # production build
npx tsc --noEmit # type check
npm run lint     # eslint
```

`verify` checks invariants against whatever the database currently holds, not
against what a test just created — which is how the Python half of this project
found its real bugs. It has earned that description twice. In Phase 1, dropping
the anonymity constraint and corrupting one row turned a check red and the exit
code to `1`. In Phase 2 it found a live defect on its first run: fourteen
resolved cases with no recorded outcome, because `changeCaseStatus` had allowed
`resolved` as a bare status change. In Phase 3 the new "resolved precedes
closed" check turned red on its first run over simulated data and exposed a
clock that was leaking between requests — see §11. A verification script never
seen to fail is not evidence of anything.

The Phase 3 checks are: every recorded transition is one `TRANSITIONS` permits
(built from the same array the application enforces, so the two cannot drift);
resolved precedes closed; the policy immutability trigger is present and
enabled; every published policy version keeps its publication stamp; no two
published versions of a policy are live at once; every acknowledgement names a
published version; no version number repeats within a policy.

## 6. Case workflow

Every legal transition and the role it needs lives in
`src/lib/cases/transitions.ts`. Anything absent from that array is refused, and
the test walks the whole cross-product of statuses to prove it.

```
submitted ─▶ triaged ─▶ under_investigation ─▶ pending_decision ─▶ resolved ─▶ closed
                │              │                      │                          │
                └──▶ dismissed ◀──────────────────────┘        closed ─▶ appealed ─▶ under_investigation
```

**`resolved` is not reachable through `changeCaseStatus`.** A case is resolved
by recording its outcome, which writes the finding and the status in one
transaction. A resolved case with no recorded decision is precisely the gap the
outcomes table exists to close, so it is made unreachable rather than merely
discouraged.

A case has exactly one outcome, enforced by `UNIQUE (case_id)`. An appeal that
is re-decided **revises** that outcome and audits as `case.outcome_revised`
carrying both findings; it does not add a second.

## 7. Evidence

Uploads are typed from their bytes. The client's declared content type is never
consulted — it is the one field an attacker fully controls.

The permitted set is an **allowlist** of signatures (PNG, JPEG, GIF, PDF, plain
text), not a blocklist of dangerous formats. A blocklist must enumerate every
hostile format and is wrong the moment a new one appears. Both directions of
disguise are refused: an executable renamed `.png` fails on its bytes, and a PNG
renamed `.exe` fails on its name, because the name is what a careless viewer
acts on.

Storage keys are random hex and never derived from the filename. Files are
served only through `GET /evidence/[id]`, which authorises first and streams —
never a static path, and never a redirect to a signed URL that would outlive the
check. A refusal and a miss both return 404.

## 8. The policy library

`policies` holds the stable identity of a rule — its code, title and owning
department. What the rule actually *says* lives in `policy_versions`, and that
separation is the whole design: superseding a policy never edits the text anyone
has already acknowledged.

**A published version is immutable, and the database is what says so.** The
trigger `policy_versions_no_edit_after_publish` refuses any update to a
published row except `effective_to`. Drafts stay editable, because nobody has
acknowledged them. "The policy said something different when I signed it" is
precisely the claim this table exists to refute, so the refusal cannot live in a
service that could be bypassed — `tests/policy-immutability.test.ts` writes
through Prisma Client directly to prove it.

Superseding writes version *n+1*, publishes it, and closes version *n* on the
same date, in one transaction. The two halves have to agree: closing *n* while
*n+1* is still a draft would leave the policy with nothing in force from that
date. `verify` holds the resulting invariant — no two published versions of a
policy are ever live at once.

**An acknowledgement names a version, never a policy.** Coverage is therefore
per version, and rewriting a policy resets it to zero. Any other reading lets
"everyone has acknowledged the code of conduct" survive a rewrite of the code of
conduct, which is exactly the reassurance nobody should be given.

Search runs over the text in force today — drafts and superseded versions are
excluded, because a search result is an answer to "what are the rules", and an
answer drawn from text that does not apply is worse than no answer. Bodies are
Markdown, rendered by a small parser in `src/lib/markdown.ts` that produces a
structure rather than an HTML string; the page renders that as JSX, so
`dangerouslySetInnerHTML` appears nowhere and a policy body containing
`<script>` shows those characters. Links and raw HTML are not supported, on
purpose.

## 9. Dashboards

Every figure is aggregated by Postgres. Fetching every case to count them in a
loop is the version that works on seed data and dies once the simulator has
produced thousands.

**Officer** (`/dashboard`, any staff role):

| Figure | Means |
| --- | --- |
| Assigned to you | Open cases where you are the assigned officer. |
| Overdue | `sla_due_at` has passed and the case is not resolved or closed. |
| Due in 24 hours | Not yet overdue, but will be within a day. |
| Unassigned | Open cases with no officer. |
| Median first response | Hours from a case opening to the first officer action on it. |
| Cases by status | Every status, counted. |

**Administrative** (same page, `admin` and `dpo` only):

| Figure | Means |
| --- | --- |
| SLA breach rate | Of cases that reached an outcome, the share resolved after their stored due date. |
| Anonymous reports | The share of intake submitted with no reporter identity. |
| Intake by week | Reports received per week over the last twelve. |
| Officer workload | Open and overdue cases per officer, heaviest first. |
| Outcome mix | Findings recorded, as a share of all outcomes. |
| Policy coverage | Accounts that have acknowledged the version of each policy in force. |

Two things these figures do deliberately.

**The breach rate reads stored values.** It compares the `sla_due_at` written
when the case was opened against when it was resolved. Phase 1 stored that
column precisely so that tuning the severity policy later cannot rewrite whether
past cases breached; a dashboard that recomputed the due date from today's
`SLA_HOURS` would quietly restate history every time the policy was tuned. Two
tests hold that line — re-grading a closed case to the highest severity does not
move the figure, and neither does multiplying every entry in `SLA_HOURS` by a
thousand.

**Every proportion carries its denominator,** and 0/0 reports as "nothing to
report" rather than as 0%. A bare "68%" invites the wrong conclusion when n
is 12.

"Overdue" is defined once, in `src/lib/cases/sla.ts`, and shared by the queue,
the case page and the dashboards, so the headline figure and the list it links
to cannot disagree. Sealed cases are excluded from every figure, as they are
from the queue: a count that included them would let someone infer the existence
of a case they may not see.

## 10. The campus directory

`/directory` is a read-only view of `campuspulse` — people, locations and
categories, tenant-scoped, paginated. It is staff-only: a reporter does not get
a searchable list of everyone on campus.

Locations and categories are read through `$queryRaw` because both models carry
`@@ignore` in `schema.prisma` and are therefore absent from Prisma Client. That
is the read-only boundary working as designed rather than a workaround.
Un-ignoring the models to "tidy it up" would put those tables back inside Prisma
Migrate's diff and reopen the hazard that has already dropped hand-written SQL
from this database once.

The queue and the directory both page by keyset rather than `OFFSET`. The queue
is ordered by `sla_due_at`, and that order changes while someone reads it — every
passing minute moves cases relative to "now", and any triage inserts a row.
Offset paging over a list that reorders underneath the reader silently skips
rows and repeats others, and a compliance queue that loses a case is worse than
one that is slow. Each cursor names the last row by both its sort key **and** its
id, because two rows sharing a key can straddle a page boundary and a key-only
cursor drops one of them.

## 11. Simulated time, and what keeps it out of production

`src/lib/clock.ts` decides when a request is happening. In ordinary operation
that is the real clock and nothing else is possible.

**Why the seam exists.** The simulator drives real HTTP endpoints, which is what
makes its output data the application could genuinely have produced. But every
request would then be stamped with the moment the simulator ran, giving a
dataset with no ageing queue, no overdue cases and no SLA history — and
dashboards built on it would be uniformly, falsely green. The header
`X-Simulated-Now` lets a request say when it is happening.

**What keeps it out of production.** A clock an HTTP header can move must be
impossible to enable by accident, so it is gated twice and both gates must open:

1. `SIMULATION_MODE=1` must be set in the environment, **and**
2. `NODE_ENV` must not be `production`.

The second is a refusal, not a fallback. With `NODE_ENV=production` the module
ignores `SIMULATION_MODE` entirely, logs that it is doing so, and no code path
reads the header — `withSimulatedTime` is refused on the same terms, so a script
cannot reach around it either. Four tests in `tests/clock.test.ts` hold that
shut.

**How the instant travels.** `newRequestMeta(headers)` reads it once and puts it
on `RequestMeta.at`; every service stamp and every audit row takes it from
there. `withAudit` sets `occurred_at` itself rather than leaving it to the
column default, because Postgres `now()` is transaction time and cannot be
moved — a default would have been the one timestamp simulated time could never
reach.

It is carried explicitly for a reason. The first version kept it in ambient
storage entered with `AsyncLocalStorage.enterWith`, which mutates the *current*
async context rather than opening a new one. On a long-lived server the value
outlived the request that set it, and a later request read an earlier request's
clock. The simulator produced a case closed nine days before it was
investigated, its own audit trail said so, and `verify`'s new "resolved precedes
closed" check is what caught it. Ambient state that leaks between requests is
not worth the convenience of a zero-argument `now()`.

Sessions stay on the real clock even under simulation. A session is
infrastructure, not part of the record a run produces; dating one by simulated
time would issue it already expired, and mixing the two would let `last_seen_at`
fall after `revoked_at`, which `verify` rightly refuses.

## 12. The simulator

`scripts/simulate.ts` produces activity by **driving the running application over
HTTP**. It does not write to the database. It signs in as seeded users and
submits the same forms a browser submits, reaching server actions exactly as a
browser with JavaScript disabled does — Next renders each as a POST to the
page's own URL carrying a hidden `$ACTION_ID` field.

That constraint is the point. A script that inserted rows could manufacture a
case with no audit trail, an SLA that was never computed and a status no
transition allows: data that looks plausible and is structurally impossible.
Everything the simulator produces arrives through the application, so it carries
the audit rows, status history and notifications a real action leaves.

```bash
# in one terminal — the server must run with the flag too
SIMULATION_MODE=1 npm run dev

# in another
SIMULATION_MODE=1 npm run simulate -- --seed 7 --anchor 2026-09-17 --days 90 --reports 250
```

| Argument | Default | Meaning |
| --- | --- | --- |
| `--seed` | `1` | Drives every draw, Faker included. The same seed reproduces the run. |
| `--anchor` | today | The date the simulated window ends. |
| `--days` | `90` | How far back the window reaches. |
| `--reports` | `200` | How many reports arrive across the window. |
| `--institution` | `NGU` | Which seeded institution to populate. |
| `--base-url` | `http://localhost:3100` | The server to drive. |
| `--verify` | `true` | Run `npm run verify` at the end; `--verify false` skips it. |

**The behavioural model** (spec §8.2). Arrivals follow the shape
`02_Insert_Data.py` already validated: weekday above weekend, clustering at
class-change times, roughly a third anonymous. Officers work the queue in the
order the application presents it — oldest untriaged first, most urgent cases
first — and do not act instantly: response latency is drawn from an exponential
distribution, because uniform latency is what makes SLA analytics meaningless,
since every case would breach or none would. Investigators add notes and upload
evidence across a case's life. A deliberate minority of cases is dismissed at
triage, appealed after closure, or reassigned mid-investigation; a dataset in
which every case flows cleanly to `closed` teaches nothing and would make the
dashboards lie. Free text is composed from templated fragments with Faker, so it
varies in length and register rather than repeating a handful of strings.

Agents choose only from what the page offers them. The case detail view renders
just the transitions the state machine permits from the current status, so an
agent picking from that select cannot invent a path through the workflow.

**The run is the integration test.** Any non-2xx that is not an expected
refusal fails it loudly and prints the request — as does a redirect to the
sign-in page while holding a session, and Next's error document, which it serves
with a 200. The run finishes by executing `npm run verify`, and exits non-zero
if the database it just filled fails its own checks.

### A recorded run

From an empty database (`prisma migrate reset` then `npm run seed`), driving a
`next dev` server on this machine:

```bash
SIMULATION_MODE=1 npm run simulate -- --seed 7 --anchor 2026-09-17 --days 90 --reports 250
```

**718 actions in 800 seconds**, from 461 planned up front — the rest were
scheduled by the run itself as cases came back to officers and reporters
returned. It exited 0 with 24/24 verification checks passing.

What the agents did, and what Northgate University then held:

| Performed | | Left in the database | |
| --- | --- | --- | --- |
| Anonymous reports | 97 | Reports | 292 |
| Attributed reports | 153 | — of them anonymous | 112 |
| Follow-up statements | 42 | Cases | 285 |
| Cases opened | 285 | Status history rows | 555 |
| Status changes | 225 | Investigation notes | 224 |
| Assignments | 209 | Evidence files | 25 |
| — of them reassignments | 51 | Outcomes | 45 |
| Dismissals | 17 | Notifications | 463 |
| Appeals after closure | 7 | Policy acknowledgements | 72 |
| Outcomes recorded | 45 | Audit events | 1,859 |
| Notes written | 224 | | |
| Evidence uploaded | 25 | | |
| Policy acknowledgements | 72 | | |

The mess is the useful part. 17 cases dismissed at triage, 7 appealed after
closure, 51 reassignments mid-investigation, and a spread of open cases still in
flight at the anchor date — which is what an open queue looks like on any real
day. 112 of 292 reports anonymous, close to the third the model aims for. Every
one of those 1,859 audit events was written by the application in the same
transaction as the change it describes, because the simulator has no other way
to write anything.

Re-running with `--seed 7` and the same anchor reproduces it.

## 13. Known limitations

Deliberate boundaries, written down so each is a known limitation rather than an
undiscovered defect. Phase 1's first three entries are gone: sessions are now
revocable, the limiter is shared, and case numbers come from the database. Two
of Phase 2's are gone too — the queue pages by keyset instead of truncating at
200, and audit rows name their actor by email instead of by uuid.

- **No malware scanning.** `scan_status` and the download gate ship, but nothing
  sets `clean`; uploads are marked `skipped` and are downloadable. The gate
  exists now so that adding a scanner later changes one line instead of
  requiring an audit of every download path.
- **Notifications are in-app only.** No email or SMS delivery. Parties with no
  account cannot be notified at all, because there is nowhere to send it.
- **The session check costs one indexed read per authenticated request.** That
  is the price of immediate revocation, paid deliberately.
- **Sessions are JWT-transported, not Auth.js database sessions.** Auth.js v5
  does not support `strategy: "database"` with the Credentials provider. The
  token carries only a session id and `compliance.sessions` holds the authority,
  which delivers immediate revocation. Do not reach for the stock strategy; it
  will not work.
- **The simulator must run against a development server, and is slow.** The
  clock seam refuses to open under `NODE_ENV=production`, so a run cannot be
  driven against a production build — which is the gate working, and the price
  is `next dev` compiling on demand for every request. Budget roughly a second
  per action.
- **The simulator populates one institution per run.** `--institution` selects
  which; driving all three means three runs.
- **The admin dashboard plots a fixed twelve weeks** of intake and offers no
  date range. Enough to see a trend, not enough to investigate one.
- **Policy authoring has no interface.** `createPolicy`, `draftVersion`,
  `publishVersion` and `supersede` are service functions with tests; the seed
  publishes the starting library. Reading, searching and acknowledging are in
  the interface; writing is not.
- **Acknowledgement coverage counts every account in the institution** as
  required, with no notion of who a policy actually applies to. A policy meant
  for residents is measured against staff as well.
- **`prisma migrate dev` can hang** on this setup while dropping its shadow
  database, holding an advisory lock that blocks the next migration. Use
  `npx prisma migrate dev --create-only` followed by `npx prisma migrate deploy`,
  which needs no shadow database — and which forces the migration to be read
  before it is applied.

## 14. Routes

| Route | Who | Purpose |
| --- | --- | --- |
| `/login` | anyone | Credential sign-in. |
| `/report` | anyone | Submit a report, attributed if signed in, anonymous if not. |
| `/report/submitted` | anyone | Reference code, and the access secret exactly once. |
| `/report/status` | anyone | Check a report with its reference code and access secret. |
| `/cases` | officer, investigator, admin | Case queue, most urgent first; triage and assign from here. |
| `/cases/[id]` | officer, investigator, admin, dpo | Case detail, linked reports, status history, SLA clock. |
| `/dashboard` | officer, investigator, admin, dpo | Workload and SLA figures; admin and dpo also see the institution-wide section. |
| `/policies` | any signed-in user | The policy library, and search over the text in force. |
| `/policies/[id]` | any signed-in user | One policy, its version history, the text, and the acknowledge button. Coverage for admin and dpo. |
| `/directory` | officer, investigator, admin, dpo | People, locations and categories, read-only. |
| `/evidence/[id]` | officer, investigator, admin, dpo | Authorised download of one evidence file. |
| `/audit` | admin, dpo | The audit log. |

Sealed cases never appear in the queue and are refused to everyone but the data
protection officer — including admins. A seal an admin can lift is decorative,
and the cases most worth sealing are the ones involving an admin.

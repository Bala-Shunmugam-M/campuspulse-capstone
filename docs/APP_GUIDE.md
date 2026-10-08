# CampusPulse — the complete guide

What the application is, how it is built, what every table in the database is
for, and how to use it — with screenshots taken from a live run.

| If you want… | Read |
|---|---|
| The whole picture, with screenshots | **this file** |
| Feature and permission reference | [`WEBAPP.md`](../WEBAPP.md) |
| Engineering rules, invariants, the simulator | [`webapp/README.md`](../webapp/README.md) |
| The Python data project and its analytics | [`README.md`](../README.md) |
| Column-by-column detail of the campus schema | [`DATA_DICTIONARY.md`](DATA_DICTIONARY.md), [`ERD.md`](ERD.md) |

---

## Contents

1. [What CampusPulse is](#1-what-campuspulse-is)
2. [How the app is built](#2-how-the-app-is-built)
3. [The database](#3-the-database)
4. [Using the app — a live walkthrough](#4-using-the-app--a-live-walkthrough)
5. [Who can do what](#5-who-can-do-what)
6. [Running and checking it](#6-running-and-checking-it)
7. [What the live run showed](#7-what-the-live-run-showed)
8. [Regenerating the images](#8-regenerating-the-images)

---

## 1. What CampusPulse is

One repository, two halves, **one PostgreSQL database** split into two schemas.

```
                    ┌───────────────────────── PostgreSQL ──────────────────────────┐
 Python data        │  campuspulse schema                    compliance schema       │  Next.js
 project       ────►│  institutions, users, locations,  ◄──── reports, cases,   ◄────┼── web app
 (01_…05_*.py)      │  categories, incidents, reports,  reads notes, outcomes,       │  (webapp/)
 owns + writes      │  work orders, feedback …               policies, audit …       │  owns + writes
                    │  (16 tables)                           (19 tables)             │
                    └────────────────────────────────────────────────────────────────┘
```

| Half | What it does | Owns |
|---|---|---|
| **Python data project** (repo root) | Facilities issue reporting: a student scans a QR sticker, reports a broken fan, the report rolls up into an incident, a technician gets a work order. Builds the schema, generates realistic synthetic data, verifies it (48 checks), and answers 14 analytics questions. | `campuspulse` schema |
| **Web application** (`webapp/`) | A campus **compliance office**: people report misconduct (anonymously if they choose), officers turn reports into cases, investigate, and record outcomes — under an SLA clock, with a tamper-proof audit trail, and with every institution's records sealed off from every other's. | `compliance` schema |

The web app **reads** the campus directory from `campuspulse` (institutions,
people, locations, categories) and **never writes to it**. That boundary is
enforced in code, not just promised — see §2.4.

---

## 2. How the app is built

### 2.1 Stack

| Layer | Technology | Why it is there |
|---|---|---|
| Framework | **Next.js 15** (App Router, React 19, Server Components + Server Actions) | Pages render on the server; forms post to server actions, so no separate REST API is needed |
| Database access | **Prisma 6** | Typed queries; migrations are hand-reviewed (§3.4) |
| Authentication | **Auth.js v5** (Credentials provider) | Email + password sign-in |
| Password hashing | **Argon2** (`@node-rs/argon2`) | Also hashes the anonymous-report access secret |
| Validation | **Zod** | Every form is parsed before it reaches the service layer |
| Tests | **Vitest** — 237 tests across 31 files | Plus `npm run verify`, 32 invariant checks against the live database |
| Database | **PostgreSQL 17** (local) or **Supabase** (hosted) | Triggers, CHECK constraints, generated `tsvector` columns and GIN indexes do real work here |

### 2.2 How a request flows

```
 Browser
   │  GET /cases              POST (form submit)
   ▼                              ▼
 src/app/**/page.tsx       src/app/**/actions.ts       ← pages and server actions: no business logic
   │                              │
   └──────────────┬───────────────┘
                  ▼
            src/server/*.ts                              ← the service layer: EVERY exported function
                  │                                         checks who is asking and what they may do
                  ├─ lib/auth/rbac.ts            role → permission
                  ├─ lib/cases/transitions.ts    the case state machine
                  ├─ lib/cases/sla.ts            due date from severity
                  ├─ lib/audit/withAudit.ts      audit row in the SAME transaction
                  ▼
            lib/db.ts (Prisma) ─────────► PostgreSQL (compliance + campuspulse)
```

**The service-layer rule.** Every exported function in `src/server/` performs an
authorisation check. A test (`tests/service-authorisation.test.ts`) walks the
directory and fails the build if one does not. Four functions are exempt, each
for a stated reason — `authenticate` produces identity so cannot require it,
`submitAnonymousReport` has no actor by definition, `lookupAnonymousReport` is
authorised by reference code plus access secret, and `newRequestMeta` touches no
data.

### 2.3 What each part of `webapp/src` does

| Path | Responsibility |
|---|---|
| `app/page.tsx` | Front door: report, check a report, sign in |
| `app/report/…` | Filing a report, the one-time confirmation page, anonymous status lookup |
| `app/login/page.tsx` | Sign-in form; every sign-in lands on the role-aware front door |
| `components/AccountBar.tsx`, `components/SignOutButton.tsx` | The bar on every signed-in page: who you are, a link home, and **Sign out** |
| `app/dashboard/page.tsx` | Officer workload; institution-wide figures for admin/DPO |
| `app/cases/…` | The queue, triage, and the case detail page with its server actions |
| `app/policies/…` | Policy library, search, one policy with its versions, acknowledge |
| `app/directory/page.tsx` | Read-only campus directory |
| `app/audit/page.tsx` | The audit log (admin/DPO) |
| `app/evidence/[id]/route.ts` | Streams an evidence file after an authorisation check |
| `app/api/auth/[...nextauth]` | Auth.js endpoints |
| `middleware.ts` | Expires the one-time `cp_ref` / `cp_secret` cookies so the access secret renders exactly once |
| `server/*.ts` | One module per area: `reports`, `cases`, `parties`, `notes`, `outcomes`, `evidence`, `notifications`, `policies`, `acknowledgements`, `dashboards`, `directory`, `audit`, `accounts` |
| `lib/auth/` | Auth.js config, Argon2 passwords, database-backed sessions, RBAC table, current-actor lookup |
| `lib/cases/` | `transitions.ts` (which status may follow which, and who may do it) and `sla.ts` (24 / 72 / 168 / 336 hours for severe / high / moderate / low) |
| `lib/audit/withAudit.ts` | Writes the audit row using the caller's transaction |
| `lib/rateLimit.ts` | Fixed-window limiter stored **in Postgres**, so it holds across processes |
| `lib/reference/codes.ts` | Generates `CR-XXXX-XXXX` reference codes and the access secret; hashes and verifies the secret |
| `lib/upload/inspect.ts` | Sniffs a file's real type from its bytes — the client's claimed type is ignored |
| `lib/storage/` | Evidence storage behind a driver interface (local disk today) |
| `lib/notify.ts` | Delivers notifications such as "`CASE-2026-0022` has been assigned to you" |
| `lib/clock.ts` | The single source of "now"; the simulator can move it, production cannot |
| `lib/validation/report.ts` | Zod schema for the report form |
| `lib/markdown.ts`, `components/Markdown.tsx` | Safe rendering of policy text |
| `lib/pagination.ts` | Cursor pagination for long lists |

### 2.4 The guarantees that make it trustworthy

- **Anonymous means anonymous.** An anonymous report stores no reporter id —
  a `CHECK` constraint refuses one — and the access secret is stored only as an
  Argon2 hash. Nobody, including the database owner, can recover it.
- **Every change leaves an audit row, in the same transaction.** If the change
  rolls back, so does its claim to have happened. The audit table refuses
  `UPDATE` and `DELETE` by trigger. Failed logins and failed lookups are
  audited too.
- **The workflow cannot be skipped.** Status changes follow the state machine
  (§4.9); `resolved` is reachable only by recording an outcome.
- **Sessions can be revoked instantly.** The JWT carries only a session id; every
  request loads the `sessions` row, so revoking it signs the user out at once.
- **Five wrong passwords lock the account for fifteen minutes.**
- **Tenants are isolated underneath the permissions.** A composite foreign key
  ties each account to a person *in the same institution*, and every query is
  scoped by institution. No role reaches another institution's rows.
- **The read-only boundary is enforced.** Campus tables the app must not touch
  are marked `@ignore` in `schema.prisma`, so they are absent from Prisma Client
  altogether.

---

## 3. The database

### 3.1 The web application's schema (`compliance`)

![ER diagram of the compliance schema and the campuspulse tables it reads](img/erd-compliance.png)

*Solid lines are enforced foreign keys. Dashed lines are logical links held as
a bare UUID with no foreign key — either because the target lives in the other
schema and the app must not depend on it (`category_id`, `location_id`,
`institution_id`), or because the column records who acted rather than creating
a dependency (`changed_by`, `actor_user_account_id`). `case_reports.report_id`
is also unenforced. Source: [`img/erd-compliance.mmd`](img/erd-compliance.mmd).*

Read the diagram from **`user_accounts` outward** — almost every table hangs off
either an account or a case.

#### Anchors borrowed from `campuspulse` (read-only)

| Table | Role in the app |
|---|---|
| `institutions` | The tenant. Every compliance row belongs to exactly one institution. |
| `users` | The campus directory: every student and staff member. A person exists here whether or not they ever sign in. |
| `locations` | Campus → building → floor → room tree. A report can say where something happened. |
| `categories` | Issue categories. Reports and cases can be classified by them. |

#### Identity and access

| Table | What it holds | How it connects |
|---|---|---|
| `user_accounts` | A person's **login**: email, Argon2 password hash, failed-login count, lock-out time | Exactly one account per `users` row (`user_id` is unique, and a composite FK forces the same institution) |
| `role_assignments` | Which roles an account holds: `reporter`, `officer`, `investigator`, `admin`, `dpo` — optionally scoped to a department | Many per account; `granted_by` records which account granted it; `revoked_at` ends it without deleting history |
| `sessions` | Live sign-ins, with expiry and revocation | Many per account; checked on every request |

#### Intake

| Table | What it holds | How it connects |
|---|---|---|
| `reports` | What someone told the office: title, description, self-assessed severity, channel, status (`received` → `triaged` / `merged` / `rejected`), reference code, access-secret hash | `reporter_user_id` → `user_accounts`, **null when anonymous** (a CHECK enforces it); optional `category_id`, `location_id` |

#### Case work

| Table | What it holds | How it connects |
|---|---|---|
| `cases` | The unit of work: case number (`CASE-2026-0022`), severity, status, SLA due date, confidentiality (`standard` / `restricted` / `sealed`), assigned officer | `assigned_officer_id` → `user_accounts` |
| `case_reports` | **Many reports can feed one case** — five people reporting the same incident produce one case, not five | Composite key (`case_id`, `report_id`); `is_primary` marks the report the case was opened from |
| `case_status_history` | Every status change: from, to, who, why, when | Many per case |
| `case_number_counters` | The next case number per institution per year | Allocated by a SQL function, so simultaneous triages never get the same number |
| `case_parties` | People involved: complainant, respondent, witness, advisor | Either an account, or just a name, or genuinely anonymous — a CHECK allows exactly those shapes |
| `case_notes` | Investigation notes at three visibility levels: `internal`, `shared_with_parties`, `reporter_visible` | Many per case; `author_id` → `user_accounts` |

#### Decisions

| Table | What it holds | How it connects |
|---|---|---|
| `outcomes` | The finding — `upheld`, `partially_upheld`, `not_upheld`, `inconclusive` — and its rationale | **At most one per case** (`case_id` is unique); `decided_by` → `user_accounts` |
| `sanctions` | What follows a finding: warning, reprimand, probation, suspension … with effective dates | Many per outcome; each names the **party** it applies to (`subject_party_id` → `case_parties`) |

#### Evidence and messaging

| Table | What it holds | How it connects |
|---|---|---|
| `evidence_files` | **Metadata only**: original filename, sniffed MIME type, size, SHA-256, scan status. The bytes live in storage under a random key. | Attached to a case, a report, or both; `uploaded_by` → `user_accounts` |
| `notifications` | In-app messages: a case was assigned to you, changed status, was decided | `recipient_id` → `user_accounts`; optional `case_id` |

#### Policy library

| Table | What it holds | How it connects |
|---|---|---|
| `policies` | The stable identity of a rule: code (`ACAD-01`), title, owning department | One per code per institution |
| `policy_versions` | What the policy **says**, version by version, with effective-from / effective-to dates. Immutable once published (trigger). | Many per policy; `published_by` → `user_accounts` |
| `policy_acknowledgements` | "This account read this version" | Names a **version**, never a policy — so rewriting a policy resets coverage to zero |

#### Infrastructure

| Table | What it holds |
|---|---|
| `audit_events` | Every action: who, what, which entity, before/after JSON, request id, hashed IP. Append-only by trigger. |
| `rate_limit_buckets` | Counters for the rate limiter: anonymous status lookups, anonymous submissions, AI drafts. Keys are hashed and the rows are swept after an hour |

### 3.2 The Python project's schema (`campuspulse`)

![ER diagram of the campuspulse schema](img/erd-campuspulse.png)

*Rendered from the Mermaid source in [`ERD.md`](ERD.md), which also explains
each relationship.*

Sixteen tables around one pipeline:

```
student reports a problem ─► REPORT ─► rolled into an INCIDENT (duplicates merge via incident_reports)
                                          ─► WORK ORDER for a SERVICE TEAM ─► resolved ─► FEEDBACK (1–5)
                                          ─► NOTIFICATIONS to every reporter, STATUS HISTORY for audit
```

| Group | Tables |
|---|---|
| Tenancy and people | `institutions`, `users`, `user_roles`, `service_teams`, `team_members` |
| Places and things | `locations` (self-referencing tree), `categories` (self-referencing, carries `sla_hours`), `assets` (QR-tagged equipment) |
| The pipeline | `reports`, `incident_reports` (report ↔ incident, one incident per report), `incidents`, `work_orders`, `status_history` |
| Follow-up | `notifications`, `feedback`, `attachments` (polymorphic) |

The key idea: **five reports of the same broken dispenser become one incident
and one work order**, so one technician is sent, not five.

### 3.3 How the two schemas meet

Only four `campuspulse` tables matter to the web app, and the web app only
reads them:

- `users` → `compliance.user_accounts` (a real foreign key, composite with the
  institution, so an account can never belong to a person in another tenant)
- `institutions` → the `institution_id` on compliance tables
- `categories`, `locations` → optional classification on reports and cases

### 3.4 Guarantees that live in the database, not the code

| Guarantee | Mechanism |
|---|---|
| An anonymous report carries no reporter | `CHECK` on `reports` |
| A party is identified, named, or anonymous — never half of one | `CHECK` on `case_parties` |
| An account belongs to a person in its own institution | Composite foreign key from `user_accounts` to `users` |
| Only one live grant of a role | Partial unique index on `role_assignments` |
| Audit rows are never changed or removed | Trigger on `audit_events` |
| A published policy version never changes (except its end date) | Trigger on `policy_versions` |
| One outcome per case | Unique `outcomes.case_id` |
| Case numbers never collide | `case_number_counters` + `compliance.next_case_number()` |
| Full-text search stays in sync | Generated `tsvector` columns + GIN indexes on `reports` and `policy_versions` |

Prisma cannot express most of these, and its generated migrations try to drop
them. Every migration is read by hand before it is applied, and
`tests/db-invariants.test.ts` asserts each one still exists.

---

## 4. Using the app — a live walkthrough

*These screenshots were taken from the running app on 2026-09-30, against the
local database, which holds seeded users and simulator-generated activity for
the **Northgate** institution. Long pages are cropped at 2,000 px.*

### 4.1 The front door — `/`

![Home page](img/app-01-home.png)

Three ways in: **report an incident** (no account needed), **check a report
you filed**, or **sign in**.

### 4.2 Filing a report — `/report`

![Report form](img/app-03-report-form.png)

Choose the institution, give a title (at least 8 characters) and a description
(at least 40), and pick a severity. Category, location and date are optional.
Not signing in makes the report anonymous; signed-in users file under their
own name.

### 4.3 The one-time confirmation — `/report/submitted`

![Report submitted, showing reference code and access code](img/app-04-report-submitted.png)

You get two things:

- a **reference code** (`CR-S91V-6GX2`) to quote to the office, and
- an **access code shown exactly once**. The server stores only its hash, and
  the middleware expires the cookie that carried it, so refreshing the page
  does not show it again. **Lose it and the anonymous report cannot be looked
  up** — by design.

*(Both codes belong to a demo report in the local database.)*

### 4.4 Checking an anonymous report — `/report/status`

![Checking report status](img/app-05-report-status.png)

Enter the reference code and access code to see the report's status. A wrong
code is audited as `report.lookup_failed`, and each reference code allows five
attempts per fifteen minutes, so secrets cannot be guessed at scale.

### 4.5 Signing in — `/login`

![Sign-in page](img/app-02-login.png)

Seeded accounts follow the pattern `role1@northgate.edu` — `admin1`, `dpo1`,
`officer1`, `investigator1`, `reporter1`. The shared development password is
printed by `npm run seed`. Five wrong attempts lock an account for fifteen
minutes.

After signing in, everyone lands on the front door, which lists what their
role can do — here an officer's Dashboard, Case queue, Campus directory and
Policy library — under the account bar described in §4.16.

![Front door after an officer signs in](img/app-17-after-sign-in.png)

### 4.6 An officer's dashboard — `/dashboard`

![Officer workload dashboard](img/app-07-dashboard-officer.png)

Four headline counts — **assigned to you**, **overdue**, **due in 24 hours**,
**unassigned** — then the median time to first response and cases by status.
Sealed cases are excluded from every figure, just as they are from the queue.

### 4.7 The case queue and triage — `/cases`

![Case queue filtered to triaged cases](img/app-08-cases-queue.png)

The queue is sorted **most urgent first** and filters by status, severity and
assignee (shown here: `status=triaged`). Below it, **untriaged reports** each
carry a small form: title, severity, confidentiality, **Open case**. Opening a
case allocates the next case number, stamps the SLA due date from the severity
*at that moment*, and links the report.

### 4.8 A case in detail — `/cases/[id]`

![Case detail page](img/app-09-case-detail.png)

Everything about one case on one page, top to bottom:

| Section | What you do there |
|---|---|
| **Progress** | Move the case to the next permitted status (only legal moves are offered — a closed case offers `appealed`), with an optional reason; assign or reassign the officer |
| **SLA** | Due date and hours remaining |
| **Linked reports** | Every report feeding this case; the primary one is marked |
| **Parties** | Add a complainant, respondent, witness or advisor — by account, by name, or anonymous |
| **Notes** | Add notes as *Internal only*, *Shared with parties* or *Reporter visible*; remove them |
| **Evidence** | Attach PNG, JPEG, GIF, PDF or plain text up to 10 MB; the type is read from the content, and each file shows its size, scan status and SHA-256 prefix |
| **Outcome** | Record the finding and rationale, and any sanctions against a named party |

### 4.9 The case lifecycle

```
submitted → triaged → under_investigation → pending_decision → resolved → closed
               ↓             ↓                    ↓                         ↓
           dismissed     dismissed            dismissed                 appealed
                                                                            ↓
                                                                 under_investigation
```

`resolved` is not in the status menu. It is reached only by **recording an
outcome**, which writes the finding and the status change together — a case
cannot claim a decision it does not have.

### 4.10 The campus directory — `/directory`

![Campus directory](img/app-10-directory.png)

People, locations and categories from the campus system, searchable and scoped
to your institution. Staff only — a reporter does not get a list of everyone on
campus.

### 4.11 The institution-wide dashboard — `/dashboard` as admin

![Admin dashboard with institution-wide figures](img/app-11-dashboard-admin.png)

Administrators and the DPO see the officer figures **plus**:

- **SLA breach rate** — measured against the due date stored when each case
  opened, so changing policy today does not rewrite history
- **Anonymous share** of intake
- **Intake by week**
- **Officer workload** — open and overdue per officer
- **Outcome mix**
- **Policy acknowledgement coverage** per policy

Every percentage is shown with its denominator ("15.7% (13 of 83 resolved
cases)"), and nothing is shown as 0% when there is nothing to measure.

### 4.12 The audit log — `/audit`

![Audit log](img/app-12-audit-log.png)

Newest first, filterable by entity type and action. Each row shows who (or
`anonymous`), what, and which record. The page says it plainly: rows cannot be
edited or removed, even by an administrator. Failed logins and failed lookups
appear alongside successes.

### 4.13 The policy library — `/policies`

![Policy library](img/app-13-policies.png)

Every policy with the version in force today, plus search over the text **in
force** — drafts and superseded versions are excluded, because a search answers
"what are the rules now".

### 4.14 One policy — `/policies/[id]`

![Policy detail with version history and acknowledgement](img/app-14-policy-detail.png)

Acknowledgement coverage for the version in force, your own acknowledgement
status (or the **Acknowledge** button), the version history with effective
dates, and the full text. Publishing a new version closes the previous one on
the same date, so exactly one version is in force on any day.

### 4.15 What a reporter sees

A signed-in reporter can file attributed reports and read and acknowledge
policies — the policy library looks exactly as in §4.13. After signing in they
land on the front door with **Report an incident**, **Check a report I filed**
and **Policy library**. Staff pages still refuse them, but sign-in no longer
sends them to one (finding 1 in §7, now fixed).

### 4.16 The account bar and signing out

![Account bar with the Sign out button](img/app-18-account-bar.png)

Every page shows this bar while you are signed in: **Campus Compliance** (back
to the front door), **Signed in as …**, and **Sign out**. Anonymous visitors
never see it, so the reporting pages look the same as before.

**Sign out** does more than clear the browser cookie: it revokes the session in
the database, so a copied cookie stops working too. You land on the front door
signed out; any staff page then sends you back to `/login`.

*The other signed-in screenshots in this section were taken before the bar
existed; the pages under it are unchanged.*

---

## 5. Who can do what

| | reporter | officer | investigator | admin | dpo |
|---|:--:|:--:|:--:|:--:|:--:|
| File a report | ● | ● | ● | ● | ● |
| Read and acknowledge policies | ● | ● | ● | ● | ● |
| Case queue | | ● | ● | ● | |
| Case detail | | ● | ● | ● | ● |
| Triage a report into a case | | ● | | ● | |
| Assign a case | | ● | | ● | |
| Move a case through the workflow | | ● | ● | ● | ● |
| Notes and evidence | | ● | ● | ● | ● |
| Record an outcome | | ● | | ● | |
| Campus directory | | ● | ● | ● | ● |
| Dashboard — workload | | ● | ● | ● | ● |
| Dashboard — institution-wide | | | | ● | ● |
| Audit log | | | | ● | ● |
| Open a **sealed** case | | | | | ● |
| Author policies | | | | ● | ● |

A sealed case is refused to **everyone except the data protection officer —
administrators included** — and never appears in any queue, list or count.

---

## 6. Running and checking it

```bash
cd webapp
npm install
cp .env.example .env          # fill AUTH_SECRET and IP_HASH_PEPPER
npx prisma migrate deploy
npx prisma generate
npm run seed                  # institutions, people, accounts, policies
npm run dev                   # http://localhost:3100
```

On Windows, `start-site.bat` at the repository root does all of it and opens the
browser. To fill the database with realistic activity, run the simulator, which
drives the running site over HTTP exactly as a browser would:

```bash
SIMULATION_MODE=1 npm run dev          # terminal 1
SIMULATION_MODE=1 npm run simulate -- --seed 7 --anchor 2026-09-17 --days 90 --reports 250   # terminal 2
```

Checks:

```bash
DATABASE_URL='postgresql://compliance:localdev@localhost:5433/compliance?schema=compliance' npm test   # 258 tests; refuses any non-localhost database
npm run verify    # 32 invariants against whatever the database holds now
npx tsc --noEmit && npm run lint && npm run build
```

---

## 7. What the live run showed

Taking these screenshots exercised the app end to end. It worked throughout —
anonymous filing, the one-time secret, lookup, sign-in for three roles, every
staff page — and surfaced six things worth knowing:

| # | Observation | Evidence | Suggested fix |
|---|---|---|---|
| 1 | ~~**A reporter who signs in lands on "You are not permitted to view the case queue."**~~ **Fixed**: sign-in now goes to the front door, which lists what each role can do. | `webapp/src/app/login/page.tsx:18` (`redirectTo: "/cases"`); screenshot [`app-15-after-login-reporter.png`](img/app-15-after-login-reporter.png) | Redirect by role: staff to `/dashboard`, reporters to `/policies` |
| 2 | ~~**Anonymous submission is not rate-limited**~~ — **fixed**: 30 per hour per connection, keyed on a day-rotated, never-stored hash of the client address | `submitAnonymousReport` in `webapp/src/server/reports.ts` | Done, alongside the AI drafting helper |
| 3 | **The local database contains test-suite rows** — cases titled `DASH-… overdue`, `Clock audit …`; accounts `page-…@`, `login-…@`; policies named `Immutability fixture`. They appear on the queue, admin dashboard and audit log. | 9 of 844 Northgate cases; visible in `app-06`, `app-11`, `app-12` | Point the test suite at its own database |
| 4 | A **closed** case still shows an SLA countdown: "-2143 hours remaining". | `app-09-case-detail.png` | Once resolved, show "met" or "breached by N hours" |
| 5 | Median first response reads **0.0 hours**. | `app-07`, `app-11` | `[UNVERIFIED]` likely a simulator artefact — the first action lands at the instant of opening; worth checking the query |
| 6 | The **Supabase** database the dev server normally uses holds **0 reports** — all activity is in the local database. | `count(*)` on `compliance.reports`: 0 on Supabase, 884 locally | Run the simulator against Supabase if the hosted copy is meant to demo |

---

## 8. Regenerating the images

**ER diagrams** — Mermaid CLI, using an installed Chrome instead of downloading
one:

```bash
echo '{"executablePath":"C:/Program Files/Google/Chrome/Application/chrome.exe"}' > pptr.json
mmdc -p pptr.json -i docs/img/erd-compliance.mmd -o docs/img/erd-compliance.png -w 2600 -s 2 -b white
```

For `erd-campuspulse.png`, copy the `erDiagram` block out of `docs/ERD.md` into a
`.mmd` file and run the same command.

**Screenshots** — Puppeteer against `npm run dev` with `DATABASE_URL` pointed at
the local database, signed in as `officer1`, `admin1` and `reporter1`, at
1366 px wide.

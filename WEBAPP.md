# CampusPulse — the compliance web application

The second half of this repository. The Python project documented in
[`README.md`](README.md) owns the data: the schema, the synthetic generator, the
analytics and the ERD. **This document is about the site** — what it does, who
can do it, and how to run it.

The two halves share one database and divide it cleanly. The Python project owns
the `campuspulse` schema (institutions, people, locations, categories). The web
application owns the `compliance` schema and treats `campuspulse` as read-only —
it reads the campus directory, it never writes to it.

| Where | What it covers |
|---|---|
| [`README.md`](README.md) | Data management, schema design, the ERD, the synthetic engine, analytics |
| **This file** | The web application: features, roles, routes, how to run it |
| [`webapp/README.md`](webapp/README.md) | Engineering detail: architecture rules, invariants, the simulator, known limitations |

---

## 1. What the site is for

A campus compliance office receives reports of misconduct, turns them into
cases, investigates them, and records outcomes — under a clock, with an audit
trail, and without leaking one institution's records to another.

Four things it takes seriously, because each one is a way such systems usually
fail:

- **Anonymous reporting is real, not decorative.** Someone who will not sign in
  can still report, and can come back later to see what happened, using only a
  reference code and a one-time secret. The database refuses to hold an
  "anonymous" report that secretly carries a reporter id.
- **Nothing happens without a record.** Every change writes an audit row in the
  same database transaction. A failed change cannot leave behind a claim that it
  happened, and the audit table refuses `UPDATE` and `DELETE` outright.
- **The workflow cannot be skipped.** A case moves only along paths the state
  machine permits, and a case cannot be marked resolved without a recorded
  finding.
- **Tenants are isolated by the database, not by a query someone remembered to
  write.** No role — not even an administrator — reaches another institution's
  records.

---

## 2. Running it

### Quickest: the launcher

On Windows, with Postgres installed locally:

```bat
start-site.bat
```

It starts Postgres, waits until it genuinely accepts connections, starts the dev
server, waits until the site answers, and opens the browser. Paths at the top of
the file are machine-specific and meant to be edited.

### By hand

```bash
cd webapp
npm install
cp .env.example .env          # then fill AUTH_SECRET and IP_HASH_PEPPER
npx prisma migrate deploy
npx prisma generate
npm run seed
npm run dev                   # http://localhost:3100
```

Where Docker works, `docker compose up -d` replaces the manual Postgres setup.

Two things that bite:

- **Restart the dev server after `prisma generate`.** A running Next process
  holds the old client, and the symptom (`prisma.X is undefined`) looks nothing
  like the cause.
- **Do not run `npm run build` while `npm run dev` is running.** Both use
  `.next/`, and the build leaves the dev server serving unstyled pages.

### Signing in

`npm run seed` creates, for each of three institutions, one admin, one data
protection officer, three officers, four investigators and thirty-one
reporters — and prints the shared development passphrase when it finishes.

| Account | What it can do |
|---|---|
| `admin1@northgate.edu` | Everything except opening a sealed case |
| `dpo1@northgate.edu` | Everything, including sealed cases |
| `officer1@northgate.edu` | Triage, assign, move cases, record outcomes |
| `investigator1@northgate.edu` | Notes and evidence on cases |
| `reporter1@northgate.edu` | File a report, read and acknowledge policies |

Five wrong passwords lock an account for fifteen minutes. That is the intended
behaviour, not a fault.

---

## 3. Features

### Reporting

Anyone can file a report without an account. On submission the reporter is given
a **reference code** and an **access secret shown exactly once** — together they
are the only way back to an anonymous report. A signed-in user can instead file
under their own name and follow the case as its reporter.

Reports carry a title, description, self-assessed severity, and optionally a
category, location and when it happened. Full-text search over title and
description is maintained by the database itself.

### Cases

An officer triages a report into a case. The case gets a per-institution,
per-year number allocated by the database — not by counting rows, which hands
every simultaneous triage the same answer — and an **SLA due date computed from
severity at that moment** (24 hours for severe, 72 for high, 168 for moderate,
336 for low).

From there the case moves through a state machine:

```
submitted → triaged → under_investigation → pending_decision → resolved → closed
                 ↓             ↓                    ↓                        ↓
             dismissed     dismissed            dismissed                appealed
                                                                             ↓
                                                                  under_investigation
```

Each transition names the roles allowed to make it. A case **cannot be moved to
`resolved` directly** — resolving asserts that a decision was reached, so it
happens only by recording an outcome, which writes the finding and the status
together.

Cases carry parties (complainant, respondent, witness, advisor — identified,
named, or genuinely anonymous), investigation notes at three visibility levels,
evidence files, and one outcome with any sanctions attached to it.

### Confidentiality

Every case is `standard`, `restricted` or `sealed`. **A sealed case is refused to
everyone but the data protection officer — including administrators**, and never
appears in any queue, list or dashboard count. A seal an admin can lift is
decorative, and the cases most worth sealing are the ones involving an admin.

### The policy library

Policies are versioned. The policy is the stable identity; what it *says* lives
in its versions.

**A published version is immutable**, enforced by a database trigger rather than
by application code, because "the policy said something different when I signed
it" is precisely the claim the table exists to refute. Only the end date can
change. Superseding writes a new version and closes the previous one on the same
date, so exactly one version is in force on any given day.

**An acknowledgement names a version, never a policy.** Rewrite a policy and
coverage resets to zero — the only honest reading of "has everyone read the
current rules".

Search covers the text in force today; drafts and superseded text are excluded,
because a search result is an answer to "what are the rules".

### Dashboards

**For officers:** cases assigned to you, overdue, due within 24 hours,
unassigned, the median time to first response, and a breakdown by status.

**For administrators and DPOs, additionally:** SLA breach rate, share of reports
filed anonymously, intake per week, workload per officer, the mix of findings,
and policy acknowledgement coverage.

Two deliberate choices:

- **The breach rate reads stored values.** It compares the due date written when
  the case was opened against when it was resolved. Changing the severity policy
  today does not restate whether past cases breached.
- **Every proportion is shown with its denominator,** and nothing is reported as
  0% when there is nothing to report. A bare "68%" invites the wrong conclusion
  when n is 12.

### Campus directory

A read-only view of the campus system: people, locations and categories,
searchable and scoped to your institution. Staff only — a reporter does not get
a searchable list of everyone on campus.

### Audit log

Every recorded action in order, with the account that performed it, what changed,
and when. Administrators and DPOs only.

---

## 4. Who can do what

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
| Open a sealed case | | | | | ● |
| Author policies | | | | ● | ● |

Alongside all of it: **no role reaches another institution's records.** Tenant
isolation is not a permission — it is a boundary underneath them.

---

## 5. Routes

| Route | Who | Purpose |
|---|---|---|
| `/` | anyone | Front door: report, check a report, or sign in |
| `/report` | anyone | File a report, anonymously or attributed |
| `/report/submitted` | anyone | Reference code, and the access secret exactly once |
| `/report/status` | anyone | Check an anonymous report with its code and secret |
| `/login` | anyone | Sign in |
| `/dashboard` | staff | Workload; admins and DPOs also see institution-wide figures |
| `/cases` | officer, investigator, admin | The queue, most urgent first; triage from here |
| `/cases/[id]` | staff | Case detail: status, parties, notes, evidence, outcome |
| `/policies` | signed in | The library, and search over the text in force |
| `/policies/[id]` | signed in | One policy, its history, and the acknowledge button |
| `/directory` | staff | People, locations, categories |
| `/audit` | admin, dpo | The audit log |

---

## 6. Generating realistic activity

The seed builds the world — institutions, people, categories, the starting
policy library. It does **not** create activity.

Activity comes from the simulator, which **drives the running site over HTTP**
rather than writing to the database:

```bash
# terminal 1
SIMULATION_MODE=1 npm run dev

# terminal 2
SIMULATION_MODE=1 npm run simulate -- --seed 7 --anchor 2026-09-17 --days 90 --reports 250
```

It signs in as seeded users and submits the same forms a browser submits. A
script that inserted rows directly could produce a case with no audit trail and
a status no transition allows — plausible-looking and structurally impossible.
Everything the simulator produces arrives through the application, so it carries
the audit rows, history and notifications a real action leaves.

A recorded run from an empty database produced, in 800 seconds: 292 reports (112
anonymous), 285 cases, 555 status changes, 224 notes, 25 evidence files, 45
outcomes, 463 notifications, 72 policy acknowledgements and 1,859 audit events —
including cases dismissed at triage, appealed after closure, and still open at
the end, because a dataset in which every case flows cleanly to closed would
make the dashboards lie.

Simulated timestamps are possible only because of a clock seam that is **gated
twice and refused outright in production**. Full detail, including what keeps it
shut, is in [`webapp/README.md`](webapp/README.md) §11.

---

## 7. Checking that it works

```bash
cd webapp
npm test         # 237 tests across 31 files
npm run verify   # 24 invariant checks against the live database
npm run build
npx tsc --noEmit
npm run lint
```

`npm run verify` is the interesting one. It checks invariants against whatever
the database currently holds rather than against what a test just created — no
anonymous report carries a reporter, every case status appears in its own
history, every transition is one the machine permits, resolved precedes closed,
no published policy version has changed, exactly one version is in force per
policy per day.

It has found real defects on three separate occasions, which is the only
evidence that a verification script is worth anything.

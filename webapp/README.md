# Campus Compliance — web platform (Phase 1)

The case-management half of CampusPulse. The Python project in the repository
root owns the `campuspulse` schema — institutions, people, locations and
categories. This application owns the `compliance` schema and treats
`campuspulse` as read-only.

Phase 1 is the spine: identity, authorisation, an audit trail, anonymous intake
and the officer case queue. Evidence handling, policy management, case parties
and the outcome workflow are Phase 2.

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
append-only triggers, and the generated `search_tsv` column with its GIN index.

Prisma proposes dropping these on **every** generated migration. Two habits keep
them:

1. Read every generated `migration.sql` before applying it and delete any
   statement that removes a hand-written object. The applied migrations record
   which lines were removed and why.
2. `tests/db-invariants.test.ts` asserts each one exists.

This is not hypothetical — `20260916181458_add_reports` dropped
`user_accounts_tenant_fk`, and the tenant boundary was missing until a test
caught it. `20260916190000_restore_tenant_fk` puts it back.

## 5. Running the checks

```bash
npm test         # 147 tests across 22 files
npm run verify   # 17 invariant checks against the live database
npx tsc --noEmit # type check
npm run lint     # eslint
```

`verify` checks invariants against whatever the database currently holds, not
against what a test just created — which is how the Python half of this project
found its real bugs. It has earned that description twice. In Phase 1, dropping
the anonymity constraint and corrupting one row turned a check red and the exit
code to `1`. In Phase 2 it found a live defect on its first run: fourteen
resolved cases with no recorded outcome, because `changeCaseStatus` had allowed
`resolved` as a bare status change. A verification script never seen to fail is
not evidence of anything.

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

## 8. Known limitations

Deliberate boundaries, written down so each is a known limitation rather than an
undiscovered defect. Phase 1's first three entries are gone: sessions are now
revocable, the limiter is shared, and case numbers come from the database.

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
- **`listCases` caps at 200 rows** ordered by SLA date, with no pagination. Past
  200 open cases the queue silently truncates.
- **Attributed reports record the actor's account id as the audit label**, so
  the audit viewer shows a UUID where an anonymous report shows `anonymous`.
  Legible, but an email would read better.
- **`prisma migrate dev` can hang** on this setup while dropping its shadow
  database, holding an advisory lock that blocks the next migration. Use
  `npx prisma migrate dev --create-only` followed by `npx prisma migrate deploy`,
  which needs no shadow database — and which forces the migration to be read
  before it is applied.

## 9. Routes

| Route | Who | Purpose |
| --- | --- | --- |
| `/login` | anyone | Credential sign-in. |
| `/report` | anyone | Submit a report, attributed if signed in, anonymous if not. |
| `/report/submitted` | anyone | Reference code, and the access secret exactly once. |
| `/report/status` | anyone | Check a report with its reference code and access secret. |
| `/cases` | officer, investigator, admin | Case queue, most urgent first; triage and assign from here. |
| `/cases/[id]` | officer, investigator, admin, dpo | Case detail, linked reports, status history, SLA clock. |
| `/evidence/[id]` | officer, investigator, admin, dpo | Authorised download of one evidence file. |
| `/audit` | admin, dpo | The audit log. |

Sealed cases never appear in the queue and are refused to everyone but the data
protection officer — including admins. A seal an admin can lift is decorative,
and the cases most worth sealing are the ones involving an admin.

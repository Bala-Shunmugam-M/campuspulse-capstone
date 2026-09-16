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
npm test         # 59 tests across 12 files
npm run verify   # 8 invariant checks against the live database
npx tsc --noEmit # type check
npm run lint     # eslint
```

`verify` checks invariants against whatever the database currently holds, not
against what a test just created — which is how the Python half of this project
found its real bugs. It has been observed to fail: dropping the anonymity
constraint and corrupting one row makes check 1 report `FAIL` and the process
exit `1`. A verification script never seen to fail is not evidence of anything.

## 6. Known limitations

These are deliberate Phase 1 boundaries, written down so each is a known
limitation rather than an undiscovered defect.

- **Sessions are JWT, not database-backed.** The spec calls for database
  sessions so access can be revoked immediately. Auth.js v5 needs an adapter for
  that and the adapter's tables do not fit the `compliance` schema cleanly.
  Phase 1 ships an 8-hour cap; a signed-out or role-revoked user keeps their
  token until it expires. **Phase 2 replaces this.**
- **The rate limiter is in-memory and therefore per-process.** Correct for a
  single instance, wrong for several: behind a load balancer each instance
  permits the full allowance, so five attempts per code per fifteen minutes
  becomes five per instance. A shared store is needed before scaling out.
- **Case numbers are allocated by counting existing rows**, which races under
  concurrent triage — two officers triaging simultaneously can collide on
  `CASE-YYYY-NNNN`. The unique index catches it and the second caller errors.
  **Phase 2 replaces this with a per institution-and-year sequence.**
- **No evidence upload or malware scanning.** Reports are text only. **Phase 2.**
- **Attributed reports record the actor's account id as the audit label**, so
  the audit viewer shows a UUID where an anonymous report shows `anonymous`.
  Legible, but an email would read better.
- **`prisma migrate dev` can hang** on this setup while dropping its shadow
  database, holding an advisory lock that blocks the next migration. Use
  `npx prisma migrate dev --create-only` followed by `npx prisma migrate deploy`,
  which needs no shadow database — and which forces the migration to be read
  before it is applied.

## 7. Routes

| Route | Who | Purpose |
| --- | --- | --- |
| `/login` | anyone | Credential sign-in. |
| `/report` | anyone | Submit a report, attributed if signed in, anonymous if not. |
| `/report/submitted` | anyone | Reference code, and the access secret exactly once. |
| `/report/status` | anyone | Check a report with its reference code and access secret. |
| `/cases` | officer, investigator, admin | Case queue, most urgent first; triage from here. |
| `/cases/[id]` | officer, investigator, admin, dpo | Case detail, linked reports, status history, SLA clock. |
| `/audit` | admin, dpo | The audit log. |

Sealed cases never appear in the queue and are refused to everyone but the data
protection officer — including admins. A seal an admin can lift is decorative,
and the cases most worth sealing are the ones involving an admin.

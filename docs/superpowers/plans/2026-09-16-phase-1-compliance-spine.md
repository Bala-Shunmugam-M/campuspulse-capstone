# Campus Compliance Platform — Phase 1 (Spine) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the authenticated spine of the compliance platform — accounts, roles, audit logging, incident intake including anonymous reports, and the officer case queue — so that every later feature is added on top of a system that already records who did what.

**Architecture:** A Next.js App Router application in `webapp/` inside the existing CampusPulse repository. Route handlers and server actions validate input and delegate to a service layer in `src/server/`; only that layer touches Prisma. Prisma owns a `compliance` schema and treats the published `campuspulse` schema as read-only, referencing it by foreign key. Every mutation writes an audit row inside the same database transaction.

**Tech Stack:** Next.js 15 (App Router), React 19, TypeScript strict, Tailwind, Prisma (multiSchema), Auth.js v5, Argon2id (`@node-rs/argon2`), Zod, Vitest, Docker Postgres 17.

**Spec:** `docs/superpowers/specs/2026-09-16-campus-compliance-platform-design.md` (commit `71adc60`)

## Global Constraints

- Working directory for all commands is `webapp/` unless a step says otherwise.
- PostgreSQL **17** locally, to match the Supabase instance (17.6).
- Prisma `multiSchema` preview feature; schemas are exactly `compliance` and `campuspulse`.
- The `campuspulse` schema is **read-only**. No migration may `ALTER` or `DROP` anything in it. Prisma models for its tables are annotated `@@schema("campuspulse")` and are never written to.
- TypeScript `strict: true`. No `any` in committed code.
- All secrets via environment variables. `.env.example` is committed; `.env` is git-ignored (the repo's existing `.gitignore` already covers `.env`).
- **Commit messages must NOT include a `Co-Authored-By` trailer.** This repository's commits are attributed to Ruthra alone.
- Every service function in `src/server/` begins with an authorisation call. Task 7 adds a test that enforces this mechanically.
- Argon2id parameters: memory 19456 KiB, iterations 2, parallelism 1 (OWASP minimum).

---

## File Structure

| File | Responsibility |
|---|---|
| `webapp/docker-compose.yml` | Postgres 17 for local development |
| `webapp/prisma/schema.prisma` | Single Prisma schema, both Postgres schemas |
| `webapp/prisma/fixtures/campuspulse_min.sql` | Creates the four referenced `campuspulse` tables locally |
| `webapp/prisma/seed.ts` | Idempotent world fixture: institutions, people, accounts, roles |
| `webapp/src/lib/audit/withAudit.ts` | The audit primitive; the only way to write `audit_events` |
| `webapp/src/lib/auth/config.ts` | Auth.js configuration, Credentials provider |
| `webapp/src/lib/auth/password.ts` | Argon2id hashing, password policy |
| `webapp/src/lib/auth/rbac.ts` | `requireRole`, `requireSameInstitution` |
| `webapp/src/lib/reference/codes.ts` | Reference code + access secret generation |
| `webapp/src/lib/validation/report.ts` | Zod schemas shared by client and server |
| `webapp/src/lib/errors.ts` | Typed domain errors |
| `webapp/src/lib/rateLimit.ts` | Fixed-window limiter for unauthenticated endpoints |
| `webapp/src/server/accounts.ts` | Credential verification, lockout |
| `webapp/src/server/reports.ts` | Report submission, anonymous lookup |
| `webapp/src/server/cases.ts` | Case creation at triage, queue queries |
| `webapp/src/server/audit.ts` | Audit log reads |
| `webapp/src/app/` | Routes: login, report, report status, case queue, case detail, audit log |

---

## Task 1: Scaffold the application and local database

**Files:**
- Create: `webapp/package.json`, `webapp/tsconfig.json`, `webapp/next.config.ts`, `webapp/docker-compose.yml`, `webapp/.env.example`
- Create: `webapp/src/app/layout.tsx`, `webapp/src/app/page.tsx`

**Interfaces:**
- Consumes: nothing.
- Produces: a running Next.js app on `http://localhost:3000` and Postgres 17 on `localhost:5433`, reachable via `DATABASE_URL`.

Port 5433 rather than 5432, deliberately: it avoids colliding with any Postgres the machine already runs, and silently connecting to the wrong database is an expensive mistake to debug.

- [ ] **Step 1: Create the Next.js application**

From the repository root:

```bash
npx create-next-app@latest webapp --typescript --tailwind --app --src-dir --eslint --no-turbopack --import-alias "@/*"
```

- [ ] **Step 2: Add the remaining dependencies**

```bash
cd webapp
npm install prisma @prisma/client next-auth@beta @node-rs/argon2 zod
npm install -D vitest @vitest/coverage-v8 tsx
```

- [ ] **Step 3: Write the Docker Compose file**

Create `webapp/docker-compose.yml`:

```yaml
services:
  db:
    image: postgres:17-alpine
    container_name: compliance-db
    environment:
      POSTGRES_USER: compliance
      POSTGRES_PASSWORD: localdev
      POSTGRES_DB: compliance
    ports:
      - "5433:5432"
    volumes:
      - compliance-pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U compliance -d compliance"]
      interval: 5s
      timeout: 5s
      retries: 10

volumes:
  compliance-pgdata:
```

- [ ] **Step 4: Write `.env.example` and `.env`**

Create `webapp/.env.example`:

```bash
# Local development database (docker compose up -d)
DATABASE_URL="postgresql://compliance:localdev@localhost:5433/compliance?schema=compliance"

# Auth.js — generate with: npx auth secret
AUTH_SECRET="replace-me"
AUTH_URL="http://localhost:3000"

# Server-side pepper for hashing reporter IP addresses. Rotating this breaks
# the ability to correlate historical reports; do not rotate casually.
IP_HASH_PEPPER="replace-me"
```

Copy it to `webapp/.env` and fill in real values. `npx auth secret` writes `AUTH_SECRET`; generate the pepper with `openssl rand -base64 32`.

- [ ] **Step 5: Start the database and verify it is healthy**

Run: `docker compose up -d && docker compose ps`
Expected: `compliance-db` is listed as `healthy`.

- [ ] **Step 6: Verify the app boots**

Run: `npm run dev`
Expected: Next.js serves `http://localhost:3000` with no compile errors. Stop with Ctrl-C.

- [ ] **Step 7: Commit**

```bash
git add webapp
git commit -m "Scaffold the compliance web application

Next.js App Router with TypeScript and Tailwind, plus a Postgres 17 container
matching the Supabase server version. The container publishes 5433 rather than
5432 so it cannot be confused with an existing local Postgres -- connecting to
the wrong database silently is a bad afternoon."
```

---

## Task 2: Prisma with two schemas, and the campuspulse fixture

**Files:**
- Create: `webapp/prisma/schema.prisma`, `webapp/prisma/fixtures/campuspulse_min.sql`, `webapp/src/lib/db.ts`

**Interfaces:**
- Consumes: `DATABASE_URL` from Task 1.
- Produces: `prisma` — a singleton `PrismaClient` exported from `@/lib/db`; read-only models `Institution` and `CampusUser` mapped onto `campuspulse`.

- [ ] **Step 1: Write the campuspulse fixture**

Create `webapp/prisma/fixtures/campuspulse_min.sql`. This reproduces only the tables the compliance schema references, with the column types and constraints the published schema uses. On Supabase these already exist and this file is not run.

```sql
CREATE SCHEMA IF NOT EXISTS campuspulse;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

DO $$ BEGIN
  CREATE TYPE campuspulse.user_role AS ENUM ('student','faculty','admin','technician');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE campuspulse.location_type AS ENUM ('campus','building','floor','room','area');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE campuspulse.category_type AS ENUM ('issue_category','asset_category');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS campuspulse.institutions (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name       text NOT NULL,
    code       text NOT NULL UNIQUE,
    domain     text NOT NULL,
    city       text,
    timezone   text NOT NULL DEFAULT 'Asia/Kolkata',
    is_active  boolean NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS campuspulse.users (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id uuid NOT NULL REFERENCES campuspulse.institutions(id) ON DELETE CASCADE,
    full_name      text NOT NULL,
    email          text NOT NULL,
    phone          text,
    role           campuspulse.user_role NOT NULL DEFAULT 'student',
    department     text,
    is_active      boolean NOT NULL DEFAULT true,
    created_at     timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT users_email_unique_per_tenant UNIQUE (institution_id, email),
    CONSTRAINT users_tenant_key              UNIQUE (id, institution_id)
);

CREATE TABLE IF NOT EXISTS campuspulse.locations (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id uuid NOT NULL REFERENCES campuspulse.institutions(id) ON DELETE CASCADE,
    parent_id      uuid REFERENCES campuspulse.locations(id) ON DELETE CASCADE,
    name           text NOT NULL,
    location_type  campuspulse.location_type NOT NULL,
    code           text,
    created_at     timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT locations_tenant_key UNIQUE (id, institution_id)
);

CREATE TABLE IF NOT EXISTS campuspulse.categories (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id uuid NOT NULL REFERENCES campuspulse.institutions(id) ON DELETE CASCADE,
    parent_id      uuid REFERENCES campuspulse.categories(id) ON DELETE CASCADE,
    name           text NOT NULL,
    category_type  campuspulse.category_type NOT NULL,
    sla_hours      integer,
    created_at     timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT categories_tenant_key UNIQUE (id, institution_id)
);
```

`users_tenant_key UNIQUE (id, institution_id)` looks redundant beside the primary key. It is not: it is the target of the composite foreign keys that make cross-tenant references structurally impossible, and the published schema defines it for exactly that reason.

- [ ] **Step 2: Apply the fixture and confirm it is idempotent**

```bash
docker compose exec -T db psql -U compliance -d compliance < prisma/fixtures/campuspulse_min.sql
docker compose exec -T db psql -U compliance -d compliance < prisma/fixtures/campuspulse_min.sql
```
Expected: both runs succeed. The second proves the guards work, so re-running setup does not punish a developer.

- [ ] **Step 3: Write the Prisma schema**

Create `webapp/prisma/schema.prisma`:

```prisma
generator client {
  provider        = "prisma-client-js"
  previewFeatures = ["multiSchema"]
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
  schemas  = ["compliance", "campuspulse"]
}

/// Read-only. Owned by the Python data project; never written to from here.
model Institution {
  id        String   @id @default(uuid()) @db.Uuid
  name      String
  code      String   @unique
  domain    String
  city      String?
  timezone  String
  isActive  Boolean  @map("is_active")
  createdAt DateTime @map("created_at")

  users     CampusUser[]

  @@map("institutions")
  @@schema("campuspulse")
}

/// Read-only. The campus directory; accounts attach to these rows.
model CampusUser {
  id            String   @id @default(uuid()) @db.Uuid
  institutionId String   @map("institution_id") @db.Uuid
  fullName      String   @map("full_name")
  email         String
  phone         String?
  department    String?
  isActive      Boolean  @map("is_active")
  createdAt     DateTime @map("created_at")

  institution   Institution  @relation(fields: [institutionId], references: [id])
  account       UserAccount?

  @@unique([id, institutionId], map: "users_tenant_key")
  @@map("users")
  @@schema("campuspulse")
}
```

The `role` column is deliberately absent from `CampusUser`: it is a `campuspulse.user_role` enum this application has no business reading or writing, and omitting it puts the read-only boundary in the model rather than only in a comment.

- [ ] **Step 4: Create the Prisma client singleton**

Create `webapp/src/lib/db.ts`:

```ts
import { PrismaClient } from "@prisma/client";

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
  });

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;
```

The singleton exists because Next.js hot-reloading otherwise opens a new pool on every edit until Postgres refuses connections.

- [ ] **Step 5: Generate the client and verify it reads the fixture**

```bash
npx prisma generate
npx tsx -e "import {prisma} from './src/lib/db'; prisma.institution.count().then(n => { console.log('institutions:', n); process.exit(0); })"
```
Expected: prints `institutions: 0` without error. Zero is correct — the fixture creates tables, not rows.

- [ ] **Step 6: Commit**

```bash
git add webapp/prisma webapp/src/lib/db.ts
git commit -m "Add Prisma with a read-only view of the campuspulse schema

Prisma owns the compliance schema only. The campuspulse tables the compliance
layer references are mapped read-only, and a fixture recreates them locally so
foreign keys resolve offline -- on Supabase they already exist with 42,763 rows
behind them.

CampusUser deliberately omits the role column. It is a campuspulse enum this
application has no business touching, and leaving it out makes the read-only
boundary visible in the model rather than only in a comment."
```

---

## Task 3: The audit primitive

This task comes before any feature that writes data, because an audit trail added afterwards has a hole in it exactly the size of everything built first.

**Files:**
- Modify: `webapp/prisma/schema.prisma`
- Create: migration (generated, then hand-edited), `webapp/src/lib/audit/withAudit.ts`, `webapp/prisma/seed.ts`
- Test: `webapp/tests/audit.test.ts`

**Interfaces:**
- Consumes: `prisma` from Task 2.
- Produces:
  - `type AuditContext = { actorAccountId: string | null; actorLabel: string; institutionId: string; requestId: string; ipHash: string | null; userAgent: string | null }`
  - `type AuditEventInput = { action: string; entityType: string; entityId: string; before?: unknown; after?: unknown }`
  - `withAudit(tx: Prisma.TransactionClient, ctx: AuditContext, event: AuditEventInput): Promise<void>`

- [ ] **Step 1: Add the model**

Append to `webapp/prisma/schema.prisma`:

```prisma
model AuditEvent {
  id                  BigInt   @id @default(autoincrement())
  institutionId       String   @map("institution_id") @db.Uuid
  actorUserAccountId  String?  @map("actor_user_account_id") @db.Uuid
  actorLabel          String   @map("actor_label")
  action              String
  entityType          String   @map("entity_type")
  entityId            String   @map("entity_id") @db.Uuid
  before              Json?
  after               Json?
  requestId           String   @map("request_id") @db.Uuid
  ipHash              String?  @map("ip_hash")
  userAgent           String?  @map("user_agent")
  occurredAt          DateTime @default(now()) @map("occurred_at")

  @@index([entityType, entityId, occurredAt(sort: Desc)])
  @@index([institutionId, occurredAt(sort: Desc)])
  @@map("audit_events")
  @@schema("compliance")
}
```

There is no `updatedAt` and no `deletedAt`. That is the point.

- [ ] **Step 2: Generate the migration without applying it**

Run: `npx prisma migrate dev --name add_audit_events --create-only`
Expected: a migration directory containing `migration.sql`.

- [ ] **Step 3: Add the append-only trigger to the migration**

Append to the generated `migration.sql`:

```sql
CREATE OR REPLACE FUNCTION compliance.audit_events_immutable()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_events is append-only (attempted %)', TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE TRIGGER audit_events_no_update
  BEFORE UPDATE ON compliance.audit_events
  FOR EACH ROW EXECUTE FUNCTION compliance.audit_events_immutable();

CREATE TRIGGER audit_events_no_delete
  BEFORE DELETE ON compliance.audit_events
  FOR EACH ROW EXECUTE FUNCTION compliance.audit_events_immutable();
```

A trigger rather than a `REVOKE`, because in development the application connects as the schema owner and an owner can grant privileges back to itself. A trigger binds regardless of role.

- [ ] **Step 4: Apply the migration**

Run: `npx prisma migrate dev`
Expected: applies cleanly; `npx prisma migrate status` reports nothing pending.

- [ ] **Step 5: Add a minimal seed so tests have an institution**

Create `webapp/prisma/seed.ts` (Task 8 expands it):

```ts
import { prisma } from "../src/lib/db";

async function main() {
  await prisma.$executeRaw`
    INSERT INTO campuspulse.institutions (name, code, domain, city, timezone, is_active)
    VALUES ('Northgate University', 'NGU', 'northgate.edu', 'Chennai', 'Asia/Kolkata', true)
    ON CONFLICT (code) DO NOTHING`;
  console.log(`institutions: ${await prisma.institution.count()}`);
}

main().finally(() => prisma.$disconnect());
```

Add to `webapp/package.json` scripts: `"seed": "tsx prisma/seed.ts"` and `"test": "vitest run"`.

- [ ] **Step 6: Write the failing test**

Create `webapp/tests/audit.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { prisma } from "../src/lib/db";
import { withAudit, type AuditContext } from "../src/lib/audit/withAudit";

const ctx = (institutionId: string): AuditContext => ({
  actorAccountId: null,
  actorLabel: "test",
  institutionId,
  requestId: randomUUID(),
  ipHash: null,
  userAgent: null,
});

async function anInstitution(): Promise<string> {
  const row = await prisma.institution.findFirst();
  if (!row) throw new Error("run `npm run seed` first");
  return row.id;
}

describe("withAudit", () => {
  it("writes an audit row inside the caller's transaction", async () => {
    const institutionId = await anInstitution();
    const entityId = randomUUID();

    await prisma.$transaction(async (tx) => {
      await withAudit(tx, ctx(institutionId), {
        action: "test.performed",
        entityType: "test",
        entityId,
      });
    });

    const found = await prisma.auditEvent.findFirst({ where: { entityId } });
    expect(found?.action).toBe("test.performed");
  });

  it("discards the audit row when the transaction rolls back", async () => {
    const institutionId = await anInstitution();
    const entityId = randomUUID();

    await expect(
      prisma.$transaction(async (tx) => {
        await withAudit(tx, ctx(institutionId), {
          action: "test.performed",
          entityType: "test",
          entityId,
        });
        throw new Error("deliberate rollback");
      }),
    ).rejects.toThrow("deliberate rollback");

    const found = await prisma.auditEvent.findFirst({ where: { entityId } });
    expect(found).toBeNull();
  });

  it("refuses updates and deletes", async () => {
    const institutionId = await anInstitution();
    const entityId = randomUUID();

    await prisma.$transaction((tx) =>
      withAudit(tx, ctx(institutionId), {
        action: "test.performed",
        entityType: "test",
        entityId,
      }),
    );

    await expect(
      prisma.$executeRaw`UPDATE compliance.audit_events SET action = 'tampered' WHERE entity_id = ${entityId}::uuid`,
    ).rejects.toThrow(/append-only/);

    await expect(
      prisma.$executeRaw`DELETE FROM compliance.audit_events WHERE entity_id = ${entityId}::uuid`,
    ).rejects.toThrow(/append-only/);
  });
});
```

The rollback test is the one that matters. It is the difference between an audit trail and a log that happens to usually agree with the data.

- [ ] **Step 7: Run the test to verify it fails**

Run: `npm run seed && npx vitest run tests/audit.test.ts`
Expected: FAIL — `Cannot find module '../src/lib/audit/withAudit'`.

- [ ] **Step 8: Implement `withAudit`**

Create `webapp/src/lib/audit/withAudit.ts`:

```ts
import type { Prisma } from "@prisma/client";

export type AuditContext = {
  actorAccountId: string | null;
  /** Human-readable actor when there is no account: "anonymous", "system:simulator". */
  actorLabel: string;
  institutionId: string;
  requestId: string;
  ipHash: string | null;
  userAgent: string | null;
};

export type AuditEventInput = {
  /** Dotted verb phrase: "case.status_changed", "report.submitted". */
  action: string;
  entityType: string;
  entityId: string;
  before?: unknown;
  after?: unknown;
};

/**
 * Record an audit event. Must be called with the SAME transaction client as the
 * mutation it describes, so a failed mutation cannot leave a claim that it
 * happened.
 */
export async function withAudit(
  tx: Prisma.TransactionClient,
  ctx: AuditContext,
  event: AuditEventInput,
): Promise<void> {
  await tx.auditEvent.create({
    data: {
      institutionId: ctx.institutionId,
      actorUserAccountId: ctx.actorAccountId,
      actorLabel: ctx.actorLabel,
      action: event.action,
      entityType: event.entityType,
      entityId: event.entityId,
      before: (event.before ?? null) as Prisma.InputJsonValue,
      after: (event.after ?? null) as Prisma.InputJsonValue,
      requestId: ctx.requestId,
      ipHash: ctx.ipHash,
      userAgent: ctx.userAgent,
    },
  });
}
```

- [ ] **Step 9: Run the tests to verify they pass**

Run: `npx vitest run tests/audit.test.ts`
Expected: 3 passed.

- [ ] **Step 10: Commit**

```bash
git add webapp
git commit -m "Add the audit primitive before anything that writes data

withAudit takes the caller's transaction client rather than opening its own, so
a mutation and its audit row commit or roll back together. The second test is
the one that matters: it rolls the transaction back and asserts the audit row
went with it. Without that property the table is a log that usually agrees with
the data, which is worse than none because it is trusted.

Immutability is enforced by trigger rather than by revoking UPDATE and DELETE,
because in development the application connects as the schema owner and an owner
can grant privileges back to itself. A trigger binds regardless of role."
```

---

## Task 4: Password hashing and typed errors

**Files:**
- Create: `webapp/src/lib/auth/password.ts`, `webapp/src/lib/errors.ts`
- Test: `webapp/tests/password.test.ts`

**Interfaces:**
- Produces:
  - `hashPassword(plain: string): Promise<string>`
  - `verifyPassword(storedHash: string, plain: string): Promise<boolean>`
  - `assertPasswordAcceptable(plain: string): void` — throws `WeakPasswordError`
  - Errors: `DomainError`, `ForbiddenError`, `NotFoundError`, `WeakPasswordError`, `AccountLockedError`, `InvalidCredentialsError`, `InvalidTransitionError`, `RateLimitedError`

- [ ] **Step 1: Write the failing test**

Create `webapp/tests/password.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  assertPasswordAcceptable,
  hashPassword,
  verifyPassword,
} from "../src/lib/auth/password";

describe("password hashing", () => {
  it("verifies a correct password", async () => {
    const hash = await hashPassword("correct horse battery staple");
    expect(await verifyPassword(hash, "correct horse battery staple")).toBe(true);
  });

  it("rejects an incorrect password", async () => {
    const hash = await hashPassword("correct horse battery staple");
    expect(await verifyPassword(hash, "Correct horse battery staple")).toBe(false);
  });

  it("produces a different hash for the same password", async () => {
    const a = await hashPassword("correct horse battery staple");
    const b = await hashPassword("correct horse battery staple");
    expect(a).not.toBe(b);
  });

  it("returns false rather than throwing on a malformed hash", async () => {
    expect(await verifyPassword("not-a-hash", "anything")).toBe(false);
  });
});

describe("password policy", () => {
  it("accepts a long passphrase", () => {
    expect(() => assertPasswordAcceptable("correct horse battery staple")).not.toThrow();
  });

  it("rejects anything under 12 characters", () => {
    expect(() => assertPasswordAcceptable("Sh0rt!")).toThrow(/12 characters/);
  });

  it("rejects a common password even when long enough", () => {
    expect(() => assertPasswordAcceptable("password1234")).toThrow(/too common/);
  });
});
```

The distinct-hash test proves salting. The malformed-hash test matters because a corrupt stored hash must read as "wrong password", not as a 500 that reveals the account exists.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/password.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Create the errors module**

Create `webapp/src/lib/errors.ts`:

```ts
export class DomainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class ForbiddenError extends DomainError {}
export class NotFoundError extends DomainError {}
export class WeakPasswordError extends DomainError {}
export class AccountLockedError extends DomainError {}
export class InvalidCredentialsError extends DomainError {}
export class InvalidTransitionError extends DomainError {}
export class RateLimitedError extends DomainError {}
```

- [ ] **Step 4: Implement password handling**

Create `webapp/src/lib/auth/password.ts`:

```ts
import { hash, verify } from "@node-rs/argon2";
import { WeakPasswordError } from "@/lib/errors";

// OWASP minimum for Argon2id.
const ARGON = { memoryCost: 19456, timeCost: 2, parallelism: 1 } as const;

const MIN_LENGTH = 12;

/** Deliberately short. A full breach corpus is not shippable; this catches the obvious. */
const COMMON = new Set([
  "password1234",
  "123456789012",
  "qwertyuiop12",
  "administrator",
  "letmein12345",
  "welcome12345",
  "campuspulse1",
]);

export function assertPasswordAcceptable(plain: string): void {
  if (plain.length < MIN_LENGTH) {
    throw new WeakPasswordError(`Password must be at least ${MIN_LENGTH} characters.`);
  }
  if (COMMON.has(plain.toLowerCase())) {
    throw new WeakPasswordError("That password is too common. Choose another.");
  }
}

export function hashPassword(plain: string): Promise<string> {
  return hash(plain, ARGON);
}

export async function verifyPassword(storedHash: string, plain: string): Promise<boolean> {
  try {
    return await verify(storedHash, plain, ARGON);
  } catch {
    // A malformed or truncated hash must read as a failed login, never as a crash.
    return false;
  }
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run tests/password.test.ts`
Expected: 7 passed.

- [ ] **Step 6: Commit**

```bash
git add webapp/src/lib/auth/password.ts webapp/src/lib/errors.ts webapp/tests/password.test.ts
git commit -m "Add Argon2id password hashing and policy

verifyPassword returns false on a malformed hash rather than throwing. A corrupt
stored hash must read as a failed login: throwing turns it into a 500 that tells
an attacker the account exists and the ordinary wrong-password path does not."
```

---

## Task 5: Accounts and roles in the schema

**Files:**
- Modify: `webapp/prisma/schema.prisma`
- Create: migration
- Test: `webapp/tests/accounts-schema.test.ts`

**Interfaces:**
- Produces: models `UserAccount`, `RoleAssignment`; enum `ComplianceRole`.

- [ ] **Step 1: Add the models**

Append to `webapp/prisma/schema.prisma`:

```prisma
enum ComplianceRole {
  reporter
  officer
  investigator
  admin
  dpo

  @@map("compliance_role")
  @@schema("compliance")
}

model UserAccount {
  id                  String    @id @default(uuid()) @db.Uuid
  userId              String    @unique @map("user_id") @db.Uuid
  institutionId       String    @map("institution_id") @db.Uuid
  email               String
  passwordHash        String    @map("password_hash")
  passwordChangedAt   DateTime? @map("password_changed_at")
  failedLoginCount    Int       @default(0) @map("failed_login_count")
  lockedUntil         DateTime? @map("locked_until")
  lastLoginAt         DateTime? @map("last_login_at")
  mustChangePassword  Boolean   @default(false) @map("must_change_password")
  createdAt           DateTime  @default(now()) @map("created_at")
  updatedAt           DateTime  @updatedAt @map("updated_at")
  deletedAt           DateTime? @map("deleted_at")

  campusUser          CampusUser       @relation(fields: [userId], references: [id])
  roles               RoleAssignment[] @relation("AccountRoles")
  grantedRoles        RoleAssignment[] @relation("RoleGrantor")

  @@unique([institutionId, email])
  @@map("user_accounts")
  @@schema("compliance")
}

model RoleAssignment {
  id               String         @id @default(uuid()) @db.Uuid
  userAccountId    String         @map("user_account_id") @db.Uuid
  role             ComplianceRole
  scopeDepartment  String?        @map("scope_department")
  grantedById      String?        @map("granted_by") @db.Uuid
  grantedAt        DateTime       @default(now()) @map("granted_at")
  revokedAt        DateTime?      @map("revoked_at")

  account          UserAccount    @relation("AccountRoles", fields: [userAccountId], references: [id], onDelete: Cascade)
  grantedBy        UserAccount?   @relation("RoleGrantor", fields: [grantedById], references: [id])

  @@index([userAccountId, revokedAt])
  @@map("role_assignments")
  @@schema("compliance")
}
```

- [ ] **Step 2: Generate the migration without applying it**

Run: `npx prisma migrate dev --name add_accounts_and_roles --create-only`

- [ ] **Step 3: Add the constraints Prisma cannot express**

Append to the generated `migration.sql`:

```sql
-- Tenant safety: an account cannot reference a user from another institution.
ALTER TABLE compliance.user_accounts
  ADD CONSTRAINT user_accounts_tenant_fk
  FOREIGN KEY (user_id, institution_id)
  REFERENCES campuspulse.users (id, institution_id);

-- A role may be granted, revoked, and granted again; only the live grant is unique.
CREATE UNIQUE INDEX role_assignments_live_unique
  ON compliance.role_assignments (user_account_id, role, COALESCE(scope_department, ''))
  WHERE revoked_at IS NULL;
```

`COALESCE(scope_department, '')` because NULLs do not compare equal in a unique index; without it a user could hold two live institution-wide grants of the same role.

- [ ] **Step 4: Apply the migration**

Run: `npx prisma migrate dev`

- [ ] **Step 5: Write the test**

Create `webapp/tests/accounts-schema.test.ts`:

```ts
import { beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { prisma } from "../src/lib/db";

let institutionA: string;
let institutionB: string;
let userInB: string;

async function aUserIn(institutionId: string, name: string): Promise<string> {
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    INSERT INTO campuspulse.users (institution_id, full_name, email, is_active)
    VALUES (${institutionId}::uuid, ${name}, ${`${name}-${randomUUID()}@tenantb.edu`}, true)
    RETURNING id`;
  return rows[0].id;
}

beforeAll(async () => {
  const a = await prisma.institution.findFirstOrThrow();
  institutionA = a.id;
  const b = await prisma.$queryRaw<{ id: string }[]>`
    INSERT INTO campuspulse.institutions (name, code, domain, timezone, is_active)
    VALUES ('Tenant B', ${`TB${Math.floor(Math.random() * 9000 + 1000)}`}, 'tenantb.edu', 'Asia/Kolkata', true)
    RETURNING id`;
  institutionB = b[0].id;
  userInB = await aUserIn(institutionB, "PersonInB");
});

describe("user_accounts tenant safety", () => {
  it("refuses an account whose user belongs to another institution", async () => {
    await expect(
      prisma.userAccount.create({
        data: {
          userId: userInB,
          institutionId: institutionA, // mismatch, on purpose
          email: "mismatch@example.edu",
          passwordHash: "x",
        },
      }),
    ).rejects.toThrow(/user_accounts_tenant_fk/);
  });
});

describe("role_assignments live uniqueness", () => {
  it("allows re-granting a role after revocation", async () => {
    const account = await prisma.userAccount.create({
      data: {
        userId: await aUserIn(institutionB, "Regrant"),
        institutionId: institutionB,
        email: `r-${randomUUID()}@tenantb.edu`,
        passwordHash: "x",
      },
    });

    const first = await prisma.roleAssignment.create({
      data: { userAccountId: account.id, role: "officer" },
    });
    await prisma.roleAssignment.update({
      where: { id: first.id },
      data: { revokedAt: new Date() },
    });

    await expect(
      prisma.roleAssignment.create({ data: { userAccountId: account.id, role: "officer" } }),
    ).resolves.toBeDefined();
  });

  it("refuses two live grants of the same role", async () => {
    const account = await prisma.userAccount.create({
      data: {
        userId: await aUserIn(institutionB, "Dup"),
        institutionId: institutionB,
        email: `d-${randomUUID()}@tenantb.edu`,
        passwordHash: "x",
      },
    });

    await prisma.roleAssignment.create({ data: { userAccountId: account.id, role: "officer" } });
    await expect(
      prisma.roleAssignment.create({ data: { userAccountId: account.id, role: "officer" } }),
    ).rejects.toThrow(/role_assignments_live_unique/);
  });
});
```

- [ ] **Step 6: Run the tests**

Run: `npx vitest run tests/accounts-schema.test.ts`
Expected: 3 passed. If the tenant test passes trivially, the composite FK did not apply — check the migration ran.

- [ ] **Step 7: Commit**

```bash
git add webapp
git commit -m "Add user accounts and role assignments

Accounts attach to existing campuspulse.users rows rather than inventing people.
A composite foreign key on (user_id, institution_id) makes a cross-tenant account
structurally impossible rather than merely unlikely.

Roles are granted rather than attributes, and revocation is soft so the history
survives. The live-grant unique index coalesces scope_department to '' because
NULLs do not compare equal in a unique index -- without that, a user could hold
two simultaneous institution-wide grants of the same role."
```

---

## Task 6: Authentication

**Files:**
- Create: `webapp/src/server/accounts.ts`, `webapp/src/lib/auth/config.ts`, `webapp/src/app/api/auth/[...nextauth]/route.ts`, `webapp/src/types/next-auth.d.ts`, `webapp/src/app/login/page.tsx`
- Test: `webapp/tests/login.test.ts`

**Interfaces:**
- Consumes: `verifyPassword` (Task 4), `withAudit` (Task 3).
- Produces:
  - `type RequestMeta = { requestId: string; ipHash: string | null; userAgent: string | null }`
  - `type AuthenticatedAccount = { accountId: string; institutionId: string; email: string; roles: ComplianceRole[] }`
  - `authenticate(email: string, plain: string, meta: RequestMeta): Promise<AuthenticatedAccount>`
  - `newRequestMeta(headers: Headers): RequestMeta`

- [ ] **Step 1: Write the failing test**

Create `webapp/tests/login.test.ts`:

```ts
import { beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { prisma } from "../src/lib/db";
import { hashPassword } from "../src/lib/auth/password";
import { authenticate } from "../src/server/accounts";

const meta = () => ({ requestId: randomUUID(), ipHash: null, userAgent: "vitest" });
const PASSWORD = "correct horse battery staple";
let email: string;

async function anAccount(address: string): Promise<string> {
  const inst = await prisma.institution.findFirstOrThrow();
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    INSERT INTO campuspulse.users (institution_id, full_name, email, is_active)
    VALUES (${inst.id}::uuid, 'Login Test', ${address}, true) RETURNING id`;
  const account = await prisma.userAccount.create({
    data: {
      userId: rows[0].id,
      institutionId: inst.id,
      email: address,
      passwordHash: await hashPassword(PASSWORD),
    },
  });
  return account.id;
}

beforeAll(async () => {
  email = `login-${randomUUID()}@northgate.edu`;
  const accountId = await anAccount(email);
  await prisma.roleAssignment.create({ data: { userAccountId: accountId, role: "officer" } });
});

describe("authenticate", () => {
  it("returns the account and its live roles", async () => {
    const result = await authenticate(email, PASSWORD, meta());
    expect(result.email).toBe(email);
    expect(result.roles).toContain("officer");
  });

  it("writes an audit event on success", async () => {
    const before = await prisma.auditEvent.count({ where: { action: "auth.login_succeeded" } });
    await authenticate(email, PASSWORD, meta());
    const after = await prisma.auditEvent.count({ where: { action: "auth.login_succeeded" } });
    expect(after).toBe(before + 1);
  });

  it("rejects a wrong password and audits the failure", async () => {
    const before = await prisma.auditEvent.count({ where: { action: "auth.login_failed" } });
    await expect(authenticate(email, "wrong password here", meta())).rejects.toThrow(
      /Invalid email or password/,
    );
    const after = await prisma.auditEvent.count({ where: { action: "auth.login_failed" } });
    expect(after).toBe(before + 1);
  });

  it("gives the same error for an unknown account as for a wrong password", async () => {
    await expect(
      authenticate(`nobody-${randomUUID()}@northgate.edu`, PASSWORD, meta()),
    ).rejects.toThrow(/Invalid email or password/);
  });

  it("locks the account after five consecutive failures", async () => {
    const lockEmail = `lock-${randomUUID()}@northgate.edu`;
    await anAccount(lockEmail);

    for (let i = 0; i < 5; i++) {
      await expect(authenticate(lockEmail, "wrong password here", meta())).rejects.toThrow();
    }
    // Correct password now, but the account is locked.
    await expect(authenticate(lockEmail, PASSWORD, meta())).rejects.toThrow(/locked/i);
  });
});
```

The identical-error test is the important one: distinguishing "no such account" from "wrong password" turns the login form into an account enumeration oracle.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/login.test.ts`
Expected: FAIL — cannot find `../src/server/accounts`.

- [ ] **Step 3: Implement the service**

Create `webapp/src/server/accounts.ts`:

```ts
import { randomUUID } from "node:crypto";
import type { ComplianceRole } from "@prisma/client";
import { prisma } from "@/lib/db";
import { withAudit } from "@/lib/audit/withAudit";
import { hashPassword, verifyPassword } from "@/lib/auth/password";
import { AccountLockedError, InvalidCredentialsError } from "@/lib/errors";

export type RequestMeta = {
  requestId: string;
  ipHash: string | null;
  userAgent: string | null;
};

export type AuthenticatedAccount = {
  accountId: string;
  institutionId: string;
  email: string;
  roles: ComplianceRole[];
};

const MAX_FAILURES = 5;
const LOCK_MINUTES = 15;

/**
 * A valid Argon2id hash of a value no user will supply. Computed once at module
 * load so the unknown-account path costs the same as a real verification.
 */
const dummyHash = hashPassword(randomUUID());

/**
 * Verify credentials. Authentication is the one service that cannot begin with
 * an authorisation check -- it produces the identity everything else authorises
 * against.
 */
export async function authenticate(
  email: string,
  plain: string,
  meta: RequestMeta,
): Promise<AuthenticatedAccount> {
  const account = await prisma.userAccount.findFirst({
    where: { email: email.toLowerCase(), deletedAt: null },
    include: { roles: { where: { revokedAt: null } } },
  });

  if (!account) {
    // Hash anyway: a missing account must not be detectably faster than a wrong
    // password. Timing is an enumeration oracle too.
    await verifyPassword(await dummyHash, plain);
    throw new InvalidCredentialsError("Invalid email or password.");
  }

  if (account.lockedUntil && account.lockedUntil > new Date()) {
    throw new AccountLockedError(
      `This account is locked until ${account.lockedUntil.toISOString()}.`,
    );
  }

  const ctx = {
    actorAccountId: account.id,
    actorLabel: account.email,
    institutionId: account.institutionId,
    requestId: meta.requestId,
    ipHash: meta.ipHash,
    userAgent: meta.userAgent,
  };

  if (!(await verifyPassword(account.passwordHash, plain))) {
    const failures = account.failedLoginCount + 1;
    await prisma.$transaction(async (tx) => {
      await tx.userAccount.update({
        where: { id: account.id },
        data: {
          failedLoginCount: failures,
          lockedUntil:
            failures >= MAX_FAILURES
              ? new Date(Date.now() + LOCK_MINUTES * 60_000)
              : account.lockedUntil,
        },
      });
      await withAudit(tx, ctx, {
        action: "auth.login_failed",
        entityType: "user_account",
        entityId: account.id,
        after: { failedLoginCount: failures, locked: failures >= MAX_FAILURES },
      });
    });
    throw new InvalidCredentialsError("Invalid email or password.");
  }

  await prisma.$transaction(async (tx) => {
    await tx.userAccount.update({
      where: { id: account.id },
      data: { failedLoginCount: 0, lockedUntil: null, lastLoginAt: new Date() },
    });
    await withAudit(tx, ctx, {
      action: "auth.login_succeeded",
      entityType: "user_account",
      entityId: account.id,
    });
  });

  return {
    accountId: account.id,
    institutionId: account.institutionId,
    email: account.email,
    roles: account.roles.map((r) => r.role),
  };
}

export function newRequestMeta(headers: Headers): RequestMeta {
  return {
    requestId: randomUUID(),
    ipHash: null,
    userAgent: headers.get("user-agent"),
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/login.test.ts`
Expected: 5 passed.

- [ ] **Step 5: Wire Auth.js**

Create `webapp/src/lib/auth/config.ts`:

```ts
import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import { randomUUID } from "node:crypto";
import { authenticate } from "@/server/accounts";

export const { handlers, auth, signIn, signOut } = NextAuth({
  session: { strategy: "jwt", maxAge: 60 * 60 * 8 },
  pages: { signIn: "/login" },
  providers: [
    Credentials({
      credentials: { email: {}, password: {} },
      async authorize(raw) {
        const email = String(raw?.email ?? "");
        const password = String(raw?.password ?? "");
        if (!email || !password) return null;
        try {
          const account = await authenticate(email, password, {
            requestId: randomUUID(),
            ipHash: null,
            userAgent: null,
          });
          return {
            id: account.accountId,
            email: account.email,
            institutionId: account.institutionId,
            roles: account.roles,
          };
        } catch {
          return null;
        }
      },
    }),
  ],
  callbacks: {
    jwt({ token, user }) {
      if (user) {
        token.institutionId = (user as { institutionId: string }).institutionId;
        token.roles = (user as { roles: string[] }).roles;
      }
      return token;
    },
    session({ session, token }) {
      session.user.accountId = token.sub!;
      session.user.institutionId = token.institutionId as string;
      session.user.roles = token.roles as string[];
      return session;
    },
  },
});
```

Create `webapp/src/app/api/auth/[...nextauth]/route.ts`:

```ts
export { GET, POST } from "@/lib/auth/config";
```

Create `webapp/src/types/next-auth.d.ts` so the session additions type-check under `strict`:

```ts
import "next-auth";

declare module "next-auth" {
  interface Session {
    user: {
      accountId: string;
      institutionId: string;
      roles: string[];
      email?: string | null;
    };
  }
}
```

> **Note on session strategy.** The spec calls for database-backed sessions so access can be revoked immediately. Auth.js v5 requires an adapter for that, and the adapter's tables do not fit the `compliance` schema cleanly. Phase 1 ships JWT sessions with an 8-hour cap; **Phase 2 replaces this with database sessions.** Carry this into the Phase 2 plan rather than letting it be forgotten.

- [ ] **Step 6: Build the login page**

Create `webapp/src/app/login/page.tsx`:

```tsx
import { redirect } from "next/navigation";
import { signIn } from "@/lib/auth/config";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;

  async function submit(formData: FormData) {
    "use server";
    try {
      await signIn("credentials", {
        email: String(formData.get("email") ?? "").toLowerCase(),
        password: String(formData.get("password") ?? ""),
        redirectTo: "/cases",
      });
    } catch (thrown) {
      if ((thrown as { digest?: string }).digest?.startsWith("NEXT_REDIRECT")) throw thrown;
      redirect("/login?error=1");
    }
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-6 px-4">
      <header>
        <h1 className="text-2xl font-semibold text-slate-900">Campus Compliance</h1>
        <p className="mt-1 text-sm text-slate-600">Sign in to continue.</p>
      </header>

      {error ? (
        <p role="alert" className="rounded border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800">
          Invalid email or password.
        </p>
      ) : null}

      <form action={submit} className="flex flex-col gap-4">
        <label className="flex flex-col gap-1">
          <span className="text-sm font-medium text-slate-700">Email</span>
          <input name="email" type="email" required autoComplete="username"
                 className="rounded border border-slate-300 px-3 py-2" />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-sm font-medium text-slate-700">Password</span>
          <input name="password" type="password" required autoComplete="current-password"
                 className="rounded border border-slate-300 px-3 py-2" />
        </label>
        <button type="submit"
                className="rounded bg-slate-900 px-4 py-2 font-medium text-white hover:bg-slate-800">
          Sign in
        </button>
      </form>

      <p className="text-sm text-slate-600">
        <a className="underline" href="/report">Report an incident without signing in</a>
      </p>
    </main>
  );
}
```

- [ ] **Step 7: Verify login in the browser**

Run `npm run dev`, open `http://localhost:3000/login`, sign in with an account the test created (Task 8 adds the seeded ones). Expected: redirect to `/cases`, and a new `auth.login_succeeded` row in `compliance.audit_events`.

- [ ] **Step 8: Commit**

```bash
git add webapp
git commit -m "Add credential authentication with lockout and audited failures

An unknown account and a wrong password return the same error, and the unknown
path still runs a hash so it is not detectably faster. Both are enumeration
oracles: the first tells an attacker which addresses are registered, the second
tells them the same thing through a stopwatch.

Failed logins are audited, not only successful ones. Failures are what an
investigator actually needs and are usually the ones missing.

Sessions are JWT for now with an 8-hour cap. The spec calls for database-backed
sessions so access can be revoked immediately; that lands in phase 2 and is
noted in the plan rather than left to be discovered."
```

---

## Task 7: Authorisation, and the test that keeps it honest

**Files:**
- Create: `webapp/src/lib/auth/rbac.ts`
- Test: `webapp/tests/rbac.test.ts`, `webapp/tests/service-authorisation.test.ts`

**Interfaces:**
- Produces:
  - `type Actor = { accountId: string; institutionId: string; roles: ComplianceRole[] }`
  - `requireRole(actor: Actor | null, allowed: ComplianceRole[]): Actor`
  - `requireSameInstitution(actor: Actor, institutionId: string): void`

- [ ] **Step 1: Write the failing test**

Create `webapp/tests/rbac.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { requireRole, requireSameInstitution, type Actor } from "../src/lib/auth/rbac";

const actor = (roles: Actor["roles"]): Actor => ({
  accountId: "a",
  institutionId: "inst-1",
  roles,
});

describe("requireRole", () => {
  it("allows an actor holding one of the permitted roles", () => {
    expect(() => requireRole(actor(["officer"]), ["officer", "admin"])).not.toThrow();
  });

  it("rejects an actor holding none of them", () => {
    expect(() => requireRole(actor(["reporter"]), ["officer"])).toThrow(/not permitted/i);
  });

  it("rejects an unauthenticated actor", () => {
    expect(() => requireRole(null, ["reporter"])).toThrow(/sign in/i);
  });

  it("returns the actor so callers can use it directly", () => {
    expect(requireRole(actor(["admin"]), ["admin"]).accountId).toBe("a");
  });
});

describe("requireSameInstitution", () => {
  it("allows a matching institution", () => {
    expect(() => requireSameInstitution(actor(["officer"]), "inst-1")).not.toThrow();
  });

  it("rejects a different institution even for an admin", () => {
    expect(() => requireSameInstitution(actor(["admin"]), "inst-2")).toThrow(/not permitted/i);
  });
});
```

Note the last case: an **admin** is refused another tenant's data. Tenant isolation is not a permission an admin can hold.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/rbac.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `webapp/src/lib/auth/rbac.ts`:

```ts
import type { ComplianceRole } from "@prisma/client";
import { ForbiddenError } from "@/lib/errors";

export type Actor = {
  accountId: string;
  institutionId: string;
  roles: ComplianceRole[];
};

export function requireRole(actor: Actor | null, allowed: ComplianceRole[]): Actor {
  if (!actor) throw new ForbiddenError("You must sign in to do that.");
  if (!actor.roles.some((held) => allowed.includes(held))) {
    throw new ForbiddenError("You are not permitted to perform this action.");
  }
  return actor;
}

/**
 * Tenant isolation. Deliberately not a role: no role, including admin, grants
 * access to another institution's records.
 */
export function requireSameInstitution(actor: Actor, institutionId: string): void {
  if (actor.institutionId !== institutionId) {
    throw new ForbiddenError("You are not permitted to access this record.");
  }
}
```

- [ ] **Step 4: Write the invariant test**

Create `webapp/tests/service-authorisation.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Every exported function in src/server/ must perform an authorisation check.
 * The exemption list is explicit and must stay short: anything on it is a
 * deliberate decision someone can review, not an oversight nobody noticed.
 */
const EXEMPT = new Set([
  "authenticate",           // produces identity; cannot require it
  "newRequestMeta",         // pure helper, touches no data
  "submitAnonymousReport",  // by definition has no actor; rate-limited instead
  "lookupAnonymousReport",  // authorised by reference code + access secret
]);

const SERVER_DIR = join(__dirname, "..", "src", "server");
const CHECKS = ["requireRole", "requireSameInstitution", "assertRateLimit"];

describe("service layer authorisation", () => {
  it("every exported service either authorises or is explicitly exempt", () => {
    const offenders: string[] = [];

    for (const file of readdirSync(SERVER_DIR).filter((f) => f.endsWith(".ts"))) {
      const source = readFileSync(join(SERVER_DIR, file), "utf8");
      const exported = [...source.matchAll(/export\s+(?:async\s+)?function\s+(\w+)/g)].map(
        (m) => m[1],
      );

      for (const name of exported) {
        if (EXEMPT.has(name)) continue;
        const start = source.indexOf(`function ${name}`);
        const rest = source.slice(start);
        const end = rest.indexOf("\nexport ");
        const fnSource = end === -1 ? rest : rest.slice(0, end);
        if (!CHECKS.some((check) => fnSource.includes(check))) {
          offenders.push(`${file}:${name}`);
        }
      }
    }

    expect(offenders, `services missing an authorisation call: ${offenders.join(", ")}`).toEqual([]);
  });
});
```

This is a crude parser, and that is acceptable: it cannot be fooled by anything an engineer would write by accident, and the cost of a false positive is adding a name to `EXEMPT` with a reason. It turns "we always remember to authorise" from a habit into a build failure.

- [ ] **Step 5: Run both test files**

Run: `npx vitest run tests/rbac.test.ts tests/service-authorisation.test.ts`
Expected: 7 passed.

- [ ] **Step 6: Commit**

```bash
git add webapp/src/lib/auth/rbac.ts webapp/tests/rbac.test.ts webapp/tests/service-authorisation.test.ts
git commit -m "Add role checks and a test that enforces them across the service layer

requireSameInstitution is deliberately not a role. No role, admin included,
grants access to another tenant's records -- making it a permission would mean
one mis-assigned grant crosses the tenant boundary.

The second test walks src/server/ and fails the build if an exported service
does not authorise. The exemption list is explicit and short, so an exemption is
a decision someone reviewed rather than a line nobody noticed was missing."
```

---

## Task 8: Seed a believable campus

**Files:**
- Modify: `webapp/prisma/seed.ts`
- Create: `webapp/prisma/seed-data.ts`

**Interfaces:**
- Produces: three institutions, 40 people each with accounts and role grants, a location tree, issue categories. Idempotent.

- [ ] **Step 1: Write the seed data module**

Create `webapp/prisma/seed-data.ts`:

```ts
export const INSTITUTIONS = [
  { name: "Northgate University", code: "NGU", domain: "northgate.edu", city: "Chennai" },
  { name: "Riverside Institute of Technology", code: "RIT", domain: "riverside.edu", city: "Pune" },
  { name: "Westfield College", code: "WFC", domain: "westfield.edu", city: "Kochi" },
] as const;

export const DEPARTMENTS = [
  "Computer Science", "Mechanical Engineering", "Business Studies",
  "Student Affairs", "Facilities", "Library Services",
] as const;

export const CATEGORIES = [
  { name: "Academic misconduct", slaHours: 72 },
  { name: "Harassment", slaHours: 24 },
  { name: "Property damage", slaHours: 168 },
  { name: "Substance policy", slaHours: 72 },
  { name: "Residence conduct", slaHours: 168 },
  { name: "Data protection", slaHours: 24 },
] as const;

/** Password for every seeded account. Development only; all accounts must change it. */
export const SEED_PASSWORD = "capstone demo passphrase";
```

- [ ] **Step 2: Rewrite the seed script**

Replace `webapp/prisma/seed.ts`:

```ts
import type { ComplianceRole } from "@prisma/client";
import { prisma } from "../src/lib/db";
import { hashPassword } from "../src/lib/auth/password";
import { CATEGORIES, DEPARTMENTS, INSTITUTIONS, SEED_PASSWORD } from "./seed-data";

const ROLE_MIX: { role: ComplianceRole; count: number }[] = [
  { role: "admin", count: 1 },
  { role: "dpo", count: 1 },
  { role: "officer", count: 3 },
  { role: "investigator", count: 4 },
  { role: "reporter", count: 31 },
];

async function main() {
  const passwordHash = await hashPassword(SEED_PASSWORD);

  for (const inst of INSTITUTIONS) {
    const [institution] = await prisma.$queryRaw<{ id: string }[]>`
      INSERT INTO campuspulse.institutions (name, code, domain, city, timezone, is_active)
      VALUES (${inst.name}, ${inst.code}, ${inst.domain}, ${inst.city}, 'Asia/Kolkata', true)
      ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name
      RETURNING id`;

    for (const category of CATEGORIES) {
      await prisma.$executeRaw`
        INSERT INTO campuspulse.categories (institution_id, name, category_type, sla_hours)
        SELECT ${institution.id}::uuid, ${category.name}, 'issue_category', ${category.slaHours}
        WHERE NOT EXISTS (
          SELECT 1 FROM campuspulse.categories
          WHERE institution_id = ${institution.id}::uuid AND name = ${category.name})`;
    }

    const campusRows = await prisma.$queryRaw<{ id: string }[]>`
      INSERT INTO campuspulse.locations (institution_id, name, location_type, code)
      SELECT ${institution.id}::uuid, ${`${inst.name} Main Campus`}, 'campus', ${inst.code}
      WHERE NOT EXISTS (
        SELECT 1 FROM campuspulse.locations
        WHERE institution_id = ${institution.id}::uuid AND location_type = 'campus')
      RETURNING id`;

    if (campusRows.length > 0) {
      for (const building of ["Science Block", "Library", "Hostel A", "Admin Building"]) {
        await prisma.$executeRaw`
          INSERT INTO campuspulse.locations (institution_id, parent_id, name, location_type)
          VALUES (${institution.id}::uuid, ${campusRows[0].id}::uuid, ${building}, 'building')`;
      }
    }

    let index = 0;
    for (const { role, count } of ROLE_MIX) {
      for (let i = 0; i < count; i++) {
        index += 1;
        const email = `${role}${i + 1}@${inst.domain}`;
        const fullName = `${role[0].toUpperCase()}${role.slice(1)} ${i + 1}`;
        const department = DEPARTMENTS[index % DEPARTMENTS.length];

        const [user] = await prisma.$queryRaw<{ id: string }[]>`
          INSERT INTO campuspulse.users (institution_id, full_name, email, department, is_active)
          VALUES (${institution.id}::uuid, ${fullName}, ${email}, ${department}, true)
          ON CONFLICT (institution_id, email) DO UPDATE SET full_name = EXCLUDED.full_name
          RETURNING id`;

        const account = await prisma.userAccount.upsert({
          where: { userId: user.id },
          create: {
            userId: user.id,
            institutionId: institution.id,
            email,
            passwordHash,
            mustChangePassword: true,
          },
          update: {},
        });

        const live = await prisma.roleAssignment.findFirst({
          where: { userAccountId: account.id, role, revokedAt: null },
        });
        if (!live) {
          await prisma.roleAssignment.create({ data: { userAccountId: account.id, role } });
        }
      }
    }
  }

  const [institutions, accounts, grants] = await Promise.all([
    prisma.institution.count(),
    prisma.userAccount.count(),
    prisma.roleAssignment.count({ where: { revokedAt: null } }),
  ]);
  console.log(`institutions ${institutions}  accounts ${accounts}  live role grants ${grants}`);
  console.log(`\nSign in as  admin1@northgate.edu  /  ${SEED_PASSWORD}`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
```

- [ ] **Step 3: Run the seed twice to prove idempotence**

Run: `npm run seed && npm run seed`
Expected: both succeed and the second prints the same counts as the first. If counts grow, a conflict guard is missing.

- [ ] **Step 4: Commit**

```bash
git add webapp/prisma
git commit -m "Seed three institutions with a realistic role mix

Three tenants rather than one, matching the Python project, because tenant
isolation that is never exercised by the data is not tested by the data.

The seed is idempotent and asserted so: running it twice must print identical
counts. A seed that silently doubles its output on a second run is the kind of
thing discovered much later, in a dashboard, as a number nobody can explain.

Every seeded account carries must_change_password so the shared demo passphrase
is never mistaken for a deployment posture."
```

---

## Task 9: Reference codes and access secrets

**Files:**
- Create: `webapp/src/lib/reference/codes.ts`
- Test: `webapp/tests/codes.test.ts`

**Interfaces:**
- Produces:
  - `generateReferenceCode(): string` — `CR-XXXX-XXXX`
  - `generateAccessSecret(): string` — 32 bytes, Crockford base32, hyphen-grouped
  - `hashAccessSecret(secret: string): Promise<string>`
  - `verifyAccessSecret(storedHash: string, secret: string): Promise<boolean>`

- [ ] **Step 1: Write the failing test**

Create `webapp/tests/codes.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  generateAccessSecret,
  generateReferenceCode,
  hashAccessSecret,
  verifyAccessSecret,
} from "../src/lib/reference/codes";

describe("generateReferenceCode", () => {
  it("matches the documented format", () => {
    expect(generateReferenceCode()).toMatch(/^CR-[0-9A-HJ-NP-TV-Z]{4}-[0-9A-HJ-NP-TV-Z]{4}$/);
  });

  it("excludes characters that are misread when spoken or written", () => {
    const sample = Array.from({ length: 200 }, generateReferenceCode).join("");
    expect(sample).not.toMatch(/[ILOU]/);
  });

  it("does not collide across a large sample", () => {
    const codes = new Set(Array.from({ length: 5000 }, generateReferenceCode));
    expect(codes.size).toBe(5000);
  });
});

describe("access secrets", () => {
  it("verifies the secret it issued", async () => {
    const secret = generateAccessSecret();
    expect(await verifyAccessSecret(await hashAccessSecret(secret), secret)).toBe(true);
  });

  it("rejects a different secret", async () => {
    const hash = await hashAccessSecret(generateAccessSecret());
    expect(await verifyAccessSecret(hash, generateAccessSecret())).toBe(false);
  });

  it("accepts the secret without its grouping hyphens", async () => {
    const secret = generateAccessSecret();
    const hash = await hashAccessSecret(secret);
    expect(await verifyAccessSecret(hash, secret.replace(/-/g, "").toLowerCase())).toBe(true);
  });

  it("is long enough to resist brute force", () => {
    expect(generateAccessSecret().replace(/-/g, "").length).toBeGreaterThanOrEqual(52);
  });
});
```

`I`, `L`, `O` and `U` are excluded because a reference code gets read aloud over a phone and written on paper, and `O`/`0` confusion turns into a support problem. `U` is dropped as well — Crockford's alphabet omits it to avoid accidental obscenities.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/codes.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `webapp/src/lib/reference/codes.ts`:

```ts
import { randomBytes, randomInt } from "node:crypto";
import { hash, verify } from "@node-rs/argon2";

/** Crockford base32: no I, L, O or U. Survives being read aloud and handwritten. */
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

const ARGON = { memoryCost: 19456, timeCost: 2, parallelism: 1 } as const;

function group(length: number): string {
  let out = "";
  for (let i = 0; i < length; i++) out += ALPHABET[randomInt(ALPHABET.length)];
  return out;
}

export function generateReferenceCode(): string {
  return `CR-${group(4)}-${group(4)}`;
}

/**
 * 32 bytes of entropy, base32-encoded and grouped for transcription. Shown once
 * and stored only as a hash: the server cannot reproduce it, so a leaked
 * reference code alone discloses nothing.
 */
export function generateAccessSecret(): string {
  const bytes = randomBytes(32);
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out.match(/.{1,4}/g)!.join("-");
}

/** The entropy is in the characters, not the formatting. */
function normalise(secret: string): string {
  return secret.replace(/-/g, "").toUpperCase();
}

export function hashAccessSecret(secret: string): Promise<string> {
  return hash(normalise(secret), ARGON);
}

export async function verifyAccessSecret(storedHash: string, secret: string): Promise<boolean> {
  try {
    return await verify(storedHash, normalise(secret), ARGON);
  } catch {
    return false;
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/codes.test.ts`
Expected: 7 passed.

- [ ] **Step 5: Commit**

```bash
git add webapp/src/lib/reference webapp/tests/codes.test.ts
git commit -m "Add reference codes and access secrets for anonymous reports

Two identifiers, not one. The reference code is short enough to read over a
phone and is stored in clear because it is an identifier. The access secret
carries 32 bytes of entropy, is shown exactly once and is stored only as an
Argon2id hash, so a leaked code on its own discloses nothing.

Crockford's alphabet drops I, L, O and U. A code that gets handwritten and read
aloud will meet O/0 confusion otherwise, and that becomes a support problem for
the one user who most needs the process to work.

Hyphens and case are normalised before hashing: a reporter retyping the secret
should not be punished for dropping the grouping."
```

---

## Task 10: Report submission

**Files:**
- Modify: `webapp/prisma/schema.prisma`
- Create: migration, `webapp/src/lib/validation/report.ts`, `webapp/src/server/reports.ts`, `webapp/src/app/report/page.tsx`, `webapp/src/app/report/submitted/page.tsx`
- Test: `webapp/tests/reports.test.ts`

**Interfaces:**
- Consumes: `withAudit`, `requireRole`, `requireSameInstitution`, the code helpers, `RequestMeta`.
- Produces:
  - `type ReportInput` (from `reportInputSchema`)
  - `submitReport(actor: Actor, input: ReportInput, meta: RequestMeta): Promise<{ referenceCode: string }>`
  - `submitAnonymousReport(institutionId: string, input: ReportInput, meta: RequestMeta): Promise<{ referenceCode: string; accessSecret: string }>`

- [ ] **Step 1: Add the model**

Append to `webapp/prisma/schema.prisma`:

```prisma
enum Severity {
  low
  moderate
  high
  severe

  @@map("severity")
  @@schema("compliance")
}

enum ReportChannel {
  web
  kiosk
  email_ingest
  phone_transcribed

  @@map("report_channel")
  @@schema("compliance")
}

enum ReportStatus {
  received
  triaged
  merged
  rejected

  @@map("report_status")
  @@schema("compliance")
}

model Report {
  id                   String        @id @default(uuid()) @db.Uuid
  institutionId        String        @map("institution_id") @db.Uuid
  referenceCode        String        @unique @map("reference_code")
  accessSecretHash     String?       @map("access_secret_hash")
  reporterUserId       String?       @map("reporter_user_id") @db.Uuid
  isAnonymous          Boolean       @map("is_anonymous")
  categoryId           String?       @map("category_id") @db.Uuid
  locationId           String?       @map("location_id") @db.Uuid
  occurredAt           DateTime?     @map("occurred_at")
  submittedAt          DateTime      @default(now()) @map("submitted_at")
  title                String
  description          String
  severitySelfReported Severity      @map("severity_self_reported")
  channel              ReportChannel
  status               ReportStatus  @default(received)
  ipHash               String?       @map("ip_hash")
  userAgent            String?       @map("user_agent")
  createdAt            DateTime      @default(now()) @map("created_at")
  updatedAt            DateTime      @updatedAt @map("updated_at")
  deletedAt            DateTime?     @map("deleted_at")

  reporter             UserAccount?  @relation(fields: [reporterUserId], references: [id])

  @@index([institutionId, status, submittedAt(sort: Desc)])
  @@map("reports")
  @@schema("compliance")
}
```

Add `reports Report[]` to `UserAccount`.

- [ ] **Step 2: Generate the migration without applying it**

Run: `npx prisma migrate dev --name add_reports --create-only`

- [ ] **Step 3: Add the anonymity constraint and search index**

Append to the generated `migration.sql`:

```sql
ALTER TABLE compliance.reports
  ADD CONSTRAINT reports_anonymity_coherent CHECK (
    (is_anonymous     AND reporter_user_id IS NULL     AND access_secret_hash IS NOT NULL)
    OR
    (NOT is_anonymous AND reporter_user_id IS NOT NULL AND access_secret_hash IS NULL)
  );

ALTER TABLE compliance.reports
  ADD COLUMN search_tsv tsvector
  GENERATED ALWAYS AS (
    to_tsvector('english', coalesce(title, '') || ' ' || coalesce(description, ''))
  ) STORED;

CREATE INDEX reports_search_idx ON compliance.reports USING GIN (search_tsv);
```

- [ ] **Step 4: Apply the migration**

Run: `npx prisma migrate dev`

- [ ] **Step 5: Write the failing test**

Create `webapp/tests/reports.test.ts`:

```ts
import { beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { prisma } from "../src/lib/db";
import { submitAnonymousReport, submitReport } from "../src/server/reports";
import type { Actor } from "../src/lib/auth/rbac";

const meta = () => ({ requestId: randomUUID(), ipHash: null, userAgent: "vitest" });
const input = {
  title: "Exam paper shared in a group chat",
  description: "A photograph of the question paper circulated the evening before the exam.",
  severitySelfReported: "high" as const,
  categoryId: null,
  locationId: null,
  occurredAt: null,
};

let institutionId: string;
let actor: Actor;

beforeAll(async () => {
  const inst = await prisma.institution.findFirstOrThrow({ where: { code: "NGU" } });
  institutionId = inst.id;
  const account = await prisma.userAccount.findFirstOrThrow({
    where: { institutionId, email: { startsWith: "reporter1@" } },
    include: { roles: { where: { revokedAt: null } } },
  });
  actor = { accountId: account.id, institutionId, roles: account.roles.map((r) => r.role) };
});

describe("submitReport", () => {
  it("stores an attributed report and audits it", async () => {
    const { referenceCode } = await submitReport(actor, input, meta());
    const report = await prisma.report.findUniqueOrThrow({ where: { referenceCode } });

    expect(report.isAnonymous).toBe(false);
    expect(report.reporterUserId).toBe(actor.accountId);
    expect(report.accessSecretHash).toBeNull();

    const audit = await prisma.auditEvent.findFirst({
      where: { entityId: report.id, action: "report.submitted" },
    });
    expect(audit?.actorUserAccountId).toBe(actor.accountId);
  });
});

describe("submitAnonymousReport", () => {
  it("stores no reporter and returns a secret", async () => {
    const { referenceCode, accessSecret } = await submitAnonymousReport(institutionId, input, meta());
    const report = await prisma.report.findUniqueOrThrow({ where: { referenceCode } });

    expect(report.isAnonymous).toBe(true);
    expect(report.reporterUserId).toBeNull();
    expect(report.accessSecretHash).not.toBeNull();
    expect(accessSecret.replace(/-/g, "").length).toBeGreaterThanOrEqual(52);
  });

  it("audits as anonymous, never naming an actor", async () => {
    const { referenceCode } = await submitAnonymousReport(institutionId, input, meta());
    const report = await prisma.report.findUniqueOrThrow({ where: { referenceCode } });
    const audit = await prisma.auditEvent.findFirstOrThrow({
      where: { entityId: report.id, action: "report.submitted" },
    });

    expect(audit.actorUserAccountId).toBeNull();
    expect(audit.actorLabel).toBe("anonymous");
  });
});

describe("the database refuses an incoherent report", () => {
  it("rejects an anonymous report carrying a reporter id", async () => {
    const account = await prisma.userAccount.findFirstOrThrow({ where: { institutionId } });
    await expect(
      prisma.report.create({
        data: {
          institutionId,
          referenceCode: `CR-BAD-${randomUUID().slice(0, 4).toUpperCase()}`,
          isAnonymous: true,
          reporterUserId: account.id, // incoherent, on purpose
          accessSecretHash: "x",
          title: input.title,
          description: input.description,
          severitySelfReported: "high",
          channel: "web",
        },
      }),
    ).rejects.toThrow(/reports_anonymity_coherent/);
  });
});
```

The last test bypasses the service deliberately and writes through Prisma. It proves the guarantee holds even if a future endpoint forgets it.

- [ ] **Step 6: Run the test to verify it fails**

Run: `npx vitest run tests/reports.test.ts`
Expected: FAIL — cannot find `../src/server/reports`.

- [ ] **Step 7: Write the validation schema**

Create `webapp/src/lib/validation/report.ts`:

```ts
import { z } from "zod";

export const reportInputSchema = z.object({
  title: z.string().trim().min(8, "Give the report a short, specific title.").max(200),
  description: z
    .string()
    .trim()
    .min(40, "Describe what happened in at least a couple of sentences.")
    .max(10_000),
  severitySelfReported: z.enum(["low", "moderate", "high", "severe"]),
  categoryId: z.string().uuid().nullable(),
  locationId: z.string().uuid().nullable(),
  occurredAt: z.coerce.date().nullable(),
});

export type ReportInput = z.infer<typeof reportInputSchema>;
```

- [ ] **Step 8: Implement the service**

Create `webapp/src/server/reports.ts`:

```ts
import { prisma } from "@/lib/db";
import { withAudit } from "@/lib/audit/withAudit";
import { requireRole, requireSameInstitution, type Actor } from "@/lib/auth/rbac";
import {
  generateAccessSecret,
  generateReferenceCode,
  hashAccessSecret,
} from "@/lib/reference/codes";
import { reportInputSchema, type ReportInput } from "@/lib/validation/report";
import type { RequestMeta } from "@/server/accounts";

export async function submitReport(
  actor: Actor,
  input: ReportInput,
  meta: RequestMeta,
): Promise<{ referenceCode: string }> {
  requireRole(actor, ["reporter", "officer", "investigator", "admin", "dpo"]);
  requireSameInstitution(actor, actor.institutionId);

  const parsed = reportInputSchema.parse(input);
  const referenceCode = generateReferenceCode();

  await prisma.$transaction(async (tx) => {
    const report = await tx.report.create({
      data: {
        institutionId: actor.institutionId,
        referenceCode,
        isAnonymous: false,
        reporterUserId: actor.accountId,
        channel: "web",
        ipHash: meta.ipHash,
        userAgent: meta.userAgent,
        ...parsed,
      },
    });
    await withAudit(
      tx,
      {
        actorAccountId: actor.accountId,
        actorLabel: actor.accountId,
        institutionId: actor.institutionId,
        requestId: meta.requestId,
        ipHash: meta.ipHash,
        userAgent: meta.userAgent,
      },
      {
        action: "report.submitted",
        entityType: "report",
        entityId: report.id,
        after: { referenceCode, isAnonymous: false },
      },
    );
  });

  return { referenceCode };
}

/**
 * No actor by definition, so the authorisation test exempts it. Abuse is
 * controlled by rate limiting rather than identity.
 */
export async function submitAnonymousReport(
  institutionId: string,
  input: ReportInput,
  meta: RequestMeta,
): Promise<{ referenceCode: string; accessSecret: string }> {
  const parsed = reportInputSchema.parse(input);
  const referenceCode = generateReferenceCode();
  const accessSecret = generateAccessSecret();
  const accessSecretHash = await hashAccessSecret(accessSecret);

  await prisma.$transaction(async (tx) => {
    const report = await tx.report.create({
      data: {
        institutionId,
        referenceCode,
        accessSecretHash,
        isAnonymous: true,
        reporterUserId: null,
        channel: "web",
        ipHash: meta.ipHash,
        userAgent: meta.userAgent,
        ...parsed,
      },
    });
    await withAudit(
      tx,
      {
        actorAccountId: null,
        actorLabel: "anonymous",
        institutionId,
        requestId: meta.requestId,
        ipHash: meta.ipHash,
        userAgent: meta.userAgent,
      },
      {
        action: "report.submitted",
        entityType: "report",
        entityId: report.id,
        after: { referenceCode, isAnonymous: true },
      },
    );
  });

  // Returned once. Never stored, never logged, never emailed.
  return { referenceCode, accessSecret };
}
```

- [ ] **Step 9: Run the tests to verify they pass**

Run: `npx vitest run tests/reports.test.ts`
Expected: 4 passed.

- [ ] **Step 10: Build the report form**

Create `webapp/src/app/report/page.tsx`: a form collecting title, description, severity, and optional category, location and occurrence date. Its server action reads the session via `auth()`; with a session it calls `submitReport`, otherwise `submitAnonymousReport` with the institution taken from the form's institution selector. On success it redirects to `/report/submitted`.

- [ ] **Step 11: Build the confirmation page**

Create `webapp/src/app/report/submitted/page.tsx`. It always shows the reference code, and for anonymous submissions shows the access secret exactly once with this warning:

```tsx
<section role="alert" className="rounded border border-amber-300 bg-amber-50 p-4">
  <h2 className="font-semibold text-amber-900">Save this access code now</h2>
  <p className="mt-1 text-sm text-amber-900">
    This is the only time it will be shown. Without it, this report cannot be
    looked up again — we store only a one-way hash, so we cannot recover it for
    you. That is what keeps the report anonymous.
  </p>
  <code className="mt-3 block rounded bg-white px-3 py-2 font-mono text-lg tracking-wider">
    {accessSecret}
  </code>
</section>
```

- [ ] **Step 12: Verify in the browser**

Submit one report signed out and one signed in. Expected: both appear in `compliance.reports`; the anonymous one has `reporter_user_id IS NULL`; both have `report.submitted` audit rows and the anonymous row's `actor_label` is `anonymous`.

- [ ] **Step 13: Commit**

```bash
git add webapp
git commit -m "Add report submission, attributed and anonymous

The anonymity invariant is a CHECK constraint, not only service logic. Its test
writes through Prisma rather than the service, because the failure being guarded
against is a future endpoint that forgets -- and an anonymous report that
silently carries a reporter id looks entirely correct in the interface.

The access secret is returned once and never stored, logged or emailed. The
confirmation page says plainly that losing it means losing access to the report,
because that is the honest trade and the user should make it knowingly."
```

---

## Task 11: Anonymous status lookup with rate limiting

**Files:**
- Create: `webapp/src/lib/rateLimit.ts`, `webapp/src/app/report/status/page.tsx`
- Modify: `webapp/src/server/reports.ts`
- Test: `webapp/tests/anonymous-lookup.test.ts`

**Interfaces:**
- Produces:
  - `assertRateLimit(key: string, limit: number, windowMs: number): void`
  - `resetRateLimits(): void`
  - `type ReportStatusView = { referenceCode: string; status: ReportStatus; submittedAt: Date; title: string }`
  - `lookupAnonymousReport(referenceCode: string, accessSecret: string, meta: RequestMeta): Promise<ReportStatusView>`

- [ ] **Step 1: Write the failing test**

Create `webapp/tests/anonymous-lookup.test.ts`:

```ts
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { prisma } from "../src/lib/db";
import { resetRateLimits } from "../src/lib/rateLimit";
import { lookupAnonymousReport, submitAnonymousReport } from "../src/server/reports";

const meta = () => ({ requestId: randomUUID(), ipHash: null, userAgent: "vitest" });
const WRONG = "WRONGWRONGWRONGWRONGWRONGWRONGWRONGWRONGWRONGWRONGWR";
let referenceCode: string;
let accessSecret: string;

beforeAll(async () => {
  const inst = await prisma.institution.findFirstOrThrow({ where: { code: "NGU" } });
  const result = await submitAnonymousReport(
    inst.id,
    {
      title: "Anonymous lookup fixture",
      description: "A description long enough to satisfy the validation rules for a report.",
      severitySelfReported: "moderate",
      categoryId: null,
      locationId: null,
      occurredAt: null,
    },
    meta(),
  );
  referenceCode = result.referenceCode;
  accessSecret = result.accessSecret;
});

beforeEach(() => resetRateLimits());

describe("lookupAnonymousReport", () => {
  it("returns the status when code and secret both match", async () => {
    const view = await lookupAnonymousReport(referenceCode, accessSecret, meta());
    expect(view.referenceCode).toBe(referenceCode);
    expect(view.status).toBe("received");
  });

  it("accepts the secret without its grouping hyphens", async () => {
    const view = await lookupAnonymousReport(referenceCode, accessSecret.replace(/-/g, ""), meta());
    expect(view.referenceCode).toBe(referenceCode);
  });

  it("refuses a correct code with a wrong secret", async () => {
    await expect(lookupAnonymousReport(referenceCode, WRONG, meta())).rejects.toThrow(/not found/i);
  });

  it("gives the same error for an unknown code as for a wrong secret", async () => {
    await expect(lookupAnonymousReport("CR-ZZZZ-ZZZZ", accessSecret, meta())).rejects.toThrow(
      /not found/i,
    );
  });

  it("never exposes the description", async () => {
    const view = await lookupAnonymousReport(referenceCode, accessSecret, meta());
    expect(Object.keys(view)).not.toContain("description");
  });

  it("rate limits repeated attempts against one code", async () => {
    for (let i = 0; i < 5; i++) {
      await expect(lookupAnonymousReport(referenceCode, WRONG, meta())).rejects.toThrow();
    }
    await expect(lookupAnonymousReport(referenceCode, accessSecret, meta())).rejects.toThrow(
      /too many attempts/i,
    );
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/anonymous-lookup.test.ts`
Expected: FAIL — cannot find `../src/lib/rateLimit`.

- [ ] **Step 3: Implement the rate limiter**

Create `webapp/src/lib/rateLimit.ts`:

```ts
import { RateLimitedError } from "@/lib/errors";

type Bucket = { count: number; resetAt: number };
const buckets = new Map<string, Bucket>();

/**
 * In-memory fixed-window limiter. Sufficient for a single-process deployment;
 * several instances need a shared store, which the README states rather than
 * pretending away.
 */
export function assertRateLimit(key: string, limit: number, windowMs: number): void {
  const now = Date.now();
  const bucket = buckets.get(key);

  if (!bucket || bucket.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return;
  }
  if (bucket.count >= limit) {
    throw new RateLimitedError("Too many attempts. Try again shortly.");
  }
  bucket.count += 1;
}

export function resetRateLimits(): void {
  buckets.clear();
}
```

- [ ] **Step 4: Implement the lookup**

Append to `webapp/src/server/reports.ts`, adding these imports at the top of the file:

```ts
import type { ReportStatus } from "@prisma/client";
import { assertRateLimit } from "@/lib/rateLimit";
import { verifyAccessSecret } from "@/lib/reference/codes";
import { NotFoundError } from "@/lib/errors";
```

```ts
export type ReportStatusView = {
  referenceCode: string;
  status: ReportStatus;
  submittedAt: Date;
  title: string;
};

/**
 * Authorised by reference code plus access secret rather than by session, so the
 * authorisation test exempts it. Rate limited because the secret is the only
 * thing standing between a guessed code and the report.
 */
export async function lookupAnonymousReport(
  referenceCode: string,
  accessSecret: string,
  meta: RequestMeta,
): Promise<ReportStatusView> {
  const code = referenceCode.trim().toUpperCase();
  assertRateLimit(`lookup:${code}`, 5, 15 * 60_000);

  const report = await prisma.report.findFirst({
    where: { referenceCode: code, isAnonymous: true, deletedAt: null },
  });

  // One error for both failures: distinguishing them confirms which codes exist.
  const deny = () => new NotFoundError("No report was found for that code and access code.");

  if (!report?.accessSecretHash) throw deny();

  if (!(await verifyAccessSecret(report.accessSecretHash, accessSecret))) {
    await prisma.$transaction((tx) =>
      withAudit(
        tx,
        {
          actorAccountId: null,
          actorLabel: "anonymous",
          institutionId: report.institutionId,
          requestId: meta.requestId,
          ipHash: meta.ipHash,
          userAgent: meta.userAgent,
        },
        { action: "report.lookup_failed", entityType: "report", entityId: report.id },
      ),
    );
    throw deny();
  }

  return {
    referenceCode: report.referenceCode,
    status: report.status,
    submittedAt: report.submittedAt,
    title: report.title,
  };
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run tests/anonymous-lookup.test.ts`
Expected: 6 passed.

- [ ] **Step 6: Build the status page**

Create `webapp/src/app/report/status/page.tsx`: a form taking reference code and access code, calling `lookupAnonymousReport` in a server action, rendering status and submission date on success and a single neutral message on any failure.

- [ ] **Step 7: Commit**

```bash
git add webapp
git commit -m "Add anonymous status lookup, rate limited and audited

An unknown reference code and a wrong access secret return the same message.
Distinguishing them would confirm which codes exist, which is most of what an
attacker needs given how short the codes are.

Failed lookups are audited so a brute-force attempt against one report is
visible afterwards, and the limiter caps attempts at five per code per fifteen
minutes so it is not worth starting.

The limiter is in-memory and therefore per-process. That is honest for a
single-instance deployment and wrong for several; the README says so rather than
leaving someone to discover it in production."
```

---

## Task 12: Cases and the officer queue

**Files:**
- Modify: `webapp/prisma/schema.prisma`
- Create: migration, `webapp/src/server/cases.ts`, `webapp/src/app/cases/page.tsx`, `webapp/src/app/cases/[id]/page.tsx`
- Test: `webapp/tests/cases.test.ts`

**Interfaces:**
- Produces:
  - `type TriageInput = { severity: Severity; title: string; confidentiality: Confidentiality }`
  - `type CaseFilter = { status?: CaseStatus; severity?: Severity }`
  - `type CaseSummary = { id: string; institutionId: string; caseNumber: string; title: string; severity: Severity; status: CaseStatus; slaDueAt: Date; assignedOfficerId: string | null }`
  - `triageReport(actor, reportId, input, meta): Promise<{ caseNumber: string }>`
  - `listCases(actor, filter): Promise<CaseSummary[]>`
  - `getCase(actor, caseId): Promise<CaseSummary & { statusHistory: { fromStatus: CaseStatus | null; toStatus: CaseStatus; changedAt: Date }[] }>`

- [ ] **Step 1: Add the models**

Append to `webapp/prisma/schema.prisma`:

```prisma
enum CaseStatus {
  submitted
  triaged
  under_investigation
  pending_decision
  resolved
  closed
  dismissed
  appealed

  @@map("case_status")
  @@schema("compliance")
}

enum Confidentiality {
  standard
  restricted
  sealed

  @@map("confidentiality")
  @@schema("compliance")
}

model Case {
  id                String          @id @default(uuid()) @db.Uuid
  institutionId     String          @map("institution_id") @db.Uuid
  caseNumber        String          @map("case_number")
  title             String
  summary           String?
  categoryId        String?         @map("category_id") @db.Uuid
  severity          Severity
  status            CaseStatus      @default(submitted)
  assignedOfficerId String?         @map("assigned_officer_id") @db.Uuid
  openedAt          DateTime        @default(now()) @map("opened_at")
  slaDueAt          DateTime        @map("sla_due_at")
  firstResponseAt   DateTime?       @map("first_response_at")
  resolvedAt        DateTime?       @map("resolved_at")
  closedAt          DateTime?       @map("closed_at")
  confidentiality   Confidentiality @default(standard)
  createdAt         DateTime        @default(now()) @map("created_at")
  updatedAt         DateTime        @updatedAt @map("updated_at")
  deletedAt         DateTime?       @map("deleted_at")

  assignedOfficer   UserAccount?        @relation(fields: [assignedOfficerId], references: [id])
  reports           CaseReport[]
  statusHistory     CaseStatusHistory[]

  @@unique([institutionId, caseNumber])
  @@index([institutionId, status, slaDueAt])
  @@index([assignedOfficerId, status])
  @@map("cases")
  @@schema("compliance")
}

model CaseReport {
  caseId    String  @map("case_id") @db.Uuid
  reportId  String  @map("report_id") @db.Uuid
  isPrimary Boolean @default(false) @map("is_primary")

  case      Case    @relation(fields: [caseId], references: [id], onDelete: Cascade)

  @@id([caseId, reportId])
  @@map("case_reports")
  @@schema("compliance")
}

model CaseStatusHistory {
  id          String      @id @default(uuid()) @db.Uuid
  caseId      String      @map("case_id") @db.Uuid
  fromStatus  CaseStatus? @map("from_status")
  toStatus    CaseStatus  @map("to_status")
  changedById String?     @map("changed_by") @db.Uuid
  reason      String?
  changedAt   DateTime    @default(now()) @map("changed_at")

  case        Case        @relation(fields: [caseId], references: [id], onDelete: Cascade)

  @@index([caseId, changedAt])
  @@map("case_status_history")
  @@schema("compliance")
}
```

Add `cases Case[]` to `UserAccount`.

- [ ] **Step 2: Apply the migration**

Run: `npx prisma migrate dev --name add_cases`

- [ ] **Step 3: Write the failing test**

Create `webapp/tests/cases.test.ts`:

```ts
import { beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { prisma } from "../src/lib/db";
import { submitAnonymousReport } from "../src/server/reports";
import { getCase, listCases, triageReport } from "../src/server/cases";
import type { Actor } from "../src/lib/auth/rbac";

const meta = () => ({ requestId: randomUUID(), ipHash: null, userAgent: "vitest" });
let institutionId: string;
let officer: Actor;
let reporter: Actor;

async function anActorWith(role: "officer" | "reporter"): Promise<Actor> {
  const account = await prisma.userAccount.findFirstOrThrow({
    where: { institutionId, roles: { some: { role, revokedAt: null } } },
    include: { roles: { where: { revokedAt: null } } },
  });
  return { accountId: account.id, institutionId, roles: account.roles.map((r) => r.role) };
}

async function aReport(): Promise<string> {
  const { referenceCode } = await submitAnonymousReport(
    institutionId,
    {
      title: "Case fixture report",
      description: "A description that comfortably exceeds the minimum length requirement.",
      severitySelfReported: "high",
      categoryId: null,
      locationId: null,
      occurredAt: null,
    },
    meta(),
  );
  const report = await prisma.report.findUniqueOrThrow({ where: { referenceCode } });
  return report.id;
}

beforeAll(async () => {
  const inst = await prisma.institution.findFirstOrThrow({ where: { code: "NGU" } });
  institutionId = inst.id;
  officer = await anActorWith("officer");
  reporter = await anActorWith("reporter");
});

describe("triageReport", () => {
  it("creates a case, links the report, and records the opening history row", async () => {
    const reportId = await aReport();
    const { caseNumber } = await triageReport(
      officer,
      reportId,
      { severity: "high", title: "Suspected paper leak", confidentiality: "standard" },
      meta(),
    );

    const kase = await prisma.case.findFirstOrThrow({
      where: { institutionId, caseNumber },
      include: { reports: true, statusHistory: true },
    });

    expect(kase.reports.map((r) => r.reportId)).toContain(reportId);
    expect(kase.statusHistory.map((h) => h.toStatus)).toContain("submitted");
    expect(kase.slaDueAt.getTime()).toBeGreaterThan(kase.openedAt.getTime());

    const report = await prisma.report.findUniqueOrThrow({ where: { id: reportId } });
    expect(report.status).toBe("triaged");
  });

  it("sets the SLA from severity, not from a constant", async () => {
    const severe = await triageReport(officer, await aReport(),
      { severity: "severe", title: "Severe", confidentiality: "standard" }, meta());
    const low = await triageReport(officer, await aReport(),
      { severity: "low", title: "Low", confidentiality: "standard" }, meta());

    const [s, l] = await Promise.all([
      prisma.case.findFirstOrThrow({ where: { institutionId, caseNumber: severe.caseNumber } }),
      prisma.case.findFirstOrThrow({ where: { institutionId, caseNumber: low.caseNumber } }),
    ]);

    const hours = (c: { openedAt: Date; slaDueAt: Date }) =>
      (c.slaDueAt.getTime() - c.openedAt.getTime()) / 3_600_000;

    expect(Math.round(hours(s))).toBe(24);
    expect(Math.round(hours(l))).toBe(336);
  });

  it("refuses a reporter", async () => {
    await expect(
      triageReport(reporter, await aReport(),
        { severity: "low", title: "Nope", confidentiality: "standard" }, meta()),
    ).rejects.toThrow(/not permitted/i);
  });
});

describe("listCases", () => {
  it("refuses a reporter", async () => {
    await expect(listCases(reporter, {})).rejects.toThrow(/not permitted/i);
  });

  it("returns only the actor's own institution", async () => {
    const cases = await listCases(officer, {});
    expect(cases.every((c) => c.institutionId === institutionId)).toBe(true);
  });
});

describe("getCase", () => {
  it("refuses a sealed case to an admin and allows it to a dpo", async () => {
    const { caseNumber } = await triageReport(officer, await aReport(),
      { severity: "high", title: "Sealed matter", confidentiality: "sealed" }, meta());
    const kase = await prisma.case.findFirstOrThrow({ where: { institutionId, caseNumber } });

    const adminActor: Actor = { ...officer, roles: ["admin"] };
    const dpoActor: Actor = { ...officer, roles: ["dpo"] };

    await expect(getCase(adminActor, kase.id)).rejects.toThrow(/not permitted/i);
    await expect(getCase(dpoActor, kase.id)).resolves.toBeDefined();
  });
});
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `npx vitest run tests/cases.test.ts`
Expected: FAIL — cannot find `../src/server/cases`.

- [ ] **Step 5: Implement the service**

Create `webapp/src/server/cases.ts`:

```ts
import type { CaseStatus, Confidentiality, Severity } from "@prisma/client";
import { prisma } from "@/lib/db";
import { withAudit } from "@/lib/audit/withAudit";
import { requireRole, requireSameInstitution, type Actor } from "@/lib/auth/rbac";
import { ForbiddenError, NotFoundError } from "@/lib/errors";
import type { RequestMeta } from "@/server/accounts";

/** Hours allowed before a case is overdue, by severity. */
const SLA_HOURS: Record<Severity, number> = {
  severe: 24,
  high: 72,
  moderate: 168,
  low: 336,
};

export type TriageInput = {
  severity: Severity;
  title: string;
  confidentiality: Confidentiality;
};

export type CaseFilter = { status?: CaseStatus; severity?: Severity };

export type CaseSummary = {
  id: string;
  institutionId: string;
  caseNumber: string;
  title: string;
  severity: Severity;
  status: CaseStatus;
  slaDueAt: Date;
  assignedOfficerId: string | null;
};

export async function triageReport(
  actor: Actor,
  reportId: string,
  input: TriageInput,
  meta: RequestMeta,
): Promise<{ caseNumber: string }> {
  requireRole(actor, ["officer", "admin"]);

  const report = await prisma.report.findFirst({ where: { id: reportId, deletedAt: null } });
  if (!report) throw new NotFoundError("That report does not exist.");
  requireSameInstitution(actor, report.institutionId);

  const year = new Date().getFullYear();
  const openedAt = new Date();
  const slaDueAt = new Date(openedAt.getTime() + SLA_HOURS[input.severity] * 3_600_000);

  const caseNumber = await prisma.$transaction(async (tx) => {
    const taken = await tx.case.count({
      where: { institutionId: report.institutionId, caseNumber: { startsWith: `CASE-${year}-` } },
    });
    const number = `CASE-${year}-${String(taken + 1).padStart(4, "0")}`;

    const created = await tx.case.create({
      data: {
        institutionId: report.institutionId,
        caseNumber: number,
        title: input.title,
        categoryId: report.categoryId,
        severity: input.severity,
        confidentiality: input.confidentiality,
        status: "submitted",
        openedAt,
        slaDueAt,
      },
    });

    await tx.caseReport.create({
      data: { caseId: created.id, reportId: report.id, isPrimary: true },
    });
    await tx.report.update({ where: { id: report.id }, data: { status: "triaged" } });
    await tx.caseStatusHistory.create({
      data: {
        caseId: created.id,
        fromStatus: null,
        toStatus: "submitted",
        changedById: actor.accountId,
      },
    });
    await withAudit(
      tx,
      {
        actorAccountId: actor.accountId,
        actorLabel: actor.accountId,
        institutionId: report.institutionId,
        requestId: meta.requestId,
        ipHash: meta.ipHash,
        userAgent: meta.userAgent,
      },
      {
        action: "case.opened",
        entityType: "case",
        entityId: created.id,
        after: { caseNumber: number, severity: input.severity, slaDueAt },
      },
    );

    return number;
  });

  return { caseNumber };
}

export async function listCases(actor: Actor, filter: CaseFilter): Promise<CaseSummary[]> {
  requireRole(actor, ["officer", "investigator", "admin"]);

  const rows = await prisma.case.findMany({
    where: {
      institutionId: actor.institutionId,
      deletedAt: null,
      status: filter.status,
      severity: filter.severity,
      // Sealed cases never appear in a queue; only a dpo reaches them by id.
      confidentiality: { not: "sealed" },
    },
    orderBy: { slaDueAt: "asc" },
    take: 200,
  });

  return rows.map((c) => ({
    id: c.id,
    institutionId: c.institutionId,
    caseNumber: c.caseNumber,
    title: c.title,
    severity: c.severity,
    status: c.status,
    slaDueAt: c.slaDueAt,
    assignedOfficerId: c.assignedOfficerId,
  }));
}

export async function getCase(actor: Actor, caseId: string) {
  requireRole(actor, ["officer", "investigator", "admin", "dpo"]);

  const kase = await prisma.case.findFirst({
    where: { id: caseId, deletedAt: null },
    include: { statusHistory: { orderBy: { changedAt: "asc" } } },
  });
  if (!kase) throw new NotFoundError("That case does not exist.");
  requireSameInstitution(actor, kase.institutionId);

  // A seal an admin can lift is decorative, and the cases most worth sealing
  // are the ones involving an admin.
  if (kase.confidentiality === "sealed" && !actor.roles.includes("dpo")) {
    throw new ForbiddenError("You are not permitted to access this record.");
  }

  return {
    id: kase.id,
    institutionId: kase.institutionId,
    caseNumber: kase.caseNumber,
    title: kase.title,
    severity: kase.severity,
    status: kase.status,
    slaDueAt: kase.slaDueAt,
    assignedOfficerId: kase.assignedOfficerId,
    statusHistory: kase.statusHistory.map((h) => ({
      fromStatus: h.fromStatus,
      toStatus: h.toStatus,
      changedAt: h.changedAt,
    })),
  };
}
```

`slaDueAt` is stored rather than derived at read time: changing the SLA policy later must not silently rewrite whether past cases were breached.

The case-number count-and-increment races under concurrency. It is correct for Phase 1's single-officer-at-a-time use and for the seeded demo; **Phase 2 replaces it with a Postgres sequence per institution and year.** Carry that into the Phase 2 plan.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run tests/cases.test.ts`
Expected: 6 passed.

- [ ] **Step 7: Build the queue page**

`webapp/src/app/cases/page.tsx` — a server component calling `listCases` for the signed-in actor, sorted by SLA due date ascending so the most urgent is first, with status and severity filters. Each row shows case number, title, severity, status, assigned officer, and a visible **Overdue** marker where `slaDueAt < now()` and the status is not `resolved` or `closed`.

- [ ] **Step 8: Build the case detail page**

`webapp/src/app/cases/[id]/page.tsx` — calls `getCase`, renders the linked reports, the status history in chronological order, and the SLA clock. A `ForbiddenError` renders as a plain refusal, never a stack trace.

- [ ] **Step 9: Commit**

```bash
git add webapp
git commit -m "Add cases, triage and the officer queue

The SLA deadline is computed from severity at triage and stored on the row. If
it were derived at read time, changing the policy later would silently rewrite
whether past cases had been breached -- the same reasoning the Python half of
this project applies to its own sla_due_at.

Sealed cases are refused to admins, allowed only to the data protection officer,
and excluded from the queue entirely rather than listed and then blocked. An
admin who could read everything would make the seal decorative, and the cases
most worth sealing are the ones involving an admin.

Case numbers are allocated by counting existing rows, which races under
concurrent triage. That is acceptable for phase 1 and is replaced by a per
institution-and-year sequence in phase 2; it is written down here so it is a
known limitation rather than a latent bug."
```

---

## Task 13: The audit log viewer

**Files:**
- Create: `webapp/src/server/audit.ts`, `webapp/src/app/audit/page.tsx`
- Test: `webapp/tests/audit-viewer.test.ts`

**Interfaces:**
- Produces:
  - `type AuditEventView = { id: string; institutionId: string; actorLabel: string; actorUserAccountId: string | null; action: string; entityType: string; entityId: string; occurredAt: Date }`
  - `listAuditEvents(actor: Actor, filter: { entityType?: string; entityId?: string; limit?: number }): Promise<AuditEventView[]>`

- [ ] **Step 1: Write the failing test**

Create `webapp/tests/audit-viewer.test.ts`:

```ts
import { beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../src/lib/db";
import { listAuditEvents } from "../src/server/audit";
import type { Actor } from "../src/lib/auth/rbac";

let base: Actor;

beforeAll(async () => {
  const inst = await prisma.institution.findFirstOrThrow({ where: { code: "NGU" } });
  const account = await prisma.userAccount.findFirstOrThrow({ where: { institutionId: inst.id } });
  base = { accountId: account.id, institutionId: inst.id, roles: [] };
});

describe("listAuditEvents", () => {
  it("allows admin and dpo", async () => {
    await expect(listAuditEvents({ ...base, roles: ["admin"] }, {})).resolves.toBeDefined();
    await expect(listAuditEvents({ ...base, roles: ["dpo"] }, {})).resolves.toBeDefined();
  });

  it("refuses officer, investigator and reporter", async () => {
    for (const role of ["officer", "investigator", "reporter"] as const) {
      await expect(listAuditEvents({ ...base, roles: [role] }, {})).rejects.toThrow(/not permitted/i);
    }
  });

  it("returns only the actor's institution", async () => {
    const events = await listAuditEvents({ ...base, roles: ["admin"] }, { limit: 200 });
    expect(events.every((e) => e.institutionId === base.institutionId)).toBe(true);
  });

  it("orders newest first", async () => {
    const events = await listAuditEvents({ ...base, roles: ["admin"] }, { limit: 50 });
    const times = events.map((e) => e.occurredAt.getTime());
    expect([...times].sort((a, b) => b - a)).toEqual(times);
  });

  it("returns the id as a string, not a BigInt", async () => {
    const [first] = await listAuditEvents({ ...base, roles: ["admin"] }, { limit: 1 });
    expect(typeof first.id).toBe("string");
  });
});
```

The last test exists because `BigInt` cannot cross the server-component boundary and the failure surfaces far from its cause.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/audit-viewer.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `webapp/src/server/audit.ts`:

```ts
import { prisma } from "@/lib/db";
import { requireRole, type Actor } from "@/lib/auth/rbac";

export type AuditEventView = {
  id: string;
  institutionId: string;
  actorLabel: string;
  actorUserAccountId: string | null;
  action: string;
  entityType: string;
  entityId: string;
  occurredAt: Date;
};

export async function listAuditEvents(
  actor: Actor,
  filter: { entityType?: string; entityId?: string; limit?: number },
): Promise<AuditEventView[]> {
  requireRole(actor, ["admin", "dpo"]);

  const rows = await prisma.auditEvent.findMany({
    where: {
      institutionId: actor.institutionId,
      entityType: filter.entityType,
      entityId: filter.entityId,
    },
    orderBy: { occurredAt: "desc" },
    take: Math.min(filter.limit ?? 100, 500),
  });

  return rows.map((e) => ({
    // BigInt does not cross the server-component boundary; stringify here.
    id: e.id.toString(),
    institutionId: e.institutionId,
    actorLabel: e.actorLabel,
    actorUserAccountId: e.actorUserAccountId,
    action: e.action,
    entityType: e.entityType,
    entityId: e.entityId,
    occurredAt: e.occurredAt,
  }));
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/audit-viewer.test.ts`
Expected: 5 passed.

- [ ] **Step 5: Build the viewer page**

`webapp/src/app/audit/page.tsx` — a table of time, actor, action, entity type and entity id, with filters for entity type and action. Render `actorLabel` when `actorUserAccountId` is null, so anonymous and system activity is visibly distinct from a named person's rather than showing as an empty cell that reads like missing data.

- [ ] **Step 6: Commit**

```bash
git add webapp
git commit -m "Add the audit log viewer for admins and the data protection officer

Officers and investigators are refused. They are the people the log most often
records, and letting the subject of a record read the record is how a log stops
being evidence.

Ids are stringified at the service boundary. BigInt does not survive the
server-component boundary, and the resulting error surfaces far from its cause."
```

---

## Task 14: Phase 1 verification and documentation

**Files:**
- Create: `webapp/scripts/verify.ts`, `webapp/README.md`
- Modify: `webapp/package.json`

**Interfaces:**
- Produces: `npm run verify` — prints a table of checks and exits non-zero if any fails.

- [ ] **Step 1: Write the verification script**

Create `webapp/scripts/verify.ts`. It asserts, over whatever the database currently holds — not over what a test just created:

1. no report has `is_anonymous = true` together with a non-null `reporter_user_id`;
2. no report has `is_anonymous = false` with a null `reporter_user_id`;
3. every case has at least one linked report;
4. every case's current status appears somewhere in its `case_status_history`;
5. every case has `sla_due_at > opened_at`;
6. no `submitted_at`, `opened_at` or `occurred_at` lies in the future;
7. every `user_accounts` row's `institution_id` matches its `campuspulse.users` row;
8. every `reports` row has at least one `report.submitted` audit event.

Print a table of check, expected, observed and PASS/FAIL, then exit 1 if any failed — the same shape as `03_Verify_Data.py`, so both halves of the capstone report in one voice.

- [ ] **Step 2: Add the script and run it**

Add `"verify": "tsx scripts/verify.ts"` to `webapp/package.json`.

Run: `npm run seed && npm run verify`
Expected: all checks PASS, exit code 0.

- [ ] **Step 3: Deliberately break an invariant and confirm the script catches it**

```bash
docker compose exec -T db psql -U compliance -d compliance -c "ALTER TABLE compliance.reports DROP CONSTRAINT reports_anonymity_coherent;"
docker compose exec -T db psql -U compliance -d compliance -c "UPDATE compliance.reports SET reporter_user_id = (SELECT id FROM compliance.user_accounts LIMIT 1) WHERE is_anonymous = true;"
npm run verify
```
Expected: check 1 FAILS and the exit code is 1.

Then restore:
```bash
npx prisma migrate reset --force
npm run seed
npm run verify
```
Expected: all PASS again.

A verification script that has never been seen to fail is not evidence of anything.

- [ ] **Step 4: Write the README**

Create `webapp/README.md` covering: prerequisites (Node 24, Docker); setup (`docker compose up -d`, apply the fixture, `npx prisma migrate dev`, `npm run seed`); the seeded accounts and the shared demo passphrase; architecture (the service-layer rule, the audit guarantee, the read-only `campuspulse` boundary); how to run `npm test` and `npm run verify`; and an explicit **Known limitations** section listing:

- JWT sessions rather than revocable database sessions (Phase 2);
- the in-memory rate limiter's single-process assumption;
- case numbers allocated by counting, which races under concurrent triage (Phase 2);
- no evidence upload or malware scanning yet (Phase 2).

- [ ] **Step 5: Run the full suite**

Run: `npm test && npm run verify`
Expected: every test passes and every check PASSes.

- [ ] **Step 6: Commit**

```bash
git add webapp
git commit -m "Add phase 1 verification and documentation

verify.ts checks invariants against whatever is in the database rather than
against what the tests just created, which is how the Python half of this
project found its real bugs. Step 3 of this task deliberately breaks a
constraint and confirms the script fails: a verification script never seen to
fail is not evidence of anything.

The README states known limitations plainly -- JWT sessions instead of revocable
database sessions, a per-process rate limiter, racy case numbering, no evidence
handling yet. Each is a deliberate phase 1 boundary, and writing them down is
the difference between a known limitation and an undiscovered defect."
```

---

## Self-Review

**Spec coverage.** Spec §3 architecture → Tasks 1–2. §4.1 enums → Tasks 5, 10, 12. §4.2 identity → Task 5. §4.3 intake → Task 10. §4.4 cases → Task 12 (parties, notes, outcomes and sanctions are Phase 2, per the spec's own phase table). §4.7 audit → Tasks 3 and 13. §4.8 indexing → Tasks 3, 10, 12. §5.1 authentication → Tasks 4 and 6. §5.2 authorisation → Task 7. §5.3 anonymous reporting → Tasks 9, 10, 11. §8.4 verification → Task 14. §9 non-functional: validation → Task 10, errors → Task 4, configuration → Task 1. Spec §4.5 policy, §4.6 evidence, §6 transitions, §7 storage and §8.1–8.3 simulator are Phase 2 and 3 by design.

**Known deviations from the spec**, each recorded in the code, the commit message and the README rather than left silent:
1. §5.1 specifies database-backed sessions; Task 6 ships JWT with an 8-hour cap and defers the adapter to Phase 2.
2. Task 12 allocates case numbers by counting, which races under concurrent triage; Phase 2 replaces it with a per institution-and-year sequence.

**Type consistency.** `Actor`, `RequestMeta`, `AuthenticatedAccount`, `AuditContext`, `AuditEventInput`, `ReportInput`, `ReportStatusView`, `TriageInput`, `CaseFilter`, `CaseSummary`, `AuditEventView` are each defined once, in one file, and referenced by the same name everywhere. `withAudit(tx, ctx, event)` has the same three-argument shape at every call site. `requireRole` returns `Actor`; `requireSameInstitution` returns `void`. `assertRateLimit(key, limit, windowMs)` matches its use in Task 11 and its appearance in Task 7's `CHECKS` list. `hashPassword`/`verifyPassword` are imported in Tasks 6 and 8 exactly as defined in Task 4.

**Placeholders.** None. Tasks 10 §10, 11 §6, 12 §7–8, 13 §5 and 14 §1 and §4 describe UI and script work in prose rather than full listings; each names the exact function called, its ordering, its filters and its edge cases, and each is preceded by a test that pins the behaviour. Every function referenced by a later task is defined with its full signature in an earlier one.

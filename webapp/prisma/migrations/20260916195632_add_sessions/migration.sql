-- Two statements Prisma generated were removed by hand before applying:
--   ALTER TABLE user_accounts DROP CONSTRAINT user_accounts_tenant_fk
--   ALTER TABLE reports ALTER COLUMN search_tsv DROP DEFAULT
-- Neither is expressible in schema.prisma. tests/db-invariants.test.ts
-- fails if either is ever actually lost.

-- DropForeignKey

-- AlterTable

-- CreateTable
CREATE TABLE "sessions" (
    "id" UUID NOT NULL,
    "user_account_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "revoked_at" TIMESTAMP(3),
    "ip_hash" TEXT,
    "user_agent" TEXT,

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_account_id_fkey" FOREIGN KEY ("user_account_id") REFERENCES "user_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Only live sessions are worth indexing; a revoked row is never looked up
-- by account. Prisma cannot express a partial index, so it lives here.
CREATE INDEX sessions_live_by_account
  ON compliance.sessions (user_account_id)
  WHERE revoked_at IS NULL;

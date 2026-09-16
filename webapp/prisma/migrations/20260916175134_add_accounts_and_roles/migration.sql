-- CreateEnum
CREATE TYPE "compliance_role" AS ENUM ('reporter', 'officer', 'investigator', 'admin', 'dpo');

-- CreateTable
CREATE TABLE "user_accounts" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "institution_id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "password_changed_at" TIMESTAMP(3),
    "failed_login_count" INTEGER NOT NULL DEFAULT 0,
    "locked_until" TIMESTAMP(3),
    "last_login_at" TIMESTAMP(3),
    "must_change_password" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "user_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "role_assignments" (
    "id" UUID NOT NULL,
    "user_account_id" UUID NOT NULL,
    "role" "compliance_role" NOT NULL,
    "scope_department" TEXT,
    "granted_by" UUID,
    "granted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked_at" TIMESTAMP(3),

    CONSTRAINT "role_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "user_accounts_user_id_key" ON "user_accounts"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "user_accounts_institution_id_email_key" ON "user_accounts"("institution_id", "email");

-- CreateIndex
CREATE INDEX "role_assignments_user_account_id_revoked_at_idx" ON "role_assignments"("user_account_id", "revoked_at");

-- AddForeignKey
ALTER TABLE "user_accounts" ADD CONSTRAINT "user_accounts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "campuspulse"."users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_assignments" ADD CONSTRAINT "role_assignments_user_account_id_fkey" FOREIGN KEY ("user_account_id") REFERENCES "user_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_assignments" ADD CONSTRAINT "role_assignments_granted_by_fkey" FOREIGN KEY ("granted_by") REFERENCES "user_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Tenant safety: an account cannot reference a user from another institution.
ALTER TABLE compliance.user_accounts
  ADD CONSTRAINT user_accounts_tenant_fk
  FOREIGN KEY (user_id, institution_id)
  REFERENCES campuspulse.users (id, institution_id);

-- A role may be granted, revoked, and granted again; only the live grant is unique.
CREATE UNIQUE INDEX role_assignments_live_unique
  ON compliance.role_assignments (user_account_id, role, COALESCE(scope_department, ''))
  WHERE revoked_at IS NULL;

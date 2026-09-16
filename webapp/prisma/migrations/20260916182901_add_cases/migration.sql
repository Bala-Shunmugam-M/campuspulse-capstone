-- Two statements Prisma generated were removed by hand before applying:
--   ALTER TABLE user_accounts DROP CONSTRAINT user_accounts_tenant_fk
--   ALTER TABLE reports ALTER COLUMN search_tsv DROP DEFAULT
-- Neither is expressible in schema.prisma, so Prisma Migrate proposes
-- removing them on every generated migration. tests/db-invariants.test.ts
-- fails if either is ever actually lost.

-- CreateEnum
CREATE TYPE "case_status" AS ENUM ('submitted', 'triaged', 'under_investigation', 'pending_decision', 'resolved', 'closed', 'dismissed', 'appealed');

-- CreateEnum
CREATE TYPE "confidentiality" AS ENUM ('standard', 'restricted', 'sealed');

-- DropForeignKey

-- AlterTable

-- CreateTable
CREATE TABLE "cases" (
    "id" UUID NOT NULL,
    "institution_id" UUID NOT NULL,
    "case_number" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "summary" TEXT,
    "category_id" UUID,
    "severity" "severity" NOT NULL,
    "status" "case_status" NOT NULL DEFAULT 'submitted',
    "assigned_officer_id" UUID,
    "opened_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sla_due_at" TIMESTAMP(3) NOT NULL,
    "first_response_at" TIMESTAMP(3),
    "resolved_at" TIMESTAMP(3),
    "closed_at" TIMESTAMP(3),
    "confidentiality" "confidentiality" NOT NULL DEFAULT 'standard',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "cases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "case_reports" (
    "case_id" UUID NOT NULL,
    "report_id" UUID NOT NULL,
    "is_primary" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "case_reports_pkey" PRIMARY KEY ("case_id","report_id")
);

-- CreateTable
CREATE TABLE "case_status_history" (
    "id" UUID NOT NULL,
    "case_id" UUID NOT NULL,
    "from_status" "case_status",
    "to_status" "case_status" NOT NULL,
    "changed_by" UUID,
    "reason" TEXT,
    "changed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "case_status_history_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "cases_institution_id_status_sla_due_at_idx" ON "cases"("institution_id", "status", "sla_due_at");

-- CreateIndex
CREATE INDEX "cases_assigned_officer_id_status_idx" ON "cases"("assigned_officer_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "cases_institution_id_case_number_key" ON "cases"("institution_id", "case_number");

-- CreateIndex
CREATE INDEX "case_status_history_case_id_changed_at_idx" ON "case_status_history"("case_id", "changed_at");

-- AddForeignKey
ALTER TABLE "cases" ADD CONSTRAINT "cases_assigned_officer_id_fkey" FOREIGN KEY ("assigned_officer_id") REFERENCES "user_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "case_reports" ADD CONSTRAINT "case_reports_case_id_fkey" FOREIGN KEY ("case_id") REFERENCES "cases"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "case_status_history" ADD CONSTRAINT "case_status_history_case_id_fkey" FOREIGN KEY ("case_id") REFERENCES "cases"("id") ON DELETE CASCADE ON UPDATE CASCADE;

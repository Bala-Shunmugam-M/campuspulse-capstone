-- CreateEnum
CREATE TYPE "severity" AS ENUM ('low', 'moderate', 'high', 'severe');

-- CreateEnum
CREATE TYPE "report_channel" AS ENUM ('web', 'kiosk', 'email_ingest', 'phone_transcribed');

-- CreateEnum
CREATE TYPE "report_status" AS ENUM ('received', 'triaged', 'merged', 'rejected');

-- DropForeignKey
ALTER TABLE "user_accounts" DROP CONSTRAINT "user_accounts_tenant_fk";

-- CreateTable
CREATE TABLE "reports" (
    "id" UUID NOT NULL,
    "institution_id" UUID NOT NULL,
    "reference_code" TEXT NOT NULL,
    "access_secret_hash" TEXT,
    "reporter_user_id" UUID,
    "is_anonymous" BOOLEAN NOT NULL,
    "category_id" UUID,
    "location_id" UUID,
    "occurred_at" TIMESTAMP(3),
    "submitted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "severity_self_reported" "severity" NOT NULL,
    "channel" "report_channel" NOT NULL,
    "status" "report_status" NOT NULL DEFAULT 'received',
    "ip_hash" TEXT,
    "user_agent" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "reports_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "reports_reference_code_key" ON "reports"("reference_code");

-- CreateIndex
CREATE INDEX "reports_institution_id_status_submitted_at_idx" ON "reports"("institution_id", "status", "submitted_at" DESC);

-- AddForeignKey
ALTER TABLE "reports" ADD CONSTRAINT "reports_reporter_user_id_fkey" FOREIGN KEY ("reporter_user_id") REFERENCES "user_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Anonymity is a database invariant, not only service logic: an anonymous
-- report that quietly carries a reporter id looks correct in the interface.
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

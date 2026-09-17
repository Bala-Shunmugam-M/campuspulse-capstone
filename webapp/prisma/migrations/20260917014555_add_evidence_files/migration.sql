-- Prisma-generated destructive statements removed by hand (see README §4).

-- CreateEnum
CREATE TYPE "scan_status" AS ENUM ('pending', 'clean', 'flagged', 'skipped');

-- DropForeignKey

-- AlterTable

-- CreateTable
CREATE TABLE "evidence_files" (
    "id" UUID NOT NULL,
    "institution_id" UUID NOT NULL,
    "case_id" UUID,
    "report_id" UUID,
    "uploaded_by" UUID,
    "storage_key" TEXT NOT NULL,
    "original_filename" TEXT NOT NULL,
    "mime_type" TEXT NOT NULL,
    "byte_size" BIGINT NOT NULL,
    "sha256" CHAR(64) NOT NULL,
    "scan_status" "scan_status" NOT NULL DEFAULT 'pending',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "evidence_files_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "evidence_files_storage_key_key" ON "evidence_files"("storage_key");

-- CreateIndex
CREATE INDEX "evidence_files_case_id_deleted_at_idx" ON "evidence_files"("case_id", "deleted_at");

-- CreateIndex
CREATE INDEX "evidence_files_report_id_deleted_at_idx" ON "evidence_files"("report_id", "deleted_at");

-- AddForeignKey
ALTER TABLE "evidence_files" ADD CONSTRAINT "evidence_files_case_id_fkey" FOREIGN KEY ("case_id") REFERENCES "cases"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "evidence_files" ADD CONSTRAINT "evidence_files_report_id_fkey" FOREIGN KEY ("report_id") REFERENCES "reports"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "evidence_files" ADD CONSTRAINT "evidence_files_uploaded_by_fkey" FOREIGN KEY ("uploaded_by") REFERENCES "user_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Evidence belongs to a case or a report. An orphan is a bug, so the schema
-- refuses to hold one.
ALTER TABLE compliance.evidence_files
  ADD CONSTRAINT evidence_files_attached CHECK (
    case_id IS NOT NULL OR report_id IS NOT NULL
  );

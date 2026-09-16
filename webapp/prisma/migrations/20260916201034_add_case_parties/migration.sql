-- Prisma-generated statements removed by hand before applying (see README §4).

-- CreateEnum
CREATE TYPE "party_role" AS ENUM ('complainant', 'respondent', 'witness', 'advisor');

-- DropForeignKey

-- AlterTable

-- CreateTable
CREATE TABLE "case_parties" (
    "id" UUID NOT NULL,
    "case_id" UUID NOT NULL,
    "user_account_id" UUID,
    "external_name" TEXT,
    "party_role" "party_role" NOT NULL,
    "is_anonymous" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "case_parties_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "case_parties_case_id_deleted_at_idx" ON "case_parties"("case_id", "deleted_at");

-- AddForeignKey
ALTER TABLE "case_parties" ADD CONSTRAINT "case_parties_case_id_fkey" FOREIGN KEY ("case_id") REFERENCES "cases"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "case_parties" ADD CONSTRAINT "case_parties_user_account_id_fkey" FOREIGN KEY ("user_account_id") REFERENCES "user_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- A party is an account, or a name, or anonymous with neither. Anything else
-- is a half-filled row pretending to identify someone.
ALTER TABLE compliance.case_parties
  ADD CONSTRAINT case_parties_identified CHECK (
    (user_account_id IS NOT NULL AND external_name IS NULL)
    OR (user_account_id IS NULL AND external_name IS NOT NULL)
    OR (is_anonymous AND user_account_id IS NULL AND external_name IS NULL)
  );

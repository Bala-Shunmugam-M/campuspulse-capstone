-- Prisma-generated destructive statements removed by hand (see README §4).

-- CreateEnum
CREATE TYPE "finding" AS ENUM ('upheld', 'partially_upheld', 'not_upheld', 'inconclusive');

-- CreateEnum
CREATE TYPE "sanction_type" AS ENUM ('warning', 'written_reprimand', 'probation', 'suspension', 'community_service', 'restitution', 'referral', 'no_action');

-- DropForeignKey

-- AlterTable

-- CreateTable
CREATE TABLE "outcomes" (
    "id" UUID NOT NULL,
    "case_id" UUID NOT NULL,
    "finding" "finding" NOT NULL,
    "rationale" TEXT NOT NULL,
    "decided_by" UUID NOT NULL,
    "decided_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "outcomes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sanctions" (
    "id" UUID NOT NULL,
    "outcome_id" UUID NOT NULL,
    "subject_party_id" UUID NOT NULL,
    "sanction_type" "sanction_type" NOT NULL,
    "description" TEXT NOT NULL,
    "effective_from" DATE NOT NULL,
    "effective_to" DATE,
    "status" TEXT NOT NULL DEFAULT 'active',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sanctions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "outcomes_case_id_key" ON "outcomes"("case_id");

-- CreateIndex
CREATE INDEX "sanctions_outcome_id_idx" ON "sanctions"("outcome_id");

-- AddForeignKey
ALTER TABLE "outcomes" ADD CONSTRAINT "outcomes_case_id_fkey" FOREIGN KEY ("case_id") REFERENCES "cases"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outcomes" ADD CONSTRAINT "outcomes_decided_by_fkey" FOREIGN KEY ("decided_by") REFERENCES "user_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sanctions" ADD CONSTRAINT "sanctions_outcome_id_fkey" FOREIGN KEY ("outcome_id") REFERENCES "outcomes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sanctions" ADD CONSTRAINT "sanctions_subject_party_id_fkey" FOREIGN KEY ("subject_party_id") REFERENCES "case_parties"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- A sanction that ends before it begins is not a date range.
ALTER TABLE compliance.sanctions
  ADD CONSTRAINT sanctions_effective_range CHECK (
    effective_to IS NULL OR effective_to > effective_from
  );

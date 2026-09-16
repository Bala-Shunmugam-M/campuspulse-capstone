-- Prisma-generated destructive statements removed by hand (see README §4).

-- CreateEnum
CREATE TYPE "note_visibility" AS ENUM ('internal', 'shared_with_parties', 'reporter_visible');

-- DropForeignKey

-- AlterTable

-- CreateTable
CREATE TABLE "case_notes" (
    "id" UUID NOT NULL,
    "case_id" UUID NOT NULL,
    "author_id" UUID NOT NULL,
    "body" TEXT NOT NULL,
    "visibility" "note_visibility" NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "case_notes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "case_notes_case_id_deleted_at_created_at_idx" ON "case_notes"("case_id", "deleted_at", "created_at");

-- AddForeignKey
ALTER TABLE "case_notes" ADD CONSTRAINT "case_notes_case_id_fkey" FOREIGN KEY ("case_id") REFERENCES "cases"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "case_notes" ADD CONSTRAINT "case_notes_author_id_fkey" FOREIGN KEY ("author_id") REFERENCES "user_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

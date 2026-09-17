-- Prisma-generated destructive statements removed by hand (see README §4).

-- DropForeignKey

-- AlterTable

-- CreateTable
CREATE TABLE "notifications" (
    "id" UUID NOT NULL,
    "recipient_id" UUID NOT NULL,
    "case_id" UUID,
    "channel" "report_channel" NOT NULL DEFAULT 'web',
    "subject" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "is_read" BOOLEAN NOT NULL DEFAULT false,
    "read_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "notifications_recipient_id_created_at_idx" ON "notifications"("recipient_id", "created_at");

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_recipient_id_fkey" FOREIGN KEY ("recipient_id") REFERENCES "user_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_case_id_fkey" FOREIGN KEY ("case_id") REFERENCES "cases"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- The badge only ever counts unread rows, so only unread rows are indexed.
CREATE INDEX notifications_unread_by_recipient
  ON compliance.notifications (recipient_id)
  WHERE is_read = false;

-- The feed is a view over audit_events, not a second table. The same event
-- written twice is an event that can disagree with itself.
CREATE OR REPLACE VIEW compliance.activity_feed AS
SELECT a.id, a.institution_id, a.action, a.entity_type, a.entity_id,
       a.actor_label, a.actor_user_account_id, ua.email AS actor_email,
       a.occurred_at
FROM compliance.audit_events a
LEFT JOIN compliance.user_accounts ua ON ua.id = a.actor_user_account_id
WHERE a.action NOT LIKE 'auth.%'
  AND a.action NOT IN ('case.note_added', 'case.note_updated', 'case.note_removed');

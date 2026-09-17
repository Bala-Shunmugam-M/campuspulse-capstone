-- Prisma generated three statements that were deleted from this file by hand:
--   ALTER TABLE "user_accounts" DROP CONSTRAINT "user_accounts_tenant_fk";
--   ALTER TABLE "policy_versions" ALTER COLUMN "body_tsv" DROP DEFAULT;
--   ALTER TABLE "reports"         ALTER COLUMN "search_tsv" DROP DEFAULT;
-- Each removes or alters hand-written SQL that schema.prisma cannot describe.
-- The first has already cost this repository its tenant boundary once.

-- Phase 2 wrote actor_label as the actor's account id, so the audit viewer and
-- the activity feed show a uuid where an anonymous action shows "anonymous".
-- Every call site now passes the email; these are the rows written before that.
--
-- audit_events carries a BEFORE UPDATE trigger that refuses every update, so
-- this backfill has to drop it and put it back. That is a serious thing to do
-- to an append-only table and it is done here for one narrow reason: actor_label
-- is a display field, a second rendering of actor_user_account_id, which is the
-- column that actually identifies the actor and is not touched. Rewriting it
-- changes how an event reads, not what it records -- no action, entity,
-- timestamp, before/after payload or actor id is altered, and the WHERE clause
-- confines the change to rows whose label is literally their own actor id.
-- Prisma runs each migration file in one transaction, so the table is never
-- observable without its trigger.
--
-- This is the only reason that justifies it. Any future change wanting the same
-- exemption is almost certainly rewriting history rather than correcting a label.

DROP TRIGGER audit_events_no_update ON compliance.audit_events;

UPDATE compliance.audit_events
SET actor_label = ua.email
FROM compliance.user_accounts ua
WHERE ua.id = audit_events.actor_user_account_id
  AND actor_label = actor_user_account_id::text;

CREATE TRIGGER audit_events_no_update
  BEFORE UPDATE ON compliance.audit_events
  FOR EACH ROW EXECUTE FUNCTION compliance.audit_events_immutable();

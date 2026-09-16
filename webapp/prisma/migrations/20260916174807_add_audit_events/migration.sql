-- The compliance schema is this application's own; campuspulse already exists.
CREATE SCHEMA IF NOT EXISTS "compliance";

-- CreateTable
CREATE TABLE "audit_events" (
    "id" BIGSERIAL NOT NULL,
    "institution_id" UUID NOT NULL,
    "actor_user_account_id" UUID,
    "actor_label" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" UUID NOT NULL,
    "before" JSONB,
    "after" JSONB,
    "request_id" UUID NOT NULL,
    "ip_hash" TEXT,
    "user_agent" TEXT,
    "occurred_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "audit_events_entity_type_entity_id_occurred_at_idx" ON "audit_events"("entity_type", "entity_id", "occurred_at" DESC);

-- CreateIndex
CREATE INDEX "audit_events_institution_id_occurred_at_idx" ON "audit_events"("institution_id", "occurred_at" DESC);

-- Append-only enforcement. A trigger rather than a REVOKE, because in
-- development the application connects as the schema owner and an owner can
-- grant privileges back to itself. A trigger binds regardless of role.
CREATE OR REPLACE FUNCTION compliance.audit_events_immutable()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_events is append-only (attempted %)', TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE TRIGGER audit_events_no_update
  BEFORE UPDATE ON compliance.audit_events
  FOR EACH ROW EXECUTE FUNCTION compliance.audit_events_immutable();

CREATE TRIGGER audit_events_no_delete
  BEFORE DELETE ON compliance.audit_events
  FOR EACH ROW EXECUTE FUNCTION compliance.audit_events_immutable();

-- Prisma generated two statements that were deleted from this file by hand:
--   ALTER TABLE "user_accounts" DROP CONSTRAINT "user_accounts_tenant_fk";
--   ALTER TABLE "reports" ALTER COLUMN "search_tsv" DROP DEFAULT;
-- Both remove hand-written SQL that schema.prisma cannot describe. The first has
-- already cost this repository its tenant boundary once.

-- CreateTable
CREATE TABLE "policies" (
    "id" UUID NOT NULL,
    "institution_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "owner_department" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "policies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
-- body_tsv is absent here on purpose: Prisma writes it as a plain column, and it
-- is added as GENERATED ALWAYS below so Postgres maintains it.
CREATE TABLE "policy_versions" (
    "id" UUID NOT NULL,
    "policy_id" UUID NOT NULL,
    "version_no" INTEGER NOT NULL,
    "body_markdown" TEXT NOT NULL,
    "summary" TEXT,
    "effective_from" DATE NOT NULL,
    "effective_to" DATE,
    "published_by" UUID,
    "published_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "policy_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "policy_acknowledgements" (
    "id" UUID NOT NULL,
    "policy_version_id" UUID NOT NULL,
    "user_account_id" UUID NOT NULL,
    "acknowledged_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "policy_acknowledgements_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "policies_institution_id_is_active_idx" ON "policies"("institution_id", "is_active");

-- CreateIndex
CREATE UNIQUE INDEX "policies_institution_id_code_key" ON "policies"("institution_id", "code");

-- CreateIndex
CREATE INDEX "policy_versions_policy_id_effective_from_idx" ON "policy_versions"("policy_id", "effective_from");

-- CreateIndex
CREATE UNIQUE INDEX "policy_versions_policy_id_version_no_key" ON "policy_versions"("policy_id", "version_no");

-- CreateIndex
CREATE INDEX "policy_acknowledgements_user_account_id_acknowledged_at_idx" ON "policy_acknowledgements"("user_account_id", "acknowledged_at");

-- CreateIndex
CREATE UNIQUE INDEX "policy_acknowledgements_policy_version_id_user_account_id_key" ON "policy_acknowledgements"("policy_version_id", "user_account_id");

-- AddForeignKey
ALTER TABLE "policy_versions" ADD CONSTRAINT "policy_versions_policy_id_fkey" FOREIGN KEY ("policy_id") REFERENCES "policies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "policy_versions" ADD CONSTRAINT "policy_versions_published_by_fkey" FOREIGN KEY ("published_by") REFERENCES "user_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "policy_acknowledgements" ADD CONSTRAINT "policy_acknowledgements_policy_version_id_fkey" FOREIGN KEY ("policy_version_id") REFERENCES "policy_versions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "policy_acknowledgements" ADD CONSTRAINT "policy_acknowledgements_user_account_id_fkey" FOREIGN KEY ("user_account_id") REFERENCES "user_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Full-text search over what a policy actually says. Maintained by Postgres, the
-- same arrangement reports.search_tsv uses.
ALTER TABLE compliance.policy_versions
  ADD COLUMN body_tsv tsvector
  GENERATED ALWAYS AS (
    to_tsvector('english', coalesce(summary, '') || ' ' || coalesce(body_markdown, ''))
  ) STORED;

CREATE INDEX policy_versions_body_idx ON compliance.policy_versions USING GIN (body_tsv);

-- A published version is immutable except for effective_to. "The policy said
-- something different when I signed it" is precisely the claim this table exists
-- to refute, so the refusal lives in the database rather than in a service that
-- could be bypassed. Drafts stay editable: nobody has acknowledged them.
CREATE OR REPLACE FUNCTION compliance.policy_versions_immutable()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.published_at IS NULL THEN RETURN NEW; END IF;   -- drafts are editable
  IF NEW.body_markdown  IS DISTINCT FROM OLD.body_markdown
     OR NEW.summary        IS DISTINCT FROM OLD.summary
     OR NEW.version_no     IS DISTINCT FROM OLD.version_no
     OR NEW.effective_from IS DISTINCT FROM OLD.effective_from
     OR NEW.published_at   IS DISTINCT FROM OLD.published_at
     OR NEW.published_by   IS DISTINCT FROM OLD.published_by THEN
    RAISE EXCEPTION 'a published policy version is immutable except for effective_to'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER policy_versions_no_edit_after_publish
  BEFORE UPDATE ON compliance.policy_versions
  FOR EACH ROW EXECUTE FUNCTION compliance.policy_versions_immutable();

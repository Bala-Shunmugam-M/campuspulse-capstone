-- Restores the composite foreign key that add_reports dropped.
--
-- Prisma Migrate diffs the whole datasource against schema.prisma and removes
-- anything it cannot see. A composite foreign key onto (id, institution_id) is
-- not expressible in the Prisma schema, so every generated migration will try
-- to drop this again. tests/db-invariants.test.ts asserts it exists, so the
-- next time that happens the suite fails instead of the tenant boundary
-- quietly disappearing.
ALTER TABLE compliance.user_accounts
  ADD CONSTRAINT user_accounts_tenant_fk
  FOREIGN KEY (user_id, institution_id)
  REFERENCES campuspulse.users (id, institution_id);

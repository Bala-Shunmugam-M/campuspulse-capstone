-- Two statements Prisma generated were removed by hand before applying:
--   ALTER TABLE user_accounts DROP CONSTRAINT user_accounts_tenant_fk
--   ALTER TABLE reports ALTER COLUMN search_tsv DROP DEFAULT
-- Neither is expressible in schema.prisma, so Prisma Migrate proposes removing
-- them on every generated migration. tests/db-invariants.test.ts fails if
-- either is ever actually lost.

-- CreateTable
CREATE TABLE "case_number_counters" (
    "institution_id" UUID NOT NULL,
    "year" INTEGER NOT NULL,
    "next_value" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "case_number_counters_pkey" PRIMARY KEY ("institution_id","year")
);

-- Allocates the next case number for one institution and year, atomically.
-- ON CONFLICT DO UPDATE takes a row lock, so concurrent callers serialise here
-- instead of all reading the same count and colliding on the unique index.
CREATE OR REPLACE FUNCTION compliance.next_case_number(p_institution uuid, p_year int)
RETURNS text LANGUAGE plpgsql AS $$
DECLARE v int;
BEGIN
  INSERT INTO compliance.case_number_counters (institution_id, year, next_value)
  VALUES (p_institution, p_year, 2)
  ON CONFLICT (institution_id, year)
    DO UPDATE SET next_value = compliance.case_number_counters.next_value + 1
  RETURNING next_value - 1 INTO v;
  RETURN 'CASE-' || p_year || '-' || lpad(v::text, 4, '0');
END;
$$;

-- Continue existing numbering rather than restarting over live rows.
INSERT INTO compliance.case_number_counters (institution_id, year, next_value)
SELECT c.institution_id,
       CAST(split_part(c.case_number, '-', 2) AS int),
       MAX(CAST(split_part(c.case_number, '-', 3) AS int)) + 1
FROM compliance.cases c
WHERE c.case_number ~ '^CASE-[0-9]{4}-[0-9]+$'
GROUP BY c.institution_id, CAST(split_part(c.case_number, '-', 2) AS int)
ON CONFLICT (institution_id, year) DO UPDATE
  SET next_value = GREATEST(compliance.case_number_counters.next_value, EXCLUDED.next_value);

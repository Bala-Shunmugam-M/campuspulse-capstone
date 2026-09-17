-- Prisma-generated destructive statements removed by hand (see README §4).

-- DropForeignKey

-- AlterTable

-- CreateTable
CREATE TABLE "rate_limit_buckets" (
    "key" TEXT NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,
    "window_start" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "rate_limit_buckets_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE INDEX "rate_limit_buckets_window_start_idx" ON "rate_limit_buckets"("window_start");

-- One statement: start a window or increment it, and return the count that
-- results. Read-then-write would let two processes both see the limit unmet.
CREATE OR REPLACE FUNCTION compliance.bump_rate_limit(
  p_key text, p_window_ms bigint
) RETURNS int LANGUAGE plpgsql AS $fn$
DECLARE v int;
BEGIN
  INSERT INTO compliance.rate_limit_buckets AS b (key, count, window_start)
  VALUES (p_key, 1, now())
  ON CONFLICT (key) DO UPDATE
    SET count = CASE
          WHEN b.window_start + (p_window_ms || ' milliseconds')::interval <= now() THEN 1
          ELSE b.count + 1
        END,
        window_start = CASE
          WHEN b.window_start + (p_window_ms || ' milliseconds')::interval <= now() THEN now()
          ELSE b.window_start
        END
  RETURNING count INTO v;
  RETURN v;
END;
$fn$;

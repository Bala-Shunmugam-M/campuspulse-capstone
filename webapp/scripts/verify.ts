import { prisma } from "../src/lib/db";

/**
 * Checks invariants against whatever the database currently holds, not against
 * what a test just created. Same shape as 03_Verify_Data.py, so both halves of
 * the capstone report in one voice.
 */

type Check = { name: string; expected: string; observed: string; pass: boolean };

async function scalar(rows: Promise<{ n: bigint }[]>): Promise<number> {
  return Number((await rows)[0].n);
}

async function main() {
  const checks: Check[] = [];

  const add = (name: string, expected: string, observed: number) =>
    checks.push({ name, expected, observed: String(observed), pass: observed === 0 });

  add(
    "anonymous reports carry no reporter",
    "0 rows",
    await scalar(prisma.$queryRaw`
      SELECT count(*) AS n FROM compliance.reports
      WHERE is_anonymous = true AND reporter_user_id IS NOT NULL`),
  );

  add(
    "attributed reports carry a reporter",
    "0 rows",
    await scalar(prisma.$queryRaw`
      SELECT count(*) AS n FROM compliance.reports
      WHERE is_anonymous = false AND reporter_user_id IS NULL`),
  );

  add(
    "every case has a linked report",
    "0 rows",
    await scalar(prisma.$queryRaw`
      SELECT count(*) AS n FROM compliance.cases c
      WHERE NOT EXISTS (SELECT 1 FROM compliance.case_reports cr WHERE cr.case_id = c.id)`),
  );

  add(
    "every case status appears in its history",
    "0 rows",
    await scalar(prisma.$queryRaw`
      SELECT count(*) AS n FROM compliance.cases c
      WHERE NOT EXISTS (
        SELECT 1 FROM compliance.case_status_history h
        WHERE h.case_id = c.id AND h.to_status = c.status)`),
  );

  add(
    "every case SLA falls after it opened",
    "0 rows",
    await scalar(prisma.$queryRaw`
      SELECT count(*) AS n FROM compliance.cases WHERE sla_due_at <= opened_at`),
  );

  add(
    "no timestamp lies in the future",
    "0 rows",
    await scalar(prisma.$queryRaw`
      SELECT (
        (SELECT count(*) FROM compliance.reports
          WHERE submitted_at > now() OR (occurred_at IS NOT NULL AND occurred_at > now()))
        + (SELECT count(*) FROM compliance.cases WHERE opened_at > now())
      ) AS n`),
  );

  add(
    "no account crosses a tenant boundary",
    "0 rows",
    await scalar(prisma.$queryRaw`
      SELECT count(*) AS n FROM compliance.user_accounts ua
      LEFT JOIN campuspulse.users u
        ON u.id = ua.user_id AND u.institution_id = ua.institution_id
      WHERE u.id IS NULL`),
  );

  add(
    "every report has a submission audit event",
    "0 rows",
    await scalar(prisma.$queryRaw`
      SELECT count(*) AS n FROM compliance.reports r
      WHERE NOT EXISTS (
        SELECT 1 FROM compliance.audit_events a
        WHERE a.entity_type = 'report' AND a.entity_id = r.id
          AND a.action = 'report.submitted')`),
  );

  const width = Math.max(...checks.map((c) => c.name.length));
  console.log("");
  console.log(
    `${"CHECK".padEnd(width)}  ${"EXPECTED".padEnd(9)}  ${"OBSERVED".padEnd(9)}  RESULT`,
  );
  console.log("-".repeat(width + 32));
  for (const c of checks) {
    console.log(
      `${c.name.padEnd(width)}  ${c.expected.padEnd(9)}  ${c.observed.padEnd(9)}  ${c.pass ? "PASS" : "FAIL"}`,
    );
  }

  const failed = checks.filter((c) => !c.pass);
  console.log("-".repeat(width + 32));
  console.log(`${checks.length - failed.length}/${checks.length} checks passed`);
  console.log("");

  if (failed.length > 0) process.exitCode = 1;
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());

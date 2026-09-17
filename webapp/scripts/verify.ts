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

  // ---- phase 2 ----

  add(
    "no case has more than one outcome",
    "0 rows",
    await scalar(prisma.$queryRaw`
      SELECT count(*) AS n FROM (
        SELECT case_id FROM compliance.outcomes GROUP BY case_id HAVING count(*) > 1
      ) d`),
  );

  add(
    "every resolved or closed case has an outcome",
    "0 rows",
    await scalar(prisma.$queryRaw`
      SELECT count(*) AS n FROM compliance.cases c
      WHERE c.status IN ('resolved', 'closed') AND c.deleted_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM compliance.outcomes o WHERE o.case_id = c.id)`),
  );

  add(
    "every sanction subject belongs to its case",
    "0 rows",
    await scalar(prisma.$queryRaw`
      SELECT count(*) AS n FROM compliance.sanctions s
      JOIN compliance.outcomes o ON o.id = s.outcome_id
      JOIN compliance.case_parties p ON p.id = s.subject_party_id
      WHERE p.case_id <> o.case_id`),
  );

  add(
    "every party is identified, named or anonymous",
    "0 rows",
    await scalar(prisma.$queryRaw`
      SELECT count(*) AS n FROM compliance.case_parties
      WHERE NOT (
        (user_account_id IS NOT NULL AND external_name IS NULL)
        OR (user_account_id IS NULL AND external_name IS NOT NULL)
        OR (is_anonymous AND user_account_id IS NULL AND external_name IS NULL)
      )`),
  );

  add(
    "no evidence file is orphaned",
    "0 rows",
    await scalar(prisma.$queryRaw`
      SELECT count(*) AS n FROM compliance.evidence_files
      WHERE case_id IS NULL AND report_id IS NULL`),
  );

  add(
    "every live evidence file has a digest",
    "0 rows",
    await scalar(prisma.$queryRaw`
      SELECT count(*) AS n FROM compliance.evidence_files
      WHERE deleted_at IS NULL AND (sha256 IS NULL OR length(sha256) <> 64)`),
  );

  add(
    "notification recipients share the case institution",
    "0 rows",
    await scalar(prisma.$queryRaw`
      SELECT count(*) AS n FROM compliance.notifications n
      JOIN compliance.cases c ON c.id = n.case_id
      JOIN compliance.user_accounts ua ON ua.id = n.recipient_id
      WHERE ua.institution_id <> c.institution_id`),
  );

  add(
    "no case number repeats within an institution",
    "0 rows",
    await scalar(prisma.$queryRaw`
      SELECT count(*) AS n FROM (
        SELECT institution_id, case_number FROM compliance.cases
        GROUP BY institution_id, case_number HAVING count(*) > 1
      ) d`),
  );

  add(
    "no revoked session was used after revocation",
    "0 rows",
    await scalar(prisma.$queryRaw`
      SELECT count(*) AS n FROM compliance.sessions
      WHERE revoked_at IS NOT NULL AND last_seen_at > revoked_at`),
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

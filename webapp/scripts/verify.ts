import { Prisma } from "@prisma/client";
import { prisma } from "../src/lib/db";
import { TRANSITIONS } from "../src/lib/cases/transitions";

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

  // ---- phase 3 ----

  // The state machine in SQL, built from the same array the application
  // enforces. A second hand-written copy here could drift from it and quietly
  // bless a transition the application would refuse.
  const permitted = Prisma.join(
    TRANSITIONS.map((t) => Prisma.sql`(${t.from}, ${t.to})`),
  );

  add(
    "every recorded transition is one the machine permits",
    "0 rows",
    await scalar(
      prisma.$queryRaw(Prisma.sql`
        SELECT count(*) AS n FROM compliance.case_status_history h
        WHERE h.from_status IS NOT NULL
          AND (h.from_status::text, h.to_status::text) NOT IN (${permitted})`),
    ),
  );

  add(
    "resolved precedes closed wherever both exist",
    "0 rows",
    await scalar(prisma.$queryRaw`
      SELECT count(*) AS n FROM compliance.cases
      WHERE resolved_at IS NOT NULL AND closed_at IS NOT NULL AND resolved_at > closed_at`),
  );

  // A published version cannot be modified because a trigger refuses it, so
  // what is checkable after the fact is that the protection is still in force
  // and that every published row still carries the stamp publication gave it.
  // A version marked published with no publisher, or a publisher with no
  // publication date, is evidence that something reached past the service.
  add(
    "the policy immutability trigger is present and enabled",
    "0 rows",
    await scalar(prisma.$queryRaw`
      SELECT (1 - count(*)) AS n FROM pg_trigger t
      JOIN pg_class c ON c.oid = t.tgrelid
      WHERE c.relname = 'policy_versions'
        AND t.tgname = 'policy_versions_no_edit_after_publish'
        AND NOT t.tgisinternal
        AND t.tgenabled <> 'D'`),
  );

  add(
    "every published policy version keeps its publication stamp",
    "0 rows",
    await scalar(prisma.$queryRaw`
      SELECT count(*) AS n FROM compliance.policy_versions
      WHERE (published_at IS NULL) <> (published_by IS NULL)`),
  );

  add(
    "no two published versions of a policy are live at once",
    "0 rows",
    await scalar(prisma.$queryRaw`
      SELECT count(*) AS n
      FROM compliance.policy_versions a
      JOIN compliance.policy_versions b
        ON b.policy_id = a.policy_id AND b.id <> a.id
      WHERE a.published_at IS NOT NULL AND b.published_at IS NOT NULL
        AND daterange(a.effective_from, a.effective_to, '[)')
         && daterange(b.effective_from, b.effective_to, '[)')`),
  );

  add(
    "every acknowledgement names a published version",
    "0 rows",
    await scalar(prisma.$queryRaw`
      SELECT count(*) AS n FROM compliance.policy_acknowledgements a
      JOIN compliance.policy_versions v ON v.id = a.policy_version_id
      WHERE v.published_at IS NULL`),
  );

  add(
    "no version number repeats within a policy",
    "0 rows",
    await scalar(prisma.$queryRaw`
      SELECT count(*) AS n FROM (
        SELECT policy_id, version_no FROM compliance.policy_versions
        GROUP BY policy_id, version_no HAVING count(*) > 1
      ) d`),
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

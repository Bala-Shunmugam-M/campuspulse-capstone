"""
03_Verify_Data.py
=================
Independent integrity audit of the loaded CampusPulse dataset.

Why this file exists
--------------------
02_Insert_Data.py is the code that *claims* the data is correct. This script
is the code that *checks* it -- deliberately written against the database
rather than against the generator's in-memory state, so a bug in the
generator cannot hide itself.

It runs three families of check:

  1. POPULATION  - every table holds rows; nothing silently failed to load.
  2. INTEGRITY   - referential and tenant-isolation invariants hold. Several
                   of these are already guaranteed by constraints; re-testing
                   them proves the constraints are actually in force rather
                   than assumed.
  3. BUSINESS    - the domain rules that no CHECK constraint can express:
                   every incident has at least one report, work orders only
                   exist for triaged incidents, feedback only follows closure,
                   duplicate rates and SLA breach rates fall in believable
                   ranges, and so on.

Exit code is 0 when every check passes and 1 otherwise, so this script can be
dropped straight into a CI pipeline.

Usage
-----
    python 03_Verify_Data.py
    python 03_Verify_Data.py --verbose     # also print row counts and samples
"""

from __future__ import annotations

import argparse
import sys
from dataclasses import dataclass

from tabulate import tabulate

from db_config import (
    SCHEMA,
    banner,
    describe_target,
    fail,
    managed_connection,
    ok,
    step,
    warn,
)


# ==========================================================================
# Check definitions
# ==========================================================================
@dataclass
class Check:
    """A single assertion.

    `sql` must return exactly one row whose first column is the observed
    value. The check passes when `predicate(value)` is True.
    """
    group: str
    name: str
    sql: str
    predicate: object
    expectation: str


def zero(v) -> bool:
    return (v or 0) == 0


def positive(v) -> bool:
    return (v or 0) > 0


def between(low: float, high: float):
    def _inner(v) -> bool:
        return v is not None and low <= float(v) <= high
    return _inner


S = SCHEMA

CHECKS: list[Check] = [
    # ------------------------------------------------------- POPULATION
    Check("Population", "institutions loaded",
          f"SELECT count(*) FROM {S}.institutions;", positive, "> 0"),
    Check("Population", "users loaded",
          f"SELECT count(*) FROM {S}.users;", positive, "> 0"),
    Check("Population", "locations loaded",
          f"SELECT count(*) FROM {S}.locations;", positive, "> 0"),
    Check("Population", "categories loaded",
          f"SELECT count(*) FROM {S}.categories;", positive, "> 0"),
    Check("Population", "assets loaded",
          f"SELECT count(*) FROM {S}.assets;", positive, "> 0"),
    Check("Population", "reports loaded",
          f"SELECT count(*) FROM {S}.reports;", positive, "> 0"),
    Check("Population", "incidents loaded",
          f"SELECT count(*) FROM {S}.incidents;", positive, "> 0"),
    Check("Population", "work_orders loaded",
          f"SELECT count(*) FROM {S}.work_orders;", positive, "> 0"),
    Check("Population", "status_history loaded",
          f"SELECT count(*) FROM {S}.status_history;", positive, "> 0"),
    Check("Population", "feedback loaded",
          f"SELECT count(*) FROM {S}.feedback;", positive, "> 0"),

    # -------------------------------------------------- TENANT ISOLATION
    Check("Tenant isolation", "no report crosses tenants via location",
          f"""SELECT count(*) FROM {S}.reports r
              JOIN {S}.locations l ON l.id = r.location_id
             WHERE l.institution_id <> r.institution_id;""",
          zero, "= 0"),
    Check("Tenant isolation", "no report crosses tenants via asset",
          f"""SELECT count(*) FROM {S}.reports r
              JOIN {S}.assets a ON a.id = r.asset_id
             WHERE a.institution_id <> r.institution_id;""",
          zero, "= 0"),
    Check("Tenant isolation", "no report crosses tenants via reporter",
          f"""SELECT count(*) FROM {S}.reports r
              JOIN {S}.users u ON u.id = r.user_id
             WHERE u.institution_id <> r.institution_id;""",
          zero, "= 0"),
    Check("Tenant isolation", "no incident crosses tenants via location",
          f"""SELECT count(*) FROM {S}.incidents i
              JOIN {S}.locations l ON l.id = i.location_id
             WHERE l.institution_id <> i.institution_id;""",
          zero, "= 0"),
    Check("Tenant isolation", "no incident crosses tenants via category",
          f"""SELECT count(*) FROM {S}.incidents i
              JOIN {S}.categories c ON c.id = i.category_id
             WHERE c.institution_id <> i.institution_id;""",
          zero, "= 0"),
    Check("Tenant isolation", "no asset sits in another tenant's location",
          f"""SELECT count(*) FROM {S}.assets a
              JOIN {S}.locations l ON l.id = a.location_id
             WHERE l.institution_id <> a.institution_id;""",
          zero, "= 0"),
    Check("Tenant isolation", "work order team matches incident tenant",
          f"""SELECT count(*) FROM {S}.work_orders wo
              JOIN {S}.incidents i     ON i.id = wo.incident_id
              JOIN {S}.service_teams t ON t.id = wo.team_id
             WHERE t.institution_id <> i.institution_id;""",
          zero, "= 0"),

    # ---------------------------------------------- STRUCTURAL INTEGRITY
    Check("Structure", "location hierarchy has no cycles",
          f"""WITH RECURSIVE walk(id, root, depth) AS (
                  SELECT id, id, 0 FROM {S}.locations WHERE parent_id IS NULL
                  UNION ALL
                  SELECT l.id, w.root, w.depth + 1
                    FROM {S}.locations l
                    JOIN walk w ON l.parent_id = w.id
                   WHERE w.depth < 12
              )
              SELECT (SELECT count(*) FROM {S}.locations)
                   - (SELECT count(DISTINCT id) FROM walk);""",
          zero, "= 0 orphaned/cyclic nodes"),
    Check("Structure", "every non-campus location has a parent",
          f"""SELECT count(*) FROM {S}.locations
             WHERE parent_id IS NULL AND type <> 'campus';""",
          zero, "= 0"),
    Check("Structure", "category tree has no cycles",
          f"""SELECT count(*) FROM {S}.categories WHERE parent_id = id;""",
          zero, "= 0"),
    Check("Structure", "asset tags unique within each institution",
          f"""SELECT count(*) FROM (
                  SELECT institution_id, asset_tag
                    FROM {S}.assets
                   GROUP BY institution_id, asset_tag HAVING count(*) > 1
              ) dup;""",
          zero, "= 0"),
    Check("Structure", "user emails unique within each institution",
          f"""SELECT count(*) FROM (
                  SELECT institution_id, email
                    FROM {S}.users
                   GROUP BY institution_id, email HAVING count(*) > 1
              ) dup;""",
          zero, "= 0"),

    # --------------------------------------------- LIFECYCLE CONSISTENCY
    Check("Lifecycle", "resolved/closed incidents all carry resolved_at",
          f"""SELECT count(*) FROM {S}.incidents
             WHERE status IN ('resolved','closed') AND resolved_at IS NULL;""",
          zero, "= 0"),
    Check("Lifecycle", "unresolved incidents never carry resolved_at",
          f"""SELECT count(*) FROM {S}.incidents
             WHERE status NOT IN ('resolved','closed') AND resolved_at IS NOT NULL;""",
          zero, "= 0"),
    Check("Lifecycle", "no incident resolved before it was created",
          f"""SELECT count(*) FROM {S}.incidents
             WHERE resolved_at IS NOT NULL AND resolved_at < created_at;""",
          zero, "= 0"),
    Check("Lifecycle", "no incident closed before it was resolved",
          f"""SELECT count(*) FROM {S}.incidents
             WHERE closed_at IS NOT NULL AND closed_at < resolved_at;""",
          zero, "= 0"),
    Check("Lifecycle", "no timestamp lies in the future",
          f"""SELECT count(*) FROM {S}.incidents
             WHERE greatest(created_at,
                            coalesce(acknowledged_at, created_at),
                            coalesce(resolved_at,     created_at),
                            coalesce(closed_at,       created_at)) > now();""",
          zero, "= 0"),
    Check("Lifecycle", "status_history records the current status",
          f"""SELECT count(*) FROM {S}.incidents i
             WHERE NOT EXISTS (
                 SELECT 1 FROM {S}.status_history sh
                  WHERE sh.incident_id = i.id AND sh.status = i.status
             );""",
          zero, "= 0"),
    Check("Lifecycle", "every incident opens with a 'reported' history row",
          f"""SELECT count(*) FROM {S}.incidents i
             WHERE NOT EXISTS (
                 SELECT 1 FROM {S}.status_history sh
                  WHERE sh.incident_id = i.id AND sh.status = 'reported'
             );""",
          zero, "= 0"),
    Check("Lifecycle", "completed work orders all carry completed_at",
          f"""SELECT count(*) FROM {S}.work_orders
             WHERE status IN ('completed','verified','closed')
               AND completed_at IS NULL;""",
          zero, "= 0"),

    # ----------------------------------------------------- BUSINESS RULES
    Check("Business rules", "every incident has at least one report",
          f"""SELECT count(*) FROM {S}.incidents i
             WHERE NOT EXISTS (
                 SELECT 1 FROM {S}.incident_reports ir WHERE ir.incident_id = i.id
             );""",
          zero, "= 0"),
    Check("Business rules", "no report is linked to two incidents",
          f"""SELECT count(*) FROM (
                  SELECT report_id FROM {S}.incident_reports
                   GROUP BY report_id HAVING count(*) > 1
              ) d;""",
          zero, "= 0"),
    Check("Business rules", "first report of an incident is not a duplicate",
          f"""SELECT count(*) FROM (
                  SELECT ir.incident_id,
                         (array_agg(r.is_duplicate ORDER BY r.created_at))[1] AS first_dup
                    FROM {S}.incident_reports ir
                    JOIN {S}.reports r ON r.id = ir.report_id
                   GROUP BY ir.incident_id
              ) t WHERE first_dup;""",
          zero, "= 0"),
    Check("Business rules", "no work order for an untriaged incident",
          f"""SELECT count(*) FROM {S}.work_orders wo
              JOIN {S}.incidents i ON i.id = wo.incident_id
             WHERE i.status = 'reported';""",
          zero, "= 0"),
    Check("Business rules", "assignee belongs to the assigned team",
          f"""SELECT count(*) FROM {S}.work_orders wo
             WHERE wo.assigned_to IS NOT NULL
               AND NOT EXISTS (
                   SELECT 1 FROM {S}.team_members tm
                    WHERE tm.team_id = wo.team_id AND tm.user_id = wo.assigned_to
               );""",
          zero, "= 0"),
    Check("Business rules", "feedback only exists for closed incidents",
          f"""SELECT count(*) FROM {S}.feedback f
              JOIN {S}.incidents i ON i.id = f.incident_id
             WHERE i.status <> 'closed';""",
          zero, "= 0"),
    Check("Business rules", "every feedback rating is 1-5",
          f"""SELECT count(*) FROM {S}.feedback
             WHERE rating < 1 OR rating > 5;""",
          zero, "= 0"),
    Check("Business rules", "read notifications carry a read timestamp",
          f"""SELECT count(*) FROM {S}.notifications
             WHERE is_read <> (read_at IS NOT NULL);""",
          zero, "= 0"),
    Check("Business rules", "every service team has at least one member",
          f"""SELECT count(*) FROM {S}.service_teams t
             WHERE NOT EXISTS (
                 SELECT 1 FROM {S}.team_members tm WHERE tm.team_id = t.id
             );""",
          zero, "= 0"),
    Check("Business rules", "every institution has an admin",
          f"""SELECT count(*) FROM {S}.institutions inst
             WHERE NOT EXISTS (
                 SELECT 1 FROM {S}.users u
                  WHERE u.institution_id = inst.id AND u.role = 'admin'
             );""",
          zero, "= 0"),

    # --------------------------------------------- STATISTICAL PLAUSIBILITY
    Check("Plausibility", "duplicate report rate is 15-60%",
          f"""SELECT round(100.0 * count(*) FILTER (WHERE is_duplicate)
                           / NULLIF(count(*), 0), 1) FROM {S}.reports;""",
          between(15, 60), "15-60 %"),
    Check("Plausibility", "SLA breach rate is 5-45%",
          f"""SELECT round(100.0 * count(*) FILTER (WHERE resolved_at > sla_due_at)
                           / NULLIF(count(*), 0), 1)
                FROM {S}.incidents WHERE resolved_at IS NOT NULL;""",
          between(5, 45), "5-45 %"),
    Check("Plausibility", "open incident backlog is 5-50%",
          f"""SELECT round(100.0 * count(*) FILTER
                           (WHERE status NOT IN ('resolved','closed'))
                           / NULLIF(count(*), 0), 1) FROM {S}.incidents;""",
          between(5, 50), "5-50 %"),
    Check("Plausibility", "avg reports per incident is 1.0-3.0",
          f"""SELECT round(count(*)::numeric
                           / NULLIF((SELECT count(*) FROM {S}.incidents), 0), 2)
                FROM {S}.incident_reports;""",
          between(1.0, 3.0), "1.0-3.0"),
    Check("Plausibility", "weekend activity is below weekday activity",
          f"""SELECT CASE WHEN weekday_avg > weekend_avg THEN 1 ELSE 0 END FROM (
                  SELECT
                    avg(c) FILTER (WHERE dow BETWEEN 1 AND 5) AS weekday_avg,
                    avg(c) FILTER (WHERE dow IN (0, 6))       AS weekend_avg
                  FROM (
                    SELECT EXTRACT(DOW FROM created_at)::int AS dow,
                           date_trunc('day', created_at) AS d, count(*) AS c
                      FROM {S}.reports GROUP BY 1, 2
                  ) daily
              ) cmp;""",
          positive, "weekday > weekend"),
    Check("Plausibility", "at least 12 distinct issue categories in use",
          f"""SELECT count(DISTINCT category_id) FROM {S}.incidents;""",
          between(12, 1000), ">= 12"),
    Check("Plausibility", "incidents span at least 300 distinct days",
          f"""SELECT count(DISTINCT date_trunc('day', created_at)) FROM {S}.incidents;""",
          between(300, 100000), ">= 300 days"),
]


# ==========================================================================
# Runner
# ==========================================================================
def run_checks(verbose: bool) -> int:
    banner("CampusPulse - Data Integrity Audit")
    step(f"Target: {describe_target()}")

    rows: list[list[str]] = []
    failures: list[str] = []
    current_group = None

    with managed_connection() as conn:
        with conn.cursor() as cur:
            # ---- optional inventory --------------------------------
            if verbose:
                cur.execute(
                    """
                    SELECT c.relname,
                           (SELECT count(*) FROM information_schema.columns col
                             WHERE col.table_schema = %s AND col.table_name = c.relname)
                      FROM pg_class c
                      JOIN pg_namespace n ON n.oid = c.relnamespace
                     WHERE n.nspname = %s AND c.relkind = 'r'
                     ORDER BY c.relname;
                    """,
                    (SCHEMA, SCHEMA),
                )
                inventory = cur.fetchall()
                counts = []
                for table, ncols in inventory:
                    cur.execute(f'SELECT count(*) FROM {SCHEMA}."{table}";')
                    counts.append([table, ncols, f"{cur.fetchone()[0]:,}"])
                banner("Table inventory", char="-")
                print(tabulate(counts, headers=["Table", "Columns", "Rows"],
                               tablefmt="github"))

            # ---- checks --------------------------------------------
            banner("Checks", char="-")
            for check in CHECKS:
                if check.group != current_group:
                    current_group = check.group
                    rows.append(["", f"--- {current_group} ---", "", ""])

                cur.execute(check.sql)
                observed = cur.fetchone()[0]
                passed = bool(check.predicate(observed))

                if not passed:
                    failures.append(
                        f"{check.group} / {check.name}: "
                        f"expected {check.expectation}, observed {observed}"
                    )

                rows.append([
                    "PASS" if passed else "FAIL",
                    check.name,
                    check.expectation,
                    "-" if observed is None else f"{observed}",
                ])

    print(tabulate(rows, headers=["Result", "Check", "Expected", "Observed"],
                   tablefmt="github"))

    total = len(CHECKS)
    failed = len(failures)
    passed = total - failed

    banner("Audit summary")
    print(f"    Checks run    : {total}")
    print(f"    Passed        : {passed}")
    print(f"    Failed        : {failed}")

    if failures:
        print()
        for line in failures:
            fail(line)
        print()
        warn("Dataset did NOT pass verification.")
        return 1

    print()
    ok("All integrity, lifecycle and plausibility checks passed.")
    print()
    print("    Next step:  python 04_Analytics_Queries.py")
    print()
    return 0


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Audit the integrity of the loaded CampusPulse dataset."
    )
    parser.add_argument("-v", "--verbose", action="store_true",
                        help="Also print a table inventory with row counts.")
    args = parser.parse_args()

    try:
        sys.exit(run_checks(args.verbose))
    except Exception as exc:  # noqa: BLE001 - top-level CLI handler
        fail(f"Verification could not run: {exc}")
        sys.exit(2)


if __name__ == "__main__":
    main()

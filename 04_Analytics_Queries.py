"""
04_Analytics_Queries.py
=======================
The payoff layer: fourteen analytical questions an operations director would
actually ask, answered directly against the generated dataset.

Each query is stated as a business question first and SQL second, because the
point of the capstone is not "we wrote SQL" but "we can turn maintenance
records into operational decisions".

SQL techniques demonstrated
---------------------------
  * Recursive CTEs           - rolling room-level incidents up the location tree
  * Window functions         - month-over-month change, running totals, ranking
  * FILTER aggregates        - conditional counts without CASE-WHEN noise
  * Lateral / correlated     - per-group top-N
  * Interval + date_trunc    - cohorting and time bucketing
  * Statistical aggregates   - percentile_cont, corr, stddev

Usage
-----
    python 04_Analytics_Queries.py                 # run every query
    python 04_Analytics_Queries.py --only 3 7 12   # run selected queries
    python 04_Analytics_Queries.py --list          # list the questions
    python 04_Analytics_Queries.py --export out/   # also write CSV files
    python 04_Analytics_Queries.py --explain 2     # show the query plan
"""

from __future__ import annotations

import argparse
import csv
import os
import sys
import time
from dataclasses import dataclass
from decimal import Decimal

from tabulate import tabulate

from db_config import SCHEMA, banner, describe_target, fail, managed_connection, ok, step

S = SCHEMA


@dataclass(frozen=True)
class Query:
    number: int
    question: str
    insight: str
    sql: str


QUERIES: list[Query] = [

    # ------------------------------------------------------------------ 1
    Query(
        1,
        "How has reporting volume trended month over month, and is the backlog growing?",
        "Separates genuine demand growth from a widening resolution gap.",
        f"""
        WITH monthly AS (
            SELECT date_trunc('month', i.created_at)::date          AS month,
                   count(*)                                         AS raised,
                   count(*) FILTER (WHERE i.resolved_at IS NOT NULL) AS resolved,
                   count(*) FILTER (WHERE i.priority IN ('high','critical'))
                                                                    AS high_priority
              FROM {S}.incidents i
             GROUP BY 1
        )
        -- NOTE: the text label is aliased `month_label`, not `month`.
        -- ORDER BY resolves output aliases before input columns, so calling
        -- it `month` would sort the report alphabetically (Apr, Aug, Dec...).
        SELECT to_char(month, 'YYYY-Mon')          AS month_label,
               raised,
               resolved,
               raised - resolved                   AS still_open,
               high_priority,
               raised - lag(raised) OVER (ORDER BY month)  AS mom_change,
               round(100.0 * (raised - lag(raised) OVER (ORDER BY month))
                     / NULLIF(lag(raised) OVER (ORDER BY month), 0), 1)
                                                   AS mom_pct,
               sum(raised - resolved) OVER (ORDER BY month
                                            ROWS UNBOUNDED PRECEDING)
                                                   AS cumulative_backlog
          FROM monthly
         ORDER BY month;
        """,
    ),

    # ------------------------------------------------------------------ 2
    Query(
        2,
        "Which rooms are the worst maintenance hot spots?",
        "Concentrated failures usually mean a root cause worth fixing once, "
        "rather than the same symptom being patched twenty times.",
        f"""
        SELECT inst.code                                   AS inst,
               l.name                                      AS location,
               l.type                                      AS kind,
               count(*)                                    AS incidents,
               count(*) FILTER (WHERE i.status NOT IN ('resolved','closed'))
                                                           AS open_now,
               count(*) FILTER (WHERE i.priority IN ('high','critical'))
                                                           AS high_prio,
               count(DISTINCT i.category_id)               AS distinct_issues,
               round(avg(EXTRACT(EPOCH FROM (i.resolved_at - i.created_at))
                         / 3600.0)::numeric, 1)            AS avg_fix_hours
          FROM {S}.incidents i
          JOIN {S}.locations    l    ON l.id    = i.location_id
          JOIN {S}.institutions inst ON inst.id = i.institution_id
         GROUP BY inst.code, l.id, l.name, l.type
         ORDER BY incidents DESC, high_prio DESC
         LIMIT 15;
        """,
    ),

    # ------------------------------------------------------------------ 3
    Query(
        3,
        "Which issue categories consume the most maintenance effort?",
        "Volume alone misleads. Total hours reveals where the labour actually goes.",
        f"""
        SELECT parent.name                                 AS category_group,
               c.name                                      AS category,
               c.sla_hours                                 AS sla_hrs,
               count(*)                                    AS incidents,
               round(avg(EXTRACT(EPOCH FROM (i.resolved_at - i.created_at))
                         / 3600.0)::numeric, 1)            AS avg_hours,
               round(percentile_cont(0.5) WITHIN GROUP (
                       ORDER BY EXTRACT(EPOCH FROM (i.resolved_at - i.created_at))
                                / 3600.0)::numeric, 1)     AS median_hours,
               round(percentile_cont(0.9) WITHIN GROUP (
                       ORDER BY EXTRACT(EPOCH FROM (i.resolved_at - i.created_at))
                                / 3600.0)::numeric, 1)     AS p90_hours,
               round(sum(EXTRACT(EPOCH FROM (i.resolved_at - i.created_at))
                         / 3600.0)::numeric, 0)            AS total_hours
          FROM {S}.incidents i
          JOIN {S}.categories c      ON c.id = i.category_id
          LEFT JOIN {S}.categories parent ON parent.id = c.parent_id
         WHERE i.resolved_at IS NOT NULL
         GROUP BY parent.name, c.name, c.sla_hours
         ORDER BY total_hours DESC
         LIMIT 15;
        """,
    ),

    # ------------------------------------------------------------------ 4
    Query(
        4,
        "How well is each category meeting its SLA?",
        "The compliance number that belongs on the operations dashboard.",
        f"""
        SELECT institution_code                AS inst,
               category,
               sla_hours                       AS sla_hrs,
               resolved_incidents              AS resolved,
               met_sla,
               breached_sla                    AS breached,
               sla_compliance_pct              AS compliance_pct,
               CASE
                   WHEN sla_compliance_pct >= 90 THEN 'On target'
                   WHEN sla_compliance_pct >= 75 THEN 'Watch'
                   ELSE 'At risk'
               END                             AS verdict
          FROM {S}.v_sla_compliance
         WHERE resolved_incidents >= 10
         ORDER BY sla_compliance_pct ASC
         LIMIT 20;
        """,
    ),

    # ------------------------------------------------------------------ 5
    Query(
        5,
        "How much duplicate reporting does incident aggregation absorb?",
        "Quantifies the core design decision: many reports collapse into one "
        "incident, so technicians are dispatched once, not five times.",
        f"""
        WITH per_incident AS (
            SELECT ir.incident_id, count(*) AS report_count
              FROM {S}.incident_reports ir
             GROUP BY ir.incident_id
        )
        SELECT report_count                              AS reports_per_incident,
               count(*)                                  AS incidents,
               round(100.0 * count(*) / sum(count(*)) OVER (), 1)
                                                         AS pct_of_incidents,
               report_count * count(*)                   AS total_reports,
               (report_count - 1) * count(*)             AS duplicate_reports,
               sum((report_count - 1) * count(*)) OVER (ORDER BY report_count)
                                                         AS cumulative_saved_dispatches
          FROM per_incident
         GROUP BY report_count
         ORDER BY report_count;
        """,
    ),

    # ------------------------------------------------------------------ 6
    Query(
        6,
        "Which individual assets fail repeatedly and should be replaced?",
        "Replace-vs-repair evidence: an asset costing more in cumulative "
        "labour than a new unit is a false economy.",
        f"""
        SELECT inst.code                        AS inst,
               a.asset_tag,
               a.name                           AS asset,
               cat.name                         AS asset_type,
               loc.name                         AS location,
               a.status,
               count(i.id)                      AS failures,
               round(sum(wo.labour_minutes) / 60.0, 1)      AS labour_hours,
               round(sum(wo.material_cost)::numeric, 0)     AS parts_cost,
               max(i.created_at)::date          AS last_failure
          FROM {S}.assets a
          JOIN {S}.incidents i        ON i.asset_id = a.id
          JOIN {S}.institutions inst  ON inst.id = a.institution_id
          JOIN {S}.categories  cat    ON cat.id  = a.category_id
          JOIN {S}.locations   loc    ON loc.id  = a.location_id
          LEFT JOIN {S}.work_orders wo ON wo.incident_id = i.id
         GROUP BY inst.code, a.id, a.asset_tag, a.name, cat.name, loc.name, a.status
        HAVING count(i.id) >= 3
         ORDER BY failures DESC, labour_hours DESC NULLS LAST
         LIMIT 15;
        """,
    ),

    # ------------------------------------------------------------------ 7
    Query(
        7,
        "Does higher priority actually get faster service?",
        "Validates that triage is working rather than being cosmetic.",
        f"""
        SELECT i.priority,
               count(*)                                     AS resolved,
               round(avg(EXTRACT(EPOCH FROM (i.acknowledged_at - i.created_at))
                         / 3600.0)::numeric, 2)             AS avg_ack_hours,
               round(avg(EXTRACT(EPOCH FROM (i.resolved_at - i.created_at))
                         / 3600.0)::numeric, 1)             AS avg_fix_hours,
               round(percentile_cont(0.5) WITHIN GROUP (
                       ORDER BY EXTRACT(EPOCH FROM (i.resolved_at - i.created_at))
                                / 3600.0)::numeric, 1)      AS median_hours,
               round(stddev_samp(EXTRACT(EPOCH FROM (i.resolved_at - i.created_at))
                                 / 3600.0)::numeric, 1)     AS stddev_hours,
               round(100.0 * count(*) FILTER (WHERE i.resolved_at <= i.sla_due_at)
                     / NULLIF(count(*), 0), 1)              AS sla_met_pct
          FROM {S}.incidents i
         WHERE i.resolved_at IS NOT NULL
         GROUP BY i.priority
         ORDER BY CASE i.priority
                    WHEN 'critical' THEN 1 WHEN 'high' THEN 2
                    WHEN 'medium'   THEN 3 ELSE 4 END;
        """,
    ),

    # ------------------------------------------------------------------ 8
    Query(
        8,
        "When during the week do reports actually arrive?",
        "Drives staffing rosters: coverage should follow demand, not habit.",
        f"""
        SELECT to_char(r.created_at, 'Dy')                  AS day,
               count(*)                                     AS total,
               count(*) FILTER (WHERE EXTRACT(HOUR FROM r.created_at) < 12)
                                                            AS morning,
               count(*) FILTER (WHERE EXTRACT(HOUR FROM r.created_at)
                                      BETWEEN 12 AND 17)    AS afternoon,
               count(*) FILTER (WHERE EXTRACT(HOUR FROM r.created_at) > 17)
                                                            AS evening,
               round(100.0 * count(*) / sum(count(*)) OVER (), 1)
                                                            AS pct_of_week
          FROM {S}.reports r
         GROUP BY to_char(r.created_at, 'Dy'), EXTRACT(DOW FROM r.created_at)
         ORDER BY EXTRACT(DOW FROM r.created_at);
        """,
    ),

    # ------------------------------------------------------------------ 9
    Query(
        9,
        "How is each service team performing on throughput, cost and satisfaction?",
        "One table for the monthly operations review.",
        f"""
        SELECT inst.code                                     AS inst,
               t.name                                        AS team,
               count(wo.id)                                  AS work_orders,
               count(wo.id) FILTER (WHERE wo.status IN ('completed','verified','closed'))
                                                             AS completed,
               round(100.0 * count(wo.id) FILTER
                     (WHERE wo.status IN ('completed','verified','closed'))
                     / NULLIF(count(wo.id), 0), 1)           AS completion_pct,
               round(avg(wo.labour_minutes)::numeric, 0)     AS avg_minutes,
               round(sum(wo.material_cost)::numeric, 0)      AS parts_cost,
               count(DISTINCT tm.user_id)                    AS technicians,
               round(avg(f.rating)::numeric, 2)              AS avg_rating
          FROM {S}.service_teams t
          JOIN {S}.institutions inst  ON inst.id = t.institution_id
          LEFT JOIN {S}.work_orders wo ON wo.team_id = t.id
          LEFT JOIN {S}.team_members tm ON tm.team_id = t.id
          LEFT JOIN {S}.feedback f      ON f.incident_id = wo.incident_id
         GROUP BY inst.code, t.id, t.name
         ORDER BY inst, work_orders DESC;
        """,
    ),

    # ----------------------------------------------------------------- 10
    Query(
        10,
        "Does slower resolution actually reduce satisfaction?",
        "Tests the assumed link between speed and perceived quality, and "
        "reports the correlation coefficient rather than eyeballing it.",
        f"""
        WITH scored AS (
            SELECT f.rating,
                   EXTRACT(EPOCH FROM (i.resolved_at - i.created_at)) / 3600.0 AS fix_hours,
                   (i.resolved_at <= i.sla_due_at)                             AS met_sla
              FROM {S}.feedback f
              JOIN {S}.incidents i ON i.id = f.incident_id
             WHERE i.resolved_at IS NOT NULL
        )
        SELECT rating,
               count(*)                                     AS responses,
               round(avg(fix_hours)::numeric, 1)            AS avg_fix_hours,
               round(percentile_cont(0.5) WITHIN GROUP (ORDER BY fix_hours)::numeric, 1)
                                                            AS median_fix_hours,
               round(100.0 * count(*) FILTER (WHERE met_sla)
                     / NULLIF(count(*), 0), 1)              AS pct_within_sla,
               round((SELECT corr(rating::numeric, fix_hours) FROM scored)::numeric, 3)
                                                            AS overall_correlation
          FROM scored
         GROUP BY rating
         ORDER BY rating DESC;
        """,
    ),

    # ----------------------------------------------------------------- 11
    Query(
        11,
        "How old is the current open backlog, and what is already overdue?",
        "The triage list. Anything in the 30-day-plus bucket needs escalation today.",
        f"""
        SELECT CASE
                   WHEN now() - i.created_at < interval '1 day'  THEN '1. under 24h'
                   WHEN now() - i.created_at < interval '3 days' THEN '2. 1-3 days'
                   WHEN now() - i.created_at < interval '7 days' THEN '3. 3-7 days'
                   WHEN now() - i.created_at < interval '30 days' THEN '4. 7-30 days'
                   ELSE                                               '5. over 30 days'
               END                                          AS age_bucket,
               count(*)                                     AS open_incidents,
               count(*) FILTER (WHERE i.priority IN ('high','critical'))
                                                            AS high_priority,
               count(*) FILTER (WHERE now() > i.sla_due_at)  AS sla_overdue,
               count(*) FILTER (WHERE i.status = 'reported') AS never_triaged,
               round(avg(EXTRACT(EPOCH FROM (now() - i.created_at))
                         / 86400.0)::numeric, 1)            AS avg_age_days
          FROM {S}.incidents i
         WHERE i.status NOT IN ('resolved','closed')
         GROUP BY age_bucket
         ORDER BY age_bucket;
        """,
    ),

    # ----------------------------------------------------------------- 12
    Query(
        12,
        "Roll room-level incidents up to whole buildings (recursive CTE).",
        "Proves the self-referencing location tree earns its keep: one query "
        "aggregates at any level of the hierarchy without hard-coded joins.",
        f"""
        WITH RECURSIVE tree AS (
            -- Anchor: every building is its own subtree root.
            SELECT l.id AS building_id, l.name AS building_name,
                   l.institution_id, l.id AS descendant_id
              FROM {S}.locations l
             WHERE l.type = 'building'
            UNION ALL
            -- Recurse down floors, rooms and areas.
            SELECT t.building_id, t.building_name, t.institution_id, child.id
              FROM tree t
              JOIN {S}.locations child ON child.parent_id = t.descendant_id
        )
        SELECT inst.code                                     AS inst,
               t.building_name                               AS building,
               count(DISTINCT t.descendant_id)               AS spaces,
               count(i.id)                                   AS incidents,
               round(count(i.id)::numeric
                     / NULLIF(count(DISTINCT t.descendant_id), 0), 2)
                                                             AS incidents_per_space,
               count(i.id) FILTER (WHERE i.status NOT IN ('resolved','closed'))
                                                             AS still_open,
               round(avg(EXTRACT(EPOCH FROM (i.resolved_at - i.created_at))
                         / 3600.0)::numeric, 1)              AS avg_fix_hours,
               rank() OVER (PARTITION BY inst.code ORDER BY count(i.id) DESC)
                                                             AS rank_in_campus
          FROM tree t
          JOIN {S}.institutions inst ON inst.id = t.institution_id
          LEFT JOIN {S}.incidents i  ON i.location_id = t.descendant_id
         GROUP BY inst.code, t.building_id, t.building_name
         ORDER BY inst, incidents DESC;
        """,
    ),

    # ----------------------------------------------------------------- 13
    Query(
        13,
        "Which reporting channel are people actually using, and is QR winning?",
        "Validates the QR-sticker investment described in the asset design.",
        f"""
        SELECT to_char(date_trunc('quarter', r.created_at), 'YYYY-\"Q\"Q') AS quarter,
               count(*)                                                  AS reports,
               count(*) FILTER (WHERE r.reported_via = 'qr_scan')        AS qr_scan,
               count(*) FILTER (WHERE r.reported_via = 'mobile_app')     AS mobile,
               count(*) FILTER (WHERE r.reported_via = 'web')            AS web,
               count(*) FILTER (WHERE r.reported_via IN ('manual','email')) AS offline,
               round(100.0 * count(*) FILTER (WHERE r.reported_via = 'qr_scan')
                     / NULLIF(count(*), 0), 1)                           AS qr_pct,
               round(100.0 * count(*) FILTER (WHERE r.asset_id IS NOT NULL)
                     / NULLIF(count(*), 0), 1)                           AS asset_linked_pct
          FROM {S}.reports r
         GROUP BY date_trunc('quarter', r.created_at)
         ORDER BY 1;
        """,
    ),

    # ----------------------------------------------------------------- 14
    Query(
        14,
        "Where is the maintenance budget going, and what does an hour cost?",
        "Ties operational data to money, which is what gets a project funded.",
        f"""
        SELECT parent.name                                   AS category_group,
               count(wo.id)                                  AS jobs,
               round(sum(wo.labour_minutes) / 60.0, 1)       AS labour_hours,
               round(sum(wo.material_cost)::numeric, 0)      AS parts_cost,
               round((sum(wo.labour_minutes) / 60.0 * 250)::numeric, 0)
                                                             AS labour_cost_est,
               round((sum(wo.material_cost)
                      + sum(wo.labour_minutes) / 60.0 * 250)::numeric, 0)
                                                             AS total_cost_est,
               round((sum(wo.material_cost)
                      + sum(wo.labour_minutes) / 60.0 * 250)
                     / NULLIF(count(wo.id), 0)::numeric, 0)  AS cost_per_job,
               round(100.0 * (sum(wo.material_cost) + sum(wo.labour_minutes) / 60.0 * 250)
                     / NULLIF(sum(sum(wo.material_cost)
                              + sum(wo.labour_minutes) / 60.0 * 250) OVER (), 0), 1)
                                                             AS pct_of_spend
          FROM {S}.work_orders wo
          JOIN {S}.incidents  i      ON i.id  = wo.incident_id
          JOIN {S}.categories c      ON c.id  = i.category_id
          LEFT JOIN {S}.categories parent ON parent.id = c.parent_id
         WHERE wo.completed_at IS NOT NULL
         GROUP BY parent.name
         ORDER BY total_cost_est DESC NULLS LAST;
        """,
    ),
]

# Labour is costed at a nominal INR 250/hour purely to make the budget query
# concrete; change the constant in query 14 to match your own rate card.


# ==========================================================================
# Runner
# ==========================================================================
def _present(value):
    """Render a cell for the console.

    psycopg2 returns SQL `numeric` as Decimal, which tabulate then formats with
    two decimal places -- so a whole-number count prints as '76.00'. Collapse
    integral Decimals back to int so counts look like counts.
    """
    if value is None:
        return ""
    if isinstance(value, Decimal) and value == value.to_integral_value():
        return int(value)
    return value


def run_query(cur, query: Query, export_dir: str | None) -> tuple[int, float]:
    started = time.perf_counter()
    cur.execute(query.sql)
    rows = cur.fetchall()
    headers = [d[0] for d in cur.description]
    elapsed = time.perf_counter() - started

    banner(f"Q{query.number}.  {query.question}", char="=")
    print(f"  Why it matters: {query.insight}")
    print()

    if rows:
        printable = [[_present(value) for value in row] for row in rows]
        print(tabulate(printable, headers=headers, tablefmt="github",
                       floatfmt=",.2f"))
    else:
        print("  (no rows returned)")

    print()
    print(f"  {len(rows)} row(s) in {elapsed * 1000:.0f} ms")

    if export_dir:
        os.makedirs(export_dir, exist_ok=True)
        slug = (
            query.question.lower()
            .replace(" ", "_").replace(",", "").replace("?", "")
            .replace("(", "").replace(")", "").replace("'", "")
            .replace("/", "-")[:60]
        )
        path = os.path.join(export_dir, f"q{query.number:02d}_{slug}.csv")
        with open(path, "w", newline="", encoding="utf-8") as handle:
            writer = csv.writer(handle)
            writer.writerow(headers)
            writer.writerows(rows)
        print(f"  exported -> {path}")

    return len(rows), elapsed


def explain(cur, query: Query) -> None:
    banner(f"EXPLAIN ANALYZE - Q{query.number}", char="=")
    cur.execute("EXPLAIN (ANALYZE, BUFFERS, COSTS) " + query.sql)
    for (line,) in cur.fetchall():
        print("   " + line)


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Run the CampusPulse analytical query suite."
    )
    parser.add_argument("--only", nargs="+", type=int, metavar="N",
                        help="Run only these query numbers.")
    parser.add_argument("--list", action="store_true",
                        help="List the questions and exit.")
    parser.add_argument("--export", metavar="DIR",
                        help="Also write each result set to a CSV in DIR.")
    parser.add_argument("--explain", type=int, metavar="N",
                        help="Show EXPLAIN ANALYZE output for query N and exit.")
    args = parser.parse_args()

    if args.list:
        banner("CampusPulse - Analytical Questions")
        for q in QUERIES:
            print(f"  {q.number:>2}.  {q.question}")
        print()
        return

    selected = QUERIES
    if args.only:
        wanted = set(args.only)
        selected = [q for q in QUERIES if q.number in wanted]
        if not selected:
            fail(f"No queries match {sorted(wanted)}. Use --list to see the numbers.")
            sys.exit(1)

    banner("CampusPulse - Analytics Suite")
    step(f"Target: {describe_target()}")
    step(f"Running {len(selected)} of {len(QUERIES)} queries")

    total_rows = 0
    total_time = 0.0

    try:
        with managed_connection() as conn:
            with conn.cursor() as cur:
                if args.explain is not None:
                    match = next((q for q in QUERIES if q.number == args.explain), None)
                    if match is None:
                        fail(f"No query numbered {args.explain}.")
                        sys.exit(1)
                    explain(cur, match)
                    return

                for query in selected:
                    rows, elapsed = run_query(cur, query, args.export)
                    total_rows += rows
                    total_time += elapsed
    except Exception as exc:  # noqa: BLE001 - top-level CLI handler
        fail(f"Analytics run failed: {exc}")
        sys.exit(1)

    banner("Analytics run complete")
    print(f"    Queries executed : {len(selected)}")
    print(f"    Rows returned    : {total_rows:,}")
    print(f"    Total query time : {total_time * 1000:.0f} ms")
    if args.export:
        ok(f"CSV exports written to {os.path.abspath(args.export)}")
    print()


if __name__ == "__main__":
    main()

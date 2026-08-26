"""
05_Export_Documentation.py
==========================
Regenerates `docs/DATA_DICTIONARY.md` by reading PostgreSQL's own catalog.

Hand-written data dictionaries rot the moment someone alters a column. This
script derives the document from `information_schema` and `pg_catalog`, so the
documentation is a projection of the live database rather than a parallel
description of it that has to be kept in sync by discipline alone.

Emitted per table: purpose comment, live row count, full column list with
types / nullability / defaults, primary key, foreign keys, unique keys, check
constraints and indexes.

Usage
-----
    python 05_Export_Documentation.py
    python 05_Export_Documentation.py --output docs/DATA_DICTIONARY.md
"""

from __future__ import annotations

import argparse
import os
from datetime import datetime, timezone

from db_config import SCHEMA, banner, fail, managed_connection, ok, step

S = SCHEMA


TABLE_SQL = """
SELECT c.relname                                  AS table_name,
       obj_description(c.oid, 'pg_class')         AS table_comment
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = %s AND c.relkind = 'r'
 ORDER BY c.relname;
"""

COLUMN_SQL = """
SELECT a.attname                                             AS column_name,
       format_type(a.atttypid, a.atttypmod)                  AS data_type,
       NOT a.attnotnull                                      AS is_nullable,
       pg_get_expr(d.adbin, d.adrelid)                       AS column_default,
       col_description(a.attrelid, a.attnum)                 AS column_comment
  FROM pg_attribute a
  LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
  JOIN pg_class c        ON c.oid = a.attrelid
  JOIN pg_namespace n    ON n.oid = c.relnamespace
 WHERE n.nspname = %s AND c.relname = %s
   AND a.attnum > 0 AND NOT a.attisdropped
 ORDER BY a.attnum;
"""

CONSTRAINT_SQL = """
SELECT con.conname                        AS name,
       con.contype                        AS kind,
       pg_get_constraintdef(con.oid)      AS definition
  FROM pg_constraint con
  JOIN pg_class c     ON c.oid = con.conrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = %s AND c.relname = %s
 ORDER BY CASE con.contype
            WHEN 'p' THEN 1 WHEN 'f' THEN 2
            WHEN 'u' THEN 3 ELSE 4 END, con.conname;
"""

INDEX_SQL = """
SELECT indexname, indexdef
  FROM pg_indexes
 WHERE schemaname = %s AND tablename = %s
 ORDER BY indexname;
"""

ENUM_SQL = """
SELECT t.typname,
       string_agg(quote_literal(e.enumlabel), ', ' ORDER BY e.enumsortorder)
  FROM pg_type t
  JOIN pg_enum e      ON e.enumtypid = t.oid
  JOIN pg_namespace n ON n.oid = t.typnamespace
 WHERE n.nspname = %s
 GROUP BY t.typname
 ORDER BY t.typname;
"""

VIEW_SQL = """
SELECT table_name
  FROM information_schema.views
 WHERE table_schema = %s
 ORDER BY table_name;
"""

CONSTRAINT_KIND = {
    "p": "PRIMARY KEY",
    "f": "FOREIGN KEY",
    "u": "UNIQUE",
    "c": "CHECK",
    "x": "EXCLUDE",
}


def escape(text: str | None) -> str:
    """Make a value safe to drop inside a Markdown table cell."""
    if text is None:
        return "-"
    return str(text).replace("|", "\\|").replace("\n", " ")


def build(output_path: str) -> None:
    banner("CampusPulse - Data Dictionary Generator")

    lines: list[str] = []
    generated = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")

    lines += [
        "# CampusPulse - Data Dictionary",
        "",
        "> **Auto-generated. Do not edit by hand.**",
        "> Regenerate with `python 05_Export_Documentation.py` after any schema change.",
        "",
        f"- **Schema:** `{S}`",
        f"- **Generated:** {generated}",
        "- **Source:** PostgreSQL `information_schema` + `pg_catalog` of the live database",
        "",
        "---",
        "",
    ]

    with managed_connection() as conn:
        with conn.cursor() as cur:
            # ---------------------------------------------------- ENUMs
            step("Reading ENUM types...")
            cur.execute(ENUM_SQL, (S,))
            enums = cur.fetchall()

            lines += ["## 1. Enumerated types", "",
                      "Controlled vocabularies enforced by the database itself. "
                      "A value outside these lists cannot be stored.", "",
                      "| Type | Allowed values |", "|---|---|"]
            for name, labels in enums:
                lines.append(f"| `{name}` | {escape(labels)} |")
            lines += ["", "---", ""]

            # --------------------------------------------------- tables
            step("Reading tables...")
            cur.execute(TABLE_SQL, (S,))
            tables = cur.fetchall()

            # Contents index
            lines += ["## 2. Tables", "", "| # | Table | Rows | Purpose |", "|---|---|---|---|"]
            counts: dict[str, int] = {}
            for idx, (table, comment) in enumerate(tables, start=1):
                cur.execute(f'SELECT count(*) FROM {S}."{table}";')
                counts[table] = cur.fetchone()[0]
                anchor = table.replace("_", "-")
                lines.append(
                    f"| {idx} | [`{table}`](#{anchor}) | {counts[table]:,} | {escape(comment)} |"
                )
            lines += ["", "---", ""]

            # Per-table detail
            for table, comment in tables:
                step(f"Documenting {table}...")
                lines += [f"### {table}", ""]
                if comment:
                    lines += [f"_{comment}_", ""]
                lines += [f"**Live row count:** {counts[table]:,}", "", "#### Columns", "",
                          "| Column | Type | Null | Default |", "|---|---|---|---|"]

                cur.execute(COLUMN_SQL, (S, table))
                for col, dtype, nullable, default, _ccomment in cur.fetchall():
                    dtype = dtype.replace(f"{S}.", "")
                    default_txt = (
                        escape(default).replace(f"{S}.", "") if default else "-"
                    )
                    lines.append(
                        f"| `{col}` | `{dtype}` | "
                        f"{'yes' if nullable else 'NO'} | {default_txt} |"
                    )
                lines.append("")

                cur.execute(CONSTRAINT_SQL, (S, table))
                constraints = cur.fetchall()
                if constraints:
                    lines += ["#### Constraints", "",
                              "| Kind | Name | Definition |", "|---|---|---|"]
                    for name, kind, definition in constraints:
                        lines.append(
                            f"| {CONSTRAINT_KIND.get(kind, kind)} | `{name}` | "
                            f"`{escape(definition).replace(f'{S}.', '')}` |"
                        )
                    lines.append("")

                cur.execute(INDEX_SQL, (S, table))
                indexes = [
                    (n, d) for n, d in cur.fetchall()
                    if not n.endswith("_pkey")
                ]
                if indexes:
                    lines += ["#### Indexes", ""]
                    for name, definition in indexes:
                        compact = (
                            definition.split(" ON ", 1)[-1]
                            .replace(f"{S}.", "")
                        )
                        lines.append(f"- `{name}` on {compact}")
                    lines.append("")

                lines += ["---", ""]

            # ---------------------------------------------------- views
            step("Reading views...")
            cur.execute(VIEW_SQL, (S,))
            views = [row[0] for row in cur.fetchall()]

            lines += ["## 3. Reporting views", "",
                      "Pre-joined projections used by the analytics layer and "
                      "any BI tool pointed at this schema.", ""]
            for view in views:
                cur.execute(f'SELECT count(*) FROM {S}."{view}";')
                nrows = cur.fetchone()[0]
                lines.append(f"### {view}")
                lines.append("")
                lines.append(f"**Rows:** {nrows:,}")
                lines.append("")
                cur.execute(COLUMN_SQL, (S, view))
                lines += ["| Column | Type |", "|---|---|"]
                for col, dtype, _nullable, _default, _c in cur.fetchall():
                    lines.append(f"| `{col}` | `{dtype.replace(f'{S}.', '')}` |")
                lines += ["", "---", ""]

    os.makedirs(os.path.dirname(os.path.abspath(output_path)), exist_ok=True)
    with open(output_path, "w", encoding="utf-8") as handle:
        handle.write("\n".join(lines).rstrip() + "\n")

    ok(f"Wrote {output_path} ({len(lines):,} lines)")


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Generate the CampusPulse data dictionary from the live catalog."
    )
    parser.add_argument("--output", default=os.path.join("docs", "DATA_DICTIONARY.md"))
    args = parser.parse_args()

    try:
        build(args.output)
    except Exception as exc:  # noqa: BLE001 - top-level CLI handler
        fail(f"Documentation export failed: {exc}")
        raise SystemExit(1)


if __name__ == "__main__":
    main()

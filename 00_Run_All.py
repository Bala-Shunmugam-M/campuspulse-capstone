"""
00_Run_All.py
=============
One-command pipeline runner: connect -> create schema -> load data ->
verify integrity -> run analytics.

Each stage is executed as a separate subprocess using the *same* Python
interpreter that is running this file, so it works identically inside a
virtual environment, from a bare `python` on PATH, or from VS Code's
debugger. A non-zero exit from any stage stops the pipeline.

Usage
-----
    python 00_Run_All.py                       # full pipeline, prompts on overwrite
    python 00_Run_All.py --yes                 # unattended (CI-friendly)
    python 00_Run_All.py --scale small --yes   # quick demo dataset
    python 00_Run_All.py --skip-analytics
"""

from __future__ import annotations

import argparse
import subprocess
import sys
import time

from db_config import banner, describe_target, fail, ok, step


def run_stage(title: str, argv: list[str]) -> float:
    banner(title, char="#")
    started = time.perf_counter()
    result = subprocess.run([sys.executable, *argv])
    elapsed = time.perf_counter() - started

    if result.returncode != 0:
        fail(f"Stage failed: {title} (exit code {result.returncode})")
        sys.exit(result.returncode)

    ok(f"{title} finished in {elapsed:.1f}s")
    return elapsed


def main() -> None:
    parser = argparse.ArgumentParser(description="Run the full CampusPulse pipeline.")
    parser.add_argument("-y", "--yes", action="store_true",
                        help="Answer yes to every overwrite prompt.")
    parser.add_argument("--scale", choices=["small", "medium", "large"],
                        help="Override the DATA_SCALE preset for this run.")
    parser.add_argument("--seed", type=int,
                        help="Override the random seed for this run.")
    parser.add_argument("--anchor", metavar="ISO8601",
                        help="Pin the simulated 'now' so the dataset is "
                             "bit-for-bit reproducible (e.g. 2026-08-26T00:00:00Z).")
    parser.add_argument("--skip-analytics", action="store_true")
    parser.add_argument("--export", metavar="DIR",
                        help="Export analytics results to CSVs in DIR.")
    args = parser.parse_args()

    banner("CampusPulse - Full Pipeline")
    step(f"Interpreter : {sys.executable}")
    step(f"Target      : {describe_target()}")

    overall = time.perf_counter()
    timings: list[tuple[str, float]] = []

    timings.append(("Connection test", run_stage("Stage 0 - Connection test", ["db_config.py"])))

    schema_args = ["01_Create_Schema.py"] + (["--yes"] if args.yes else [])
    timings.append(("Create schema", run_stage("Stage 1 - Create schema", schema_args)))

    insert_args = ["02_Insert_Data.py"] + (["--yes"] if args.yes else [])
    if args.scale:
        insert_args += ["--scale", args.scale]
    if args.seed is not None:
        insert_args += ["--seed", str(args.seed)]
    if args.anchor:
        insert_args += ["--anchor", args.anchor]
    timings.append(("Insert data", run_stage("Stage 2 - Generate + load data", insert_args)))

    timings.append(("Verify data", run_stage("Stage 3 - Verify integrity", ["03_Verify_Data.py", "--verbose"])))

    if not args.skip_analytics:
        analytics_args = ["04_Analytics_Queries.py"]
        if args.export:
            analytics_args += ["--export", args.export]
        timings.append(("Analytics", run_stage("Stage 4 - Analytics suite", analytics_args)))

    total = time.perf_counter() - overall

    banner("Pipeline complete")
    for name, seconds in timings:
        print(f"    {name:<18} {seconds:>7.1f}s")
    print(f"    {'TOTAL':<18} {total:>7.1f}s")
    print()


if __name__ == "__main__":
    main()

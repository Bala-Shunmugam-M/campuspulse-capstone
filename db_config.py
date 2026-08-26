"""
db_config.py
============
Shared database configuration + connection helper for the CampusPulse capstone.

Every script in this project imports from here so that connection logic,
credential loading and error handling live in exactly one place.

Nothing in this file contains a hard-coded secret. Credentials are read from
the `.env` file (which is git-ignored) or from real environment variables.

Usage
-----
    from db_config import get_connection, SCHEMA

    with get_connection() as conn:
        with conn.cursor() as cur:
            cur.execute(f"SELECT count(*) FROM {SCHEMA}.incidents;")
            print(cur.fetchone()[0])
"""

from __future__ import annotations

import os
import socket
import sys
import time
from contextlib import contextmanager
from typing import Any, Iterator

import psycopg2
from psycopg2 import OperationalError, sql
from psycopg2.extensions import connection as PgConnection
from dotenv import load_dotenv

# --------------------------------------------------------------------------
# Load .env sitting next to this file (works no matter where you run from)
# --------------------------------------------------------------------------
_PROJECT_ROOT = os.path.dirname(os.path.abspath(__file__))
load_dotenv(os.path.join(_PROJECT_ROOT, ".env"))


# --------------------------------------------------------------------------
# Configuration
# --------------------------------------------------------------------------
SCHEMA: str = os.getenv("DB_SCHEMA", "campuspulse")

DB_HOST: str = os.getenv("DB_HOST", "")
DB_PORT: int = int(os.getenv("DB_PORT", "5432"))
DB_NAME: str = os.getenv("DB_NAME", "postgres")
DB_USER: str = os.getenv("DB_USER", "postgres")
DB_PASSWORD: str = os.getenv("DB_PASSWORD", "")
DB_SSLMODE: str = os.getenv("DB_SSLMODE", "require")

# Optional IPv4 fallback (Supabase Session Pooler)
POOLER_HOST: str = os.getenv("POOLER_HOST", "")
POOLER_PORT: int = int(os.getenv("POOLER_PORT", "5432") or 5432)
POOLER_USER: str = os.getenv("POOLER_USER", "")

CONNECT_TIMEOUT_SECONDS = 20
MAX_RETRIES = 3
RETRY_BACKOFF_SECONDS = 3


class ConfigurationError(RuntimeError):
    """Raised when required settings are missing from the environment."""


def _validate_config() -> None:
    """Fail fast with a human-readable message instead of a psycopg2 stack trace."""
    missing = [
        name
        for name, value in (
            ("DB_HOST", DB_HOST),
            ("DB_PASSWORD", DB_PASSWORD),
            ("DB_NAME", DB_NAME),
            ("DB_USER", DB_USER),
        )
        if not value
    ]
    if missing:
        raise ConfigurationError(
            "Missing required setting(s): "
            + ", ".join(missing)
            + "\n\nCreate a `.env` file next to db_config.py. "
            "Start from the provided template:\n"
            "    Windows :  copy .env.example .env\n"
            "    macOS   :  cp .env.example .env\n"
            "then fill in your Supabase credentials."
        )


def _dsn_params(use_pooler: bool = False) -> dict[str, Any]:
    """Build the keyword arguments handed to psycopg2.connect()."""
    if use_pooler:
        return {
            "host": POOLER_HOST,
            "port": POOLER_PORT,
            "dbname": DB_NAME,
            "user": POOLER_USER or DB_USER,
            "password": DB_PASSWORD,
            "sslmode": DB_SSLMODE,
            "connect_timeout": CONNECT_TIMEOUT_SECONDS,
            "application_name": "campuspulse-capstone",
        }
    return {
        "host": DB_HOST,
        "port": DB_PORT,
        "dbname": DB_NAME,
        "user": DB_USER,
        "password": DB_PASSWORD,
        "sslmode": DB_SSLMODE,
        "connect_timeout": CONNECT_TIMEOUT_SECONDS,
        "application_name": "campuspulse-capstone",
    }


def describe_target() -> str:
    """Safe, printable description of the connection target (never shows the password)."""
    return f"{DB_USER}@{DB_HOST}:{DB_PORT}/{DB_NAME} (sslmode={DB_SSLMODE}, schema={SCHEMA})"


def _host_resolves(host: str) -> bool:
    try:
        socket.getaddrinfo(host, None)
        return True
    except socket.gaierror:
        return False


def get_connection(autocommit: bool = False) -> PgConnection:
    """
    Open a psycopg2 connection to Supabase/PostgreSQL.

    Retries transient failures, and transparently falls back to the Supabase
    Session Pooler when the direct host cannot be reached (a very common
    problem on IPv4-only networks, since `db.<ref>.supabase.co` is IPv6-only
    on newer Supabase projects).
    """
    _validate_config()

    attempts: list[tuple[str, bool]] = [("direct", False)]
    if POOLER_HOST:
        attempts.append(("pooler", True))

    last_error: Exception | None = None

    for label, use_pooler in attempts:
        params = _dsn_params(use_pooler)
        if not _host_resolves(params["host"]):
            last_error = OperationalError(
                f"Hostname '{params['host']}' could not be resolved by DNS."
            )
            continue

        for attempt in range(1, MAX_RETRIES + 1):
            try:
                conn = psycopg2.connect(**params)
                conn.autocommit = autocommit
                # Make the app schema the default for unqualified names.
                with conn.cursor() as cur:
                    cur.execute(
                        sql.SQL("SET search_path TO {}, public;").format(
                            sql.Identifier(SCHEMA)
                        )
                    )
                if not autocommit:
                    conn.commit()
                return conn
            except OperationalError as exc:
                last_error = exc
                if attempt < MAX_RETRIES:
                    time.sleep(RETRY_BACKOFF_SECONDS * attempt)

        # direct route exhausted -> try the pooler on the next loop iteration

    raise OperationalError(
        f"Could not connect to the database.\n"
        f"Target: {describe_target()}\n"
        f"Last error: {last_error}\n\n"
        "Troubleshooting checklist:\n"
        "  1. Is the password in .env correct? (Supabase -> Settings -> Database)\n"
        "  2. Is the Supabase project awake, not paused?\n"
        "  3. On an IPv4-only network the direct host will not resolve. Copy the\n"
        "     Session Pooler values from Supabase -> Database -> Connection Pooling\n"
        "     into POOLER_HOST / POOLER_PORT / POOLER_USER in your .env.\n"
        "  4. Some campus/corporate networks block outbound port 5432. Try a\n"
        "     mobile hotspot to confirm."
    )


@contextmanager
def managed_connection(autocommit: bool = False) -> Iterator[PgConnection]:
    """Context manager that always closes the connection, committing on success."""
    conn = get_connection(autocommit=autocommit)
    try:
        yield conn
        if not autocommit:
            conn.commit()
    except Exception:
        if not autocommit:
            conn.rollback()
        raise
    finally:
        conn.close()


# --------------------------------------------------------------------------
# Small console helpers, shared by all scripts for consistent output
# --------------------------------------------------------------------------
def banner(title: str, char: str = "=", width: int = 74) -> None:
    print()
    print(char * width)
    print(f"  {title}")
    print(char * width)


def step(message: str) -> None:
    print(f"  -> {message}")


def ok(message: str) -> None:
    print(f"  [OK] {message}")


def warn(message: str) -> None:
    print(f"  [!!] {message}")


def fail(message: str) -> None:
    print(f"  [XX] {message}", file=sys.stderr)


if __name__ == "__main__":
    # Running `python db_config.py` performs a quick connectivity smoke test.
    banner("CampusPulse - Connection Test")
    step(f"Target: {describe_target()}")
    try:
        with managed_connection() as conn:
            with conn.cursor() as cur:
                cur.execute("SELECT version(), current_database(), current_user;")
                version, database, user = cur.fetchone()
        ok(f"Connected as '{user}' to database '{database}'")
        ok(version.split(" on ")[0])
    except Exception as exc:  # noqa: BLE001 - top-level CLI handler
        fail(str(exc))
        sys.exit(1)

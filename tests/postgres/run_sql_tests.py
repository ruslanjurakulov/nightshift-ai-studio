#!/usr/bin/env python3
"""Local PostgreSQL smoke/concurrency runner.

This is deliberately conservative: it reports UNRUN when psycopg or the
database is unavailable and never substitutes SQLite or fake PASS results.
Full identity-wrapper assertions are added only after the approved host loads
the complete migration chain and its role fixture.
"""
from __future__ import annotations

import os
import re
import sys


def main() -> int:
    try:
        import psycopg
    except ImportError:
        print("UNRUN: psycopg is not installed on this development host")
        return 2
    dsn = os.environ.get(
        "NIGHTSHIFT_TEST_DSN",
        "host=127.0.0.1 port=55322 dbname=postgres user=postgres",
    )
    host = re.search(r"(?:^|\s)host=([^\s]+)", dsn)
    port = re.search(r"(?:^|\s)port=([0-9]+)", dsn)
    if not host or host.group(1) not in {"127.0.0.1", "localhost"} or not port or port.group(1) != "55322":
        print("UNRUN: DSN is outside the approved local Supabase endpoint")
        return 2
    try:
        with psycopg.connect(dsn) as conn:
            with conn.cursor() as cur:
                cur.execute("select current_database(), current_user")
                db, user = cur.fetchone()
                if db not in {"postgres", "nightshift_test"} or user not in {"postgres", "nightshift_test"}:
                    print("UNRUN: refusing a non-disposable database")
                    return 2
                cur.execute("select to_regclass('public.creative_jobs')")
                if cur.fetchone()[0] is None:
                    print("UNRUN: creative_jobs migration is not loaded")
                    return 2
        print("UNRUN: database reachable; security/concurrency fixture roles are not installed yet")
        return 2
    except Exception as exc:  # connection failures are an explicit UNRUN
        print(f"UNRUN: PostgreSQL test database unavailable ({type(exc).__name__})")
        return 2


if __name__ == "__main__":
    sys.exit(main())


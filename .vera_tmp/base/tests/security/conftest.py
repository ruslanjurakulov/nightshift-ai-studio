"""Fixtures for the security lab (tests/security).

The lab needs a Postgres it may create databases in, named by
NIGHTSHIFT_SECURITY_PG (a superuser DSN). Without one — a laptop running the
unit suite, the Python `tests.yml` job — every test here is skipped with that
reason. The `security.yml` workflow provides one and sets
NIGHTSHIFT_SECURITY_REQUIRED, which turns a missing database or driver into a
failure: in CI a skipped security test is a hole nobody looked at.
"""

from __future__ import annotations

import os
import sys
import uuid
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))

# Without the driver there is nothing to collect: the unit suite on a machine
# that never installed tests/security/requirements.txt passes over this
# directory. In CI (NIGHTSHIFT_SECURITY_REQUIRED) the imports are left to fail.
try:
    import psycopg  # noqa: F401
except ImportError:
    if not os.environ.get("NIGHTSHIFT_SECURITY_REQUIRED"):
        collect_ignore_glob = ["test_sec_*.py"]


def _unavailable(reason: str):
    if os.environ.get("NIGHTSHIFT_SECURITY_REQUIRED"):
        pytest.fail(reason, pytrace=False)
    pytest.skip(reason)


@pytest.fixture(scope="session")
def lab():
    import psycopg
    import sec_db
    from sec_scenario import build_scenario

    dsn = sec_db.admin_dsn()
    if not dsn:
        _unavailable(f"{sec_db.DSN_ENV} is not set — the security lab needs a scratch Postgres")

    dbname = f"ns_security_lab_{uuid.uuid4().hex[:8]}"
    db_dsn = sec_db.build(dsn, dbname)
    conn = psycopg.connect(db_dsn, autocommit=True)
    try:
        scenario = build_scenario(conn)
        yield conn, scenario
    finally:
        conn.close()
        if not os.environ.get("NIGHTSHIFT_SECURITY_KEEP"):
            sec_db.drop_database(dsn, dbname)


@pytest.fixture(scope="session")
def conn(lab):
    return lab[0]


@pytest.fixture(scope="session")
def sc(lab):
    return lab[1]

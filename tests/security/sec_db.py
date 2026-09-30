"""Database plumbing for the security lab: build a scratch database from the
repository's own SQL, and act inside it as a given API caller.

Everything here talks to a plain Postgres 16 (the CI service container, or a
local cluster). ``bootstrap.sql`` stands in for what Supabase provides before
our SQL runs; see that file for what is emulated and why it is enough.

The admin DSN comes from ``NIGHTSHIFT_SECURITY_PG`` and must be a superuser
(``postgres``): it creates the scratch database, applies the migrations and
switches into the API roles with ``SET LOCAL ROLE``.
"""

from __future__ import annotations

import json
import os
import re
import sys
import uuid
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterator, Optional, Sequence

import psycopg
from psycopg import sql

REPO = Path(__file__).resolve().parents[2]
BOOTSTRAP = Path(__file__).resolve().parent / "bootstrap.sql"
SCHEMA = REPO / "supabase" / "schema.sql"
MIGRATIONS = REPO / "supabase" / "migrations"

DSN_ENV = "NIGHTSHIFT_SECURITY_PG"

_MIGRATION_RE = re.compile(r"^(\d{4})_[a-z0-9_]+\.sql$")


def admin_dsn() -> Optional[str]:
    return os.environ.get(DSN_ENV) or None


def migration_files() -> list[Path]:
    """Every migration, in sorted filename order — the order a fresh project
    applies them. Numbers need not be contiguous (migrations can merge out of
    order), but two files with the same number are an error: their relative
    order would be an accident of naming. A .sql file that does not match the
    naming rule is an error too, rather than silently skipped — an unapplied
    migration is exactly what this lab exists to notice."""
    files = sorted(p for p in MIGRATIONS.iterdir() if p.suffix == ".sql")
    bad = [p.name for p in files if not _MIGRATION_RE.match(p.name)]
    if bad:
        raise RuntimeError(f"migration files not named NNNN_name.sql: {bad}")
    seen: dict[str, str] = {}
    dupes = []
    for p in files:
        n = _MIGRATION_RE.match(p.name).group(1)
        if n in seen:
            dupes.append(f"{seen[n]} / {p.name}")
        seen[n] = p.name
    if dupes:
        raise RuntimeError(f"two migrations share a number: {dupes}")
    return files


def build_sequence() -> list[Path]:
    """What a fresh Supabase project runs, in order: the platform stand-in,
    schema.sql (docs/SUPABASE.md step 2), then every migration."""
    return [BOOTSTRAP, SCHEMA, *migration_files()]


class ApplyError(RuntimeError):
    pass


def _dsn_for(dsn: str, dbname: str) -> str:
    return psycopg.conninfo.make_conninfo(dsn, dbname=dbname)


def create_database(dsn: str, dbname: str) -> str:
    with psycopg.connect(dsn, autocommit=True) as c:
        c.execute(sql.SQL("drop database if exists {} with (force)").format(sql.Identifier(dbname)))
        c.execute(sql.SQL("create database {}").format(sql.Identifier(dbname)))
    return _dsn_for(dsn, dbname)


def drop_database(dsn: str, dbname: str) -> None:
    with psycopg.connect(dsn, autocommit=True) as c:
        c.execute(sql.SQL("drop database if exists {} with (force)").format(sql.Identifier(dbname)))


def apply_files(db_dsn: str, files: Sequence[Path]) -> None:
    """Apply each file in its own round trip, stopping at the first error with
    the file name in the message. Files are sent whole (simple protocol), the
    way the Supabase SQL editor runs them."""
    with psycopg.connect(db_dsn, autocommit=True) as c:
        for f in files:
            try:
                c.execute(f.read_text(encoding="utf-8"))
            except psycopg.Error as e:
                diag = e.diag
                where = f" ({diag.context.strip()})" if diag and diag.context else ""
                raise ApplyError(f"{f.relative_to(REPO)}: {diag.sqlstate if diag else ''} "
                                 f"{str(e).strip()}{where}") from e


def build(dsn: str, dbname: str) -> str:
    db_dsn = create_database(dsn, dbname)
    apply_files(db_dsn, build_sequence())
    return db_dsn


# ── acting as an API caller ─────────────────────────────────────────────────

@dataclass(frozen=True)
class Actor:
    """Someone making a request through PostgREST."""

    name: str
    role: str  # anon | authenticated | service_role
    uid: Optional[str] = None
    email: Optional[str] = None

    def claims(self) -> dict[str, Any]:
        c: dict[str, Any] = {"role": self.role}
        if self.uid:
            c["sub"] = self.uid
        if self.email:
            c["email"] = self.email
        return c


ANON = Actor("anon", "anon")
SERVICE = Actor("service", "service_role")


def user(name: str, email: str, uid: Optional[str] = None) -> Actor:
    return Actor(name, "authenticated", uid or str(uuid.uuid4()), email)


@dataclass
class Outcome:
    ok: bool
    rowcount: int = 0
    rows: list = None  # type: ignore[assignment]
    sqlstate: Optional[str] = None
    error: Optional[str] = None

    def __repr__(self) -> str:  # readable in assertion messages
        if self.ok:
            return f"<ok rowcount={self.rowcount} rows={self.rows!r}>"
        return f"<error {self.sqlstate}: {self.error}>"


class Session:
    """One transaction as one caller. Every statement runs in its own
    savepoint, so a refused attack does not poison the next one."""

    def __init__(self, conn: psycopg.Connection):
        self.conn = conn

    def run(self, query, params: Optional[Sequence[Any]] = None) -> Outcome:
        try:
            with self.conn.transaction():
                cur = self.conn.execute(query, params)
                rows = cur.fetchall() if cur.description else []
                return Outcome(True, cur.rowcount, rows)
        except psycopg.Error as e:
            return Outcome(False, sqlstate=e.sqlstate, error=str(e).strip().splitlines()[0])

    def rows(self, query, params: Optional[Sequence[Any]] = None) -> list:
        out = self.run(query, params)
        if not out.ok:
            raise AssertionError(f"query failed: {out!r}\n{query}")
        return out.rows

    def value(self, query, params: Optional[Sequence[Any]] = None) -> Any:
        rows = self.rows(query, params)
        return rows[0][0] if rows else None


@contextmanager
def acting(conn: psycopg.Connection, who: Actor, *, commit: bool = False) -> Iterator[Session]:
    """A transaction in which PostgREST would be serving `who`: the JWT claims
    set for this transaction only, and the API role switched to. Rolled back
    unless `commit` — an attack must never leave anything behind for the next
    test to trip over."""
    with conn.transaction(force_rollback=not commit):
        conn.execute("select set_config('request.jwt.claims', %s, true)", [json.dumps(who.claims())])
        conn.execute("select set_config('request.jwt.claim.role', %s, true)", [who.role])
        conn.execute(sql.SQL("set local role {}").format(sql.Identifier(who.role)))
        yield Session(conn)


@contextmanager
def as_superuser(conn: psycopg.Connection, *, commit: bool = True) -> Iterator[Session]:
    """The database owner, for seeding what only Supabase itself could write
    (auth.users, Vault) and for reading the ground truth an attack is checked
    against."""
    with conn.transaction(force_rollback=not commit):
        conn.execute("select set_config('request.jwt.claims', '', true)")
        yield Session(conn)


def main() -> int:
    """`python tests/security/sec_db.py`: apply bootstrap, schema.sql and every
    migration, in order, to a fresh database — the CI step that fails the job
    on the first migration that does not apply."""
    dsn = admin_dsn()
    if not dsn:
        print(f"{DSN_ENV} is not set", file=sys.stderr)
        return 2
    dbname = "ns_security_migrations"
    db_dsn = create_database(dsn, dbname)
    try:
        for f in build_sequence():
            apply_files(db_dsn, [f])
            print(f"applied {f.relative_to(REPO)}")
    except ApplyError as e:
        print(f"::error::{e}", file=sys.stderr)
        return 1
    finally:
        drop_database(dsn, dbname)
    return 0


if __name__ == "__main__":
    sys.exit(main())

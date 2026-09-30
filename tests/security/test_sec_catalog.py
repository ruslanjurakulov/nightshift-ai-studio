"""The catalog is closed: nothing reaches the API roles undeclared.

A migration that adds a table or a function has to add it to
sec_expectations.py, which means somebody decided whose rows it holds and who
may call it — and the isolation and attack tests then hold it to that.
"""

from __future__ import annotations

import pytest

from sec_db import as_superuser
from sec_expectations import FUNCTIONS, TABLES, VIEWS


def _tables(conn, *, rls: bool | None = None) -> set[str]:
    with as_superuser(conn, commit=False) as s:
        rows = s.rows(
            "select c.relname, c.relrowsecurity from pg_class c "
            "where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p')")
    return {r[0] for r in rows if rls is None or r[1] == rls}


def test_every_public_table_has_row_level_security(conn):
    # Supabase exposes every table in `public` through PostgREST, and its
    # default grants give anon and authenticated full access. A table without
    # RLS is a table the whole internet can read and write.
    assert _tables(conn, rls=False) == set()


def test_every_rls_table_declares_its_isolation(conn):
    live = _tables(conn, rls=True)
    undeclared = sorted(live - set(TABLES))
    stale = sorted(set(TABLES) - live)
    assert not undeclared, (
        f"tables with no entry in tests/security/sec_expectations.py TABLES: {undeclared} — "
        "declare whose rows each one holds (Org/Channel/Video/Platform/Public/Service)")
    assert not stale, f"TABLES lists tables that do not exist: {stale}"


def test_every_view_is_declared_and_runs_as_its_caller(conn):
    # A view runs with its owner's rights and ignores the caller's RLS unless
    # it is security_invoker, so each one is a decision: declared in VIEWS,
    # security_invoker, and never a materialized view (which has no RLS).
    with as_superuser(conn, commit=False) as s:
        rows = s.rows(
            "select c.relname, c.relkind, "
            "coalesce(exists (select 1 from unnest(c.reloptions) o where o in ('security_invoker=true', 'security_invoker=on')), false) "
            "from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind in ('v', 'm')")
    live = {r[0] for r in rows}
    assert not [r[0] for r in rows if r[1] == "m"], "materialized views bypass RLS"
    assert not sorted(live - set(VIEWS)), (
        f"views with no entry in tests/security/sec_expectations.py VIEWS: {sorted(live - set(VIEWS))}")
    assert not sorted(set(VIEWS) - live), f"VIEWS lists views that do not exist: {sorted(set(VIEWS) - live)}"
    assert not [r[0] for r in rows if not r[2]], f"views without security_invoker: {[r[0] for r in rows if not r[2]]}"


def _functions(conn):
    """Every callable function in public that is not a trigger function and
    not an extension's own (pgcrypto lives in `extensions` on Supabase)."""
    with as_superuser(conn, commit=False) as s:
        return s.rows(
            """
            select p.proname, pg_get_function_identity_arguments(p.oid),
                   has_function_privilege('anon', p.oid, 'execute'),
                   has_function_privilege('authenticated', p.oid, 'execute')
              from pg_proc p
             where p.pronamespace = 'public'::regnamespace
               and p.prokind = 'f'
               and p.prorettype <> 'trigger'::regtype
               and not exists (select 1 from pg_depend d
                                where d.objid = p.oid and d.classid = 'pg_proc'::regclass and d.deptype = 'e')
             order by 1, 2
            """)


def test_every_function_declares_who_may_call_it(conn):
    live = {r[0] for r in _functions(conn)}
    undeclared = sorted(live - set(FUNCTIONS))
    stale = sorted(set(FUNCTIONS) - live)
    assert not undeclared, (
        f"functions with no entry in tests/security/sec_expectations.py FUNCTIONS: {undeclared} — "
        "declare whether anon / authenticated may execute each one")
    assert not stale, f"FUNCTIONS lists functions that do not exist: {stale}"


def test_function_execute_grants_match_the_declaration(conn):
    wrong = []
    for name, args, anon, authed in _functions(conn):
        want = FUNCTIONS.get(name)
        if want is not None and (anon, authed) != want:
            wrong.append(f"{name}({args}): anon={anon} authenticated={authed}, declared anon={want[0]} authenticated={want[1]}")
    assert not wrong, "execute grants differ from sec_expectations.FUNCTIONS:\n  " + "\n  ".join(wrong)


def test_security_definer_functions_pin_their_search_path(conn):
    # A security-definer function without a pinned search_path can be steered
    # into calling an attacker's object of the same name.
    with as_superuser(conn, commit=False) as s:
        rows = s.rows(
            """
            select p.proname from pg_proc p
             where p.pronamespace = 'public'::regnamespace and p.prosecdef
               and not exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%')
            """)
    assert rows == []

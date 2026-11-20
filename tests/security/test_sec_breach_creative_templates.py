"""Breach on 0181 (trend templates): the attacks beyond the contract suite, kept as regression tests.

No attack here succeeded when written; each test pins the lock that stopped it, named for what would break.
  * a draft is reached through a view or a security-definer function       test_nothing_reads_the_table_around_its_policy
  * a browser reaches a function that writes the table                     test_no_function_writes_the_table
"""
from sec_db import as_superuser


def test_nothing_reads_the_table_around_its_policy(conn):
    with as_superuser(conn, commit=False) as s:
        views = s.rows("select schemaname || '.' || viewname from pg_views where definition ilike '%%creative_templates%%'")
        assert views == [], f"a view reads creative_templates and may bypass RLS for drafts: {views}"
        funcs = s.rows("select p.oid::regprocedure::text from pg_proc p where p.prosrc ilike '%%creative_templates%%' "
                       "and p.prosecdef")
        assert funcs == [], f"a security-definer function reads creative_templates: {funcs}"


def test_no_function_writes_the_table(conn):
    # The only function 0181 adds is the updated_at trigger; anything else naming the table is a write path nobody reviewed.
    with as_superuser(conn, commit=False) as s:
        funcs = s.rows("select p.proname from pg_proc p where p.prosrc ilike '%%creative_templates%%'")
        assert {r[0] for r in funcs} <= {"creative_templates_touch"}, funcs

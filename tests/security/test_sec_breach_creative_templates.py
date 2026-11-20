"""Breach on 0181 (trend templates): the attacks beyond the contract suite, kept as regression tests.

No attack here succeeded when written; each test pins the lock that stopped it, named for what would break.
  * a customer clears request.jwt.claims (or drops back to the login role) to pass the SQL-editor test   test_a_customer_cannot_pass_as_the_sql_editor
  * the login role PostgREST connects as is read as the SQL editor                                       test_the_api_login_role_is_never_the_editor
  * a browser uploads or upserts into template-media (any name, any storage.operation)                    test_no_api_role_uploads_into_template_media
  * a customer moves their own avatar object into template-media (storage "move" is an UPDATE)           test_an_avatar_cannot_be_moved_into_template_media
  * a draft is reached through a view or another function                                                test_only_the_owner_function_touches_the_table
  * the owner path writes a path that leaves the bucket                                                  test_the_owner_path_cannot_store_an_escaping_path
"""
import pytest

from sec_creative_templates_0181 import DRAFT_SLUG
from sec_db import ANON, acting, as_superuser


def _draft_published(conn):
    with as_superuser(conn, commit=False) as s:
        return s.value("select published from public.creative_templates where slug = %s", [DRAFT_SLUG])


def test_a_customer_cannot_pass_as_the_sql_editor(conn, sc):
    for who in (sc.bob.actor, sc.alice.actor, sc.stranger, sc.dana):
        with acting(conn, who) as s:
            # An RPC body cannot run set_config, but a chain of public functions might; assume the worst.
            s.rows("select set_config('request.jwt.claims', '', true)")
            s.rows("select set_config('request.jwt.claim.role', '', true)")
            out = s.run("select public.set_creative_template_media(%s, true, null, null)", [DRAFT_SLUG])
            assert not out.ok and out.sqlstate == "42501", f"{who.name} with no claims: {out!r}"
    assert _draft_published(conn) is False


def test_the_api_login_role_is_never_the_editor(conn):
    # With the role GUC at 'none' the function reads session_user; under PostgREST that is authenticator, which must be refused
    # even if someone later makes it a member of postgres.
    with as_superuser(conn, commit=False) as s:
        # bootstrap.sql has no authenticator role; where one exists it must not be a member of postgres.
        for r in ("anon", "authenticated", "service_role", "authenticator"):
            if not s.value("select exists (select 1 from pg_roles where rolname = %s)", [r]):
                continue
            assert s.value("select pg_has_role(%s, 'postgres', 'member')", [r]) is False, r
        src = s.value("select prosrc from pg_proc where proname = 'set_creative_template_media'")
        assert "'authenticator'" in src, "the editor allow-list no longer excludes the PostgREST login role"


@pytest.mark.parametrize("name", ["x.mp4", "{uid}/x.mp4", "lab-published/preview.mp4", "{uid}/avatar.jpg",
                                  "{uid}/{uid}/sample.mp4"])
@pytest.mark.parametrize("op", ["upload", "object", "storage.object.upload", ""])
def test_no_api_role_uploads_into_template_media(conn, sc, name, op):
    for who in (ANON, sc.bob.actor, sc.stranger):
        n = name.format(uid=who.uid or "00000000-0000-0000-0000-000000000000")
        with acting(conn, who) as s:
            s.rows("select set_config('storage.operation', %s, true)", [op])
            out = s.run("insert into storage.objects (bucket_id, name, owner) values ('template-media', %s, %s) "
                        "on conflict do nothing returning id", [n, who.uid])
            assert not out.ok or out.rowcount == 0, f"{who.name} uploaded {n!r} into template-media: {out!r}"


def test_an_avatar_cannot_be_moved_into_template_media(conn, sc):
    who = sc.bob.actor
    with acting(conn, who) as s:
        s.run("select set_config('storage.operation', 'upload', true)")
        ins = s.run("insert into storage.objects (bucket_id, name, owner) values ('avatars', %s, %s) returning id",
                    [f"{who.uid}/avatar.jpg", who.uid])
        if not ins.ok:
            pytest.skip(f"the lab's avatar policy refused the setup upload: {ins!r}")
        s.run("select set_config('storage.operation', 'move', true)")
        out = s.run("update storage.objects set bucket_id = 'template-media', name = 'lab-published/poster.jpg' "
                    "where bucket_id = 'avatars' and name = %s", [f"{who.uid}/avatar.jpg"])
        assert not out.ok or out.rowcount == 0, f"an avatar moved into template-media: {out!r}"


def test_only_the_owner_function_touches_the_table(conn):
    with as_superuser(conn, commit=False) as s:
        views = s.rows("select schemaname || '.' || viewname from pg_views where definition ilike '%%creative_templates%%'")
        assert views == [], f"a view reads creative_templates and may bypass RLS for drafts: {views}"
        funcs = s.rows("select p.oid::regprocedure::text from pg_proc p where p.prosrc ilike '%%creative_templates%%' "
                       "and p.prosecdef and p.proname <> 'set_creative_template_media'")
        assert funcs == [], f"another security-definer function reads creative_templates: {funcs}"


@pytest.mark.parametrize("path", ["a/../../avatars/x.mp4", "https://evil.example/x.mp4", "A/x.mp4", "x.mp4\n", "x.mp4/../y.mp4",
                                  "a%2f..%2fx.mp4", "x.svg"])
def test_the_owner_path_cannot_store_an_escaping_path(conn, path):
    with as_superuser(conn, commit=False) as s:
        out = s.run("select public.set_creative_template_media(%s, false, %s, null)", [DRAFT_SLUG, path])
        assert not out.ok and out.sqlstate == "23514", f"{path!r}: {out!r}"

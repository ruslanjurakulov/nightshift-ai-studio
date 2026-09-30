"""Named attacks on the media library (migration 0038).

The table-by-table isolation tests already prove that Bob (org B) cannot read,
change, delete, move or insert Alice's (org A) media rows. These prove the
functions: the upload ticket flow, soft delete, and the worker's registering
and purging — the paths where the check lives in plpgsql, not in a policy.
"""

from __future__ import annotations

import uuid

import pytest

from sec_db import ANON, SERVICE, acting, as_superuser


def ticket_status(conn, ticket: str) -> str:
    with as_superuser(conn, commit=False) as s:
        return s.value("select status from public.media_uploads where id = %s", [ticket])


def asset_row(conn, asset: str):
    with as_superuser(conn, commit=False) as s:
        return s.rows("select org_id::text, deleted_at, purged_at from public.media_assets where id = %s", [asset])[0]


# ── uploads ─────────────────────────────────────────────────────────────────

def test_customer_cannot_request_an_upload_into_another_org(conn, sc):
    with acting(conn, sc.bob.actor) as s:
        out = s.run("select public.request_upload(%s, 'x.png', 'image/png', 10)", [sc.alice.org])
    assert not out.ok and out.sqlstate == "42501", out


@pytest.mark.parametrize("who", ["stranger", "anon"])
def test_outsiders_cannot_request_uploads(conn, sc, who):
    actor = sc.stranger if who == "stranger" else ANON
    with acting(conn, actor) as s:
        out = s.run("select public.request_upload(%s, 'x.png', 'image/png', 10)", [sc.alice.org])
    assert not out.ok and out.sqlstate == "42501", out


def test_customer_cannot_send_the_body_of_another_orgs_ticket(conn, sc):
    before = ticket_status(conn, sc.alice.media_ticket)
    with acting(conn, sc.bob.actor) as s:
        begin = s.run("select public.begin_upload_receive(%s)", [sc.alice.media_ticket])
        finish = s.run("select public.finish_upload_receive(%s, 10, true)", [sc.alice.media_ticket])
    # "Not found", not "forbidden": a ticket id says nothing to someone else.
    assert not begin.ok and begin.sqlstate == "P0002", begin
    assert not finish.ok and finish.sqlstate == "P0002", finish
    assert ticket_status(conn, sc.alice.media_ticket) == before


def test_a_member_cannot_hijack_a_colleagues_ticket(conn, sc):
    # Ivan holds an invite into org A (a member by email), but is not the person who
    # asked for the ticket, so he may not send its body.
    with acting(conn, sc.invitee) as s:
        out = s.run("select public.begin_upload_receive(%s)", [sc.alice.media_ticket])
    assert not out.ok and out.sqlstate == "P0002", out


def test_a_ticket_is_received_once(conn, sc):
    with acting(conn, sc.alice.actor) as s:
        t = s.value("select public.request_upload(%s, 'clip.mp4', 'video/mp4', 100) ->> 'ticket'", [sc.alice.org])
        first = s.value("select public.begin_upload_receive(%s)", [t])
        second = s.value("select public.begin_upload_receive(%s)", [t])
        over = s.value("select public.finish_upload_receive(%s, 101, true)", [t])
    assert first["ok"] is True
    assert second["ok"] is False
    assert over == "rejected"  # more than declared is never 'uploaded'


def test_path_characters_in_a_filename_are_only_a_label(conn, sc):
    with acting(conn, sc.alice.actor) as s:
        out = s.value("select public.request_upload(%s, %s, 'image/png', 10)",
                      [sc.alice.org, "../../../etc/cron.d/evil\x01.png"])
    assert out["name"] == "evil.png"


@pytest.mark.parametrize("name,mime", [
    ("photo.png", "video/mp4"),        # extension and type disagree
    ("payload.exe", "image/png"),      # not media by name
    ("x.svg", "image/svg+xml"),        # a browser would run it
    ("page", "text/html"),
])
def test_spoofed_types_are_refused_before_a_ticket(conn, sc, name, mime):
    with acting(conn, sc.alice.actor) as s:
        out = s.run("select public.request_upload(%s, %s, %s, 10)", [sc.alice.org, name, mime])
    assert not out.ok and out.sqlstate == "NS415", out


def test_quota_is_enforced_for_the_member_who_asks(conn, sc):
    with as_superuser(conn) as s:
        s.rows("update public.org_storage_quota set limit_bytes = used_bytes + 5000 where org_id = %s returning 1",
               [sc.bob.org])
    try:
        with acting(conn, sc.bob.actor) as s:
            out = s.run("select public.request_upload(%s, 'big.mp4', 'video/mp4', 10000)", [sc.bob.org])
        assert not out.ok and out.sqlstate == "NS507", out
    finally:
        with as_superuser(conn) as s:
            s.rows("update public.org_storage_quota set limit_bytes = null where org_id = %s returning 1", [sc.bob.org])


# ── assets ──────────────────────────────────────────────────────────────────

def test_customer_cannot_delete_another_orgs_asset(conn, sc):
    with acting(conn, sc.bob.actor) as s:
        out = s.run("select public.soft_delete_asset(%s)", [sc.alice.media_asset])
    assert not out.ok and out.sqlstate == "P0002", out
    assert asset_row(conn, sc.alice.media_asset)[1] is None


@pytest.mark.parametrize("who", ["stranger", "anon"])
def test_outsiders_cannot_delete_assets(conn, sc, who):
    actor = sc.stranger if who == "stranger" else ANON
    with acting(conn, actor) as s:
        out = s.run("select public.soft_delete_asset(%s)", [sc.alice.media_asset])
    assert not out.ok, out
    assert asset_row(conn, sc.alice.media_asset)[1] is None


def test_a_deleted_asset_is_hidden_from_its_own_members(conn, sc):
    with acting(conn, sc.alice.actor) as s:
        assert s.value("select public.soft_delete_asset(%s)", [sc.alice.media_asset]) is True
        assert s.rows("select 1 from public.media_assets where id = %s", [sc.alice.media_asset]) == []
    # acting() rolled it back: the seed row is live again for the other tests.
    assert asset_row(conn, sc.alice.media_asset)[1] is None


SERVICE_CALLS = [
    ("register_asset", "select public.register_asset(gen_random_uuid(), %(org)s, 'image', 'image/png', 1, "
                       "repeat('a', 64), 'generated')"),
    ("claim_media_upload", "select * from public.claim_media_upload('bob')"),
    ("reject_media_upload", "select public.reject_media_upload(%(ticket)s, 'bob', 'nope')"),
    ("claim_media_purge", "select * from public.claim_media_purge(10)"),
    ("mark_asset_purged", "select public.mark_asset_purged(%(asset)s)"),
]


@pytest.mark.parametrize("name,query", SERVICE_CALLS, ids=[c[0] for c in SERVICE_CALLS])
def test_customer_cannot_call_the_workers_functions(conn, sc, name, query):
    args = {"org": sc.alice.org, "ticket": sc.alice.media_ticket, "asset": sc.alice.media_asset}
    for who in (sc.bob.actor, sc.alice.actor, ANON):
        with acting(conn, who) as s:
            out = s.run(query, args)
        assert not out.ok and out.sqlstate == "42501", f"{name} as {who.name}: {out!r}"


def test_the_worker_cannot_register_an_upload_into_another_org(conn, sc):
    with acting(conn, sc.alice.actor, commit=True) as s:
        t = s.value("select public.request_upload(%s, 'a.png', 'image/png', 50) ->> 'ticket'", [sc.alice.org])
        s.value("select public.begin_upload_receive(%s)", [t])
        s.value("select public.finish_upload_receive(%s, 50, true)", [t])
    with acting(conn, SERVICE) as s:
        claimed = s.rows("select id::text from public.claim_media_upload('w1')")
        assert claimed and claimed[0][0] == t
        out = s.run("select public.register_asset(gen_random_uuid(), %s, 'image', 'image/png', 50, repeat('b', 64), "
                    "'upload', p_upload_id => %s)", [sc.bob.org, t])
        assert not out.ok and out.sqlstate == "42501", out
        # Without an org the ticket's own is used, and the row is Alice's.
        ok = s.value("select public.register_asset(gen_random_uuid(), null, 'image', 'image/png', 50, repeat('b', 64), "
                     "'upload', p_upload_id => %s) ->> 'id'", [t])
        assert s.value("select org_id::text from public.media_assets where id = %s", [ok]) == sc.alice.org
    # Leave nothing in flight for the other tests.
    with as_superuser(conn) as s:
        s.rows("update public.media_uploads set status = 'expired' where id = %s returning 1", [t])


def test_a_version_of_another_orgs_asset_cannot_be_registered(conn, sc):
    with acting(conn, SERVICE) as s:
        out = s.run("select public.register_asset(gen_random_uuid(), %s, 'image', 'image/png', 1, repeat('c', 64), "
                    "'generated', p_parent_asset_id => %s)", [sc.bob.org, sc.alice.media_asset])
    assert not out.ok and out.sqlstate == "42501", out


def test_nobody_can_choose_where_a_file_lives(conn, sc):
    aid = str(uuid.uuid4())
    with as_superuser(conn, commit=False) as s:
        out = s.run("insert into public.media_assets (id, org_id, kind, mime, bytes, sha256, source, storage_key) "
                    "values (%s, %s, 'image', 'image/png', 1, repeat('d', 64), 'generated', '../../etc')",
                    [aid, sc.alice.org])
        assert not out.ok and out.sqlstate == "428C9", out  # generated column
        key = s.value("select storage_key from public.media_assets where id = %s", [sc.alice.media_asset])
    assert key == f"{sc.alice.media_asset[:2]}/{sc.alice.media_asset}"

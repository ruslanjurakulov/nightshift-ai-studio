"""Migration 0101: a private review link — a view-only link to one video's review
copy, for someone with no account.

The link lets a stranger read a file from a private bucket, so every test is an
attack on WHO can make, see, revoke or use one, and on WHAT a token reaches.
What would break without each:

* the token (or anything that opens the link) being stored: the table keeps only
  its SHA-256, and the stored hash is not itself a key (sent as the token it
  opens nothing);
* a member of another organization (or a viewer / editor of the same one, or a
  signed-out caller) creating, listing or revoking a link, or learning that a
  video exists: every refusal reads as "not found";
* an expired, revoked, unknown or wrong-shaped token still working, or telling
  the caller which of those it was (all are "gone");
* a token of organization A reaching an object of organization B, in the page's
  function, in the stream's function or in the storage policy; a link following a
  channel that moved organization, or a preview path that points into another
  channel's folder;
* the storage policy being wider than one object: no header, a bad header, a
  token for another bucket's object, the voice samples, a write, or a signed-in
  stranger carrying someone else's token;
* the tables or the internal functions being readable or callable through the API;
* the view rate limit not holding.

Isolation of the two tables (row by row) is covered by test_sec_isolation.py
through sec_expectations.TABLES, the function grants by test_sec_catalog.py.

NOT covered here: Supabase Storage itself (the lab has a stand-in storage schema
and no Storage API). That Storage publishes the request's headers to the database
as request.headers and evaluates the policy as the request's role is Storage's
documented behaviour; it must be confirmed once on the real project, see the PR.
"""

from __future__ import annotations

import hashlib
import json
import re
import uuid

import pytest

from sec_db import ANON, acting, as_superuser
from sec_review_links_0101 import TOKEN_A, TOKEN_B, token_hash

UNKNOWN = "c3" * 32

# The exact policy expression as Postgres deparses it. Exact on purpose: "... or true" must not pass.
POLICY_EXPR = ("(review_link_allows(bucket_id, name) AND storage.allow_any_operation("
               "ARRAY['object.get_authenticated'::text, 'object.get_authenticated_info'::text]))")


def headers(token):
    return json.dumps({"host": "x.supabase.co", "x-review-token": token, "accept": "*/*"})


def with_header(s, token, operation="storage.object.get_authenticated"):
    """The request as Storage presents it to the database: the headers and the operation it is running."""
    s.conn.execute("select set_config('request.headers', %s, true)", [headers(token)])
    s.conn.execute("select set_config('storage.operation', %s, true)", [operation])


def seen_by_anon(conn, token, bucket="previews"):
    with acting(conn, ANON) as s:
        if token is not None:
            with_header(s, token)
        return sorted(r[0] for r in s.rows("select name from storage.objects where bucket_id = %s", [bucket]))


def owner_sql(conn, query, params=None):
    with as_superuser(conn, commit=False) as s:
        return s.rows(query, params)


def create(s, video, days=7):
    return s.run("select public.create_review_link(%s, %s)", [video, days])


def seat(s, sc, role):
    """Ivan, a member of org A with `role`, for this transaction."""
    s.conn.execute("reset role")
    s.conn.execute("update public.org_members set user_id = %s, role = %s where org_id = %s and email = %s",
                   [sc.invitee.uid, role, sc.alice.org, sc.invitee.email])
    s.conn.execute("set local role authenticated")


def kill(conn_or_s, how):
    """Turn Alice's seeded link off by the owner's hand: how in {expired, revoked}."""
    q = {"expired": "update public.review_links set created_at = now() - interval '9 days', expires_at = now() - interval '1 day' "
                    "where token_hash = %s",
         "revoked": "update public.review_links set revoked_at = now() where token_hash = %s"}[how]
    conn_or_s.execute(q, [token_hash(TOKEN_A)])


# ── what is stored ──────────────────────────────────────────────────────────

def test_only_a_hash_is_stored_and_the_hash_is_not_a_key(conn, sc):
    with acting(conn, sc.alice.actor) as s:
        made = s.value("select public.create_review_link(%s, 7)", [sc.alice.video])
        token = made["token"]
        assert re.fullmatch(r"[0-9a-f]{64}", token)
        s.conn.execute("reset role")
        rows = s.rows("select token_hash, row_to_json(l)::text from public.review_links l where id = %s", [made["id"]])
        assert rows[0][0] == hashlib.sha256(token.encode()).hexdigest()
        assert token not in rows[0][1]
        # the hash, offered as the token, opens nothing
        s.conn.execute("set local role anon")
        assert s.value("select public.review_link_view(%s)", [rows[0][0]]) == {"status": "gone"}
        assert s.value("select public.review_link_object(%s)", [rows[0][0]]) is None
        with_header(s, rows[0][0])
        assert s.rows("select name from storage.objects where bucket_id = 'previews'") == []
        # while the token itself does
        with_header(s, token)
        assert [r[0] for r in s.rows("select name from storage.objects where bucket_id = 'previews'")] == [f"{sc.alice.channel}/slug-a.mp4"]


def test_the_makers_language_is_kept_by_shape_only_so_a_new_language_needs_no_migration(conn, sc):
    with acting(conn, sc.alice.actor) as s:
        got = {}
        for given in ("ru", " UZ ", "pt-br", "ar", "zz", "not a locale", "", "x" * 40, None):
            made = s.value("select public.create_review_link(%s, 1, %s)", [sc.alice.video, given])
            s.conn.execute("set local role anon")
            got[given] = s.value("select public.review_link_view(%s)", [made["token"]])["locale"]
            s.conn.execute("reset role")
            s.conn.execute("set local role authenticated")
    assert got == {"ru": "ru", " UZ ": "uz", "pt-br": "pt-br", "ar": "ar", "zz": "zz", "not a locale": None, "": None, "x" * 40: None, None: None}


def test_tokens_are_long_random_and_distinct(conn, sc):
    with acting(conn, sc.alice.actor) as s:
        toks = {s.value("select public.create_review_link(%s, 1)", [sc.alice.video])["token"] for _ in range(8)}
    assert len(toks) == 8 and all(re.fullmatch(r"[0-9a-f]{64}", t) for t in toks)


# ── who may make, list, revoke ──────────────────────────────────────────────

def test_the_owner_makes_a_link_with_the_default_week_and_the_listed_choices(conn, sc):
    with acting(conn, sc.alice.actor) as s:
        out = s.value("select public.create_review_link(%s)", [sc.alice.video])
        days = s.value("select extract(epoch from (%s::timestamptz - now())) / 86400", [out["expires_at"]])
        assert 6.99 < float(days) <= 7.0001
        for d in (1, 3, 7, 14, 30):
            assert create(s, sc.alice.video, d).ok, d
    with acting(conn, sc.alice.actor) as s:
        for bad in (0, 2, 8, 31, 365, -1, None):
            out = create(s, sc.alice.video, bad)
            assert not out.ok and out.sqlstate == "NS400", (bad, out)


def test_another_organization_a_stranger_and_the_signed_out_cannot_make_one_and_learn_nothing(conn, sc):
    results = []
    for who in (sc.bob.actor, sc.stranger):
        with acting(conn, who) as s:
            real = create(s, sc.alice.video)
            fake = create(s, "no-such-video")
        assert not real.ok and not fake.ok
        assert (real.sqlstate, real.error) == (fake.sqlstate, fake.error), "a real video must read like a made-up one"
        results.append(real.sqlstate)
    assert results == ["P0002", "P0002"]
    with acting(conn, ANON) as s:
        out = create(s, sc.alice.video)
    assert not out.ok and out.sqlstate in ("42501",)
    assert owner_sql(conn, "select count(*) from public.review_links where video_id = %s", [sc.alice.video])[0][0] == 1  # the seeded one


@pytest.mark.parametrize("role", ["viewer", "editor"])
def test_a_viewer_or_editor_of_the_same_organization_cannot_make_list_or_revoke(conn, sc, role):
    lid = owner_sql(conn, "select id from public.review_links where token_hash = %s", [token_hash(TOKEN_A)])[0][0]
    with acting(conn, sc.invitee) as s:
        seat(s, sc, role)
        out = create(s, sc.alice.video)
        assert not out.ok and out.sqlstate == "P0002"
        assert s.value("select public.list_review_links(%s)", [sc.alice.video]) == []
        assert s.value("select public.revoke_review_link(%s)", [str(lid)]) is False
    assert owner_sql(conn, "select revoked_at is null from public.review_links where id = %s", [lid])[0][0] is True


def test_an_admin_of_the_same_organization_may(conn, sc):
    with acting(conn, sc.invitee) as s:
        seat(s, sc, "admin")
        assert create(s, sc.alice.video).ok


def test_a_video_with_no_kept_review_copy_has_nothing_to_share(conn, sc):
    with acting(conn, sc.alice.actor) as s:
        s.conn.execute("reset role")
        s.conn.execute("update public.videos set preview_path = null where video_id = %s", [sc.alice.video])
        s.conn.execute("set local role authenticated")
        out = create(s, sc.alice.video)
    assert not out.ok and out.sqlstate == "NS400" and "no_preview" in out.error


def test_a_preview_path_into_another_channels_folder_cannot_be_shared(conn, sc):
    with acting(conn, sc.alice.actor) as s:
        s.conn.execute("reset role")
        s.conn.execute("update public.videos set preview_path = %s where video_id = %s",
                       [f"{sc.bob.channel}/slug-b.mp4", sc.alice.video])
        s.conn.execute("set local role authenticated")
        out = create(s, sc.alice.video)
        assert not out.ok and out.sqlstate == "NS400"
        # and the link that already exists stops resolving instead of reaching Bob's file
        s.conn.execute("set local role anon")
        assert s.value("select public.review_link_object(%s)", [TOKEN_A]) is None
        with_header(s, TOKEN_A)
        assert s.rows("select name from storage.objects where bucket_id = 'previews'") == []


def test_ten_live_links_per_video_at_most(conn, sc):
    with acting(conn, sc.alice.actor) as s:
        made = [create(s, sc.alice.video, 1) for _ in range(9)]  # one is seeded already
        assert all(o.ok for o in made)
        out = create(s, sc.alice.video, 1)
    assert not out.ok and out.sqlstate == "NS429"


def test_list_shows_status_and_never_a_hash_or_a_token(conn, sc):
    with acting(conn, sc.alice.actor) as s:
        made = s.value("select public.create_review_link(%s, 3)", [sc.alice.video])
        rows = s.value("select public.list_review_links(%s)", [sc.alice.video])
    assert {r["id"] for r in rows} >= {made["id"]}
    text = json.dumps(rows)
    for secret in (made["token"], hashlib.sha256(made["token"].encode()).hexdigest(), TOKEN_A, token_hash(TOKEN_A)):
        assert secret not in text
    assert all(set(r) == {"id", "created_at", "expires_at", "revoked_at", "views", "last_viewed_at"} for r in rows)


def test_another_organization_lists_nothing_and_cannot_revoke(conn, sc):
    lid = str(owner_sql(conn, "select id from public.review_links where token_hash = %s", [token_hash(TOKEN_A)])[0][0])
    for who in (sc.bob.actor, sc.stranger):
        with acting(conn, who) as s:
            assert s.value("select public.list_review_links(%s)", [sc.alice.video]) == []
            assert s.value("select public.revoke_review_link(%s)", [lid]) is False
            assert s.value("select public.revoke_review_link(%s)", [str(uuid.uuid4())]) is False  # same answer as a made-up id
    with acting(conn, ANON) as s:
        out = s.run("select public.revoke_review_link(%s)", [lid])
    assert not out.ok and out.sqlstate == "42501"
    assert owner_sql(conn, "select revoked_at is null from public.review_links where token_hash = %s", [token_hash(TOKEN_A)])[0][0]


def test_revoke_works_at_once_for_every_reader_of_the_token(conn, sc):
    lid = str(owner_sql(conn, "select id from public.review_links where token_hash = %s", [token_hash(TOKEN_A)])[0][0])
    with acting(conn, ANON) as s:
        assert s.value("select public.review_link_view(%s)", [TOKEN_A])["status"] == "ok"
    with acting(conn, sc.alice.actor) as s:
        assert s.value("select public.revoke_review_link(%s)", [lid]) is True
        assert s.value("select public.revoke_review_link(%s)", [lid]) is False  # already off
        s.conn.execute("set local role anon")
        assert s.value("select public.review_link_view(%s)", [TOKEN_A]) == {"status": "gone"}
        assert s.value("select public.review_link_object(%s)", [TOKEN_A]) is None
        with_header(s, TOKEN_A)
        assert s.rows("select name from storage.objects where bucket_id = 'previews'") == []


# ── what a token reaches ────────────────────────────────────────────────────

def test_a_live_token_gets_its_title_and_expiry_and_nothing_else(conn, sc):
    with acting(conn, ANON) as s:
        out = s.value("select public.review_link_view(%s)", [TOKEN_A])
    assert set(out) == {"status", "title", "expires_at", "locale"}
    assert out["status"] == "ok" and out["title"] == "Video a"


def test_every_kind_of_no_reads_the_same(conn, sc):
    owner_sql(conn, "select 1")
    shapes = {"unknown": UNKNOWN, "short": "abc", "upper": TOKEN_A.upper(), "padded": TOKEN_A + "0", "empty": "",
              "sql": "' or 1=1 --", "null": None}
    with acting(conn, ANON) as s:
        for label, tok in shapes.items():
            assert s.value("select public.review_link_view(%s)", [tok]) == {"status": "gone"}, label
            assert s.value("select public.review_link_object(%s)", [tok]) is None, label
    for how in ("expired", "revoked"):
        with acting(conn, sc.alice.actor) as s:
            s.conn.execute("reset role")
            kill(s.conn, how)
            s.conn.execute("set local role anon")
            assert s.value("select public.review_link_view(%s)", [TOKEN_A]) == {"status": "gone"}, how
            assert s.value("select public.review_link_object(%s)", [TOKEN_A]) is None, how
            with_header(s, TOKEN_A)
            assert s.rows("select name from storage.objects where bucket_id = 'previews'") == [], how


def test_a_token_of_one_organization_never_reaches_the_others_object(conn, sc):
    with acting(conn, ANON) as s:
        assert s.value("select public.review_link_object(%s)", [TOKEN_A]) == f"{sc.alice.channel}/slug-a.mp4"
        assert s.value("select public.review_link_object(%s)", [TOKEN_B]) == f"{sc.bob.channel}/slug-b.mp4"
    assert seen_by_anon(conn, TOKEN_A) == [f"{sc.alice.channel}/slug-a.mp4"]
    assert seen_by_anon(conn, TOKEN_B) == [f"{sc.bob.channel}/slug-b.mp4"]


def test_a_channel_that_moved_organization_takes_its_links_with_it(conn, sc):
    with acting(conn, sc.alice.actor) as s:
        s.conn.execute("reset role")
        # the guard trigger (0018) refuses this for a customer; the test plays the database owner
        s.conn.execute("set local session_replication_role = replica")
        s.conn.execute("update public.channels set org_id = %s where channel_id = %s", [sc.bob.org, sc.alice.channel])
        s.conn.execute("set local session_replication_role = origin")
        s.conn.execute("set local role anon")
        assert s.value("select public.review_link_view(%s)", [TOKEN_A]) == {"status": "gone"}
        with_header(s, TOKEN_A)
        assert s.rows("select name from storage.objects where bucket_id = 'previews'") == []


def test_view_counts_and_the_rate_limit_holds(conn, sc):
    with acting(conn, ANON) as s:
        outs = [s.value("select public.review_link_view(%s)", [TOKEN_A])["status"] for _ in range(33)]
        s.conn.execute("reset role")
        views = s.value("select views from public.review_links where token_hash = %s", [token_hash(TOKEN_A)])
    assert outs[:29].count("ok") == 29  # the seeded row already holds one hit this minute
    assert "limited" in outs[28:] and outs[-1] == "limited"
    assert views == outs.count("ok")
    # the limit is per link: Bob's is not spent
    with acting(conn, ANON) as s:
        assert s.value("select public.review_link_view(%s)", [TOKEN_B])["status"] == "ok"


# ── the storage policy: one object, read only ───────────────────────────────

def test_no_header_or_a_bad_one_reads_nothing(conn, sc):
    assert seen_by_anon(conn, None) == []
    for bad in ("", "not json", '{"x-review-token": null}', '{"x-review-token": 5}', "[]", '{"X-Review-Token": "%s"}' % TOKEN_A):
        with acting(conn, ANON) as s:
            s.conn.execute("select set_config('request.headers', %s, true)", [bad])
            out = s.run("select name from storage.objects where bucket_id = 'previews'")
        assert out.ok and out.rows == [], bad


def test_the_token_opens_the_previews_bucket_only(conn, sc):
    owner_sql(conn, "select 1")
    with as_superuser(conn, commit=False) as s:
        s.rows("insert into storage.objects (bucket_id, name) values ('voice-previews', %s) returning 1", [f"{sc.alice.channel}/slug-a.mp4"])
        s.rows("insert into storage.objects (bucket_id, name) values ('previews', %s) returning 1", [f"{sc.alice.channel}/other.mp4"])
        s.conn.execute("set local role anon")
        with_header(s, TOKEN_A)
        assert [r[0] for r in s.rows("select name from storage.objects where bucket_id = 'voice-previews'")] == []
        # same channel, different file: not the link's file
        assert sorted(r[0] for r in s.rows("select name from storage.objects where bucket_id = 'previews'")) == [f"{sc.alice.channel}/slug-a.mp4"]


def test_the_policy_never_writes(conn, sc):
    with acting(conn, ANON) as s:
        with_header(s, TOKEN_A)
        ins = s.run("insert into storage.objects (bucket_id, name) values ('previews', %s)", [f"{sc.alice.channel}/new.mp4"])
        upd = s.run("update storage.objects set name = name || 'x' where bucket_id = 'previews'")
        dele = s.run("delete from storage.objects where bucket_id = 'previews'")
    assert not ins.ok
    assert (not upd.ok) or upd.rowcount == 0
    assert (not dele.ok) or dele.rowcount == 0
    assert owner_sql(conn, "select count(*) from storage.objects where bucket_id = 'previews'")[0][0] >= 2


def test_a_signed_in_stranger_carrying_someone_elses_token_gains_nothing(conn, sc):
    for who in (sc.bob.actor, sc.stranger):
        with acting(conn, who) as s:
            before = sorted(r[0] for r in s.rows("select name from storage.objects where bucket_id = 'previews'"))
            with_header(s, TOKEN_A)
            after = sorted(r[0] for r in s.rows("select name from storage.objects where bucket_id = 'previews'"))
        assert after == before
        assert f"{sc.alice.channel}/slug-a.mp4" not in after


def test_the_only_anon_policy_on_storage_is_the_one_read_for_review_links(conn, sc):
    rows = owner_sql(conn, "select policyname, cmd, permissive, qual, with_check from pg_policies "
                           "where schemaname = 'storage' and tablename = 'objects' and (roles::text like '%anon%' or roles::text like '%public%')")
    assert [r[:3] for r in rows] == [("previews_review_link_read", "SELECT", "PERMISSIVE")]
    assert rows[0][3] == POLICY_EXPR, rows[0][3]
    assert rows[0][4] is None


# ── the API surface ─────────────────────────────────────────────────────────

@pytest.mark.parametrize("who_attr", ["anon", "bob", "stranger"])
def test_the_tables_and_internals_are_closed_to_the_api(conn, sc, who_attr):
    who = {"anon": ANON, "bob": sc.bob.actor, "stranger": sc.stranger}[who_attr]
    for q in ("select * from public.review_links", "select * from public.review_link_hits",
              "insert into public.review_links (org_id, channel_id, video_id, token_hash, created_by, expires_at) "
              "values (gen_random_uuid(), 'x', 'y', repeat('0', 64), gen_random_uuid(), now() + interval '1 day')",
              "update public.review_links set revoked_at = null", "delete from public.review_links",
              "select public.review_link_token()", "select public.review_link_hash('x')",
              "select * from public.review_link_live('%s')" % TOKEN_A):
        with acting(conn, who) as s:
            out = s.run(q)
        assert not out.ok and out.sqlstate == "42501", (q, out)


def test_every_function_pins_its_search_path_and_is_security_definer_where_it_reads_the_tables(conn):
    rows = owner_sql(conn, "select p.proname, p.prosecdef, p.proconfig::text from pg_proc p join pg_namespace n on n.oid = p.pronamespace "
                           "where n.nspname = 'public' and p.proname like any (array['%review\\_link%'])")
    names = {r[0] for r in rows}
    assert {"create_review_link", "list_review_links", "revoke_review_link", "review_link_view", "review_link_object",
            "review_link_allows", "review_link_live", "review_link_token", "review_link_hash"} <= names
    for name, definer, cfg in rows:
        assert "search_path=public, pg_temp" in (cfg or ""), name
        if name not in ("review_link_token", "review_link_hash"):
            assert definer, name


def test_deleting_the_video_deletes_its_links(conn, sc):
    with as_superuser(conn, commit=False) as s:
        s.rows("delete from public.videos where video_id = %s returning 1", [sc.alice.video])
        assert s.value("select count(*) from public.review_links where video_id = %s", [sc.alice.video]) == 0
        assert s.value("select count(*) from public.review_links where video_id = %s", [sc.bob.video]) == 1


# ── reading only: sign, list and every other operation are refused ─────────

READ_OPERATIONS = ["storage.object.get_authenticated", "object.get_authenticated", "object.get_authenticated_info",
                   "storage.object.get_authenticated_info"]
OTHER_OPERATIONS = ["storage.object.sign", "object.sign", "storage.object.list", "object.list", "storage.object.get_public",
                    "storage.object.info_authenticated", "object.head_authenticated_info", "storage.object.upload",
                    "storage.object.copy", "bucket.get", "object", "", "OBJECT.GET_AUTHENTICATED"]


def anon_names(conn, operation):
    with acting(conn, ANON) as s:
        with_header(s, TOKEN_A, operation)
        return [r[0] for r in s.rows("select name from storage.objects where bucket_id = 'previews'")]


@pytest.mark.parametrize("operation", READ_OPERATIONS)
def test_the_two_read_operations_serve_the_one_object(conn, sc, operation):
    assert anon_names(conn, operation) == [f"{sc.alice.channel}/slug-a.mp4"]


@pytest.mark.parametrize("operation", OTHER_OPERATIONS)
def test_sign_list_and_every_other_operation_are_refused_even_with_a_live_token(conn, sc, operation):
    """A signed URL outlives a revoke and a CDN keeps what it served, so signing is never allowed."""
    assert anon_names(conn, operation) == []


def test_no_operation_at_all_is_refused(conn, sc):
    with acting(conn, ANON) as s:
        s.conn.execute("select set_config('request.headers', %s, true)", [headers(TOKEN_A)])
        assert s.rows("select name from storage.objects where bucket_id = 'previews'") == []


def test_an_older_storage_without_the_operation_helper_fails_closed_and_says_so(conn, sc):
    """No helper, no policy: the feature stops, nothing leaks, and the migration says why."""
    from sec_db import MIGRATIONS
    sql = (MIGRATIONS / "0101_review_links.sql").read_text(encoding="utf-8")
    notices = []
    with as_superuser(conn, commit=False) as s:
        conn.add_notice_handler(lambda d: notices.append(d.message_primary))
        s.conn.execute("drop policy previews_review_link_read on storage.objects")
        s.conn.execute("drop function storage.allow_any_operation(text[])")
        s.conn.execute(sql)
        assert s.value("select count(*) from pg_policies where schemaname = 'storage' and policyname = 'previews_review_link_read'") == 0
        s.conn.execute("set local role anon")
        with_header(s, TOKEN_A)
        assert s.rows("select name from storage.objects where bucket_id = 'previews'") == []
    assert any("allow_any_operation" in n and "NOT created" in n for n in notices), notices

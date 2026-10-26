"""Named attacks on the parent link of an uploaded picture (migration 0128).

The image editor saves an edit as a NEW library file through an upload ticket. request_upload's seven-argument overload may now name the
picture the file is an edit of, and register_asset links the new file to it (media_assets.parent_asset_id, 0038's column). What must hold:

  * the parent must be a LIVE IMAGE of the organization the caller uploads to: another organization's picture, a deleted one, a video and
    a made-up id are refused with the SAME word, and no ticket is written, so an id confirms nothing across organizations;
  * a stranger and the anon key get 0038's refusal whether or not a parent is named (the parent is looked at only after membership);
  * the other gates (type, extension, size) still apply with a parent, and a refusal leaves no ticket behind;
  * nobody but request_upload writes the ticket's parent: no API role can insert or update media_uploads, and the worker cannot either;
  * the parent is RE-CHECKED when the worker registers the file: deleted, purged or (by an owner's hand) another organization's = no link,
    never a failed upload; a purge of the parent sets the child's link to null (ON DELETE SET NULL, on the ticket and on the asset);
  * the link reads nothing: another organization sees neither the parent, the child nor the ticket;
  * the five- and six-argument calls are unchanged and link nothing;
  * the file replaces only register_asset (0051's body, plus the marked lines), is idempotent, refuses a body it has not seen, and its
    rollback puts 0051's body back, refuses while a ticket in flight carries a parent, and can be followed by the migration again.

Every flow runs in one transaction that is rolled back, switching between the member's session and the worker's (service role) the way
PostgREST would serve each of them.
"""

from __future__ import annotations

import json
import re
import uuid

import psycopg
import pytest

import sec_db
from sec_db import ANON, SERVICE, acting, as_superuser
from test_sec_upload_folder import back_to_owner, become, refused

MIGRATION = sec_db.MIGRATIONS / "0128_upload_parent_asset.sql"
ROLLBACK = sec_db.REPO / "docs" / "sql" / "rollback_0128_upload_parent_asset.sql"
REGISTER = "public.register_asset(uuid, uuid, text, text, bigint, text, text, integer, integer, numeric, jsonb, bigint, text[], uuid, uuid, uuid, text, uuid)"
REQUEST7 = "select public.request_upload(%s, %s, 'image/png', 50, null, null, %s)"
REQUEST6 = "select public.request_upload(%s, %s, 'image/png', 50, null, null)"
REQUEST5 = "select public.request_upload(%s, %s, 'image/png', 50)"
BEFORE_HASH = "233cdbb722c76a434f08d929bafa4e27"


def make_asset(s, org: str, *, kind: str = "image", mime: str = "image/png") -> str:
    """As the worker: a registered library file (a generated one, the way AI edits arrive)."""
    become(s, SERVICE)
    return str(s.value("select public.register_asset(gen_random_uuid(), %s, %s, %s, 100, %s, 'generated', "
                       "p_width => 8, p_height => 8, p_duration_s => %s) ->> 'id'",
                       [org, kind, mime, uuid.uuid4().hex + uuid.uuid4().hex, 1 if kind == "video" else None]))


def ticket_for(s, who, org: str, parent) -> str:
    """As `who`: ask for a ticket naming `parent`, send its body. Returns the ticket."""
    become(s, who)
    out = s.value(REQUEST7, [org, f"edit-{uuid.uuid4().hex[:6]}.png", parent])
    t = out["ticket"]
    assert s.value("select public.begin_upload_receive(%s) ->> 'ok'", [t]) == "true"
    assert s.value("select public.finish_upload_receive(%s, 50, true)", [t]) == "uploaded"
    return t


def register(s, ticket: str) -> dict:
    """As the worker: claim THIS ticket (others waiting are set aside inside this transaction only) and register it."""
    back_to_owner(s)
    s.rows("update public.media_uploads set status = 'expired' where status = 'uploaded' and id <> %s returning 1", [ticket])
    become(s, SERVICE)
    claimed = s.rows("select id::text from public.claim_media_upload('w-parent')")
    assert claimed and claimed[0][0] == ticket, claimed
    return s.value("select public.register_asset(gen_random_uuid(), null, 'image', 'image/png', 50, repeat('f', 64), 'upload', p_upload_id => %s)",
                   [ticket])


def asset_row(s, asset: str):
    back_to_owner(s)
    r = s.rows("select parent_asset_id::text, version from public.media_assets where id = %s", [asset])
    return r[0]


def ticket_parent(s, ticket: str):
    back_to_owner(s)
    return s.value("select parent_asset_id::text from public.media_uploads where id = %s", [ticket])


def tickets_of(s, org: str) -> int:
    back_to_owner(s)
    return s.value("select count(*) from public.media_uploads where org_id = %s", [org])


# ── asking for a ticket ─────────────────────────────────────────────────────

def test_a_member_links_an_upload_to_a_picture_of_the_organization(conn, sc):
    with as_superuser(conn, commit=False) as s:
        parent = make_asset(s, sc.alice.org)
        become(s, sc.alice.actor)
        out = s.value(REQUEST7, [sc.alice.org, "edit.png", parent])
        assert out["parent_asset_id"] == parent and out["folder_id"] is None, out
        assert ticket_parent(s, out["ticket"]) == parent


def test_the_file_registered_from_that_ticket_remembers_the_picture(conn, sc):
    with as_superuser(conn, commit=False) as s:
        parent = make_asset(s, sc.alice.org)
        t = ticket_for(s, sc.alice.actor, sc.alice.org, parent)
        out = register(s, t)
        assert out["reused"] is False
        # Linked, and one version up like any edit of that picture.
        assert asset_row(s, out["id"]) == (parent, 2)
        # The parent itself is untouched.
        assert asset_row(s, parent) == (None, 1)
        # A retried registration answers with the same file and changes nothing.
        become(s, SERVICE)
        again = s.value("select public.register_asset(gen_random_uuid(), null, 'image', 'image/png', 50, repeat('f', 64), 'upload', p_upload_id => %s)", [t])
        assert again["reused"] is True and again["id"] == out["id"]
        assert asset_row(s, out["id"]) == (parent, 2)


def test_another_orgs_picture_is_refused_like_a_made_up_id_and_writes_no_ticket(conn, sc):
    with as_superuser(conn, commit=False) as s:
        theirs = make_asset(s, sc.alice.org)
        before = tickets_of(s, sc.bob.org)
        become(s, sc.bob.actor)
        cross = s.run(REQUEST7, [sc.bob.org, "x.png", theirs])
        made_up = s.run(REQUEST7, [sc.bob.org, "x.png", str(uuid.uuid4())])
        # And it really is Alice's, live, and an image: the refusal is about the organization, nothing else.
        back_to_owner(s)
        assert s.value("select count(*) from public.media_assets where id = %s and org_id = %s and kind = 'image' and deleted_at is null",
                       [theirs, sc.alice.org]) == 1
        assert tickets_of(s, sc.bob.org) == before
    assert refused(cross, "P0002"), cross
    # The same answer word for word: Alice's picture id tells Bob nothing.
    assert (cross.sqlstate, cross.error) == (made_up.sqlstate, made_up.error), (cross, made_up)


def test_the_refusal_names_the_reason_and_nothing_about_who_owns_the_picture(conn, sc):
    with as_superuser(conn, commit=False) as s:
        theirs = make_asset(s, sc.alice.org)
        become(s, sc.bob.actor)
        with pytest.raises(psycopg.Error) as e:
            with s.conn.transaction():
                s.conn.execute(REQUEST7, [sc.bob.org, "x.png", theirs])
    diag = e.value.diag
    assert (diag.sqlstate, diag.message_detail) == ("P0002", "reason=parent_not_found"), diag.message_detail
    said = " ".join(filter(None, [diag.message_primary, diag.message_detail, diag.message_hint]))
    assert sc.alice.org not in said and theirs not in said, said


def test_naming_another_orgs_picture_while_uploading_to_that_org_is_refused_too(conn, sc):
    with as_superuser(conn, commit=False) as s:
        theirs = make_asset(s, sc.alice.org)
        become(s, sc.bob.actor)
        out = s.run(REQUEST7, [sc.alice.org, "x.png", theirs])
    assert refused(out, "42501"), out


def test_a_picture_of_one_of_my_other_orgs_is_not_a_parent_here(conn, sc):
    # A person in two organizations may not link a file of one to an upload into the other.
    with as_superuser(conn, commit=False) as s:
        org2 = str(s.value("insert into public.organizations (name, slug) values ('Second', %s) returning id", [f"second-{uuid.uuid4().hex[:6]}"]))
        s.rows("insert into public.org_members (org_id, user_id, role) values (%s, %s, 'owner') returning 1", [org2, sc.alice.actor.uid])
        mine_elsewhere = make_asset(s, org2)
        become(s, sc.alice.actor)
        out = s.run(REQUEST7, [sc.alice.org, "x.png", mine_elsewhere])
    assert refused(out, "P0002"), out


@pytest.mark.parametrize("who_name", ["stranger", "anon"])
def test_outsiders_get_the_membership_refusal_with_or_without_a_parent(conn, sc, who_name):
    who = sc.stranger if who_name == "stranger" else ANON
    with as_superuser(conn, commit=False) as s:
        parent = make_asset(s, sc.alice.org)
        become(s, who)
        with_parent = s.run(REQUEST7, [sc.alice.org, "x.png", parent])
        made_up = s.run(REQUEST7, [sc.alice.org, "x.png", str(uuid.uuid4())])
        without = s.run(REQUEST7, [sc.alice.org, "x.png", None])
    assert refused(with_parent, "42501"), with_parent
    assert (with_parent.sqlstate, with_parent.error) == (made_up.sqlstate, made_up.error) == (without.sqlstate, without.error)


def test_a_deleted_picture_and_a_video_are_not_parents(conn, sc):
    with as_superuser(conn, commit=False) as s:
        gone = make_asset(s, sc.alice.org)
        video = make_asset(s, sc.alice.org, kind="video", mime="video/mp4")
        become(s, sc.alice.actor)
        assert s.value("select public.soft_delete_asset(%s)", [gone]) is True
        deleted = s.run(REQUEST7, [sc.alice.org, "x.png", gone])
        not_image = s.run(REQUEST7, [sc.alice.org, "x.png", video])
    assert refused(deleted, "P0002") and refused(not_image, "P0002"), (deleted, not_image)


def test_a_viewer_may_link_what_they_can_read_but_still_not_file_into_a_folder(conn, sc):
    with as_superuser(conn, commit=False) as s:
        org = str(s.value("select public.default_org_id()::text"))
        parent = make_asset(s, org)
        back_to_owner(s)
        folder = str(s.value("insert into public.media_folders (org_id, name) values (%s, 'Viewer parent test') returning id", [org]))
        become(s, sc.dana)
        linked = s.run(REQUEST7, [org, "v.png", parent])
        filed = s.run("select public.request_upload(%s, 'v.png', 'image/png', 50, null, %s, %s)", [org, folder, parent])
    assert linked.ok and linked.rows[0][0]["parent_asset_id"] == parent, linked
    assert refused(filed, "42501"), filed


def test_the_other_gates_still_apply_with_a_parent_and_leave_no_ticket(conn, sc):
    with as_superuser(conn, commit=False) as s:
        parent = make_asset(s, sc.alice.org)
        before = tickets_of(s, sc.alice.org)
        become(s, sc.alice.actor)
        spoof = s.run("select public.request_upload(%s, 'payload.exe', 'image/png', 50, null, null, %s)", [sc.alice.org, parent])
        huge = s.run("select public.request_upload(%s, 'big.png', 'image/png', 10737418240, null, null, %s)", [sc.alice.org, parent])
        empty = s.run("select public.request_upload(%s, 'e.png', 'image/png', 0, null, null, %s)", [sc.alice.org, parent])
        folder = s.run("select public.request_upload(%s, 'e.png', 'image/png', 50, null, %s, %s)", [sc.alice.org, str(uuid.uuid4()), parent])
        after = tickets_of(s, sc.alice.org)
    assert refused(spoof, "NS415"), spoof
    assert refused(huge, "NS413"), huge
    assert refused(empty, "22023"), empty
    assert refused(folder, "P0002"), folder
    assert after == before


def test_the_five_and_six_argument_calls_are_unchanged_and_link_nothing(conn, sc):
    with acting(conn, sc.alice.actor) as s:
        five = s.value(REQUEST5, [sc.alice.org, "old.png"])
        six = s.value(REQUEST6, [sc.alice.org, "old.png"])
        no_parent = s.value(REQUEST7, [sc.alice.org, "new.png", None])
        assert "parent_asset_id" not in five and "parent_asset_id" not in six, (five, six)
        assert no_parent["parent_asset_id"] is None
        for t in (five, six, no_parent):
            assert s.value("select parent_asset_id from public.media_uploads where id = %s", [t["ticket"]]) is None


def test_the_api_roles_reach_the_overloads_they_should(conn, sc):
    with as_superuser(conn, commit=False) as s:
        rows = s.rows(
            "select pg_get_function_identity_arguments(p.oid), p.prosecdef, p.proconfig::text, "
            "has_function_privilege('authenticated', p.oid, 'EXECUTE'), "
            "has_function_privilege('anon', p.oid, 'EXECUTE'), "
            "has_function_privilege('service_role', p.oid, 'EXECUTE'), "
            "has_function_privilege('public', p.oid, 'EXECUTE') "
            "from pg_proc p where p.proname = 'request_upload' and p.pronamespace = 'public'::regnamespace order by 1")
    assert len(rows) == 3, rows
    for args, secdef, config, authed, anon, service, public in rows:
        assert (secdef, authed, anon, service, public) == (True, True, False, False, False), (args, rows)
        assert "search_path=public, pg_temp" in config, config
    seven = [r for r in rows if r[0].endswith("p_parent_asset_id uuid")]
    assert len(seven) == 1


# ── nobody else writes the ticket's parent ──────────────────────────────────

@pytest.mark.parametrize("who_name", ["alice", "stranger", "anon", "service"])
def test_no_api_role_writes_a_tickets_parent(conn, sc, who_name):
    who = {"alice": sc.alice.actor, "stranger": sc.stranger, "anon": ANON, "service": SERVICE}[who_name]
    with as_superuser(conn, commit=False) as s:
        parent = make_asset(s, sc.alice.org)
        become(s, sc.alice.actor)
        t = s.value(REQUEST7, [sc.alice.org, "x.png", None])["ticket"]
        become(s, who)
        upd = s.run("update public.media_uploads set parent_asset_id = %s where id = %s", [parent, t])
        col = s.run("update public.media_uploads set parent_asset_id = null where id = %s", [t])
        ins = s.run("insert into public.media_uploads (org_id, original_name, declared_mime, declared_bytes, expires_at, created_by, parent_asset_id) "
                    "values (%s, 'x.png', 'image/png', 1, now() + interval '1 hour', %s, %s)", [sc.alice.org, sc.alice.actor.uid, parent])
    for out in (upd, col, ins):
        assert (not out.ok) and out.sqlstate == "42501", (who_name, out)


def test_only_the_worker_registers_and_only_members_request(conn, sc):
    with as_superuser(conn, commit=False) as s:
        parent = make_asset(s, sc.alice.org)
        for who in (sc.alice.actor, ANON):
            become(s, who)
            out = s.run("select public.register_asset(gen_random_uuid(), %s, 'image', 'image/png', 10, repeat('a', 64), 'generated', p_parent_asset_id => %s)",
                        [sc.alice.org, parent])
            assert (not out.ok) and out.sqlstate == "42501", out
        become(s, SERVICE)
        out = s.run(REQUEST7, [sc.alice.org, "x.png", parent])
        assert (not out.ok) and out.sqlstate in ("42501", "42883"), out


# ── registering the file ────────────────────────────────────────────────────

def test_a_parent_deleted_before_the_worker_registers_means_no_link_not_a_failure(conn, sc):
    with as_superuser(conn, commit=False) as s:
        parent = make_asset(s, sc.alice.org)
        t = ticket_for(s, sc.alice.actor, sc.alice.org, parent)
        become(s, sc.alice.actor)
        assert s.value("select public.soft_delete_asset(%s)", [parent]) is True
        out = register(s, t)
        assert out["reused"] is False
        assert asset_row(s, out["id"]) == (None, 1)
        assert s.value("select status from public.media_uploads where id = %s", [t]) == "ingested"


def test_a_parent_purged_while_the_ticket_waits_sets_the_ticket_link_to_null(conn, sc):
    with as_superuser(conn, commit=False) as s:
        parent = make_asset(s, sc.alice.org)
        t = ticket_for(s, sc.alice.actor, sc.alice.org, parent)
        back_to_owner(s)
        s.rows("delete from public.media_assets where id = %s returning 1", [parent])
        assert ticket_parent(s, t) is None
        out = register(s, t)
        assert asset_row(s, out["id"]) == (None, 1)


def test_deleting_the_parent_row_unlinks_the_child(conn, sc):
    with as_superuser(conn, commit=False) as s:
        parent = make_asset(s, sc.alice.org)
        t = ticket_for(s, sc.alice.actor, sc.alice.org, parent)
        child = register(s, t)["id"]
        assert asset_row(s, child) == (parent, 2)
        back_to_owner(s)
        s.rows("delete from public.media_assets where id = %s returning 1", [parent])
        assert asset_row(s, child) == (None, 2)
        assert ticket_parent(s, t) is None
        assert s.value("select status from public.media_uploads where id = %s", [t]) == "ingested"


def test_a_ticket_pointing_at_another_orgs_picture_links_nothing(conn, sc):
    # No API path writes this (request_upload checks the org, nobody can update a ticket); the owner does it, to prove
    # register_asset re-checks rather than trusts the ticket.
    with as_superuser(conn, commit=False) as s:
        theirs = make_asset(s, sc.bob.org)
        t = ticket_for(s, sc.alice.actor, sc.alice.org, None)
        back_to_owner(s)
        s.rows("update public.media_uploads set parent_asset_id = %s where id = %s returning 1", [theirs, t])
        out = register(s, t)
        assert asset_row(s, out["id"]) == (None, 1)
        assert s.value("select count(*) from public.media_assets where parent_asset_id = %s", [theirs]) == 0


def test_a_ticket_pointing_at_a_video_links_nothing(conn, sc):
    with as_superuser(conn, commit=False) as s:
        video = make_asset(s, sc.alice.org, kind="video", mime="video/mp4")
        t = ticket_for(s, sc.alice.actor, sc.alice.org, None)
        back_to_owner(s)
        s.rows("update public.media_uploads set parent_asset_id = %s where id = %s returning 1", [video, t])
        assert asset_row(s, register(s, t)["id"]) == (None, 1)


def test_an_upload_without_a_parent_registers_exactly_as_before(conn, sc):
    with as_superuser(conn, commit=False) as s:
        t = ticket_for(s, sc.alice.actor, sc.alice.org, None)
        out = register(s, t)
        assert asset_row(s, out["id"]) == (None, 1)
    with acting(conn, SERVICE) as s:
        gen = s.value("select public.register_asset(gen_random_uuid(), %s, 'image', 'image/png', 10, repeat('9', 64), 'generated')", [sc.alice.org])
        assert gen["reused"] is False


def test_the_workers_own_parent_for_an_ai_edit_still_works_and_is_still_org_checked(conn, sc):
    with as_superuser(conn, commit=False) as s:
        parent = make_asset(s, sc.alice.org)
        become(s, SERVICE)
        child = s.value("select public.register_asset(gen_random_uuid(), %s, 'image', 'image/png', 10, repeat('8', 64), 'generated', p_parent_asset_id => %s)",
                        [sc.alice.org, parent])
        assert asset_row(s, child["id"]) == (parent, 2)
        foreign = s.run("select public.register_asset(gen_random_uuid(), %s, 'image', 'image/png', 10, repeat('7', 64), 'generated', p_parent_asset_id => %s)",
                        [sc.bob.org, parent])
        assert refused(foreign, "42501"), foreign


# ── what the link lets anybody read ─────────────────────────────────────────

def test_the_link_lets_another_organization_read_nothing(conn, sc):
    with as_superuser(conn, commit=False) as s:
        parent = make_asset(s, sc.alice.org)
        t = ticket_for(s, sc.alice.actor, sc.alice.org, parent)
        child = register(s, t)["id"]
        become(s, sc.alice.actor)
        # The owner of both sees the pair; everybody else sees neither, not through the ticket either.
        assert s.value("select count(*) from public.media_assets where id in (%s, %s)", [parent, child]) == 2
        assert s.value("select count(*) from public.media_uploads where parent_asset_id = %s", [parent]) == 1
        for who in (sc.bob.actor, sc.stranger, ANON):
            become(s, who)
            out = s.run("select count(*) from public.media_assets where id in (%s, %s) or parent_asset_id = %s", [parent, child, parent])
            assert (not out.ok and out.sqlstate == "42501") or out.rows[0][0] == 0, (who, out)
            out = s.run("select count(*) from public.media_uploads where parent_asset_id = %s", [parent])
            assert (not out.ok and out.sqlstate == "42501") or out.rows[0][0] == 0, (who, out)


# ── the file ────────────────────────────────────────────────────────────────

def _body(conn, fn: str) -> str:
    with as_superuser(conn, commit=False) as s:
        return s.value(f"select md5(regexp_replace(prosrc, '\\s+', ' ', 'g')) from pg_proc where oid = '{fn}'::regprocedure")


def drift(s) -> None:
    """The live register_asset() with one extra statement, as if somebody had edited it by hand."""
    src = s.value(f"select pg_get_functiondef('{REGISTER}'::regprocedure)")
    assert "ver     integer := 1;" in src
    s.conn.execute(src.replace("ver     integer := 1;", "ver     integer := 1;\n  hand_edit integer := 0;"))


def test_the_live_bodies_are_the_ones_the_file_pins(conn):
    text = MIGRATION.read_text(encoding="utf-8")
    after, req7 = re.search(r"in \('([0-9a-f]{32})', '([0-9a-f]{32})'\)", text).group(2), re.search(r"oid = req7\) <> '([0-9a-f]{32})'", text).group(1)
    assert _body(conn, REGISTER) == after
    assert _body(conn, "public.request_upload(uuid, text, text, bigint, uuid, uuid, uuid)") == req7


def test_the_file_applies_twice_and_changes_nothing(conn):
    with as_superuser(conn, commit=False) as s:
        s.conn.execute(MIGRATION.read_text(encoding="utf-8"))
        s.conn.execute(MIGRATION.read_text(encoding="utf-8"))
        assert s.value("select count(*) from pg_proc where proname = 'request_upload' and pronamespace = 'public'::regnamespace") == 3


def test_the_file_refuses_a_register_asset_it_has_not_seen(conn):
    with as_superuser(conn, commit=False) as s:
        drift(s)
        out = s.run(MIGRATION.read_text(encoding="utf-8"))
    assert (not out.ok) and "neither 0051's body nor 0128's" in out.error, out


def test_the_file_refuses_without_0051(conn):
    with as_superuser(conn, commit=False) as s:
        s.conn.execute("drop function public.request_upload(uuid, text, text, bigint, uuid, uuid, uuid)")
        s.conn.execute("drop function public.request_upload(uuid, text, text, bigint, uuid, uuid)")
        out = s.run(MIGRATION.read_text(encoding="utf-8"))
    assert (not out.ok) and "apply 0038, 0044, 0049 and 0051 first" in out.error, out


def _rollback_text() -> str:
    return "\n".join(ln for ln in ROLLBACK.read_text(encoding="utf-8").splitlines() if ln.strip() not in ("begin;", "commit;"))


def test_the_rollback_puts_0051_back_and_the_file_applies_again(conn, sc):
    with as_superuser(conn, commit=False) as s:
        s.conn.execute(_rollback_text())
        assert s.value(f"select md5(regexp_replace(prosrc, '\\s+', ' ', 'g')) from pg_proc where oid = '{REGISTER}'::regprocedure") == BEFORE_HASH
        assert s.value("select count(*) from pg_proc where proname = 'request_upload' and pronamespace = 'public'::regnamespace") == 2
        assert s.value("select count(*) from information_schema.columns where table_name = 'media_uploads' and column_name = 'parent_asset_id'") == 0
        # Uploading still works the way it did before 0128, and the Command Center's seven-argument call is simply not found.
        become(s, sc.alice.actor)
        assert s.value(REQUEST6, [sc.alice.org, "pre.png"])["ticket"]
        gone = s.run(REQUEST7, [sc.alice.org, "x.png", None])
        assert (not gone.ok) and gone.sqlstate == "42883", gone
        back_to_owner(s)
        s.conn.execute(MIGRATION.read_text(encoding="utf-8"))
        assert s.value("select count(*) from pg_proc where proname = 'request_upload' and pronamespace = 'public'::regnamespace") == 3


def test_the_rollback_keeps_links_already_made_and_refuses_while_a_linked_ticket_is_in_flight(conn, sc):
    with as_superuser(conn, commit=False) as s:
        parent = make_asset(s, sc.alice.org)
        done = register(s, ticket_for(s, sc.alice.actor, sc.alice.org, parent))["id"]
        pending = ticket_for(s, sc.alice.actor, sc.alice.org, parent)
        back_to_owner(s)
        out = s.run(_rollback_text())
        assert (not out.ok) and "an upload in flight carries a parent" in out.error, out
        # Finish it (expire it), then the rollback goes through and the finished file keeps its link.
        s.rows("update public.media_uploads set status = 'expired' where id = %s returning 1", [pending])
        s.conn.execute(_rollback_text())
        assert asset_row(s, done) == (parent, 2)


def test_the_rollback_refuses_a_body_that_is_not_0128s(conn):
    with as_superuser(conn, commit=False) as s:
        drift(s)
        out = s.run(_rollback_text())
    assert (not out.ok) and "is not 0128's body" in out.error, out

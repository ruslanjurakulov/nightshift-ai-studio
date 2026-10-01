"""Named attacks on uploading into a folder (migration 0051).

An upload ticket may now name a folder (request_upload's six-argument
overload), and register_asset puts the file there. What must hold:

  * a folder of ANOTHER organization is refused exactly like a made-up id,
    and no ticket is written — an id confirms nothing across organizations;
  * a viewer may still upload, but only into All files (filing is a folder
    write, editors only, as move_media_assets);
  * the folder is re-checked when the worker registers the file: a folder
    deleted meanwhile — before or after the worker claimed the ticket — sends
    the file to All files, never fails it; a ticket whose folder is somehow
    another organization's (no API path writes one; the owner does it here)
    is filed nowhere but All files;
  * the worker cannot choose a folder: register_asset has no such argument.

Every flow runs in one transaction that is rolled back, switching between
the member's session and the worker's (service role) the way PostgREST would
serve each of them.
"""

from __future__ import annotations

import json
import uuid

import psycopg
import pytest

from sec_db import ANON, SERVICE, acting, as_superuser
from sec_folders_0049 import FOLDER

REQUEST = "select public.request_upload(%s, %s, 'image/png', 50, null, %s)"
REQUEST5 = "select public.request_upload(%s, %s, 'image/png', 50)"


def become(s, who) -> None:
    """Inside one transaction, act as `who` from here on (the session user is
    the superuser, so any API role can be taken and left again)."""
    s.conn.execute("reset role")
    s.conn.execute("select set_config('request.jwt.claims', %s, true)", [json.dumps(who.claims())])
    s.conn.execute("select set_config('request.jwt.claim.role', %s, true)", [who.role])
    s.conn.execute(f"set local role {who.role}")


def back_to_owner(s) -> None:
    s.conn.execute("reset role")
    s.conn.execute("select set_config('request.jwt.claims', '', true)")


def refused(out, sqlstate: str) -> bool:
    return (not out.ok) and out.sqlstate == sqlstate


def tickets_of(conn, org: str) -> int:
    with as_superuser(conn, commit=False) as s:
        return s.value("select count(*) from public.media_uploads where org_id = %s", [org])


def send_body(s, who, org: str, folder) -> str:
    """As `who`: ask for a ticket (into `folder`), send its body. Returns the ticket."""
    become(s, who)
    out = s.value(REQUEST, [org, f"upload-{uuid.uuid4().hex[:6]}.png", folder])
    t = out["ticket"]
    assert s.value("select public.begin_upload_receive(%s) ->> 'ok'", [t]) == "true"
    assert s.value("select public.finish_upload_receive(%s, 50, true)", [t]) == "uploaded"
    return t


def claim_and_register(s, ticket: str) -> dict:
    """As the worker: claim THIS ticket and register it. Other tickets waiting
    in the lab (none should be) are set aside inside this transaction only."""
    back_to_owner(s)
    s.rows("update public.media_uploads set status = 'expired' where status = 'uploaded' and id <> %s returning 1", [ticket])
    become(s, SERVICE)
    claimed = s.rows("select id::text from public.claim_media_upload('w-folder')")
    assert claimed and claimed[0][0] == ticket, claimed
    return s.value("select public.register_asset(gen_random_uuid(), null, 'image', 'image/png', 50, repeat('f', 64), "
                   "'upload', p_upload_id => %s)", [ticket])


def asset_folder(s, asset: str):
    back_to_owner(s)
    return s.value("select folder_id::text from public.media_assets where id = %s", [asset])


# ── asking for a ticket ─────────────────────────────────────────────────────

def test_another_orgs_folder_is_refused_like_a_made_up_one(conn, sc):
    before = tickets_of(conn, sc.bob.org)
    with acting(conn, sc.bob.actor) as s:
        theirs = s.run(REQUEST, [sc.bob.org, "x.png", FOLDER["a"]])
        made_up = s.run(REQUEST, [sc.bob.org, "x.png", str(uuid.uuid4())])
    assert refused(theirs, "P0002"), theirs
    # The same answer, word for word: Alice's folder id tells Bob nothing.
    assert (theirs.sqlstate, theirs.error) == (made_up.sqlstate, made_up.error), (theirs, made_up)
    assert tickets_of(conn, sc.bob.org) == before


def test_the_refusal_names_the_folder_and_nothing_about_who_owns_it(conn, sc):
    with acting(conn, sc.bob.actor) as s:
        with pytest.raises(psycopg.Error) as e:
            with s.conn.transaction():
                s.conn.execute(REQUEST, [sc.bob.org, "x.png", FOLDER["a"]])
    diag = e.value.diag
    assert (diag.sqlstate, diag.message_detail) == ("P0002", "reason=folder_not_found"), diag.message_detail
    said = " ".join(filter(None, [diag.message_primary, diag.message_detail, diag.message_hint]))
    assert sc.alice.org not in said and "Brand" not in said, said


def test_bob_cannot_upload_into_alices_folder_in_her_org_either(conn, sc):
    with acting(conn, sc.bob.actor) as s:
        out = s.run(REQUEST, [sc.alice.org, "x.png", FOLDER["a"]])
    assert refused(out, "42501"), out


def test_outsiders_name_no_folder(conn, sc):
    for who in (sc.stranger, ANON):
        with acting(conn, who) as s:
            out = s.run(REQUEST, [sc.alice.org, "x.png", FOLDER["a"]])
        assert refused(out, "42501"), (who.name, out)


def test_a_viewer_uploads_to_all_files_but_cannot_file_an_upload(conn, sc):
    with as_superuser(conn, commit=False) as s:
        org = s.value("select public.default_org_id()::text")
        folder = str(s.value("insert into public.media_folders (org_id, name) values (%s, 'Viewer test') returning id", [org]))
        become(s, sc.dana)
        into_folder = s.run(REQUEST, [org, "v.png", folder])
        made_up = s.run(REQUEST, [org, "v.png", str(uuid.uuid4())])
        all_files = s.run(REQUEST, [org, "v.png", None])
        five_args = s.run(REQUEST5, [org, "v.png"])
    assert refused(into_folder, "42501"), into_folder
    # The role is checked before the folder is looked up.
    assert (made_up.sqlstate, made_up.error) == (into_folder.sqlstate, into_folder.error), made_up
    assert all_files.ok and all_files.rows[0][0]["folder_id"] is None, all_files
    assert five_args.ok and five_args.rows[0][0]["folder_id"] is None, five_args


def test_the_five_argument_call_is_unchanged_and_files_nothing(conn, sc):
    with acting(conn, sc.alice.actor) as s:
        out = s.value(REQUEST5, [sc.alice.org, "old-client.png"])
        assert out["folder_id"] is None
        assert s.value("select folder_id from public.media_uploads where id = %s", [out["ticket"]]) is None


def test_the_other_gates_still_apply_with_a_folder(conn, sc):
    with acting(conn, sc.alice.actor) as s:
        spoof = s.run("select public.request_upload(%s, 'payload.exe', 'image/png', 50, null, %s)", [sc.alice.org, FOLDER["a"]])
        huge = s.run("select public.request_upload(%s, 'big.png', 'image/png', 10737418240, null, %s)", [sc.alice.org, FOLDER["a"]])
    assert refused(spoof, "NS415"), spoof
    assert refused(huge, "NS413"), huge


def test_the_api_roles_reach_both_overloads_as_before(conn, sc):
    with as_superuser(conn, commit=False) as s:
        rows = s.rows(
            "select pg_get_function_identity_arguments(p.oid), "
            "has_function_privilege('authenticated', p.oid, 'EXECUTE'), "
            "has_function_privilege('anon', p.oid, 'EXECUTE'), "
            "has_function_privilege('service_role', p.oid, 'EXECUTE') "
            "from pg_proc p where p.proname = 'request_upload' and p.pronamespace = 'public'::regnamespace order by 1")
    assert [r[1:] for r in rows] == [(True, False, False)] * 2, rows
    assert len(rows) == 2


# ── registering the file ────────────────────────────────────────────────────

def test_an_upload_lands_in_the_folder_it_was_asked_into(conn, sc):
    with as_superuser(conn, commit=False) as s:
        t = send_body(s, sc.alice.actor, sc.alice.org, FOLDER["a"])
        back_to_owner(s)
        assert s.value("select folder_id::text from public.media_uploads where id = %s", [t]) == FOLDER["a"]
        out = claim_and_register(s, t)
        assert out["folder_id"] == FOLDER["a"], out
        assert asset_folder(s, out["id"]) == FOLDER["a"]
        # And Alice sees it there, counted.
        become(s, sc.alice.actor)
        counts = dict(s.rows("select folder_id::text, assets from public.media_folder_counts(%s)", [sc.alice.org]))
        assert counts[FOLDER["a"]] >= 1


def test_a_folder_deleted_before_the_worker_claims_sends_the_file_to_all_files(conn, sc):
    with as_superuser(conn, commit=False) as s:
        become(s, sc.alice.actor)
        tmp = str(s.value("select public.save_media_folder(%s, null, %s)", [sc.alice.org, "Short-lived"]))
        t = send_body(s, sc.alice.actor, sc.alice.org, tmp)
        assert s.value("select public.delete_media_folder(%s, %s)", [sc.alice.org, tmp]) is True
        back_to_owner(s)
        assert s.value("select folder_id from public.media_uploads where id = %s", [t]) is None
        out = claim_and_register(s, t)
        assert out["folder_id"] is None and out["reused"] is False, out
        assert asset_folder(s, out["id"]) is None
        assert s.value("select status from public.media_uploads where id = %s", [t]) == "ingested"


def test_a_folder_deleted_while_the_file_is_checked_never_fails_it(conn, sc):
    with as_superuser(conn, commit=False) as s:
        become(s, sc.alice.actor)
        tmp = str(s.value("select public.save_media_folder(%s, null, %s)", [sc.alice.org, "Gone mid-check"]))
        t = send_body(s, sc.alice.actor, sc.alice.org, tmp)
        back_to_owner(s)
        s.rows("update public.media_uploads set status = 'expired' where status = 'uploaded' and id <> %s returning 1", [t])
        become(s, SERVICE)
        assert s.rows("select id::text from public.claim_media_upload('w-folder')")[0][0] == t
        # The member deletes the folder while the worker is ingesting.
        become(s, sc.alice.actor)
        assert s.value("select public.delete_media_folder(%s, %s)", [sc.alice.org, tmp]) is True
        become(s, SERVICE)
        out = s.value("select public.register_asset(gen_random_uuid(), null, 'image', 'image/png', 50, repeat('f', 64), "
                      "'upload', p_upload_id => %s)", [t])
        assert out["folder_id"] is None, out
        assert asset_folder(s, out["id"]) is None


def test_a_ticket_pointing_at_another_orgs_folder_files_nothing_there(conn, sc):
    # No API path writes this (request_upload checks the org, the browser
    # cannot update tickets); the owner does, to prove register_asset
    # re-checks rather than trusts the ticket.
    with as_superuser(conn, commit=False) as s:
        t = send_body(s, sc.alice.actor, sc.alice.org, None)
        back_to_owner(s)
        s.rows("update public.media_uploads set folder_id = %s where id = %s returning 1", [FOLDER["b"], t])
        out = claim_and_register(s, t)
        assert out["folder_id"] is None, out
        assert asset_folder(s, out["id"]) is None
        assert s.value("select count(*) from public.media_assets where folder_id = %s and org_id = %s",
                       [FOLDER["b"], sc.alice.org]) == 0


def test_the_worker_cannot_choose_a_folder(conn, sc):
    with as_superuser(conn, commit=False) as s:
        t = send_body(s, sc.alice.actor, sc.alice.org, None)
        back_to_owner(s)
        s.rows("update public.media_uploads set status = 'expired' where status = 'uploaded' and id <> %s returning 1", [t])
        become(s, SERVICE)
        s.rows("select 1 from public.claim_media_upload('w-folder')")
        out = s.run("select public.register_asset(gen_random_uuid(), null, 'image', 'image/png', 50, repeat('f', 64), "
                    "'upload', p_upload_id => %s, p_folder_id => %s)", [t, FOLDER["b"]])
        # There is no such argument: the call does not resolve at all.
        assert refused(out, "42883"), out
        # Nor can the service role write a ticket's folder directly.
        upd = s.run("update public.media_uploads set folder_id = %s where id = %s", [FOLDER["a"], t])
        assert (not upd.ok) and upd.sqlstate == "42501", upd


def test_a_retried_registration_answers_with_the_same_folder(conn, sc):
    with as_superuser(conn, commit=False) as s:
        t = send_body(s, sc.alice.actor, sc.alice.org, FOLDER["a"])
        first = claim_and_register(s, t)
        become(s, SERVICE)
        again = s.value("select public.register_asset(gen_random_uuid(), null, 'image', 'image/png', 50, repeat('f', 64), "
                        "'upload', p_upload_id => %s)", [t])
        assert again["reused"] is True and again["id"] == first["id"] and again["folder_id"] == FOLDER["a"], again


def test_generated_files_are_unchanged(conn, sc):
    with acting(conn, SERVICE) as s:
        out = s.value("select public.register_asset(gen_random_uuid(), %s, 'image', 'image/png', 10, repeat('9', 64), "
                      "'generated')", [sc.alice.org])
        assert out["folder_id"] is None and out["reused"] is False, out

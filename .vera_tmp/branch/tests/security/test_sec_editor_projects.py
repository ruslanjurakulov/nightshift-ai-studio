"""Named attacks on the video editor (migration 0054).

The table-by-table isolation tests already prove that Bob (org B) cannot read,
change, delete or insert Alice's (org A) project and export rows directly.
These prove the paths where the check lives in plpgsql: creating a project
that names another organization's files, saving / deleting / exporting
another organization's project, the worker's functions, and the limits that
stand in for a price (an export is free).

Every attack runs in a transaction that is rolled back.
"""

from __future__ import annotations

import json
import uuid

import pytest

from sec_db import ANON, SERVICE, acting, as_superuser
from sec_editor_0054 import AUDIO, EXPORT, PROJECT, VIDEO, doc, register

CREATE = "select public.create_editor_project(%s, %s, %s::jsonb)"
SAVE = "select public.save_editor_project(%s, %s, %s, %s::jsonb)"
DELETE = "select public.delete_editor_project(%s)"
EXPORT_Q = "select public.request_editor_export(%s, %s)"
CLAIM = "select id::text, org_id::text, status from public.claim_editor_export(%s)"
ASSETS = "select id::text from public.editor_export_assets(%s)"
FINISH = "select public.finish_editor_export(%s, %s, %s, %s)"
HEARTBEAT = "select public.editor_export_heartbeat(%s, %s)"


def refused(out, sqlstate: str, word: str | None = None) -> bool:
    return (not out.ok) and out.sqlstate == sqlstate and (word is None or word in (out.error or ""))


def project_row(conn, project: str):
    with as_superuser(conn, commit=False) as s:
        rows = s.rows("select org_id::text, title, rev, doc, deleted_at from public.editor_projects where id = %s",
                      [project])
    return rows[0] if rows else None


def j(d) -> str:
    return json.dumps(d)


# ── reading ─────────────────────────────────────────────────────────────────

def test_another_org_reads_none_of_alices_projects_or_exports(conn, sc):
    for who in (sc.bob.actor, sc.stranger, sc.dana, ANON):
        with acting(conn, who) as s:
            p = s.run("select count(*) from public.editor_projects where org_id = %s", [sc.alice.org])
            e = s.run("select count(*) from public.editor_exports where org_id = %s", [sc.alice.org])
        for out in (p, e):
            assert (not out.ok) or out.rows == [(0,)], f"{who.name}: {out!r}"
    with acting(conn, sc.alice.actor) as s:
        assert s.value("select count(*) from public.editor_projects where id = %s", [PROJECT["a"]]) == 1
        assert s.value("select count(*) from public.editor_exports where id = %s", [EXPORT["a"]]) == 1


# ── creating ────────────────────────────────────────────────────────────────

def test_bob_cannot_create_a_project_in_alices_org(conn, sc):
    with acting(conn, sc.bob.actor) as s:
        theirs = s.run(CREATE, [sc.alice.org, "Mine now", j(doc(VIDEO["b"]))])
        made_up = s.run(CREATE, [str(uuid.uuid4()), "Mine now", j(doc(VIDEO["b"]))])
    assert refused(theirs, "42501"), theirs
    assert (theirs.sqlstate, theirs.error) == (made_up.sqlstate, made_up.error)


def test_alices_file_reads_like_a_made_up_one_in_bobs_project(conn, sc):
    with acting(conn, sc.bob.actor) as s:
        hers = s.run(CREATE, [sc.bob.org, "Steal", j(doc(VIDEO["a"]))])
        made_up = s.run(CREATE, [sc.bob.org, "Steal", j(doc(str(uuid.uuid4())))])
        her_music = s.run(CREATE, [sc.bob.org, "Steal", j(doc(VIDEO["b"], audio=AUDIO["a"]))])
    assert refused(hers, "NS400", "invalid_asset"), hers
    assert (hers.sqlstate, hers.error) == (made_up.sqlstate, made_up.error)
    assert refused(her_music, "NS400", "invalid_asset"), her_music


def test_a_foreign_file_hidden_anywhere_in_the_document_is_refused(conn, sc):
    # Not where a clip keeps it: a field the renderer would reject anyway.
    sneaky = doc(VIDEO["b"])
    sneaky["tracks"][1]["clips"][0]["asset_id"] = VIDEO["a"]
    deep = doc(VIDEO["b"])
    deep["extra"] = {"nested": [{"asset_id": VIDEO["a"]}]}
    upper = doc(VIDEO["a"].upper())
    with acting(conn, sc.bob.actor) as s:
        outs = [s.run(CREATE, [sc.bob.org, "x", j(d)]) for d in (sneaky, deep, upper)]
    for out in outs:
        assert refused(out, "NS400", "invalid_asset"), out


def test_a_deleted_file_cannot_be_used(conn, sc):
    gone = register(conn, sc.bob.org, "b-gone")
    with as_superuser(conn, commit=False) as s:
        s.run("update public.media_assets set deleted_at = now() where id = %s", [gone])
        s.conn.execute("select set_config('request.jwt.claims', %s, true)", [json.dumps(sc.bob.actor.claims())])
        s.conn.execute("set local role authenticated")
        out = s.run(CREATE, [sc.bob.org, "x", j(doc(gone))])
    assert refused(out, "NS400", "invalid_asset"), out


def test_malformed_documents_and_titles_are_refused(conn, sc):
    big = doc(VIDEO["b"])
    big["tracks"][1]["clips"][0]["text"] = "x" * 300_000
    cases = {
        "invalid_doc": [{"version": 2, "tracks": []}, {"version": 1, "tracks": {}}, [1, 2],
                        {"version": 1, "tracks": [{"id": "v", "kind": "V", "clips": "no"}]}],
        "invalid_asset": [doc("not-a-uuid"), doc(VIDEO["b"] + "'; drop table x; --")],
        "doc_too_large": [big],
    }
    with acting(conn, sc.bob.actor) as s:
        for word, docs in cases.items():
            for d in docs:
                out = s.run(CREATE, [sc.bob.org, "x", j(d)])
                assert refused(out, "NS400", word) or (word == "doc_too_large" and refused(out, "NS400")), (word, out)
        for title in ("", "   ", "\x01\x02", "x" * 121):
            out = s.run(CREATE, [sc.bob.org, title, j(doc(VIDEO["b"]))])
            assert refused(out, "NS400", "invalid_title"), (title, out)


# ── saving, deleting ────────────────────────────────────────────────────────

def test_bob_cannot_save_or_delete_alices_project(conn, sc):
    before = project_row(conn, PROJECT["a"])
    with acting(conn, sc.bob.actor) as s:
        theirs = (s.run(SAVE, [PROJECT["a"], 1, "pwned", j(doc(VIDEO["b"]))]),
                  s.run(DELETE, [PROJECT["a"]]),
                  s.run(EXPORT_Q, [PROJECT["a"], 1]))
        made_up = (s.run(SAVE, [str(uuid.uuid4()), 1, "pwned", j(doc(VIDEO["b"]))]),
                   s.run(DELETE, [str(uuid.uuid4())]),
                   s.run(EXPORT_Q, [str(uuid.uuid4()), 1]))
    for t, m in zip(theirs, made_up):
        # Another org's project reads as missing, exactly like a made-up id.
        assert refused(t, "P0002", "not_found"), t
        assert (t.sqlstate, t.error) == (m.sqlstate, m.error), (t, m)
    assert project_row(conn, PROJECT["a"]) == before


def test_alice_cannot_save_bobs_file_into_her_own_project(conn, sc):
    with acting(conn, sc.alice.actor) as s:
        out = s.run(SAVE, [PROJECT["a"], 1, None, j(doc(VIDEO["b"]))])
    assert refused(out, "NS400", "invalid_asset"), out


def test_a_stale_save_does_not_overwrite_a_newer_one(conn, sc):
    with acting(conn, sc.alice.actor) as s:
        first = s.value(SAVE, [PROJECT["a"], 1, "Second", None])
        stale = s.run(SAVE, [PROJECT["a"], 1, "Lost update", j(doc(VIDEO["a"], out_s=4))])
        title = s.value("select title from public.editor_projects where id = %s", [PROJECT["a"]])
    assert first == 2
    assert refused(stale, "NS409", "stale_revision"), stale
    assert title == "Second"


def test_a_deleted_project_is_gone_for_its_own_org_too(conn, sc):
    with acting(conn, sc.alice.actor) as s:
        assert s.value(DELETE, [PROJECT["a"]]) is True
        assert s.value("select count(*) from public.editor_projects where id = %s", [PROJECT["a"]]) == 0
        again = s.run(SAVE, [PROJECT["a"], 1, "back", None])
        export = s.run(EXPORT_Q, [PROJECT["a"], 1])
        status = s.value("select status || ':' || reason from public.editor_exports where id = %s", [EXPORT["a"]])
    assert refused(again, "P0002"), again
    assert refused(export, "P0002"), export
    # The export that was waiting is not rendered for nobody.
    assert status == "failed:project_deleted"


@pytest.mark.parametrize("who", ["stranger", "anon"])
def test_outsiders_cannot_write(conn, sc, who):
    actor = {"stranger": sc.stranger, "anon": ANON}[who]
    before = project_row(conn, PROJECT["a"])
    with acting(conn, actor) as s:
        outs = [s.run(CREATE, [sc.alice.org, "x", j(doc(VIDEO["a"]))]),
                s.run(SAVE, [PROJECT["a"], 1, "x", None]),
                s.run(DELETE, [PROJECT["a"]]),
                s.run(EXPORT_Q, [PROJECT["a"], 1])]
    for out in outs:
        assert (not out.ok) and out.sqlstate in ("42501", "P0002"), out
    assert project_row(conn, PROJECT["a"]) == before


def test_no_api_role_writes_projects_or_exports_directly(conn, sc):
    for who in (sc.alice.actor, sc.bob.actor, SERVICE):
        with acting(conn, who) as s:
            outs = [
                s.run("insert into public.editor_projects (org_id, title, doc) values (%s, 'd', '{}'::jsonb)",
                      [sc.alice.org]),
                s.run("update public.editor_projects set title = 'direct' where id = %s", [PROJECT["a"]]),
                s.run("delete from public.editor_projects where id = %s", [PROJECT["a"]]),
                s.run("update public.editor_exports set status = 'done' where id = %s", [EXPORT["a"]]),
                s.run("insert into public.editor_exports (org_id, project_id, rev, doc, duration_s, requested_by) "
                      "values (%s, %s, 1, '{}'::jsonb, 1, gen_random_uuid())", [sc.alice.org, PROJECT["a"]]),
            ]
        for out in outs:
            assert (not out.ok) or out.rowcount == 0, (who.name, out)


# ── exports: free, bounded ──────────────────────────────────────────────────

def test_an_export_holds_and_charges_no_credits(conn, sc):
    ledger = ("select (select count(*) from public.credit_transactions where org_id = %(o)s), "
              "(select count(*) from public.credit_reservations where org_id = %(o)s), "
              "(select balance from public.credit_accounts where org_id = %(o)s)")
    with as_superuser(conn, commit=False) as s:
        before = s.rows(ledger, {"o": sc.bob.org})
        s.run("update public.editor_exports set status = 'failed', reason = 'test' where project_id = %s",
              [PROJECT["b"]])
        s.conn.execute("select set_config('request.jwt.claims', %s, true)", [json.dumps(sc.bob.actor.claims())])
        s.conn.execute("set local role authenticated")
        rev = s.value(SAVE, [PROJECT["b"], 1, None, j(doc(VIDEO["b"], out_s=6, speed=2))])
        fresh = s.run(EXPORT_Q, [PROJECT["b"], rev])
        busy = s.run(EXPORT_Q, [PROJECT["b"], rev])
        s.conn.execute("reset role")
        s.conn.execute("select set_config('request.jwt.claims', '', true)")
        after = s.rows(ledger, {"o": sc.bob.org})
    assert fresh.ok, fresh
    # One at a time per project.
    assert refused(busy, "NS409", "export_in_progress"), busy
    assert after == before


def test_export_needs_the_current_saved_revision_and_a_sane_length(conn, sc):
    with as_superuser(conn, commit=False) as s:
        s.run("update public.editor_exports set status = 'failed', reason = 'test' where project_id = %s",
              [PROJECT["b"]])
        s.conn.execute("select set_config('request.jwt.claims', %s, true)", [json.dumps(sc.bob.actor.claims())])
        s.conn.execute("set local role authenticated")
        stale = s.run(EXPORT_Q, [PROJECT["b"], 7])
        rev = s.value(SAVE, [PROJECT["b"], 1, None, j(doc(VIDEO["b"], out_s=20, speed=0.5))])
        ok = s.run(EXPORT_Q, [PROJECT["b"], rev])
        length = s.value("select duration_s::float from public.editor_exports where id = %s",
                         [ok.rows[0][0] if ok.ok else None])
        too_long = doc(VIDEO["b"])
        too_long["tracks"][1]["clips"][0]["end_s"] = 1801
        s.run("update public.editor_exports set status = 'failed' where project_id = %s", [PROJECT["b"]])
        rev2 = s.value(SAVE, [PROJECT["b"], rev, None, j(too_long)])
        long_out = s.run(EXPORT_Q, [PROJECT["b"], rev2])
    assert refused(stale, "NS409", "stale_revision"), stale
    assert ok.ok, ok
    # (20 - 2) source seconds at half speed play for 36 s.
    assert length == 36.0
    assert refused(long_out, "NS400", "too_long"), long_out


def test_exports_per_org_are_capped(conn, sc):
    with as_superuser(conn, commit=False) as s:
        for _ in range(20):
            s.run("insert into public.editor_exports (org_id, project_id, rev, doc, duration_s, status, requested_by) "
                  "values (%s, %s, 1, '{}'::jsonb, 1, 'failed', gen_random_uuid())", [sc.bob.org, PROJECT["b"]])
        s.run("update public.editor_exports set status = 'failed' where project_id = %s", [PROJECT["b"]])
        s.conn.execute("select set_config('request.jwt.claims', %s, true)", [json.dumps(sc.bob.actor.claims())])
        s.conn.execute("set local role authenticated")
        out = s.run(EXPORT_Q, [PROJECT["b"], 1])
    assert refused(out, "NS429", "daily_limit"), out


# ── the worker's functions ──────────────────────────────────────────────────

@pytest.mark.parametrize("who", ["alice", "bob", "anon"])
def test_browsers_cannot_call_the_workers_functions(conn, sc, who):
    actor = {"alice": sc.alice.actor, "bob": sc.bob.actor, "anon": ANON}[who]
    with acting(conn, actor) as s:
        outs = [s.run(CLAIM, ["w"]), s.run(ASSETS, [EXPORT["a"]]), s.run(HEARTBEAT, [EXPORT["a"], "w"]),
                s.run(FINISH, [EXPORT["a"], "w", None, "x"])]
    for out in outs:
        assert refused(out, "42501"), (who, out)


def test_the_worker_reads_only_the_exports_own_orgs_live_files(conn, sc):
    with acting(conn, SERVICE) as s:
        a = {r[0] for r in s.rows(ASSETS, [EXPORT["a"]])}
        b = {r[0] for r in s.rows(ASSETS, [EXPORT["b"]])}
        none = s.rows(ASSETS, [str(uuid.uuid4())])
    assert a == {VIDEO["a"], AUDIO["a"]}
    assert b == {VIDEO["b"], AUDIO["b"]}
    assert none == []


def test_a_finished_export_must_be_the_exports_own_orgs_render(conn, sc):
    with acting(conn, SERVICE) as s:
        claimed = s.rows(CLAIM, ["worker-1"])
        assert claimed and claimed[0][2] == "rendering"
        eid, org = claimed[0][0], claimed[0][1]
        other = sc.bob.org if org == sc.alice.org else sc.alice.org
        foreign = s.value("select public.register_asset(gen_random_uuid(), %s, 'video', 'video/mp4', 10, %s, "
                          "'render') ->> 'id'", [other, "c" * 64])
        upload_like = s.value("select public.register_asset(gen_random_uuid(), %s, 'video', 'video/mp4', 10, %s, "
                              "'generated') ->> 'id'", [org, "d" * 64])
        own = s.value("select public.register_asset(gen_random_uuid(), %s, 'video', 'video/mp4', 10, %s, "
                      "'render') ->> 'id'", [org, "e" * 64])
        wrong_worker = s.run(FINISH, [eid, "worker-2", own, None])
        foreign_out = s.run(FINISH, [eid, "worker-1", foreign, None])
        not_render = s.run(FINISH, [eid, "worker-1", upload_like, None])
        done = s.value(FINISH, [eid, "worker-1", own, None])
        again = s.value(FINISH, [eid, "worker-1", None, "late"])
        row = s.rows("select status, asset_id::text from public.editor_exports where id = %s", [eid])
    assert refused(wrong_worker, "55000"), wrong_worker
    assert refused(foreign_out, "42501", "invalid_asset"), foreign_out
    assert refused(not_render, "42501", "invalid_asset"), not_render
    assert done == "done" and again == "done"
    assert row == [("done", own)]


def test_a_failure_reason_is_a_word_never_free_text(conn, sc):
    with acting(conn, SERVICE) as s:
        eid = s.rows(CLAIM, ["worker-1"])[0][0]
        assert s.value(FINISH, [eid, "worker-1", None, "ffmpeg said: /media/aa/secret path"]) == "failed"
        assert s.value("select reason from public.editor_exports where id = %s", [eid]) == "render_failed"

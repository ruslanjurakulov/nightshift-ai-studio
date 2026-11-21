"""Named attacks on "Open in editor" (no new migration: it writes documents
through the 0054 functions, so those are what must hold).

The route (POST /api/editor/send) pins the file to the project's organization
before it asks the database, but the database is the last word. The person who
matters here belongs to TWO organizations: RLS lets them read both
organizations' files, so a file of one organization going into a project of the
other is the attack the pin and the database both have to stop. Also held to
the database: every document the Command Center builds for a send
(samples/editor_send_cases.json — a still picture, a sound under an empty
picture track, a clip added to a project with text) is accepted for the
organization's own files.

Every attempt runs in a transaction that is rolled back.
"""

from __future__ import annotations

import json
from contextlib import contextmanager
from pathlib import Path

from sec_db import acting, as_superuser
from sec_editor_0054 import PROJECT, VIDEO, doc, register

CASES = Path(__file__).resolve().parents[2] / "samples" / "editor_send_cases.json"
CREATE = "select public.create_editor_project(%s, %s, %s::jsonb)"
SAVE = "select public.save_editor_project(%s, %s, null, %s::jsonb)"


@contextmanager
def two_org_member(conn, sc):
    """Bob, who also belongs to Alice's organization — for the length of one transaction."""
    with as_superuser(conn, commit=False) as su:
        su.rows("insert into public.org_members (org_id, user_id, email, role) values (%s, %s, %s, 'viewer') returning 1",
                [sc.alice.org, sc.bob.actor.uid, sc.bob.actor.email])
        yield


def with_extra_clip(base: dict, asset: str) -> dict:
    out = json.loads(json.dumps(base))
    out["tracks"][0]["clips"].append({"id": "c9", "asset_id": asset, "start_s": 6, "in_s": 0, "out_s": 4,
                                      "speed": 1, "audio": False})
    return out


def test_a_member_of_two_orgs_cannot_send_one_orgs_file_into_the_others_project(conn, sc):
    with two_org_member(conn, sc):
        # The premise: RLS alone would show Bob Alice's file, so the route's pin is what stops it.
        with acting(conn, sc.bob.actor) as s:
            assert s.value("select count(*) from public.media_assets where id = %s", [VIDEO["a"]]) == 1
            into_project = s.run(SAVE, [PROJECT["b"], 1, json.dumps(with_extra_clip(doc(VIDEO["b"]), VIDEO["a"]))])
            as_new = s.run(CREATE, [sc.bob.org, "Steal", json.dumps(doc(VIDEO["a"]))])
            made_up = s.run(CREATE, [sc.bob.org, "Steal", json.dumps(doc("99999999-9999-4999-8999-999999999999"))])
    for out in (into_project, as_new):
        assert (not out.ok) and out.sqlstate == "NS400" and "invalid_asset" in (out.error or ""), out
    assert (as_new.sqlstate, as_new.error) == (made_up.sqlstate, made_up.error)


def test_the_same_member_can_send_a_file_into_the_project_of_the_organization_it_belongs_to(conn, sc):
    with two_org_member(conn, sc):
        with acting(conn, sc.bob.actor) as s:
            ok = s.run(SAVE, [PROJECT["a"], 1, json.dumps(with_extra_clip(doc(VIDEO["a"]), VIDEO["a"]))])
    assert ok.ok and ok.rows == [(2,)], ok


def test_a_stale_send_is_refused_not_applied_over_a_newer_save(conn, sc):
    with acting(conn, sc.bob.actor) as s:
        out = s.run(SAVE, [PROJECT["b"], 7, json.dumps(with_extra_clip(doc(VIDEO["b"]), VIDEO["b"]))])
    assert (not out.ok) and out.sqlstate == "NS409" and "stale_revision" in (out.error or ""), out


def test_someone_outside_the_org_cannot_send_into_its_project_and_reads_not_found(conn, sc):
    with acting(conn, sc.bob.actor) as s:
        theirs = s.run(SAVE, [PROJECT["a"], 1, json.dumps(doc(VIDEO["b"]))])
        made_up = s.run(SAVE, ["99999999-9999-4999-8999-999999999999", 1, json.dumps(doc(VIDEO["b"]))])
    assert (not theirs.ok) and theirs.sqlstate == "P0002", theirs
    assert (theirs.sqlstate, theirs.error) == (made_up.sqlstate, made_up.error)


def _real(conn, org: str, kinds: dict[str, str], label: str) -> dict[str, str]:
    return {fake: register(conn, org, f"send-{label}-{i}", kind) for i, (fake, kind) in enumerate(kinds.items())}


def test_every_document_a_send_builds_is_accepted_for_the_orgs_own_files(conn, sc):
    cases = json.loads(CASES.read_text(encoding="utf-8"))["cases"]
    assert len(cases) >= 6
    for n, case in enumerate(cases):
        kinds: dict[str, str] = {case["asset"]["id"]: case["asset"]["kind"]}
        for t in (case["doc"] or {"tracks": []})["tracks"]:
            for c in t["clips"]:
                if "asset_id" in c:
                    kinds.setdefault(c["asset_id"], "audio" if t["kind"] == "A" else "video")
        files = _real(conn, sc.bob.org, kinds, str(n))

        def real(d):
            text = json.dumps(d)
            for fake, rid in files.items():
                text = text.replace(fake, rid)
            return text

        with acting(conn, sc.bob.actor) as s:
            if case["doc"] is None:
                out = s.run(CREATE, [sc.bob.org, "Sent", real(case["expected"])])
            else:
                pid = s.value(CREATE, [sc.bob.org, "Before", real(case["doc"])])
                out = s.run(SAVE, [pid, 1, real(case["expected"])])
        assert out.ok, (case["name"], out)

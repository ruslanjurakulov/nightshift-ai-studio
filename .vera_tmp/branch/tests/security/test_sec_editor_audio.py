"""The database's half of the editor's music track (follow-up to 0054; no new
migration): the shared asset cases in samples/timeline_doc_cases.json, run
through create_editor_project -> editor_doc_problem() in a member's own
session.

The database guards WHOSE file a document names: a song of another
organization is refused exactly like a made-up id (invalid_asset). It does not
judge which track a file is on — a picture on the music track of the right
organization is accepted here and refused by the save route
(lib/editor.ts docAssetProblems) and by the renderer (timeline.resolve_assets).
Each case's "sql" field says which; this test holds the database to it.

Every attempt runs in a transaction that is rolled back.
"""

from __future__ import annotations

import json
from pathlib import Path

from sec_db import acting
from sec_editor_0054 import register

CASES = Path(__file__).resolve().parents[2] / "samples" / "timeline_doc_cases.json"
CREATE = "select public.create_editor_project(%s, %s, %s::jsonb)"


def _asset_cases():
    return [c for c in json.loads(CASES.read_text(encoding="utf-8"))["cases"] if "assets" in c]


def test_every_shared_asset_case_gets_the_answer_it_names(conn, sc):
    cases = _asset_cases()
    assert any(c["sql"] == "invalid_asset" for c in cases)
    real: dict = {}
    for case in cases:
        # Each id in the case becomes a real file: Bob's organization's of the
        # stated kind, or Alice's when the case says "other_org".
        text = json.dumps(case["doc"])
        for fake, kind in case["assets"].items():
            key = (fake, kind)
            if key not in real:
                org = sc.alice.org if kind == "other_org" else sc.bob.org
                real[key] = register(conn, org, f"audio-case-{len(real)}",
                                     "audio" if kind == "other_org" else kind)
            text = text.replace(fake, real[key])
        with acting(conn, sc.bob.actor) as s:
            out = s.run(CREATE, [sc.bob.org, "Music case", text])
        if case["sql"] is None:
            assert out.ok, (case["name"], out)
        else:
            assert (not out.ok) and out.sqlstate == "NS400" and case["sql"] in (out.error or ""), \
                (case["name"], out)


def test_another_orgs_song_reads_like_a_made_up_one_on_save_too(conn, sc):
    from sec_editor_0054 import AUDIO, PROJECT, VIDEO, doc

    with acting(conn, sc.bob.actor) as s:
        hers = s.run("select public.save_editor_project(%s, 1, null, %s::jsonb)",
                     [PROJECT["b"], json.dumps(doc(VIDEO["b"], audio=AUDIO["a"]))])
        made_up = s.run("select public.save_editor_project(%s, 1, null, %s::jsonb)",
                        [PROJECT["b"], json.dumps(doc(VIDEO["b"], audio="99999999-9999-4999-8999-999999999999"))])
    assert (not hers.ok) and hers.sqlstate == "NS400" and "invalid_asset" in (hers.error or ""), hers
    assert (hers.sqlstate, hers.error) == (made_up.sqlstate, made_up.error)


def test_a_ducked_document_is_stored_unchanged_and_still_guards_the_files(conn, sc):
    """Music ducking adds ``role`` and ``duck`` to an A track and changes no
    SQL: the database stores the document as it is and still refuses another
    organization's file anywhere in it."""
    from sec_editor_0054 import AUDIO, VIDEO, doc

    def ducked(video: str, music: str) -> dict:
        d = doc(video, audio=music)
        d["tracks"][-1]["duck"] = {"amount_db": 12, "attack_s": 0.3, "release_s": 0.8}
        d["tracks"].append({"id": "a2", "kind": "A", "role": "speech", "clips": [
            {"id": "v2", "asset_id": music, "start_s": 1, "in_s": 0, "out_s": 3}]})
        return d

    mine = ducked(VIDEO["b"], AUDIO["b"])
    with acting(conn, sc.bob.actor) as s:
        ok = s.run(CREATE, [sc.bob.org, "Ducked", json.dumps(mine)])
        hers = s.run(CREATE, [sc.bob.org, "Ducked", json.dumps(ducked(VIDEO["b"], AUDIO["a"]))])
        stored = s.value("select doc from public.editor_projects where id = %s", [ok.rows[0][0]]) if ok.ok else None
    assert ok.ok, ok
    assert stored == mine
    assert (not hers.ok) and hers.sqlstate == "NS400" and "invalid_asset" in (hers.error or ""), hers

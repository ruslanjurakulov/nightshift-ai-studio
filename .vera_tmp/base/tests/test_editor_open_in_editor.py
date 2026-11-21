"""The documents "Open in editor" saves are documents the worker will render.

The Command Center builds them (command-center/lib/editor.ts newDocForAnyAsset
/ appendAssetToDoc, pinned by command-center/tests/editor-send.test.ts) and the
save route checks them with its own copy of the rules; the renderer's rules are
modules/timeline.py, which runs again before anything is rendered. A send that
produced a document this side refuses would be a project that saves and then
fails at export — so each case in samples/editor_send_cases.json is judged by
validate() and by the export's file resolver, the way an export reads it.
The database's half is tests/security/test_sec_editor_send.py."""

import json
import unittest
from pathlib import Path

from modules import timeline as tl

CASES = Path(__file__).resolve().parent.parent / "samples" / "editor_send_cases.json"


def _cases():
    return json.loads(CASES.read_text(encoding="utf-8"))["cases"]


def _kinds(case) -> dict:
    """Every file the case's documents use, with the kind it has in the library."""
    kinds = {case["asset"]["id"]: case["asset"]["kind"]}
    for doc in (case["doc"], case["expected"]):
        for track in (doc or {"tracks": []})["tracks"]:
            for clip in track["clips"]:
                if "asset_id" in clip:
                    kinds.setdefault(clip["asset_id"], "audio" if track["kind"] == "A" else "video")
    return kinds


def _resolver(kinds: dict):
    table = {aid: tl.ResolvedAsset(aid, kind, f"/media/{aid}", None if kind == "image" else 600.0)
             for aid, kind in kinds.items()}
    return table.get


class OpenInEditorCasesTestCase(unittest.TestCase):
    def test_there_is_a_case_for_each_kind_of_file_and_for_both_targets(self):
        cases = _cases()
        self.assertEqual({c["asset"]["kind"] for c in cases}, {"video", "image", "audio"})
        self.assertTrue(any(c["doc"] is None for c in cases))
        self.assertTrue(any(c["doc"] is not None for c in cases))

    def test_every_saved_document_validates_and_resolves_its_files(self):
        for case in _cases():
            with self.subTest(case["name"]):
                self.assertEqual(tl.validate(case["expected"]), [])
                found = tl.resolve_assets(tl.load(case["expected"]), _resolver(_kinds(case)))
                self.assertIn(case["asset"]["id"], found)

    def test_the_project_before_the_send_was_valid_too(self):
        for case in _cases():
            if case["doc"] is not None:
                with self.subTest(case["name"]):
                    self.assertEqual(tl.validate(case["doc"]), [])

    def test_a_send_only_adds_never_removes_or_rewrites_what_was_there(self):
        for case in _cases():
            if case["doc"] is None:
                continue
            with self.subTest(case["name"]):
                before = {c["id"]: c for t in case["doc"]["tracks"] for c in t["clips"]}
                after = {c["id"]: c for t in case["expected"]["tracks"] for c in t["clips"]}
                for cid, clip in before.items():
                    # the text clips gain the editor's defaults; their words and times stay
                    self.assertEqual({k: after[cid][k] for k in clip}, clip)
                self.assertEqual(len(after), len(before) + 1)
                self.assertTrue(any(c.get("asset_id") == case["asset"]["id"] for c in after.values()))

    def test_a_picture_is_a_still_on_the_picture_track_and_a_sound_is_on_an_audio_track(self):
        for case in _cases():
            kind = case["asset"]["kind"]
            holders = [t["kind"] for t in case["expected"]["tracks"]
                       for c in t["clips"] if c.get("asset_id") == case["asset"]["id"]]
            with self.subTest(case["name"]):
                self.assertEqual(holders, ["A"] if kind == "audio" else ["V"])

    def test_a_picture_on_the_music_track_would_be_refused(self):
        case = next(c for c in _cases() if c["asset"]["kind"] == "image")
        doc = json.loads(json.dumps(case["expected"]))
        doc["tracks"].append({"id": "a1", "kind": "A", "clips": [
            {"id": "m1", "asset_id": case["asset"]["id"], "start_s": 0, "in_s": 0, "out_s": 3}]})
        with self.assertRaises(tl.TimelineError):
            tl.resolve_assets(tl.load(doc), _resolver(_kinds(case)))


if __name__ == "__main__":
    unittest.main()

"""The editor's "reuse a look" edits (command-center/lib/editorSelection.ts, editorPasteLook.ts and editorSync.ts:
multi-select delete, move, nudge, copy and paste; paste attributes from a clip or a stored preset; ripple edits with
sync lock moving texts, sounds, overlays and shapes) held to THIS validator, not only to its TypeScript twin.

samples/editor_look_fuzz_docs.json.gz holds every state of a seeded run of 9,000 edits as the editor saves them
(written by command-center/tests/editor-look-fuzz.test.ts, which fails when the operations stop making exactly these
documents). Every document must pass ``validate`` and ``resolve_assets``.
"""

import gzip
import json
import unittest
from pathlib import Path

from modules import timeline as tl

FILE = Path(__file__).resolve().parent.parent / "samples" / "editor_look_fuzz_docs.json.gz"
LENGTHS = {
    "11111111-1111-4111-8111-111111111111": 10.0,
    "22222222-2222-4222-8222-222222222222": 6.0,
    "33333333-3333-4333-8333-333333333333": None,
    "44444444-4444-4444-8444-444444444444": 30.0,
    "55555555-5555-4555-8555-555555555555": None,
}


class EditorLookFuzzTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.data = json.loads(gzip.decompress(FILE.read_bytes()).decode("utf-8"))

    def resolver(self, aid):
        kind = self.data["assets"].get(aid)
        if kind is None:
            return None
        return tl.ResolvedAsset(aid, kind, f"/media/{aid}", LENGTHS.get(aid), kind == "video")

    def test_the_run_is_the_one_described(self):
        self.assertEqual(self.data["seeds"], [7, 99, 20261113])
        docs = self.data["docs"]
        self.assertGreater(len(docs), 4000)
        self.assertTrue({(1920, 1080), (1080, 1920), (2560, 1440), (3840, 2160)} <= {(d["width"], d["height"]) for d in docs})
        # what this run is about is in it: texts, overlays and shapes, and looks on clips
        self.assertGreater(sum(1 for d in docs if any(t["kind"] == "T" for t in d["tracks"])), 1000)
        self.assertGreater(sum(1 for d in docs if d.get("overlays")), 500)
        self.assertGreater(sum(1 for d in docs if d.get("shapes")), 500)
        looked = sum(1 for d in docs for c in d["tracks"][0]["clips"] if any(k in c for k in ("grade", "color", "mask", "fx", "move")))
        self.assertGreater(looked, 2000)

    def test_every_document_the_editor_made_is_one_this_validator_accepts(self):
        refused = []
        for i, d in enumerate(self.data["docs"]):
            problems = tl.validate(d)
            if not problems:
                try:
                    tl.resolve_assets(d, self.resolver)
                except tl.TimelineError as e:
                    problems = [str(e)]
            if problems:
                refused.append((i, problems[:2]))
        self.assertEqual(refused[:5], [], f"{len(refused)} refused")

    def test_nothing_starts_before_zero(self):
        for d in self.data["docs"]:
            for t in d["tracks"]:
                for c in t["clips"]:
                    self.assertGreaterEqual(c["start_s"], 0)
            for o in (d.get("overlays") or []) + (d.get("shapes") or []):
                self.assertGreaterEqual(o["start_s"], 0)


if __name__ == "__main__":
    unittest.main()

"""The editor's editing core (command-center/lib/editor.ts and lib/editorRange.ts: roll, slip, slide, ripple trim,
range delete, lift, insert, J / L cut) held to THIS validator, not only to its TypeScript twin.

samples/editor_core_fuzz_docs.json.gz holds every state of a seeded run of 15,000 edits as the editor saves them
(written by command-center/tests/editor-core-fuzz.test.ts, which fails when the operations stop making exactly these
documents). Seeds 7 and 99 are the ones that, while the editor rounded milliseconds with Math.round, gave documents
the editor laid out and saved and this validator refused ("clips overlap", "cross-fade must start"): a 0.7745 s clip
was 0.775 there and 0.774 here. The editor's ``ms`` is now Python's ``round(v, 3)`` bit for bit
(command-center/tests/editor-ms-round.test.ts, against samples/ms_round_cases.json.gz), and ``_ms`` here is unchanged
(the database's editor_ms, migration 0136, copies it). Every document must pass ``validate`` and ``resolve_assets``.
"""

import gzip
import json
import unittest
from pathlib import Path

from modules import timeline as tl

FILE = Path(__file__).resolve().parent.parent / "samples" / "editor_core_fuzz_docs.json.gz"
DURATIONS = {"video": None, "image": None, "audio": None}
LENGTHS = {
    "11111111-1111-4111-8111-111111111111": 10.0,
    "22222222-2222-4222-8222-222222222222": 6.0,
    "33333333-3333-4333-8333-333333333333": None,
    "44444444-4444-4444-8444-444444444444": 30.0,
}


class EditorCoreFuzzTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.data = json.loads(gzip.decompress(FILE.read_bytes()).decode("utf-8"))

    def resolver(self, aid):
        kind = self.data["assets"].get(aid)
        if kind is None:
            return None
        return tl.ResolvedAsset(aid, kind, f"/media/{aid}", LENGTHS.get(aid), kind == "video")

    def test_the_run_is_the_one_described(self):
        self.assertEqual(self.data["seeds"], [7, 99, 20261112])
        self.assertGreater(len(self.data["docs"]), 4500)
        frames = {(d["width"], d["height"]) for d in self.data["docs"]}
        self.assertTrue({(1920, 1080), (1080, 1920), (2560, 1440), (3840, 2160)} <= frames, frames)
        self.assertTrue({24, 25, 30, 60} <= {d["fps"] for d in self.data["docs"]})
        # gaps (what a lift leaves) are in it: a picture clip starting after the one before it ended
        gaps = 0
        for d in self.data["docs"]:
            v = sorted(d["tracks"][0]["clips"], key=lambda c: c["start_s"])
            gaps += any(b["start_s"] > tl.clip_end_s(a) + 0.0015 for a, b in zip(v, v[1:]))
        self.assertGreater(gaps, 50)

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

    def test_ms_here_is_still_round_to_three_places_and_the_table_is_its_answers(self):
        # The editor follows this rounding, not the other way round: the database's editor_ms (0136) copies it.
        self.assertEqual(tl._ms(0.7745), 0.774)
        self.assertEqual(tl._ms(0.0625), 0.062)
        table = json.loads(gzip.decompress((FILE.parent / "ms_round_cases.json.gz").read_bytes()).decode("utf-8"))
        self.assertGreater(len(table["x"]), 100000)
        bad = [(x, y) for x, y in zip(table["x"], table["y"]) if repr(round(x, 3)) != repr(y) or repr(tl._ms(x)) != repr(y)]
        self.assertEqual(bad[:5], [])


if __name__ == "__main__":
    unittest.main()

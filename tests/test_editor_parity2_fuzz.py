"""Editor parity 2: a seeded fuzz of the new V clip fields (``color``, ``mask``) shared by both validators.

``random_doc`` builds documents around the edges of every range (in, at and just past each limit, wrong
types, unknown names, missing keys) on frames and lengths that put the render-time charge on both sides
of the export's allowance. samples/timeline_parity2_fuzz.json holds the documents with
modules/timeline.py's verdict; this test makes them again from the seed (the file must be current) and
command-center/tests/editor-parity2.test.ts judges every one with lib/editor.ts: the two must agree.
Regenerate with ``python3 -m tests.test_editor_parity2_fuzz --write``."""

import json
import random
import sys
import unittest
from pathlib import Path

from modules import timeline as tl

ROOT = Path(__file__).resolve().parent.parent
CORPUS = ROOT / "samples" / "timeline_parity2_fuzz.json"
SEED = 20261111
COUNT = 400
B = "11111111-1111-4111-8111-111111111111"


def _num(rng, lo, hi):
    if rng.random() < 0.85:
        return rng.choice([lo, hi, round(rng.uniform(lo, hi), 3), round(rng.uniform(lo, hi), 3)])
    return rng.choice([round(lo - rng.choice([0.001, 0.5, 10]), 3), round(hi + rng.choice([0.001, 0.5, 10]), 3),
                       "5", None, True, 0])


def _color(rng):
    c = {}
    for k, hi in (("temperature", 100), ("tint", 100), ("hue", 180)):
        if rng.random() < 0.5:
            c[k] = _num(rng, -hi, hi)
    if rng.random() < 0.4:
        c["curve"] = rng.choice(list(tl.COLOR_CURVES) * 2 + ["sepia", "", 3, None])
    if rng.random() < 0.05:
        c["saturation"] = 1
    if rng.random() < 0.05:
        return rng.choice([[], "warm", None])
    return c


def _mask(rng):
    m = {}
    if rng.random() < 0.93:
        m["shape"] = rng.choice(list(tl.MASK_SHAPES) * 6 + ["star", "", None])
    for k, lo, hi in (("x", 0, 1), ("y", 0, 1), ("w", 0.05, 1), ("h", 0.05, 1), ("feather", 0, 0.5)):
        if rng.random() < 0.45:
            m[k] = _num(rng, lo, hi)
    if rng.random() < (0.6 if m.get("shape") == "rounded" else 0.08):
        m["radius"] = _num(rng, 0, 0.5)
    if rng.random() < 0.3:
        m["invert"] = rng.choice([True, False, True, False, 1, "yes"])
    if rng.random() < 0.03:
        m["opacity"] = 1
    return m


def random_doc(rng):
    w, h, fps = rng.choice([(1280, 720, 30), (1920, 1080, 30), (1920, 1080, 60), (3840, 2160, 60), (1080, 1920, 25)])
    clips = []
    start = 0.0
    for i in range(rng.randint(1, 3)):
        length = rng.choice([2.0, 30.0, 120.0, 400.0])
        c = {"id": f"c{i}", "asset_id": B, "start_s": start, "in_s": 0, "out_s": length}
        if rng.random() < 0.75:
            c["color"] = _color(rng)
        if rng.random() < 0.65:
            c["mask"] = _mask(rng)
        if rng.random() < 0.2:
            c["speed"] = rng.choice([2, 4])
        clips.append(c)
        start += length / c.get("speed", 1)
    return {"version": 1, "width": w, "height": h, "fps": fps, "tracks": [{"id": "v1", "kind": "V", "clips": clips}]}


def corpus():
    rng = random.Random(SEED)
    out = []
    for _ in range(COUNT):
        d = random_doc(rng)
        out.append({"valid": tl.validate(d) == [], "doc": d})
    return out


class ParityFuzzTestCase(unittest.TestCase):
    def test_the_corpus_is_current_and_holds_both_verdicts(self):
        stored = json.loads(CORPUS.read_text(encoding="utf-8"))
        self.assertEqual(stored["seed"], SEED)
        self.assertEqual(stored["cases"], corpus(), "regenerate: python3 -m tests.test_editor_parity2_fuzz --write")
        valid = sum(1 for c in stored["cases"] if c["valid"])
        self.assertGreater(valid, COUNT // 5)
        self.assertGreater(COUNT - valid, COUNT // 5)

    def test_the_budget_refuses_some_and_only_with_its_sentence(self):
        budget = 0
        for c in corpus():
            probs = tl.validate(c["doc"])
            if any("colour and masks" in p for p in probs):
                budget += 1
        self.assertGreater(budget, 5)

    def test_every_valid_one_normalises_to_a_valid_one_and_builds_a_spec(self):
        from modules import timeline_render as tr
        from modules import render_spec as rs
        res = lambda a: tl.ResolvedAsset(a, "video", "/m/a.mp4", 1000.0, False)
        for c in corpus():
            if not c["valid"]:
                continue
            n = tl.normalise(c["doc"])
            self.assertEqual(tl.validate(n), [], n)
            self.assertEqual(rs.validate(tr.to_render_spec(c["doc"], res, "/w/o.mp4")), [])


if __name__ == "__main__":
    if "--write" in sys.argv:
        CORPUS.write_text(json.dumps({"_comment": __doc__.split("\n\n")[1].replace("\n", " "), "seed": SEED,
                                      "cases": corpus()}, ensure_ascii=False) + "\n", encoding="utf-8")
        print("written", CORPUS)
    else:
        unittest.main()

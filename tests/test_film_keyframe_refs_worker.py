"""A film key frame's references in the worker (migration 0239, B2 and B5): FilmOrchestrator._inputs puts the film's own references
in front of the style kit's and the @characters' pictures, so those get only the slots the film's references leave, and a take whose
own references are more than the model takes is failed by name before anything else is read or sent.

Before 0239 the style was given every one of the model's slots and the film's references were added on top: one film reference plus
any style kit on a 3-picture model reached RegistryAdapter.submit with 4 pictures and was refused there, after the film's hold. The
quote (film_price, 0239) counts the slots the same way; tests/security/test_sec_film_keyframe_refs_quote_0239.py pins that side.
"""

from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from modules import creative_adapters as ca
from modules import creative_worker as cw
from modules import film_orchestrator as fo
from modules import model_registry as reg
from modules.capabilities import build_adapter
from tests.test_creative_media_inputs import PNG, put_asset
from tests.test_creative_style_inputs import HERO, KIT, R, answer, char, kit
from tests.test_creative_worker import JOB, ORG

LITE = "gemini-3.1-flash-lite-image"  # 3 pictures in all, references on t2i
FILM_REFS = [f"4b1d0000-0000-4000-8000-0000000002{i:02d}" for i in range(6)]


class _Queue:
    def __init__(self, style):
        self.style = style
        self.calls = []

    def job_style(self, job_id, worker_id):
        self.calls.append(job_id)
        return self.style


class _Media:
    """The film's own input copies (FilmMedia.copy_input), as files named the way the orchestrator names them."""

    def copy_input(self, item, dest, name):
        dest.mkdir(parents=True, exist_ok=True)
        p = Path(dest) / f"{name}.png"
        p.write_bytes(PNG + str(item.get("asset_id")).encode())
        return p


class FilmKeyframeReferences(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.media = self.root / "media"
        for r in R:
            put_asset(self.media, r, PNG + r.encode())

    def tearDown(self):
        self.tmp.cleanup()

    def orchestrator(self, style):
        entry = reg.get(LITE)
        adapter = ca.RegistryAdapter(entry, build_adapter(entry.adapter, env={}), sync_store={})
        orch = object.__new__(fo.FilmOrchestrator)
        orch.media = _Media()
        queue = _Queue(style)
        orch.db = type("D", (), {"creative": queue})()
        orch.resolve_adapter = lambda _m: adapter
        orch.worker_id = "w-1"
        orch.media_root = self.media
        return orch, adapter, queue

    def take(self, n_refs, params):
        tj = {"inputs": [{"role": "reference", "asset_id": a} for a in FILM_REFS[:n_refs]]}
        req = cw.GenerationRequest(job_id=JOB, org_id=ORG, capability="t2i", model=LITE, params={"prompt": "@hero at the door", **params})
        return tj, req

    def test_film_references_plus_a_style_kit_never_exceed_the_model_and_go_first(self):
        orch, adapter, _ = self.orchestrator(answer(kit_=kit(description="", refs=(R[0], R[1], R[2]))))
        tj, req = self.take(1, {"style_kit_id": KIT, "prompt": "a lighthouse"})
        out = orch._inputs(req, tj, adapter, self.root / "work")
        limit = reg.get(LITE).image_refs_max
        self.assertEqual(len(out.input_files) + len(out.reference_files), limit)
        # the film's own reference first, then the kit's first two pictures (the third did not fit)
        self.assertEqual([f.read_bytes() for f in out.reference_files],
                         [PNG + FILM_REFS[0].encode(), PNG + R[0].encode(), PNG + R[1].encode()])
        self.assertEqual(out.style["references"], limit - 1)

    def test_film_references_that_fill_the_model_leave_an_undescribed_kit_refused_by_name_not_dropped(self):
        orch, adapter, _ = self.orchestrator(answer(kit_=kit(description="")))
        tj, req = self.take(3, {"style_kit_id": KIT, "prompt": "a lighthouse"})
        with self.assertRaises(fo._TakeFailed) as cm:
            orch._inputs(req, tj, adapter, self.root / "work")
        self.assertEqual(cm.exception.code, "bad_request")
        self.assertIn("the style kit has no description", cm.exception.message)
        self.assertIn("add a description", cm.exception.message)

    def test_a_described_character_with_no_slot_left_is_sent_as_words_only(self):
        orch, adapter, _ = self.orchestrator(answer(characters=[char(HERO, "hero", "red scarf", [R[3]])]))
        tj, req = self.take(3, {})
        out = orch._inputs(req, tj, adapter, self.root / "work")
        self.assertEqual(len(out.reference_files), 3)
        self.assertIn("@hero: red scarf", out.prompt)

    def test_a_take_with_more_film_references_than_the_model_takes_fails_by_name_before_the_style_is_read(self):
        """B5: a character given more pictures after Start. The take never reaches the adapter's submit."""
        orch, adapter, queue = self.orchestrator(answer(kit_=kit()))
        tj, req = self.take(5, {"style_kit_id": KIT})
        with self.assertRaises(fo._TakeFailed) as cm:
            orch._inputs(req, tj, adapter, self.root / "work")
        self.assertEqual(cm.exception.code, "bad_request")
        self.assertIn(f"5 reference pictures and {LITE} takes 3", cm.exception.message)
        self.assertIn("remove some pictures, or choose a key-frame model that takes them all", cm.exception.message)
        self.assertEqual(queue.calls, [])  # nothing else was read

    def test_reserved_slots_only_ever_lower_what_the_style_gets(self):
        style = answer(kit_=kit(description="warm", refs=(R[0], R[1], R[2])))
        worker = cw.CreativeWorker(_Queue(style), lambda _m: None, worker_id="w-1", out_dir=self.root / "w", media_root=self.media)
        entry = reg.get(LITE)
        adapter = ca.RegistryAdapter(entry, build_adapter(entry.adapter, env={}), sync_store={})
        req = cw.GenerationRequest(job_id=JOB, org_id=ORG, capability="t2i", model=LITE, params={"prompt": "x", "style_kit_id": KIT})
        self.assertEqual(len(worker._style(req, adapter).reference_files), 3)
        self.assertEqual(len(worker._style(req, adapter, reserved_slots=2).reference_files), 1)
        self.assertEqual(len(worker._style(req, adapter, reserved_slots=9).reference_files), 0)
        self.assertEqual(len(worker._style(req, adapter, reserved_slots=-4).reference_files), 3)


if __name__ == "__main__":
    unittest.main()

"""An export in another frame (migration 0129), the worker's half: modules/editor_export.py.

One saved edit can be exported in a frame from the closed list (schemas/export_presets.json) instead of the project's own. What
would break without these tests:

  * an export WITHOUT a frame rendering any differently than before (the document object, the provenance, the switch);
  * a frame size reaching ffmpeg that is not our own list's: an id outside the list, a size that is not that id's, a float, a
    string, a negative or huge number, or a row with only some of the three values quietly rendered in the project's frame;
  * a frame row rendered while the switch is off, or the switch read as on by accident;
  * the document judged against the OLD frame (the budgets and memory rules depend on the frame's size);
  * the frame override changing anything but width and height: the rate, a clip's own fit, the texts.

SQL does not run here: the database's half is tests/security/test_sec_editor_export_frame.py and
tests/test_editor_export_frame_migration.py.
"""

from __future__ import annotations

import copy
import json
import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from modules import ass_captions, editor_export, export_presets
from modules import media_library as ml
from modules import timeline as tl

V1 = "11111111-1111-4111-8111-111111111111"
ORG = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
PROJECT = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
EXPORT = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
STORED = "dddddddd-dddd-4ddd-8ddd-dddddddddddd"
PRESETS = export_presets.load()


def doc(**clip):
    c = {"id": "c1", "asset_id": V1, "start_s": 0, "in_s": 2.0, "out_s": 6.0}
    c.update(clip)
    return {"version": 1, "width": 1920, "height": 1080, "fps": 25,
            "tracks": [{"id": "v1", "kind": "V", "clips": [c]},
                       {"id": "t1", "kind": "T", "clips": [{"id": "x1", "start_s": 0, "end_s": 2, "text": "Hello", "size": 64}]}]}


def row(d=None, **over):
    r = {"id": EXPORT, "org_id": ORG, "project_id": PROJECT, "rev": 3, "duration_s": 4,
         "doc": d if d is not None else doc()}
    r.update(over)
    return r


def framed(preset_id: str, **over):
    p = PRESETS[preset_id]
    return row(frame_preset=p.id, frame_width=p.width, frame_height=p.height, **over)


class FakeStore:
    def __init__(self):
        self.finished = []
        self.asked = 0

    def export_assets(self, export_id):
        self.asked += 1
        return [{"id": V1, "kind": "video", "mime": "video/mp4", "duration_s": 20, "variants": []}]

    def export_heartbeat(self, export_id, worker_id):
        return True

    def finish_export(self, export_id, worker_id, asset_id, reason):
        self.finished.append((asset_id, reason))
        return "done" if asset_id else "failed"


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        f = ml.asset_file(self.root, V1, "original")
        f.parent.mkdir(parents=True, exist_ok=True)
        f.write_bytes(b"x")

    def tearDown(self):
        self.tmp.cleanup()

    def run_export(self, export, *, enabled=True):
        store = FakeStore()
        render = mock.Mock(side_effect=lambda d, res, out, **kw: Path(out).write_bytes(b"mp4") or out)
        store_file = mock.Mock(return_value={"id": STORED})
        status = editor_export.run_export(export, store=store, media_root=self.root, worker_id="w1",
                                          tools=ml.Tools("ffprobe", "ffmpeg"), render=render, store_file=store_file,
                                          has_audio=lambda path, mime: True, heartbeat_s=0.01, frames_enabled=enabled)
        return status, store, render, store_file

    def assert_refused(self, export, reason, *, enabled=True):
        status, store, render, store_file = self.run_export(export, enabled=enabled)
        self.assertEqual((status, store.finished), ("failed", [(None, reason)]), export)
        render.assert_not_called()
        store_file.assert_not_called()
        # Refused before the database is asked which files the export may read, and before any folder is made.
        self.assertEqual(store.asked, 0)
        self.assertFalse((self.root / editor_export.WORK_DIRNAME).exists())


class AnExportWithoutAFrameIsWhatItWas(Base):
    def test_no_frame_means_no_override_whatever_the_switch_says(self):
        for export in (row(), row(frame_preset=None, frame_width=None, frame_height=None)):
            for enabled in (False, True):
                self.assertIsNone(editor_export.frame_override(export, enabled=enabled))

    def test_the_document_given_to_the_validator_is_the_rows_own_object(self):
        d = doc()
        self.assertIs(editor_export.framed_doc(d, None), d)
        self.assertEqual(editor_export.framed_doc("{}", None), "{}")
        self.assertEqual(editor_export.framed_doc(None, None), {})
        self.assertEqual(editor_export.framed_doc(7, None), {})

    def test_it_renders_the_projects_frame_and_writes_the_same_provenance_with_the_switch_off_or_on(self):
        for enabled in (False, True):
            status, store, render, store_file = self.run_export(row(), enabled=enabled)
            self.assertEqual(status, "done")
            norm = render.call_args.args[0]
            self.assertEqual((norm["width"], norm["height"], norm["fps"]), (1920, 1080, 25))
            self.assertEqual(store_file.call_args.kwargs["provenance"],
                             {"tool": "editor", "editor_project": PROJECT, "editor_export": EXPORT, "rev": 3})

    def test_the_default_of_run_export_is_off(self):
        # A caller that never heard of frames (tools/editor_export_cost.py) refuses a frame row instead of rendering the project's frame.
        store = FakeStore()
        render = mock.Mock()
        status = editor_export.run_export(framed("vertical_1080p"), store=store, media_root=self.root, worker_id="w1",
                                          tools=ml.Tools("ffprobe", "ffmpeg"), render=render, heartbeat_s=0.01)
        self.assertEqual((status, store.finished), ("failed", [(None, "frame_off")]))
        render.assert_not_called()


class TheFrameIsRendered(Base):
    def test_every_format_of_the_list_is_rendered_in_exactly_its_size(self):
        self.assertEqual(sorted(PRESETS), sorted(["youtube_1080p", "youtube_720p", "vertical_1080p", "square_1080", "feed_4x5_1080"]))
        for p in PRESETS.values():
            status, store, render, store_file = self.run_export(framed(p.id))
            self.assertEqual(status, "done", p.id)
            norm = render.call_args.args[0]
            self.assertEqual((norm["width"], norm["height"]), (p.width, p.height), p.id)
            self.assertEqual(store_file.call_args.kwargs["provenance"]["frame"], p.id)
            self.assertEqual(store.finished, [(STORED, None)])

    def test_only_width_and_height_change(self):
        d = doc(fit="cover", speed=1.5)
        plain = self.run_export(row(copy.deepcopy(d)))[2].call_args.args[0]
        other = self.run_export(framed("vertical_1080p", doc=copy.deepcopy(d)))[2].call_args.args[0]
        self.assertEqual((other["width"], other["height"]), (1080, 1920))
        # The rate is the PROJECT's (25), not the format's 30: an export in another frame is never a frame-rate conversion.
        self.assertEqual(other["fps"], 25)
        for norm in (plain, other):
            norm.pop("width"), norm.pop("height")
        self.assertEqual(other, plain)

    def test_a_clip_keeps_its_own_fit_and_the_default_is_contain_never_a_crop(self):
        for fit, expect in ((None, "contain"), ("contain", "contain"), ("cover", "cover"), ("blur", "blur")):
            d = doc(**({"fit": fit} if fit else {}))
            norm = self.run_export(framed("square_1080", doc=d))[2].call_args.args[0]
            self.assertEqual(norm["tracks"][0]["clips"][0]["fit"], expect)

    def test_the_claimed_row_is_not_edited(self):
        d = doc()
        export = framed("vertical_1080p", doc=d)
        before = copy.deepcopy(export)
        out = editor_export.framed_doc(d, PRESETS["vertical_1080p"])
        self.assertIsNot(out, d)
        self.assertEqual((out["width"], out["height"], d["width"], d["height"]), (1080, 1920, 1920, 1080))
        self.run_export(export)
        self.assertEqual(export, before)

    def test_the_document_is_judged_against_the_new_frame(self):
        # Backwards play holds every frame in memory, so how long it may be depends on the frame's size (timeline.reverse_max_seconds).
        small, big = tl.reverse_max_seconds(320, 180, 25), tl.reverse_max_seconds(1080, 1920, 25)
        self.assertLess(big, small)
        length = round(min(small, 18.0) if small < 18 else 18.0, 1)
        self.assertGreater(length, big)
        d = doc(in_s=0, out_s=length, reverse=True)
        d["width"], d["height"] = 320, 180
        self.assertEqual(tl.validate(d), [])            # fine in the project's own frame
        self.assertEqual(self.run_export(row(d, duration_s=length))[0], "done")
        status, store, render, _ = self.run_export(framed("vertical_1080p", doc=d, duration_s=length))
        self.assertEqual((status, store.finished), ("failed", [(None, "invalid_timeline")]))
        render.assert_not_called()

    def test_the_decode_budget_is_the_new_frames(self):
        d = doc()
        d["width"], d["height"] = 320, 180
        work_small = ml.decode_work(320, 180, 25, 4)
        work_big = ml.decode_work(1080, 1920, 25, 4)
        # (The list itself is checked against the real budget when it is read, so it is read before the budget is lowered.)
        with mock.patch.object(export_presets, "load", return_value=PRESETS), \
                mock.patch.object(ml, "DECODE_BUDGET_PX", (work_small + work_big) / 2):
            self.assertEqual(self.run_export(row(copy.deepcopy(d)))[0], "done")
            status, store, render, _ = self.run_export(framed("vertical_1080p", doc=copy.deepcopy(d)))
        self.assertEqual((status, store.finished), ("failed", [(None, "too_long")]))
        render.assert_not_called()

    def test_a_document_that_is_text_is_not_reparsed_for_a_frame(self):
        self.assert_refused(framed("square_1080", doc=json.dumps(doc())), "invalid_timeline")
        self.assert_refused(framed("square_1080", doc=None), "invalid_timeline")


class AFrameOutsideTheListIsRefused(Base):
    def test_an_id_that_is_not_on_the_list(self):
        for bad in ("vertical_4k", " vertical_1080p", "vertical_1080p ", "VERTICAL_1080P", "Vertical_1080p", "1080x1920", "9:16",
                    "project", "", "vertical_1080p\n", "vertical_1080p'; drop table editor_exports; --", 5, 1080, True, 1.5,
                    ["vertical_1080p"], {"id": "vertical_1080p"}, b"vertical_1080p"):
            self.assert_refused(row(frame_preset=bad, frame_width=1080, frame_height=1920), "invalid_frame")

    def test_a_size_that_is_not_that_ids(self):
        for w, h in ((1920, 1080), (1920, 1920), (1080, 1921), (1081, 1920), (1079, 1919), (2160, 3840), (8192, 8192),
                     (1080000, 1920000), (0, 0), (0, 1920), (1080, 0), (-1080, -1920), (-1080, 1920), (1080.0, 1920.0),
                     (1080.5, 1920), ("1080", "1920"), ("1080", 1920), (True, True), ([1080], [1920]), (float("nan"), 1920),
                     (float("inf"), 1920), (540, 960), (16, 16)):
            self.assert_refused(row(frame_preset="vertical_1080p", frame_width=w, frame_height=h), "invalid_frame")

    def test_another_entrys_size_under_this_id(self):
        # Both are on the list, but not together: the three values must be ONE entry.
        self.assert_refused(row(frame_preset="square_1080", frame_width=1080, frame_height=1920), "invalid_frame")
        self.assert_refused(row(frame_preset="youtube_720p", frame_width=1920, frame_height=1080), "invalid_frame")

    def test_only_some_of_the_three_values_is_never_the_projects_frame(self):
        for partial in ({"frame_preset": "vertical_1080p"},
                        {"frame_preset": "vertical_1080p", "frame_width": 1080},
                        {"frame_preset": "vertical_1080p", "frame_height": 1920},
                        {"frame_width": 1080, "frame_height": 1920},
                        {"frame_width": 1080},
                        {"frame_height": 1920},
                        {"frame_preset": None, "frame_width": 1080, "frame_height": 1920},
                        {"frame_preset": "vertical_1080p", "frame_width": None, "frame_height": None}):
            self.assert_refused(row(**partial), "invalid_frame")

    def test_the_list_is_the_files_not_the_rows(self):
        # A list that does not hold the id refuses it, even when the row's three values agree with each other.
        only_square = {"square_1080": PRESETS["square_1080"]}
        with self.assertRaises(editor_export.ExportFailed) as e:
            editor_export.frame_override(framed("vertical_1080p"), enabled=True, presets=only_square)
        self.assertEqual(e.exception.reason, "invalid_frame")
        self.assertEqual(editor_export.frame_override(framed("square_1080"), enabled=True, presets=only_square).id, "square_1080")

    def test_a_list_that_cannot_be_read_renders_nothing(self):
        with mock.patch.object(export_presets, "load", side_effect=export_presets.PresetDataError("broken")):
            self.assert_refused(framed("vertical_1080p"), "invalid_frame")
            # And an export without a frame does not need the list at all.
            self.assertEqual(self.run_export(row())[0], "done")

    def test_the_two_words_are_reasons_the_database_and_the_page_accept(self):
        for word in ("invalid_frame", "frame_off"):
            self.assertIn(word, editor_export.REASONS)
            self.assertRegex(word, r"^[a-z0-9_]{1,64}$")     # editor_exports.reason's check (0054)
            self.assertEqual(editor_export.ExportFailed(word).reason, word)


class TheSwitch(Base):
    def test_off_refuses_a_frame_row_before_it_looks_at_the_list(self):
        self.assert_refused(framed("vertical_1080p"), "frame_off", enabled=False)
        self.assert_refused(row(frame_preset="nonsense", frame_width=1, frame_height=1), "frame_off", enabled=False)

    def test_only_the_four_words_turn_it_on(self):
        self.assertEqual(editor_export.FRAME_FLAG, "NIGHTSHIFT_MULTI_RATIO_EXPORT")
        for on in ("on", "1", "true", "yes", " ON ", "True", "YES"):
            self.assertTrue(editor_export.multi_ratio_enabled({editor_export.FRAME_FLAG: on}), on)
        for off in ("", "0", "off", "false", "no", "enabled", "2", "onn", " "):
            self.assertFalse(editor_export.multi_ratio_enabled({editor_export.FRAME_FLAG: off}), off)
        self.assertFalse(editor_export.multi_ratio_enabled({}))
        self.assertFalse(editor_export.multi_ratio_enabled({"NIGHTSHIFT_MULTI_RATIO": "on"}))

    def service(self, **kw):
        store = mock.Mock()
        store.claim_export.return_value = framed("square_1080")
        return editor_export.ExportService(store, media_root=self.root, worker_id="w1", tools=ml.Tools("ffprobe", "ffmpeg"), **kw)

    def test_the_service_reads_its_own_process_and_is_off_by_default(self):
        with mock.patch.dict(os.environ, {}, clear=False):
            os.environ.pop(editor_export.FRAME_FLAG, None)
            self.assertFalse(self.service().frames_enabled)
            os.environ[editor_export.FRAME_FLAG] = "on"
            self.assertTrue(self.service().frames_enabled)
            os.environ[editor_export.FRAME_FLAG] = "off"
            self.assertFalse(self.service().frames_enabled)
            self.assertTrue(self.service(frames_enabled=True).frames_enabled)

    def test_the_service_hands_its_switch_to_every_export(self):
        for enabled in (False, True):
            svc = self.service(frames_enabled=enabled)
            with mock.patch.object(editor_export, "run_export") as run:
                self.assertTrue(svc.run_once())
            self.assertIs(run.call_args.kwargs["frames_enabled"], enabled)


def _ffmpeg_ok() -> bool:
    exe = shutil.which("ffmpeg")
    try:
        return bool(exe and shutil.which("ffprobe")) and ass_captions.has_libass(exe)
    except OSError:
        return False


@unittest.skipUnless(_ffmpeg_ok(), "ffmpeg / ffprobe with libass not available")
class ARealRenderInAnotherFrame(unittest.TestCase):
    """The whole worker path with the real ffmpeg: a 16:9 source of a 16:9 project, exported 9:16."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        src = ml.asset_file(self.root, V1, "original")
        src.parent.mkdir(parents=True)
        subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc=s=160x90:r=25:d=3",
                        "-c:v", "libx264", "-pix_fmt", "yuv420p", "-f", "mp4", str(src)], check=True)

    def tearDown(self):
        self.tmp.cleanup()

    def probe(self, path: Path):
        out = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-count_frames", "-show_entries",
                              "stream=width,height,nb_read_frames,r_frame_rate", "-of", "json", str(path)],
                             capture_output=True, text=True).stdout
        s = json.loads(out)["streams"][0]
        return s["width"], s["height"], int(s["nb_read_frames"]), s["r_frame_rate"]

    def test_the_file_has_the_frames_size_the_projects_rate_and_bars_not_a_crop(self):
        registered = []

        class Store(FakeStore):
            def register(self, **kw):
                registered.append(kw)
                return {"id": kw["asset_id"], "storage_key": ml.storage_key(kw["asset_id"])}

        d = {"version": 1, "width": 320, "height": 180, "fps": 25,
             "tracks": [{"id": "v1", "kind": "V", "clips": [{"id": "c1", "asset_id": V1, "start_s": 0, "in_s": 0.0, "out_s": 0.4}]}]}
        store = Store()
        status = editor_export.run_export(framed("vertical_1080p", doc=d, duration_s=0.4), store=store, media_root=self.root,
                                          worker_id="w1", tools=ml.Tools("ffprobe", "ffmpeg"), frames_enabled=True)
        self.assertEqual(status, "done", store.finished)
        reg = registered[0]
        stored = ml.asset_file(self.root, reg["asset_id"], "original")
        self.assertEqual(self.probe(stored), (1080, 1920, 10, "25/1"))
        self.assertEqual((reg["width"], reg["height"]), (1080, 1920))
        self.assertEqual(reg["provenance"]["frame"], "vertical_1080p")
        # contain: the 16:9 picture is whole in the middle, so the top of the 9:16 frame is black bars, and the middle is not.
        def mean_luma(crop: str) -> float:
            out = subprocess.run(["ffmpeg", "-v", "error", "-i", str(stored), "-frames:v", "1", "-vf",
                                  f"crop={crop},scale=1:1,format=gray", "-f", "rawvideo", "-"], capture_output=True).stdout
            return float(out[0])
        self.assertLess(mean_luma("1080:200:0:0"), 30)
        self.assertGreater(mean_luma("1080:200:0:860"), 60)


if __name__ == "__main__":
    unittest.main()

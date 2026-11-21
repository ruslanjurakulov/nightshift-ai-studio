"""Denial-of-service and poison-job hardening of the editor's backend half.

What would break without these:

* A caption track of 5000 cues on one span has 12.5 million overlapping
  pairs; ``validate`` used to list every one (4-9 s and over a gigabyte).
  It now stops one past the 20 it reports.
* A picture clip with ``out_s`` of 1e308 raised OverflowError out of
  ``round(length * fps)`` and out of ``tl.load``; ``run_export`` caught only
  ExportFailed, so the export stayed "rendering" with no heartbeat until its
  lease ran out, three times (about 45 minutes holding an export slot).
* A document holding an integer of more than 4300 digits made the whole
  ``claim_editor_export`` response unparseable (Python's int limit), so the
  export was claimed and never worked on.
* ``$`` matched before a trailing newline (an id "c1\\n"), and ``True`` /
  ``1.0`` equalled the version 1.
* Timeline commands now whitelist the ``file`` protocol on every input.
"""

from __future__ import annotations

import json
import logging
import subprocess
import tempfile
import time
import tracemalloc
import unittest
from pathlib import Path
from unittest import mock

import requests

from modules import editor_export, media_library as ml, render_backend
from modules import render_spec as rs
from modules import timeline as tl
from modules import timeline_render as tr

V1 = "11111111-1111-4111-8111-111111111111"
IMG = "22222222-2222-4222-8222-222222222222"
V2 = "33333333-3333-4333-8333-333333333333"
MU = "44444444-4444-4444-8444-444444444444"
ORG = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
PROJECT = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
EXPORT = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"


def clip_doc(**clip):
    c = {"id": "c1", "asset_id": V1, "start_s": 0, "in_s": 0.0, "out_s": 4.0}
    c.update(clip)
    return {"version": 1, "width": 1280, "height": 720, "fps": 30,
            "tracks": [{"id": "v1", "kind": "V", "clips": [c]}]}


def cue_doc(n, start=0, end=5):
    d = tl.new_timeline()
    d["captions"] = {"cues": [{"id": f"c{i}", "start_s": start, "end_s": end, "text": "x"}
                              for i in range(n)]}
    return d


# ── M1: the overlap search stops ────────────────────────────────────────────


class OverlapLimitTestCase(unittest.TestCase):
    def test_5000_cues_on_one_span_are_checked_in_milliseconds_and_megabytes(self):
        d = cue_doc(5000)
        self.assertGreater(len(json.dumps(d)), 200_000)       # a document the web route accepts
        tracemalloc.start()
        try:
            t0 = time.perf_counter()
            problems = tl.validate(d)
            took = time.perf_counter() - t0
            _cur, peak = tracemalloc.get_traced_memory()
        finally:
            tracemalloc.stop()
        self.assertLess(took, 2.0)               # was 4-9 s
        self.assertLess(peak, 64 * 1024 * 1024)  # was about 1 GB
        # The first 20 are exactly what they always were; then one line, not a count.
        ids = sorted(f"c{i}" for i in range(5000))
        want = [f"track 'captions': clips 'c0' and {other!r} overlap (0.000-5.000 s) — "
                "move one to another track" for other in ids[1:21]]
        self.assertEqual(problems[:20], want)
        self.assertEqual(problems[20:], ["... and more overlaps"])

    def test_2000_overlapping_clips_on_the_picture_track(self):
        d = clip_doc()
        d["tracks"][0]["clips"] = [{"id": f"c{i}", "asset_id": V1, "start_s": 0, "in_s": 0, "out_s": 4}
                                   for i in range(tl.MAX_CLIPS_PER_TRACK)]
        t0 = time.perf_counter()
        problems = tl.validate(d)
        self.assertLess(time.perf_counter() - t0, 2.0)
        self.assertEqual(len(problems), 21)
        self.assertIn("clips 'c0' and 'c1' overlap", problems[0])

    def test_up_to_twenty_overlaps_are_all_listed_and_nothing_more_is_said(self):
        # n cues on one span make n(n-1)/2 pairs.
        for n, pairs in ((2, 1), (3, 3), (6, 15)):
            problems = tl.validate(cue_doc(n))
            self.assertEqual(len(problems), pairs, n)
            self.assertFalse(any("more overlaps" in p for p in problems))

    def test_one_past_the_limit_says_there_are_more(self):
        problems = tl.validate(cue_doc(7))          # 21 pairs
        self.assertEqual(len(problems), 21)
        self.assertEqual(problems[-1], "... and more overlaps")

    def test_the_limit_keeps_the_first_pairs_in_the_usual_order(self):
        d = cue_doc(60)
        full = tl.overlaps(d)
        self.assertEqual(len(full), 60 * 59 // 2)
        for limit in (1, 5, 21):
            self.assertEqual(tl.overlaps(d, limit=limit), full[:limit])

    def test_crossfaded_neighbours_are_still_not_overlaps_under_the_limit(self):
        d = clip_doc(out_s=2.0)
        d["tracks"][0]["clips"].append({"id": "c2", "asset_id": V1, "start_s": 1.5, "in_s": 0, "out_s": 2.0,
                                        "transition": {"type": "crossfade", "duration_s": 0.5}})
        self.assertEqual(tl.validate(d), [])
        self.assertEqual(tl.overlaps(tl.load(d), limit=21), [])


# ── M2: nothing a document says can crash the maths ─────────────────────────


HUGE = (1e308, 10 ** 308, 10 ** 400, -1e308, 10 ** 5000)


class OverflowSafeTestCase(unittest.TestCase):
    def test_out_s_of_1e308_is_a_problem_not_an_overflow(self):
        d = clip_doc(out_s=1e308, end_s=1)
        problems = tl.validate(d)               # raised OverflowError
        self.assertTrue(any("out_s must be a number" in p for p in problems), problems)
        self.assertTrue(any("end_s is not a known field" in p for p in problems), problems)
        with self.assertRaises(tl.TimelineError):
            tl.load(d)

    def test_every_time_field_survives_every_huge_number(self):
        for value in HUGE:
            for field in ("start_s", "in_s", "out_s", "fade_in_s", "fade_out_s", "speed"):
                with self.subTest(field=field, digits=len(HUGE) and HUGE.index(value)):
                    problems = tl.validate(clip_doc(**{field: value}))
                    self.assertTrue(problems)
                    self.assertTrue(all(isinstance(p, str) for p in problems))
            for place in ("width", "height", "fps", "version"):
                d = clip_doc()
                d[place] = value
                self.assertTrue(tl.validate(d), place)
            d = cue_doc(1)
            d["captions"]["cues"][0]["end_s"] = value
            self.assertTrue(tl.validate(d))
            d = clip_doc()
            d["tracks"].append({"id": "t1", "kind": "T", "clips": [
                {"id": "x", "start_s": 0, "end_s": 2, "text": "hi", "fade_in_s": value, "size": value}]})
            self.assertTrue(tl.validate(d))

    def test_a_5000_digit_integer_where_an_id_goes_is_a_problem_with_a_readable_message(self):
        big = 10 ** 5000
        for build in (lambda: clip_doc(id=big), lambda: clip_doc(asset_id=big),
                      lambda: {**clip_doc(), "tracks": [{"id": big, "kind": "V", "clips": []}]},
                      lambda: {**cue_doc(1), "captions": {"cues": [
                          {"id": big, "start_s": 0, "end_s": 1, "text": "x"}]}}):
            problems = tl.validate(build())
            self.assertTrue(problems)
            self.assertTrue(all(len(p) < 400 for p in problems), problems)

    def test_a_5000_digit_integer_in_an_unknown_field_is_a_problem(self):
        problems = tl.validate(clip_doc(extra=10 ** 5000))
        self.assertEqual(problems, ["track 'v1' clip 'c1': extra is not a known field"])

    def test_a_document_as_text_with_a_5000_digit_integer_is_refused_not_raised(self):
        text = '{"version": 1, "extra": ' + "9" * 5000 + "}"
        with self.assertRaises(tl.TimelineError):
            tl.load(text)


class PoisonExportTestCase(unittest.TestCase):
    """run_export turns what the validator did not foresee into a failed export."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        f = ml.asset_file(self.root, V1, "original")
        f.parent.mkdir(parents=True)
        f.write_bytes(b"x")

    def store(self):
        class Store:
            def __init__(s):
                s.finished, s.beats = [], 0

            def export_assets(s, eid):
                return [{"id": V1, "kind": "video", "mime": "video/mp4", "duration_s": 20, "variants": []}]

            def export_heartbeat(s, *a):
                s.beats += 1
                return True

            def finish_export(s, eid, worker, asset_id, reason):
                s.finished.append((eid, worker, asset_id, reason))
                return "done" if asset_id else "failed"

        return Store()

    def run_export(self, doc, store=None, render=None, **kw):
        store = store or self.store()
        render = render or mock.Mock()
        row = {"id": EXPORT, "org_id": ORG, "project_id": PROJECT, "rev": 1, "duration_s": 4, "doc": doc}
        status = editor_export.run_export(row, store=store, media_root=self.root, worker_id="w1",
                                          tools=ml.Tools("ffprobe", "ffmpeg"), render=render,
                                          has_audio=lambda p, m: False, heartbeat_s=0.01, **kw)
        return status, store, render

    def test_out_s_1e308_with_end_s_1_fails_at_once_with_a_reason(self):
        status, store, render = self.run_export(clip_doc(out_s=1e308, end_s=1))
        self.assertEqual(status, "failed")
        self.assertEqual(store.finished, [(EXPORT, "w1", None, "invalid_timeline")])
        render.assert_not_called()

    def test_whatever_load_raises_is_an_invalid_timeline_and_is_logged_by_type(self):
        for exc in (OverflowError("secret-a"), RecursionError("secret-b"), ZeroDivisionError("x"), KeyError("k")):
            with self.subTest(type(exc).__name__):
                with mock.patch.object(tl, "load", side_effect=exc), \
                        self.assertLogs("modules.editor_export", level=logging.WARNING) as logs:
                    status, store, render = self.run_export(clip_doc())
                self.assertEqual(store.finished[-1][2:], (None, "invalid_timeline"))
                render.assert_not_called()
                self.assertTrue(any(type(exc).__name__ in line for line in logs.output), logs.output)
                self.assertFalse(any("secret" in line for line in logs.output))

    def test_whatever_the_layout_raises_is_an_invalid_timeline(self):
        with mock.patch.object(tr, "to_render_spec", side_effect=OverflowError("x")), \
                self.assertLogs("modules.editor_export", level=logging.WARNING):
            status, store, render = self.run_export(clip_doc())
        self.assertEqual(status, "failed")
        self.assertEqual(store.finished[-1][2:], (None, "invalid_timeline"))
        render.assert_not_called()
        self.assertFalse((self.root / editor_export.WORK_DIRNAME / EXPORT).exists())

    def test_a_database_outage_still_propagates(self):
        # The export is handed out again once its heartbeat goes stale: not a failed document.
        store = self.store()
        store.export_assets = mock.Mock(side_effect=RuntimeError("db down"))
        with self.assertRaises(RuntimeError):
            self.run_export(clip_doc(), store=store)
        self.assertEqual(store.finished, [])

    def test_the_heartbeat_runs_during_validation_not_only_during_the_render(self):
        store = self.store()
        real_load = tl.load

        def slow_load(doc):
            time.sleep(0.15)               # heartbeat_s is 0.01 in these tests
            return real_load(doc)

        with mock.patch.object(tl, "load", side_effect=slow_load):
            self.run_export(
                clip_doc(), store=store,
                render=mock.Mock(side_effect=lambda d, res, out, **kw: Path(out).write_bytes(b"mp4") or out),
                store_file=mock.Mock(return_value={"id": "dddddddd-dddd-4ddd-8ddd-dddddddddddd"}))
        self.assertGreater(store.beats, 2)


def _response(body: str) -> requests.Response:
    r = requests.Response()
    r.status_code = 200
    r._content = body.encode()
    r.encoding = "utf-8"
    return r


class BigIntegerClaimTestCase(unittest.TestCase):
    """A stored document with a 5000-digit integer must fail its export, not strand it."""

    @staticmethod
    def big_claim():
        return ('[{"id": "%s", "org_id": "%s", "project_id": "%s", "rev": 1, "duration_s": 4, '
                '"doc": {"version": 1, "width": 1280, "height": 720, "fps": 30, "extra": %s, '
                '"tracks": [{"id": "v1", "kind": "V", "clips": []}]}}]' % (EXPORT, ORG, PROJECT, "7" * 5000))

    def test_the_stock_parser_really_cannot_read_it(self):
        with self.assertRaises(ValueError):
            _response(self.big_claim()).json()

    def test_the_claim_reads_it_and_the_big_integer_is_not_a_usable_number(self):
        class Session:
            def post(s, *a, **k):
                return _response(BigIntegerClaimTestCase.big_claim())

        export = ml.MediaStore("http://db.test", "key", session=Session()).claim_export("w1")
        self.assertEqual(export["id"], EXPORT)
        self.assertEqual(export["doc"]["extra"], float("inf"))
        self.assertTrue(tl.validate(export["doc"]))

    def test_the_export_is_claimed_then_failed_with_a_reason_word(self):
        calls = []

        class Session:
            def post(s, url, json=None, headers=None, timeout=None):
                name = url.rsplit("/", 1)[-1]
                calls.append((name, json))
                if name == "claim_editor_export":
                    return _response(BigIntegerClaimTestCase.big_claim())
                if name == "finish_editor_export":
                    return _response('"failed"')
                return _response("[]")

        store = ml.MediaStore("http://db.test", "key", session=Session())
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        service = editor_export.ExportService(store, media_root=Path(tmp.name), worker_id="w1",
                                              tools=ml.Tools("ffprobe", "ffmpeg"))
        self.assertTrue(service.run_once())
        finish = [c for c in calls if c[0] == "finish_editor_export"]
        self.assertEqual(len(finish), 1)
        self.assertEqual((finish[0][1]["p_export"], finish[0][1]["p_reason"], finish[0][1]["p_asset"]),
                         (EXPORT, "invalid_timeline", None))

    def test_ordinary_responses_and_real_errors_are_unchanged(self):
        class Session:
            def __init__(s, resp):
                s.resp = resp

            def post(s, *a, **k):
                return s.resp

        ok = ml.MediaStore("http://db.test", "key", session=Session(_response('[{"n": 12345, "f": 1.5}]')))
        self.assertEqual(ok._rpc("x", {}), [{"n": 12345, "f": 1.5}])
        junk = ml.MediaStore("http://db.test", "key", session=Session(_response("<html>")))
        with self.assertRaises(RuntimeError):
            junk._rpc("x", {})


# ── L1: the two validators say the same thing ───────────────────────────────


class StrictFieldsTestCase(unittest.TestCase):
    def test_an_id_with_a_trailing_newline_is_refused_everywhere_ids_are_checked(self):
        self.assertTrue(any("id must be 1-64" in p for p in tl.validate(clip_doc(id="c1\n"))))
        d = clip_doc()
        d["tracks"][0]["id"] = "v1\n"
        self.assertTrue(any("id must be 1-64" in p for p in tl.validate(d)))
        d = cue_doc(1)
        d["captions"]["cues"][0]["id"] = "c0\n"
        self.assertTrue(any("id must be 1-64" in p for p in tl.validate(d)))

    def test_a_uuid_and_a_colour_with_a_trailing_newline_are_refused(self):
        self.assertTrue(any("asset_id must be a uuid" in p for p in tl.validate(clip_doc(asset_id=V1 + "\n"))))
        d = clip_doc()
        d["tracks"].append({"id": "t1", "kind": "T", "clips": [
            {"id": "x", "start_s": 0, "end_s": 2, "text": "hi", "color": "#FFFFFF\n"}]})
        self.assertTrue(any("color must be a #RRGGBB" in p for p in tl.validate(d)))

    def test_the_version_is_the_integer_one(self):
        for bad in (True, 1.0, "1", None, [1], 2, 0, False):
            with self.subTest(bad=bad):
                d = clip_doc()
                d["version"] = bad
                self.assertTrue(any("version must be 1" in p for p in tl.validate(d)), bad)
        self.assertEqual(tl.validate(clip_doc()), [])
        # From text, "1.0" parses to a float (the web twin cannot tell it from 1, so this case
        # is not in the shared file).
        text = json.dumps(clip_doc()).replace('"version": 1,', '"version": 1.0,')
        with self.assertRaises(tl.TimelineError):
            tl.load(text)


# ── H1: ffmpeg may open files and nothing else ──────────────────────────────


def _input_options(argv):
    """The options in front of each ``-i`` of one command (back to the previous input)."""
    out, start = [], 1
    for i, tok in enumerate(argv):
        if tok == "-i":
            out.append(argv[start:i])
            start = i + 2
    return out


def _whitelist(opts):
    return opts[opts.index("-protocol_whitelist") + 1]


class ProtocolWhitelistTestCase(unittest.TestCase):
    def test_every_input_of_a_timeline_segment_command_whitelists_the_file_protocol(self):
        a = rs.Segment(duration=2.0, path="/m/a.mp4", kind=rs.KIND_VIDEO, in_s=1.0, clip_s=4.0,
                       xfade=rs.Segment(duration=1.0, path="/m/b.mp4", kind=rs.KIND_VIDEO, clip_s=2.0))
        still = rs.Segment(duration=1.0, path="/m/i.png", kind=rs.KIND_IMAGE, clip_s=1.0)
        black = rs.Segment(duration=1.0, path="", kind=rs.KIND_COLOR)
        mixed = rs.Segment(duration=1.0, path="/m/a.mp4", kind=rs.KIND_VIDEO, clip_s=2.0,
                           xfade=rs.Segment(duration=1.0, path="/m/i.png", kind=rs.KIND_IMAGE, clip_s=1.0))
        cmds = []
        for seg in (a, still, black, mixed):
            cmds += render_backend.segment_commands("ffmpeg", seg, Path("/w/o.mp4"), 1280, 720, 30,
                                                    seed="s", frame_exact=True)
        self.assertGreaterEqual(len(cmds), 6)       # the still and the mixed cross-fade have two each
        inputs = 0
        for argv in cmds:
            for opts in _input_options(argv):
                inputs += 1
                self.assertEqual(_whitelist(opts), "file", argv)
        self.assertGreaterEqual(inputs, 9)

    def test_the_final_pass_and_the_music_inputs_whitelist_it_too(self):
        d = tl.load({"version": 1, "width": 128, "height": 72, "fps": 25, "tracks": [
            {"id": "v1", "kind": "V", "clips": [
                {"id": "c1", "asset_id": V1, "start_s": 0, "in_s": 0, "out_s": 2, "audio": True}]},
            {"id": "a1", "kind": "A", "clips": [
                {"id": "m1", "asset_id": MU, "start_s": 0, "in_s": 0, "out_s": 2}]}]})
        assets = {V1: tl.ResolvedAsset(V1, "video", "/m/v.mp4", 6.0, True),
                  MU: tl.ResolvedAsset(MU, "audio", "/m/m.mp3", 10.0)}
        argv = rs.build_ffmpeg_command(tr.to_render_spec(d, assets.get, "/o/out.mp4"), "/w/concat.txt")
        options = _input_options(argv)
        self.assertEqual(len(options), 3)           # the segment list, the clip's sound, the music
        for opts in options:
            self.assertEqual(_whitelist(opts), "file", argv)

    def test_the_pipelines_own_commands_are_left_byte_for_byte_alone(self):
        seg = rs.Segment(duration=2.0, path="/m/a.mp4", kind=rs.KIND_VIDEO)
        for argv in render_backend.segment_commands("ffmpeg", seg, Path("/w/o.mp4"), 1280, 720, 30):
            self.assertNotIn("-protocol_whitelist", argv)
        spec = rs.RenderSpec(output_path="/o/out.mp4", segments=[seg])
        self.assertNotIn("-protocol_whitelist", rs.build_ffmpeg_command(spec, "/w/concat.txt"))


def _ffmpeg():
    exe = render_backend.resolve_ffmpeg()
    try:
        out = subprocess.run([exe, "-hide_banner", "-filters"], capture_output=True, text=True).stdout
    except OSError:
        return None
    return exe if (" xfade " in out and " acrossfade " in out) else None


@unittest.skipUnless(_ffmpeg(), "ffmpeg with xfade / acrossfade not available")
class RealWhitelistedRenderTestCase(unittest.TestCase):
    """The real ffmpeg, with the whitelist, still renders a video, a still and a cross-fade."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        d = self.dir = Path(self.tmp.name)
        f = self.ffmpeg = _ffmpeg()
        for name, colour in (("a.mp4", "red"), ("b.mp4", "blue")):
            render_backend._run([f, "-y", "-f", "lavfi", "-i", f"color=c={colour}:s=96x64:r=30:d=4",
                                 "-f", "lavfi", "-i", "sine=frequency=440:duration=4", "-shortest",
                                 "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", str(d / name)])
        render_backend._run([f, "-y", "-f", "lavfi", "-i", "color=c=0x00FF00:s=64x48", "-frames:v", "1",
                             str(d / "g.png")])
        render_backend._run([f, "-y", "-f", "lavfi", "-i", "sine=frequency=220:duration=6",
                             "-c:a", "pcm_s16le", str(d / "m.wav")])
        self.assets = {
            V1: tl.ResolvedAsset(V1, "video", str(d / "a.mp4"), 4.0, True),
            V2: tl.ResolvedAsset(V2, "video", str(d / "b.mp4"), 4.0, True),
            IMG: tl.ResolvedAsset(IMG, "image", str(d / "g.png"), None),
            MU: tl.ResolvedAsset(MU, "audio", str(d / "m.wav"), 6.0),
        }

    def frames(self, path):
        raw = subprocess.run([self.ffmpeg, "-hide_banner", "-loglevel", "error", "-i", str(path),
                              "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], capture_output=True).stdout
        return len(raw) // (96 * 64 * 3)

    def test_a_video_a_still_and_a_cross_fade_with_music_render_to_their_frames(self):
        doc = {"version": 1, "width": 96, "height": 64, "fps": 30, "tracks": [
            {"id": "v1", "kind": "V", "clips": [
                {"id": "c1", "asset_id": V1, "start_s": 0, "in_s": 0, "out_s": 2, "audio": True},
                {"id": "c2", "asset_id": V2, "start_s": 1.5, "in_s": 0, "out_s": 2, "fit": "cover",
                 "transition": {"type": "crossfade", "duration_s": 0.5}},
                {"id": "c3", "asset_id": IMG, "start_s": 3.5, "in_s": 0, "out_s": 1, "fit": "cover"}]},
            {"id": "a1", "kind": "A", "clips": [
                {"id": "m1", "asset_id": MU, "start_s": 0, "in_s": 0, "out_s": 4, "gain_db": -12}]}]}
        out = self.dir / "out.mp4"
        seen = []
        real_run = render_backend._run

        def spy(cmd, deadline=None):
            seen.append(list(cmd))
            return real_run(cmd, deadline=deadline)

        with mock.patch.object(render_backend, "_run", side_effect=spy):
            tr.render(doc, self.assets.get, str(out), ffmpeg=self.ffmpeg, jobs=1, timeout_s=120)
        self.assertEqual(self.frames(out), 135)               # 4.5 s at 30 fps
        # What ran: three segment commands (the cross-fade is one), then the final pass.
        reading = [argv for argv in seen if "-i" in argv]
        self.assertGreaterEqual(len(reading), 4)
        for argv in reading:
            self.assertIn("-protocol_whitelist", argv)

    def test_an_input_that_names_another_one_is_held_to_the_file_protocol(self):
        # A "video" that is really a concat script naming a url. ffmpeg's own default for such
        # demuxers is "file,crypto,data"; the command now says "file".
        evil = self.dir / "evil"
        evil.write_text("ffconcat version 1.0\nfile http://127.0.0.1:9/x.mp4\n")
        seg = rs.Segment(duration=1.0, path=str(evil), kind=rs.KIND_VIDEO)
        (cmd,) = render_backend.segment_commands(self.ffmpeg, seg, self.dir / "o.mp4", 96, 64, 30,
                                                 frame_exact=True)
        cmd = cmd[:1] + ["-safe", "0"] + cmd[1:]            # let the script be read at all
        proc = subprocess.run(cmd, capture_output=True, text=True)
        self.assertNotEqual(proc.returncode, 0)
        self.assertIn("not on whitelist 'file'!", proc.stderr)


if __name__ == "__main__":
    unittest.main()

"""The editor's free tools (migration 0054): trim + split, speed (0.5-2x) and
text on the picture, as timeline data — validated (modules/timeline.py),
turned into ffmpeg arguments (render_spec / render_backend / timeline_render)
and rendered by the media worker's export thread (modules/editor_export.py).

The argv tests pin what a speed change and a clip's own sound do to the
commands; the injection tests prove text never reaches an ffmpeg argument;
the export tests prove an export is checked, rendered, stored as a 'render'
library file and finished — or failed with a reason word — without a
provider, a credit or a path in the logs. Real-ffmpeg tests are skipped
without ffmpeg (with libass)."""

from __future__ import annotations

import copy
import json
import logging
import re
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from modules import ass_captions, editor_export, media_library as ml, render_backend
from modules import render_spec as rs
from modules import timeline as tl
from modules import timeline_render as tr

V1 = "11111111-1111-4111-8111-111111111111"
IMG = "22222222-2222-4222-8222-222222222222"
MU = "44444444-4444-4444-8444-444444444444"
ORG = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
PROJECT = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
EXPORT = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"


def doc(**clip):
    c = {"id": "c1", "asset_id": V1, "start_s": 0, "in_s": 2.0, "out_s": 6.0}
    c.update(clip)
    return {"version": 1, "width": 1920, "height": 1080, "fps": 30,
            "tracks": [{"id": "v1", "kind": "V", "clips": [c]}]}


def assets(has_audio=True):
    return {V1: tl.ResolvedAsset(V1, "video", "/m/v1.mp4", 20.0, has_audio),
            IMG: tl.ResolvedAsset(IMG, "image", "/m/img.png"),
            MU: tl.ResolvedAsset(MU, "audio", "/m/mu.mp3", 60.0)}


# ── speed: validation ────────────────────────────────────────────────────────


class SpeedValidationTestCase(unittest.TestCase):
    def test_speed_range_is_the_same_in_the_document_and_the_spec(self):
        self.assertEqual((tl.SPEED_MIN, tl.SPEED_MAX), (rs.SPEED_MIN, rs.SPEED_MAX))
        self.assertEqual((tl.SPEED_MIN, tl.SPEED_MAX), (0.5, 2.0))
        schema = json.loads(tl.SCHEMA_PATH.read_text(encoding="utf-8"))
        speed = schema["$defs"]["video_clip"]["properties"]["speed"]
        self.assertEqual((speed["minimum"], speed["maximum"]), (tl.SPEED_MIN, tl.SPEED_MAX))

    def test_speeds_outside_half_to_double_are_refused(self):
        for bad in (0.25, 0.49, 2.01, 4, 0, -1, "2", True, None, float("nan"), float("inf")):
            problems = tl.validate(doc(speed=bad))
            self.assertTrue(any("speed" in p for p in problems), (bad, problems))
        for ok in (0.5, 0.75, 1, 1.25, 1.5, 2, 2.0):
            self.assertEqual(tl.validate(doc(speed=ok)), [], ok)

    def test_audio_flag_must_be_a_boolean(self):
        for bad in ("yes", 1, None, [True]):
            self.assertTrue(any("audio" in p for p in tl.validate(doc(audio=bad))), bad)
        self.assertEqual(tl.validate(doc(audio=True)), [])

    def test_speed_and_audio_belong_to_video_clips_only(self):
        d = doc()
        d["tracks"].append({"id": "a1", "kind": "A", "clips": [
            {"id": "m1", "asset_id": MU, "start_s": 0, "in_s": 0, "out_s": 4, "speed": 2}]})
        self.assertTrue(any("speed is not a known field" in p for p in tl.validate(d)))

    def test_a_faster_clip_is_shorter_on_the_timeline(self):
        # in/out are source times: 4 s of source at 2x lasts 2 s, at 0.5x 8 s.
        self.assertEqual(tl.duration_s(tl.load(doc(speed=2))), 2.0)
        self.assertEqual(tl.duration_s(tl.load(doc(speed=0.5))), 8.0)
        self.assertEqual(tl.duration_s(tl.load(doc())), 4.0)

    def test_overlaps_are_judged_by_the_sped_up_length(self):
        d = doc(speed=2)
        d["tracks"][0]["clips"].append({"id": "c2", "asset_id": V1, "start_s": 2.0, "in_s": 0, "out_s": 1})
        self.assertEqual(tl.validate(d), [])           # c1 ends at 2.0 at 2x
        d["tracks"][0]["clips"][0]["speed"] = 1.5      # ...and at 2.667 at 1.5x
        self.assertTrue(any("overlap" in p for p in tl.validate(d)))

    def test_fades_must_fit_the_sped_up_clip(self):
        self.assertEqual(tl.validate(doc(fade_in_s=1.5, fade_out_s=1.5)), [])
        self.assertTrue(any("fade" in p for p in tl.validate(doc(speed=2, fade_in_s=1.5, fade_out_s=1.5))))

    def test_a_clip_sped_below_one_frame_is_refused(self):
        self.assertTrue(any("one frame" in p for p in tl.validate(doc(in_s=0, out_s=0.03, speed=2))))

    def test_clip_audio_counts_toward_the_audio_input_cap(self):
        clips = [{"id": f"c{i}", "asset_id": V1, "start_s": i, "in_s": 0, "out_s": 1, "audio": True}
                 for i in range(tl.MAX_AUDIO_CLIPS + 1)]
        d = {"version": 1, "width": 64, "height": 64, "fps": 30,
             "tracks": [{"id": "v1", "kind": "V", "clips": clips}]}
        self.assertTrue(any("audio clips" in p for p in tl.validate(d)))
        for c in clips:
            c["audio"] = False
        self.assertEqual(tl.validate(d), [])

    def test_normalise_fills_speed_and_audio_and_older_documents_still_load(self):
        norm = tl.load(doc())
        clip = norm["tracks"][0]["clips"][0]
        self.assertEqual((clip["speed"], clip["audio"]), (1.0, False))
        self.assertEqual(tl.load(norm), norm)


# ── trim + split ─────────────────────────────────────────────────────────────


class SplitTestCase(unittest.TestCase):
    def test_split_of_a_sped_up_clip_continues_the_source_at_its_speed(self):
        d = tl.load(doc(speed=2, audio=True))          # 2..6 s of source over 0..2 s
        out = tl.split_clip(d, "c1", 0.5, "c1b")
        a, b = out["tracks"][0]["clips"]
        self.assertEqual((a["in_s"], a["out_s"], b["start_s"], b["in_s"], b["out_s"]),
                         (2.0, 3.0, 0.5, 3.0, 6.0))
        self.assertEqual((a["speed"], b["speed"], a["audio"], b["audio"]), (2.0, 2.0, True, True))
        self.assertEqual(tl.duration_s(tl.load(out)), tl.duration_s(d))

    def test_split_refuses_points_outside_or_at_the_edges(self):
        d = tl.load(doc(speed=2))
        for at in (0, 2.0, 2.5, -1):
            with self.assertRaises(tl.TimelineError):
                tl.split_clip(d, "c1", at, "x")
        with self.assertRaises(tl.TimelineError):
            tl.split_clip(d, "c1", 0.0001, "x")      # rounds onto the clip's start

    def test_trim_past_the_end_of_the_source_is_refused(self):
        with self.assertRaises(tl.TimelineError):
            tr.to_render_spec(doc(out_s=20.5), assets().get, "/o.mp4")


# ── text: never interpolated into a filter graph ────────────────────────────


HOSTILE = [
    "a'b", "x,y;z", "[0:v]null[v]", "subtitles=/etc/passwd", r"{\fs900\pos(0,0)}boom", "line\nbreak",
    "\\N\\h", "$(rm -rf /)", "%{pts}", "drawtext=text=x", "'; -i /etc/shadow",
]


class TextSafetyTestCase(unittest.TestCase):
    def spec_for(self, text):
        d = doc()
        d["tracks"].append({"id": "t1", "kind": "T", "clips": [
            {"id": "x", "start_s": 0, "end_s": 2, "text": text}]})
        return tr.to_render_spec(d, assets().get, "/out/o.mp4")

    def test_text_never_appears_in_any_ffmpeg_argument(self):
        for text in HOSTILE:
            spec = self.spec_for(text)
            argv = rs.build_ffmpeg_command(spec, "/w/concat.txt", "/w/overlays.ass")
            argv += [a for s in spec.segments for cmd in render_backend.segment_commands(
                "ffmpeg", s, Path("/w/s.mp4"), spec.width, spec.height, spec.fps, frame_exact=True)
                for a in cmd]
            joined = "\x00".join(argv)
            self.assertNotIn(text, joined, text)
            graph = argv[argv.index("-filter_complex") + 1]
            # The only thing the overlays add to the graph is the file the backend wrote.
            self.assertEqual(graph, "[0:v]subtitles='/w/overlays.ass'[vout]")

    def test_text_cannot_open_an_ass_override_or_a_new_event(self):
        for text in HOSTILE:
            ass = ass_captions.build_overlay_ass(self.spec_for(text).overlays, width=1920, height=1080)
            events = [ln for ln in ass.splitlines() if ln.startswith("Dialogue:")]
            self.assertEqual(len(events), 1, text)
            self.assertEqual(events[0].count("{"), 1, text)       # only our own tag block
            self.assertNotIn(r"\fs900", events[0])

    def test_text_length_is_bounded(self):
        d = doc()
        d["tracks"].append({"id": "t1", "kind": "T", "clips": [
            {"id": "x", "start_s": 0, "end_s": 2, "text": "x" * (tl.MAX_TEXT + 1)}]})
        self.assertTrue(any("at most" in p for p in tl.validate(d)))


# ── ffmpeg arguments ────────────────────────────────────────────────────────


class SpeedArgvTestCase(unittest.TestCase):
    def test_a_sped_up_video_segment_is_retimed_before_it_is_fitted(self):
        seg = rs.Segment(duration=2.0, path="/m/v1.mp4", kind=rs.KIND_VIDEO, in_s=2.0, speed=2.0)
        cmd = render_backend.segment_commands("ffmpeg", seg, Path("/w/s.mp4"), 1920, 1080, 30,
                                              frame_exact=True)[0]
        vf = cmd[cmd.index("-vf") + 1]
        self.assertTrue(vf.startswith("setpts=(PTS-STARTPTS)/2.000,scale=1920:1080"), vf)
        self.assertEqual(cmd[cmd.index("-frames:v") + 1], "60")
        self.assertEqual(cmd[cmd.index("-ss") + 1], "2.000")
        self.assertIn("-an", cmd)

    def test_normal_speed_leaves_the_command_exactly_as_before(self):
        seg = rs.Segment(duration=2.0, path="/m/v1.mp4", kind=rs.KIND_VIDEO, in_s=2.0)
        cmd = render_backend.segment_commands("ffmpeg", seg, Path("/w/s.mp4"), 1920, 1080, 30)[0]
        self.assertNotIn("setpts", " ".join(cmd))
        self.assertEqual(rs.Segment.from_dict(seg.to_dict()), seg)
        self.assertNotIn("speed", seg.to_dict())

    def test_a_still_ignores_speed(self):
        d = doc(asset_id=IMG, in_s=0, out_s=3)
        spec = tr.to_render_spec(d, assets().get, "/o.mp4")
        self.assertEqual(spec.segments[0].speed, 1.0)

    def test_sped_up_sound_uses_one_atempo_stage_and_fades_on_the_output(self):
        t = rs.AudioTrack("/m/v1.mp4", duration_s=4.0, in_s=2.0, speed=2.0, fade_out_s=0.5)
        f = rs.audio_track_filter(t, 1, "a0")
        self.assertIn("atrim=start=2.000:duration=4.000,asetpts=PTS-STARTPTS,atempo=2.000,aformat=", f)
        # 4 s of source at 2x sound for 2 s: the fade-out starts at 1.5 s.
        self.assertIn("afade=t=out:st=1.500:d=0.500", f)
        self.assertEqual(f.count("atempo"), 1)
        self.assertEqual(rs.AudioTrack.from_dict(t.to_dict()), t)

    def test_spec_validation_refuses_out_of_range_speed(self):
        bad = rs.RenderSpec(output_path="/o.mp4", segments=[rs.Segment(1.0, "/v.mp4", speed=3.0)],
                            audio_tracks=[rs.AudioTrack("/a.wav", 1.0, speed=0.25)])
        problems = rs.validate(bad)
        self.assertTrue(any("segment 0 speed" in p for p in problems))
        self.assertTrue(any("audio track 0 speed" in p for p in problems))

    def test_clip_sound_follows_trim_start_and_speed(self):
        d = doc(speed=2, audio=True, start_s=1.0)
        spec = tr.to_render_spec(d, assets().get, "/o.mp4")
        self.assertEqual(spec.segments[1].speed, 2.0)        # [0] is the black lead-in
        self.assertEqual(spec.audio_tracks, [rs.AudioTrack("/m/v1.mp4", duration_s=4.0, start_s=1.0,
                                                           in_s=2.0, speed=2.0)])
        argv = rs.build_ffmpeg_command(spec, "/w/c.txt")
        self.assertEqual(argv.count("/m/v1.mp4"), 1)
        graph = argv[argv.index("-filter_complex") + 1]
        self.assertIn("[1:a]atrim=start=2.000:duration=4.000,asetpts=PTS-STARTPTS,atempo=2.000", graph)
        self.assertIn("adelay=delays=1000:all=1", graph)

    def test_clip_sound_is_off_unless_asked_and_known_to_exist(self):
        for audio, has in ((False, True), (True, False), (True, None)):
            spec = tr.to_render_spec(doc(audio=audio), assets(has_audio=has).get, "/o.mp4")
            self.assertEqual(spec.audio_tracks, [], (audio, has))

    def test_clip_sound_comes_before_the_music_tracks(self):
        d = doc(audio=True)
        d["tracks"].append({"id": "a1", "kind": "A", "clips": [
            {"id": "m1", "asset_id": MU, "start_s": 0, "in_s": 0, "out_s": 4, "gain_db": -12}]})
        spec = tr.to_render_spec(d, assets().get, "/o.mp4")
        self.assertEqual([t.path for t in spec.audio_tracks], ["/m/v1.mp4", "/m/mu.mp3"])


# ── the export worker ───────────────────────────────────────────────────────


class FakeStore:
    def __init__(self, rows=None):
        self.rows = rows if rows is not None else [
            {"id": V1, "kind": "video", "mime": "video/mp4", "duration_s": 20, "variants": ["proxy"]}]
        self.finished = []
        self.beats = 0

    def export_assets(self, export_id):
        return self.rows

    def export_heartbeat(self, export_id, worker_id):
        self.beats += 1
        return True

    def finish_export(self, export_id, worker_id, asset_id, reason):
        self.finished.append((export_id, worker_id, asset_id, reason))
        return "done" if asset_id else "failed"


def media_tree(root: Path, ids=(V1,)) -> None:
    for aid in ids:
        f = ml.asset_file(root, aid, "original")
        f.parent.mkdir(parents=True, exist_ok=True)
        f.write_bytes(b"x")


def export_row(d=None, **over):
    row = {"id": EXPORT, "org_id": ORG, "project_id": PROJECT, "rev": 3, "duration_s": 4,
           "doc": d if d is not None else doc(audio=True, speed=1.5)}
    row.update(over)
    return row


class ExportWorkerTestCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        media_tree(self.root)
        self.tools = ml.Tools("ffprobe", "ffmpeg")

    def tearDown(self):
        self.tmp.cleanup()

    def run_export(self, export, store=None, render=None, store_file=None):
        store = store or FakeStore()
        render = render or mock.Mock(side_effect=lambda d, res, out, **kw: Path(out).write_bytes(b"mp4") or out)
        store_file = store_file or mock.Mock(return_value={"id": "dddddddd-dddd-4ddd-8ddd-dddddddddddd"})
        status = editor_export.run_export(export, store=store, media_root=self.root, worker_id="w1",
                                          tools=self.tools, render=render, store_file=store_file,
                                          has_audio=lambda path, mime: True, heartbeat_s=0.01)
        return status, store, render, store_file

    def test_a_good_export_is_rendered_stored_as_a_render_and_finished(self):
        status, store, render, store_file = self.run_export(export_row())
        self.assertEqual(status, "done")
        args, kw = render.call_args
        self.assertEqual(kw["jobs"], 1)
        resolved = args[1](V1)
        self.assertEqual(resolved.path, str(ml.asset_file(self.root, V1, "original")))
        self.assertTrue(resolved.has_audio)
        kw = store_file.call_args.kwargs
        self.assertEqual((kw["source"], kw["org_id"], kw["project_id"], kw["expect_kind"]),
                         ("render", ORG, PROJECT, "video"))
        self.assertEqual(kw["provenance"], {"tool": "editor", "editor_project": PROJECT,
                                            "editor_export": EXPORT, "rev": 3})
        self.assertEqual(store.finished, [(EXPORT, "w1", "dddddddd-dddd-4ddd-8ddd-dddddddddddd", None)])
        # The work folder on the media volume is cleaned up.
        self.assertFalse((self.root / editor_export.WORK_DIRNAME / EXPORT).exists())

    def test_an_invalid_document_fails_without_rendering(self):
        for bad in (doc(speed=3), doc(out_s=1, in_s=2), {"version": 1}, "not json", None):
            status, store, render, _ = self.run_export(export_row(doc=bad))
            self.assertEqual(status, "failed")
            self.assertEqual(store.finished[-1][2:], (None, "invalid_timeline"), bad)
            render.assert_not_called()

    def test_a_file_the_database_did_not_return_is_never_read(self):
        # Another organization's file, or one deleted since: the database
        # leaves it out, and the export fails instead of rendering around it.
        status, store, render, _ = self.run_export(export_row(), store=FakeStore(rows=[]))
        self.assertEqual(store.finished[-1][2:], (None, "asset_unavailable"))
        render.assert_not_called()

    def test_a_file_missing_from_the_volume_or_a_symlink_is_unavailable(self):
        other = "99999999-9999-4999-8999-999999999999"
        rows = [{"id": other, "kind": "video", "mime": "video/mp4", "duration_s": 20, "variants": []}]
        self.assertIsNone(editor_export.build_resolver(rows, self.root, has_audio=lambda p, m: True)(other))
        target = ml.asset_file(self.root, other, "original")
        target.parent.mkdir(parents=True)
        target.symlink_to("/etc/passwd")
        self.assertIsNone(editor_export.build_resolver(rows, self.root, has_audio=lambda p, m: True)(other))

    def test_paths_come_from_the_id_alone(self):
        rows = [{"id": V1, "kind": "video", "mime": "video/mp4", "variants": [],
                 "storage_key": "../../etc", "path": "/etc/passwd"},
                {"id": "../../etc/passwd", "kind": "video", "mime": "video/mp4"}]
        res = editor_export.build_resolver(rows, self.root, has_audio=lambda p, m: False)
        self.assertEqual(res(V1).path, str(ml.asset_file(self.root, V1, "original")))
        self.assertIsNone(res("../../etc/passwd"))

    def test_a_heic_photo_is_read_from_its_display_copy(self):
        media_tree(self.root, ())
        f = ml.asset_file(self.root, IMG, "display")
        f.parent.mkdir(parents=True, exist_ok=True)
        f.write_bytes(b"jpg")
        rows = [{"id": IMG, "kind": "image", "mime": "image/heic", "variants": ["display"]}]
        res = editor_export.build_resolver(rows, self.root, has_audio=lambda p, m: True)
        self.assertEqual(res(IMG).path, str(f))
        rows[0]["variants"] = []
        self.assertIsNone(editor_export.build_resolver(rows, self.root, has_audio=lambda p, m: True)(IMG))

    def test_too_long_is_refused_before_any_work(self):
        status, store, render, _ = self.run_export(export_row(duration_s=1801))
        self.assertEqual(store.finished[-1][2:], (None, "too_long"))
        render.assert_not_called()

    def test_an_ffmpeg_failure_is_a_reason_word_and_no_path_is_logged(self):
        boom = mock.Mock(side_effect=render_backend.RenderBackendError(f"ffmpeg exited 1: {self.root}/x"))
        with self.assertLogs("modules.editor_export", level=logging.INFO) as logs:
            status, store, _, store_file = self.run_export(export_row(), render=boom)
        self.assertEqual(store.finished[-1][2:], (None, "render_failed"))
        store_file.assert_not_called()
        self.assertFalse(any(str(self.root) in line for line in logs.output), logs.output)

    def test_a_storing_failure_fails_the_export(self):
        bad = mock.Mock(side_effect=ml.StoreUnavailable("db"))
        status, store, _, _ = self.run_export(export_row(), store_file=bad)
        self.assertEqual(store.finished[-1][2:], (None, "store_failed"))

    def test_nothing_here_reaches_a_provider_credits_or_publishing(self):
        src = Path(editor_export.__file__).read_text(encoding="utf-8")
        for word in ("creative_adapters", "credit", "publish_request", "youtube",
                     "requests.post", "social_publish"):
            self.assertNotIn(word, src.split('"""', 2)[2], word)

    def test_audio_probe_is_forced_to_the_recorded_type_and_local_files(self):
        argv = editor_export.audio_probe_command("ffprobe", Path("/m/x/original"), "video/quicktime")
        self.assertEqual(argv[argv.index("-protocol_whitelist") + 1], "file")
        self.assertEqual(argv[argv.index("-f") + 1], "mov")
        with self.assertRaises(editor_export.ExportFailed):
            editor_export.probe_has_audio("ffprobe", Path("/x"), "text/vtt")


# ── real renders ────────────────────────────────────────────────────────────


def _ffmpeg_ok() -> bool:
    import shutil

    exe = shutil.which("ffmpeg")
    try:
        return bool(exe and shutil.which("ffprobe")) and ass_captions.has_libass(exe)
    except OSError:
        return False


def _frames_and_audio(path: Path):
    out = subprocess.run(["ffprobe", "-v", "error", "-count_frames", "-show_entries",
                          "stream=codec_type,nb_read_frames,duration", "-of", "json", str(path)],
                         capture_output=True, text=True).stdout
    streams = json.loads(out)["streams"]
    v = [s for s in streams if s["codec_type"] == "video"][0]
    a = [s for s in streams if s["codec_type"] == "audio"]
    return int(v["nb_read_frames"]), (float(a[0]["duration"]) if a else None)


@unittest.skipUnless(_ffmpeg_ok(), "ffmpeg / ffprobe with libass not available")
class RealEditorRenderTestCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        src = ml.asset_file(self.root, V1, "original")
        src.parent.mkdir(parents=True)
        subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc=s=160x90:r=25:d=6",
                        "-f", "lavfi", "-i", "sine=frequency=440:duration=6", "-c:v", "libx264",
                        "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", "-f", "mp4", str(src)], check=True)
        self.src = src

    def tearDown(self):
        self.tmp.cleanup()

    def test_trim_split_speed_and_text_render_to_exactly_their_frames_with_sound(self):
        d = {"version": 1, "width": 128, "height": 72, "fps": 25, "tracks": [
            {"id": "v1", "kind": "V", "clips": [
                {"id": "c1", "asset_id": V1, "start_s": 0, "in_s": 1.0, "out_s": 5.0, "speed": 2, "audio": True}]},
            {"id": "t1", "kind": "T", "clips": [
                {"id": "x", "start_s": 0.2, "end_s": 1.4, "text": "a'b,c;[0:v]{\\b1}\nnext", "size": 20}]}]}
        d = tl.split_clip(tl.load(d), "c1", 0.8, "c2")
        d["tracks"][0]["clips"][1]["speed"] = 0.5     # the second half at half speed
        res = editor_export.build_resolver(
            [{"id": V1, "kind": "video", "mime": "video/mp4", "duration_s": 6, "variants": []}], self.root,
            has_audio=lambda p, m: editor_export.probe_has_audio("ffprobe", p, m))
        self.assertTrue(res(V1).has_audio)
        out = self.root / "out.mp4"
        tr.render(d, res, str(out), ffmpeg="ffmpeg", jobs=1)
        frames, audio_s = _frames_and_audio(out)
        # 1.0..2.6 s of source at 2x (0.8 s), then 2.6..5.0 s at 0.5x (4.8 s):
        # 5.6 s × 25 fps, and the sound lasts exactly as long.
        self.assertEqual(frames, 140)
        self.assertIsNotNone(audio_s)
        self.assertAlmostEqual(audio_s, 5.6, delta=0.06)

    def test_the_export_thread_end_to_end_with_a_real_render(self):
        registered = []

        class Store(FakeStore):
            def register(self, **kw):
                registered.append(kw)
                return {"id": kw["asset_id"], "storage_key": ml.storage_key(kw["asset_id"])}

        store = Store()
        d = doc(in_s=0.5, out_s=2.5, speed=2, audio=True)
        d["width"], d["height"] = 64, 36
        status = editor_export.run_export(export_row(d, duration_s=1), store=store, media_root=self.root,
                                          worker_id="w1", tools=ml.Tools("ffprobe", "ffmpeg"))
        self.assertEqual(status, "done", store.finished)
        self.assertEqual(len(registered), 1)
        reg = registered[0]
        self.assertEqual((reg["source"], reg["kind"], reg["org"], reg["project_id"]), ("render", "video", ORG, PROJECT))
        stored = ml.asset_file(self.root, reg["asset_id"], "original")
        frames, audio_s = _frames_and_audio(stored)
        self.assertEqual(frames, 30)                  # 2 s of source at 2x, 30 fps
        self.assertAlmostEqual(audio_s, 1.0, delta=0.06)
        self.assertEqual(store.finished, [(EXPORT, "w1", reg["asset_id"], None)])


if __name__ == "__main__":
    unittest.main()

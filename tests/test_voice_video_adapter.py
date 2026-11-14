"""Voice to video (migration 0176) on the worker: the adapter of our own engine, the registry entry, the seam and the worker.

The render and the transcription are replaced by fakes here (a real render is opt-in, test_the_real_engine below); nothing
touches a network or spends anything. What must hold:

* "configured" means the engine is installed on THIS machine (npx, video-engine/node_modules, Whisper and its model, the sound
  effects), never a key; anything missing fails the job before anything runs, naming the fix, and the hold is released;
* the person's recording and look are what is rendered: no planner model, no look filled in here, no music, nothing else;
* every refusal is a named failure (no words, too long, unreadable, the render failing or timing out) and never a video of
  something else; the operator's log gets Remotion's tail, the job row never does (it names this machine's paths);
* the finished file is moved, not read into memory, into the job folder, and from there into the library as a video;
* the registry entry ships dark: no price, never probed, our own engine, one capability, the looks the database accepts.
"""

from __future__ import annotations

import json
import logging
import os
import signal
import sys
import shutil
import subprocess
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest import mock

from modules import creative_adapters as ca
from modules import creative_worker as cw
from modules import media_library as ml
from modules import model_registry as reg
from modules import voice_explainer as ve
from modules.capabilities import build_adapter
from modules.capabilities import voice_video as vv
from modules.capabilities.base import (
    E_BAD_REQUEST,
    E_BAD_RESPONSE,
    E_NOT_CONFIGURED,
    E_NOT_FOUND,
    E_UNAVAILABLE,
    EXPLAINER_LOOKS,
    MEDIA_INPUT,
    REGISTRY_ONLY_CAPABILITIES,
    VOICE_EXPLAINER,
    AdapterError,
    CapabilityRequest,
    PollResult,
    SUCCEEDED,
)
from tests.test_creative_media_inputs import FakeStore, SourceQueue, put_asset
from tests.test_creative_worker import JOB, ORG, FakeCredits, job

MODEL = "nightshift-voice-explainer"
SRC = "ab0c1d1e-0000-4000-8000-000000000171"
MP3 = b"ID3\x04\x00\x00\x00\x00\x00\x00" + b"\x00" * 512
MP4 = b"\x00\x00\x00\x18ftypisom\x00\x00\x02\x00isomiso2" + b"\x00" * 1024
WORDS = [{"word": "Salom.", "start": 0.1, "end": 0.6}, {"word": "Bu", "start": 0.9, "end": 1.1},
         {"word": "narx", "start": 1.2, "end": 1.6}, {"word": "10", "start": 1.7, "end": 2.0},
         {"word": "dollar.", "start": 2.1, "end": 2.6}]


class Engine:
    """A machine with the engine installed: a fake video-engine, a Whisper model file, the effects."""

    def __init__(self, root: Path):
        self.engine = root / "video-engine"
        (self.engine / "node_modules" / "remotion").mkdir(parents=True)
        (self.engine / "node_modules" / ".remotion").mkdir()
        self.whisper = root / "whisper"
        self.whisper.mkdir()
        (self.whisper / vv.WHISPER_FILE).write_bytes(b"model")
        self.sfx = root / "sfx"
        self.sfx.mkdir()
        for n in ve.SFX_NEEDED:
            (self.sfx / f"{n}.wav").write_bytes(b"RIFF")
        self.rendered = []
        self.transcribed = []
        self.words = WORDS
        self.render_error = None
        self.decoded = []

    def decode(self, src, dst):
        # Stands in for ffmpeg (the real one is TheDecoder, below): the "WAV" is the recording's bytes.
        self.decoded.append((Path(src), Path(dst)))
        shutil.copyfile(src, dst)

    def transcribe(self, audio, work_dir, root):
        self.transcribed.append((Path(audio), Path(work_dir), Path(root)))
        return list(self.words)

    def render(self, props, out, *, files, engine_dir, browser, timeout_s, tmp_dir, on_spawn=None):
        self.rendered.append({"props": props, "out": Path(out), "files": dict(files), "engine_dir": engine_dir,
                              "browser": browser, "timeout_s": timeout_s, "tmp_dir": Path(tmp_dir), "on_spawn": on_spawn})
        if self.render_error:
            raise self.render_error
        Path(out).write_bytes(MP4)
        return Path(out)

    def adapter(self, env=None, **over):
        kw = dict(env=env or {}, engine_dir=self.engine, sfx_dir=self.sfx, whisper_dirs=(self.whisper,),
                  transcribe=self.transcribe, render=self.render, has_npx=lambda: True, whisper_installed=lambda: True,
                  which=lambda name: f"/usr/bin/{name}", font_family=lambda: "Inter", decode=self.decode,
                  stop=threading.Event())
        kw.update(over)
        return vv.VoiceVideoAdapter(**kw)


class Tmp(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.addCleanup(self.tmp.cleanup)
        self.e = Engine(self.root)
        self.input = self.root / "job" / "input"
        self.input.mkdir(parents=True)
        self.rec = self.input / "source.mp3"
        self.rec.write_bytes(MP3)
        p = mock.patch.object(ve, "audio_seconds", return_value=3.0)
        self.seconds = p.start()
        self.addCleanup(p.stop)

    def req(self, look="dusk", media=None, **over):
        return CapabilityRequest(capability=VOICE_EXPLAINER, look=look,
                                 input_media=tuple(media) if media is not None else (str(self.rec),), **over)


class Configured(Tmp):
    def test_ready_means_the_engine_is_installed_never_a_key(self):
        a = self.e.adapter()
        self.assertEqual(a.missing(), [])
        self.assertTrue(a.configured())
        # Keys change nothing either way: there is no key to have.
        self.assertTrue(self.e.adapter(env={"OPENAI_API_KEY": "sk-whatever-1234567890"}).configured())
        self.assertEqual(vv.VoiceVideoAdapter.key_env, ())

    def test_each_missing_part_is_named_with_its_fix(self):
        cases = {
            "npx": dict(has_npx=lambda: False),
            "npm ci": dict(engine_dir=self.root / "nowhere"),
            "pip install": dict(whisper_installed=lambda: False),
            "bakes it in": dict(whisper_dirs=(self.root / "empty",)),
            "generate_assets.py": dict(sfx_dir=self.root / "nosfx"),
            "ffmpeg is not on PATH": dict(which=lambda n: None if n == "ffmpeg" else f"/usr/bin/{n}"),
            "ffprobe is not on PATH": dict(which=lambda n: None if n == "ffprobe" else f"/usr/bin/{n}"),
            "install fonts-inter": dict(font_family=lambda: "DejaVu Sans"),
            "install fontconfig": dict(font_family=lambda: None),
        }
        for fix, over in cases.items():
            a = self.e.adapter(**over)
            self.assertFalse(a.configured(), fix)
            self.assertTrue(any(fix in m for m in a.missing()), (fix, a.missing()))
        a = self.e.adapter(env={vv.BROWSER_ENV: str(self.root / "no-chrome")})
        self.assertIn(f"{vv.BROWSER_ENV} does not point at a file", " ".join(a.missing()))
        # Remotion's own browser: without it Remotion would download one in the middle of a paid job.
        shutil.rmtree(self.e.engine / "node_modules" / ".remotion")
        self.assertIn("npx remotion browser ensure", " ".join(self.e.adapter().missing()))
        chrome = self.root / "chrome"
        chrome.write_bytes(b"#!")
        self.assertEqual(self.e.adapter(env={vv.BROWSER_ENV: str(chrome)}).missing(), [], "a Chrome of the operator's stands in")

    def test_inter_is_what_fontconfig_answers_never_a_family_that_merely_starts_with_it(self):
        self.assertEqual(self.e.adapter(font_family=lambda: "Inter,Inter Display").missing(), [])
        self.assertTrue(self.e.adapter(font_family=lambda: "Interstate").missing())

    def test_whisper_present_as_a_module_without_a_spec_does_not_break_the_check(self):
        # find_spec raises ValueError for a sys.modules entry with no __spec__ (what a test double leaves behind).
        stub = type(sys)("whisper")
        stub.__spec__ = None
        with mock.patch.dict(sys.modules, {"whisper": stub}):
            self.assertTrue(vv.whisper_importable())

    def test_not_ready_fails_before_anything_runs(self):
        a = self.e.adapter(has_npx=lambda: False)
        with self.assertRaises(AdapterError) as cm:
            a.submit(self.req(), vv.RULES_ENGINE)
        self.assertEqual(cm.exception.code, E_NOT_CONFIGURED)
        self.assertTrue(cm.exception.not_accepted)
        self.assertEqual((self.e.transcribed, self.e.rendered), ([], []))
        self.seconds.assert_not_called()

    def test_the_shared_whisper_copy_is_found_when_the_users_cache_is_empty(self):
        # The creative worker runs as another user with HOME on a tmpfs: Whisper's default cache is empty there.
        self.assertEqual(vv.whisper_root((self.root / "empty", self.e.whisper)), self.e.whisper)
        self.assertIsNone(vv.whisper_root((self.root / "empty",)))
        self.assertIn(vv.SHARED_WHISPER_DIR, vv.VoiceVideoAdapter().whisper_dirs)


class Submit(Tmp):
    def test_the_recording_and_the_look_are_rendered_with_the_rules_planner_and_nothing_else(self):
        a = self.e.adapter()
        task = a.submit(self.req("neon"), vv.RULES_ENGINE)
        (r,) = self.e.rendered
        props = r["props"]
        self.assertEqual((props["look"], props["width"], props["height"], props["fps"]), ("neon", 1080, 1920, 30))
        # The decoded copy is what is rendered (a browser recording has no length and no seek index of its own).
        work = self.input / "voice-video"
        self.assertEqual((props["narration"], props["music"], props["captions"]), ("narration.wav", "", True))
        self.assertEqual(r["files"]["narration.wav"], work / "narration.wav")
        self.assertEqual(self.e.decoded, [(self.rec, work / "narration.wav")])
        self.assertEqual(sorted(k for k in r["files"] if k.startswith("sfx/")), ["sfx/deep_boom.wav", "sfx/whoosh.wav"])
        # The spoken number became a counter exactly as said; every scene comes from the words, not a model.
        # (The short greeting joins the next sentence: no scene flashes past.)
        self.assertEqual([s["visual"] for s in props["scenes"]], [{"kind": "stat", "value": "10", "label": "Salom Bu narx 10 dollar"}])
        self.assertEqual([w["text"] for w in props["words"]], [w["word"] for w in WORDS])
        # Scratch on the job's own volume (the creative worker's /tmp is a tmpfs), and a time limit from the recording.
        self.assertTrue(r["tmp_dir"].is_relative_to(self.input))
        self.assertEqual(r["timeout_s"], vv.RENDER_TIMEOUT_FLOOR_S + vv.RENDER_TIMEOUT_PER_SECOND * 3.0)
        self.assertIsNone(r["browser"])
        (transcribed,) = self.e.transcribed
        self.assertEqual((transcribed[0], transcribed[2]), (work / "narration.wav", self.e.whisper))
        self.seconds.assert_called_once_with(work / "narration.wav")
        # The file is handed over by its path, never read into memory.
        self.assertIsNone(task.task_id)
        (out,) = task.outputs
        self.assertIsInstance(out, vv.FileOutput)
        self.assertIsNone(out.data)
        self.assertEqual(out.mime, "video/mp4")
        self.assertEqual(out.path.read_bytes(), MP4)

    def test_fetch_moves_the_video_into_the_job_folder(self):
        a = self.e.adapter()
        task = a.submit(self.req(), vv.RULES_ENGINE)
        rendered = task.outputs[0].path
        (f,) = a.fetch(PollResult(SUCCEEDED, task.outputs), self.root / "job", stem="output")
        self.assertEqual(f, self.root / "job" / "output_0.mp4")
        self.assertEqual(f.read_bytes(), MP4)
        self.assertFalse(rendered.exists())
        self.assertFalse((self.input / "voice-video").exists(), "the render's scratch is gone")
        with self.assertRaises(AdapterError):
            a.fetch(PollResult(SUCCEEDED, task.outputs), self.root / "job")  # moved once, never twice

    def test_the_browser_override_is_passed_through(self):
        chrome = self.root / "chrome"
        chrome.write_bytes(b"#!")
        self.e.adapter(env={vv.BROWSER_ENV: str(chrome)}).submit(self.req(), vv.RULES_ENGINE)
        self.assertEqual(self.e.rendered[0]["browser"], str(chrome))

    def test_a_registry_ahead_of_the_code_is_refused(self):
        with self.assertRaises(AdapterError) as cm:
            self.e.adapter().submit(self.req(), "voice-explainer-model-1")
        self.assertEqual((cm.exception.code, cm.exception.not_accepted), (E_NOT_FOUND, True))
        self.assertEqual(self.e.rendered, [])

    def test_a_look_is_required_and_never_defaulted(self):
        for look in (None, "", "sepia", "warm"):
            with self.assertRaises(AdapterError) as cm:
                self.e.adapter().submit(self.req(look), vv.RULES_ENGINE)
            self.assertEqual(cm.exception.code, E_BAD_REQUEST, look)
        self.assertEqual((self.e.transcribed, self.e.rendered), ([], []))

    def test_exactly_one_recording_that_was_copied_here(self):
        for media in ((), (str(self.rec), str(self.rec)), (str(self.root / "missing.mp3"),)):
            with self.assertRaises(AdapterError) as cm:
                self.e.adapter().submit(self.req(media=media), vv.RULES_ENGINE)
            self.assertEqual(cm.exception.code, E_BAD_REQUEST, media)

    def test_longer_than_the_engine_holds_is_refused_before_the_transcription(self):
        self.seconds.return_value = 600.5
        with self.assertRaises(AdapterError) as cm:
            self.e.adapter().submit(self.req(), vv.RULES_ENGINE)
        self.assertEqual(cm.exception.code, E_BAD_REQUEST)
        self.assertIn("trim it first", cm.exception.message)
        self.assertEqual(self.e.transcribed, [])
        self.assertFalse((self.input / "voice-video").exists())

    def test_a_recording_that_does_not_decode_names_the_persons_fix(self):
        def broken(src, dst):
            raise AdapterError(E_BAD_REQUEST, "the recording could not be decoded as sound", not_accepted=True)

        with self.assertRaises(AdapterError) as cm:
            self.e.adapter(decode=broken).submit(self.req(), vv.RULES_ENGINE)
        self.assertEqual(cm.exception.code, E_BAD_REQUEST)
        self.assertEqual((self.e.transcribed, self.e.rendered), ([], []))
        self.assertFalse((self.input / "voice-video").exists())

    def test_a_decoded_copy_that_cannot_be_measured_is_the_machines_failure_not_the_persons(self):
        self.seconds.side_effect = ve.ExplainerError("cannot read")
        with self.assertRaises(AdapterError) as cm:
            self.e.adapter().submit(self.req(), vv.RULES_ENGINE)
        self.assertEqual(cm.exception.code, E_BAD_RESPONSE)
        self.assertNotIn("upload", cm.exception.message)

    def test_a_length_other_than_the_one_priced_is_refused_before_the_transcription(self):
        # The library measured (and the job was priced on) 3.0 s; within a second either way is the same recording.
        for priced in (2.0, 4.0, 3.0 + 0.999):
            self.e.adapter().submit(self.req(source_seconds=priced), vv.RULES_ENGINE)
        for priced in (1.9, 4.1, 30.0):
            n = len(self.e.transcribed)
            with self.assertRaises(AdapterError) as cm:
                self.e.adapter().submit(self.req(source_seconds=priced), vv.RULES_ENGINE)
            self.assertEqual(cm.exception.code, E_BAD_REQUEST, priced)
            self.assertIn("the length it was priced on", cm.exception.message)
            self.assertEqual(len(self.e.transcribed), n, "refused before Whisper runs")

    def test_no_words_heard_is_a_refusal_never_a_silent_or_empty_video(self):
        self.e.words = []
        with self.assertRaises(AdapterError) as cm:
            self.e.adapter().submit(self.req(), vv.RULES_ENGINE)
        self.assertEqual(cm.exception.code, E_BAD_REQUEST)
        self.assertIn("no words were heard", cm.exception.message)
        self.assertEqual(self.e.rendered, [])

    def test_a_word_track_that_is_not_this_recordings_is_refused(self):
        self.e.words = [{"word": "late", "start": 10.0, "end": 11.0}]
        with self.assertRaises(AdapterError) as cm:
            self.e.adapter().submit(self.req(), vv.RULES_ENGINE)
        self.assertEqual(cm.exception.code, E_BAD_REQUEST)
        self.assertEqual(self.e.rendered, [])

    def test_a_transcription_that_crashes_is_the_engines_failure_not_no_words(self):
        a = self.e.adapter(transcribe=mock.Mock(side_effect=RuntimeError("torch exploded")))
        with self.assertRaises(AdapterError) as cm:
            a.submit(self.req(), vv.RULES_ENGINE)
        self.assertEqual(cm.exception.code, E_BAD_RESPONSE)
        self.assertNotIn("no words", cm.exception.message)

    def test_a_render_failure_keeps_the_machines_paths_out_of_the_job_row(self):
        self.e.render_error = ve.RenderFailed(f"Remotion failed (exit 1): Error at {self.root}/secret/path.tsx")
        with self.assertLogs(vv.logger, level=logging.WARNING) as logs:
            with self.assertRaises(AdapterError) as cm:
                self.e.adapter().submit(self.req(), vv.RULES_ENGINE)
        self.assertEqual((cm.exception.code, cm.exception.not_accepted), (E_BAD_RESPONSE, True))
        self.assertNotIn(str(self.root), cm.exception.message)
        self.assertIn("nothing was charged", cm.exception.message)
        self.assertIn("secret/path.tsx", "\n".join(logs.output))
        self.assertFalse((self.input / "voice-video").exists(), "a failed render leaves nothing behind")

    def test_a_render_that_runs_out_of_time_says_try_later(self):
        self.e.render_error = ve.RenderTimeout("the render took longer than 618 s and was stopped")
        with self.assertRaises(AdapterError) as cm:
            self.e.adapter().submit(self.req(), vv.RULES_ENGINE)
        self.assertEqual(cm.exception.code, E_UNAVAILABLE)
        self.assertIn("try again later", cm.exception.message)

    def test_one_render_at_a_time_in_this_process_and_a_second_is_refused_never_waited_for(self):
        seen = []

        def render(*a, **kw):
            seen.append(vv._RENDER_LOCK.locked())
            return self.e.render(*a, **kw)

        self.e.adapter(render=render).submit(self.req(), vv.RULES_ENGINE)
        self.assertEqual(seen, [True])
        self.assertFalse(vv._RENDER_LOCK.locked())
        # Waiting would keep the job in 'submitting', where it can no longer be cancelled: refused at once instead.
        with vv._RENDER_LOCK:
            started = time.monotonic()
            with self.assertRaises(AdapterError) as cm:
                self.e.adapter().submit(self.req(), vv.RULES_ENGINE)
            self.assertLess(time.monotonic() - started, 1.0)
        self.assertEqual((cm.exception.code, cm.exception.not_accepted), (E_UNAVAILABLE, True))
        self.assertIn("nothing was charged", cm.exception.message)
        self.assertEqual(len(self.e.rendered), 1)


class Stop(Tmp):
    """The worker told to stop (SIGTERM) while a voice video renders: the render's whole process tree is killed and the job
    fails now, its hold released, instead of rendering on until Docker's SIGKILL leaves it in 'submitting'."""

    def test_a_stop_kills_the_render_tree_and_fails_the_job_at_once(self):
        stop = threading.Event()
        started = threading.Event()
        procs = []

        def render(props, out, *, on_spawn, **kw):
            # A real process tree in its own group, as ve.render starts Remotion: a shell with a child that sleeps.
            p = subprocess.Popen(["sh", "-c", "sleep 60 & wait"], start_new_session=True,
                                 stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            procs.append(p)
            on_spawn(p)
            started.set()
            p.communicate()
            raise ve.RenderFailed(f"Remotion failed (exit {p.returncode})")

        threading.Thread(target=lambda: (started.wait(10), stop.set()), daemon=True).start()
        t0 = time.monotonic()
        with self.assertRaises(AdapterError) as cm:
            self.e.adapter(render=render, stop=stop).submit(self.req(), vv.RULES_ENGINE)
        self.assertLess(time.monotonic() - t0, 15)
        self.assertEqual((cm.exception.code, cm.exception.not_accepted), (E_UNAVAILABLE, True))
        self.assertIn("nothing was charged", cm.exception.message)
        (p,) = procs
        # SIGKILL reached the shell through its process group (nothing signals it directly), so its child got it too.
        self.assertEqual(p.returncode, -signal.SIGKILL)
        self.assertFalse((self.input / "voice-video").exists(), "the render's scratch is gone")
        self.assertFalse(vv._RENDER_LOCK.locked())

    def test_a_stop_before_the_render_starts_renders_nothing(self):
        stop = threading.Event()
        stop.set()
        with self.assertRaises(AdapterError) as cm:
            self.e.adapter(stop=stop).submit(self.req(), vv.RULES_ENGINE)
        self.assertEqual(cm.exception.code, E_UNAVAILABLE)
        self.assertEqual((self.e.decoded, self.e.rendered), ([], []))

    def test_a_render_process_that_starts_after_the_stop_is_killed_as_it_starts(self):
        stop = threading.Event()
        a = self.e.adapter(stop=stop)
        killed = []

        def render(props, out, *, on_spawn, **kw):
            stop.set()  # the stop lands while the render is still copying its files
            p = subprocess.Popen(["sleep", "60"], start_new_session=True)
            on_spawn(p)
            killed.append(p.wait(timeout=10))
            raise ve.RenderFailed("killed")

        a._render = render
        with self.assertRaises(AdapterError) as cm:
            a.submit(self.req(), vv.RULES_ENGINE)
        self.assertEqual(cm.exception.code, E_UNAVAILABLE)
        self.assertEqual(killed, [-signal.SIGKILL])

    def test_the_default_stop_is_the_process_wide_one_the_runner_sets(self):
        from modules.capabilities import base

        self.assertIs(vv.VoiceVideoAdapter()._stop, base.SHUTDOWN)
        self.assertIn("SHUTDOWN.set()", (Path(__file__).resolve().parent.parent / "tools" / "creative_worker.py").read_text())


@unittest.skipUnless(shutil.which("ffmpeg") and shutil.which("ffprobe"), "needs the real ffmpeg and ffprobe (the worker image has them)")
class TheDecoder(unittest.TestCase):
    """The real ffmpeg on real files: a browser's streamed WebM (no duration in its header), a damaged file, and the whole
    adapter on that WebM with only Whisper and Remotion stood in."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        # What MediaRecorder writes: Opus in WebM, piped (so no duration and no cues are written into the header).
        self.webm = self.root / "job" / "input" / "source.webm"
        self.webm.parent.mkdir(parents=True)
        with self.webm.open("wb") as fh:
            subprocess.run(["ffmpeg", "-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=5", "-c:a", "libopus",
                            "-f", "webm", "pipe:1"], stdout=fh, check=True, timeout=60)

    def test_a_streamed_webm_has_no_length_of_its_own_and_the_decoded_copy_has_the_real_one(self):
        with self.assertRaises(ve.ExplainerError):
            ve.audio_seconds(self.webm)   # the failure this decode exists for
        wav = self.root / "n.wav"
        vv.decode_to_wav(self.webm, wav)
        self.assertAlmostEqual(ve.audio_seconds(wav), 5.0, delta=0.1)

    def test_a_damaged_file_is_the_persons_fix_and_keeps_paths_out_of_the_message(self):
        bad = self.root / "job" / "input" / "source.mp3"
        bad.write_bytes(b"ID3" + os.urandom(2048))
        with self.assertLogs(vv.logger, level=logging.WARNING):
            with self.assertRaises(AdapterError) as cm:
                vv.decode_to_wav(bad, self.root / "n.wav")
        self.assertEqual((cm.exception.code, cm.exception.not_accepted), (E_BAD_REQUEST, True))
        self.assertNotIn(str(self.root), cm.exception.message)
        self.assertNotIn("upload it again", cm.exception.message.replace("upload that", ""))

    def test_no_ffmpeg_is_the_operators_fix_never_upload_it_again(self):
        with mock.patch.object(vv.subprocess, "run", side_effect=FileNotFoundError("ffmpeg")):
            with self.assertRaises(AdapterError) as cm:
                vv.decode_to_wav(self.webm, self.root / "n.wav")
        self.assertEqual(cm.exception.code, E_NOT_CONFIGURED)
        self.assertNotIn("upload", cm.exception.message)

    def test_the_adapter_renders_a_streamed_webm_and_checks_it_against_the_priced_length(self):
        e = Engine(self.root / "machine")
        a = e.adapter(decode=vv.decode_to_wav)   # the real ffmpeg and ffprobe; Whisper and Remotion stood in
        e.words = [{"word": "Salom.", "start": 0.2, "end": 1.0}, {"word": "Dunyo.", "start": 1.4, "end": 2.4}]
        task = a.submit(CapabilityRequest(capability=VOICE_EXPLAINER, look="dusk", input_media=(str(self.webm),),
                                          source_seconds=5.0), vv.RULES_ENGINE)
        (r,) = e.rendered
        self.assertAlmostEqual(r["props"]["duration_s"], 5.0, delta=0.1)
        self.assertEqual(r["props"]["narration"], "narration.wav")
        self.assertEqual(task.outputs[0].path.read_bytes(), MP4)
        with self.assertRaises(AdapterError) as cm:
            e.adapter(decode=vv.decode_to_wav).submit(
                CapabilityRequest(capability=VOICE_EXPLAINER, look="dusk", input_media=(str(self.webm),), source_seconds=9.0),
                vv.RULES_ENGINE)
        self.assertEqual(cm.exception.code, E_BAD_REQUEST)


class TheEngineModule(unittest.TestCase):
    def test_render_takes_a_scratch_dir_and_hands_it_to_remotion(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            engine = root / "engine"
            (engine / "node_modules").mkdir(parents=True)
            seen = {}

            class Proc:
                returncode = 0
                pid = 1

                def __init__(self, cmd, **kw):
                    seen.update(kw)
                    seen["cmd"] = cmd
                    Path(cmd[5]).write_bytes(MP4)

                def communicate(self, timeout=None):
                    return "", ""

            with mock.patch.object(ve.subprocess, "Popen", Proc), mock.patch.object(ve.shutil, "which", return_value="/usr/bin/npx"):
                ve.render({"look": "dusk"}, root / "out.mp4", files={}, engine_dir=engine, tmp_dir=root / "scratch")
            self.assertEqual(seen["env"]["TMPDIR"], str((root / "scratch").resolve()))
            self.assertTrue(any(a.startswith(f"--public-dir={(root / 'scratch').resolve()}") for a in seen["cmd"]))

    def test_render_failures_are_typed(self):
        self.assertTrue(issubclass(ve.RenderTimeout, ve.RenderFailed))
        self.assertTrue(issubclass(ve.RenderFailed, ve.ExplainerError))


# ── the registry entry ────────────────────────────────────────────────────────

class Registry(unittest.TestCase):
    def test_it_ships_dark_and_is_our_own_engine(self):
        e = reg.load()[MODEL]
        self.assertEqual((e.provider, e.adapter, e.vendor_model), ("nightshift", "video.voice_explainer", vv.RULES_ENGINE))
        self.assertEqual(e.capabilities, (VOICE_EXPLAINER,))
        self.assertEqual(e.explainer_looks, EXPLAINER_LOOKS)
        self.assertEqual(e.max_source_seconds, 600)
        self.assertEqual(e.doc_source, "own_engine")
        # No price of ours in the file (the owner sets credit_prices), no vendor price at all, nothing confirmed.
        self.assertIsNone(e.raw["pricing"]["provider_usd_per_unit"])
        self.assertFalse(e.raw["pricing"]["confirmed"])
        self.assertNotIn("operator_preview", e.raw)
        self.assertNotIn("availability", e.raw)
        self.assertFalse(e.registry_only)
        self.assertNotIn(VOICE_EXPLAINER, REGISTRY_ONLY_CAPABILITIES)
        self.assertIn(VOICE_EXPLAINER, MEDIA_INPUT)

    def test_the_sync_row_carries_the_looks_and_the_limit_and_never_availability(self):
        (row,) = [r for r in reg.sync_rows(list(reg.load().values())) if r["id"] == MODEL]
        self.assertEqual(row["capabilities"], [VOICE_EXPLAINER])
        self.assertEqual(row["spec"]["explainer_looks"], list(EXPLAINER_LOOKS))
        self.assertEqual(row["spec"]["limits"]["max_source_seconds"], 600)
        for k in ("availability", "verified_at", "verified_probe_id"):
            self.assertNotIn(k, row["spec"])

    def test_the_probe_asks_what_is_sold_from_speech_in_a_look(self):
        e = reg.load()[MODEL]
        req = e.probe_request(voice_id="A" * 20, generated_speech="probe_speech.mp3")
        self.assertEqual((req.capability, req.look, req.prompt, req.voice_id, req.input_media),
                         (VOICE_EXPLAINER, "dusk", "", None, ("probe_speech.mp3",)))
        self.assertEqual(build_adapter(e.adapter, env={}).problems(req, e), [])

    def test_a_probe_where_the_engine_is_missing_says_what_is_missing_and_pays_for_nothing(self):
        from tools import probe_models as pm

        e = reg.load()[MODEL]
        with tempfile.TemporaryDirectory() as tmp, \
                mock.patch.object(vv.VoiceVideoAdapter, "missing", return_value=["npx is not on PATH: install Node 22"]), \
                mock.patch.object(pm, "probe_speech", side_effect=AssertionError("the speech is a paid call")):
            out = pm.run_probe(e, env={}, voice_id="A" * 20, workdir=Path(tmp))
        self.assertEqual((out.ok, out.code), (False, "not_configured"))
        self.assertIn("install Node 22", out.message)
        self.assertIn("engine=", pm.describe(e, {}, "A" * 20))
        self.assertIn("one paid call, then a local render", pm.describe(e, {}, "A" * 20))

    def test_the_rules_an_entry_must_keep(self):
        doc = json.loads(reg.REGISTRY_PATH.read_text())
        base = next(m for m in doc["models"] if m["id"] == MODEL)

        def errors(**over):
            m = json.loads(json.dumps(base))
            for k, v in over.items():
                if v is None:
                    m.pop(k, None)
                else:
                    m[k] = v
            return reg.validate(dict(doc, models=[x for x in doc["models"] if x["id"] != MODEL] + [m]))

        self.assertEqual(errors(), [])
        self.assertTrue(any("explainer_looks is required" in x for x in errors(explainer_looks=None)))
        self.assertTrue(errors(explainer_looks=["sepia"]))
        self.assertTrue(any("at most 600" in x for x in errors(limits={**base["limits"], "max_source_seconds": 900})))
        self.assertTrue(any("lists only voice_explainer" in x for x in errors(capabilities=["voice_explainer", "dub"])))
        self.assertTrue(any("own_engine" in x for x in errors(api_documented={**base["api_documented"], "source": "vendor_sdk"})))

    def test_a_look_is_checked_against_the_models_list(self):
        e = reg.load()[MODEL]
        narrow = reg._entry(dict(e.raw, explainer_looks=["paper"]))
        self.assertIn(f"{MODEL} does not draw the dusk look", narrow.problems(CapabilityRequest(capability=VOICE_EXPLAINER, look="dusk",
                                                                                              input_media=("x.mp3",))))
        self.assertIn(f"{MODEL} does not draw the (no look) look", e.problems(CapabilityRequest(capability=VOICE_EXPLAINER, input_media=("x.mp3",))))
        # Every other tool still refuses a look but relight.
        dub = next(m for m in reg.load().values() if "dub" in m.capabilities)
        self.assertIn("a look does not apply to dub", dub.problems(CapabilityRequest(capability="dub", look="dusk", target_language="uz",
                                                                                  input_media=("x.mp3",))))


# ── the seam and the worker ───────────────────────────────────────────────────

def vv_job(look="dusk", **over):
    return job(capability=VOICE_EXPLAINER, requested_model=MODEL, routed_model=MODEL,
               params={"source_asset_id": SRC, "look": look}, quantity="42", **over)


def audio_source(mime="audio/mpeg", kind="audio"):
    return {"ok": True, "asset_id": SRC, "storage_key": ml.storage_key(SRC), "mime": mime, "kind": kind,
            "variants": [], "duration_s": 41.3}


class Worker(Tmp):
    def setUp(self):
        super().setUp()
        self.media = self.root / "media"
        self.media.mkdir()
        self.out = self.root / "jobs"
        # The decoded copy measures what the library measured (audio_source's duration_s): the same recording.
        self.seconds.return_value = 41.3

    def run_job(self, j, source, store=None, adapter=None):
        put_asset(self.media, SRC, MP3)
        q = SourceQueue(j, source=source)
        e = reg.load()[MODEL]
        ra = ca.RegistryAdapter(e, adapter or self.e.adapter(), sync_store={})
        library = cw.Library(store=store, media_root=self.media) if store is not None else None
        w = cw.CreativeWorker(q, lambda m: ra if m == e.id else None, worker_id="w1", out_dir=self.out, credits=FakeCredits(),
                              enforce=True, sleep=lambda s: None, heartbeat_seconds=0, media_root=self.media, library=library)
        w.run_once()
        return q

    def test_the_look_reaches_the_adapter_and_the_recording_goes_as_media(self):
        req = cw.GenerationRequest(job_id="j", org_id=ORG, capability=VOICE_EXPLAINER, model=MODEL,
                                   params={"source_asset_id": SRC, "look": "golden"}, input_files=(self.rec,))
        c = ca.capability_request(req)
        self.assertEqual((c.look, c.input_media, c.input_images, c.prompt), ("golden", (str(self.rec),), (), ""))
        # relight keeps its look; a tool with no look never gets one, whatever the params say.
        self.assertIsNone(ca.capability_request(cw.GenerationRequest(job_id="j", org_id=ORG, capability="dub", model="m",
                                                                     params={"look": "dusk"})).look)

    def test_a_job_runs_end_to_end_into_the_library_as_a_video(self):
        store = FakeStore()
        q = self.run_job(vv_job("paper"), audio_source(), store=store)
        self.assertTrue(q.finished["ok"], q.finished)
        self.assertEqual(self.e.rendered[0]["props"]["look"], "paper")
        self.assertTrue(any(c[0] == "advance" and c[1] == "submitted" and str(c[2]).startswith(ca.SYNC_PREFIX) for c in q.calls), q.calls)
        (row,) = store.rows
        self.assertEqual((row["org"], row["kind"]), (ORG, "video"))
        # Not a version of the recording (a video is not a new take of a voice), but it names it.
        self.assertIsNone(row["parent_asset_id"])
        self.assertEqual(row["provenance"]["source_asset_id"], SRC)
        self.assertEqual((row["provenance"]["capability"], row["provenance"]["provider"]), (VOICE_EXPLAINER, "nightshift"))
        # Usage is the database's quantity, in seconds; no dollar figure is made up.
        (cost,) = q.costs
        self.assertEqual((cost.provider, cost.unit, cost.quantity, cost.usd), ("nightshift", "second", 42.0, None))
        self.assertFalse((self.out / JOB).exists(), "the job folder is scratch once the library holds the video")

    def test_a_deployment_without_the_engine_fails_before_anything_runs(self):
        q = self.run_job(vv_job(), audio_source(), adapter=self.e.adapter(has_npx=lambda: False))
        self.assertEqual((q.finished["ok"], q.finished["error_code"]), (False, "not_configured"))
        self.assertEqual(self.e.rendered, [])

    def test_a_source_that_is_not_audio_is_refused_before_anything_runs(self):
        for source in (audio_source("video/mp4", "video"), audio_source("audio/mpeg", "video"), audio_source("video/mp4", "audio")):
            self.e.rendered.clear()
            q = self.run_job(vv_job(), source)
            self.assertEqual(q.finished["error_code"], "source_unavailable", source)
            self.assertEqual(self.e.rendered, [], source)

    def test_a_failed_render_fails_the_job_so_the_hold_is_released(self):
        self.e.render_error = ve.RenderFailed("Remotion failed (exit 1): x")
        q = self.run_job(vv_job(), audio_source())
        self.assertEqual((q.finished["ok"], q.finished["error_code"]), (False, "bad_response"))

    def test_a_worker_restart_between_render_and_store_loses_the_output_and_releases(self):
        # The sync key was stored, then the process died: the next claim finds a task nobody holds.
        q = SourceQueue(vv_job(provider_task_id=ca.SYNC_PREFIX + "0" * 32), source=audio_source())
        e = reg.load()[MODEL]
        ra = ca.RegistryAdapter(e, self.e.adapter(), sync_store={})
        w = cw.CreativeWorker(q, lambda m: ra, worker_id="w1", out_dir=self.out, credits=FakeCredits(), enforce=True,
                              sleep=lambda s: None, heartbeat_seconds=0, media_root=self.media)
        w.run_once()
        self.assertEqual((q.finished["ok"], q.finished["error_code"]), (False, "output_lost"))
        self.assertEqual(self.e.rendered, [], "never rendered (and paid) twice")


# ── the worker's one slot for a render on this machine, and its scratch ───────────

VJOB_B = "0f0e0d0c-0b0a-4000-8000-00000000000b"
TJOB = "0f0e0d0c-0b0a-4000-8000-0000000000c1"


class SlotQueue:
    """Several jobs, with 0036's rules for the steps the slot uses (submitting once, requeue only before a send)."""

    def __init__(self, jobs, source):
        self.waiting = [dict(j) for j in jobs]
        self.state = {}
        self.calls = []
        self.finished = {}
        self.source = source
        self.lost = set()

    def claim(self, worker_id, stale_minutes=10):
        self.calls.append(("claim",))
        if not self.waiting:
            return None
        j = self.waiting.pop(0)
        self.state[j["id"]] = j
        return dict(j)

    def heartbeat(self, job_id, worker_id):
        self.calls.append(("heartbeat", job_id))
        return job_id not in self.lost

    def advance(self, job_id, worker_id, step, task_id=None, route=None):
        self.calls.append(("advance", job_id, step))
        j = self.state[job_id]
        if job_id in self.lost:
            return False
        if step == "submitting":
            if j.get("submit_started_at") or j.get("provider_task_id"):
                return False
            j["submit_started_at"] = "now"
        elif step == "submitted":
            j["provider_task_id"] = task_id
        elif step == "requeue":
            if j.get("submit_started_at") and not j.get("provider_task_id"):
                return False
            self.waiting.append(dict(j))
        return True

    def steps(self, job_id):
        return [c[2] for c in self.calls if c[0] == "advance" and c[1] == job_id]

    def finish(self, job_id, worker_id, ok, *, charge=None, result=None, error_code=None, error=None):
        self.finished[job_id] = {"ok": ok, "error_code": error_code, "result": result}
        return {"status": "completed" if ok else "failed"}

    def job_source(self, job_id, worker_id):
        return self.source

    def attach_assets(self, job_id, worker_id, ids):
        return True

    def record_cost(self, job_id, usage):
        pass

    def reroute(self, job_id, worker_id, code):
        return None


class TheSlot(Tmp):
    """M1: a second voice video in the process is never sent while one renders, never blocks a thread, never starves the
    vendor jobs behind it, and stays cancellable; a stop hands it back uncharged."""

    def setUp(self):
        super().setUp()
        self.media = self.root / "media"
        self.media.mkdir()
        put_asset(self.media, SRC, MP3)
        self.out = self.root / "jobs"
        self.seconds.return_value = 41.3
        self.vendor = None
        self.paused = []
        self.addCleanup(lambda: cw._SERIAL_SLOT.release() if cw._SERIAL_SLOT.locked() else None)

    def worker(self, q, **kw):
        from tests.test_creative_worker import FakeAdapter

        e = reg.load()[MODEL]
        ra = ca.RegistryAdapter(e, self.e.adapter(), sync_store={})
        self.vendor = FakeAdapter()
        kw.setdefault("heartbeat_seconds", 0)
        return cw.CreativeWorker(q, lambda m: ra if m == e.id else self.vendor, worker_id="w1", out_dir=self.out,
                                 credits=FakeCredits(), enforce=True, sleep=self.paused.append, media_root=self.media, **kw)

    def test_busy_the_job_is_parked_unsent_vendor_jobs_run_and_it_runs_when_the_slot_frees(self):
        q = SlotQueue([vv_job(), job(id=TJOB)], audio_source())
        w = self.worker(q)
        with cw._SERIAL_SLOT:   # another thread of this process is rendering
            w.run_once()
            self.assertEqual(q.steps(JOB), [], "not marked submitting, so it can still be cancelled")
            self.assertEqual(len(w._parked), 1)
            self.assertNotIn(JOB, q.finished)
            w.run_once()        # the thread is free for the vendor job behind it
            self.assertTrue(q.finished[TJOB]["ok"])
            self.assertEqual(self.e.rendered, [])
        w.run_once()            # the slot is free: the parked job runs first, before any new claim
        self.assertEqual(q.steps(JOB)[:2], ["submitting", "submitted"])
        self.assertTrue(q.finished[JOB]["ok"], q.finished)
        self.assertEqual(len(self.e.rendered), 1)
        self.assertEqual(w._parked, [])
        self.assertFalse(cw._SERIAL_SLOT.locked())

    def test_the_slot_is_held_through_the_whole_job_and_released_on_failure(self):
        seen = []
        real = self.e.render

        def render(*a, **kw):
            seen.append(cw._SERIAL_SLOT.locked())
            return real(*a, **kw)

        self.e.render = render
        q = SlotQueue([vv_job()], audio_source())
        self.worker(q).run_once()
        self.assertEqual(seen, [True])
        self.e.render_error = ve.RenderFailed("x")
        q = SlotQueue([vv_job()], audio_source())
        self.worker(q).run_once()
        self.assertEqual(q.finished[JOB]["error_code"], "bad_response")
        self.assertFalse(cw._SERIAL_SLOT.locked())

    def test_a_parked_job_that_is_cancelled_is_dropped_and_never_sent(self):
        q = SlotQueue([vv_job()], audio_source())
        w = self.worker(q, heartbeat_seconds=0.01)
        with cw._SERIAL_SLOT:
            w.run_once()
            q.lost.add(JOB)     # cancelled in the Studio: the heartbeat answers no
            deadline = time.monotonic() + 5
            while not w._parked[0][1].lost.is_set() and time.monotonic() < deadline:
                time.sleep(0.01)
        self.assertFalse(w.run_once())
        self.assertEqual((w._parked, q.steps(JOB), q.finished), ([], [], {}))
        self.assertEqual(self.e.rendered, [])

    def test_a_stop_hands_every_parked_job_back_uncharged(self):
        q = SlotQueue([vv_job()], audio_source())
        w = self.worker(q)
        with cw._SERIAL_SLOT:
            w.run_once()
            w.stop.set()
            w.run_forever(idle_seconds=0)
        self.assertEqual(q.steps(JOB), ["requeue"])
        self.assertEqual((w._parked, q.finished), ([], {}))
        self.assertEqual([j["id"] for j in q.waiting], [JOB], "back in the queue for the next start")

    def test_a_voice_job_claimed_as_the_worker_stops_goes_back_to_the_queue_not_to_failed(self):
        q = SlotQueue([vv_job()], audio_source())
        w = self.worker(q)
        w.stop.set()
        w.run_once()
        self.assertEqual((q.steps(JOB), q.finished, self.e.rendered), (["requeue"], {}, []))
        self.assertFalse(cw._SERIAL_SLOT.locked())

    def test_past_the_parking_room_a_claim_is_handed_back_and_the_thread_pauses(self):
        jobs = [vv_job(id=f"0f0e0d0c-0b0a-4000-8000-{i:012d}") for i in range(cw.MAX_PARKED + 1)]
        q = SlotQueue(jobs, audio_source())
        w = self.worker(q)
        with cw._SERIAL_SLOT:
            for _ in range(cw.MAX_PARKED + 1):
                w.run_once()
        self.assertEqual(len(w._parked), cw.MAX_PARKED)
        last = jobs[-1]["id"]
        self.assertEqual(q.steps(last), ["requeue"])
        self.assertEqual(self.paused, [cw.BUSY_PAUSE_SECONDS])
        self.assertEqual(q.finished, {})
        w.hand_back_parked()

    def test_a_vendor_job_takes_no_slot(self):
        q = SlotQueue([job(id=TJOB)], audio_source())
        with cw._SERIAL_SLOT:
            self.worker(q).run_once()
        self.assertTrue(q.finished[TJOB]["ok"])

    def test_the_voice_job_folder_is_gone_on_every_way_out(self):
        # A failed render, a task id that could not be stored (the job is no longer ours), and a source that is refused.
        for case in ("render", "submitted", "source"):
            self.e.render_error = ve.RenderFailed("x") if case == "render" else None
            q = SlotQueue([vv_job()], audio_source("video/mp4", "video") if case == "source" else audio_source())
            if case == "submitted":
                real = q.advance
                q.advance = lambda jid, wid, step, task_id=None, route=None: (
                    False if step == "submitted" else real(jid, wid, step, task_id, route))
            self.worker(q).run_once()
            self.assertFalse((self.out / JOB).exists(), case)

    def test_a_completed_job_without_the_library_keeps_its_video_and_drops_its_scratch(self):
        q = SlotQueue([vv_job()], audio_source())
        self.worker(q).run_once()
        self.assertTrue(q.finished[JOB]["ok"])
        self.assertEqual(sorted(p.name for p in (self.out / JOB).iterdir()), ["output_0.mp4"])


class Sweep(unittest.TestCase):
    def test_old_input_copies_go_and_kept_outputs_fresh_jobs_and_other_folders_stay(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            now = time.time()
            old, fresh, kept = (root / f"0f0e0d0c-0b0a-4000-8000-00000000000{i}" for i in (1, 2, 3))
            for d in (old, fresh, kept):
                (d / "input" / "voice-video").mkdir(parents=True)
                (d / "input" / "source.webm").write_bytes(b"x")
            (kept / "output_0.mp4").write_bytes(MP4)
            other = root / "not-a-job" / "input"
            other.mkdir(parents=True)
            for d in (old / "input", kept / "input", other):
                os.utime(d, (now - 30 * 3600, now - 30 * 3600))
            self.assertEqual(cw.sweep_scratch(root, now=now), 2)
            self.assertFalse(old.exists(), "an empty job folder goes with its input")
            self.assertTrue((fresh / "input" / "source.webm").exists(), "a job of the last day may still be running")
            self.assertEqual([p.name for p in kept.iterdir()], ["output_0.mp4"])
            self.assertTrue(other.exists(), "only folders named by a job id are touched")
            self.assertEqual(cw.sweep_scratch(root / "missing", now=now), 0)

    def test_the_runner_sweeps_before_any_thread_claims(self):
        text = (Path(__file__).resolve().parent.parent / "tools" / "creative_worker.py").read_text()
        self.assertLess(text.index("cw.sweep_scratch(out_dir)"), text.index("threads = [threading.Thread"))


@unittest.skipUnless(os.environ.get("NIGHTSHIFT_VOICE_VIDEO_E2E"), "opt-in: a real render (needs npm ci in video-engine/ and a browser)")
class TheRealEngine(unittest.TestCase):
    """NIGHTSHIFT_VOICE_VIDEO_E2E=<narration.mp3>[:<words.json>] — the real Remotion render through the adapter. Whisper is used
    unless a word track is given (a container without torch passes the narration's own track)."""

    def test_a_real_render(self):
        spec = os.environ["NIGHTSHIFT_VOICE_VIDEO_E2E"]
        audio, _, words = spec.partition(":")
        with tempfile.TemporaryDirectory() as tmp:
            over = {}
            if words:
                # The narration's own word track stands in for Whisper (said so in the report): everything else is real.
                track = json.loads(Path(words).read_text(encoding="utf-8"))
                model = Path(tmp) / "whisper"
                model.mkdir()
                (model / vv.WHISPER_FILE).write_bytes(b"stand-in")
                over = {"transcribe": lambda *_a: track.get("words", track) if isinstance(track, dict) else track,
                        "whisper_installed": lambda: True, "whisper_dirs": (model,)}
            src = Path(tmp) / "job" / "input" / ("source" + Path(audio).suffix)
            src.parent.mkdir(parents=True)
            shutil.copyfile(audio, src)
            a = vv.VoiceVideoAdapter(env=os.environ, **over)
            self.assertEqual(a.missing(), [])
            task = a.submit(CapabilityRequest(capability=VOICE_EXPLAINER, look="dusk", input_media=(str(src),)), vv.RULES_ENGINE)
            (f,) = a.fetch(PollResult(SUCCEEDED, task.outputs), Path(tmp) / "out")
            self.assertGreater(f.stat().st_size, 10_000)
            keep = os.environ.get("NIGHTSHIFT_VOICE_VIDEO_E2E_KEEP")
            if keep:
                shutil.copyfile(f, keep)


if __name__ == "__main__":
    unittest.main()

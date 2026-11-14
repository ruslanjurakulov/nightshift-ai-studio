"""Voice to video (migration 0171) on the worker: the adapter of our own engine, the registry entry, the seam and the worker.

The render is replaced by a fake and the transcription's HTTP layer by a fake session (a real render is opt-in,
test_the_real_engine below); nothing touches a network or spends anything. What must hold:

* "configured" means the engine is installed on THIS machine (npx, video-engine/node_modules, the sound effects, Inter) and
  the ElevenLabs key is in its env; anything missing fails the job before anything runs, naming the fix (the key by its
  NAME, never Whisper), and the hold is released;
* the words come from ElevenLabs Scribe and from nothing else: no local Whisper fallback, each vendor refusal named by the
  vendor's own word with its fix, a stop or the time limit failing the job at once, an empty transcript the adapter's own
  "no words" refusal, and the key in no message and no log line;
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
from modules.capabilities.audio import scribe_form
from modules.capabilities.base import (
    E_AUTH,
    E_BAD_REQUEST,
    E_BAD_RESPONSE,
    E_NOT_CONFIGURED,
    E_NOT_FOUND,
    E_QUOTA,
    E_RATE_LIMITED,
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
from tests.test_capabilities import FakeResp
from tests.test_creative_media_inputs import FakeStore, SourceQueue, put_asset
from tests.test_creative_worker import JOB, ORG, FakeCredits, job

MODEL = "nightshift-voice-explainer"
SRC = "ab0c1d1e-0000-4000-8000-000000000171"
MP3 = b"ID3\x04\x00\x00\x00\x00\x00\x00" + b"\x00" * 512
MP4 = b"\x00\x00\x00\x18ftypisom\x00\x00\x02\x00isomiso2" + b"\x00" * 1024
WORDS = [{"word": "Salom.", "start": 0.1, "end": 0.6}, {"word": "Bu", "start": 0.9, "end": 1.1},
         {"word": "narx", "start": 1.2, "end": 1.6}, {"word": "10", "start": 1.7, "end": 2.0},
         {"word": "dollar.", "start": 2.1, "end": 2.6}]
#: Shaped like an ElevenLabs key, so a leak would be seen whatever form it takes in a message or a log line.
KEY = "sk_0123456789abcdef0123456789abcdef0123456789abcdef"
ENV = {vv.KEY_ENV: KEY}


def scribe_body(words, language="uzb"):
    """What Scribe answers: each word, then the vendor's own spacing entry; an audio event at the end."""
    entries = []
    for w in words:
        entries.append({"text": w["word"], "start": w["start"], "end": w["end"], "type": "word", "logprob": -0.1})
        entries.append({"text": " ", "start": w["end"], "end": w["end"], "type": "spacing"})
    entries.append({"text": "(music)", "start": 2.7, "end": 2.9, "type": "audio_event"})
    return {"language_code": language, "language_probability": 0.97, "text": "x", "words": entries}


def refusal(status, code, message="no", type_=None):
    return FakeResp(status, {"detail": {"type": type_ or code, "code": code, "message": message}})


class ScribeSession:
    """The transcription's HTTP layer: records each call (and the bytes uploaded) and answers with the engine's words, or
    ``engine.answer`` (a response or an exception), after ``engine.block`` is set when one is given."""

    def __init__(self, engine):
        self.engine = engine
        self.calls = []
        self.uploaded = []

    def request(self, method, url, **kw):
        self.calls.append((method, url, kw))
        files = kw.get("files") or {}
        if "file" in files:
            self.uploaded.append(files["file"][1].read())
        if self.engine.block is not None:
            self.engine.block.wait(30)
        answer = self.engine.answer
        if isinstance(answer, BaseException):
            raise answer
        return answer if answer is not None else FakeResp(200, scribe_body(self.engine.words))


class Engine:
    """A machine with the engine installed: a fake video-engine, the effects, and a fake Scribe behind the HTTP layer."""

    def __init__(self, root: Path):
        self.engine = root / "video-engine"
        (self.engine / "node_modules" / "remotion").mkdir(parents=True)
        (self.engine / "node_modules" / ".remotion").mkdir()
        self.sfx = root / "sfx"
        self.sfx.mkdir()
        for n in ve.SFX_NEEDED:
            (self.sfx / f"{n}.wav").write_bytes(b"RIFF")
        self.rendered = []
        self.sessions = []
        self.words = WORDS
        self.answer = None
        self.block = None
        self.render_error = None
        self.decoded = []

    @property
    def transcribed(self):
        """Every call made to the transcription, by every adapter this engine built."""
        return [c for s in self.sessions for c in s.calls]

    def decode(self, src, dst, **shape):
        # Stands in for ffmpeg (the real one is TheDecoder, below): the "WAV" is the recording's bytes.
        self.decoded.append((Path(src), Path(dst), shape))
        shutil.copyfile(src, dst)

    def render(self, props, out, *, files, engine_dir, browser, timeout_s, tmp_dir, on_spawn=None):
        self.rendered.append({"props": props, "out": Path(out), "files": dict(files), "engine_dir": engine_dir,
                              "browser": browser, "timeout_s": timeout_s, "tmp_dir": Path(tmp_dir), "on_spawn": on_spawn})
        if self.render_error:
            raise self.render_error
        Path(out).write_bytes(MP4)
        return Path(out)

    def adapter(self, env=None, key=True, **over):
        session = ScribeSession(self)
        self.sessions.append(session)
        kw = dict(env={**(ENV if key else {}), **(env or {})}, session=session, engine_dir=self.engine, sfx_dir=self.sfx,
                  render=self.render, has_npx=lambda: True, which=lambda name: f"/usr/bin/{name}",
                  font_family=lambda: "Inter", decode=self.decode, stop=threading.Event())
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
    def test_ready_means_the_engine_is_installed_and_the_elevenlabs_key_is_set(self):
        a = self.e.adapter()
        self.assertEqual(a.missing(), [])
        self.assertTrue(a.configured())
        # The key every ElevenLabs adapter reads, no new secret name; another vendor's key is not it.
        self.assertEqual(vv.VoiceVideoAdapter.key_env, ("ELEVENLABS_API_KEY",))
        bare = self.e.adapter(key=False, env={"OPENAI_API_KEY": "sk-whatever-1234567890"})
        self.assertFalse(bare.configured())
        (msg,) = bare.missing()
        self.assertIn("ELEVENLABS_API_KEY is not set", msg)

    def test_missing_names_the_key_never_whisper_and_whisper_is_not_needed(self):
        # Rule 4: Whisper is not a requirement, so it cannot be a quiet substitute either. With no whisper module at all
        # (an import would fail) the machine is ready; without the key, the key is what is named.
        with mock.patch.dict(sys.modules, {"whisper": None}):
            self.assertEqual(self.e.adapter().missing(), [])
            missing = self.e.adapter(key=False).missing()
        self.assertTrue(missing)
        self.assertFalse(any("whisper" in m.lower() for m in missing), missing)
        for gone in ("WHISPER_FILE", "SHARED_WHISPER_DIR", "whisper_transcribe", "whisper_root", "whisper_importable"):
            self.assertFalse(hasattr(vv, gone), gone)

    def test_the_key_is_never_in_what_is_missing_or_said_when_it_is_refused(self):
        a = self.e.adapter(has_npx=lambda: False)
        self.assertNotIn(KEY, " ".join(a.missing()))
        with self.assertRaises(AdapterError) as cm:
            a.submit(self.req(), vv.RULES_ENGINE)
        self.assertNotIn(KEY, str(cm.exception))

    def test_each_missing_part_is_named_with_its_fix(self):
        cases = {
            "npx": dict(has_npx=lambda: False),
            "npm ci": dict(engine_dir=self.root / "nowhere"),
            "ELEVENLABS_API_KEY is not set": dict(key=False),
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

    def test_not_ready_fails_before_anything_runs(self):
        a = self.e.adapter(has_npx=lambda: False)
        with self.assertRaises(AdapterError) as cm:
            a.submit(self.req(), vv.RULES_ENGINE)
        self.assertEqual(cm.exception.code, E_NOT_CONFIGURED)
        self.assertTrue(cm.exception.not_accepted)
        self.assertEqual((self.e.transcribed, self.e.rendered), ([], []))
        self.seconds.assert_not_called()

    def test_no_key_fails_before_anything_runs_and_nothing_is_sent(self):
        with self.assertRaises(AdapterError) as cm:
            self.e.adapter(key=False).submit(self.req(), vv.RULES_ENGINE)
        self.assertEqual((cm.exception.code, cm.exception.not_accepted), (E_NOT_CONFIGURED, True))
        self.assertIn("ELEVENLABS_API_KEY", cm.exception.message)
        self.assertEqual((self.e.decoded, self.e.transcribed, self.e.rendered), ([], [], []))

    def test_the_engine_build_pins_the_scribe_model_the_captions_job_sends(self):
        # A new Scribe model is a new engine id (and so a new probe), never a quiet swap under the old proof.
        self.assertEqual((vv.RULES_ENGINE, vv.SCRIBE_MODEL), ("voice-explainer-rules-2", "scribe_v2"))
        self.assertEqual(reg.load()["elevenlabs-scribe-v2"].vendor_model, vv.SCRIBE_MODEL)


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
        # The narration is rendered at its own rate; only a 16 kHz mono copy of it is sent to be transcribed.
        self.assertEqual(self.e.decoded, [(self.rec, work / "narration.wav", {}),
                                          (work / "narration.wav", work / "speech.wav", {"rate": 16000, "channels": 1})])
        self.assertFalse((work / "speech.wav").exists(), "the copy that was sent is gone once the words are back")
        self.assertEqual(sorted(k for k in r["files"] if k.startswith("sfx/")), ["sfx/deep_boom.wav", "sfx/whoosh.wav"])
        # The spoken number became a counter exactly as said; every scene comes from the words, not a model.
        # (The short greeting joins the next sentence: no scene flashes past.)
        self.assertEqual([s["visual"] for s in props["scenes"]], [{"kind": "stat", "value": "10", "label": "Salom Bu narx 10 dollar"}])
        self.assertEqual([w["text"] for w in props["words"]], [w["word"] for w in WORDS])
        # Scratch on the job's own volume (the creative worker's /tmp is a tmpfs), and a time limit from the recording.
        self.assertTrue(r["tmp_dir"].is_relative_to(self.input))
        self.assertEqual(r["timeout_s"], vv.RENDER_TIMEOUT_FLOOR_S + vv.RENDER_TIMEOUT_PER_SECOND * 3.0)
        self.assertIsNone(r["browser"])
        # One documented Scribe call: the captions job's form and model, the key in its header only, no language named
        # (0176's params carry none: the vendor detects it), the worker's own file name, a limit from the recording.
        ((method, url, kw),) = self.e.transcribed
        self.assertEqual((method, url), ("POST", "https://api.elevenlabs.io/v1/speech-to-text"))
        self.assertEqual(kw["headers"]["xi-api-key"], KEY)
        self.assertNotIn(KEY, url)
        self.assertEqual(kw["data"], scribe_form(vv.SCRIBE_MODEL))
        self.assertNotIn("language_code", kw["data"])
        self.assertEqual((kw["files"]["file"][0], kw["files"]["file"][2]), ("speech.wav", "audio/wav"))
        self.assertEqual(kw["timeout"], vv.scribe_timeout(3.0))
        self.assertIs(kw["allow_redirects"], False, "a redirect would carry the key to a host nobody checked")
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
            self.assertEqual(len(self.e.transcribed), n, "refused before anything is sent to be transcribed")

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
        a = self.e.adapter(transcribe=mock.Mock(side_effect=RuntimeError("socket exploded")))
        with self.assertRaises(AdapterError) as cm:
            a.submit(self.req(), vv.RULES_ENGINE)
        self.assertEqual(cm.exception.code, E_BAD_RESPONSE)
        self.assertNotIn("no words", cm.exception.message)
        self.assertNotIn("socket exploded", cm.exception.message)

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


class Scribe(Tmp):
    """The transcription: ElevenLabs speech-to-text, read by its own words, with no local fallback (CLAUDE.md rules 4, 6)."""

    def fail(self, **over):
        with self.assertRaises(AdapterError) as cm:
            self.e.adapter(**over).submit(self.req(), vv.RULES_ENGINE)
        self.assertEqual(self.e.rendered, [], "nothing is rendered from a failed transcription")
        self.assertFalse((self.input / "voice-video").exists(), "a failed transcription leaves nothing behind")
        self.assertFalse(vv._RENDER_LOCK.locked())
        return cm.exception

    def test_only_words_become_words_and_spacing_and_audio_events_are_dropped(self):
        self.e.adapter().submit(self.req(), vv.RULES_ENGINE)
        words = self.e.rendered[0]["props"]["words"]
        self.assertEqual([w["text"] for w in words], [w["word"] for w in WORDS])
        self.assertNotIn("(music)", [w["text"] for w in words])
        self.assertNotIn(" ", [w["text"] for w in words])

    def test_the_vendors_words_are_cleaned_as_the_captions_track_is(self):
        # Words are text from outside: control and bidi marks out, times forward, never a word before the one before it.
        self.e.words = [{"word": "Sa‮lom.", "start": 0.1, "end": 0.6}, {"word": "dunyo\u0007", "start": 0.4, "end": 1.0}]
        self.e.adapter().submit(self.req(), vv.RULES_ENGINE)
        words = self.e.rendered[0]["props"]["words"]
        self.assertEqual([w["text"] for w in words], ["Salom.", "dunyo"])
        self.assertGreaterEqual(words[1]["start_s"], words[0]["end_s"])

    def test_a_word_without_its_times_is_left_out_never_put_at_zero(self):
        self.e.words = [{"word": "Salom.", "start": 0.1, "end": 0.6}, {"word": "lost", "start": None, "end": None},
                        {"word": "Bu", "start": 0.9, "end": None}, {"word": "narx.", "start": 1.2, "end": 1.6}]
        with self.assertLogs(vv.logger, level=logging.WARNING) as logs:
            self.e.adapter().submit(self.req(), vv.RULES_ENGINE)
        self.assertEqual([w["text"] for w in self.e.rendered[0]["props"]["words"]], ["Salom.", "narx."])
        self.assertIn("2 of 4 words came back without their times", "\n".join(logs.output))
        self.assertNotIn("lost", "\n".join(logs.output), "the person's words are not logged")

    def test_words_that_all_lack_their_times_are_the_vendors_fault_never_no_speech(self):
        self.e.words = [{"word": "Salom", "start": None, "end": None}, {"word": "dunyo", "start": "x", "end": True}]
        e = self.fail()
        self.assertEqual(e.code, E_BAD_RESPONSE)
        self.assertIn("without their times", e.message)
        self.assertNotIn("no words were heard", e.message)

    def test_an_empty_transcript_is_the_adapters_own_no_speech_refusal(self):
        for body in ({"language_code": "uzb", "text": "", "words": []},
                     {"language_code": "uzb", "text": "", "words": [{"text": " ", "start": 0, "end": 1, "type": "spacing"},
                                                                   {"text": "(silence)", "start": 0, "end": 3,
                                                                    "type": "audio_event"}]}):
            self.e.answer = FakeResp(200, body)
            e = self.fail()
            self.assertEqual((e.code, e.not_accepted), (E_BAD_REQUEST, True), body)
            self.assertIn("no words were heard", e.message)
            self.assertIn("nothing was charged", e.message)

    def test_an_answer_that_is_not_a_transcript_is_a_bad_response(self):
        for answer in (FakeResp(200, "<html>"), FakeResp(200, {"transcripts": [{"words": []}]}), FakeResp(200, [])):
            self.e.answer = answer
            self.assertEqual(self.fail().code, E_BAD_RESPONSE)

    def test_each_vendor_word_becomes_its_code_and_names_its_fix(self):
        # (status, detail.code) -> our code, words of the fix, whether the refusal proves nothing was taken.
        cases = [
            (401, "invalid_api_key", E_AUTH, "set a valid ELEVENLABS_API_KEY", True),
            (401, "missing_api_key", E_AUTH, "set a valid ELEVENLABS_API_KEY", True),
            (401, "quota_exceeded", E_QUOTA, "top up ElevenLabs", True),          # the legacy shape: 401, not 402
            (402, "insufficient_credits", E_QUOTA, "top up ElevenLabs", True),
            (402, "payment_required", E_QUOTA, "top up ElevenLabs", True),
            (429, "rate_limit_exceeded", E_RATE_LIMITED, "try again in a few minutes", True),
            (429, "concurrent_limit_exceeded", E_RATE_LIMITED, "try again in a few minutes", True),
            (429, "system_busy", E_UNAVAILABLE, "try again later", False),
            (400, "invalid_audio_format", E_BAD_REQUEST, "export it again", False),
            (400, "request_too_large", E_BAD_REQUEST, "export it again", False),
            (503, "service_unavailable", E_UNAVAILABLE, "try again later", False),
        ]
        for status, word, code, fix, refused in cases:
            with self.subTest(word=word):
                self.e.answer = refusal(status, word, message=f"echo {KEY}")
                e = self.fail()
                self.assertEqual((e.code, e.http_status, e.not_accepted), (code, status, refused))
                self.assertIn(fix, e.message)
                self.assertIn(f"HTTP {status}, {word}", e.message)
                self.assertIn("nothing was charged", e.message)
                self.assertNotIn(KEY, e.message)
                self.assertNotIn("echo", e.message, "the vendor's text is never quoted")
        self.assertTrue(AdapterError(E_RATE_LIMITED).retryable and AdapterError(E_UNAVAILABLE).retryable)
        self.assertFalse(AdapterError(E_AUTH).retryable or AdapterError(E_QUOTA).retryable)

    def test_the_legacy_shape_and_a_body_without_a_word_still_get_a_code(self):
        self.e.answer = FakeResp(401, {"detail": {"status": "quota_exceeded", "message": "out of characters"}})
        self.assertEqual(self.fail().code, E_QUOTA)
        self.e.answer = FakeResp(401, "Unauthorized")
        self.assertEqual(self.fail().code, E_AUTH)
        self.e.answer = FakeResp(302, "", headers={"location": "https://elsewhere.example/"})
        self.assertEqual(self.fail().code, E_UNAVAILABLE)

    def test_a_failing_transcription_never_falls_back_to_local_whisper(self):
        whisper = mock.MagicMock()
        for answer in (refusal(402, "insufficient_credits"), refusal(429, "system_busy"), FakeResp(500, "boom"),
                       vv_requests().exceptions.ConnectionError("down")):
            self.e.answer = answer
            with mock.patch.dict(sys.modules, {"whisper": whisper}):
                self.fail()
        whisper.load_model.assert_not_called()
        self.assertEqual(len(self.e.transcribed), 4, "one call each, never retried inside the paid job")

    def test_a_request_that_times_out_says_try_later(self):
        self.e.answer = vv_requests().exceptions.ReadTimeout("read timed out")
        e = self.fail()
        self.assertEqual((e.code, e.not_accepted), (E_UNAVAILABLE, False))   # the vendor may have taken it
        self.assertIn("ReadTimeout", e.message)
        self.assertIn("try again later", e.message)

    def test_the_time_limit_grows_with_the_recording_and_is_capped(self):
        self.assertEqual(vv.scribe_timeout(0), vv.SCRIBE_TIMEOUT_FLOOR_S)
        self.assertEqual(vv.scribe_timeout(120), 60 + 0.5 * 120)
        self.assertEqual(vv.scribe_timeout(600), 360)
        self.assertEqual(vv.scribe_timeout(10_000), vv.SCRIBE_TIMEOUT_MAX_S)

    def test_a_transcription_that_hangs_past_its_limit_is_given_up_at_once(self):
        self.e.block = threading.Event()
        self.addCleanup(self.e.block.set)
        with mock.patch.object(vv, "scribe_timeout", return_value=0.2), mock.patch.object(vv, "SCRIBE_GRACE_S", 0.1):
            t0 = time.monotonic()
            e = self.fail()
        self.assertLess(time.monotonic() - t0, 5)
        self.assertEqual((e.code, e.not_accepted), (E_UNAVAILABLE, False))
        self.assertIn("try again later", e.message)

    def test_a_stop_during_the_transcription_fails_the_job_at_once(self):
        stop = threading.Event()
        self.e.block = threading.Event()
        self.addCleanup(self.e.block.set)
        sent = lambda: bool(self.e.transcribed)

        def stop_once_sent():
            deadline = time.monotonic() + 10
            while not sent() and time.monotonic() < deadline:
                time.sleep(0.01)
            stop.set()

        threading.Thread(target=stop_once_sent, daemon=True).start()
        t0 = time.monotonic()
        with self.assertLogs(vv.logger, level=logging.WARNING):
            e = self.fail(stop=stop)
        self.assertLess(time.monotonic() - t0, 5, "never the request's own limit, never Docker's grace")
        self.assertEqual((e.code, e.not_accepted), (E_UNAVAILABLE, False))
        self.assertIn("stopped while the recording was being transcribed", e.message)
        self.assertIn("nothing was charged", e.message)

    def test_a_stop_after_the_decode_sends_nothing(self):
        stop = threading.Event()

        def decode(src, dst, **shape):
            self.e.decode(src, dst, **shape)
            if shape:
                stop.set()   # the stop lands while the copy for transcription is made

        e = self.fail(stop=stop, decode=decode)
        self.assertEqual((e.code, e.not_accepted), (E_UNAVAILABLE, True))
        self.assertEqual(self.e.transcribed, [])

    def test_a_copy_for_transcription_that_fails_is_the_machines_fault(self):
        def decode(src, dst, **shape):
            if shape:
                raise AdapterError(E_BAD_REQUEST, "the recording could not be decoded as sound", not_accepted=True)
            self.e.decode(src, dst)

        e = self.fail(decode=decode)
        self.assertEqual(e.code, E_BAD_RESPONSE)
        self.assertNotIn("upload", e.message)

    def test_the_key_is_in_no_log_line_of_a_whole_job_or_of_a_failure(self):
        with self.assertLogs(level=logging.DEBUG) as logs:
            logging.getLogger().debug("start")
            self.e.adapter().submit(self.req(), vv.RULES_ENGINE)
            self.e.answer = refusal(401, "invalid_api_key", message=f"bad key {KEY}")
            with self.assertRaises(AdapterError):
                self.e.adapter().submit(self.req(), vv.RULES_ENGINE)
        joined = "\n".join(logs.output)
        self.assertNotIn(KEY, joined)
        self.assertNotIn(KEY[:12], joined)


def vv_requests():
    import requests  # noqa: PLC0415

    return requests


class SharedScribeHelpers(unittest.TestCase):
    """modules/capabilities/audio.py: the form and the vendor's words, shared with the captions job (0072)."""

    def test_the_form_is_the_captions_jobs(self):
        self.assertEqual(scribe_form("scribe_v2"), {"model_id": "scribe_v2", "timestamps_granularity": "word",
                                                    "diarize": "false", "tag_audio_events": "false"})
        self.assertEqual(scribe_form("scribe_v2", "uz")["language_code"], "uz")

    def test_the_vendors_word_is_read_and_its_message_never(self):
        from modules.capabilities.audio import elevenlabs_error_code, elevenlabs_error_word

        self.assertEqual(elevenlabs_error_word(json.dumps({"detail": {"type": "payment_required", "code": "insufficient_credits"}})),
                         "insufficient_credits")
        self.assertEqual(elevenlabs_error_word(json.dumps({"detail": {"status": "quota_exceeded"}})), "quota_exceeded")
        self.assertEqual(elevenlabs_error_word(json.dumps({"detail": {"type": "rate_limit_exceeded", "code": "Not A Word!"}})),
                         "rate_limit_exceeded")
        for text in ("", "not json", json.dumps({"detail": "quota exceeded"}), json.dumps([1]), json.dumps({"detail": {}})):
            self.assertIsNone(elevenlabs_error_word(text), text)
        self.assertIsNone(elevenlabs_error_code(400, json.dumps({"detail": {"code": "something_new"}})))
        self.assertEqual(elevenlabs_error_code(429, json.dumps({"detail": {"code": "system_busy"}})), E_UNAVAILABLE)


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
    adapter on that WebM with only Scribe's HTTP layer and Remotion stood in."""

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
        import io  # noqa: PLC0415
        import wave  # noqa: PLC0415

        e = Engine(self.root / "machine")
        rates = []
        real_render = e.render

        def render(props, out, **kw):
            with wave.open(str(kw["files"]["narration.wav"])) as w:
                rates.append(w.getframerate())
            return real_render(props, out, **kw)

        e.render = render
        a = e.adapter(decode=vv.decode_to_wav)   # the real ffmpeg and ffprobe; Scribe's HTTP layer and Remotion stood in
        e.words = [{"word": "Salom.", "start": 0.2, "end": 1.0}, {"word": "Dunyo.", "start": 1.4, "end": 2.4}]
        task = a.submit(CapabilityRequest(capability=VOICE_EXPLAINER, look="dusk", input_media=(str(self.webm),),
                                          source_seconds=5.0), vv.RULES_ENGINE)
        (r,) = e.rendered
        self.assertAlmostEqual(r["props"]["duration_s"], 5.0, delta=0.1)
        self.assertEqual(r["props"]["narration"], "narration.wav")
        # What went to ElevenLabs is a real 16 kHz mono 16-bit WAV of the whole recording (5 s = 160 kB, not the narration's
        # own 48 kHz), and the narration that is rendered keeps its own rate.
        (uploaded,) = a.session.uploaded
        with wave.open(io.BytesIO(uploaded)) as w:
            self.assertEqual((w.getnchannels(), w.getframerate(), w.getsampwidth()), (1, 16000, 2))
            self.assertAlmostEqual(w.getnframes() / 16000, 5.0, delta=0.1)
        self.assertEqual(rates, [48000])
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
        # Its transcription is an ElevenLabs Service inside a product we sell: gated on the plan like every ElevenLabs entry,
        # so the database refuses beta / ga until the owner has confirmed a Scale (or higher) plan and cleared it.
        self.assertEqual(e.terms_gate, "plan_required:scale")
        self.assertTrue(any("§2.B" in n for n in e.raw["terms_notes"]))
        self.assertIn("speech-to-text", e.raw["api_documented"]["evidence"])
        self.assertIn(vv.SCRIBE_MODEL, e.raw["api_documented"]["evidence"])
        self.assertEqual(e.capabilities, (VOICE_EXPLAINER,))
        self.assertEqual(e.explainer_looks, EXPLAINER_LOOKS)
        self.assertEqual(e.max_source_seconds, 600)
        self.assertEqual(e.doc_source, "own_engine")
        # No price of ours in the file (the owner sets credit_prices), and no single vendor price per second: Scribe's is
        # only part of the cost (it is in the note), and an operator preview quoted at it would be priced at the vendor
        # share alone (0139). Nothing confirmed.
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
        self.assertIn("engine+key=NO", pm.describe(e, {}, "A" * 20))
        self.assertIn("two paid calls (the speech, then its transcription), then a local render", pm.describe(e, {}, "A" * 20))

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
    """NIGHTSHIFT_VOICE_VIDEO_E2E=<narration.mp3>[:<words.json>] — the real Remotion render through the adapter. ElevenLabs Scribe
    is called (ONE PAID CALL, ELEVENLABS_API_KEY from the env) unless a word track is given."""

    def test_a_real_render(self):
        spec = os.environ["NIGHTSHIFT_VOICE_VIDEO_E2E"]
        audio, _, words = spec.partition(":")
        with tempfile.TemporaryDirectory() as tmp:
            over = {}
            if words:
                # The narration's own word track stands in for Scribe (said so in the report): everything else is real. The key
                # check still runs, so a placeholder value is enough for it; nothing is sent.
                track = json.loads(Path(words).read_text(encoding="utf-8"))
                over = {"transcribe": lambda *_a: track.get("words", track) if isinstance(track, dict) else track}
                env = {**os.environ, vv.KEY_ENV: os.environ.get(vv.KEY_ENV) or "unused-placeholder"}
            else:
                env = os.environ
            src = Path(tmp) / "job" / "input" / ("source" + Path(audio).suffix)
            src.parent.mkdir(parents=True)
            shutil.copyfile(audio, src)
            a = vv.VoiceVideoAdapter(env=env, **over)
            self.assertEqual(a.missing(), [])
            task = a.submit(CapabilityRequest(capability=VOICE_EXPLAINER, look="dusk", input_media=(str(src),)), vv.RULES_ENGINE)
            (f,) = a.fetch(PollResult(SUCCEEDED, task.outputs), Path(tmp) / "out")
            self.assertGreater(f.stat().st_size, 10_000)
            keep = os.environ.get("NIGHTSHIFT_VOICE_VIDEO_E2E_KEEP")
            if keep:
                shutil.copyfile(f, keep)


if __name__ == "__main__":
    unittest.main()

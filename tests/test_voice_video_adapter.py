"""Voice to video (migration 0170) on the worker: the adapter of our own engine, the registry entry, the seam and the worker.

The render and the transcription are replaced by fakes here (a real render is opt-in, test_the_real_engine below); nothing
touches a network or spends anything. What must hold:

* "configured" means the engine is installed on THIS machine (npx, video-engine/node_modules, Whisper and its model, the sound
  effects), never a key; anything missing fails the job before anything runs, naming the fix, and the hold is released;
* the person's recording and look are what is rendered: no planner model, no default look, no music, nothing else;
* every refusal is a named failure (no words, too long, unreadable, the render failing or timing out) and never a video of
  something else; the operator's log gets Remotion's tail, the job row never does (it names this machine's paths);
* the finished file is moved, not read into memory, into the job folder, and from there into the library as a video;
* the registry entry ships dark: no price, never probed, our own engine, one capability, the looks the database accepts.
"""

from __future__ import annotations

import json
import logging
import os
import shutil
import tempfile
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
SRC = "ab0c1d1e-0000-4000-8000-000000000170"
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

    def transcribe(self, audio, work_dir, root):
        self.transcribed.append((Path(audio), Path(work_dir), Path(root)))
        return list(self.words)

    def render(self, props, out, *, files, engine_dir, browser, timeout_s, tmp_dir):
        self.rendered.append({"props": props, "out": Path(out), "files": dict(files), "engine_dir": engine_dir,
                              "browser": browser, "timeout_s": timeout_s, "tmp_dir": Path(tmp_dir)})
        if self.render_error:
            raise self.render_error
        Path(out).write_bytes(MP4)
        return Path(out)

    def adapter(self, env=None, **over):
        kw = dict(env=env or {}, engine_dir=self.engine, sfx_dir=self.sfx, whisper_dirs=(self.whisper,),
                  transcribe=self.transcribe, render=self.render, has_npx=lambda: True, whisper_installed=lambda: True)
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
        }
        for fix, over in cases.items():
            a = self.e.adapter(**over)
            self.assertFalse(a.configured(), fix)
            self.assertTrue(any(fix in m for m in a.missing()), (fix, a.missing()))
        a = self.e.adapter(env={vv.BROWSER_ENV: str(self.root / "no-chrome")})
        self.assertIn(f"{vv.BROWSER_ENV} does not point at a file", " ".join(a.missing()))

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
        self.assertEqual((props["narration"], props["music"], props["captions"]), ("narration.mp3", "", True))
        self.assertEqual(r["files"]["narration.mp3"], self.rec)
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
        self.assertEqual((transcribed[0], transcribed[2]), (self.rec, self.e.whisper))
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

    def test_an_unreadable_recording_names_the_fix(self):
        self.seconds.side_effect = ve.ExplainerError("cannot read")
        with self.assertRaises(AdapterError) as cm:
            self.e.adapter().submit(self.req(), vv.RULES_ENGINE)
        self.assertEqual(cm.exception.code, E_BAD_REQUEST)
        self.assertIn("upload it again", cm.exception.message)

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

    def test_one_render_at_a_time_in_this_process(self):
        seen = []

        def render(*a, **kw):
            seen.append(vv._RENDER_LOCK.locked())
            return self.e.render(*a, **kw)

        self.e.adapter(render=render).submit(self.req(), vv.RULES_ENGINE)
        self.assertEqual(seen, [True])
        self.assertFalse(vv._RENDER_LOCK.locked())


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

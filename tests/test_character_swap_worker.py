"""Character Studio's worker (modules/character_swap.py, tools/character_swap_worker.py), with the database, the vendor and the media
library faked: nothing here touches a network, a database or a vendor, and nothing is paid for.

What would break:
* the switch: off means the worker connects to nothing; a missing setting is a remedy and exit 2, never a half-configured run;
* no paid call on an input the vendor refuses (length, size, frame rate, too many pictures) or on words the screen refuses;
* one job, one paid task: the task id is recorded BEFORE the first poll, a resumed job polls and never submits, a lost submit is never
  retried and the person is not charged;
* the result goes into the library as 'generated' with the job in its provenance (the database's finish checks exactly that), stored as
  the vendor made it (no re-mux or re-encode: its provenance and any mark stay, docs/AI_DISCLOSURE.md);
* the signed input link is the web app's own (lib/server/media.ts): the same payload, the same HMAC, at most an hour.
"""

import base64
import hashlib
import hmac
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from modules import character_swap as cs
from modules import model_registry as reg
from modules.capabilities.base import FAILED, PENDING, SUCCEEDED, AdapterError, Output, PollResult, ProviderTask
from tools import character_swap_worker as cli

SECRET = b"s" * 40
ORIGIN = "https://studio.example.com"
JOB = "0b8f2c51-6f7c-4f1e-9a43-111111111111"
VID = "11111111-1111-1111-1111-111111111111"
PIC = "22222222-2222-2222-2222-222222222222"


def claimed(model="kling-4.0-omni-edit", **over):
    job = {"job_id": JOB, "org_id": "33333333-3333-3333-3333-333333333333", "project_id": None, "model": model, "resolution": "720p",
           "prompt": "Replace the person on the left with @Image 1", "credits": 18.8, "resume": False, "provider_task_id": None,
           "input": {"id": VID, "mime": "video/mp4", "bytes": 5_000_000, "width": 1280, "height": 720, "duration_s": 10},
           "references": [{"id": PIC, "mime": "image/png", "bytes": 1000, "width": 512, "height": 512}], "end_user": "org-abc"}
    job.update(over)
    return job


class Store:
    def __init__(self, job):
        self.job, self.calls = job, []

    def claim(self, worker):
        self.calls.append(("claim",))
        job, self.job = self.job, None
        return job

    def record_task(self, job, worker, task):
        self.calls.append(("record_task", task))
        return {"id": job, "task": task}

    def finish(self, job, worker, output):
        self.calls.append(("finish", output))
        return {"status": "ready"}

    def fail(self, job, worker, code):
        self.calls.append(("fail", code))
        return {"status": "failed"}


class Adapter:
    def __init__(self, polls=(), submit_error=None, problems=()):
        self.polls, self.submit_error, self._problems, self.calls = list(polls), submit_error, list(problems), []
        self.fetch_dir = None

    def problems(self, request, entry):
        self.calls.append(("problems", request))
        return self._problems

    def submit(self, request, vendor_model, *, external_id=None):
        self.calls.append(("submit", request, vendor_model, external_id))
        if self.submit_error:
            raise self.submit_error
        return ProviderTask("video.kling_omni", vendor_model, "T-1")

    def poll(self, task):
        self.calls.append(("poll", task.task_id))
        return self.polls.pop(0) if self.polls else PollResult(PENDING)

    def fetch(self, result, out_dir, stem="output"):
        p = Path(out_dir) / f"{stem}_0.mp4"
        p.write_bytes(b"\x00\x00\x00\x18ftypmp42")
        return [p]


class Tools:
    ffmpeg, ffprobe = "ffmpeg", "ffprobe"


#: The likeness policy on: these tests are about the swap itself; LikenessPolicy below pins the off state.
POLICY_ON = {"NIGHTSHIFT_LIKENESS_FEATURES": "on"}


def worker(job, adapter, *, tools=Tools(), store=None, policy_env=POLICY_ON):
    tmp = Path(tempfile.mkdtemp())
    st = store or Store(job)
    w = cs.CharacterSwapWorker(st, worker_id="w-1", library=cs.Library(store=object(), media_root=tmp, tools=tools), scratch=tmp / "s",
                               origin=ORIGIN, secret=SECRET, registry=reg.registry(), build_adapter=lambda key: adapter,
                               policy_env=policy_env, sleep=lambda s: None)
    return w, st, tmp


def done():
    return PollResult(SUCCEEDED, [Output("video/mp4", url="https://v15-kling.klingai.com/out.mp4")])


class Patched(unittest.TestCase):
    """copy_source, ffprobe and store_generated are the media library's: faked so the job's own decisions are what is tested."""

    def setUp(self):
        src = Path(tempfile.mkdtemp()) / "source.mp4"
        src.write_bytes(b"\x00\x00\x00\x18ftypmp42")
        self.stored = []
        self.probe = {"fps": 30.0, "seconds": 10.0, "audio": True}
        patches = [mock.patch("modules.media_library.copy_source", lambda *a, **k: src),
                   mock.patch.object(cs, "probe", lambda *a, **k: dict(self.probe)),
                   mock.patch("modules.media_library.store_generated", lambda path, **kw: self.stored.append((path, kw)) or {"id": kw["asset_id"]})]
        for p in patches:
            p.start()
            self.addCleanup(p.stop)


class LikenessPolicy(Patched):
    """modules/likeness_policy.py: the payment terms forbid selling a real-person swap. A job that reaches the worker anyway (an RPC
    called directly, a job queued before the switch went off) is failed with feature_unavailable_policy, which releases its hold."""

    def test_policy_off_fails_the_job_before_any_vendor_call_or_library_write(self):
        for env in ({}, {"NIGHTSHIFT_LIKENESS_FEATURES": ""}, {"NIGHTSHIFT_LIKENESS_FEATURES": "1"},
                    {"NIGHTSHIFT_LIKENESS_FEATURES": "true"}, {"NIGHTSHIFT_LIKENESS_FEATURES": "off"}):
            a = Adapter(polls=[done()])
            w, st, _ = worker(claimed(), a, policy_env=env)
            self.assertTrue(w.run_once())
            self.assertEqual(st.calls, [("claim",), ("fail", "feature_unavailable_policy")], env)
            self.assertEqual(a.calls, [], env)
            self.assertEqual(self.stored, [], env)

    def test_a_resumed_job_with_a_recorded_task_is_refused_too_never_finished_and_charged(self):
        a = Adapter(polls=[done()])
        w, st, _ = worker(claimed(resume=True, provider_task_id="T-1"), a, policy_env={})
        w.run_once()
        self.assertEqual(st.calls, [("claim",), ("fail", "feature_unavailable_policy")])
        self.assertNotIn("finish", [c[0] for c in st.calls])

    def test_policy_on_trimmed_any_case_runs_the_job(self):
        a = Adapter(polls=[done()])
        w, st, _ = worker(claimed(), a, policy_env={"NIGHTSHIFT_LIKENESS_FEATURES": " On "})
        w.run_once()
        self.assertIn("submit", [c[0] for c in a.calls])

    def test_unset_in_the_process_environment_is_off(self):
        a = Adapter(polls=[done()])
        with mock.patch.dict(os.environ, {}, clear=False):
            os.environ.pop("NIGHTSHIFT_LIKENESS_FEATURES", None)
            w, st, _ = worker(claimed(), a, policy_env=None)
            w.run_once()
        self.assertEqual(st.calls[-1], ("fail", "feature_unavailable_policy"))


class Flow(Patched):
    def test_submit_once_record_the_task_before_the_first_poll_store_and_finish(self):
        a = Adapter(polls=[PollResult(PENDING), done()])
        w, st, _ = worker(claimed(), a)
        self.assertTrue(w.run_once())
        kinds = [c[0] for c in a.calls]
        self.assertEqual(kinds.count("submit"), 1)
        self.assertEqual([c[0] for c in st.calls], ["claim", "record_task", "finish"])
        # The order that keeps a crash from paying twice: submit, record, then poll.
        self.assertLess(kinds.index("submit"), kinds.index("poll"))
        sub = next(c for c in a.calls if c[0] == "submit")
        self.assertEqual(sub[3], JOB, "the job id travels as the vendor's external task id")
        request = sub[1]
        self.assertTrue(request.input_media[0].startswith(f"{ORIGIN}/api/media/file/{VID}/original?"))
        self.assertTrue(request.input_images[0].startswith(f"{ORIGIN}/api/media/file/{PIC}/original?"))
        path, kw = self.stored[0]
        self.assertEqual(kw["source"], "generated")
        self.assertEqual(kw["expect_kind"], "video")
        self.assertEqual(kw["provenance"]["origin"], "character_swap")
        self.assertEqual(kw["provenance"]["job_id"], JOB)
        self.assertEqual(kw["provenance"]["ai_label"], "altered_or_synthetic")
        self.assertEqual(kw["parent_asset_id"], VID)
        self.assertEqual(st.calls[-1], ("finish", kw["asset_id"]))

    def test_a_resumed_job_polls_its_recorded_task_and_never_submits(self):
        a = Adapter(polls=[done()])
        w, st, _ = worker(claimed(resume=True, provider_task_id="T-9"), a)
        w.run_once()
        self.assertNotIn("submit", [c[0] for c in a.calls])
        self.assertEqual([c for c in a.calls if c[0] == "poll"], [("poll", "T-9")])
        self.assertEqual(st.calls[-1][0], "finish")

    def test_a_lost_submit_fails_the_job_unconfirmed_and_is_never_retried(self):
        a = Adapter(submit_error=AdapterError("unavailable", "UNCONFIRMED SPEND: lost"))
        w, st, _ = worker(claimed(), a)
        with self.assertLogs("modules.character_swap", level="ERROR") as logs:
            w.run_once()
        self.assertTrue(any("POSSIBLE UNCONFIRMED VENDOR SPEND" in m and JOB in m and "kling-4.0-omni-edit" in m for m in logs.output), logs.output)
        self.assertEqual([c for c in st.calls if c[0] != "claim"], [("fail", "submit_unconfirmed")])
        self.assertEqual([c[0] for c in a.calls].count("submit"), 1)

    def test_a_proven_refusal_fails_with_its_code(self):
        a = Adapter(submit_error=AdapterError("quota", "balance", not_accepted=True))
        w, st, _ = worker(claimed(), a)
        w.run_once()
        self.assertEqual(st.calls[-1], ("fail", "quota"))

    def test_the_vendors_failure_releases_and_a_policy_refusal_says_so(self):
        for err, want in ((AdapterError("policy", "real face"), "policy"), (AdapterError("unavailable", "x"), "vendor_failed"), (None, "vendor_failed")):
            a = Adapter(polls=[PollResult(FAILED, error=err)])
            w, st, _ = worker(claimed(), a)
            w.run_once()
            self.assertEqual(st.calls[-1], ("fail", want))

    def test_still_at_the_vendor_after_the_limit_is_left_for_the_next_claim_with_heartbeats_on_the_way(self):
        a = Adapter(polls=[])
        w, st, _ = worker(claimed(), a)
        t = iter(range(0, 10_000, 30))
        w.clock = lambda: float(next(t))
        w.poll_limit_s = 300
        w.run_once()
        self.assertNotIn("fail", [c[0] for c in st.calls])
        self.assertNotIn("finish", [c[0] for c in st.calls])
        records = [c for c in st.calls if c[0] == "record_task"]
        self.assertGreater(len(records), 1, "the same task id again is the heartbeat that keeps the job from being taken over")
        self.assertEqual({c[1] for c in records}, {"T-1"})


class RefusedBeforeAnyPaidCall(Patched):
    def _refused(self, job, want, adapter=None):
        a = adapter or Adapter()
        w, st, _ = worker(job, a)
        w.run_once()
        self.assertNotIn("submit", [c[0] for c in a.calls])
        self.assertEqual(st.calls[-1], ("fail", want))

    def test_the_vendors_input_limits(self):
        self._refused(claimed(input={**claimed()["input"], "duration_s": 31}), "input_length")
        self._refused(claimed(input={**claimed()["input"], "width": 640, "height": 360}), "input_size")
        self._refused(claimed(input={**claimed()["input"], "bytes": 301 * 1024 * 1024}), "input_bytes")
        self._refused(claimed(input={**claimed()["input"], "duration_s": None}), "input_unmeasured")
        self._refused(claimed(references=[claimed()["references"][0]] * 11), "references_count")
        self.probe = {"fps": 15.0, "seconds": 10.0, "audio": True}
        self._refused(claimed(), "input_fps")
        self.probe = {"fps": None}
        self._refused(claimed(), "input_unmeasured")

    def test_a_file_longer_than_its_record_is_refused_and_one_frame_of_difference_is_not(self):
        # A crafted MP4 whose header understates its length would be priced (and sent) as the short clip it claims to be.
        self.probe = {"fps": 30.0, "seconds": 25.0, "audio": True}
        self._refused(claimed(), "input_length_mismatch")
        self.probe = {"fps": 30.0, "seconds": 9.0, "audio": True}
        self._refused(claimed(), "input_length_mismatch")
        self.probe = {"fps": 30.0, "seconds": None, "audio": True}
        self._refused(claimed(), "input_unmeasured")
        self.probe = {"fps": 30.0, "seconds": 10.0 + 1 / 30 + 0.05, "audio": True}
        a = Adapter(polls=[done()])
        w, st, _ = worker(claimed(), a)
        w.run_once()
        self.assertEqual(st.calls[-1][0], "finish")

    def test_seedance_limits_are_its_own(self):
        self._refused(claimed(model="seedance-2.5-edit", input={**claimed()["input"], "duration_s": 3.5}), "input_length")

    def test_words_the_screen_refuses_never_leave(self):
        self._refused(claimed(prompt="Replace the actor with @Image 1"), "prompt_refused")

    def test_what_the_adapter_refuses(self):
        self._refused(claimed(), "bad_request", Adapter(problems=["no"]))

    def test_an_unknown_model_or_a_missing_input(self):
        self._refused(claimed(model="kling-v3"), "model_unknown")
        with mock.patch("modules.media_library.copy_source", side_effect=__import__("modules.media_library").media_library.SourceUnavailable("x")):
            self._refused(claimed(), "input_unavailable")


class Probe(unittest.TestCase):
    def test_the_length_is_the_files_own_never_the_records(self):
        def run(stdout):
            with mock.patch.object(cs.subprocess, "run", return_value=mock.Mock(stdout=stdout)):
                return cs.probe("ffprobe", Path("x"))
        stream = b'{"streams": [{"codec_type": "video", "avg_frame_rate": "24/1", "duration": "12.5", "nb_frames": "600"}], "format": {"duration": "9.9"}}'
        self.assertEqual(run(stream)["seconds"], 12.5, "the video stream's own length first")
        frames = b'{"streams": [{"codec_type": "video", "avg_frame_rate": "24/1", "nb_frames": "600"}], "format": {"duration": "9.9"}}'
        self.assertEqual(run(frames)["seconds"], 25.0, "else its frames over its rate")
        fmt = b'{"streams": [{"codec_type": "video", "avg_frame_rate": "24/1"}], "format": {"duration": "9.9"}}'
        self.assertEqual(run(fmt)["seconds"], 9.9)
        self.assertIsNone(run(b'{"streams": [{"codec_type": "video", "duration": "nan"}]}').get("seconds"))
        self.assertEqual(run(b"not json"), {})


class VendorFileKept(Patched):
    def test_the_vendors_file_is_stored_as_it_came_for_both_models(self):
        """docs/AI_DISCLOSURE.md: no re-mux, no re-encode; the file the adapter fetched is the file the library stores."""
        for model in ("kling-4.0-omni-edit", "seedance-2.5-edit"):
            self.stored.clear()
            a = Adapter(polls=[done()])
            w, st, _ = worker(claimed(model=model, prompt="Replace the person with @Image 1"), a)
            w.run_once()
            self.assertEqual(st.calls[-1][0], "finish", model)
            self.assertEqual(self.stored[0][0].name, "edited_0.mp4", model)

    def test_no_code_path_rewrites_the_vendors_file(self):
        import inspect
        src = inspect.getsource(cs)
        for word in ("ffmpeg", "-c copy", "map_metadata", "remux"):
            self.assertNotIn(word, src.split('"""', 2)[2], word)


class DatabaseOutOfReach(Patched):
    def test_nothing_is_decided_when_the_database_cannot_be_reached(self):
        class Down(Store):
            def record_task(self, *a):
                raise cs.StoreUnavailable("x")

        a = Adapter(polls=[done()])
        w, st, _ = worker(claimed(), a, store=Down(claimed()))
        self.assertTrue(w.run_once())
        self.assertNotIn("poll", [c[0] for c in a.calls], "no poll without a recorded task: the next claim decides")
        self.assertNotIn("fail", [c[0] for c in st.calls])


class SignedLink(unittest.TestCase):
    def test_it_is_the_web_apps_own_signature(self):
        url = cs.signed_link(ORIGIN, SECRET, VID, "video/mp4", now=1_000, ttl_s=600)
        payload = f"nightshift-media-v1\n{VID}\noriginal\nvideo/mp4\n1600".encode()
        sig = base64.urlsafe_b64encode(hmac.new(SECRET, payload, hashlib.sha256).digest()).rstrip(b"=").decode()
        self.assertEqual(url, f"{ORIGIN}/api/media/file/{VID}/original?t=video%2Fmp4&exp=1600&sig={sig}")
        # The same vector command-center/tests/character-studio.test.ts checks against lib/server/media.ts signMedia.
        self.assertEqual(cs.sign_media(b"k" * 32, VID, "original", "video/mp4", 2_000_000_000), "XVu_umBhDtx2MGPwU9LMW4zudqnl2rZzPzdAfpJ0t00")

    def test_never_longer_than_an_hour_and_never_for_something_unsignable(self):
        self.assertIn("exp=4600", cs.signed_link(ORIGIN, SECRET, VID, "video/mp4", now=1_000, ttl_s=99_999))
        for bad in (("http://x.example", SECRET, VID, "video/mp4"), (ORIGIN, b"short", VID, "video/mp4"), (ORIGIN, SECRET, "../x", "video/mp4"),
                    (ORIGIN, SECRET, VID, "text/html\n"), (ORIGIN + "/path", SECRET, VID, "video/mp4")):
            with self.assertRaises(ValueError):
                cs.signed_link(*bad)


class Switch(unittest.TestCase):
    def test_off_connects_to_nothing(self):
        with mock.patch.object(cli, "build_worker", side_effect=AssertionError("must not be built")):
            for value in ("", "off", "1", "true", "ON "):
                env = {cs.FLAG: value} if value else {}
                if value.strip().lower() == "on":
                    continue
                self.assertEqual(cli.main([], env=env), 0)

    def test_a_missing_setting_is_exit_2_with_the_remedy(self):
        media = tempfile.mkdtemp()
        base = {cs.FLAG: "on", "SUPABASE_URL": "https://db.example.com", "SUPABASE_SERVICE_KEY": "k", "NIGHTSHIFT_MEDIA_DIR": media,
                cs.ORIGIN_ENV: ORIGIN, cs.SECRET_ENV: "x" * 40}
        for drop in ("SUPABASE_SERVICE_KEY", "NIGHTSHIFT_MEDIA_DIR", cs.ORIGIN_ENV, cs.SECRET_ENV):
            env = {k: v for k, v in base.items() if k != drop}
            with self.assertRaises(SystemExit) as cm:
                cli.build_worker(env)
            self.assertIn(drop if drop != "SUPABASE_SERVICE_KEY" else "SUPABASE_SERVICE_KEY", str(cm.exception))
            self.assertNotIn("x" * 40, str(cm.exception))
            self.assertEqual(cli.main([], env=env), 2)
        self.assertIsInstance(cli.build_worker(base), cs.CharacterSwapWorker)
        self.assertEqual(os.path.basename(str(cli.build_worker(base).scratch)), ".character-swap")


class NoVendorPackageForThePureParts(unittest.TestCase):
    def test_the_screen_and_the_links_import_without_requests_or_the_adapters(self):
        # The security lab (tests/security/requirements.txt: psycopg, pytest) imports prompt_problem to compare it with the database's:
        # nothing that needs requests (modules.capabilities included) may be imported at module level.
        root = Path(__file__).resolve().parent.parent
        code = subprocess.run(
            [sys.executable, "-c", "import sys, builtins; real = builtins.__import__\n"
             "def guard(name, *a, **k):\n"
             "    if name == 'requests' or name.startswith('requests.') or name.startswith('modules.capabilities'):\n"
             "        raise ImportError(name)\n"
             "    return real(name, *a, **k)\n"
             "builtins.__import__ = guard\n"
             "import modules.character_swap as cs\n"
             "assert cs.prompt_problem('Replace the person with @Image 1') is None\n"
             "cs.signed_link('https://studio.example.com', b's' * 40, '11111111-1111-1111-1111-111111111111', 'video/mp4')\n"],
            cwd=str(root), capture_output=True, text=True, timeout=60)
        self.assertEqual(code.returncode, 0, code.stderr[-500:])


class Screen(unittest.TestCase):
    def test_the_words(self):
        self.assertIsNone(cs.prompt_problem("Replace the person on the left with @Image 1"))
        for text, word in (("Replace the singer with @Image 1", "prompt_real_person"), ("no character", "prompt_needs_character"),
                           ("a\u200bb @Image 1", "prompt_characters"), ("", "prompt_length"), (None, "prompt_length")):
            self.assertEqual(cs.prompt_problem(text), word, text)


if __name__ == "__main__":
    unittest.main()

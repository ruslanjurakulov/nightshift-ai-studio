"""The owner's model switch on the channel pipeline's side (modules/model_switch.py, tools/queue_worker.py; migration 0124).

What would break without these:

* a run that calls a provider the owner switched OFF started anyway and spent the vendor's money (or a customer's hold) on it;
* a run whose provider is off quietly went to stock footage or to another provider (CLAUDE.md #4), or was stopped for a reason it did not
  have (a model-level switch, a provider with no registry entry, a stock-footage run);
* the switch changed a worker that nobody turned it on for (it is built only for NIGHTSHIFT_MODEL_SWITCH);
* an unreachable database stopped the pipeline, or a malformed answer read as "nothing is off";
* the owner's reason ("out of funds") reached a customer-facing text.

Nothing here touches a network: the database is a fake that answers model_switch_state().
"""

from __future__ import annotations

import io
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from modules import model_switch as ms  # noqa: E402
from modules import render_error, run_request  # noqa: E402
from tools import queue_worker as qw  # noqa: E402
from tests.test_queue_worker import FakeQueue, job  # noqa: E402


def state(*, enforced=True, providers=(), models=()):
    return ms.SwitchState(enforced=enforced, providers=frozenset(providers), models=frozenset(models))


class FakeSwitches:
    """What the worker asks: state(). It counts the asks."""

    def __init__(self, answer=None, error=None):
        self.answer, self.error, self.asked = answer, error, 0

    def state(self):
        self.asked += 1
        if self.error:
            raise ms.SwitchUnavailable(self.error)
        return self.answer


# ── what a run would call ───────────────────────────────────────────────────

class WhatARunCalls(unittest.TestCase):
    def uses(self, params, base=None):
        _, env, _ = run_request.plan_run("news", "daily", params, base or {})
        return [(u.kind, u.pipeline, u.provider) for u in ms.pipeline_uses(env)]

    def test_a_per_run_video_provider_is_the_registry_provider_it_belongs_to(self):
        self.assertEqual(self.uses({"video_provider": "seedance"}), [("video", "seedance", "bytedance")])
        self.assertEqual(self.uses({"video_provider": "veo"}), [("video", "veo", "google")])
        self.assertEqual(self.uses({"video_provider": "wan"}), [("video", "wan", "alibaba")])
        self.assertEqual(self.uses({"video_provider": "kling"}), [("video", "kling", "kling")])

    def test_a_per_run_image_generator_is_one_too_and_pexels_is_not_a_model(self):
        self.assertEqual(self.uses({"image_provider": "flux"}), [("image", "flux", "bfl")])
        self.assertEqual(self.uses({"image_provider": "nano-banana"}), [("image", "nano-banana", "google")])
        self.assertEqual(self.uses({"image_provider": "pexels"}), [])

    def test_a_provider_with_no_registry_entry_has_nothing_to_switch(self):
        self.assertEqual(self.uses({"video_provider": "higgsfield"}), [])
        self.assertEqual(self.uses({"image_provider": "leonardo"}), [])
        self.assertEqual(self.uses({"image_provider": "fal"}), [])

    def test_a_plain_run_calls_nothing_unless_the_deployment_turned_generation_on(self):
        self.assertEqual(self.uses({}), [])
        # a provider id on its own, with no flag, is dormant (video_providers.requested)
        self.assertEqual(self.uses({}, {"CHRONOS_VIDEO_PROVIDER": "seedance"}), [])
        self.assertEqual(self.uses({}, {"CHRONOS_VIDEO_PROVIDER": "seedance", "CHRONOS_ENABLE_VIDEO_GEN": "true"}),
                         [("video", "seedance", "bytedance")])
        self.assertEqual(self.uses({}, {"CHRONOS_IMAGE_PROVIDER": "flux"}), [])
        self.assertEqual(self.uses({}, {"CHRONOS_IMAGE_PROVIDER": "flux", "CHRONOS_ENABLE_IMAGE_GEN": "on"}),
                         [("image", "flux", "bfl")])

    def test_minimax_is_asked_for_by_its_own_flag_without_the_general_one(self):
        self.assertEqual(self.uses({}, {"CHRONOS_ENABLE_MINIMAX_BROLL": "true"}), [("video", "minimax", "minimax")])
        self.assertEqual(self.uses({}, {"CHRONOS_VIDEO_PROVIDER": "kling", "CHRONOS_ENABLE_MINIMAX_BROLL": "true"}), [])

    def test_a_scene_regeneration_names_its_provider(self):
        self.assertEqual([(u.pipeline, u.provider) for u in ms.pipeline_uses({"SCENE_REGEN_PROVIDER": "Seedance"})],
                         [("seedance", "bytedance")])

    def test_both_kinds_are_listed_once_each(self):
        uses = self.uses({"video_provider": "veo", "image_provider": "nano-banana"})
        self.assertEqual(uses, [("video", "veo", "google"), ("image", "nano-banana", "google")])

    def test_the_tables_agree_with_the_registry_and_the_workflow(self):
        registry = json.loads((ROOT / "schemas" / "model_registry.json").read_text(encoding="utf-8"))
        providers = {m["provider"] for m in registry["models"]}
        for table, kind in ((ms.VIDEO_PROVIDERS, "video"), (ms.IMAGE_PROVIDERS, "image")):
            for pipeline, provider in table.items():
                self.assertIn(provider, providers, f"{pipeline} -> {provider} is not a provider of the registry")
                owned = [m for m in registry["models"] if m["provider"] == provider and m["adapter"].startswith(f"{kind}.")]
                self.assertTrue(owned, f"{provider} has no {kind} model in the registry, so the switch could not hide anything of it")
        self.assertTrue(set(ms.VIDEO_PROVIDERS) <= set(run_request.VIDEO_PROVIDERS))
        self.assertTrue(set(ms.IMAGE_PROVIDERS) <= set(run_request.IMAGE_PROVIDERS))
        # every pipeline provider is either gated or named here as having no registry entry: a new one cannot slip by unnoticed
        self.assertEqual(set(run_request.VIDEO_PROVIDERS) - set(ms.VIDEO_PROVIDERS), {"higgsfield"})
        self.assertEqual(set(run_request.IMAGE_PROVIDERS) - set(ms.IMAGE_PROVIDERS), {"pexels", "leonardo", "fal"})


# ── the state ───────────────────────────────────────────────────────────────

class TheState(unittest.TestCase):
    def test_nothing_is_blocked_while_the_switches_are_not_in_force(self):
        uses = ms.pipeline_uses({"CHRONOS_ENABLE_VIDEO_GEN": "true", "CHRONOS_VIDEO_PROVIDER": "seedance"})
        self.assertIsNone(ms.blocked(uses, state(enforced=False, providers=["bytedance"])))
        self.assertEqual(ms.blocked(uses, state(providers=["bytedance"])).provider, "bytedance")

    def test_only_a_provider_switch_blocks_a_pipeline_run(self):
        uses = ms.pipeline_uses({"CHRONOS_ENABLE_VIDEO_GEN": "true", "CHRONOS_VIDEO_PROVIDER": "seedance"})
        self.assertIsNone(ms.blocked(uses, state(models=["seedance-1.0-pro", "seedance-1.5-pro"])))
        self.assertIsNone(ms.blocked(uses, state(providers=["kling", "google"])))

    def test_a_pipeline_name_that_happens_to_be_a_model_id_blocks_nothing(self):
        """The model list is for registry ids; a model-level switch is never matched to a run by its name."""
        uses = ms.pipeline_uses({"CHRONOS_ENABLE_VIDEO_GEN": "true", "CHRONOS_VIDEO_PROVIDER": "seedance",
                                 "CHRONOS_ENABLE_IMAGE_GEN": "true", "CHRONOS_IMAGE_PROVIDER": "flux"})
        self.assertIsNone(ms.blocked(uses, state(models=["seedance", "flux", "bytedance", "bfl"])))

    def test_the_first_off_provider_is_the_one_named(self):
        uses = ms.pipeline_uses({"CHRONOS_ENABLE_VIDEO_GEN": "true", "CHRONOS_VIDEO_PROVIDER": "veo",
                                 "CHRONOS_ENABLE_IMAGE_GEN": "true", "CHRONOS_IMAGE_PROVIDER": "flux"})
        self.assertEqual(ms.blocked(uses, state(providers=["bfl", "google"])).kind, "video")
        self.assertEqual(ms.blocked(uses, state(providers=["bfl"])).kind, "image")

    def test_a_malformed_answer_is_unavailable_never_nothing_is_off(self):
        for raw in (None, [], "x", {}, {"enforced": "yes", "providers": [], "models": []}, {"enforced": True},
                    {"enforced": True, "providers": "bytedance", "models": []}, {"enforced": True, "providers": [1], "models": []}):
            with self.subTest(raw=raw), self.assertRaises(ms.SwitchUnavailable):
                ms.parse_state(raw)
        self.assertEqual(ms.parse_state({"enforced": True, "providers": ["a"], "models": ["b"]}), state(providers=["a"], models=["b"]))

    def test_the_flag_is_off_unless_it_says_on(self):
        for v in (None, "", "off", "0", "false", "maybe", "onn"):
            self.assertFalse(ms.enabled({"NIGHTSHIFT_MODEL_SWITCH": v} if v is not None else {}), v)
        for v in ("on", "ON", " 1 ", "true", "Yes"):
            self.assertTrue(ms.enabled({"NIGHTSHIFT_MODEL_SWITCH": v}), v)

    def test_check_without_a_client_asks_nothing_and_blocks_nothing(self):
        self.assertEqual(ms.check(None, {"CHRONOS_ENABLE_VIDEO_GEN": "true", "CHRONOS_VIDEO_PROVIDER": "seedance"}), (None, None))

    def test_a_run_that_calls_no_provider_never_asks_the_database(self):
        s = FakeSwitches(state(providers=["bytedance"]))
        self.assertEqual(ms.check(s, {}), (None, None))
        self.assertEqual(s.asked, 0)

    def test_an_unreadable_state_lets_the_run_go_on_and_says_so(self):
        s = FakeSwitches(error="model_switch_state: HTTP 404 (is migration 0124 applied?)")
        use, warning = ms.check(s, {"CHRONOS_ENABLE_VIDEO_GEN": "true", "CHRONOS_VIDEO_PROVIDER": "seedance"})
        self.assertIsNone(use)
        self.assertIn("state unknown", warning)
        self.assertIn("HTTP 404", warning)

    def test_the_stopped_runs_text_names_the_provider_not_a_reason(self):
        text = ms.refusal_text(ms.Use("video", "seedance", "bytedance"))
        self.assertIn("temporarily switched off", text)
        self.assertIn("nothing was charged", text)
        for word in ("fund", "balance", "quota", "outage", "terms"):
            self.assertNotIn(word, text.lower())

    def test_the_code_is_in_the_closed_set_the_page_words(self):
        self.assertEqual(ms.CODE, render_error.SWITCHED_OFF)
        self.assertIn(ms.CODE, render_error.CODES)
        self.assertEqual(render_error.code_of(render_error.tag(ms.CODE, "x")), "switched_off")


class RestClient(unittest.TestCase):
    class Resp:
        def __init__(self, status=200, body=None, boom=False):
            self.status_code, self._body, self._boom = status, body, boom

        def json(self):
            if self._boom:
                raise ValueError("not json")
            return self._body

    class Session:
        def __init__(self, resp=None, exc=None):
            self.resp, self.exc, self.calls = resp, exc, []

        def post(self, url, json=None, headers=None, timeout=None):
            self.calls.append((url, json, headers, timeout))
            if self.exc:
                raise self.exc
            return self.resp

    def client(self, **kw):
        s = self.Session(**kw)
        return ms.SwitchRest("https://x.supabase.co/", "SERVICE-KEY-123456", session=s), s

    def test_it_posts_to_the_one_function_with_the_service_key(self):
        c, s = self.client(resp=self.Resp(body={"enforced": True, "providers": ["bytedance"], "models": []}))
        self.assertEqual(c.state(), state(providers=["bytedance"]))
        (url, body, headers, timeout), = s.calls
        self.assertEqual((url, body), ("https://x.supabase.co/rest/v1/rpc/model_switch_state", {}))
        self.assertEqual(headers["Authorization"], "Bearer SERVICE-KEY-123456")
        self.assertEqual(timeout, 10.0)

    def test_every_failure_is_unavailable_and_carries_no_key_and_no_body(self):
        for kw in ({"resp": self.Resp(status=404, body={"message": "SERVICE-KEY-123456 leaked"})},
                   {"resp": self.Resp(status=500, body="boom")},
                   {"resp": self.Resp(body=None, boom=True)},
                   {"resp": self.Resp(body={"enforced": 1})},
                   {"exc": RuntimeError("connect to SERVICE-KEY-123456 failed")}):
            c, _ = self.client(**kw)
            with self.subTest(kw=kw):
                with self.assertRaises(ms.SwitchUnavailable) as cm:
                    c.state()
                self.assertNotIn("SERVICE-KEY-123456", str(cm.exception))
                self.assertNotIn("leaked", str(cm.exception))

    def test_an_http_error_is_named_by_its_status_not_read_as_an_answer(self):
        for status in (401, 404, 500):
            c, _ = self.client(resp=self.Resp(status=status, body={"enforced": False, "providers": [], "models": []}))
            with self.assertRaises(ms.SwitchUnavailable) as cm:
                c.state()
            self.assertIn(f"HTTP {status}", str(cm.exception))


# ── the worker ──────────────────────────────────────────────────────────────

class RecordingCredits:
    """Credits as a customer's run sees them: it must never be touched by a run that is stopped before it starts."""

    def __init__(self):
        self.calls = []

    def channel_org(self, channel_id):
        return "00000000-0000-0000-0000-000000000001"     # the operator's own organization: exempt, no hold

    def expire(self):
        return 0


class WorkerGate(unittest.TestCase):
    """The worker with a fake queue and the fake main.py of tests/test_queue_worker.py (not a subclass of its case: that would run it again)."""

    def setUp(self):
        from tests.test_queue_worker import FAKE_MAIN, OperatorCredits  # noqa: PLC0415

        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.repo = Path(self.tmp.name)
        (self.repo / "main.py").write_text(FAKE_MAIN)
        self.env = {"PATH": os.environ.get("PATH", ""), "GEMINI_API_KEY": "gemini-secret-value-123"}
        self.out = io.StringIO()
        self.operator_credits = OperatorCredits

    def worker(self, queue, **kw):
        opts = dict(env=self.env, repo_dir=self.repo, prelude=[],
                    resolve_channel=lambda cid: {"channel_id": cid, "is_default": False, "is_operators": True,
                                                 "token_secret": "CHRONOS_YT_TOKEN_NEWS"},
                    heartbeat_seconds=0.05, poll_seconds=0.01, grace_seconds=60, kill_after_seconds=2, out=self.out,
                    credits=self.operator_credits())
        opts.update(kw)
        return qw.Worker(queue, worker_id="w1", **opts)

    def run_one(self, params, switches, **kw):
        q = FakeQueue([job(params=params)])
        w = self.worker(q, switches=switches, **kw)
        w.run_forever(once=True)
        return q

    def main_ran(self):
        return (self.repo / "report.out").exists()

    def ends(self, q):
        (_, _, status, error), = q.ends()
        return status, error

    def test_a_run_whose_video_provider_is_off_is_not_started_and_says_why_in_one_coded_line(self):
        s = FakeSwitches(state(providers=["bytedance"]))
        q = self.run_one({"video_provider": "seedance"}, s)
        status, error = self.ends(q)
        self.assertEqual(status, "failed")
        self.assertTrue(error.startswith("[code:switched_off] the video provider seedance is temporarily switched off"), error)
        self.assertIn("nothing was run, nothing was charged", error)
        self.assertFalse(self.main_ran(), "main.py must not start: nothing may be spent")
        self.assertEqual(s.asked, 1)

    def test_nothing_is_substituted_the_job_is_failed_not_re_queued_and_not_run_with_stock(self):
        q = self.run_one({"video_provider": "seedance"}, FakeSwitches(state(providers=["bytedance"])))
        self.assertEqual([c[0] for c in q.calls if c[0] in ("finish", "release")], ["finish"])
        self.assertFalse(self.main_ran())

    def test_a_provider_that_is_on_runs_as_before(self):
        q = self.run_one({"video_provider": "kling"}, FakeSwitches(state(providers=["bytedance"])))
        self.assertEqual(self.ends(q), ("succeeded", None))
        self.assertTrue(self.main_ran())

    def test_while_the_switches_are_not_in_force_nothing_is_stopped(self):
        s = FakeSwitches(state(enforced=False, providers=["bytedance"]))
        q = self.run_one({"video_provider": "seedance"}, s)
        self.assertEqual(self.ends(q), ("succeeded", None))
        self.assertTrue(self.main_ran())

    def test_a_model_switch_alone_does_not_stop_a_channel_run(self):
        """Documented: a pipeline run names a provider, not a registry model, so only a provider switch can be matched to it."""
        q = self.run_one({"video_provider": "seedance"}, FakeSwitches(state(models=["seedance-1.0-pro", "seedance-1.5-pro"])))
        self.assertEqual(self.ends(q), ("succeeded", None))

    def test_an_image_generator_that_is_off_stops_the_run_too_and_pexels_never_does(self):
        s = FakeSwitches(state(providers=["bfl", "google"]))
        q = self.run_one({"image_provider": "flux"}, s)
        self.assertEqual(self.ends(q)[0], "failed")
        self.assertIn("image provider flux", self.ends(q)[1])
        self.assertFalse(self.main_ran())
        q = self.run_one({"image_provider": "pexels"}, s)
        self.assertEqual(self.ends(q)[0], "succeeded")

    def test_a_stock_footage_run_never_asks_the_database(self):
        s = FakeSwitches(error="must not be asked")
        q = self.run_one({}, s)
        self.assertEqual(self.ends(q), ("succeeded", None))
        self.assertEqual(s.asked, 0)

    def test_an_unreadable_state_lets_the_run_go_on_and_the_log_says_so(self):
        s = FakeSwitches(error="model_switch_state: HTTP 503")
        with self.assertLogs("queue_worker", level="WARNING") as logs:
            q = self.run_one({"video_provider": "seedance"}, s)
        self.assertEqual(self.ends(q), ("succeeded", None))
        self.assertTrue(any("state unknown" in line for line in logs.output), logs.output)

    def test_without_a_client_the_worker_is_what_it_was(self):
        q = self.run_one({"video_provider": "seedance"}, None)
        self.assertEqual(self.ends(q), ("succeeded", None))
        self.assertTrue(self.main_ran())

    def test_the_stopped_run_opens_no_hold_and_spends_nothing(self):
        credits = RecordingCredits()
        calls = []
        credits.start = lambda *a, **k: calls.append(("start", a))          # type: ignore[attr-defined]
        credits.capture = lambda *a, **k: calls.append(("capture", a))      # type: ignore[attr-defined]
        credits.release = lambda *a, **k: calls.append(("release", a))      # type: ignore[attr-defined]
        self.run_one({"video_provider": "seedance"}, FakeSwitches(state(providers=["bytedance"])), credits=credits)
        self.assertEqual(calls, [])

    def test_the_log_does_not_carry_the_owners_reason_or_a_key(self):
        with self.assertLogs("queue_worker", level="INFO") as logs:
            self.run_one({"video_provider": "seedance"}, FakeSwitches(state(providers=["bytedance"])))
        blob = "\n".join(logs.output).lower()
        self.assertIn("switched off", blob)
        self.assertNotIn("fund", blob)
        self.assertNotIn("gemini-secret-value-123", blob)

    def test_the_gate_is_built_only_when_the_variable_says_on(self):
        self.assertFalse(ms.enabled(self.env))
        self.assertTrue(ms.enabled({**self.env, "NIGHTSHIFT_MODEL_SWITCH": "on"}))
        src = (ROOT / "tools" / "queue_worker.py").read_text(encoding="utf-8")
        self.assertIn("switches = model_switch.SwitchRest(url, key) if model_switch.enabled(os.environ) else None", src)


class RegenerationGate(unittest.TestCase):
    """A priced scene regeneration (0076) whose provider is off is settled as a failure with its hold released, before main.py starts."""

    def setUp(self):
        from tests.test_scene_regenerate import FAKE_MAIN  # noqa: PLC0415

        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.repo = Path(self.tmp.name)
        (self.repo / "main.py").write_text(FAKE_MAIN)
        self.run_dir = self.repo / "output" / "the-lost-city"
        self.run_dir.mkdir(parents=True)
        (self.run_dir / "project.json").write_text('{"old": true}')
        (self.run_dir / "final_video.mp4").write_bytes(b"OLD CUT")
        self.sink = open(os.devnull, "w")
        self.addCleanup(self.sink.close)

    def run_job(self, switches):
        from tests.test_scene_regenerate import RID, RegenCredits, RunRequest  # noqa: PLC0415

        c = RegenCredits()
        q = FakeQueue([job(kind="repair", params=dict(RunRequest.PARAMS), scene_regeneration_id=RID,
                           credit_ref="rj-sr-" + RID.replace("-", ""))])
        w = qw.Worker(q, worker_id="w1", env={"PATH": os.environ.get("PATH", "")}, repo_dir=self.repo, prelude=[],
                      resolve_channel=lambda cid: {"channel_id": cid, "is_default": False},
                      heartbeat_seconds=0.05, poll_seconds=0.01, grace_seconds=60, kill_after_seconds=2,
                      out=self.sink, credits=c, switches=switches)
        w.run_forever(once=True)
        return q, c

    def test_the_press_is_released_and_the_previous_take_is_untouched(self):
        from tests.test_scene_regenerate import PROVIDER, RID  # noqa: PLC0415

        q, c = self.run_job(FakeSwitches(state(providers=[ms.VIDEO_PROVIDERS[PROVIDER]])))
        (_, _, status, error), = q.ends()
        self.assertEqual(status, "failed")
        self.assertTrue(error.startswith("[code:switched_off]"), error)
        (_, rid, jid, ok, code, text, _), = [x for x in c.calls if x[0] == "finish"]
        self.assertEqual((rid, jid, ok, code), (RID, 7, False, "model_switched_off"))
        self.assertNotIn("fund", (text or "").lower())
        self.assertFalse((self.repo / "argv.out").exists(), "main.py must not start")
        self.assertEqual((self.run_dir / "project.json").read_text(), '{"old": true}')
        self.assertEqual((self.run_dir / "final_video.mp4").read_bytes(), b"OLD CUT")

    def test_another_provider_off_or_the_switches_not_in_force_lets_it_run(self):
        for sw in (FakeSwitches(state(providers=["bytedance"])), FakeSwitches(state(enforced=False, providers=["kling"])), None):
            with self.subTest(switches=sw):
                (self.run_dir / "final_video.mp4").write_bytes(b"OLD CUT")
                q, c = self.run_job(sw)
                self.assertEqual(q.ends()[0][2], "succeeded")
                self.assertTrue((self.repo / "argv.out").exists())
                (self.repo / "argv.out").unlink()


if __name__ == "__main__":
    unittest.main()

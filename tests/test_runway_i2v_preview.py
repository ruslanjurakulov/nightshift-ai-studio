"""Runway image-to-video, prepared for the operator's own trial (docs/research/video-i2v-2026-11-13.md).

Step 1 of "one photo -> styled clips": both Runway video models may be tried by the platform operator in the operator's own
credits-exempt organization (migration 0139) and by nobody else, and nothing is put on sale. These tests pin what would
break that, or would make the first paid call wrong:

* the registry entries say what Runway's docs and terms said on 2026-11-13, keep a page price unconfirmed, and add no sale;
* gen4.5's probe proves the image-to-video path at the cheapest call the feature needs (5 s), and ``--all`` still skips gated models;
* the adapter speaks the documented API (endpoint, version header, 2-10 s, the six ratios) and maps every documented task
  status and failure code to the remedy it needs (THROTTLED is still running; ASSET.INVALID is the input's fault; an empty
  balance is quota, never "change your input").

No network, no database, no key: every call goes to a fake session.
"""
from __future__ import annotations

import logging
import tempfile
import unittest
from pathlib import Path

from modules import model_registry as reg
from modules.capabilities.base import (
    E_BAD_REQUEST,
    E_POLICY,
    E_QUOTA,
    E_RATE_LIMITED,
    E_UNAVAILABLE,
    FAILED,
    PENDING,
    SUCCEEDED,
    AdapterError,
    CapabilityRequest,
    ProviderTask,
)
from tests.test_capabilities import ENV, FakeResp, FakeSession, adapter

READ = "2026-11-13"
VIDEO = ("runway-gen4.5", "runway-gen4-turbo")
TASK = ProviderTask("video.runway", "gen4.5", "t1")


def i2v(**kw) -> CapabilityRequest:
    base = dict(aspect_ratio="16:9", duration_s=5, input_images=("https://img.test/photo.png",))
    base.update(kw)
    return CapabilityRequest("i2v", "slow push in", **base)


class RegistryTests(unittest.TestCase):
    def setUp(self):
        self.r = reg.load()

    def test_both_models_are_an_operator_preview_and_nothing_more(self):
        rows = {row["id"]: row for row in reg.sync_rows(list(self.r.values()))}
        for mid in VIDEO:
            with self.subTest(mid=mid):
                e = self.r[mid]
                self.assertIs(e.raw["operator_preview"], True)            # 0139 reads the JSON value true, nothing else
                self.assertIs(rows[mid]["spec"]["operator_preview"], True)  # what --sync copies into model_registry.spec
                self.assertEqual(e.api_exposure, "web_only")                # never the API or MCP (§1.3(a))
                self.assertIsNone(e.terms_gate)
                # availability is the database's (0035): the file cannot open a sale, and this change adds no field that could.
                for banned in ("availability", "verified_at", "credits_per_unit"):
                    self.assertNotIn(banned, e.raw)

    def test_the_upscaler_is_not_part_of_this_trial(self):
        self.assertNotIn("operator_preview", self.r["runway-video-upscale"].raw)

    def test_prices_are_the_pricing_page_and_stay_unconfirmed(self):
        for mid, usd in (("runway-gen4.5", 0.12), ("runway-gen4-turbo", 0.05)):
            with self.subTest(mid=mid):
                p = self.r[mid].raw["pricing"]
                self.assertEqual((p["unit"], p["provider_usd_per_unit"]), ("second", usd))
                self.assertEqual((p["source_url"], p["as_of"]), ("https://docs.dev.runwayml.com/guides/pricing", READ))
                # A page figure, not a bill: set true only after a probe's cost.credits matched it.
                self.assertFalse(p["confirmed"])
                self.assertIn("$0.01 per credit", p["note"])
        self.assertIn("no longer on it", self.r["runway-gen4-turbo"].raw["pricing"]["note"])

    def test_api_facts_are_the_docs_of_that_day(self):
        for mid in VIDEO:
            with self.subTest(mid=mid):
                a = self.r[mid].raw["api_documented"]
                self.assertEqual((a["url"], a["checked_at"]), ("https://docs.dev.runwayml.com/api.md", READ))
                for fact in ("/v1/image_to_video", "X-Runway-Version 2024-11-06", "2-10", "1584:672", "position first"):
                    self.assertIn(fact, a["evidence"])
                self.assertIn("THROTTLED", a["note"])

    def test_terms_notes_carry_every_clause_a_sale_depends_on(self):
        must = {
            "§4.4": "Inputs and Outputs may be used by the Company to train and improve its AI models",
            "§5.2": "may not use Customer Content as training data",
            "§2.2": "13 or older",
            "§4.2": "without that person's permission",
            "§18.12": "US-embargoed",
            "§1:": "Powered by Runway",
        }
        for mid in VIDEO:
            notes = self.r[mid].raw["terms_notes"]
            for section, words in must.items():
                with self.subTest(mid=mid, section=section):
                    self.assertTrue(any(section in n and words in n and f"read {READ}" in n for n in notes), notes)
            self.assertTrue(all(len(n) <= 300 for n in notes))
            # tests/test_registry_corrections_2026_11_11: the terms live on runway.com, never the old domain.
            self.assertNotIn("runwayml.com", " ".join(notes))

    def test_attribution_is_the_line_the_terms_require(self):
        for mid in VIDEO:
            self.assertEqual(self.r[mid].raw["attribution"], {"text": "Powered by Runway", "url": "https://runway.com"})

    def test_offered_lengths_are_inside_runways_range_and_include_five_seconds(self):
        for mid in VIDEO:
            durations = self.r[mid].durations_s
            self.assertIn(5, durations, mid)
            self.assertTrue(all(2 <= d <= 10 for d in durations), (mid, durations))


class ProbeTests(unittest.TestCase):
    def setUp(self):
        self.r = reg.load()

    def test_gen45_is_probed_on_the_image_to_video_path_at_the_cheapest_length(self):
        p = self.r["runway-gen4.5"].raw["probe"]
        self.assertEqual((p["capability"], p["duration_s"], p["input_image"]), ("i2v", 5, "generated"))
        # The generated probe frame is 1280x720: 16:9 sends it uncropped. Runway bills by the second, not by the ratio.
        self.assertEqual(p["aspect_ratio"], "16:9")
        self.assertEqual(min(self.r["runway-gen4.5"].durations_s), 5)

    def test_both_probes_pass_the_registry_and_the_adapter_before_any_call(self):
        a = adapter("video.runway")
        for mid in VIDEO:
            e = self.r[mid]
            req = e.probe_request(generated_image="https://probe.invalid/x.png")
            self.assertEqual(a.problems(req, e), [], mid)
        self.assertEqual(a.session.calls, [])

    def test_all_still_probes_only_ungated_models(self):
        from tools import probe_models

        chosen = probe_models.select(self.r.values(), [], None, True)
        ids = {e.id for e in chosen}
        self.assertTrue(set(VIDEO) <= ids)
        self.assertFalse([e.id for e in chosen if e.terms_gate])
        # A gated model past its shutdown (the Veo rows) is reported as shutdown instead (tools/probe_models.shutdown_left_out).
        gated = {e.id for e in self.r.values() if e.terms_gate and not e.shut_down()}
        self.assertEqual({e.id for e in probe_models.gated_left_out(self.r.values(), [], None, True)}, gated)

    def test_the_gen45_probe_sends_a_drawn_first_frame_to_image_to_video(self):
        from tools import probe_models

        video = b"\x00\x00\x00\x18ftypmp42" + b"\x00" * 64
        session = FakeSession(
            [("POST", "/v1/image_to_video", FakeResp(200, {"id": "p1"})),
             ("GET", "/v1/tasks/p1", FakeResp(200, {"status": "SUCCEEDED", "output": ["https://dnznrvs05pmza.cloudfront.net/p1.mp4"],
                                                     "cost": {"credits": 60}}))],
            downloads={"https://dnznrvs05pmza.cloudfront.net/p1.mp4": FakeResp(200, content=video)})
        with tempfile.TemporaryDirectory() as d:
            res = probe_models.run_probe(self.r["runway-gen4.5"], env=ENV, voice_id=None, workdir=Path(d),
                                         session=session, sleep=lambda s: None)
        self.assertTrue(res.ok, res.message)
        method, url, kw = session.calls[0]
        body = kw["json"]
        self.assertEqual((method, body["model"], body["ratio"], body["duration"]), ("POST", "gen4.5", "1280:720", 5))
        self.assertTrue(body["promptImage"].startswith("data:image/png;base64,"))
        self.assertEqual(kw["headers"]["X-Runway-Version"], "2024-11-06")
        # 5 s at 12 credits a second: what Runway reports is printed beside OK, to be compared before a price is trusted.
        self.assertIn("credits reported by Runway: 60", res.note)
        self.assertEqual(res.credits, 60.0)                         # the bare number --brief (the workflow) can print

    def test_the_workflows_brief_log_carries_the_credits_and_nothing_else_of_the_vendors(self):
        # The workflow always runs --brief, which prints no free text: without a bare number there the owner could not read
        # the figure the doc's "Owner steps" ask them to compare (Lens on PR 712).
        import io
        from unittest import mock
        from tools import probe_models
        db = mock.Mock()
        db.sync.return_value = 0
        cases = [(60, "ok runway-gen4.5 credits=60"), (None, "ok runway-gen4.5\n")]
        for credits, want in cases:
            out = io.StringIO()
            res = probe_models.ProbeResult("runway-gen4.5", True, latency_ms=1, output_bytes=1,
                                           note="credits reported by Runway: secret-looking text", credits=credits)
            with mock.patch.object(probe_models, "run_probe", return_value=res):
                code = probe_models.main(["--model", "runway-gen4.5", "--brief"], env=ENV, db=db, stream=out)
            self.assertEqual(code, 0)
            self.assertIn(want, out.getvalue())
            self.assertNotIn("secret-looking", out.getvalue())

    def test_only_a_finite_non_negative_number_becomes_the_credits_figure(self):
        from tools import probe_models
        for bad in (None, True, "60", float("nan"), float("inf"), -1, {"credits": 1}):
            self.assertIsNone(probe_models._bare_number(bad), bad)
        self.assertEqual(probe_models._bare_number(12), 12.0)


class AdapterRequestTests(unittest.TestCase):
    def test_image_to_video_is_the_documented_call(self):
        a = adapter("video.runway", [("POST", "/v1/image_to_video", FakeResp(200, {"id": "t1"}))])
        task = a.submit(i2v(), "gen4_turbo")
        self.assertEqual(task.task_id, "t1")
        method, url, kw = a.session.calls[0]
        self.assertEqual(url, "https://api.dev.runwayml.com/v1/image_to_video")
        self.assertEqual(kw["json"], {"model": "gen4_turbo", "promptText": "slow push in", "ratio": "1280:720",
                                      "duration": 5, "promptImage": "https://img.test/photo.png"})

    def test_every_offered_shape_is_one_of_runways_six_ratios(self):
        documented = {"1280:720", "720:1280", "1104:832", "960:960", "832:1104", "1584:672"}
        e = reg.load()["runway-gen4.5"]
        for aspect in e.aspects_for("i2v"):
            a = adapter("video.runway", [("POST", "/v1/image_to_video", FakeResp(200, {"id": "t1"}))])
            a.submit(i2v(aspect_ratio=aspect), "gen4.5")
            self.assertIn(a.session.calls[0][2]["json"]["ratio"], documented, aspect)

    def test_a_length_runway_does_not_make_is_refused_before_any_call(self):
        e = reg.load()["runway-gen4.5"]
        for bad in (1, 11, 30):
            with self.subTest(duration=bad):
                a = adapter("video.runway")
                self.assertTrue(any("2 to 10" in p for p in a.problems(i2v(duration_s=bad), e)))
                with self.assertRaises(AdapterError) as cm:
                    a.submit(i2v(duration_s=bad), "gen4.5")
                self.assertEqual(cm.exception.code, E_BAD_REQUEST)
                self.assertTrue(cm.exception.not_accepted)      # nothing left this process, so nothing was billed
                self.assertEqual(a.session.calls, [])

    def test_an_empty_runway_balance_is_quota_not_a_bad_input(self):
        def code(status, text):
            a = adapter("video.runway", [("POST", "/v1/image_to_video", FakeResp(status, {"error": text}))])
            with self.assertRaises(AdapterError) as cm:
                a.submit(i2v(), "gen4.5")
            return cm.exception.code

        self.assertEqual(code(400, "You do not have enough credits to run this task."), E_QUOTA)
        self.assertEqual(code(400, "Insufficient credits"), E_QUOTA)
        self.assertEqual(code(400, "Invalid ratio for this model"), E_BAD_REQUEST)
        self.assertEqual(code(429, "Too many requests"), E_RATE_LIMITED)
        # A gateway can stand in front of a Runway that already took the task: a 5xx is never read as a refusal.
        self.assertEqual(code(503, "insufficient credits"), E_UNAVAILABLE)


class AdapterPollTests(unittest.TestCase):
    def poll(self, body):
        return adapter("video.runway", [("GET", "/v1/tasks/t1", FakeResp(200, body))]).poll(TASK)

    def test_throttled_is_still_running(self):
        for status in ("PENDING", "THROTTLED", "RUNNING"):
            self.assertEqual(self.poll({"status": status}).state, PENDING, status)

    def test_an_unknown_status_stays_pending_and_is_logged(self):
        with self.assertLogs("modules.capabilities.video", level=logging.WARNING) as logs:
            self.assertEqual(self.poll({"status": "QUEUED_SOMEWHERE"}).state, PENDING)
        self.assertIn("not one the docs list", logs.output[0])

    def test_failure_codes_name_the_remedy(self):
        cases = {
            "SAFETY.INPUT.IMAGE": E_POLICY,
            "SAFETY.INPUT.TEXT": E_POLICY,
            "SAFETY.OUTPUT.VIDEO": E_POLICY,
            "INPUT_PREPROCESSING.SAFETY.TEXT": E_POLICY,
            "ASSET.INVALID": E_BAD_REQUEST,
            "INTERNAL.BAD_OUTPUT.01": E_UNAVAILABLE,
            "INPUT_PREPROCESSING.INTERNAL": E_UNAVAILABLE,
            "THIRD_PARTY.UNAVAILABLE": E_UNAVAILABLE,
            "INTERNAL": E_UNAVAILABLE,
        }
        for fcode, want in cases.items():
            with self.subTest(failureCode=fcode):
                res = self.poll({"status": "FAILED", "failureCode": fcode, "failure": "something went wrong"})
                self.assertEqual((res.state, res.error.code), (FAILED, want))
        res = self.poll({"status": "CANCELLED"})
        self.assertEqual((res.state, res.error.code), (FAILED, E_UNAVAILABLE))

    def test_success_keeps_the_reported_cost_for_the_probe_only(self):
        a = adapter("video.runway", [("GET", "/v1/tasks/t1", FakeResp(200, {
            "status": "SUCCEEDED", "output": ["https://dnznrvs05pmza.cloudfront.net/t1.mp4"], "cost": {"credits": 25}}))])
        self.assertEqual(a.poll(TASK).state, SUCCEEDED)
        self.assertIn("25", a.probe_note(TASK))
        self.assertIn("no cost.credits", a.probe_note(ProviderTask("video.runway", "gen4.5", "other")))
        self.assertEqual(a.probe_credits(TASK), 25)
        self.assertIsNone(a.probe_credits(ProviderTask("video.runway", "gen4.5", "other")))


if __name__ == "__main__":
    unittest.main()

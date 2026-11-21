"""AI critic on rendered frames (modules/video_critic.py).

Gemini and ffmpeg are both faked: frames are PIL images written where ffmpeg
would write them, and the model answers with a canned JSON object. What these
pin is the contract around the call — off by default, never blocking, never
raising, counted in the ledger, skipped at a met ceiling — and that the model's
answer is filtered to scenes that were actually on the sheet.
"""

import ast
import io
import json
import os
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace as NS
from unittest.mock import patch

from PIL import Image

from modules import video_critic
from modules.cost_ledger import CostEntry, CostLedger, VISION_CALLS


def timeline(n):
    return [{"section": f"sec{i}", "start_ms": i * 10_000, "end_ms": (i + 1) * 10_000} for i in range(n)]


def script(n):
    return NS(sections=[NS(narration=f"Narration for section {i}.") for i in range(n)])


def fake_extract(exe, video, seconds, out):
    Image.new("RGB", (64, 36), (int(seconds) % 255, 80, 120)).save(out)
    return True


def response(issues, usage=True):
    return NS(
        parsed={"issues": issues},
        usage_metadata=NS(prompt_token_count=1500, candidates_token_count=90) if usage else None,
    )


class CriticTestCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.video = Path(self.tmp.name) / "final_video.mp4"
        self.video.write_bytes(b"0" * 1000)
        self.channel = NS(channel_id="history", agent=NS(spend_ceiling_usd=None))
        for p in (
            patch.dict(os.environ, {video_critic.ENV_FLAG: "1"}),
            patch("modules.video_critic._ffmpeg_exe", return_value="/usr/bin/ffmpeg"),
            patch("modules.video_critic._extract_frame", side_effect=fake_extract),
        ):
            p.start()
            self.addCleanup(p.stop)
        self.emitted = []
        p = patch("modules.event_log.emit", side_effect=lambda *a, **k: self.emitted.append((a, k)))
        p.start()
        self.addCleanup(p.stop)

    def critic(self, answers, n=3, **kw):
        """Run with `_ask` returning each of `answers` in turn (an Exception is raised)."""
        answers = list(answers)
        self.prompts = []

        def ask(client, model, jpeg, prompt):
            self.prompts.append(prompt)
            Image.open(io.BytesIO(jpeg)).verify()  # a real JPEG went out
            a = answers.pop(0)
            if isinstance(a, Exception):
                raise a
            return a

        kw.setdefault("costs", CostLedger(channel_id="history"))
        self.costs = kw["costs"]
        with patch("modules.video_critic._ask", side_effect=ask):
            return video_critic.run(
                self.video, script=script(n), timeline=timeline(n), channel=self.channel,
                client=object(), model="vision-model", **kw,
            )


class OffByDefaultTests(unittest.TestCase):
    def test_without_the_flag_nothing_is_called_written_or_emitted(self):
        with tempfile.TemporaryDirectory() as tmp, \
                patch.dict(os.environ, {video_critic.ENV_FLAG: ""}), \
                patch("modules.video_critic._ask") as ask, \
                patch("modules.event_log.emit") as emit:
            video = Path(tmp) / "final_video.mp4"
            video.write_bytes(b"0")
            report = video_critic.run(video, script=script(2), timeline=timeline(2), client=object())
            self.assertFalse((Path(tmp) / "critic_report.json").exists())
        ask.assert_not_called()
        emit.assert_not_called()
        self.assertEqual(report.status, "disabled")


class FrameTimesTests(unittest.TestCase):
    def test_one_frame_is_the_scene_midpoint_keyed_by_scene_id(self):
        times = video_critic.frame_times([{"start_ms": 0, "end_ms": 4000}, {"start_ms": 4000, "end_ms": 10_000}], 1)
        self.assertEqual(times, [("s000", 1, 2.0), ("s001", 1, 7.0)])

    def test_three_frames_are_spread_inside_the_scene(self):
        times = video_critic.frame_times([{"start_ms": 0, "end_ms": 8000}], 3)
        self.assertEqual([t for _, _, t in times], [2.0, 4.0, 6.0])

    def test_empty_or_broken_entries_are_skipped_but_indices_are_kept(self):
        times = video_critic.frame_times([{"start_ms": 0, "end_ms": 0}, {"bad": 1}, {"start_ms": 0, "end_ms": 2000}], 1)
        self.assertEqual(times, [("s002", 1, 1.0)])

    def test_frames_per_scene_is_clamped(self):
        with patch.dict(os.environ, {video_critic.ENV_FRAMES: "9"}):
            self.assertEqual(video_critic.frames_per_scene(), 3)
        with patch.dict(os.environ, {video_critic.ENV_FRAMES: "zero"}):
            self.assertEqual(video_critic.frames_per_scene(), 2)


class ReviewTests(CriticTestCase):
    def test_issues_are_reported_per_scene_and_written_next_to_the_video(self):
        report = self.critic([response([
            {"scene_id": "s001", "severity": "severe", "kind": "text_overflow", "note": "Caption runs off the right edge."},
            {"scene_id": "s002", "severity": "info", "kind": "bad_crop", "note": "Slightly tight."},
        ])])
        self.assertEqual(report.status, "ok")
        self.assertEqual(report.scenes_reviewed, 3)
        self.assertEqual(report.frames, 6)  # default 2 per scene
        self.assertEqual([i["scene_id"] for i in report.issues], ["s001", "s002"])
        written = json.loads((self.video.parent / "critic_report.json").read_text())
        self.assertTrue(written["advisory"])
        self.assertEqual(written["counts"], {"info": 1, "warn": 0, "severe": 1})

    def test_the_prompt_carries_each_scenes_narration(self):
        self.critic([response([])])
        self.assertIn("s000: Narration for section 0.", self.prompts[0])
        self.assertIn("s002: Narration for section 2.", self.prompts[0])

    def test_invented_scenes_and_unknown_severities_are_dropped(self):
        report = self.critic([response([
            {"scene_id": "s099", "severity": "severe", "kind": "empty_frame", "note": "not on the sheet"},
            {"scene_id": "s000", "severity": "catastrophic", "kind": "empty_frame", "note": "?"},
            {"scene_id": "s000", "severity": "warn", "kind": "weird_kind", "note": "odd"},
            "not an object",
        ])])
        self.assertEqual(report.dropped_issues, 3)
        self.assertEqual(report.issues, [{"scene_id": "s000", "severity": "warn", "kind": "other", "note": "odd"}])

    def test_no_issues_is_a_clean_ok_not_a_skip(self):
        report = self.critic([response([])])
        self.assertEqual(report.status, "ok")
        self.assertEqual(report.issues, [])

    def test_many_scenes_are_split_across_sheets(self):
        report = self.critic([response([]), response([])], n=13)
        self.assertEqual(report.vision_calls, 2)
        self.assertEqual(report.scenes_reviewed, 13)


class CostTests(CriticTestCase):
    def test_every_answered_call_is_in_the_ledger_with_its_tokens(self):
        self.critic([response([])])
        units = {(e.unit, e.stage): e.quantity for e in self.costs.entries}
        self.assertEqual(units[(VISION_CALLS, "critic")], 1)
        self.assertEqual(units[("gemini_input_tokens", "critic")], 1500)
        self.assertEqual(VISION_CALLS, "vision_calls")  # a schema string: add, don't rename

    def test_an_unparseable_answer_was_still_paid_for(self):
        report = self.critic([NS(parsed=None, text="not json at all", usage_metadata=None)])
        self.assertEqual(report.status, "failed")
        self.assertEqual([e.unit for e in self.costs.entries], [VISION_CALLS])

    def test_a_call_that_raised_is_not_counted(self):
        report = self.critic([RuntimeError("503")])
        self.assertEqual(report.status, "failed")
        self.assertEqual(report.reason, "vision_call_failed")
        self.assertEqual(self.costs.entries, [])

    def test_one_failed_sheet_of_two_is_partial(self):
        report = self.critic([response([]), RuntimeError("503")], n=13)
        self.assertEqual(report.status, "partial")
        self.assertEqual(report.scenes_reviewed, 12)


class BudgetTests(CriticTestCase):
    def _store(self):
        class Store:
            def __enter__(self):
                return self

            def __exit__(self, *a):
                return False

        return Store

    def test_a_met_ceiling_skips_the_call(self):
        self.channel.agent.spend_ceiling_usd = 10.0
        status = NS(spent_usd=9.5)
        costs = CostLedger(channel_id="history")
        costs.entries.append(CostEntry(unit="tts_characters", quantity=1, estimated_usd=0.6))
        with patch("modules.state_store.StateStore", self._store()), \
                patch("modules.budget.check_budget", return_value=status):
            report = self.critic([], costs=costs)
        self.assertEqual((report.status, report.reason), ("skipped", "budget_ceiling"))
        self.assertEqual(self.prompts, [])

    def test_room_under_the_ceiling_lets_it_run(self):
        self.channel.agent.spend_ceiling_usd = 10.0
        with patch("modules.state_store.StateStore", self._store()), \
                patch("modules.budget.check_budget", return_value=NS(spent_usd=2.0)):
            report = self.critic([response([])])
        self.assertEqual(report.status, "ok")

    def test_an_unreadable_ledger_is_unknown_spend_and_does_not_skip(self):
        self.channel.agent.spend_ceiling_usd = 10.0
        with patch("modules.state_store.StateStore", side_effect=RuntimeError("db down")):
            report = self.critic([response([])])
        self.assertEqual(report.status, "ok")


class NeverRaisesTests(CriticTestCase):
    def test_no_timeline_is_a_skip(self):
        with patch("modules.video_critic._ask") as ask:
            report = video_critic.run(self.video, script=script(2), timeline=[], client=object())
        self.assertEqual((report.status, report.reason), ("skipped", "no_timeline"))
        ask.assert_not_called()

    def test_no_gemini_key_is_a_skip(self):
        with patch("config.GEMINI_API_KEY", ""), patch("modules.video_critic._ask") as ask:
            report = video_critic.run(self.video, script=script(2), timeline=timeline(2))
        self.assertEqual(report.reason, "no_gemini_key")
        ask.assert_not_called()

    def test_frames_that_cannot_be_extracted_fail_honestly(self):
        with patch("modules.video_critic._extract_frame", return_value=False):
            report = self.critic([])
        self.assertEqual((report.status, report.reason), ("failed", "no_frames"))

    def test_an_unexpected_crash_is_reported_not_raised(self):
        with patch("modules.video_critic.frame_times", side_effect=ValueError("boom")):
            report = video_critic.run(self.video, timeline=timeline(2), client=object())
        self.assertEqual(report.status, "failed")
        self.assertEqual(report.reason, "errored:ValueError")


class EventTests(CriticTestCase):
    def test_a_summary_event_is_emitted(self):
        self.critic([response([{"scene_id": "s000", "severity": "warn", "kind": "repeated_visual", "note": "n" * 500}])])
        (args, kwargs), = self.emitted
        self.assertEqual(args[0], "video.critic")
        self.assertEqual(kwargs["channel_id"], "history")
        meta = kwargs["metadata"]
        self.assertEqual(meta["issues_total"], 1)
        self.assertEqual(meta["counts"]["warn"], 1)
        self.assertLessEqual(len(meta["issues"][0]["note"]), 160)

    def test_a_failed_critic_emits_a_failed_status(self):
        self.critic([RuntimeError("503")])
        (_, kwargs), = self.emitted
        self.assertEqual(kwargs["status"], "failed")


class GeminiCallTests(unittest.TestCase):
    def test_the_request_is_schema_constrained_and_carries_the_image(self):
        seen = {}

        class Models:
            def generate_content(self, model, contents, config):
                seen.update(model=model, contents=contents, config=config)
                return response([])

        out = video_critic._ask(NS(models=Models()), "vision-model", b"\xff\xd8jpeg", "prompt")
        self.assertEqual(out.parsed, {"issues": []})
        self.assertEqual(seen["model"], "vision-model")
        self.assertEqual(seen["config"].response_mime_type, "application/json")
        self.assertIsNotNone(seen["config"].response_schema)
        part, prompt = seen["contents"]
        self.assertEqual(part.inline_data.mime_type, "image/jpeg")
        self.assertEqual(prompt, "prompt")


class MainWiringTests(unittest.TestCase):
    def test_the_critic_runs_after_the_render_and_is_not_part_of_the_gate(self):
        source = (Path(__file__).resolve().parents[1] / "main.py").read_text()
        tree = ast.parse(source)
        calls = [n for n in ast.walk(tree)
                 if isinstance(n, ast.Call) and ast.unparse(n.func) == "video_critic.run"]
        self.assertEqual(len(calls), 1)
        gate_calls = [n for n in ast.walk(tree)
                      if isinstance(n, ast.Call) and ast.unparse(n.func) == "publish_gate.evaluate"]
        render = source.index("comp.render(")
        self.assertLess(render, source.index("video_critic.run("))
        for g in gate_calls:
            self.assertNotIn("critic", ast.unparse(g))


if __name__ == "__main__":
    unittest.main()

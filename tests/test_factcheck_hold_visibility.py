"""A run held before its video exists must be legible to the owner and the customer.

Review findings on the first version of the early fact-check stop:

* the flagged title / description / thumbnail / hook texts belonged to no scene, so the held row showed
  "0 flagged" for a run held because of them (``hold_detail.flagged`` now carries them);
* exit 79 left no traceback, so a customer read "Something went wrong" (the ``held`` job error code);
* the operator bot said "Blocked by the gate and kept" about a run with no video (``hold_detail.stage``);
* a re-run of the same topic kept the OLD cut's preview and manifest under the new text, and the old
  preview object stayed in the bucket unreferenced.

No network: Supabase is the in-memory fake from tests/test_video_review_record.py.
"""

from __future__ import annotations

import ast
import logging
import os
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from modules import claim_extractor as ce  # noqa: E402
from modules import held_video, publish_gate, render_error  # noqa: E402
from modules.fact_checker import _make_result, _safe_default  # noqa: E402
from modules.held_video import HeldVideos, held_video_id  # noqa: E402
from modules.operator_bot import views  # noqa: E402
from modules.operator_bot.i18n import LANGUAGES, t, table  # noqa: E402
from modules.video_review import VideoReview  # noqa: E402
from tests.test_video_review_record import FakeSupabase, KEY, URL, _patched  # noqa: E402

MAIN = ROOT / "main.py"


def claim(source, text, section_index=-1, n=1):
    return ce.Claim(f"x-{source}-{n}", section_index, text, source)


# ── the flagged texts ────────────────────────────────────────────────────

class FlaggedTextsReachTheHeldRow(unittest.TestCase):
    def test_only_uncleared_texts_outside_the_narration_are_listed(self):
        claims = [claim("narration", "The keeper vanished in 1900.", 1),
                  claim("title", "The Keeper Killed Them"), claim("description", "A fine accurate sentence here."),
                  claim("thumbnail_text", "NEVER OPENED!"), claim("hook_ab", "The alternate opening says so.", 0),
                  claim("title_ab", "Rome Fell In 410")]
        results = [_make_result(claims[0].text, "unverifiable", "n"),
                   _make_result(claims[1].text, "likely_inaccurate", "No evidence."),
                   _make_result(claims[2].text, "likely_accurate", ""),
                   _make_result(claims[3].text, "unverifiable", "Cannot tell."),
                   _make_result(claims[4].text, "unverifiable", "Alt."),
                   _safe_default(claims[5].text)]
        got = held_video.flagged_claims(claims, results)
        self.assertEqual([(f["source"], f["verdict"]) for f in got],
                         [("title", "likely_inaccurate"), ("thumbnail_text", "unverifiable"),
                          ("hook_ab", "unverifiable")])
        self.assertEqual(set(got[0]), {"source", "verdict", "reasoning", "text"})

    def test_count_and_lengths_are_capped(self):
        claims = [claim("description", "x" * 900, n=i) for i in range(50)]
        results = [_make_result("x" * 900, "unverifiable", "r" * 900) for _ in claims]
        got = held_video.flagged_claims(claims, results)
        self.assertEqual(len(got), held_video.MAX_FLAGGED_IN_DETAIL)
        self.assertEqual(len(got[0]["text"]), held_video.MAX_FLAGGED_TEXT)
        self.assertEqual(len(got[0]["reasoning"]), held_video.MAX_FLAGGED_REASONING)

    def test_a_broken_input_gives_an_empty_list_not_an_error(self):
        self.assertEqual(held_video.flagged_claims(None, None), [])
        self.assertEqual(held_video.flagged_claims([object()], [object()]), [])

    def test_the_run_after_the_render_records_them_too(self):
        src = MAIN.read_text()
        record = src[src.index("def _record_held_run"):src.index("video_id, video_url = None, None")]
        self.assertIn("held_video.flagged_claims(section_claims, fact_results)", record)
        self.assertIn('detail["flagged"] = flagged', record)


# ── a hold with no cut leaves nothing of an earlier cut behind ───────────

def _hold_runner(**over):
    """The real ``_hold_before_render`` from main.py with its globals supplied."""
    tree = ast.parse(MAIN.read_text())
    fn = next(n for n in ast.walk(tree) if isinstance(n, ast.FunctionDef) and n.name == "_hold_before_render")
    emitted = []
    ns = dict(
        held_video=held_video, VideoReview=VideoReview, logger=logging.getLogger("t"), print=lambda *a, **k: None,
        claim_scenes=SimpleNamespace(annotate_scenes=lambda *a: [{"name": "Hook"}]),
        events=SimpleNamespace(emit=lambda *a, **k: emitted.append((a, k)), PUBLISH_BLOCKED="publish.blocked",
                               STATUS_FAILED="failed"),
        _flush_costs=lambda costs, slug: None,
    )
    ns.update(over)
    exec(compile(ast.Module(body=[fn], type_ignores=[]), str(MAIN), "exec"), ns)
    return ns["_hold_before_render"], emitted


def _hold(fake, claims=(), results=()):
    run, emitted = _hold_runner()
    decision = publish_gate.GateDecision(blocks=["fact_check_flagged:1"], checks_run=["fact_check"])
    env = {"SUPABASE_URL": URL, "SUPABASE_SERVICE_KEY": KEY}
    with _patched(fake), mock.patch.dict(os.environ, env):
        run(SimpleNamespace(channel_id="news"), slug="the-lost-city", topic="The lost city",
            script=SimpleNamespace(title="The Lost City", full_narration=lambda: "the narration"),
            claims=list(claims), fact_results=list(results), decision=decision, costs=object())
    return emitted


class AnEarlyHoldIsNotTheOldCut(unittest.TestCase):
    HID = held_video_id("news", "the-lost-city")

    def seeded(self):
        fake = FakeSupabase()
        fake.rows[self.HID] = {
            "video_id": self.HID, "channel_id": "news", "slug": "the-lost-city", "publish_state": "held",
            "preview_path": f"news/{self.HID}.mp4", "local_path": "/out/old/final_video.mp4",
            "manifest": {"scenes": [{"id": "s000"}]}, "cut_sha256": "abc", "script_text": "the old narration",
            "title": "Old", "hold_detail": {"reason": "held"}}
        return fake

    def test_the_row_stops_pointing_at_the_old_cut(self):
        fake = self.seeded()
        _hold(fake)
        row = fake.rows[self.HID]
        self.assertIsNone(row["preview_path"])
        self.assertIsNone(row["local_path"])
        self.assertIsNone(row["manifest"])
        self.assertIsNone(row["cut_sha256"])
        self.assertEqual(row["publish_state"], "blocked")
        self.assertEqual(row["script_text"], "the narration")                 # the new text, not the old one
        self.assertEqual(row["hold_detail"]["stage"], "before_render")
        self.assertIsNone(row["published_at"])

    def test_the_old_preview_object_is_removed_from_the_bucket(self):
        fake = self.seeded()
        _hold(fake)
        deletes = [c for c in fake.calls if c[0] == "delete" and "/storage/" in c[1]]
        self.assertEqual([c[3] for c in deletes], [{"prefixes": [f"news/{self.HID}.mp4"]}])

    def test_an_object_that_is_not_a_held_run_preview_is_never_removed(self):
        fake = self.seeded()
        fake.rows[self.HID]["preview_path"] = "news/dQw4w9WgXcQ.mp4"          # an uploaded video's preview
        _hold(fake)
        self.assertEqual([c for c in fake.calls if c[0] == "delete" and "/storage/" in c[1]], [])

    def test_nothing_is_removed_when_the_row_could_not_be_written(self):
        fake = self.seeded()
        fake.missing = {"hold_detail"}                                          # a refused write
        with mock.patch.object(HeldVideos, "record_held", return_value=None):
            _hold(fake)
        self.assertEqual([c for c in fake.calls if c[0] == "delete" and "/storage/" in c[1]], [])

    def test_a_first_hold_with_no_earlier_row_removes_nothing_and_carries_the_flagged_texts(self):
        fake = FakeSupabase()
        claims = [claim("title", "The Keeper Killed Them")]
        _hold(fake, claims, [_make_result(claims[0].text, "likely_inaccurate", "No evidence.")])
        row = fake.rows[self.HID]
        self.assertEqual(row["hold_detail"]["flagged"][0]["source"], "title")
        self.assertEqual([c for c in fake.calls if c[0] == "delete" and "/storage/" in c[1]], [])

    def test_an_ordinary_hold_still_leaves_the_other_columns_alone(self):
        """no_cut is only for a hold with no video: a hold with one never blanks its preview."""
        fake = self.seeded()
        env = {"SUPABASE_URL": URL, "SUPABASE_SERVICE_KEY": KEY}
        with _patched(fake), mock.patch.dict(os.environ, env):
            HeldVideos().record_held(channel_id="news", slug="the-lost-city", state="blocked", title="T")
        self.assertEqual(fake.rows[self.HID]["preview_path"], f"news/{self.HID}.mp4")
        self.assertEqual(fake.rows[self.HID]["local_path"], "/out/old/final_video.mp4")

    def test_a_database_that_refuses_the_cleared_columns_still_records_the_hold(self):
        """Migrations 0004/0011/0013 are older than the held rows (0016), but the fallback must not depend on it."""
        fake = FakeSupabase(missing_columns={"preview_path"})
        _hold(fake)
        self.assertIn(self.HID, fake.rows)


# ── the customer's page and the worker ───────────────────────────────────

class TheCustomerIsToldTheScriptWasHeld(unittest.TestCase):
    HEADER = "main.py exited with code 79: the fact-check held the script before the video was made; nothing was charged"

    def test_the_held_exit_code_is_classified_by_the_workers_header(self):
        self.assertIn(render_error.HELD, render_error.CODES)
        self.assertEqual(render_error.classify(self.HEADER, ["INFO whatever the log said"]), "held")

    def test_no_other_exit_code_and_no_log_line_reads_as_held(self):
        self.assertEqual(render_error.classify("main.py exited with code 78: the channel's spend ceiling", []),
                         render_error.UNKNOWN)
        self.assertEqual(render_error.classify("main.py exited with code 1", ["fact-check held the script"]),
                         render_error.UNKNOWN)
        self.assertEqual(render_error.classify("main.py exited with code 790: x", []), render_error.UNKNOWN)

    def test_the_tag_carries_it_to_the_column_the_page_parses(self):
        tagged = render_error.tag(render_error.classify(self.HEADER, []), self.HEADER)
        self.assertTrue(tagged.startswith("[code:held] main.py exited with code 79"))
        self.assertEqual(render_error.code_of(tagged), "held")

    def test_the_typescript_code_list_has_the_same_codes_in_the_same_order(self):
        ts = (ROOT / "command-center" / "lib" / "runBackend.ts").read_text()
        line = next(ln for ln in ts.splitlines() if ln.startswith("export const JOB_ERROR_CODES"))
        self.assertEqual(tuple(c.strip(' "') for c in line.split("[")[1].split("]")[0].split(",")), render_error.CODES)


# ── the operator bot ─────────────────────────────────────────────────────

class TheOperatorBotDoesNotCallAnEmptyHoldAKeptVideo(unittest.TestCase):
    NEW_KEYS = ("status.held_early", "pending.v_held_early", "alert.video_held_early")

    def test_every_language_has_every_new_key_with_its_placeholders(self):
        base = table("en")
        for lang in LANGUAGES:
            for key in self.NEW_KEYS:
                with self.subTest(lang=lang, key=key):
                    text = table(lang)[key]
                    self.assertTrue(text)
                    for ph in ("{n}", "{channel}", "{video}"):
                        self.assertEqual(ph in text, ph in base[key])
        self.assertNotEqual(table("ru")["status.held_early"], base["status.held_early"])
        self.assertNotEqual(table("uz")["status.held_early"], base["status.held_early"])

    def test_the_wording_says_no_cut_exists(self):
        self.assertIn("no cut exists", table("en")["status.held_early"])
        self.assertIn("no cut exists", table("en")["alert.video_held_early"])

    def test_the_stage_the_pipeline_writes_is_the_one_the_bot_reads(self):
        from modules.operator_bot import sources
        self.assertEqual(sources.HOLD_STAGES, ("before_render",))
        self.assertIn('detail["stage"] = "before_render"', MAIN.read_text())

    def test_status_and_pending_count_them_apart_from_blocked_runs(self):
        from tests.test_operator_bot_owner_view import held, ops_with
        rows = [held("run-aaaaaaaaaaaaaaaaaaaa", "blocked", 10),
                {**held("run-bbbbbbbbbbbbbbbbbbbb", "blocked", 20), "hold_stage": "before_render"},
                {**held("run-cccccccccccccccccccc", "blocked", 30), "hold_stage": "before_render"},
                {**held("run-dddddddddddddddddddd", "blocked", 40), "hold_stage": "<b>free text</b>"}]
        ops, _ = ops_with({"videos": rows})
        for view in (views.view_status, views.view_pending):
            text = view(ops).text
            self.assertIn("Blocked by the gate and kept: 2", text)            # the ordinary one and the odd word
            self.assertIn("Held before the video was made (no cut exists): 2", text)
            self.assertNotIn("free text", text)

    def test_the_alert_for_such_a_row_says_so_and_a_plain_blocked_row_keeps_its_wording(self):
        from tests.test_reliability_alerts import at, run_detect, video
        found = run_detect(videos=[video("run-aaaa", state="blocked", held=at(14, 15, 30)),
                                   video("run-bbbb", state="blocked", held=at(14, 15, 31),
                                         detail={"stage": "before_render"})], now=at(14, 16, 0))[0]
        lines = {a.key.split(":")[2]: a.line for a in found if a.key.startswith("video:")}
        self.assertIn("The publish gate blocked a video", lines["run-aaaa"])
        self.assertIn("held before its video was made", lines["run-bbbb"])
        self.assertTrue(all(a.key.startswith("video:blocked:") for a in found if a.key.startswith("video:")))

    def test_only_the_one_fixed_word_survives_as_a_stage_in_the_evidence_read_too(self):
        from tests.test_reliability_alerts import at, make, video
        _, _, _, ops, _ = make(now=at(14, 16, 0))
        ops.sync.tables["videos"].append(video("run-kkkk", state="blocked", held=at(14, 15, 30),
                                               detail={"stage": "<b>free text</b>"}))
        ops.sync.tables["videos"].append(video("run-llll", state="blocked", held=at(14, 15, 31),
                                               detail={"stage": "before_render"}))
        rows = {r["video_id"]: r for r in ops.recent_videos(at(14, 0, 0), ["default"]).data}
        self.assertIsNone(rows["run-kkkk"]["hold_stage"])
        self.assertEqual(rows["run-llll"]["hold_stage"], "before_render")

    def test_the_stage_read_is_a_path_select_that_never_asks_for_the_whole_json(self):
        from tests.test_operator_bot_owner_view import ops_with
        ops, sync = ops_with()
        ops.held_videos()
        select = [p["select"] for name, p in sync.reads if name == "videos"][0]
        self.assertIn("hold_stage:hold_detail->>stage", select)
        self.assertNotIn("hold_detail", select.replace("hold_detail->>stage", ""))


class TelegramSaysNoVideoExists(unittest.TestCase):
    def test_the_early_stop_has_its_own_line_and_the_gate_block_keeps_its_own(self):
        from modules import telegram_control as tc
        early = tc.format_notification("publish.blocked", {"stage": "before_render", "blocks": ["x"]})
        self.assertIn("Held before the video was made", early)
        self.assertNotIn("kept for review", early)
        late = tc.format_notification("publish.blocked", {"blocks": ["x"], "title": "T"})
        self.assertIn("kept for review: T", late)


if __name__ == "__main__":
    unittest.main()

"""A run held before its video exists must be legible to the owner and the customer.

Review findings on the first version of the early fact-check stop:

* the flagged title / description / thumbnail / hook texts belonged to no scene, so the held row showed
  "0 flagged" for a run held because of them (``hold_detail.flagged`` now carries them);
* exit 79 left no traceback, so a customer read "Something went wrong" (the ``held`` job error code);
* the operator bot said "Blocked by the gate and kept" about a run with no video (``hold_detail.stage``);
* a re-run of the same topic would have replaced (or blanked) a cut a person may still be reviewing under the
  same row key: a row that holds a cut is now left exactly as it is.

No network: Supabase is the in-memory fake from tests/test_video_review_record.py.
"""

from __future__ import annotations

import ast
import json
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


# ── an early hold never replaces a cut somebody may be reviewing ─────────

def _hold_runner(**over):
    """The real ``_hold_before_render`` from main.py with its globals supplied."""
    tree = ast.parse(MAIN.read_text())
    fn = next(n for n in ast.walk(tree) if isinstance(n, ast.FunctionDef) and n.name == "_hold_before_render")
    emitted = []
    ns = dict(
        held_video=held_video, logger=logging.getLogger("t"), print=lambda *a, **k: None,
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


class AnEarlyHoldNeverReplacesACutSomebodyMayBeReviewing(unittest.TestCase):
    HID = held_video_id("news", "the-lost-city")

    def seeded(self, **over):
        fake = FakeSupabase()
        row = {"video_id": self.HID, "channel_id": "news", "slug": "the-lost-city", "publish_state": "held",
               "preview_path": f"news/{self.HID}.mp4", "local_path": "/out/old/final_video.mp4",
               "manifest": {"scenes": [{"id": "s000"}]}, "cut_sha256": "abc", "script_text": "the old narration",
               "title": "Old", "hold_detail": {"reason": "held"}, "scenes": [{"name": "Old"}]}
        row.update(over)
        fake.rows[self.HID] = row
        return fake

    def test_a_row_that_holds_a_preview_is_left_exactly_as_it_is_in_every_held_state(self):
        for state in ("held", "awaiting_approval", "repaired_awaiting_review", "blocked"):
            with self.subTest(state=state):
                fake = self.seeded(publish_state=state)
                before = dict(fake.rows[self.HID])
                _hold(fake)
                self.assertEqual(fake.rows[self.HID], before)
                self.assertEqual([c for c in fake.calls if c[0] in ("post", "patch")], [])
                self.assertEqual([c for c in fake.calls if c[0] == "delete"], [])      # nothing removed from storage

    def test_a_row_with_only_a_local_cut_is_left_alone_too(self):
        fake = self.seeded(preview_path=None)
        before = dict(fake.rows[self.HID])
        _hold(fake)
        self.assertEqual(fake.rows[self.HID], before)

    def test_the_run_still_stops_and_says_why_when_the_row_is_left_alone(self):
        claims = [claim("title", "Napoleon Was Poisoned")]
        emitted = _hold(self.seeded(), claims, [_make_result(claims[0].text, "unverifiable", "Cannot tell.")])
        self.assertEqual([a[0] for a, _ in emitted], ["publish.blocked"])
        meta = emitted[0][1]["metadata"]
        self.assertEqual(meta["stage"], "before_render")
        # no row is written, so the rows-based alerts are silent: the event is what reads
        self.assertEqual((meta["row"], meta["slug"], meta["video_id"]), ("kept_existing_cut", "the-lost-city", self.HID))
        self.assertEqual([(f["source"], f["verdict"], f["text"]) for f in meta["flagged"]],
                         [("title", "unverifiable", "Napoleon Was Poisoned")])
        self.assertNotIn("The Lost City", json.dumps(meta))            # the script's title and narration are not in it
        self.assertNotIn("the narration", json.dumps(meta))

    def test_the_event_is_emitted_even_when_recording_the_row_blows_up(self):
        with mock.patch.object(HeldVideos, "has_cut", side_effect=RuntimeError("boom")):
            emitted = _hold(FakeSupabase())
        self.assertEqual(len(emitted), 1)
        self.assertEqual(emitted[0][1]["metadata"]["row"], "not_recorded")

    def test_the_event_says_what_happened_to_the_row_in_each_case(self):
        written = _hold(FakeSupabase())[0][1]["metadata"]
        self.assertEqual(written["row"], "written")
        with mock.patch.object(HeldVideos, "has_cut", return_value=None), self.assertLogs("t", "WARNING") as logs:
            failed = _hold(self.seeded())[0][1]["metadata"]
        self.assertEqual(failed["row"], "lookup_failed")
        self.assertTrue(any("could not be read" in line for line in logs.output))
        env = {}                                                       # an inert client: nothing is written, nothing to protect
        with mock.patch.dict(os.environ, env, clear=False), mock.patch.object(HeldVideos, "has_cut", return_value=False), \
                mock.patch.object(HeldVideos, "record_held", return_value=None):
            self.assertEqual(_hold(FakeSupabase())[0][1]["metadata"]["row"], "not_recorded")

    def test_a_lookup_that_fails_is_read_as_maybe_and_writes_nothing(self):
        fake = self.seeded()
        with mock.patch.object(HeldVideos, "has_cut", return_value=None):
            before = dict(fake.rows[self.HID])
            _hold(fake)
        self.assertEqual(fake.rows[self.HID], before)
        fake = FakeSupabase(fail=True)                                         # every request raises
        emitted = _hold(fake)
        self.assertEqual(fake.rows, {})
        self.assertEqual(len(emitted), 1)

    def test_a_lookup_that_fails_while_the_write_would_work_writes_nothing(self):
        """The real failure shape: the read errors, the upsert would succeed, and the row must still not change."""
        class ReadsFail(FakeSupabase):
            def get(self, *a, **k):
                raise ConnectionError("read failed")

        fake = ReadsFail()
        fake.rows[self.HID] = {"video_id": self.HID, "channel_id": "news", "publish_state": "held",
                               "preview_path": "news/x.mp4", "script_text": "the old narration"}
        before = dict(fake.rows[self.HID])
        emitted = _hold(fake)
        self.assertEqual(fake.rows[self.HID], before)
        self.assertEqual(len(emitted), 1)

    def test_a_row_without_a_cut_is_written_and_loses_its_stale_manifest(self):
        fake = self.seeded(preview_path=None, local_path=None)
        _hold(fake)
        row = fake.rows[self.HID]
        self.assertIsNone(row["manifest"])
        self.assertIsNone(row["cut_sha256"])
        self.assertEqual(row["publish_state"], "blocked")
        self.assertEqual(row["script_text"], "the narration")
        self.assertEqual(row["hold_detail"]["stage"], "before_render")
        self.assertIsNone(row["published_at"])

    def test_a_first_hold_with_no_row_is_written_with_the_flagged_texts(self):
        fake = FakeSupabase()
        claims = [claim("title", "The Keeper Killed Them")]
        _hold(fake, claims, [_make_result(claims[0].text, "likely_inaccurate", "No evidence.")])
        row = fake.rows[self.HID]
        self.assertEqual(row["hold_detail"]["flagged"][0]["source"], "title")
        self.assertEqual(row["hold_detail"]["stage"], "before_render")

    def test_has_cut_is_false_for_an_inert_client_and_for_a_missing_row(self):
        self.assertFalse(HeldVideos(url="", service_key="").has_cut(self.HID))
        with _patched(FakeSupabase()):
            self.assertFalse(HeldVideos(url=URL, service_key=KEY).has_cut(self.HID))

    def test_an_ordinary_hold_still_leaves_the_other_columns_alone(self):
        """no_cut is only for a hold with no video: a hold with one never blanks its preview."""
        fake = self.seeded()
        env = {"SUPABASE_URL": URL, "SUPABASE_SERVICE_KEY": KEY}
        with _patched(fake), mock.patch.dict(os.environ, env):
            HeldVideos().record_held(channel_id="news", slug="the-lost-city", state="blocked", title="T")
        self.assertEqual(fake.rows[self.HID]["preview_path"], f"news/{self.HID}.mp4")
        self.assertEqual(fake.rows[self.HID]["local_path"], "/out/old/final_video.mp4")

    def test_the_helper_no_longer_touches_the_bucket(self):
        src = MAIN.read_text()
        body = src[src.index("def _hold_before_render"):src.index("def _effective_privacy")]
        self.assertNotIn("delete_objects", body)
        self.assertNotIn("VideoReview", body)


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

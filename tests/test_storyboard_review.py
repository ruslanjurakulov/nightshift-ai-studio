"""Storyboard review: the run stops before the render is paid for, waits for a
person, and resumes from exactly what was approved (modules/storyboard_review.py,
migration 0057, the runners around it).

What would break without these:

* a channel that never turned review on making a Supabase call — or pausing —
  on every run (autopilot and scheduled runs must behave exactly as before);
* a channel with review on rendering on its own because the storyboard could
  not be stored (an outage must stop the run, never skip the checkpoint);
* a second run of the same topic adding a second storyboard, or rendering past
  one that is still waiting;
* a discarded storyboard rendering on a resume;
* the approved render using another script than the one the person read, or
  picking a different opening (hook) than the approved one;
* the planning run's credit hold being CAPTURED when the run pauses — with any
  unpriced ledger entry that would charge the whole render for a plan;
* the price being computed from anything but the storyboard's own scenes.
"""

from __future__ import annotations

import ast
import io
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from modules import credits  # noqa: E402
from modules import storyboard_review as sb  # noqa: E402
from modules.channels import AgentConfig, ChannelContext  # noqa: E402
from modules.script_engine import Script, ScriptEngine, ScriptSection  # noqa: E402
from tools import credits_settle  # noqa: E402
from tools import queue_worker as qw  # noqa: E402

MAIN = ROOT / "main.py"
WORKFLOW = ROOT / ".github" / "workflows" / "daily_video.yml"
SB_ID = "0b8f7a52-3f9c-4d1e-9b7a-1c2d3e4f5a6b"


def make_script(n=3, hint=40, keywords=("storm waves", "lighthouse")):
    sections = [
        ScriptSection(name=f"part {i}", narration=f"[SFX:whoosh] Line {i} of the story. [PAUSE:0.5]",
                      duration_hint=hint, section_type="hook" if i == 0 else "story",
                      keywords=list(keywords))
        for i in range(n)
    ]
    return Script(topic="The Lighthouse Keeper", title="The Last Lighthouse", title_ab="", description="d",
                  tags=["t"], hook_sentence="h", sections=sections, thumbnail_prompt_a="a",
                  thumbnail_prompt_b="b", thumbnail_overlay_text="o", open_loops=[], hook_ab="Alt open.")


def ctx(on=True):
    return ChannelContext(channel_id="news", name="News", niche="history",
                          agent=AgentConfig.from_dict({"storyboard_review": on}))


class Resp:
    def __init__(self, status=200, body=None):
        self.status_code = status
        self._body = body

    def json(self):
        if self._body is None:
            raise ValueError("no json")
        return self._body


class FakeHttp:
    """PostgREST in memory: storyboards rows, and a switch to make it fail."""

    def __init__(self, rows=(), *, down=False, conflict=False):
        self.rows = [dict(r) for r in rows]
        self.down = down
        self.conflict = conflict
        self.calls = []

    def get(self, url, params=None, headers=None, timeout=None):
        self.calls.append(("get", params))
        if self.down:
            return Resp(503)
        hits = [r for r in self.rows
                if f"eq.{r['channel_id']}" == params["channel_id"] and f"eq.{r['slug']}" == params["slug"]]
        return Resp(200, hits[-1:])

    def post(self, url, params=None, json=None, headers=None, timeout=None):
        self.calls.append(("post", json))
        if self.down:
            return Resp(500)
        if self.conflict:
            self.rows.append({**json, "id": SB_ID, "status": "ready"})
            return Resp(409, {"code": "23505"})
        row = {**json, "id": SB_ID, "status": "ready"}
        self.rows.append(row)
        return Resp(201, [{"id": SB_ID}])

    def patch(self, url, params=None, json=None, headers=None, timeout=None):
        self.calls.append(("patch", params, json))
        return Resp(204)


def store(http):
    return sb.StoryboardStore("https://db.example", "service-key-value", session=http)


class Toggle(unittest.TestCase):
    def test_off_unless_explicitly_true(self):
        self.assertFalse(AgentConfig().storyboard_review)
        self.assertFalse(AgentConfig.from_dict({}).storyboard_review)
        self.assertFalse(AgentConfig.from_dict({"storyboard_review": "true"}).storyboard_review)
        self.assertFalse(AgentConfig.from_dict({"storyboard_review": 1}).storyboard_review)
        self.assertTrue(AgentConfig.from_dict({"storyboard_review": True}).storyboard_review)

    def test_round_trips_through_the_agent_config(self):
        cfg = AgentConfig.from_dict({"storyboard_review": True})
        self.assertTrue(AgentConfig.from_dict(cfg.to_dict()).storyboard_review)
        self.assertTrue(sb.enabled(ctx(True)))
        self.assertFalse(sb.enabled(ctx(False)))


class Cards(unittest.TestCase):
    def test_one_card_per_scene_in_order_with_spoken_text_and_footage(self):
        cards = sb.scene_cards(make_script(3))
        self.assertEqual([c["n"] for c in cards], [1, 2, 3])
        # What will be spoken, not the cue markup.
        self.assertEqual(cards[0]["narration"], "Line 0 of the story.")
        self.assertEqual(cards[0]["visual"], "storm waves, lighthouse")
        self.assertEqual(cards[0]["duration_s"], 40)
        self.assertEqual(cards[0]["type"], "hook")

    def test_the_render_is_priced_from_the_scenes_and_held_to_run_bounds(self):
        self.assertEqual(sb.priced_duration(sb.scene_cards(make_script(3, hint=40))), 120)
        self.assertEqual(sb.priced_duration(sb.scene_cards(make_script(1, hint=5))), 30)
        self.assertEqual(sb.priced_duration(sb.scene_cards(make_script(10, hint=600))), 3600)

    def test_price_floor_for_the_storyboard_matches_the_runners_check(self):
        # 0057's below_floor and 0041's guard use the same rule as
        # modules/credits.minimum_reservation: the queued job carries
        # duration_s, so the runner's floor is computed from the same number.
        prices = {"video_minute": credits.Price(12.0, 0.0), "job_minimum": credits.Price(5.0, 0.0)}
        row = sb.build_row(channel_id="news", slug="the-lighthouse-keeper", topic="The Lighthouse Keeper",
                           script=make_script(5, hint=60), hook_variant="A")
        self.assertEqual(row["duration_s"], 300)
        self.assertEqual(credits.minimum_reservation(prices, row["duration_s"]), 60.0)

    def test_a_plan_a_storyboard_cannot_show_whole_is_refused_not_truncated(self):
        with self.assertRaises(sb.StoryboardUnavailable):
            sb.scene_cards(make_script(sb.MAX_SCENES + 1))
        with self.assertRaises(sb.StoryboardUnavailable):
            sb.scene_cards(make_script(0))

    def test_long_text_is_clipped_to_the_database_bounds(self):
        s = make_script(1)
        s.sections[0].narration = "word " * 2000
        s.sections[0].keywords = ["x" * 2000]
        card = sb.scene_cards(s)[0]
        self.assertLessEqual(len(card["narration"]), sb.MAX_NARRATION)
        self.assertLessEqual(len(card["visual"]), sb.MAX_VISUAL)

    def test_a_topic_with_no_run_key_cannot_be_resumed_so_it_stops(self):
        with self.assertRaises(sb.StoryboardUnavailable):
            sb.build_row(channel_id="news", slug="", topic="???", script=make_script(), hook_variant="A")


class Checkpoint(unittest.TestCase):
    def run_cp(self, http, *, on=True, resume=False, approved=None, notify=None):
        return sb.checkpoint(ctx(on), slug="the-lighthouse-keeper", topic="The Lighthouse Keeper",
                             script=make_script(), hook_variant="B", resume=resume, approved=approved,
                             store=store(http), notify=notify or (lambda c, r: None))

    def test_review_off_makes_no_request_and_goes_on(self):
        http = FakeHttp(down=True)
        self.assertIsNone(self.run_cp(http, on=False))
        self.assertEqual(http.calls, [])

    def test_review_on_stores_the_storyboard_and_stops_before_the_render(self):
        http, told = FakeHttp(), []
        with self.assertRaises(sb.StoryboardPaused) as cm:
            self.run_cp(http, notify=lambda c, r: told.append(r))
        self.assertEqual((cm.exception.storyboard_id, cm.exception.reason), (SB_ID, "ready"))
        (_, row), = [c for c in http.calls if c[0] == "post"]
        # It starts as the database default ('ready', undecided, unpaid — 0057's insert guard).
        self.assertNotIn("status", row)
        self.assertEqual(row["duration_s"], 120)
        self.assertEqual(row["hook_variant"], "B")
        # The script the render resumes from — with its cue markup intact.
        self.assertIn("[SFX:whoosh]", row["script"]["sections"][0]["narration"])
        self.assertEqual(len(told), 1)

    def test_an_outage_with_review_on_stops_the_run_instead_of_rendering(self):
        with self.assertRaises(sb.StoryboardUnavailable):
            self.run_cp(FakeHttp(down=True))

    def test_review_on_without_supabase_stops_the_run(self):
        with self.assertRaises(sb.StoryboardUnavailable):
            sb.checkpoint(ctx(True), slug="the-lighthouse-keeper", topic="The Lighthouse Keeper",
                          script=make_script(), hook_variant="A", resume=False, approved=None,
                          store=sb.StoryboardStore("", ""))

    def test_one_waiting_storyboard_per_run(self):
        http = FakeHttp([{"id": SB_ID, "channel_id": "news", "slug": "the-lighthouse-keeper", "status": "ready"}])
        with self.assertRaises(sb.StoryboardPaused) as cm:
            self.run_cp(http)
        self.assertEqual(cm.exception.reason, "waiting")
        self.assertFalse([c for c in http.calls if c[0] == "post"])

    def test_a_race_on_the_same_run_waits_on_the_other_storyboard(self):
        with self.assertRaises(sb.StoryboardPaused) as cm:
            self.run_cp(FakeHttp(conflict=True))
        self.assertEqual(cm.exception.reason, "waiting")

    def test_a_resume_never_renders_a_discarded_storyboard(self):
        row = {"id": SB_ID, "channel_id": "news", "slug": "the-lighthouse-keeper", "status": "discarded"}
        for on in (True, False):
            with self.assertRaises(sb.StoryboardPaused) as cm:
                self.run_cp(FakeHttp([row]), on=on, resume=True)
            self.assertEqual(cm.exception.reason, "discarded")

    def test_a_resume_with_review_off_still_waits_on_an_undecided_storyboard(self):
        row = {"id": SB_ID, "channel_id": "news", "slug": "the-lighthouse-keeper", "status": "ready"}
        with self.assertRaises(sb.StoryboardPaused):
            self.run_cp(FakeHttp([row]), on=False, resume=True)

    def test_a_fresh_plan_of_a_discarded_topic_is_a_new_storyboard(self):
        row = {"id": "x", "channel_id": "news", "slug": "the-lighthouse-keeper", "status": "discarded"}
        http = FakeHttp([row])
        with self.assertRaises(sb.StoryboardPaused) as cm:
            self.run_cp(http)
        self.assertEqual(cm.exception.reason, "ready")

    def test_an_approved_storyboard_this_run_did_not_load_is_not_rendered_blind(self):
        row = {"id": SB_ID, "channel_id": "news", "slug": "the-lighthouse-keeper", "status": "approved"}
        with self.assertRaises(sb.StoryboardPaused) as cm:
            self.run_cp(FakeHttp([row]), resume=True)
        self.assertEqual(cm.exception.reason, "not_applied")

    def test_the_approved_storyboard_goes_on_to_the_render_without_a_request(self):
        http = FakeHttp(down=True)
        approved = sb.Approved(SB_ID, Path("x"), "A", 120)
        self.assertIsNone(self.run_cp(http, resume=True, approved=approved))
        self.assertEqual(http.calls, [])

    def test_review_off_resume_with_an_outage_continues_as_before(self):
        self.assertIsNone(self.run_cp(FakeHttp(down=True), on=False, resume=True))

    def test_errors_never_carry_the_key(self):
        try:
            self.run_cp(FakeHttp(down=True))
        except sb.StoryboardUnavailable as e:
            self.assertNotIn("service-key-value", str(e))


class ResumeFromApproved(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.out = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def approved_row(self, **kw):
        s = make_script(2)
        s.sections[0].narration = "The approved opening, as the person read it."
        row = {"id": SB_ID, "channel_id": "news", "slug": "the-lighthouse-keeper", "status": "approved",
               "script": s.to_dict(), "hook_variant": "B", "duration_s": 80}
        row.update(kw)
        return row

    def test_the_render_resumes_from_the_approved_script(self):
        http = FakeHttp([self.approved_row()])
        got = sb.approved_for_resume("news", "The Lighthouse Keeper", store=store(http), output_dir=self.out)
        self.assertEqual(got.storyboard_id, SB_ID)
        self.assertEqual(got.hook_variant, "B")
        self.assertEqual(got.script_path, self.out / "the-lighthouse-keeper" / "script.json")
        # The same parser --script-file uses reads exactly what was approved.
        loaded = ScriptEngine.load(got.script_path, "The Lighthouse Keeper")
        self.assertEqual(loaded.sections[0].narration, "The approved opening, as the person read it.")
        self.assertEqual(len(loaded.sections), 2)

    def test_a_run_is_found_under_its_channels_keyed_name_or_the_topics_own(self):
        """BR-G-007: the run directory is keyed by the channel for a customer
        organization; a storyboard of a run begun before the key is stored under
        the topic's own slug. Both are looked up, the channel's own row only."""
        from modules import run_slug

        topic = "The Lighthouse Keeper"
        keyed = run_slug.keyed_slug(topic, "news")
        for stored_as in (keyed, "the-lighthouse-keeper"):
            http = FakeHttp([self.approved_row(slug=stored_as)])
            got = sb.approved_for_resume("news", topic, store=store(http), output_dir=self.out,
                                         slugs=run_slug.candidates(topic, "news"))
            self.assertEqual(got.script_path, self.out / stored_as / "script.json")
        # Another channel's approved storyboard for the same topic is never this channel's.
        http = FakeHttp([self.approved_row(channel_id="other", slug=keyed)])
        self.assertIsNone(sb.approved_for_resume("news", topic, store=store(http), output_dir=self.out,
                                                 slugs=run_slug.candidates(topic, "news")))

    def test_nothing_to_resume_unless_approved(self):
        for status in ("ready", "discarded", "rendered"):
            http = FakeHttp([self.approved_row(status=status)])
            self.assertIsNone(sb.approved_for_resume("news", "The Lighthouse Keeper", store=store(http),
                                                     output_dir=self.out))
        self.assertIsNone(sb.approved_for_resume("news", "The Lighthouse Keeper",
                                                 store=store(FakeHttp(down=True)), output_dir=self.out))

    def test_a_malformed_script_is_refused_not_repaired(self):
        for bad in ({"sections": "rm -rf /"}, {"sections": [{"narration": 5}]}, "not an object", None):
            http = FakeHttp([self.approved_row(script=bad)])
            with self.assertRaises(sb.StoryboardUnavailable):
                sb.approved_for_resume("news", "The Lighthouse Keeper", store=store(http), output_dir=self.out)

    def test_marking_rendered_only_moves_an_approved_row(self):
        http = FakeHttp()
        self.assertTrue(sb.mark_rendered(sb.Approved(SB_ID, Path("x"), "A", 60), store(http)))
        (_, params, body), = [c for c in http.calls if c[0] == "patch"]
        self.assertEqual(params, {"id": f"eq.{SB_ID}", "status": "eq.approved"})
        self.assertEqual(body["status"], "rendered")
        self.assertFalse(sb.mark_rendered(None, store(http)))

    # ── edited before approval (migration 0058) ──────────────────────────

    def edited_row(self, **kw):
        """A storyboard as save_storyboard_edits leaves it: scene 2 moved first
        with its section untouched (cues and all), scene 1 rewritten as plain
        text with new search terms and a measured length, one scene added."""
        s = make_script(2).to_dict()
        rewritten = dict(s["sections"][0], narration="A person's own words [not a cue].",
                         keywords=["harbour", "dawn"], duration_hint=3)
        added = {"name": "Added scene", "type": "story", "voice": "main", "narration": "Closing line.",
                 "duration_hint": 1, "cut_interval": 5.0, "keywords": []}
        s["sections"] = [s["sections"][1], rewritten, added]
        return self.approved_row(script=s, opening_edited=True, revision=3, **kw)

    def test_the_render_uses_the_edited_scenes_in_their_new_order(self):
        http = FakeHttp([self.edited_row()])
        got = sb.approved_for_resume("news", "The Lighthouse Keeper", store=store(http), output_dir=self.out)
        loaded = ScriptEngine.load(got.script_path, "The Lighthouse Keeper")
        self.assertEqual([s.name for s in loaded.sections], ["part 1", "part 0", "Added scene"])
        self.assertEqual(loaded.sections[1].narration, "A person's own words [not a cue].")
        self.assertEqual(loaded.sections[1].keywords, ["harbour", "dawn"])
        # The untouched scene keeps the cues it was written with; the person's
        # text carries none (0058 refuses cue markup in an edit).
        self.assertTrue(loaded.sections[0].sfx_cues)
        self.assertEqual(loaded.sections[1].sfx_cues, [])
        self.assertEqual(loaded.sections[1].clean_narration(), "A person's own words [not a cue].")

    def test_an_edited_opening_is_not_credited_to_a_hook_arm(self):
        got = sb.approved_for_resume("news", "The Lighthouse Keeper", store=store(FakeHttp([self.edited_row()])),
                                     output_dir=self.out)
        self.assertTrue(got.opening_edited)
        # A database without 0058 has no such column: the opening is the plan's.
        plain = sb.approved_for_resume("news", "The Lighthouse Keeper", store=store(FakeHttp([self.approved_row()])),
                                       output_dir=self.out)
        self.assertFalse(plain.opening_edited)

    def test_the_lookup_never_names_a_column_an_older_database_lacks(self):
        http = FakeHttp([self.approved_row()])
        sb.approved_for_resume("news", "The Lighthouse Keeper", store=store(http), output_dir=self.out)
        (_, params), = [c for c in http.calls if c[0] == "get"]
        self.assertEqual(params["select"], "*")


# ── the money around a paused run ─────────────────────────────────────────

CUSTOMER_ORG = "11111111-2222-3333-4444-555555555555"
FAKE_MAIN = ("import os, sys\nopen('report.out', 'w').write('ran')\n"
             "sys.exit(int(os.environ.get('FAKE_RC', '0')))\n")


class FakeCredits:
    def __init__(self):
        self.calls = []

    def channel_org(self, channel_id):
        return CUSTOMER_ORG

    def start(self, ref, org):
        self.calls.append(("start", ref))
        return 60.0

    def prices(self):
        return {"video_minute": credits.Price(12.0, 0.0)}

    def capture(self, ref, amount):
        self.calls.append(("capture", ref, amount))
        return amount

    def release(self, ref):
        self.calls.append(("release", ref))
        return 60.0

    def expire(self):
        return 0

    def settled(self):
        return [c for c in self.calls if c[0] in ("capture", "release")]


class FakeQueue:
    def __init__(self, jobs):
        self.jobs = list(jobs)
        self.ends = []

    def claim(self, worker_id, stale_minutes):
        return self.jobs.pop(0) if self.jobs else None

    def heartbeat(self, job_id, worker_id):
        return True

    def finish(self, job_id, worker_id, status, error):
        self.ends.append((status, error))
        return True

    def release(self, job_id, worker_id, *, status, attempts, error):
        self.ends.append(("released:" + status, error))
        return True


class PausedRunIsNotCharged(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.repo = Path(self.tmp.name)
        (self.repo / "main.py").write_text(FAKE_MAIN)

    def tearDown(self):
        self.tmp.cleanup()

    def run_job(self, rc):
        fake = FakeCredits()
        q = FakeQueue([{"id": 3, "channel_id": "news", "kind": "daily", "params": {"duration": 300},
                        "attempts": 1, "max_attempts": 3, "created_at": "2026-10-01T10:00:00+00:00",
                        "credit_ref": "rj-plan"}])
        env = {"PATH": os.environ.get("PATH", ""), "FAKE_RC": str(rc)}
        w = qw.Worker(q, worker_id="w1", env=env, repo_dir=self.repo, prelude=[],
                      resolve_channel=lambda cid: {"channel_id": cid, "is_default": False,
                                                   "token_secret": "CHRONOS_YT_TOKEN_NEWS"},
                      heartbeat_seconds=0.05, out=io.StringIO(), credits=fake,
                      # An unpriced planning entry: captured, it would charge the whole hold.
                      ledger_reader=lambda ch, since: [{"unit": "gemini_input_tokens", "quantity": 5000,
                                                        "channel_id": ch,
                                                        "recorded_at": "2026-10-01T10:01:00+00:00"}])
        job = q.claim("w1", 10)
        return w.process(job), q.ends, fake

    def test_the_worker_releases_a_run_that_stopped_at_its_storyboard(self):
        outcome, ends, fake = self.run_job(sb.PAUSED_EXIT)
        self.assertEqual(outcome, "paused")
        # The job did its part; it is not a failure in the queue.
        self.assertEqual(ends, [("succeeded", None)])
        self.assertEqual(fake.settled(), [("release", "rj-plan")])

    def test_a_finished_run_is_still_captured_as_before(self):
        outcome, _, fake = self.run_job(0)
        self.assertEqual(outcome, "succeeded")
        self.assertEqual(fake.settled(), [("capture", "rj-plan", 60.0)])

    def test_the_actions_settle_step_releases_a_paused_run(self):
        fake = FakeCredits()
        env = {"CREDIT_REF": "gh-plan", "CHANNEL_ID": "news", "CREDITS_HOLD": "60.00",
               "CREDITS_ORG": CUSTOMER_ORG, "RUN_OUTCOME": "success", "RUN_PAUSED": "true"}
        credits_settle.settle(env, fake, ledger=lambda *_: [{"unit": "gemini_input_tokens", "quantity": 1}])
        self.assertEqual(fake.settled(), [("release", "gh-plan")])


# ── the wiring, parsed (main.py needs the render stack to import) ─────────

class Wiring(unittest.TestCase):
    def setUp(self):
        self.src = MAIN.read_text()
        self.tree = ast.parse(self.src)

    def _run(self):
        return next(n for n in ast.walk(self.tree) if isinstance(n, ast.FunctionDef) and n.name == "run")

    def test_the_checkpoint_comes_before_any_paid_scene_generation(self):
        body = ast.get_source_segment(self.src, self._run())
        cp = body.index("storyboard_review.checkpoint(")
        for paid in ("mixer.build(script)", "fetcher.generate_broll(", "fetcher.generate_images(",
                     "render_dispatch.render_video("):
            self.assertLess(cp, body.index(paid), f"{paid} runs before the storyboard checkpoint")
        # And after the plan exists: the fact-check and the hook choice.
        self.assertGreater(cp, body.index("fact_check_claims("))
        self.assertGreater(cp, body.index("_pick_hook(channel_id)"))

    def test_the_approved_script_is_loaded_through_the_resume_path(self):
        body = ast.get_source_segment(self.src, self._run())
        self.assertIn("storyboard_review.approved_for_resume(", body)
        self.assertIn("channel_id, topic,", body)
        # BR-G-007: the run is looked up under the names its channel keys it by.
        self.assertIn("slugs=run_slug.candidates(topic, str(channel_id), operators=ctx.is_operators)", body)
        self.assertLess(body.index("approved_for_resume("), body.index("ScriptEngine.load(Path(script_file)"))

    def test_an_edited_opening_records_no_hook_arm(self):
        body = ast.get_source_segment(self.src, self._run())
        start = body.index("hook_variant = approved_storyboard.hook_variant")
        branch = body[start:body.index("else:", start)]
        self.assertIn("if approved_storyboard.opening_edited:", branch)
        self.assertIn('hook_variant = ""', branch)

    def test_a_paused_run_exits_with_the_code_the_runners_read(self):
        self.assertIn("sys.exit(storyboard_review.PAUSED_EXIT)", self.src)
        self.assertEqual(sb.PAUSED_EXIT, qw.STORYBOARD_PAUSED_EXIT)

    def test_the_workflow_maps_the_pause_to_a_released_hold(self):
        text = WORKFLOW.read_text()
        self.assertIn(f'if [ "$rc" -eq {sb.PAUSED_EXIT} ]; then', text)
        self.assertIn('echo "paused=true" >> "$GITHUB_OUTPUT"', text)
        self.assertIn("RUN_PAUSED: ${{ steps.run.outputs.paused }}", text)


if __name__ == "__main__":
    unittest.main()

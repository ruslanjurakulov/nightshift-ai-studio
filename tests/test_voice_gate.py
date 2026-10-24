"""The Actions-side half of the Custom Voice hard gate (modules/voice_gate.py, docs/CUSTOM_VOICE.md).

What would break without these: a run on GitHub Actions never passes through render_jobs or creative_jobs, so the database rule of
migration 0117 ("a cloned voice is used only by its owner, on a channel the owner attached it to") did not apply to it. A voice
attached last month and detached, deleted, orphaned by an org move or left by a demoted owner would still narrate; the Run-now
``voice_id`` input reached the pipeline with no check at all. The gate asks the database again, before the first paid call, and
refuses (never substitutes: CLAUDE.md rule 4), and a voice that is in no profile is left alone.

The database is faked at the one place the gate talks to it (the PostgREST call of channel_voice_config_problem). The fake follows
the SQL of 0117 (voice_usable_by, channel path), so a case here is a case of that rule; the SQL itself is tested in
tests/security/test_sec_voice_profiles.py.
"""

from __future__ import annotations

import json
import logging
import os
import re
import sys
import unittest
from dataclasses import replace
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from modules import voice_gate  # noqa: E402
from modules.voice_gate import VoiceGateRefused, require_voices_usable  # noqa: E402

CLONE = "AbCdEfGhIjKlMnOpQrSt"          # 20 letters and digits: a custom voice
STOCK = "pNInz6obpgDQGcFmaJgB"           # the operator's own premade voice: in no profile
OTHER = "Zz9Yy8Xx7Ww6Vv5Uu4Tt"
ENV = {"SUPABASE_URL": "https://db.test", "SUPABASE_SERVICE_KEY": "service-key-not-real"}
WS = " \t 　"


class Resp:
    def __init__(self, status=200, body=None, raises_on_json=False):
        self.status_code = status
        self._body = body
        self._bad = raises_on_json

    def json(self):
        if self._bad:
            raise ValueError("not json")
        return self._body


class World:
    """The few facts 0117's channel path reads, and the rule itself (voice_usable_by with no person)."""

    def __init__(self):
        self.profiles = {}      # lowercase voice id -> {"status", "owner"}
        self.attachments = []   # {"voice", "channel", "slot", "org", "status"}
        self.channels = {"chan-a": "org-1"}
        self.admins = {("owner-1", "org-1")}

    def approve(self, voice=CLONE, status="approved", owner="owner-1"):
        self.profiles[voice.lower()] = {"status": status, "owner": owner}

    def attach(self, voice=CLONE, channel="chan-a", slot="narrator", org="org-1", status="active"):
        self.attachments.append({"voice": voice.lower(), "channel": channel, "slot": slot, "org": org, "status": status})

    def usable(self, voice, channel, slot):
        v = re.sub(r"^[\s 　]+|[\s 　]+$", "", voice or "").lower()
        if not v:
            return True
        pr = self.profiles.get(v)
        if pr is None:
            return True
        if pr["status"] != "approved":
            return False
        org = self.channels.get(channel)
        if org is None:
            return False
        return any(a["voice"] == v and a["channel"] == channel and a["status"] == "active" and a["org"] == org
                   and a["slot"] == slot for a in self.attachments) and (pr["owner"], org) in self.admins

    def problem(self, channel, new):
        for key, slot in (("elevenlabs_voice_id", "narrator"), ("elevenlabs_secondary_voice_id", "secondary")):
            if key not in new or new[key] is None:
                continue
            if not isinstance(new[key], str) or not self.usable(new[key], channel, slot):
                return key
        return None


class Session:
    """requests.Session standing in for PostgREST. ``script`` answers first, in order, then the world does."""

    def __init__(self, world=None, script=()):
        self.world = world or World()
        self.script = list(script)
        self.calls = []

    def post(self, url, json=None, headers=None, timeout=None):  # noqa: A002 — requests' own parameter name
        self.calls.append({"url": url, "json": json, "headers": headers, "timeout": timeout})
        if self.script:
            step = self.script.pop(0)
            if isinstance(step, BaseException):
                raise step
            return step
        assert url.endswith("/rest/v1/rpc/channel_voice_config_problem"), url
        return Resp(200, self.world.problem(json["p_channel"], json["p_new"]))


def gate(session, narrator=CLONE, secondary="narrator", channel="chan-a", env=ENV):
    sleeps = []
    require_voices_usable(channel, narrator, secondary, env=env, session=session, sleep=sleeps.append)
    return sleeps


def approved_and_attached(**kw):
    w = World()
    w.approve(**{k: v for k, v in kw.items() if k in ("voice", "status", "owner")})
    w.attach(**{k: v for k, v in kw.items() if k in ("voice", "channel", "slot", "org", "status")})
    return w


class AttachedVoiceIsAllowed(unittest.TestCase):
    def test_an_approved_voice_attached_by_an_owner_who_still_administers_the_org_is_allowed(self):
        gate(Session(approved_and_attached()))

    def test_the_question_names_the_channel_and_the_key_it_is_for_and_carries_no_person(self):
        s = Session(approved_and_attached())
        gate(s)
        call = s.calls[0]
        self.assertEqual(call["json"], {"p_channel": "chan-a", "p_org": None, "p_old": {}, "p_new": {"elevenlabs_voice_id": CLONE}})
        self.assertEqual(call["url"], "https://db.test/rest/v1/rpc/channel_voice_config_problem")
        self.assertEqual(call["headers"]["apikey"], ENV["SUPABASE_SERVICE_KEY"])

    def test_both_slots_are_asked_in_one_call(self):
        w = approved_and_attached()
        w.approve(OTHER)
        w.attach(OTHER, slot="secondary")
        s = Session(w)
        gate(s, secondary=OTHER)
        self.assertEqual(len(s.calls), 1)
        self.assertEqual(s.calls[0]["json"]["p_new"], {"elevenlabs_voice_id": CLONE, "elevenlabs_secondary_voice_id": OTHER})


class RefusedBeforeAnythingIsSpent(unittest.TestCase):
    def refuses(self, world, **kw):
        with self.assertRaises(VoiceGateRefused) as caught:
            gate(Session(world), **kw)
        self.assertEqual(caught.exception.reason, "not_permitted")
        return str(caught.exception)

    def test_a_detached_voice(self):
        self.refuses(approved_and_attached(status="revoked"))

    def test_a_voice_that_was_never_attached(self):
        w = World()
        w.approve()
        self.refuses(w)

    def test_an_owner_who_is_no_longer_an_administrator_of_the_org(self):
        w = approved_and_attached()
        w.admins.clear()                       # demoted to member, or removed
        self.refuses(w)

    def test_an_attachment_made_in_an_org_the_channel_has_since_left(self):
        w = approved_and_attached()
        w.channels["chan-a"] = "org-2"         # the channel moved
        self.refuses(w)

    def test_a_voice_in_a_profile_that_is_no_longer_approved(self):
        for status in ("deleted", "pending_verification", "rejected", "testing"):
            with self.subTest(status=status):
                self.refuses(approved_and_attached(status=status))

    def test_a_channel_the_database_does_not_know(self):
        self.refuses(approved_and_attached(), channel="chan-x")

    def test_case_and_padding_do_not_make_it_a_different_voice(self):
        for variant in (CLONE.lower(), CLONE.upper(), f"{WS}{CLONE}{WS}", f"\t{CLONE.swapcase()} "):
            with self.subTest(variant=repr(variant)):
                self.refuses(approved_and_attached(status="deleted"), narrator=variant)

    def test_a_variant_of_an_allowed_voice_is_allowed_like_the_voice(self):
        for variant in (CLONE.lower(), CLONE.upper(), f" {CLONE}\t"):
            with self.subTest(variant=repr(variant)):
                gate(Session(approved_and_attached()), narrator=variant)

    def test_a_number_for_an_id_is_asked_about_as_text(self):
        w = World()
        w.approve("12345678901234567890", status="deleted")
        s = Session(w)
        with self.assertRaises(VoiceGateRefused):
            require_voices_usable("chan-a", 12345678901234567890, "narrator", env=ENV, session=s, sleep=lambda _: None)
        self.assertEqual(s.calls[0]["json"]["p_new"], {"elevenlabs_voice_id": "12345678901234567890"})

    def test_the_message_names_the_slot_and_the_remedy_and_never_the_voice_or_who_owns_it(self):
        text = self.refuses(approved_and_attached(status="revoked"))
        self.assertIn("narrator voice", text)
        self.assertIn("attach", text)
        self.assertIn("Nothing was spent", text)
        self.assertNotIn(CLONE, text)
        self.assertNotIn("owner-1", text)

    def test_the_message_does_not_say_which_of_the_reasons_it_was(self):
        reasons = {"detached": approved_and_attached(status="revoked"), "deleted": approved_and_attached(status="deleted"),
                   "pending": approved_and_attached(status="pending_verification")}
        texts = {self.refuses(w) for w in reasons.values()}
        self.assertEqual(len(texts), 1, "a different sentence per reason would tell a stranger which voices exist and in what state")


class TheSecondarySlot(unittest.TestCase):
    def test_a_voice_attached_as_narrator_may_not_speak_the_quoted_lines(self):
        with self.assertRaises(VoiceGateRefused) as caught:
            gate(Session(approved_and_attached(slot="narrator")), narrator=STOCK, secondary=CLONE)
        self.assertIn("second (quote) voice", str(caught.exception))

    def test_a_voice_attached_as_secondary_may_speak_the_quoted_lines(self):
        gate(Session(approved_and_attached(slot="secondary")), narrator=STOCK, secondary=CLONE)

    def test_a_detached_secondary_is_refused_even_though_the_narrator_is_a_stock_voice(self):
        with self.assertRaises(VoiceGateRefused):
            gate(Session(approved_and_attached(slot="secondary", status="revoked")), narrator=STOCK, secondary=CLONE)

    def test_the_narrators_own_voice_choice_is_not_a_voice_id_and_is_not_asked_about(self):
        s = Session()
        gate(s, narrator=STOCK, secondary="narrator")
        self.assertEqual(s.calls[0]["json"]["p_new"], {"elevenlabs_voice_id": STOCK})

    def test_padded_secondary_is_still_asked_about(self):
        with self.assertRaises(VoiceGateRefused):
            gate(Session(approved_and_attached(slot="secondary", status="deleted")), narrator=STOCK, secondary=f" {CLONE.lower()} ")


class WhenTheDatabaseCannotBeAsked(unittest.TestCase):
    def unavailable(self, session, **kw):
        sleeps = []
        with self.assertRaises(VoiceGateRefused) as caught:
            require_voices_usable("chan-a", kw.get("narrator", CLONE), "narrator", env=ENV, session=session, sleep=sleeps.append)
        self.assertEqual(caught.exception.reason, "unavailable")
        return str(caught.exception), sleeps

    def test_an_outage_fails_closed_after_retrying_and_names_the_fix(self):
        s = Session(script=[OSError("no route"), OSError("no route"), OSError("no route")])
        text, sleeps = self.unavailable(s)
        self.assertEqual(len(s.calls), 3)
        self.assertEqual(sleeps, list(voice_gate.RETRY_BACKOFF))
        self.assertIn("SUPABASE_URL", text)
        self.assertIn("Nothing was spent", text)
        self.assertIn("no other voice is substituted", text)

    def test_a_blip_that_heals_is_not_a_failure(self):
        s = Session(approved_and_attached(), script=[Resp(503), OSError("reset")])
        gate(s)
        self.assertEqual(len(s.calls), 3)

    def test_a_5xx_and_a_429_and_an_unreadable_answer_are_retried_then_closed(self):
        for first in (Resp(500), Resp(408), Resp(429), Resp(200, raises_on_json=True), Resp(200, {"unexpected": "shape"})):
            with self.subTest(first=first.status_code):
                s = Session(script=[first, Resp(502), Resp(502)])
                self.unavailable(s)
                self.assertEqual(len(s.calls), 3, "a transient failure is retried before the run is stopped")

    def test_a_refused_key_is_not_retried(self):
        for status in (401, 403):
            with self.subTest(status=status):
                s = Session(script=[Resp(status)])
                text, sleeps = self.unavailable(s)
                self.assertEqual((len(s.calls), sleeps), (1, []))
                self.assertIn(f"HTTP {status}", text)

    def test_an_error_message_never_carries_the_key_or_the_response_body(self):
        s = Session(script=[OSError(f"boom {ENV['SUPABASE_SERVICE_KEY']}")] * 3)
        text, _ = self.unavailable(s)
        self.assertNotIn(ENV["SUPABASE_SERVICE_KEY"], text)
        s = Session(script=[Resp(500, {"message": "secret-body"})] * 3)
        text, _ = self.unavailable(s)
        self.assertNotIn("secret-body", text)

    def test_not_a_voice_id_at_all_needs_no_database(self):
        s = Session(script=[OSError("down")] * 3)
        gate(s, narrator="16516516145", secondary="narrator")      # a typed number: verify_voice judges it, as before
        self.assertEqual(s.calls, [])

    def test_an_upper_case_or_padded_id_that_could_be_a_clone_still_fails_closed(self):
        for variant in (CLONE.upper(), f"{WS}{CLONE}{WS}"):
            with self.subTest(variant=repr(variant)):
                self.unavailable(Session(script=[OSError("down")] * 3), narrator=variant)

    def test_the_function_not_existing_means_0117_is_not_applied_so_no_clone_exists(self):
        s = Session(script=[Resp(404)])
        with self.assertLogs("modules.voice_gate", level="WARNING") as logs:
            gate(s)
        self.assertEqual(len(s.calls), 1)
        self.assertIn("0117", logs.output[0])

    def test_no_database_configured_means_no_clone_can_exist_and_it_is_said_in_the_log(self):
        s = Session(script=[OSError("must not be called")])
        for env in ({}, {"SUPABASE_URL": "https://db.test"}, {"SUPABASE_SERVICE_KEY": "k"}, {"SUPABASE_URL": " ", "SUPABASE_SERVICE_KEY": " "}):
            with self.subTest(env=env), self.assertLogs("modules.voice_gate", level="INFO") as logs:
                gate(s, env=env)
                self.assertIn("skipped", logs.output[0])
        self.assertEqual(s.calls, [])


class NothingChangesWhenNoCloneIsUsed(unittest.TestCase):
    """The gate must be invisible to every run that does not use a profile-backed voice."""

    def test_a_stock_voice_in_both_slots_passes_whatever_the_world_holds(self):
        w = World()
        w.approve(status="deleted")           # a clone exists, but it is not what this run uses
        gate(Session(w), narrator=STOCK, secondary=OTHER)

    def test_a_stock_voice_passes_with_an_empty_database(self):
        gate(Session(World()), narrator=STOCK, secondary="narrator")

    def test_nothing_chosen_asks_nothing(self):
        s = Session()
        gate(s, narrator="", secondary="")
        gate(s, narrator=None, secondary=None)
        self.assertEqual(s.calls, [])

    def test_an_edge_channel_speaks_no_elevenlabs_voice_and_asks_nothing(self):
        s = Session(script=[OSError("must not be called")])
        ctx = mock.MagicMock()
        ctx.agent.tts_provider = "edge"
        ctx.channel_id = "chan-a"
        voice_gate.check_run(ctx, CLONE, CLONE, env=ENV, session=s)
        self.assertEqual(s.calls, [])

    def test_an_elevenlabs_channel_is_asked_for_the_channel_it_runs(self):
        s = Session(approved_and_attached())
        ctx = mock.MagicMock()
        ctx.agent.tts_provider = "elevenlabs"
        ctx.channel_id = "chan-a"
        voice_gate.check_run(ctx, CLONE, "narrator", env=ENV, session=s)
        self.assertEqual(s.calls[0]["json"]["p_channel"], "chan-a")


class TheStageInTheRun(unittest.TestCase):
    """main.run: the refusal comes before every paid call, ends in its own exit code, and a repair never reaches it."""

    def setUp(self):
        import main  # noqa: PLC0415
        from modules.channels import ChannelContext  # noqa: PLC0415
        self.main = main
        self.cwd = os.getcwd()
        import tempfile  # noqa: PLC0415
        self.tmp = tempfile.TemporaryDirectory()
        os.chdir(self.tmp.name)
        base = ChannelContext(channel_id="chan-a", name="X", niche="h")
        self.ctx = replace(base, agent=replace(base.agent, tts_provider="elevenlabs", elevenlabs_voice_id=CLONE,
                                               elevenlabs_secondary_voice_id="narrator"))

    def tearDown(self):
        os.chdir(self.cwd)
        self.tmp.cleanup()

    def health(self):
        from modules.credential_health import CredentialCheck, HealthReport  # noqa: PLC0415
        return HealthReport("chan-a", (CredentialCheck("gemini", "ok", required=True),))

    def run_with(self, world):
        session = Session(world)
        events = mock.MagicMock()
        with mock.patch.dict(os.environ, ENV), \
                mock.patch("requests.Session", return_value=session), \
                mock.patch("modules.audio_mixer.ELEVENLABS_RUN_VOICE_ID", ""), \
                mock.patch.object(self.main, "check_run_credentials", return_value=self.health()), \
                mock.patch.object(self.main, "_preflight_disk"), \
                mock.patch.object(self.main, "_guard_spend"), \
                mock.patch.object(self.main, "ensure_assets", return_value=0), \
                mock.patch.object(self.main.events, "emit", events), \
                mock.patch.object(self.main, "verify_voice", side_effect=AssertionError("voice verified")) as verify, \
                mock.patch.object(self.main.video_providers, "preflight", side_effect=AssertionError("video preflight")), \
                mock.patch.object(self.main, "MediaFetcher", side_effect=AssertionError("fetched")), \
                mock.patch.object(self.main, "ScriptEngine", side_effect=AssertionError("script paid for")), \
                mock.patch.object(self.main, "TopicManager", side_effect=AssertionError("topic paid for")):
            try:
                self.main.run(channel=self.ctx, skip_upload=True)
                raised = None
            except BaseException as e:   # noqa: BLE001
                raised = e
        return raised, session, events, verify

    def test_a_detached_clone_stops_the_run_before_the_voice_check_and_before_any_paid_stage(self):
        raised, session, events, verify = self.run_with(approved_and_attached(status="revoked"))
        self.assertIsInstance(raised, VoiceGateRefused)
        self.assertEqual(len(session.calls), 1)
        verify.assert_not_called()
        failed = [c for c in events.call_args_list if c.kwargs.get("agent") == "voice_gate"]
        self.assertEqual(len(failed), 1)
        self.assertEqual(failed[0].kwargs["metadata"], {"error": "not_permitted", "stage": "preflight"})

    def test_an_outage_stops_the_run_the_same_way(self):
        w = approved_and_attached()
        with mock.patch.object(voice_gate, "RETRY_BACKOFF", (0, 0)):
            session = Session(w, script=[OSError("down")] * 3)
            with mock.patch.dict(os.environ, ENV), mock.patch("requests.Session", return_value=session), \
                    mock.patch.object(self.main, "check_run_credentials", return_value=self.health()), \
                    mock.patch.object(self.main, "_preflight_disk"), mock.patch.object(self.main, "_guard_spend"), \
                    mock.patch.object(self.main, "ensure_assets", return_value=0), \
                    mock.patch.object(self.main.events, "emit"), \
                    mock.patch.object(self.main, "verify_voice", side_effect=AssertionError("voice verified")):
                with self.assertRaises(VoiceGateRefused) as caught:
                    self.main.run(channel=self.ctx, skip_upload=True)
        self.assertEqual(caught.exception.reason, "unavailable")

    def test_an_allowed_clone_goes_on_to_the_voice_check_as_before(self):
        raised, session, events, verify = self.run_with(approved_and_attached())
        self.assertIsInstance(raised, AssertionError)          # reached verify_voice, the next stage
        self.assertEqual(str(raised), "voice verified")
        verify.assert_called_once()

    def test_the_gate_is_the_first_of_the_voice_stages_and_before_every_paid_call(self):
        body = (ROOT / "main.py").read_text()
        body = body[body.index("\ndef run("):]
        gate_at = body.index("voice_gate.check_run(ctx, narrator_voice(ctx.agent), secondary_voice(ctx.agent))")
        self.assertGreater(gate_at, body.index("raise CredentialsMissing("))
        for later in ("verify_voice(ctx)", "video_providers.preflight()", "_preflight_pictures(ctx, series_obj, channel_id)",
                      "ScriptEngine(channel=ctx)"):
            self.assertLess(gate_at, body.index(later), f"{later} runs before the voice gate")

    def test_a_repair_and_a_scene_regeneration_never_reach_the_gate(self):
        """They reuse the run's saved audio and buy no voice (0117 lets a 'repair' job through for the same reason)."""
        for name in ("scene_repair.py", "scene_regenerate.py"):
            text = (ROOT / "modules" / name).read_text()
            self.assertNotIn("voice_gate", text, name)
        main_src = (ROOT / "main.py").read_text()
        tail = main_src[main_src.index('if __name__ == "__main__":'):]
        repair_branch = tail[tail.index("elif args.repair_scenes is not None:"):tail.index("    else:\n        try:\n            run(")]
        self.assertNotIn("voice_gate", repair_branch)
        self.assertNotIn("run(", repair_branch)
        self.assertEqual(main_src.count("voice_gate.check_run("), 1, "the gate belongs to run() and nowhere else")


class TheExitCode(unittest.TestCase):
    def test_the_code_is_distinct_from_every_other_ending(self):
        from modules import budget, gemini_stages, publish_gate, storyboard_review  # noqa: PLC0415
        from modules.series import SERIES_NOT_RUNNABLE_EXIT  # noqa: PLC0415

        taken = {0, 1, 2, 3, 4, 254, storyboard_review.PAUSED_EXIT, budget.BUDGET_STOP_EXIT, publish_gate.HELD_BEFORE_RENDER_EXIT,
                 gemini_stages.GEMINI_QUOTA_EXIT, SERIES_NOT_RUNNABLE_EXIT}
        self.assertEqual(voice_gate.VOICE_GATE_EXIT, 82)
        self.assertNotIn(voice_gate.VOICE_GATE_EXIT, taken)

    def run_main_block(self, side_effect):
        import io  # noqa: PLC0415
        from contextlib import redirect_stderr, redirect_stdout  # noqa: PLC0415

        import main  # noqa: PLC0415

        source = (ROOT / "main.py").read_text()
        tail = source[source.index('if __name__ == "__main__":'):]
        records: list = []

        class Grab(logging.Handler):
            def emit(self, record):
                records.append(record)

        handler = Grab(level=logging.DEBUG)
        main.logger.addHandler(handler)
        namespace = dict(vars(main), __name__="__main__", run=mock.MagicMock(side_effect=side_effect))
        out = io.StringIO()
        code = None
        try:
            with mock.patch.object(sys, "argv", ["main.py", "--no-upload"]), redirect_stdout(out), redirect_stderr(out):
                try:
                    exec(compile(tail, str(ROOT / "main.py"), "exec"), namespace)
                except SystemExit as e:
                    code = e.code
        finally:
            main.logger.removeHandler(handler)
        return code, out.getvalue(), records

    def test_main_exits_82_with_one_line_and_no_traceback(self):
        refusal = VoiceGateRefused("This channel's narrator voice is a custom voice that this run may not use.", reason="not_permitted")
        code, output, records = self.run_main_block(refusal)
        self.assertEqual(code, 82)
        self.assertNotIn("Traceback", output)
        lines = [r.getMessage() for r in records if r.levelname == "ERROR"]
        printed = [ln for ln in output.splitlines() if ln.strip()]
        self.assertEqual(len(lines) + len(printed), 1, (lines, printed))

    def test_other_exceptions_are_not_turned_into_82(self):
        with self.assertRaises(RuntimeError):
            self.run_main_block(RuntimeError("something else"))

    def test_the_actions_step_stays_red_names_the_remedy_and_lets_the_failure_release_the_hold(self):
        flow = (ROOT / ".github" / "workflows" / "daily_video.yml").read_text()
        marker = f'if [ "$rc" -eq {voice_gate.VOICE_GATE_EXIT} ]; then'
        self.assertIn(marker, flow)
        block = flow[flow.index(marker):flow.index('exit "$rc"', flow.index(marker))]
        self.assertIn("::error", block)
        self.assertIn("attach", block)
        self.assertNotIn("paused=true", block, "a refusal is not a pause: the step must not go green and the hold is released by the failure")
        self.assertNotIn("exit 0", block)

    def test_the_queue_worker_fails_the_job_and_releases_the_hold(self):
        from tools import queue_worker  # noqa: PLC0415

        self.assertEqual(queue_worker.VOICE_GATE_EXIT, voice_gate.VOICE_GATE_EXIT)
        src = (ROOT / "tools" / "queue_worker.py").read_text()
        branch = src[src.index("if rc == VOICE_GATE_EXIT:"):src.index("if rc == HELD_BEFORE_RENDER_EXIT:")]
        self.assertIn('return end("failed"', branch)
        self.assertNotIn("charge=True", branch)


class TheModuleItself(unittest.TestCase):
    def test_it_reads_the_service_key_only_from_the_environment_and_never_logs_it(self):
        src = (ROOT / "modules" / "voice_gate.py").read_text()
        self.assertNotRegex(src, r"(logger|print)[^\n]*\b(key|_key)\b")
        self.assertNotIn("r.text", src)
        self.assertNotIn("r.content", src)

    def test_it_asks_only_the_one_function_the_service_role_may_execute(self):
        src = (ROOT / "modules" / "voice_gate.py").read_text()
        self.assertEqual(set(re.findall(r"/rest/v1/(\w+(?:/\w+)?)", src)), {"rpc/channel_voice_config_problem"})


if __name__ == "__main__":
    unittest.main()

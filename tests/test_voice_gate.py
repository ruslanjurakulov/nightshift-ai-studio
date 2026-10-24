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
    def __init__(self, status=200, body=None, raises_on_json=False, headers=None):
        self.status_code = status
        self._body = body
        self._bad = raises_on_json
        self.headers = headers or {}

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

    def post(self, url, json=None, headers=None, timeout=None, allow_redirects=True):  # noqa: A002 — requests' own parameter name
        self.calls.append({"url": url, "json": json, "headers": headers, "timeout": timeout, "allow_redirects": allow_redirects})
        if self.script:
            step = self.script.pop(0)
            if isinstance(step, BaseException):
                raise step
            return step
        assert url.endswith("/rest/v1/rpc/channel_voice_config_problem"), url
        return Resp(200, self.world.problem(json["p_channel"], json["p_new"]))


STRICT = dict(ENV, NIGHTSHIFT_VOICE_GATE_STRICT="on")


def gate(session, narrator=CLONE, secondary="narrator", channel="chan-a", env=ENV, defaults=("", "")):
    """``defaults`` is empty here so every id is asked about; TheDeploymentsOwnVoicesAreNotAsked pins the real ones."""
    sleeps = []
    require_voices_usable(channel, narrator, secondary, env=env, session=session, sleep=sleeps.append, defaults=defaults)
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


class WhenTheDatabaseAnswersNo(unittest.TestCase):
    """A real answer of "not allowed" stops the run in every mode; the switch only changes what "no answer" means."""

    def test_it_stops_the_run_with_or_without_the_strict_switch_and_with_exit_82(self):
        for env in (ENV, STRICT):
            with self.subTest(strict=env is STRICT):
                with self.assertRaises(VoiceGateRefused) as caught:
                    gate(Session(approved_and_attached(status="revoked")), env=env)
                self.assertEqual((caught.exception.reason, caught.exception.exit_code), ("not_permitted", 82))


CANNOT_ANSWER = {
    "a network error": lambda: OSError("no route"),
    "a 500": lambda: Resp(500),
    "a 502": lambda: Resp(502, {"message": "secret-body"}),
    "a 408": lambda: Resp(408),
    "a 429": lambda: Resp(429),
    "an unreadable answer": lambda: Resp(200, raises_on_json=True),
    "an odd body": lambda: Resp(200, {"unexpected": "shape"}),
    "a number": lambda: Resp(200, 7),
}
REFUSED_AT_ONCE = {
    "a 401": lambda: Resp(401),
    "a 403": lambda: Resp(403, {"code": "42501"}),
    "a 400": lambda: Resp(400, {"code": "22023"}),
    "a 404 that is not 'function missing'": lambda: Resp(404, {"code": "PGRST205"}),
    "a 404 with no body": lambda: Resp(404, raises_on_json=True),
    "a 301": lambda: Resp(301, headers={"Location": "https://elsewhere.test"}),
    "a 302 that would have answered null": lambda: Resp(302, None, headers={"Location": "https://elsewhere.test"}),
    "a 307": lambda: Resp(307),
    "a 204": lambda: Resp(204),
}


class WhenTheDatabaseCannotBeAsked(unittest.TestCase):
    """Default: the run goes on, loudly. Strict: it stops (exit 83). Never a silent stock voice, never a silent allow."""

    def lenient(self, session, **kw):
        sleeps = []
        with self.assertLogs("modules.voice_gate", level="WARNING") as logs:
            require_voices_usable("chan-a", kw.get("narrator", CLONE), "narrator", env=kw.get("env", ENV), session=session,
                                  sleep=sleeps.append, defaults=("", ""))
        return sleeps, "\n".join(logs.output)

    def strict(self, session, **kw):
        sleeps = []
        with self.assertRaises(VoiceGateRefused) as caught:
            require_voices_usable("chan-a", kw.get("narrator", CLONE), "narrator", env=kw.get("env", STRICT), session=session,
                                  sleep=sleeps.append, defaults=("", ""))
        self.assertEqual((caught.exception.reason, caught.exception.exit_code), ("unavailable", 83))
        return str(caught.exception), sleeps

    def test_an_outage_does_not_stop_the_run_by_default_and_says_so(self):
        s = Session(script=[OSError("no route"), OSError("no route"), OSError("no route")])
        sleeps, log = self.lenient(s)
        self.assertIn("could NOT be completed", log)
        self.assertIn("OSError", log)
        self.assertIn("NIGHTSHIFT_VOICE_GATE_STRICT", log)

    def test_by_default_the_wait_is_small_two_tries_and_about_five_seconds_at_most(self):
        s = Session(script=[OSError("down")] * 5)
        sleeps, _ = self.lenient(s)
        self.assertEqual(len(s.calls), 2)
        worst = sum(sleeps) + sum(c["timeout"] for c in s.calls)
        self.assertLessEqual(worst, 6.0)

    def test_every_kind_of_no_answer_continues_by_default_and_stops_under_strict(self):
        for name, make in {**CANNOT_ANSWER, **REFUSED_AT_ONCE}.items():
            with self.subTest(name):
                sleeps, log = self.lenient(Session(script=[make(), make(), make()]))
                self.assertIn("could NOT be completed", log)
            with self.subTest(name + " (strict)"):
                text, _ = self.strict(Session(script=[make(), make(), make()]))
                self.assertIn("NIGHTSHIFT_VOICE_GATE_STRICT", text)
                self.assertIn("no other voice is substituted", text)

    def test_strict_retries_transient_failures_three_times_then_stops_and_names_the_fix(self):
        s = Session(script=[OSError("down")] * 3)
        text, sleeps = self.strict(s)
        self.assertEqual((len(s.calls), sleeps), (3, list(voice_gate.RETRY_BACKOFF)))
        self.assertIn("SUPABASE_URL", text)
        self.assertIn("Nothing was spent", text)

    def test_a_transient_failure_is_retried_and_one_that_heals_is_not_a_failure(self):
        for env in (ENV, STRICT):
            s = Session(approved_and_attached(), script=[Resp(503)])
            gate(s, env=env)
            self.assertEqual(len(s.calls), 2)

    def test_every_transient_status_is_retried_once_by_default(self):
        for status in (408, 429, 500, 503):
            with self.subTest(status=status):
                s = Session(approved_and_attached(), script=[Resp(status)])
                gate(s)                          # healed on the second try: no warning, no stop
                self.assertEqual(len(s.calls), 2)

    def test_a_blip_that_heals_into_a_no_still_stops_the_run(self):
        s = Session(approved_and_attached(status="revoked"), script=[Resp(503)])
        with self.assertRaises(VoiceGateRefused) as caught:
            gate(s)
        self.assertEqual(caught.exception.reason, "not_permitted")

    def test_a_failure_that_cannot_heal_is_not_retried(self):
        for name, make in REFUSED_AT_ONCE.items():
            for env in (ENV, STRICT):
                with self.subTest(name, strict=env is STRICT):
                    s = Session(script=[make(), make(), make()])
                    try:
                        gate(s, env=env)
                    except VoiceGateRefused:
                        pass
                    self.assertEqual(len(s.calls), 1)

    def test_a_redirect_is_never_followed_and_a_null_behind_it_is_never_read_as_allow(self):
        s = Session(script=[Resp(302, None, headers={"Location": "https://elsewhere.test"})])
        text, _ = self.strict(s)
        self.assertEqual(len(s.calls), 1)
        self.assertIs(s.calls[0]["allow_redirects"], False)
        s = Session(script=[Resp(302, None)])
        _, log = self.lenient(s)
        self.assertIn("redirect", log, "the log says it was a redirect that could not be answered, not an allow")

    def test_the_request_pins_its_headers_timeout_and_no_redirects(self):
        s = Session(approved_and_attached())
        gate(s)
        call = s.calls[0]
        self.assertEqual(call["headers"], {"apikey": ENV["SUPABASE_SERVICE_KEY"], "Authorization": f"Bearer {ENV['SUPABASE_SERVICE_KEY']}",
                                           "Content-Type": "application/json"})
        self.assertEqual(call["timeout"], 2.5)
        self.assertIs(call["allow_redirects"], False)
        s = Session(approved_and_attached())
        gate(s, env=STRICT)
        self.assertEqual(s.calls[0]["timeout"], 10.0)

    def test_the_log_and_the_message_never_carry_the_key_or_the_response_body(self):
        s = Session(script=[OSError(f"boom {ENV['SUPABASE_SERVICE_KEY']}")] * 3)
        _, log = self.lenient(s)
        self.assertNotIn(ENV["SUPABASE_SERVICE_KEY"], log)
        s = Session(script=[Resp(500, {"message": "secret-body"})] * 3)
        text, _ = self.strict(s)
        self.assertNotIn("secret-body", text)
        self.assertNotIn(ENV["SUPABASE_SERVICE_KEY"], text)
        s = Session(script=[Resp(502, {"message": "secret-body"})] * 3)
        _, log = self.lenient(s)
        self.assertNotIn("secret-body", log)

    def test_not_a_voice_id_at_all_needs_no_database_in_any_mode(self):
        for env in (ENV, STRICT):
            s = Session(script=[OSError("down")] * 3)
            gate(s, narrator="16516516145", secondary="narrator", env=env)      # a typed number: verify_voice judges it, as before
            self.assertEqual(s.calls, [])

    def test_an_upper_case_or_padded_id_that_could_be_a_clone_is_treated_like_the_id(self):
        for variant in (CLONE.upper(), f"{WS}{CLONE}{WS}"):
            with self.subTest(variant=repr(variant)):
                self.strict(Session(script=[OSError("down")] * 3), narrator=variant)

    def test_only_the_two_function_missing_codes_mean_0117_is_not_applied(self):
        for code in ("PGRST202", "42883"):
            for status in (404, 400):
                for env in (ENV, STRICT):
                    with self.subTest(code=code, status=status, strict=env is STRICT), self.assertLogs("modules.voice_gate", level="WARNING") as logs:
                        s = Session(script=[Resp(status, {"code": code, "message": "x"})])
                        gate(s, env=env)
                        self.assertEqual(len(s.calls), 1)
                        self.assertIn("0117", logs.output[0])

    def test_no_database_configured_is_no_answer_too(self):
        for env in ({}, {"SUPABASE_URL": "https://db.test"}, {"SUPABASE_SERVICE_KEY": "k"}, {"SUPABASE_URL": " ", "SUPABASE_SERVICE_KEY": " "}):
            s = Session(script=[OSError("must not be called")])
            with self.subTest(env=env, strict=False):
                _, log = self.lenient(s, env=env)
                self.assertIn("no Supabase configured", log)
            with self.subTest(env=env, strict=True):
                text, _ = self.strict(s, env={**env, "NIGHTSHIFT_VOICE_GATE_STRICT": "on"})
                self.assertIn("no Supabase configured", text)
            self.assertEqual(s.calls, [])

    def test_the_strict_switch_reads_like_the_other_switches(self):
        for value in ("on", "ON", "1", "true", "Yes", " on "):
            self.assertTrue(voice_gate.strict_on({"NIGHTSHIFT_VOICE_GATE_STRICT": value}), value)
        for value in ("", "0", "off", "no", "false", "maybe", None):
            self.assertFalse(voice_gate.strict_on({"NIGHTSHIFT_VOICE_GATE_STRICT": value}), repr(value))
        self.assertFalse(voice_gate.strict_on({}))


class TheActionsAnnotation(unittest.TestCase):
    """A skipped check must show on the run's summary, not only in its log."""

    def run_gate(self, session, env):
        import io  # noqa: PLC0415
        from contextlib import redirect_stdout  # noqa: PLC0415

        out = io.StringIO()
        with redirect_stdout(out), self.assertLogs("modules.voice_gate", level="WARNING"):
            gate(session, env=env)
        return out.getvalue()

    def test_a_check_that_could_not_be_completed_is_a_warning_annotation_on_actions(self):
        text = self.run_gate(Session(script=[OSError("down")] * 3), dict(ENV, GITHUB_ACTIONS="true"))
        self.assertEqual(len(text.strip().splitlines()), 1)
        self.assertTrue(text.startswith("::warning title=Custom voice check skipped::"), text)
        self.assertIn("OSError", text)
        self.assertNotIn(ENV["SUPABASE_SERVICE_KEY"], text)

    def test_a_missing_function_is_a_warning_annotation_too(self):
        text = self.run_gate(Session(script=[Resp(404, {"code": "PGRST202"})]), dict(ENV, GITHUB_ACTIONS="true"))
        self.assertTrue(text.startswith("::warning title=Custom voice check skipped::"), text)
        self.assertIn("0117", text)

    def test_nothing_is_printed_off_actions_or_when_the_voice_is_allowed(self):
        self.assertEqual(self.run_gate(Session(script=[OSError("down")] * 3), ENV), "")
        import io  # noqa: PLC0415
        from contextlib import redirect_stdout  # noqa: PLC0415

        out = io.StringIO()
        with redirect_stdout(out):
            gate(Session(approved_and_attached()), env=dict(ENV, GITHUB_ACTIONS="true"))
        self.assertEqual(out.getvalue(), "")


class TheDeploymentsOwnVoicesAreNotAsked(unittest.TestCase):
    """A clone's id comes from a clone request, so it can never be the configured default; the default narrator is on every run."""

    def test_a_configured_default_is_never_sent_to_the_database_even_if_a_profile_held_its_id(self):
        w = World()
        w.approve(STOCK, status="deleted")        # the database would say no; the gate must not even ask
        s = Session(w, script=[OSError("must not be called")])
        require_voices_usable("chan-a", STOCK, OTHER, env=ENV, session=s, sleep=lambda _: None, defaults=(STOCK, OTHER))
        self.assertEqual(s.calls, [])

    def test_case_and_padding_do_not_make_a_default_something_else(self):
        s = Session(script=[OSError("must not be called")])
        require_voices_usable("chan-a", f" {STOCK.upper()} ", STOCK.lower(), env=ENV, session=s, sleep=lambda _: None, defaults=(STOCK, ""))
        self.assertEqual(s.calls, [])

    def test_only_the_default_is_skipped_a_clone_beside_it_is_still_asked(self):
        s = Session(approved_and_attached(status="revoked"))
        with self.assertRaises(VoiceGateRefused):
            require_voices_usable("chan-a", STOCK, CLONE, env=ENV, session=s, sleep=lambda _: None, defaults=(STOCK, ""))
        self.assertEqual(s.calls[0]["json"]["p_new"], {"elevenlabs_secondary_voice_id": CLONE})

    def test_the_defaults_are_the_ones_config_resolved(self):
        import config  # noqa: PLC0415

        self.assertEqual(voice_gate._defaults(), (config.ELEVENLABS_VOICE_ID, config.ELEVENLABS_SECONDARY_VOICE_ID))
        s = Session(script=[OSError("must not be called")])
        require_voices_usable("chan-a", config.ELEVENLABS_VOICE_ID, "narrator", env=ENV, session=s, sleep=lambda _: None)
        self.assertEqual(s.calls, [], "the built-in narrator is on every run and is not asked about")


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
        voice_gate.check_run(ctx, CLONE, CLONE, env=ENV, session=s, defaults=("", ""))
        self.assertEqual(s.calls, [])

    def test_an_elevenlabs_channel_is_asked_for_the_channel_it_runs(self):
        s = Session(approved_and_attached())
        ctx = mock.MagicMock()
        ctx.agent.tts_provider = "elevenlabs"
        ctx.channel_id = "chan-a"
        voice_gate.check_run(ctx, CLONE, "narrator", env=ENV, session=s, defaults=("", ""))
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

    def outage(self, env):
        session = Session(approved_and_attached(), script=[OSError("down")] * 3)
        with mock.patch.dict(os.environ, env), mock.patch("requests.Session", return_value=session), \
                mock.patch.object(voice_gate, "_LENIENT", ((0,), 0.1, 0.1)), mock.patch.object(voice_gate, "_STRICT", ((0, 0), 0.1, 0.1)), \
                mock.patch.object(self.main, "check_run_credentials", return_value=self.health()), \
                mock.patch.object(self.main, "_preflight_disk"), mock.patch.object(self.main, "_guard_spend"), \
                mock.patch.object(self.main, "ensure_assets", return_value=0), \
                mock.patch.object(self.main.events, "emit"), \
                mock.patch.object(self.main, "verify_voice", side_effect=AssertionError("voice verified")):
            try:
                self.main.run(channel=self.ctx, skip_upload=True)
            except BaseException as e:   # noqa: BLE001
                return e

    def test_an_outage_does_not_stop_the_run_by_default_it_goes_on_to_the_voice_check(self):
        raised = self.outage(ENV)
        self.assertIsInstance(raised, AssertionError)
        self.assertEqual(str(raised), "voice verified")

    def test_an_outage_stops_the_run_when_the_strict_switch_is_on_and_before_the_voice_check(self):
        raised = self.outage(STRICT)
        self.assertIsInstance(raised, VoiceGateRefused)
        self.assertEqual(raised.reason, "unavailable")

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
        self.assertEqual((voice_gate.VOICE_GATE_EXIT, voice_gate.VOICE_GATE_UNAVAILABLE_EXIT), (82, 83))
        self.assertNotIn(voice_gate.VOICE_GATE_EXIT, taken)
        self.assertNotIn(voice_gate.VOICE_GATE_UNAVAILABLE_EXIT, taken | {voice_gate.VOICE_GATE_EXIT})

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

    def test_main_exits_83_when_the_strict_check_could_not_be_completed(self):
        code, output, _ = self.run_main_block(VoiceGateRefused("could not be completed", reason="unavailable"))
        self.assertEqual(code, 83)
        self.assertNotIn("Traceback", output)

    def test_other_exceptions_are_not_turned_into_82(self):
        with self.assertRaises(RuntimeError):
            self.run_main_block(RuntimeError("something else"))

    def step_block(self, code):
        flow = (ROOT / ".github" / "workflows" / "daily_video.yml").read_text()
        marker = f'if [ "$rc" -eq {code} ]; then'
        self.assertIn(marker, flow)
        return flow[flow.index(marker):flow.index("fi\n", flow.index(marker))]

    def test_the_actions_step_stays_red_names_the_remedy_and_lets_the_failure_release_the_hold(self):
        for code, word in ((voice_gate.VOICE_GATE_EXIT, "attach"), (voice_gate.VOICE_GATE_UNAVAILABLE_EXIT, "SUPABASE_SERVICE_KEY")):
            block = self.step_block(code)
            self.assertIn("::error", block)
            self.assertIn(word, block)
            self.assertNotIn("paused=true", block, "a refusal is not a pause: the step must not go green and the hold is released by the failure")
            self.assertNotIn("exit 0", block)

    def test_the_two_annotations_say_different_things(self):
        refused, unverified = self.step_block(82), self.step_block(83)
        self.assertIn("may not be used", refused)
        self.assertNotIn("could not be completed", refused)
        self.assertIn("could not be completed", unverified)
        self.assertIn("NIGHTSHIFT_VOICE_GATE_STRICT", unverified)
        self.assertNotIn("may not be used", unverified)

    def test_the_queue_worker_fails_the_job_and_releases_the_hold_and_tells_the_two_apart(self):
        from tools import queue_worker  # noqa: PLC0415

        self.assertEqual(queue_worker.VOICE_GATE_EXIT, voice_gate.VOICE_GATE_EXIT)
        self.assertEqual(queue_worker.VOICE_GATE_UNAVAILABLE_EXIT, voice_gate.VOICE_GATE_UNAVAILABLE_EXIT)
        src = (ROOT / "tools" / "queue_worker.py").read_text()
        a = src[src.index("if rc == VOICE_GATE_EXIT:"):src.index("if rc == VOICE_GATE_UNAVAILABLE_EXIT:")]
        b = src[src.index("if rc == VOICE_GATE_UNAVAILABLE_EXIT:"):src.index("if rc == HELD_BEFORE_RENDER_EXIT:")]
        for branch in (a, b):
            self.assertIn('return end("failed"', branch)
            self.assertNotIn("charge=True", branch)
        self.assertIn("may not use", a)
        self.assertIn("could not be completed", b)

    def test_a_failed_job_of_either_ending_is_a_voice_failure_not_unknown(self):
        from modules import render_error  # noqa: PLC0415

        for rc in (82, 83):
            header = f"main.py exited with code {rc}: x"
            self.assertEqual(render_error.classify(header, ["ERROR Voice gate: whatever"]), "voice", rc)
        for header in ("main.py exited with code 820: x", "main.py exited with code 8: x", "main.py exited with code 84: x"):
            self.assertEqual(render_error.classify(header, []), "unknown", header)


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

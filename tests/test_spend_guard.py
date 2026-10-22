"""Spend guard (modules/spend_guard.py), the cost ledger's flush-once rule, and
the pipeline's flush-in-finally + guard calls (main.run).

What would break without these:

* a failed run losing every cost it had already paid for (the ledger was flushed
  once, at the very end of a successful run);
* a run that keeps buying clips after it has spent more than the operator allows,
  or a cap that fails quietly (no message, or no variable to change);
* a typo in CHRONOS_MAX_RUN_USD switching the brake off.

Nothing here calls a provider or the network. The pipeline test runs main.run in
a child interpreter (as tests/test_auto_publish_never_public.py does: `import
main` is heavy) with every external stage replaced.
"""

from __future__ import annotations

import json
import logging
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import MagicMock, patch

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from modules import cost_ledger, spend_guard  # noqa: E402
from modules.cost_ledger import CostLedger  # noqa: E402
from modules.state_store import StateStore  # noqa: E402


def ledger(**units) -> CostLedger:
    led = CostLedger(channel_id="c1", slug="s")
    for unit, qty in units.items():
        led.add(unit, qty, stage="t")
    return led


class LimitParsing(unittest.TestCase):
    def test_unset_and_empty_use_the_documented_defaults(self):
        self.assertEqual(spend_guard.limit("X", 10.0, {}), 10.0)
        self.assertEqual(spend_guard.limit("X", 10.0, {"X": "  "}), 10.0)
        self.assertEqual(spend_guard.DEFAULT_MAX_RUN_USD, 10.0)
        self.assertEqual(spend_guard.DEFAULT_MAX_DAILY_USD, 30.0)

    def test_a_number_is_taken_and_off_removes_the_cap(self):
        self.assertEqual(spend_guard.limit("X", 10.0, {"X": "2.5"}), 2.5)
        self.assertIsNone(spend_guard.limit("X", 10.0, {"X": "OFF"}))

    def test_a_typo_zero_or_negative_never_removes_the_brake(self):
        for bad in ("abc", "0", "-3", "nan", "inf", "$5"):
            with self.subTest(bad=bad), self.assertLogs(spend_guard.logger, "WARNING"):
                self.assertEqual(spend_guard.limit("X", 10.0, {"X": bad}), 10.0)


class PerRunCap(unittest.TestCase):
    PRICES = {"CHRONOS_PRICE_TTS_CHARACTERS": "0.001", "CHRONOS_PRICE_VIDEO_GEN_CLIPS": "2"}

    def check(self, units, stage="the voice", env=None, **kw):
        """Build the ledger and run the check under one environment (a unit is
        priced when it is added, so the prices must already be set)."""
        with patch.dict("os.environ", {**self.PRICES, **(env or {})}):
            spend_guard.check(ledger(**units), stage, **kw)

    def test_under_the_cap_passes(self):
        self.check({"tts_characters": 1000}, env={"CHRONOS_MAX_RUN_USD": "5"})  # $1

    def test_over_the_cap_stops_loudly_and_names_the_variable_and_the_stage(self):
        with self.assertLogs(spend_guard.logger, "ERROR"), self.assertRaises(spend_guard.SpendLimitExceeded) as ctx:
            self.check({"tts_characters": 6000}, "generating b-roll clips", env={"CHRONOS_MAX_RUN_USD": "5"})
        msg = str(ctx.exception)
        for part in ("CHRONOS_MAX_RUN_USD", "generating b-roll clips", "$6.00", "$5.00", "Deploy web"):
            self.assertIn(part, msg)

    def test_the_default_cap_applies_when_nothing_is_set(self):
        with self.assertLogs(spend_guard.logger, "ERROR"), self.assertRaises(spend_guard.SpendLimitExceeded):
            self.check({"tts_characters": 11000})  # $11 > the $10 default

    def test_what_the_stage_is_about_to_buy_counts(self):
        # $1 spent + 2 clips x $2 = $5 > $4, although the ledger alone is under it.
        env = {"CHRONOS_MAX_RUN_USD": "4"}
        with self.assertLogs(spend_guard.logger, "ERROR"), self.assertRaises(spend_guard.SpendLimitExceeded) as ctx:
            self.check({"tts_characters": 1000}, "generating b-roll clips", env=env,
                       planned=[(cost_ledger.VIDEO_GEN_CLIPS, 2)])
        self.assertIn("would add about $4.00", str(ctx.exception))
        self.check({"tts_characters": 1000}, "generating b-roll clips", env=env, planned=None)

    def test_off_never_stops(self):
        self.check({"tts_characters": 10 ** 7}, env={"CHRONOS_MAX_RUN_USD": "off"})

    def test_unpriced_units_are_called_out_once_not_hidden(self):
        with patch.dict("os.environ", {}, clear=True):
            led = ledger(pexels_requests=3)  # no rate configured
            with self.assertLogs(spend_guard.logger, "WARNING") as logs:
                spend_guard.check(led, "the voice")
                spend_guard.check(led, "generating stills")
        self.assertEqual(len(logs.records), 1)
        text = logs.records[0].getMessage()
        self.assertIn("pexels_requests", text)
        self.assertIn("CHRONOS_PRICE_PEXELS_REQUESTS", text)

    def test_the_stop_is_an_event_for_the_dashboard(self):
        with patch("modules.event_log.emit") as emit, self.assertLogs(spend_guard.logger, "ERROR"), \
                self.assertRaises(spend_guard.SpendLimitExceeded):
            self.check({"tts_characters": 5000}, env={"CHRONOS_MAX_RUN_USD": "1"})
        self.assertEqual(emit.call_args.args[0], "budget.exceeded")
        self.assertEqual(emit.call_args.kwargs["metadata"]["variable"], "CHRONOS_MAX_RUN_USD")


class PerDayCap(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.store = StateStore(Path(self.tmp) / "c.db")
        self.addCleanup(self.store.close)
        now = datetime.now(timezone.utc)
        self.today = now.replace(hour=0, minute=1, second=0, microsecond=0)
        self.yesterday = self.today - timedelta(days=1)

    def spend(self, usd, when, channel="other"):
        self.store.record_video_cost(unit="tts_characters", quantity=1, recorded_at=when.isoformat(),
                                     channel_id=channel, estimated_usd=usd)

    def test_the_operators_day_is_capped_across_every_channel_but_only_todays_rows_count(self):
        self.spend(20.0, self.today, channel="a")
        self.spend(9.0, self.today, channel="b")
        self.spend(500.0, self.yesterday, channel="a")
        led = ledger()
        with patch.dict("os.environ", {"CHRONOS_MAX_DAILY_USD": "30"}):
            spend_guard.check(led, "the voice", operators=True, store=self.store)   # $29 <= $30
            self.spend(2.0, self.today)
            with self.assertRaises(spend_guard.SpendLimitExceeded) as ctx, self.assertLogs(spend_guard.logger, "ERROR"):
                spend_guard.check(led, "the voice", operators=True, store=self.store)
        self.assertIn("CHRONOS_MAX_DAILY_USD", str(ctx.exception))

    def test_a_customers_run_is_not_stopped_by_the_operators_day(self):
        self.spend(999.0, self.today)
        with patch.dict("os.environ", {"CHRONOS_MAX_DAILY_USD": "30"}):
            spend_guard.check(ledger(), "the voice", operators=False, store=self.store)

    def test_this_runs_unflushed_spend_counts_toward_the_day(self):
        self.spend(29.0, self.today)
        led = CostLedger(channel_id="c1")
        with patch.dict("os.environ", {"CHRONOS_PRICE_TTS_CHARACTERS": "0.001", "CHRONOS_MAX_DAILY_USD": "30",
                                       "CHRONOS_MAX_RUN_USD": "off"}):
            led.add("tts_characters", 2000, "voice")  # $2 not yet in the store
            with self.assertRaises(spend_guard.SpendLimitExceeded), self.assertLogs(spend_guard.logger, "ERROR"):
                spend_guard.check(led, "generating stills", operators=True, store=self.store)
            led.flush(self.store)  # now it is in the store: counted once, not twice
            with self.assertRaises(spend_guard.SpendLimitExceeded), self.assertLogs(spend_guard.logger, "ERROR"):
                spend_guard.check(led, "generating stills", operators=True, store=self.store)
        self.assertEqual(led.priced_usd(pending_only=True), 0.0)

    def test_an_unreadable_database_skips_the_daily_cap_with_a_warning(self):
        broken = MagicMock()
        broken.list_video_costs.side_effect = RuntimeError("disk gone")
        with patch.dict("os.environ", {"CHRONOS_MAX_DAILY_USD": "1"}):
            spend_guard.check(ledger(), "the voice", operators=True, store=broken)


class LedgerFlushOnce(unittest.TestCase):
    def test_a_second_flush_writes_only_what_was_added_since(self):
        store = MagicMock()
        led = ledger(tts_characters=10)
        self.assertEqual(led.flush(store), 1)
        self.assertEqual(led.flush(store), 0)          # the finally of a run that already flushed
        led.add("render_seconds", 5, "render")
        self.assertEqual(led.flush(store), 1)
        self.assertEqual(store.record_video_cost.call_count, 2)

    def test_priced_total_is_a_floor_that_survives_an_unpriced_unit(self):
        with patch.dict("os.environ", {"CHRONOS_PRICE_TTS_CHARACTERS": "0.5"}, clear=True):
            led = ledger(tts_characters=2, pexels_requests=9)
        self.assertEqual(led.priced_usd(), 1.0)
        self.assertIsNone(led.total_usd())             # the honest total stays unknown
        self.assertEqual(led.unpriced_units(), ["pexels_requests"])


_CHILD = r"""
import json, logging, os, sys, tempfile, traceback
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock, patch
sys.path.insert(0, sys.argv[1])
row = json.loads(sys.argv[2])
mode = sys.argv[3]
import main
from modules.channels import ChannelContext
from modules.state_store import StateStore

ctx = ChannelContext.from_dict(row)
work = Path(tempfile.mkdtemp())
os.chdir(work)
db = Path(os.environ["CHRONOS_STATE_DB"])
out = {}

class FakeMixer:
    characters_synthesized = 6000
    def __init__(self, *a, **k): pass
    def build(self, script):
        out["voice_built"] = True
        return work / "a.mp3", []
    def describe_voice(self):
        return {"provider": "edge", "source": "default"}

fetcher = MagicMock()
fetcher.generate_broll.return_value = SimpleNamespace(generated=0, by_section={}, newly_generated=0, to_dict=lambda: {})
topic_manager = MagicMock()
if mode == "avatar":
    # a faceless-looking happy path up to the presenter: stock found, clips cost $10 (added when
    # generate_broll runs, after its own guard passed), an enabled avatar, nothing else paid
    fetcher.fetch_videos.return_value = [work / "v.mp4"]
    fetcher.fetch_images.return_value = [work / "i.jpg"]
    fetcher.searches_made = 0
    fetcher.video_terms = {}
    fetcher.provenance = {}
    fetcher.generate_images.return_value = []
    def broll_costs_ten(*a, **k):
        main._RUN_COSTS[0].add("gemini_output_tokens", 1000000, "broll")
        return SimpleNamespace(generated=0, by_section={}, newly_generated=0, to_dict=lambda: {})
    fetcher.generate_broll.side_effect = broll_costs_ten
presenter = MagicMock()

if mode == "daily":     # the operator's day is already spent, before this run starts
    with StateStore(db) as seed:
        seed.record_video_cost(unit="tts_characters", quantity=1, estimated_usd=50.0, channel_id="other",
                               recorded_at=datetime.now(timezone.utc).isoformat())

real_slug = main._run_slug
def slug_after_planning_spend(topic, c):
    # what the topic + script calls would have put in the ledger by now
    main._RUN_COSTS[0].add("gemini_output_tokens", 1000000, "script")
    return real_slug(topic, c)

patches = [
    patch.object(main, "resolve_channel", return_value=ctx),
    patch.object(main, "ensure_assets", return_value=0),
    patch.object(main, "verify_voice", return_value=None),
    patch.object(main.video_providers, "preflight", return_value=None),
    patch.object(main, "AudioMixer", FakeMixer),
    patch.object(main, "MediaFetcher", return_value=fetcher),
    patch.object(main, "TopicManager", return_value=topic_manager),
    patch.object(main, "StateStore", lambda: StateStore(db)),
]
if mode == "planning":
    patches.append(patch.object(main, "_run_slug", slug_after_planning_spend))
if mode == "avatar":
    patches += [
        patch.object(main, "resolve_avatar_config", return_value=SimpleNamespace(enabled=True, provider="x", character_prompt="")),
        patch.object(main, "preflight_avatar", return_value=None),
        patch.object(main, "maybe_generate_presenter", presenter),
        patch.object(main, "SubtitleGenerator", MagicMock()),
        patch.object(main, "ThumbnailGenerator", MagicMock()),
        patch.object(main.video_ir, "write_for_run", return_value=None),
    ]
for p in patches: p.start()
try:
    main.run(script_file=str(Path(sys.argv[1]) / "samples" / "demo_script.json"), channel=ctx.channel_id,
             skip_upload=True)
    out["raised"] = None
except BaseException as e:
    out["raised"] = [type(e).__name__, str(e)]
    out["tb"] = traceback.format_exc()[-1500:]
out["broll_called"] = fetcher.generate_broll.called
out["images_called"] = fetcher.generate_images.called
out["topic_manager_called"] = topic_manager.called
out["presenter_called"] = presenter.called
out.setdefault("voice_built", False)
store = StateStore(db)
out["rows"] = [[r["unit"], r["quantity"], r["estimated_usd"], r["stage"]] for r in store.list_video_costs()]
print("RESULT " + json.dumps(out))
"""

_TERM_CHILD = r"""
import json, os, signal, sys, tempfile
from pathlib import Path
sys.path.insert(0, sys.argv[1])
import main
from modules.cost_ledger import CostLedger
from modules.state_store import StateStore

db = Path(tempfile.mkdtemp()) / "c.db"
main.StateStore = lambda: StateStore(db)
before = signal.getsignal(signal.SIGTERM)

@main._flush_costs_on_exit
def fake_run():
    led = CostLedger(channel_id="c1", slug="s")
    main._RUN_COSTS[:] = [led]
    led.add("tts_characters", 10, "voice")
    os.kill(os.getpid(), signal.SIGTERM)      # docker stop / the worker's timeout
    raise AssertionError("SIGTERM did not stop the run")

@main._flush_costs_on_exit
def broken_run():
    led = CostLedger(channel_id="c1", slug="s2")
    main._RUN_COSTS[:] = [led]
    led.add("tts_characters", 5, "voice")
    raise KeyError("the run's own error")

out = {}
try:
    fake_run()
except SystemExit as e:
    out["exit"] = e.code
out["restored"] = signal.getsignal(signal.SIGTERM) == before

# a SECOND SIGTERM arriving while the flush runs must not abort it
real_flush = main._flush_costs
def flush_hit_by_sigterm(ledger, slug=None):
    os.kill(os.getpid(), signal.SIGTERM)
    return real_flush(ledger, slug)
main._flush_costs = flush_hit_by_sigterm

@main._flush_costs_on_exit
def second_term_run():
    led = CostLedger(channel_id="c1", slug="s3")
    main._RUN_COSTS[:] = [led]
    led.add("tts_characters", 7, "voice")
    raise KeyError("first failure")

try:
    second_term_run()
except BaseException as e:
    out["second_term"] = type(e).__name__
main._flush_costs = real_flush

# a flush that itself blows up must not replace the run's exception
def boom(*a, **k): raise RuntimeError("flush exploded")
main._flush_costs = boom
try:
    broken_run()
except BaseException as e:
    out["original"] = type(e).__name__
print("RESULT " + json.dumps({**out, "rows": [[r["unit"], r["quantity"]] for r in StateStore(db).list_video_costs()]}))
"""

ROW = {"channel_id": "news", "name": "news", "niche": "tech", "status": "ACTIVE",
       "agent_config": {"language": "English"},
       "schedule_config": {"enabled": True, "publish_hour_utc": 15},
       "credential_ref": {"youtube_channel_id": "UCnews", "verified_at": "2026-09-01T00:00:00Z"}}


def child(code, env, *args):
    proc = subprocess.run([sys.executable, "-I", "-c", code, str(ROOT), *args], capture_output=True, text=True,
                          timeout=300, cwd=tempfile.gettempdir(),
                          env={"PATH": "/usr/bin:/bin", "HOME": tempfile.gettempdir(), "GEMINI_API_KEY": "not-a-real-key", "PEXELS_API_KEY": "not-a-real-key",
                               "CHRONOS_STATE_DB": str(Path(tempfile.mkdtemp()) / "state.db"),
                               # these runs are about the spend caps, not the host's free disk (main._preflight_disk)
                               "NIGHTSHIFT_MIN_FREE_DISK_GB": "0",
                               # nothing in these runs may reach Wikipedia (modules/grounding.py)
                               "NIGHTSHIFT_GROUNDED_FACTCHECK": "off", **env})
    line = next((l for l in proc.stdout.splitlines() if l.startswith("RESULT ")), None)
    assert line is not None, proc.stderr[-3000:]
    return json.loads(line[len("RESULT "):])


class PipelineStopsAndRecordsSpend(unittest.TestCase):
    """main.run, end to end with every external stage replaced."""

    def drive(self, env, mode="plain"):
        return child(_CHILD, env, json.dumps(ROW), mode)

    def test_a_run_over_its_cap_stops_before_what_it_would_buy_next_and_still_records_what_it_spent(self):
        out = self.drive({"CHRONOS_PRICE_TTS_CHARACTERS": "0.001", "CHRONOS_MAX_RUN_USD": "5"})
        self.assertEqual(out["raised"][0], "SpendLimitExceeded")
        self.assertIn("CHRONOS_MAX_RUN_USD", out["raised"][1])
        self.assertIn("generating stills", out["raised"][1])    # the first purchase after the voice
        self.assertFalse(out["broll_called"])      # nothing was submitted
        self.assertFalse(out["images_called"])
        # the failed run's spend reached the ledger (it used to be lost)
        self.assertIn(["tts_characters", 6000.0, 6.0, "voice"], out["rows"])

    def test_clips_are_not_submitted_when_they_would_go_over_the_cap(self):
        # 2 clips x $3 = $6 > the $5 cap, although nothing has been spent yet
        out = self.drive({"CHRONOS_ENABLE_VIDEO_GEN": "1", "CHRONOS_VIDEO_PROVIDER": "kling",
                          "KLING_API_KEY": "not-a-real-key", "CHRONOS_PRICE_VIDEO_GEN_CLIPS": "3",
                          "CHRONOS_MAX_RUN_USD": "5"})
        self.assertEqual(out["raised"][0], "SpendLimitExceeded", out.get("tb"))
        self.assertIn("generating b-roll clips", out["raised"][1])
        self.assertFalse(out["broll_called"])

    def test_the_voice_is_not_synthesized_when_planning_already_went_over_the_cap(self):
        out = self.drive({"CHRONOS_PRICE_GEMINI_OUTPUT_TOKENS": "0.00001", "CHRONOS_MAX_RUN_USD": "5"}, "planning")
        self.assertEqual(out["raised"][0], "SpendLimitExceeded", out.get("tb"))
        self.assertIn("the voice", out["raised"][1])
        self.assertFalse(out["voice_built"])       # AudioMixer.build was never called
        self.assertFalse(out["broll_called"])
        self.assertIn(["gemini_output_tokens", 1000000.0, 10.0, "script"], out["rows"])   # planning spend kept

    def test_stills_are_not_requested_when_they_would_go_over_the_cap(self):
        # clips are off (no video provider), stills are on: 2 stills x $1 > the $1 cap
        out = self.drive({"CHRONOS_ENABLE_IMAGE_GEN": "1", "CHRONOS_IMAGE_PROVIDER": "leonardo",
                          "LEONARDO_API_KEY": "not-a-real-key", "CHRONOS_PRICE_IMAGE_GENERATIONS": "1",
                          "CHRONOS_MAX_RUN_USD": "1"})
        self.assertEqual(out["raised"][0], "SpendLimitExceeded", out.get("tb"))
        self.assertIn("generating stills", out["raised"][1])
        self.assertTrue(out["voice_built"])
        self.assertFalse(out["images_called"])

    def test_the_presenter_is_not_generated_when_the_ledger_is_already_over_the_cap(self):
        out = self.drive({"CHRONOS_PRICE_GEMINI_OUTPUT_TOKENS": "0.00001", "CHRONOS_MAX_RUN_USD": "5"}, "avatar")
        self.assertEqual(out["raised"][0], "SpendLimitExceeded", out.get("tb"))
        self.assertIn("generating the presenter", out["raised"][1])
        self.assertFalse(out["presenter_called"])
        self.assertTrue(out["broll_called"])        # it got that far: the clips guard had passed

    def test_an_exhausted_daily_cap_stops_the_operators_run_before_any_paid_planning(self):
        out = self.drive({"CHRONOS_MAX_DAILY_USD": "30"}, "daily")      # $50 already spent today
        self.assertEqual(out["raised"][0], "SpendLimitExceeded", out.get("tb"))
        self.assertIn("the topic", out["raised"][1])
        self.assertIn("CHRONOS_MAX_DAILY_USD", out["raised"][1])
        self.assertFalse(out["topic_manager_called"])
        self.assertFalse(out["voice_built"])

    def test_a_run_that_fails_for_any_other_reason_also_records_its_spend(self):
        # no cap: the pipeline goes on past the guard, then dies in the fake fetcher's
        # first use of a MagicMock-built value; the TTS entry must still be in the ledger.
        out = self.drive({"CHRONOS_MAX_RUN_USD": "off"})
        self.assertIsNotNone(out["raised"])
        self.assertNotEqual(out["raised"][0], "SpendLimitExceeded")
        self.assertIn("tts_characters", [r[0] for r in out["rows"]])
        self.assertEqual([r[0] for r in out["rows"]].count("tts_characters"), 1)   # once, not twice


class TerminatedRunStillRecordsSpend(unittest.TestCase):
    def test_sigterm_unwinds_so_the_ledger_is_flushed_and_the_handler_is_restored(self):
        out = child(_TERM_CHILD, {})
        self.assertEqual(out["exit"], 143)
        self.assertTrue(out["restored"])
        self.assertIn(["tts_characters", 10.0], out["rows"])

    def test_a_second_sigterm_during_the_flush_does_not_abort_it(self):
        out = child(_TERM_CHILD, {})
        self.assertEqual(out["second_term"], "KeyError")
        self.assertIn(["tts_characters", 7.0], out["rows"])

    def test_a_failing_flush_never_replaces_the_runs_own_exception(self):
        out = child(_TERM_CHILD, {})
        self.assertEqual(out["original"], "KeyError")


if __name__ == "__main__":
    unittest.main()

"""modules/ai_disclosure.py — the one rule that decides the "altered or synthetic
content" label for every platform. The 'auto' decision table is pinned row by
row: a row that flips is a change in what the channel tells its audience."""

import re
import unittest
from pathlib import Path

from modules import ai_disclosure as ad
from modules.channels import AgentConfig


def sig(**kw):
    return ad.Signals(**kw)


class AutoDecisionTable(unittest.TestCase):
    """Every row of the table in docs/AI_DISCLOSURE.md."""

    def check(self, signals, label, reasons):
        d = ad.decide("auto", signals)
        self.assertEqual((d.label, d.reasons), (label, tuple(reasons)))

    def test_stock_footage_with_generic_voice_is_not_labelled(self):
        self.check(sig(), False, [ad.R_NONE])

    def test_own_voice_clone_is_exempt(self):
        # The page: "Cloning one's own voice to create voice overs or dubs" needs no disclosure.
        self.check(sig(voice=ad.VOICE_OWN_CLONE), False, [ad.R_NONE])

    def test_generated_clip_is_labelled(self):
        self.check(sig(generated_clips=1), True, [ad.R_GENERATED_VIDEO])

    def test_generated_still_is_labelled(self):
        self.check(sig(generated_stills=3), True, [ad.R_GENERATED_IMAGES])

    def test_ai_presenter_is_labelled(self):
        self.check(sig(presenter=True), True, [ad.R_AI_PRESENTER])

    def test_another_real_persons_voice_is_labelled(self):
        self.check(sig(voice=ad.VOICE_REAL_PERSON), True, [ad.R_REAL_PERSON_VOICE])

    def test_unreadable_provenance_is_labelled_not_assumed_clean(self):
        # CLAUDE.md rule 5: an unknown is not a measured "no".
        self.check(sig(known=False), True, [ad.R_PROVENANCE_UNKNOWN])

    def test_every_reason_is_listed_when_several_hold(self):
        self.check(sig(generated_clips=2, generated_stills=1, presenter=True, voice=ad.VOICE_REAL_PERSON), True,
                   [ad.R_GENERATED_VIDEO, ad.R_GENERATED_IMAGES, ad.R_AI_PRESENTER, ad.R_REAL_PERSON_VOICE])

    def test_unknown_voice_word_reads_as_real_person(self):
        # A typo must not switch a disclosure off.
        self.check(sig(voice="realperson"), True, [ad.R_REAL_PERSON_VOICE])


class Modes(unittest.TestCase):
    def test_never_is_false_even_with_generated_media(self):
        d = ad.decide("never", sig(generated_clips=5, presenter=True))
        self.assertEqual((d.label, d.reasons, d.line), (False, (ad.R_MODE_NEVER,), ""))

    def test_always_is_true_even_for_stock_only(self):
        d = ad.decide("always", sig())
        self.assertEqual((d.label, d.reasons), (True, (ad.R_MODE_ALWAYS,)))
        self.assertTrue(d.line)

    def test_default_and_garbage_are_auto_never_never(self):
        self.assertEqual(ad.normalize_mode(None), "auto")
        self.assertEqual(ad.normalize_mode("nevr"), "auto")
        self.assertEqual(ad.normalize_mode(False), "auto")
        self.assertEqual(ad.normalize_mode(" NEVER "), "never")
        self.assertEqual(ad.normalize_mode("Always"), "always")

    def test_mode_garbage_with_synthetic_media_still_labels(self):
        self.assertTrue(ad.decide("off", sig(generated_clips=1)).label)


class Line(unittest.TestCase):
    def test_standard_wording_per_language(self):
        for lang, code in (("english", "en"), ("russian", "ru"), ("uzbek", "uz"), ("ru", "ru"), ("uz-UZ", "uz"),
                           ("klingon", "en"), ("", "en"), (None, "en")):
            self.assertEqual(ad.line_for(lang), ad.STANDARD_LINES[code], lang)

    def test_label_false_has_no_line(self):
        self.assertEqual(ad.decide("auto", sig(), language="russian").line, "")

    def test_line_flag_off_drops_only_the_line(self):
        d = ad.decide("auto", sig(generated_clips=1), line_enabled=False)
        self.assertEqual((d.label, d.line), (True, ""))

    def test_only_an_explicit_false_drops_the_line(self):
        for v in (None, True, 0, "no", ""):
            self.assertTrue(ad.normalize_line_flag(v), v)
        self.assertFalse(ad.normalize_line_flag(False))

    def test_custom_wording_overrides_and_is_one_clean_line(self):
        d = ad.decide("always", sig(), custom_text="  Made with <b>AI</b>\n tools  ")
        self.assertEqual(d.line, "Made with bAI/b tools")

    def test_custom_wording_is_capped(self):
        self.assertEqual(len(ad.normalize_text("x" * 1000)), ad.LINE_MAX)
        self.assertEqual(ad.normalize_text(123), "")

    def test_append_line_only_when_it_fits_and_not_twice(self):
        self.assertEqual(ad.append_line("Body", "Line", limit=100), "Body\n\nLine")
        self.assertEqual(ad.append_line("Body\n\nLine", "Line", limit=100), "Body\n\nLine")
        self.assertEqual(ad.append_line("Body", "Line", limit=8), "Body")
        self.assertEqual(ad.append_line("", "Line", limit=100), "Line")
        self.assertEqual(ad.append_line("Body", "", limit=100), "Body")

    def test_append_line_measures_bytes_when_asked(self):
        body = "я" * 10  # 20 bytes
        self.assertEqual(ad.append_line(body, "Line", limit=24, measure=lambda s: len(s.encode())), body)
        self.assertNotEqual(ad.append_line(body, "Line", limit=26, measure=lambda s: len(s.encode())), body)


class FromManifest(unittest.TestCase):
    def asset(self, kind, source):
        return {"id": "a", "kind": kind, "source": source}

    def test_counts_generated_assets_by_kind_and_ignores_stock(self):
        m = {"assets": [self.asset("video", "generated"), self.asset("video", "generated"),
                        self.asset("image", "generated"), self.asset("video", "stock"),
                        self.asset("image", "stock"), self.asset("audio", "generated")]}
        s = ad.signals_from_manifest(m)
        self.assertEqual((s.known, s.generated_clips, s.generated_stills), (True, 2, 1))

    def test_all_stock_manifest_is_known_and_clean(self):
        s = ad.signals_from_manifest({"assets": [self.asset("video", "stock")]})
        self.assertEqual((s.known, s.generated_clips, s.generated_stills), (True, 0, 0))
        self.assertFalse(ad.decide("auto", s).label)

    def test_missing_or_broken_manifest_is_unknown(self):
        for m in (None, {}, {"assets": "x"}, [], "x"):
            self.assertFalse(ad.signals_from_manifest(m).known, m)

    def test_junk_entries_are_skipped(self):
        s = ad.signals_from_manifest({"assets": [None, 3, "x", self.asset("video", "generated")]})
        self.assertEqual(s.generated_clips, 1)


class FromEvents(unittest.TestCase):
    def ev(self, ts, **signals):
        return {"event": ad.EVENT, "ts": ts, "metadata": {"signals": signals}}

    def good(self, **kw):
        base = {"known": True, "generated_clips": 0, "generated_stills": 0, "presenter": False, "voice": "generic"}
        base.update(kw)
        return base

    def test_newest_event_wins_by_ts(self):
        rows = [self.ev("2026-10-02", **self.good(generated_clips=4)),
                self.ev("2026-10-01", **self.good(generated_clips=1))]
        self.assertEqual(ad.signals_from_events(rows).generated_clips, 4)

    def test_other_events_and_unreadable_records_are_ignored(self):
        rows = [{"event": "video.published", "ts": "2026-10-09", "metadata": {}},
                {"event": ad.EVENT, "ts": "2026-10-09", "metadata": {"signals": {"generated_clips": "3"}}},
                {"event": ad.EVENT, "ts": "2026-10-09", "metadata": None},
                self.ev("2026-10-01", **self.good(presenter=True))]
        self.assertTrue(ad.signals_from_events(rows).presenter)

    def test_none_when_nothing_readable(self):
        self.assertIsNone(ad.signals_from_events([]))
        self.assertIsNone(ad.signals_from_events(None))

    def test_round_trip(self):
        s = sig(generated_clips=2, presenter=True, voice=ad.VOICE_OWN_CLONE)
        self.assertEqual(ad.Signals.from_dict(s.to_dict()), s)

    def test_negative_or_bool_counts_are_unreadable(self):
        self.assertIsNone(ad.Signals.from_dict(self.good(generated_clips=-1)))
        self.assertIsNone(ad.Signals.from_dict(self.good(generated_clips=True)))


class ChannelSettings(unittest.TestCase):
    def test_defaults_are_auto_generic_line_on(self):
        a = AgentConfig.from_dict({})
        self.assertEqual((a.ai_disclosure, a.ai_disclosure_voice, a.ai_disclosure_line, a.ai_disclosure_text),
                         ("auto", "generic", True, ""))

    def test_round_trip_through_agent_config(self):
        a = AgentConfig.from_dict({"ai_disclosure": "never", "ai_disclosure_voice": "own_clone",
                                   "ai_disclosure_line": False, "ai_disclosure_text": "AI helped."})
        again = AgentConfig.from_dict(a.to_dict())
        self.assertEqual((again.ai_disclosure, again.ai_disclosure_voice, again.ai_disclosure_line,
                          again.ai_disclosure_text), ("never", "own_clone", False, "AI helped."))

    def test_garbage_in_agent_config_never_turns_it_off(self):
        a = AgentConfig.from_dict({"ai_disclosure": "disabled", "ai_disclosure_voice": 7})
        self.assertEqual((a.ai_disclosure, a.ai_disclosure_voice), ("auto", "real_person"))

    def test_decide_for_uses_the_channels_voice_over_the_recorded_one(self):
        agent = AgentConfig.from_dict({"ai_disclosure_voice": "real_person", "language": "russian"})
        d = ad.decide_for(agent, sig(voice="generic"))
        self.assertEqual((d.label, d.reasons), (True, (ad.R_REAL_PERSON_VOICE,)))
        self.assertEqual(d.line, ad.STANDARD_LINES["ru"])

    def test_decide_for_honours_mode_never(self):
        agent = AgentConfig.from_dict({"ai_disclosure": "never"})
        self.assertFalse(ad.decide_for(agent, sig(generated_clips=3)).label)


class ForRun(unittest.TestCase):
    def test_a_run_with_only_stock_media_is_clean(self):
        d, s = ad.for_run(AgentConfig.from_dict({}), generated_clips=0, generated_stills=0, presenter=False)
        self.assertFalse(d.label)
        self.assertTrue(s.known)

    def test_generated_clips_from_the_run_label_it(self):
        d, s = ad.for_run(AgentConfig.from_dict({"language": "russian"}), generated_clips=3, generated_stills=0,
                          presenter=False)
        self.assertEqual((d.label, d.reasons, d.line), (True, (ad.R_GENERATED_VIDEO,), ad.STANDARD_LINES["ru"]))
        self.assertEqual(s.generated_clips, 3)

    def test_junk_counts_read_as_zero(self):
        _, s = ad.for_run(None, generated_clips=None, generated_stills="2", presenter=0)
        self.assertEqual((s.generated_clips, s.generated_stills, s.presenter), (0, 0, False))

    def test_no_agent_means_defaults(self):
        d, _ = ad.for_run(None, generated_clips=1, generated_stills=0, presenter=False)
        self.assertEqual((d.label, d.mode), (True, "auto"))


class Overrides(unittest.TestCase):
    """Until an admin lock exists, a setting that lowers what 'auto' declares must at least be visible: in the
    recorded event and in the log."""

    def meta(self, agent, **kw):
        d, s = ad.for_run(AgentConfig.from_dict(agent), generated_clips=kw.get("clips", 0), generated_stills=0,
                          presenter=False)
        return d.to_metadata("english", s)

    def test_never_is_marked_in_the_record(self):
        self.assertEqual(self.meta({"ai_disclosure": "never"}, clips=2)["overrides"], ["mode_never"])

    def test_own_voice_clone_is_marked_in_the_record(self):
        self.assertEqual(self.meta({"ai_disclosure_voice": "own_clone"})["overrides"], ["voice_own_clone"])

    def test_both_and_neither(self):
        self.assertEqual(self.meta({"ai_disclosure": "never", "ai_disclosure_voice": "own_clone"})["overrides"],
                         ["mode_never", "voice_own_clone"])
        for agent in ({}, {"ai_disclosure": "always"}, {"ai_disclosure_voice": "real_person"}):
            self.assertEqual(self.meta(agent)["overrides"], [], agent)

    def test_the_log_says_so_for_never_and_own_clone(self):
        for agent in ({"ai_disclosure": "never"}, {"ai_disclosure_voice": "own_clone"}):
            with self.assertLogs("modules.ai_disclosure", level="WARNING") as cm:
                ad.for_run(AgentConfig.from_dict(agent), generated_clips=1, generated_stills=0, presenter=False)
            self.assertIn("channel settings", cm.output[0])

    def test_the_default_logs_nothing(self):
        with self.assertNoLogs("modules.ai_disclosure", level="WARNING"):
            ad.for_run(AgentConfig.from_dict({}), generated_clips=1, generated_stills=0, presenter=False)

    def test_the_dashboard_still_reads_a_record_with_overrides(self):
        # the TypeScript parser ignores unknown keys; the key names are pinned here so the two sides stay aligned
        self.assertIn("overrides", self.meta({"ai_disclosure": "never"}))


class DashboardAgrees(unittest.TestCase):
    """The review panel reads the event this module's words are written into (command-center/lib/aiDisclosure.ts):
    the event name and the closed reason list must be the same on both sides."""

    TS = (Path(__file__).resolve().parent.parent / "command-center" / "lib" / "aiDisclosure.ts").read_text(encoding="utf-8")

    def test_event_name(self):
        self.assertIn(f'AI_DISCLOSURE_EVENT = "{ad.EVENT}"', self.TS)

    def test_reason_words_and_modes(self):
        listed = re.search(r"AI_REASONS = \[(.*?)\] as const", self.TS, re.S).group(1)
        self.assertEqual(sorted(re.findall(r'"([a-z_]+)"', listed)), sorted(ad.REASONS))
        overrides = re.search(r"AI_OVERRIDES = \[(.*?)\] as const", self.TS, re.S).group(1)
        self.assertEqual(sorted(re.findall(r'"([a-z_]+)"', overrides)), ["mode_never", "voice_own_clone"])
        modes = re.search(r"AI_MODES = \[(.*?)\] as const", self.TS, re.S).group(1)
        self.assertEqual(sorted(re.findall(r'"([a-z]+)"', modes)), sorted(ad.MODES))


class Metadata(unittest.TestCase):
    def test_metadata_has_facts_not_prompts(self):
        s = sig(generated_clips=1)
        d = ad.decide("auto", s, language="uzbek")
        m = d.to_metadata("uzbek", s)
        self.assertEqual(m["label"], True)
        self.assertEqual(m["language"], "uz")
        self.assertEqual(m["reasons"], [ad.R_GENERATED_VIDEO])
        self.assertEqual(m["signals"]["generated_clips"], 1)
        self.assertTrue(m["line"])
        self.assertTrue(set(m["reasons"]) <= set(ad.REASONS))


if __name__ == "__main__":
    unittest.main()

"""The per-channel risk settings the Command Center can write (spend ceiling, pinned comment, watch-next) are read by the
worker exactly as the editor means them, and a hostile stored value neither crashes the load nor silently removes a limit.

Why it matters: these three keys sit in agent_config, which any EDITOR of the organisation may write (they are not in
channels_config_guard's list), so what the worker reads is whatever a browser, a script or a stale page stored. A ceiling
the worker cannot read is "no ceiling", which is the most expensive way to be wrong; a value that makes from_dict raise
takes the whole registry load down with it.

The cases are command-center/tests/fixtures/channel-risk-cases.json, shared with channel-risk.test.ts.
"""

import json
import re
import unittest
from pathlib import Path

from modules.channels import AgentConfig

ROOT = Path(__file__).resolve().parent.parent
CASES = json.loads((ROOT / "command-center" / "tests" / "fixtures" / "channel-risk-cases.json").read_text(encoding="utf-8"))
MIG = ROOT / "supabase" / "migrations"


def ceiling(raw):
    return AgentConfig.from_dict({"spend_ceiling_usd": raw}).spend_ceiling_usd


class SpendCeilingReading(unittest.TestCase):
    def test_every_stored_shape_reads_as_the_fixture_says(self):
        for case in CASES["stored"]:
            with self.subTest(raw=case["raw"]):
                self.assertEqual(ceiling(case["raw"]), case["worker"])

    def test_every_number_the_editor_can_store_is_honoured_not_dropped(self):
        for case in CASES["saveable"]:
            with self.subTest(typed=case["typed"]):
                self.assertEqual(ceiling(case["stored"]), case["stored"])

    def test_a_huge_integer_literal_does_not_crash_the_load(self):
        # JSON allows an integer of any size; float() of 10**400 raises OverflowError, which is neither TypeError nor ValueError.
        self.assertIsNone(ceiling(10 ** 400))
        self.assertIsNone(ceiling(-(10 ** 400)))

    def test_true_is_not_a_one_dollar_ceiling(self):
        # bool is an int in Python: float(True) == 1.0 would cap the channel at $1 on a stray boolean.
        self.assertIsNone(ceiling(True))

    def test_an_infinite_ceiling_is_no_ceiling_said_plainly(self):
        self.assertIsNone(ceiling(float("inf")))
        self.assertIsNone(ceiling("inf"))

    def test_the_other_settings_of_the_same_blob_survive_a_hostile_ceiling(self):
        a = AgentConfig.from_dict({"spend_ceiling_usd": 10 ** 400, "language": "Russian", "pinned_comment": False})
        self.assertEqual(a.language, "Russian")
        self.assertFalse(a.pinned_comment)

    def test_only_ascii_digits_and_ascii_whitespace_count(self):
        # float() accepts a BOM-free Unicode space, Arabic-Indic digits and "1_000"; the page reads none of them, so the
        # worker must not enforce a limit the page shows as "no limit" (or the other way round).
        for raw in ("\ufeff25", "\u00a025", "25\u2003", "\u0662\u0665", "1_000", "2\u06f5"):
            with self.subTest(raw=raw):
                self.assertIsNone(ceiling(raw))
        self.assertEqual(ceiling(" \t25\n"), 25.0)

    def test_it_round_trips_through_to_dict(self):
        a = AgentConfig.from_dict({"spend_ceiling_usd": "25,5".replace(",", ".")})
        self.assertEqual(AgentConfig.from_dict(a.to_dict()).spend_ceiling_usd, 25.5)


class OnOffSwitches(unittest.TestCase):
    """Absent reads as ON; ONLY a real false turns them off (what the editor's switch writes)."""

    def test_only_an_explicit_false_turns_either_off(self):
        for key in ("pinned_comment", "watch_next"):
            for raw, expected in [(False, False), (True, True), (None, True), ("false", True), (0, True), ("", True), ([], True)]:
                with self.subTest(key=key, raw=raw):
                    self.assertEqual(getattr(AgentConfig.from_dict({key: raw}), key), expected)
            self.assertTrue(getattr(AgentConfig.from_dict({}), key))
            self.assertTrue(getattr(AgentConfig.from_dict(None), key))

    def test_off_survives_a_round_trip(self):
        a = AgentConfig.from_dict({"pinned_comment": False, "watch_next": False})
        b = AgentConfig.from_dict(a.to_dict())
        self.assertFalse(b.pinned_comment)
        self.assertFalse(b.watch_next)


def function_body(sql: str, name: str) -> str:
    i = sql.index(f"create or replace function public.{name}")
    return sql[i:sql.index("\n$$;", i) + 4]


class EditorMayWriteTheseKeys(unittest.TestCase):
    """Pinned from the migrations: the three keys are editor-level. If a later migration puts one of them behind the
    administrator lock, the editor in the Command Center would offer a switch that always fails, and this says so."""

    KEYS = ("spend_ceiling_usd", "pinned_comment", "watch_next")

    def latest_guard(self) -> str:
        # The newest migration that defines channels_config_guard() is the live body.
        latest = None
        for p in sorted(MIG.glob("*.sql")):
            if "create or replace function public.channels_config_guard()" in p.read_text(encoding="utf-8"):
                latest = p
        self.assertIsNotNone(latest)
        return function_body(latest.read_text(encoding="utf-8"), "channels_config_guard()")

    def test_the_guard_locks_four_controls_and_none_of_these(self):
        body = self.latest_guard()
        controls = re.search(r"controls constant text\[\] := array\[(.*?)\];", body, re.S).group(1)
        self.assertEqual(sorted(re.findall(r"'(\w+)'", controls)),
                         ["auto_publish", "publish_gate", "require_two_person_publish", "storyboard_review"])
        for key in self.KEYS:
            self.assertNotIn(key, body)

    def test_agent_config_is_a_column_an_editor_may_update(self):
        text = (MIG / "0086_channel_config_lock.sql").read_text(encoding="utf-8")
        grant = re.search(r"grant update \((.*?)\)\s+on public\.channels to authenticated;", text, re.S).group(1)
        self.assertIn("agent_config", [c.strip() for c in grant.split(",")])
        policy = (MIG / "0018_organizations.sql").read_text(encoding="utf-8")
        update = policy[policy.index("create policy channels_auth_update"):]
        update = update[:update.index(";")]
        self.assertEqual(update.count("accessible_org_ids('editor')"), 2)


if __name__ == "__main__":
    unittest.main()

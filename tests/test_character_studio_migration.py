"""Migration 0135 (Character Studio), pinned from the file: what the security lab cannot see by running it.

* every function body hashes to the value the drift guard, the end state and the rollback name (the three lists agree);
* it replaces nothing and touches no object it did not add: no `create or replace` of an older name, no `alter table` of an older table, no
  write to credit_prices (job_minimum) or to reserve_credits, and it names no object of the Ads Factory (0131 / 0133);
* the grants are exactly four functions to `authenticated` and four to `service_role`; the helpers to nobody;
* the shipped prices are NULL (nothing on sale), the vendor rates and limits are the registry's, the prompt screen is the worker's;
* the money path: a hold only after the caps and under the platform lock taken after the organization's; a capture of exactly the charge
  only in finish; a release in every ending;
* the rollback is one transaction and drops exactly what was added.
Later migration numbers are allowed: nothing here pins that 0135 is the highest.
"""

import hashlib
import json
import re
import unittest
from pathlib import Path

from modules import character_swap as cs

ROOT = Path(__file__).resolve().parent.parent
MIG = ROOT / "supabase" / "migrations"
FILE = MIG / "0135_character_studio.sql"
TEXT = FILE.read_text(encoding="utf-8")
ROLLBACK = (ROOT / "docs" / "sql" / "rollback_0135_character_studio.sql").read_text(encoding="utf-8")
REGISTRY = json.loads((ROOT / "schemas" / "model_registry.json").read_text(encoding="utf-8"))

TABLES = ["character_swap_models", "character_swap_settings", "character_swap_consents", "character_swap_jobs", "character_swap_templates",
          "character_swap_template_samples"]
MEMBER = {
    "quote_character_swap": "uuid, uuid, text",
    "record_character_swap_consent": "uuid, text, uuid, uuid[], jsonb, text",
    "request_character_swap": "uuid, uuid, uuid, uuid[], text, text, text, uuid, numeric, text",
    "cancel_character_swap": "uuid",
}
WORKER = {
    "claim_character_swap": "text",
    "record_character_swap_task": "uuid, text, text",
    "finish_character_swap": "uuid, text, uuid",
    "fail_character_swap": "uuid, text, text",
}
INTERNAL = {
    "character_swap_prompt_patterns": "",
    "character_swap_norm": "text",
    "character_swap_prompt_problem": "text",
    "character_swap_declarations_problem": "jsonb",
    "character_swap_settings_guard": "",
    "character_swap_settings_trail": "",
    "character_swap_append_only": "",
    "character_swap_charge": "text, text, numeric",
    "character_swap_hold": "numeric",
    "character_swap_input_problem": "uuid, text, uuid, uuid[]",
    "character_swap_end_locked": "uuid, text, text",
    "character_swap_sweep": "uuid",
}
ALL = {**MEMBER, **WORKER, **INTERNAL}


def code(sql: str) -> str:
    return "\n".join(line.split("--", 1)[0] for line in sql.splitlines())


def body(sql: str, name: str) -> str:
    i = sql.index(f"create or replace function public.{name}(")
    a = sql.index("$$", i) + 2
    return sql[a:sql.index("$$", a)]


def h(b: str) -> str:
    return hashlib.md5(re.sub(r"\s+", " ", b).encode()).hexdigest()


def pins(sql: str, start: str, end: str) -> dict:
    block = sql[sql.index(start):sql.index(end, sql.index(start))]
    return {m.group(1): m.group(2) for m in re.finditer(r"\('public\.(\w+)\([^']*\)', '([0-9a-f]{32})'", block)}


GUARD = pins(TEXT, "A function of one of this file's names that already exists", "-- 1. The words")
END = pins(TEXT, "-- 8. The end state", "-- Verify (the SQL editor")
RB = pins(ROLLBACK, "begin;", "-- 1. The functions an API role could call.")


class Numbering(unittest.TestCase):
    def test_the_number_is_unique_and_0132_and_0134_are_left_to_their_own_pull_requests(self):
        numbers = sorted(p.name[:4] for p in MIG.glob("*.sql"))
        self.assertEqual(numbers.count("0135"), 1)
        self.assertIn("0133", numbers)
        for taken in ("0132", "0134"):
            self.assertNotIn(f"{taken}_character", " ".join(p.name for p in MIG.glob("*.sql")))
        self.assertIn("0132 is reserved by open pull request #677", TEXT)
        self.assertIn("0134 by\n-- the brand-scan follow-up", TEXT)

    def test_the_file_says_it_is_applied_as_one_transaction_and_what_to_verify(self):
        for needle in ("APPLY AS ONE TRANSACTION", "WHAT TO VERIFY BEFORE YOU APPLY", "LIVE ON APPLY"):
            self.assertIn(needle, TEXT)
        self.assertIn("set local lock_timeout = '5s'", code(TEXT))
        self.assertRegex(ROLLBACK, r"(?m)^begin;$")
        self.assertEqual(len(re.findall(r"(?m)^commit;$", ROLLBACK)), 1)
        self.assertIn("set local lock_timeout = '5s'", ROLLBACK)


class Hashes(unittest.TestCase):
    def test_every_function_is_pinned_in_the_guard_the_end_state_and_the_rollback_with_its_real_hash(self):
        want = {name: h(body(TEXT, name)) for name in ALL}
        self.assertEqual(GUARD, want)
        self.assertEqual(END, want)
        self.assertEqual(RB, want)
        self.assertEqual(len(set(want.values())), len(want))

    def test_the_signatures_are_written_out_in_all_three(self):
        for name, args in ALL.items():
            self.assertEqual(TEXT.count(f"('public.{name}({args})', '"), 2, name)
            self.assertIn(f"('public.{name}({args})', '", ROLLBACK, name)

    def test_no_source_line_carries_a_literal_invisible_character(self):
        for text in (TEXT, ROLLBACK):
            self.assertIsNone(re.search("[\u00ad\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]", text))


class Scope(unittest.TestCase):
    c = code(TEXT).lower()

    def test_it_creates_exactly_its_own_functions_and_tables(self):
        self.assertEqual(sorted(set(re.findall(r"create or replace function public\.(\w+)\(", self.c))), sorted(ALL))
        self.assertEqual(sorted(re.findall(r"create table if not exists public\.(\w+)", self.c)), sorted(TABLES))

    def test_it_alters_only_its_own_tables_and_names_nothing_of_the_ads_factory(self):
        self.assertEqual(set(re.findall(r"alter table public\.(\w+)", self.c)) - set(TABLES), set())
        self.assertIsNone(re.search(r"\b(brand_\w+|ad_\w+|ads_\w+)\b", self.c))
        self.assertIsNone(re.search(r"\bcreative_jobs\b", self.c), "a character swap is not a creative job")

    def test_it_changes_no_shared_money_function_and_no_price(self):
        for fn in ("reserve_credits", "capture_credits", "release_credits", "creative_platform_reserve", "credits_round_up"):
            self.assertNotIn(f"function public.{fn}(", self.c, fn)
        self.assertIsNone(re.search(r"(insert into|update|delete from)\s+public\.credit_prices", self.c), "job_minimum is never changed")

    def test_the_grants(self):
        granted = re.findall(r"grant execute on function public\.(\w+)\(([^)]*)\) to (\w+);", self.c)
        self.assertEqual({(n, r) for n, _, r in granted}, {(n, "authenticated") for n in MEMBER} | {(n, "service_role") for n in WORKER})
        for name in ALL:
            self.assertIn(f"revoke all on function public.{name}(", self.c, name)

    def test_every_definer_pins_its_search_path(self):
        for m in re.finditer(r"create or replace function public\.(\w+)\([^$]*?\$\$", self.c, re.S):
            self.assertIn("set search_path = public, pg_temp", m.group(0), m.group(1))


class Money(unittest.TestCase):
    c = code(TEXT)

    def test_nothing_is_on_sale_as_shipped(self):
        seed = TEXT[TEXT.index("insert into public.character_swap_models"):]
        seed = seed[:seed.index("on conflict (model_id) do nothing")]
        rows = re.findall(r"\('([a-z0-9.-]+)', (\d+), (null|[0-9.]+),", seed)
        self.assertEqual([(r[0], r[2]) for r in rows], [("kling-4.0-omni-edit", "null"), ("seedance-2.5-edit", "null")])

    def test_the_vendor_rates_and_limits_are_the_registrys(self):
        entries = {m["id"]: m for m in REGISTRY["models"]}
        seed = TEXT[TEXT.index("insert into public.character_swap_models"):]
        for mid, p720, p1080, lo, hi, refs, people, src in re.findall(
                r"\('([a-z0-9.-]+)', \d+, null, ([0-9.]+), ([0-9.]+), (\d+), (\d+), (\d+), '(\w+)', '(https://[^']+)'\)", seed):
            m = entries[mid]
            self.assertEqual((float(p720), float(p1080)), (m["pricing"]["variants"]["prices"]["720p"], m["pricing"]["variants"]["prices"]["1080p"]))
            self.assertEqual([int(lo), int(hi)], m["character_swap"]["input_seconds"])
            self.assertEqual(int(refs), m["character_swap"]["reference_images_max"])
            self.assertEqual(people, m["character_swap"]["real_people"])
            self.assertEqual(src, m["pricing"]["source_url"])

    def test_the_request_holds_only_after_every_cap_and_under_the_platform_lock_taken_after_the_organizations(self):
        b = body(TEXT, "request_character_swap")
        org_lock = b.index("hashtextextended('character_swap:' || p_org::text, 0)")
        platform = b.index("hashtextextended('character_swap_global', 0)")
        hold = b.index("creative_platform_reserve")
        self.assertLess(org_lock, b.index("for share"), "the rows are locked only after the organization's lock (0131)")
        for refusal in ("'not_on_sale'", "'price_changed' using errcode = 'NS409', detail", "'consent_required'", "'org_daily_limit'",
                        "'job_in_progress'", "'platform_busy'"):
            self.assertLess(b.index(refusal), hold, refusal)
        self.assertLess(org_lock, platform)
        self.assertLess(platform, hold)
        self.assertIn("charge > p_max_credits", b, "the confirmed price is compared with the charge, never the hold")

    def test_capture_is_exactly_the_charge_and_only_in_finish(self):
        self.assertEqual(self.c.count("capture_credits("), 2, "one call, one prerequisite check")
        self.assertIn("public.capture_credits(x.credit_ref, x.charge_credits, false)", body(TEXT, "finish_character_swap"))
        self.assertIn("creative_platform_release(x.credit_ref)", body(TEXT, "character_swap_end_locked"))
        for fn in ("cancel_character_swap", "fail_character_swap", "character_swap_sweep", "claim_character_swap"):
            self.assertIn("character_swap_end_locked(", body(TEXT, fn), fn)

    def test_a_cancel_takes_the_locks_in_0131s_order(self):
        b = body(TEXT, "cancel_character_swap")
        self.assertLess(b.index("select org_id into v_org"), b.index("is_org_member(v_org, 'editor')"))
        self.assertLess(b.index("is_org_member(v_org, 'editor')"), b.index("pg_advisory_xact_lock"))
        self.assertLess(b.index("pg_advisory_xact_lock"), b.index("for no key update"))


class Screen(unittest.TestCase):
    def test_the_prompt_patterns_are_the_workers(self):
        arr = body(TEXT, "character_swap_prompt_patterns")
        sql = re.findall(r"'((?:[^']|'')*)'", arr[arr.index("array["):])
        self.assertEqual(tuple(x.replace("''", "'") for x in sql), cs.PROMPT_PATTERNS)

    def test_the_templates_prompts_pass_the_screen(self):
        for prompt in re.findall(r"'((?:Replace)[^']*)'", TEXT[TEXT.index("insert into public.character_swap_templates"):]):
            self.assertIsNone(cs.prompt_problem(prompt), prompt)


class Rollback(unittest.TestCase):
    def test_it_drops_exactly_what_was_added(self):
        dropped_fns = set(re.findall(r"drop function if exists public\.(\w+)\(", ROLLBACK))
        dropped_tables = set(re.findall(r"drop table if exists public\.(\w+);", ROLLBACK))
        self.assertEqual(dropped_fns, set(ALL))
        self.assertEqual(dropped_tables, set(TABLES))
        self.assertNotIn(" cascade", code(ROLLBACK).lower())

    def test_it_refuses_while_a_job_is_in_flight_or_people_have_rows(self):
        self.assertIn("still requested or running", ROLLBACK)
        self.assertIn("nightshift.character_swap_rollback_delete_rows", ROLLBACK)
        for t in ("character_swap_jobs", "character_swap_consents", "character_swap_template_samples"):
            self.assertIn(f"'{t}'", ROLLBACK)


if __name__ == "__main__":
    unittest.main()

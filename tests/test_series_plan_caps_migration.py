"""Migration 0127 (the per-person and platform-wide plan caps, finding F4), pinned from the file: what the security lab cannot see by running it.

* the replaced function is 0122's request_series_plan body with ONLY lines added (each block marked 0127), and the drift guard in the file carries
  exactly the md5 of the old and the new body (the header names the same hashes, so the person who applies it reads what the file checks);
* it grants nothing: no migration grants request_series_plan, the file revokes it and refuses to run when it is executable by an API role;
* the locks are taken in the order organization, person, platform, after the replay and before the insert; a refusal is a closed word;
* the rollback restores 0122's body byte for byte, refuses a granted function, and runs before 0122's;
* the docs and the worker's env comment say the caps exist, with the defaults, and the closed words are mapped in the Command Center.
"""

import hashlib
import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MIG = ROOT / "supabase" / "migrations"
FILE = MIG / "0127_series_plan_caps.sql"
TEXT = FILE.read_text(encoding="utf-8")
M0122 = (MIG / "0122_series_template_carrier.sql").read_text(encoding="utf-8")
ROLLBACK = (ROOT / "docs" / "sql" / "rollback_0127_series_plan_caps.sql").read_text(encoding="utf-8")

REQ = "create or replace function public.request_series_plan("
BEFORE = "e38342a6c8511d5eadb1f99ab38fb6aa"
SIG = "public.request_series_plan(text, text, integer, text, integer, text, text, text)"


def code(sql: str) -> str:
    return "\n".join(line.split("--", 1)[0] for line in sql.splitlines())


def body(sql: str, start: str) -> str:
    i = sql.index(start)
    a = sql.index("$$", i) + 2
    return sql[a:sql.index("$$", a)]


def h(b: str) -> str:
    return hashlib.md5(re.sub(r"\s+", " ", b).encode()).hexdigest()


def added_lines(old: str, new: str):
    """The lines of ``new`` that are not, in order, lines of ``old`` (a pure-addition diff); raises if anything of ``old`` was changed."""
    o, n = old.splitlines(), new.splitlines()
    out, i = [], 0
    for line in n:
        if i < len(o) and line == o[i]:
            i += 1
        else:
            out.append(line)
    assert i == len(o), f"line {i + 1} of the old body was changed or removed: {o[i]!r}"
    return out


AFTER = h(body(TEXT, REQ))
GUARD = h(body(TEXT, "create or replace function public.series_plan_cap_settings_guard()"))
TRAIL = h(body(TEXT, "create or replace function public.series_plan_cap_settings_trail()"))


class Numbering(unittest.TestCase):
    def test_the_number_is_unique_and_after_everything_that_was_merged_first(self):
        numbers = sorted(p.name[:4] for p in MIG.glob("*.sql"))
        self.assertEqual(numbers.count("0127"), 1)
        for earlier in ("0122", "0124", "0125", "0126"):
            self.assertIn(earlier, numbers)
        self.assertEqual([n for n in numbers if n > "0127"], [], "0127 is the highest: a later number needs its own review of this file's pins")

    def test_the_rollback_exists_and_is_one_transaction(self):
        self.assertRegex(ROLLBACK, r"(?m)^begin;$")
        self.assertEqual(len(re.findall(r"(?m)^commit;$", ROLLBACK)), 1)

    def test_the_file_says_it_is_applied_as_one_transaction_and_names_the_hashes_to_verify(self):
        self.assertIn("APPLY AS ONE TRANSACTION", TEXT)
        self.assertIn("WHAT TO VERIFY BEFORE YOU APPLY", TEXT)
        self.assertIn("set local lock_timeout", code(TEXT))


class Hashes(unittest.TestCase):
    def test_0122s_function_hashes_to_the_before_value_and_the_file_carries_it(self):
        self.assertEqual(h(body(M0122, REQ)), BEFORE)
        self.assertEqual(TEXT.count(BEFORE), 2, "the header and the drift guard (the end state pins the AFTER value)")
        self.assertIn(BEFORE, ROLLBACK)

    def test_the_header_the_guard_the_end_state_and_the_rollback_all_name_the_after_values(self):
        self.assertEqual(len(AFTER), 32)
        self.assertEqual(TEXT.count(AFTER), 3, "the header, the drift guard and the end state")
        for value in (GUARD, TRAIL):
            self.assertGreaterEqual(TEXT.count(value), 3)
        self.assertIn(AFTER, ROLLBACK)
        self.assertEqual(len({BEFORE, AFTER, GUARD, TRAIL}), 4)

    def test_the_drift_guard_accepts_exactly_the_old_and_the_new_body(self):
        self.assertIn(f"r <> all (array['{BEFORE}', '{AFTER}'])", TEXT)
        self.assertIn(f"gd <> '{GUARD}'", TEXT)
        self.assertIn(f"tr <> '{TRAIL}'", TEXT)
        self.assertIn(f"<> '{AFTER}'", code(TEXT[TEXT.index("4. The end state"):]))

    def test_the_hash_is_of_the_body_with_white_space_collapsed_as_the_file_says(self):
        self.assertIn("md5(regexp_replace(p.prosrc, '\\s+', ' ', 'g'))", TEXT)
        self.assertIn("md5(regexp_replace(prosrc, '\\s+', ' ', 'g'))", ROLLBACK)


class ReplacedBody(unittest.TestCase):
    old, new = body(M0122, REQ), body(TEXT, REQ)

    def test_it_is_0122s_body_plus_added_lines_only(self):
        added = added_lines(self.old, self.new)
        self.assertGreater(len(added), 10)
        text = "\n".join(added)
        self.assertGreaterEqual(text.count("-- 0127"), 2, "each added block is marked")
        for needle in ("perform pg_advisory_xact_lock(hashtextextended('series_plan_global', 0));",
                       "from public.series_plan_cap_settings s;",
                       "v_ucap := coalesce(v_ucap, 3);", "v_gcap := coalesce(v_gcap, 30);",
                       "where requested_by = uid and created_at > now() - interval '24 hours') >= v_ucap then",
                       "where created_at > now() - interval '24 hours') >= v_gcap then",
                       "raise exception 'series_user_cap' using errcode = 'NS429', detail = format('limit=%s per 24 hours', v_ucap);",
                       "raise exception 'series_global_cap' using errcode = 'NS429';"):
            self.assertIn(needle, text)

    def test_the_platforms_refusal_carries_no_detail_and_no_refusal_carries_vendor_text(self):
        added = "\n".join(added_lines(self.old, self.new))
        self.assertNotIn("detail", added[added.index("'series_global_cap'"):added.index("'series_global_cap'") + 80])
        for word in ("gemini", "openai", "google", "vendor", "quota exceeded"):
            self.assertNotIn(word, code(added).lower())

    def test_the_locks_are_in_the_order_organization_then_platform_after_the_replay_and_before_the_insert(self):
        n = self.new
        org = n.index("hashtextextended('series_plan:' || v_org::text, 0)")
        replay = n.index("'replayed', true")
        org_cap = n.index("'rate_limited'")
        platform = n.index("hashtextextended('series_plan_global'")
        read = n.index("from public.series_plan_cap_settings s;")
        user_check = n.index("'series_user_cap'")
        global_check = n.index("'series_global_cap'")
        insert = n.index("insert into public.series_plans")
        self.assertLess(org, replay, "0120's lock first")
        self.assertLess(replay, org_cap, "a replay is answered before any cap")
        self.assertLess(org_cap, platform, "the organization is checked before the platform lock is taken")
        self.assertNotIn("series_plan_user", n, "one platform lock covers both counts; a lock per person would be dead weight")
        self.assertLess(platform, read, "the numbers are read under the locks")
        self.assertLess(read, user_check)
        self.assertLess(user_check, global_check, "the person before the platform")
        self.assertLess(global_check, insert, "a refusal comes before anything is written")

    def test_the_signature_and_the_header_are_0122s(self):
        head = TEXT[TEXT.index(REQ):TEXT.index(REQ) + 400]
        old_head = M0122[M0122.index(REQ):M0122.index(REQ) + 400]
        self.assertEqual(head[:head.index("$$")], old_head[:old_head.index("$$")])
        self.assertIn("language plpgsql volatile security definer set search_path = public, pg_temp as $$", head)

    def test_it_counts_the_plan_rows_and_nothing_a_client_sends(self):
        added = "\n".join(added_lines(self.old, self.new))
        self.assertNotRegex(code(added), r"\bp_[a-z]", "no argument of the call is read by the caps")
        self.assertNotRegex(code(added).lower(), r"\b(insert|update|delete)\b", "the caps only read")
        self.assertIn("requested_by = uid", added)


class Dormant(unittest.TestCase):
    def test_no_migration_grants_request_series_plan(self):
        offenders = []
        for p in sorted(MIG.glob("*.sql")):
            if re.search(r"(?is)grant\s+execute\s+on\s+function\s+public\.request_series_plan", code(p.read_text(encoding="utf-8")).replace("revoke", "rv")):
                offenders.append(p.name)
        self.assertEqual(offenders, [])

    def test_the_file_revokes_it_and_refuses_to_run_when_it_is_executable(self):
        c = code(TEXT)
        self.assertIn(f"revoke all on function {SIG} from public, anon, authenticated, service_role;", c)
        self.assertEqual(c.count("executable by public or by an API role"), 1)
        self.assertEqual(c.count("executable by public or an API role"), 1, "and the end state asserts it again")
        self.assertIn("p.proacl is null", c, "a NULL ACL is the default, and the default includes public")

    def test_the_rollback_refuses_while_it_is_granted(self):
        self.assertIn("executable by public or an API role", code(ROLLBACK))
        self.assertIn("p.proacl is null", code(ROLLBACK))

    def test_the_table_is_closed_to_every_api_role(self):
        c = code(TEXT)
        self.assertIn("alter table public.series_plan_cap_settings enable row level security;", c)
        self.assertIn("revoke all on public.series_plan_cap_settings from public, anon, authenticated, service_role;", c)
        self.assertNotRegex(c, r"(?i)create\s+policy")
        self.assertNotRegex(c, r"(?i)grant\s+\w+\s+on\s+(table\s+)?public\.series_plan_cap_settings")
        for fn in ("series_plan_cap_settings_guard", "series_plan_cap_settings_trail"):
            self.assertIn(f"revoke all on function public.{fn}() from public, anon, authenticated, service_role;", c)

    def test_the_defaults_are_three_and_thirty_everywhere_they_are_written(self):
        c = code(TEXT)
        self.assertIn("user_daily_cap   integer not null default 3,", c)
        self.assertIn("global_daily_cap integer not null default 30,", c)
        self.assertIn("v_ucap := coalesce(v_ucap, 3);", c)
        self.assertIn("v_gcap := coalesce(v_gcap, 30);", c)
        self.assertIn("on conflict (id) do nothing", c, "a replay never undoes what the owner set")

    def test_it_touches_no_other_function_table_or_row(self):
        c = code(TEXT).lower()
        self.assertEqual(sorted(set(re.findall(r"create or replace function (public\.\w+)", c))),
                         ["public.request_series_plan", "public.series_plan_cap_settings_guard", "public.series_plan_cap_settings_trail"])
        self.assertEqual(re.findall(r"create table (?:if not exists )?(public\.\w+)", c), ["public.series_plan_cap_settings"])
        self.assertNotRegex(c, r"\balter table public\.(?!series_plan_cap_settings)")
        outside = c.replace(code(body(TEXT, REQ)).lower(), "")      # the request function writes plans, as it did; everything else in the file does not
        self.assertNotRegex(outside, r"\b(update|delete from|truncate)\s+public\.")
        self.assertEqual(re.findall(r"insert into (public\.\w+)", outside), ["public.series_plan_cap_settings"])


class Rollback(unittest.TestCase):
    def test_it_restores_0122s_function_byte_for_byte(self):
        old = M0122[M0122.index(REQ):M0122.index("\n$$;\n", M0122.index(REQ)) + len("\n$$;\n")].rstrip("\n")
        self.assertIn(old, ROLLBACK)
        self.assertEqual(h(body(ROLLBACK, REQ)), BEFORE)

    def test_it_drops_exactly_what_the_file_added_and_is_ordered_before_0122s_rollback(self):
        c = code(ROLLBACK)
        for stmt in ("drop function if exists public.series_plan_cap_settings_trail();", "drop function if exists public.series_plan_cap_settings_guard();",
                     "drop table if exists public.series_plan_cap_settings;"):
            self.assertIn(stmt, c)
        self.assertIn("BEFORE docs/sql/rollback_0122_series_template_carrier.sql", ROLLBACK)
        self.assertNotRegex(c.lower(), r"\bdelete from public\.series_plans\b")


class Documented(unittest.TestCase):
    def read(self, rel):
        return (ROOT / rel).read_text(encoding="utf-8")

    def test_the_docs_say_the_caps_exist_with_the_defaults_and_what_the_owner_must_still_do(self):
        doc = re.sub(r"\s+", " ", self.read("docs/SERIES_FACTORY.md"))
        for needle in ("## Plan caps (migration 0127", "series_plan_cap_settings", "series_user_cap", "series_global_cap",
                       "What the owner must do before granting `request_series_plan`", "**3** |", "**30** |",
                       "F4: the cap is per organization, and one account can have many organizations. MET by migration 0127"):
            self.assertIn(needle, doc)
        self.assertIn("0127_series_plan_caps", self.read("docs/MIGRATIONS.md"))

    def test_the_env_comment_says_the_caps_exist_and_that_nothing_is_granted(self):
        example = self.read("deploy/.env.worker.example")
        block = example[example.index("# [var] Series planning"):example.index("NIGHTSHIFT_SERIES_PLANNER=")]
        flat = re.sub(r"\s*#\s*|\s+", " ", block)
        self.assertIn("3 per PERSON and 30 for ALL organizations", flat)
        self.assertIn("5 per organization", flat)
        self.assertIn("only when request_series_plan is granted", flat)

    def test_the_command_center_maps_both_words_in_every_language(self):
        ts = self.read("command-center/lib/seriesPlan.ts")
        self.assertIn('series_user_cap: "series_user_cap",', ts)
        self.assertIn('series_global_cap: "series_global_cap",', ts)
        for loc in ("en", "ru", "uz"):
            t = self.read(f"command-center/lib/i18n/series-plan/{loc}.ts")
            self.assertEqual(len(re.findall(r"^\s+series_user_cap: \"", t, re.M)), 1, loc)
            self.assertEqual(len(re.findall(r"^\s+series_global_cap: \"", t, re.M)), 1, loc)


if __name__ == "__main__":
    unittest.main()

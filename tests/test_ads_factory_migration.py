"""Migration 0131 (Ads Factory, Phase 1), pinned from the file: what the security lab cannot see by running it.

* every function body hashes to the value the file's drift guard, its end state and the rollback name (and the three lists agree);
* it replaces nothing and touches no object it did not add: no `create or replace function` of an older name, no `alter table` of an
  older table, no grant on anything but its own objects, nothing granted to anon or service_role but SELECT on the content tables;
* the grants are exactly the ten member functions to `authenticated`, and every SECURITY DEFINER function pins its search_path;
* the closed lists, the lengths, the site-address shape and the invisible-character class in the SQL are the ones the Command Center
  checks first (lib/adsFactory/model.ts), so the form and the database cannot disagree about what is allowed;
* the caps' defaults are 5 / 20 / 20 / 24 wherever they are written (the table, the fall-backs, the header, the docs);
* nothing in it fetches, calls a model, touches credits, jobs or publishing;
* the rollback is one transaction, drops exactly what was added, refuses while rows exist, and the docs name all of it.
"""

import hashlib
import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MIG = ROOT / "supabase" / "migrations"
FILE = MIG / "0131_ads_factory.sql"
TEXT = FILE.read_text(encoding="utf-8")
ROLLBACK = (ROOT / "docs" / "sql" / "rollback_0131_ads_factory.sql").read_text(encoding="utf-8")
MODEL = (ROOT / "command-center" / "lib" / "adsFactory" / "model.ts").read_text(encoding="utf-8")

TABLES = ["brand_kits", "brand_products", "brand_product_images", "ad_campaigns", "ad_campaign_products", "ad_concepts", "ads_factory_cap_settings"]
CONTENT = TABLES[:-1]
MEMBER = {
    "save_brand_kit": "uuid, uuid, text, text, uuid, text[], text[], text",
    "delete_brand_kit": "uuid",
    "save_brand_product": "uuid, uuid, text, text, text, uuid[]",
    "delete_brand_product": "uuid",
    "save_ad_campaign": "uuid, uuid, text, text, text, text[], text[], uuid[]",
    "delete_ad_campaign": "uuid",
    "add_ad_concepts": "uuid, text, jsonb",
    "update_ad_concept": "uuid, text, text, text, text, jsonb",
    "set_ad_concept_status": "uuid, text",
    "delete_ad_concept": "uuid",
}
INTERNAL = {
    "ads_clean_text": "text, boolean",
    "ads_text_ok": "text, integer, integer, boolean",
    "ads_text_list_ok": "text[], integer, integer",
    "ads_palette_ok": "text[]",
    "ads_closed_list_ok": "text[], text[], integer, integer",
    "ads_site_url_ok": "text",
    "ads_storyboard_ok": "jsonb",
    "ads_check_images": "uuid, uuid[], integer",
    "ads_asset_guard": "",
    "ad_concepts_guard": "",
    "ads_factory_cap_settings_guard": "",
    "ads_factory_cap_settings_trail": "",
}
ALL = {**MEMBER, **INTERNAL}


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


GUARD = pins(TEXT, "A function of one of this file's names that already exists", "-- 1. Text and list rules")
END = pins(TEXT, "-- 10. The end state", "-- Verify (run as the SQL editor")
RB = pins(ROLLBACK, "begin;", "-- 1. The functions a member could call.")


class Numbering(unittest.TestCase):
    def test_the_number_is_unique_and_after_everything_merged_first(self):
        numbers = sorted(p.name[:4] for p in MIG.glob("*.sql"))
        self.assertEqual(numbers.count("0131"), 1)
        self.assertIn("0128", numbers)
        # 0129 (#661) and 0130 (#652) are open pull requests that may merge before or after this file: 0131 names nothing they add.
        self.assertEqual([n for n in numbers if n > "0131"], [], "a later number needs its own review of this file's pins")

    def test_the_file_says_it_is_applied_as_one_transaction_and_what_to_verify(self):
        self.assertIn("APPLY AS ONE TRANSACTION", TEXT)
        self.assertIn("WHAT TO VERIFY BEFORE YOU APPLY", TEXT)
        self.assertIn("set local lock_timeout", code(TEXT))
        self.assertIn("LIVE ON APPLY", TEXT)

    def test_the_rollback_is_one_transaction(self):
        self.assertRegex(ROLLBACK, r"(?m)^begin;$")
        self.assertEqual(len(re.findall(r"(?m)^commit;$", ROLLBACK)), 1)


class Hashes(unittest.TestCase):
    def test_every_function_is_pinned_in_the_guard_the_end_state_and_the_rollback_with_its_real_hash(self):
        want = {name: h(body(TEXT, name)) for name in ALL}
        self.assertEqual(GUARD, want)
        self.assertEqual(END, want)
        self.assertEqual(RB, want)
        self.assertEqual(len(set(want.values())), len(want), "two functions with the same body would make a pin meaningless")

    def test_the_hash_is_of_the_body_with_white_space_collapsed(self):
        self.assertEqual(code(TEXT).count("md5(regexp_replace(p.prosrc, '\\s+', ' ', 'g'))"), 2)
        self.assertIn("md5(regexp_replace(prosrc, '\\s+', ' ', 'g'))", ROLLBACK)

    def test_the_end_state_names_the_signatures_of_the_functions_it_creates(self):
        for name, args in ALL.items():
            self.assertIn(f"('public.{name}({args})', '", TEXT, name)
            self.assertIn(f"('public.{name}({args})', '", ROLLBACK, name)

    def test_no_source_line_carries_a_literal_invisible_character(self):
        # A zero-width or bidi character typed into SQL is unreviewable and would change the hash without a visible change.
        for name, text in (("migration", TEXT), ("rollback", ROLLBACK), ("model.ts", MODEL)):
            self.assertIsNone(re.search("[­​-‏ -‮⁠-⁩﻿]", text), name)


class Scope(unittest.TestCase):
    c = code(TEXT).lower()

    def test_it_creates_exactly_its_own_functions_and_tables(self):
        self.assertEqual(sorted(set(re.findall(r"create or replace function public\.(\w+)\(", self.c))), sorted(ALL))
        self.assertEqual(sorted(re.findall(r"create table if not exists public\.(\w+)", self.c)), sorted(TABLES))

    def test_it_alters_drops_and_writes_no_older_object(self):
        for m in re.findall(r"alter table public\.(\w+)", self.c):
            self.assertIn(m, TABLES)
        self.assertNotRegex(self.c, r"\bdrop (table|function|policy on|column)\b(?! if exists \w+ on public\.(?:%s))" % "|".join(TABLES))
        for m in re.findall(r"drop (?:trigger|policy) if exists \w+ on public\.(\w+)", self.c):
            self.assertIn(m, TABLES)
        for m in re.findall(r"\b(?:insert into|update|delete from) public\.(\w+)", self.c):
            self.assertIn(m, TABLES)

    def test_it_names_no_credit_job_publish_or_provider_object(self):
        for word in ("credit", "reserve_", "capture_", "render_jobs", "creative_jobs", "publish", "series_plan", "channels", "videos",
                     "http", "net.", "pg_net", "dblink", "copy ", "lo_import", "vault"):
            # The site address's shape check and its comment say "https"; everything else may not name the web at all.
            self.assertNotIn(word, re.sub(r"https://|'https?:|xn--|a note: https", "", self.c), word)

    def test_it_reads_only_the_objects_0018_0038_and_0107_provide(self):
        older = set(re.findall(r"public\.(\w+)", self.c)) - set(TABLES) - set(ALL)
        self.assertEqual(sorted(older), sorted({"organizations", "media_assets", "is_org_member", "accessible_org_ids", "security_event_log"}))


class Grants(unittest.TestCase):
    c = code(TEXT)

    def test_execute_goes_to_authenticated_on_the_ten_member_functions_and_nothing_else(self):
        grants = re.findall(r"grant execute on function public\.(\w+)\(([^)]*)\) to (\w+);", self.c)
        self.assertEqual(sorted((n, a, r) for n, a, r in grants), sorted((n, a, "authenticated") for n, a in MEMBER.items()))

    def test_every_function_is_revoked_from_every_role_first(self):
        for name, args in ALL.items():
            self.assertIn(f"revoke all on function public.{name}({args}) from public, anon, authenticated, service_role;", self.c, name)

    def test_tables_are_revoked_then_granted_select_only_and_never_to_anon(self):
        self.assertEqual(re.findall(r"grant (\w+) on ", self.c.replace("grant execute", "")), ["select"])
        grant = self.c[self.c.index("grant select on public.brand_kits"):]
        grant = grant[:grant.index(";")]
        self.assertTrue(grant.endswith("to authenticated, service_role"))
        self.assertNotIn("ads_factory_cap_settings", grant)
        for t in CONTENT:
            self.assertIn(f"public.{t}", grant)
        revoke = self.c[self.c.index("revoke all on public.brand_kits"):]
        revoke = revoke[:revoke.index(";")]
        for t in TABLES:
            self.assertIn(f"public.{t}", revoke)
        self.assertTrue(revoke.endswith("from public, anon, authenticated, service_role"))

    def test_every_table_has_rls_and_the_content_tables_one_select_policy_for_authenticated(self):
        for t in TABLES:
            self.assertIn(f"alter table public.{t} enable row level security;", self.c)
        policies = re.findall(r"create policy (\w+) on public\.(\w+)\s+for (\w+) to (\w+)\s+using \(([^;]+)\);", self.c)
        self.assertEqual(sorted(p[1] for p in policies), sorted(CONTENT))
        for name, table, cmd, role, using in policies:
            self.assertEqual((name, cmd, role), (f"{table}_select", "select", "authenticated"))
            self.assertEqual(using.strip(), "org_id in (select public.accessible_org_ids('viewer'))")

    def test_every_definer_pins_its_search_path(self):
        for m in re.finditer(r"create or replace function public\.(\w+)\(.*?\$\$", self.c, re.S):
            head = m.group(0)
            self.assertIn("set search_path = public, pg_temp", head, m.group(1))

    def test_every_member_function_checks_the_caller_first_and_the_editor_role(self):
        for name in MEMBER:
            b = code(body(TEXT, name))
            self.assertLess(b.index("auth.uid() is null"), b.index("raise exception 'not_found'") if "'not_found'" in b else len(b), name)
            self.assertIn("'editor')", b, name)
            self.assertIn("raise exception 'not_found' using errcode = 'P0002'", b, name)


class AgreesWithTheCommandCenter(unittest.TestCase):
    def ts_list(self, name: str) -> list:
        m = re.search(rf"export const {name} = \[([^\]]*)\] as const;", MODEL)
        return re.findall(r'"([^"]+)"', m.group(1))

    def test_the_closed_lists(self):
        c = code(TEXT)
        self.assertEqual(self.ts_list("AD_OBJECTIVES"), ["awareness", "traffic", "sales", "launch", "offer"])
        self.assertEqual(self.ts_list("AD_LANGUAGES"), ["en", "ru", "uz"])
        self.assertEqual(self.ts_list("AD_DIRECTIONS"), ["spotlight", "editorial", "minimal", "lifestyle", "bold"])
        self.assertEqual(re.findall(r'\{ id: "([^"]+)"', MODEL), ["1:1", "4:5", "9:16", "16:9"])
        self.assertEqual(c.count("objective in ('awareness', 'traffic', 'sales', 'launch', 'offer')"), 1)
        self.assertEqual(c.count("p_objective not in ('awareness', 'traffic', 'sales', 'launch', 'offer')"), 1)
        self.assertEqual(c.count("array['1:1', '4:5', '9:16', '16:9']"), 2)
        self.assertEqual(c.count("format in ('1:1', '4:5', '9:16', '16:9')"), 1)
        self.assertEqual(c.count("array['spotlight', 'editorial', 'minimal', 'lifestyle', 'bold']"), 2)
        self.assertEqual(c.count("direction in ('spotlight', 'editorial', 'minimal', 'lifestyle', 'bold')"), 1)
        self.assertEqual(c.count("('en', 'ru', 'uz')"), 2)
        self.assertIn("status in ('draft', 'approved', 'archived')", c)
        self.assertIn("kind in ('image', 'video')", c)
        self.assertEqual(self.ts_list("AD_STATUSES"), ["draft", "approved", "archived"])
        self.assertEqual(self.ts_list("AD_KINDS"), ["image", "video"])

    def test_the_site_address_shape_is_the_same_expression(self):
        ts = re.search(r"SITE_URL_PATTERN = String\.raw`([^`]+)`", MODEL).group(1)
        sql = re.search(r"p_url ~ '([^']+)'", TEXT).group(1)       # not code(): the pattern itself contains "xn--"
        self.assertEqual(ts, sql)

    def test_the_invisible_characters_are_the_same_class(self):
        sql = "[\\x01-\\x1f\\x7f-\\x9f\\u00ad\\u200b-\\u200f\\u2028-\\u202e\\u2060-\\u2064\\u2066-\\u2069\\ufeff]"
        self.assertEqual(code(TEXT).count(f"'{sql}'"), 2, "single-line class in ads_clean_text and ads_text_ok")
        ranges = re.findall(r"\[0x([0-9a-f]+), 0x([0-9a-f]+)\]", MODEL)
        self.assertEqual([(int(a, 16), int(b, 16)) for a, b in ranges],
                         [(0x01, 0x1F), (0x7F, 0x9F), (0xAD, 0xAD), (0x200B, 0x200F), (0x2028, 0x202E), (0x2060, 0x2064), (0x2066, 0x2069), (0xFEFF, 0xFEFF)])

    def test_the_lengths(self):
        limits = dict(re.findall(r"^\s+(\w+): (\d+),$", MODEL[MODEL.index("export const ADS_LIMITS"):MODEL.index("} as const;", MODEL.index("export const ADS_LIMITS"))], re.M))
        c = code(TEXT)
        checks = {
            "kitName": "ads_text_ok(name, 1, {}, false)", "voice": "ads_text_ok(voice_notes, 0, {}, true)",
            "productTitle": "ads_text_ok(title, 1, {}, false)", "productDescription": "ads_text_ok(description, 0, {}, true)",
            "price": "ads_text_ok(price_text, 0, {}, false)", "headline": "ads_text_ok(headline, 1, {}, false)",
            "body": "ads_text_ok(body, 0, {}, true)", "cta": "ads_text_ok(cta, 0, {}, false)", "brief": "ads_text_ok(visual_brief, 0, {}, true)",
            "beatVisual": "ads_text_ok(b ->> 'visual', 1, {}, false)", "beatLine": "ads_text_ok(b ->> 'line', 0, {}, false)",
            "fonts": "ads_text_list_ok(fonts, {}, 60)", "fontName": "ads_text_list_ok(fonts, 4, {})",
            "productImages": "position between 0 and {}", "campaignProducts": "position between 0 and {}",
        }
        for key, pattern in checks.items():
            n = int(limits[key]) - (1 if pattern.startswith("position") else 0)
            self.assertIn(pattern.format(n), c, key)
        self.assertIn(f"<= {limits['palette']}", code(body(TEXT, "ads_palette_ok")))
        self.assertIn(f"between 1 and {limits['beats']}", code(body(TEXT, "ads_storyboard_ok")))
        self.assertIn(f"between 1 and {limits['conceptsPerAdd']}", code(body(TEXT, "add_ad_concepts")))
        self.assertIn(f"'bold'], 1, {limits['campaignDirections']})", c)
        self.assertEqual(limits["siteUrl"], "300")
        self.assertIn("between 12 and 300", c)


class Caps(unittest.TestCase):
    def test_the_defaults_are_five_twenty_twenty_and_twenty_four_everywhere(self):
        c = code(TEXT)
        for col, n in (("kits_per_org", 5), ("products_per_kit", 20), ("campaigns_per_org", 20), ("concepts_per_campaign", 24)):
            self.assertRegex(c, rf"{col}\s+integer not null default {n},?", col)
        for fn, n in (("save_brand_kit", 5), ("save_brand_product", 20), ("save_ad_campaign", 20), ("add_ad_concepts", 24)):
            self.assertIn(f"v_cap := coalesce(v_cap, {n});", code(body(TEXT, fn)), fn)
        self.assertIn("on conflict (id) do nothing", c, "a replay never undoes what the owner set")
        doc = (ROOT / "docs" / "ADS_FACTORY.md").read_text(encoding="utf-8")
        for row in ("| `kits_per_org` | **5** |", "| `products_per_kit` | **20** |", "| `campaigns_per_org` | **20** |", "**24**"):
            self.assertIn(row, doc)

    def test_every_cap_is_counted_under_the_organization_lock_and_refused_with_its_number(self):
        for fn in ("save_brand_kit", "save_brand_product", "save_ad_campaign", "add_ad_concepts"):
            b = code(body(TEXT, fn))
            lock = b.index("pg_advisory_xact_lock(hashtextextended('ads_factory:' ||")
            read = b.index("from public.ads_factory_cap_settings s")
            refuse = b.index("raise exception 'limit_reached' using errcode = 'NS429'")
            write = b.index("insert into public.")
            self.assertLess(lock, read, fn)
            self.assertLess(read, refuse, fn)
            self.assertLess(refuse, write, fn)
            self.assertIn("format('max=%s", b[refuse:refuse + 140], fn)

    def test_a_replay_of_a_press_is_answered_before_the_cap(self):
        b = code(body(TEXT, "add_ad_concepts"))
        self.assertLess(b.index("'replayed', true"), b.index("'limit_reached'"))

    def test_the_settings_are_closed_and_trailed(self):
        c = code(TEXT)
        self.assertIn("'ads.factory.caps'", c)
        self.assertNotRegex(c, r"create policy \w+ on public\.ads_factory_cap_settings")
        self.assertIn("raise exception 'ads_factory_cap_settings keeps its one row'", c)


class Rollback(unittest.TestCase):
    c = code(ROLLBACK)

    def test_it_drops_exactly_what_the_file_added_without_cascade(self):
        self.assertEqual(sorted(re.findall(r"drop table if exists public\.(\w+);", self.c)), sorted(TABLES))
        self.assertEqual(sorted(re.findall(r"drop function if exists public\.(\w+)\(", self.c)), sorted(ALL))
        self.assertNotIn("cascade", self.c.lower())

    def test_it_refuses_while_rows_exist_unless_told_they_may_go(self):
        self.assertIn("nightshift.ads_rollback_delete_rows", self.c)
        self.assertIn("<> 'yes'", self.c)

    def test_it_refuses_a_body_that_is_not_0131s(self):
        self.assertIn("is not 0131''s body", self.c)


class Documented(unittest.TestCase):
    def test_the_docs_name_the_migration_the_rollback_the_switch_and_what_is_not_built(self):
        doc = (ROOT / "docs" / "ADS_FACTORY.md").read_text(encoding="utf-8")
        for needle in ("0131_ads_factory.sql", "rollback_0131_ads_factory.sql", "NIGHTSHIFT_ADS_FACTORY", "## What is NOT built",
                       "## Phase 2", "## Phase 3", "## Phase 4", "## Phase 5", "## Phase 6", "Strings that need a native read", "#651"):
            self.assertIn(needle, doc)
        self.assertIn("0131_ads_factory", (ROOT / "docs" / "MIGRATIONS.md").read_text(encoding="utf-8"))


if __name__ == "__main__":
    unittest.main()

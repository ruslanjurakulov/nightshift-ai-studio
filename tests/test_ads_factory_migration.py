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
import json
import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MIG = ROOT / "supabase" / "migrations"
FILE = MIG / "0131_ads_factory.sql"
TEXT = FILE.read_text(encoding="utf-8")
ROLLBACK = (ROOT / "docs" / "sql" / "rollback_0131_ads_factory.sql").read_text(encoding="utf-8")
MODEL = (ROOT / "command-center" / "lib" / "adsFactory" / "model.ts").read_text(encoding="utf-8")
INBOX = json.loads((ROOT / "tests" / "fixtures" / "inbox_cleaner_cases.txt").read_text(encoding="utf-8"))


def ts_ranges(name: str) -> list:
    block = MODEL[MODEL.index(f"const {name}: "):]
    block = block[:block.index("];")]
    return [(int(a, 16), int(b, 16)) for a, b in re.findall(r"\[0x([0-9a-f]+), 0x([0-9a-f]+)\]", block)]


def sql_char(cp: int) -> str:
    if cp < 0xA0:
        return "\\x%02x" % cp
    return ("\\u%04x" % cp) if cp <= 0xFFFF else ("\\U%08x" % cp)


def sql_range(lo: int, hi: int) -> str:
    return sql_char(lo) if lo == hi else f"{sql_char(lo)}-{sql_char(hi)}"


# The ads class: every range removed (single-line; the multi-line class keeps U+000A) and the blank-looking spaces read as one space.
INVISIBLE = [(0x01, 0x1F), (0x7F, 0x9F), (0xAD, 0xAD), (0x34F, 0x34F), (0x61C, 0x61C), (0x115F, 0x115F), (0x1160, 0x1160), (0x17B4, 0x17B4),
             (0x17B5, 0x17B5), (0x180B, 0x180F), (0x200B, 0x200F), (0x2028, 0x202E), (0x2060, 0x206F), (0x2800, 0x2800), (0x3164, 0x3164), (0xFE00, 0xFE0F), (0xFEFF, 0xFEFF),
             (0xFFA0, 0xFFA0), (0xFFF0, 0xFFFB), (0x13430, 0x1343F), (0x1BCA0, 0x1BCA3), (0x1D173, 0x1D17A), (0xE0000, 0xE0FFF)]
SPACES = [(0xA0, 0xA0), (0x1680, 0x1680), (0x2000, 0x200A), (0x202F, 0x202F), (0x205F, 0x205F), (0x3000, 0x3000)]

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
        for earlier in ("0128", "0129", "0130"):
            self.assertIn(earlier, numbers)
        # 0129 (#661) and 0130 (#652) are merged before this file: 0131 names nothing they add, so it applies after them or without them.
        # 0132 (1440p and 4K editor exports, sold by the minute) was reviewed against these pins: it touches the video editor's export
        # table and functions and the credit helpers of 0020 / 0036 only, and replaces or alters nothing of 0131's.
        # 0133 (the brand scan, Phase 2) was reviewed against these pins: it replaces none of 0131's functions and alters none of its
        # tables (tests/test_brand_scan_migration.py pins that), and 0131's rollback must wait for 0133's (its checks use 0131's rules).
        # 0136 (exports up to 1080p sold by the minute) was reviewed the same way: the video editor's export functions and 0132's price row
        # only; it replaces or alters nothing of 0131's.
        # 0137 (Character Studio) was reviewed against these pins: it names no object of 0131 (tests/test_character_studio_migration.py
        # checks that it names no brand_*, ad_* or ads_* object), so it applies with or without 0131 and 0131's rollback does not wait for it.
        # 0134 (the brand scan's follow-up) replaces one of 0133's functions and none of 0131's, and alters no table; it reads 0131's tables.
        # 0138 (the operator's Customers page) was reviewed the same way: three read-only functions over the credit ledger, the
        # workspaces and the generations; it reads, replaces and alters nothing of 0131's.
        # 0139 (the operator preview of a hidden model) was reviewed the same way: it replaces creative_price on 0125's body and adds two
        # model-registry functions; it reads, replaces and alters nothing of 0131's.
        # 0145 (YouTube's "made for kids") was reviewed the same way: videos columns, one function, the run params validator and the
        # audit list; nothing of 0131's.
        # 0142 (a model with blocked_countries cannot be beta or ga) was reviewed the same way: one CHECK on model_registry; it reads,
        # replaces and alters nothing of 0131's.
        # 0143 (the probe log's vendor_tool_unsupported word) was reviewed the same way: it replaces one check constraint on
        # model_probe_runs and nothing else; it reads, replaces and alters nothing of 0131's.
        # 0146 (Dodo Payments next to Paddle) was reviewed the same way: the payment tables' provider checks and the two subscription
        # functions of 0034 only; it reads, replaces and alters nothing of 0131's.
        # 0147 (MCP over OAuth on every plan, the OAuth rate credit and registration classes, the API key's spend-limit sentences) was
        # reviewed the same way: 0093's and 0042's functions, one new table, one column on oauth_clients; nothing of 0131's.
        # 0149 (an operator preview priced by resolution) was reviewed the same way: it replaces creative_price on 0139's body and
        # nothing else; it reads, replaces and alters nothing of 0131's.
        # 0151 (the Studio's progress seed: one read-only function over model_registry and model_probe_runs) was reviewed the same
        # way: it reads, replaces and alters nothing of 0131's.
        # 0152 (the probe log's vendor_credits) was reviewed the same way: one column on model_probe_runs and an eleven-argument
        # record_model_probe overload; it reads, replaces and alters nothing of 0131's.
        # 0153 (an operator preview priced by quality) was reviewed the same way: it replaces creative_price on 0149's body and
        # nothing else; it reads, replaces and alters nothing of 0131's.
        # 0155 (a quote refuses a shape the model does not list) was reviewed the same way: it replaces creative_price on 0153's
        # body and nothing else; it reads, replaces and alters nothing of 0131's.
        # 0156 (a model's own resolution names) was reviewed the same way: it replaces creative_params_problem on 0126's body and
        # creative_price on 0155's, nothing else; it reads, replaces and alters nothing of 0131's.
        # 0157 (the Credits page's Dodo purchase history: one read-only function over payment_events and dodo_checkout_nonces) was
        # reviewed the same way: it reads, replaces and alters nothing of 0131's.
        # 0158 (the concept-thumbnail settings are an administrator's: channel_admin_controls and one trigger on channels) was
        # reviewed the same way: it reads, replaces and alters nothing of 0131's.
        # 0159 (a quote refuses a clip length the model does not list) was reviewed the same way: it replaces creative_price on
        # 0156's body and nothing else; it reads, replaces and alters nothing of 0131's.
        # 0161 (ChatGPT keeps the client it registered: oauth_gc on 0147's body, one internal helper, one generated column and its index on oauth_clients) was reviewed the same way:
        # it reads, replaces and alters nothing of 0131's.
        # 0162 (two read-only API functions for the MCP Studio tools: api_creative_models, api_creative_job_files) was reviewed the
        # same way: it reads, replaces and alters nothing of 0131's.
        # 0164 (the site's live public counters: site_settings and three new functions that count videos, intents, generations and
        # runs) was reviewed the same way: it reads, replaces and alters nothing of 0131's.
        # 0165 (the referral programme: two tables, eight functions, four earlier bodies with one hunk each) was reviewed the
        # same way: it reads, replaces and alters nothing of 0131's.
        # 0166 (Film Studio P1: five new film tables and their own functions) was reviewed the same way: it reads, replaces and
        # alters nothing of 0131's (its text helpers are its own copies of ads_clean_text and ads_text_ok, so rollback_0131 still
        # drops 0131's freely).
        # 0167 (a refund that met a hold collects when the hold is released: refund_purchased_credits on 0034's body, one table, one
        # trigger on credit_transactions) was reviewed the same way: it reads, replaces and alters nothing of 0131's.
        # 0168 (an API top-up refund that met a hold collects when the hold is released: api_refund_topup on 0031's body, one table,
        # one trigger on api_ledger) was reviewed the same way: it reads, replaces and alters nothing of 0131's.
        # 0170 (api_request_download audits a listed action name: one hunk in 0147's body) was reviewed the same way: it reads,
        # replaces and alters nothing of 0131's.
        # 0171 (Film Studio P2: two new tables, money columns on film_takes, creative_jobs.film_take_id, and its own functions) was
        # reviewed the same way: it reads, replaces and alters nothing of 0131's.
        # 0172 (an owner's grant reversal that met a hold collects when the hold is released: owner_reverse_grant on 0107's
        # body, the lot trigger on 0167's, one table, one trigger on credit_transactions) was reviewed the same way: it reads,
        # replaces and alters nothing of 0131's.
        # 0173 (the seven cleared models on sale) was reviewed the same way: credit_prices rows and model_registry availability /
        # entitlement only, no function, table or grant; it reads, replaces and alters nothing of 0131's.
        # 0174 (rights acknowledgement: two tables, a model_registry column, four functions, two hunks in 0075's create_creative_job)
        # was reviewed the same way: it reads, replaces and alters nothing of 0131's.
        # 0182 (owner analytics: two closed tables, owner-only read functions, one index on dodo_checkout_nonces; names nothing these pin)
        # 0183 (trend templates: one new table and its seed; no function, no bucket; alters no existing object) was
        # reviewed the same way.
        # 0191 (trend templates, second set: 'viral' added to creative_templates' category CHECK and ten seed rows; no
        # function, no grant) was reviewed the same way: it names nothing these pin.
        self.assertEqual([n for n in numbers if n > "0131" and n not in ("0132", "0133", "0134", "0136", "0137", "0138", "0139", "0142", "0143", "0145", "0146", "0147", "0149", "0151", "0152", "0153", "0155", "0156", "0157", "0158", "0159", "0161", "0162", "0164", "0165", "0166", "0167", "0168", "0170", "0171", "0172", "0173", "0174", "0182", "0183", "0191")], [], "a later number needs its own review of this file's pins")
        later = next(MIG.glob("0134_*.sql")).read_text(encoding="utf-8")
        self.assertEqual(re.findall(r"create or replace function public\.(\w+)\(", later), ["brand_scan_fail_locked"])
        self.assertNotRegex(code(later), r"\balter table\b")

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


class Order(unittest.TestCase):
    """What a function does first: the caller is checked before anything they sent is worked on, and the locks are always taken in one
    order (the row FOR NO KEY UPDATE, then the organization's lock, then the writes), so two writers never wait for each other."""

    ORG_LOCK = "pg_advisory_xact_lock(hashtextextended('ads_factory:' ||"

    def test_no_text_is_cleaned_before_sign_in_and_membership_are_checked(self):
        for name in MEMBER:
            b = code(body(TEXT, name))
            if "ads_clean_text(" not in b:
                continue
            first = b.index("ads_clean_text(")
            self.assertGreater(first, b.index("\nbegin\n"), f"{name} cleans in its declarations")
            self.assertGreater(first, b.rindex("'editor')"), f"{name} cleans before the editor check")
            self.assertGreater(first, b.rindex("raise exception 'forbidden'"), name)
        b = code(body(TEXT, "update_ad_concept"))
        self.assertGreater(b.index("ads_clean_text("), b.index("'concept_not_draft'"))

    WRITERS = {"save_brand_kit": "brand_kits", "delete_brand_kit": "brand_kits", "save_brand_product": "brand_products",
               "delete_brand_product": "brand_products", "save_ad_campaign": "ad_campaigns", "delete_ad_campaign": "ad_campaigns"}

    def test_no_row_is_locked_before_the_organization_lock_and_the_row_is_read_again_under_it(self):
        for name, table in self.WRITERS.items():
            b = code(body(TEXT, name))
            lock = b.index(self.ORG_LOCK)
            self.assertNotRegex(b[:lock], r"\bfor (no key update|update|share|key share)\b", f"{name} holds a row lock while it waits")
            self.assertLess(b.rindex("'editor')", 0, lock), lock, f"{name} takes the organization lock before the editor check")
            self.assertRegex(b[lock:], rf"from public\.{table} where id = [\w.]+ for no key update;", name)
            self.assertNotRegex(b, r"\bfor (update|share)\b", name)
            for write in re.finditer(r"\b(insert into|update|delete from) public\.", b):
                self.assertLess(lock, write.start(), (name, write.group(0)))

    def test_what_decides_a_write_is_read_again_under_the_organization_lock(self):
        for name, read in (("save_brand_product", "perform 1 from public.brand_kits where id = k.id;"),
                           ("save_ad_campaign", "perform 1 from public.brand_kits where id = k.id;"),
                           ("save_ad_campaign", "from public.brand_products p where p.id = any (p_products)"),
                           ("add_ad_concepts", "select * into c from public.ad_campaigns where id = p_campaign;")):
            b = code(body(TEXT, name))
            self.assertGreater(b.rindex(read), b.index(self.ORG_LOCK), (name, read))

    def test_the_concept_functions_lock_one_leaf_row_and_no_organization(self):
        for name in ("update_ad_concept", "set_ad_concept_status", "delete_ad_concept"):
            b = code(body(TEXT, name))
            self.assertIn("from public.ad_concepts where id = p_concept for update;", b, name)
            self.assertNotIn(self.ORG_LOCK, b, name)
            # Membership first, the lock after it: nobody waits on another organization's concept.
            self.assertLess(b.index("'editor')"), b.index("for update;"), name)
        self.assertNotRegex(code(TEXT), r"references public\.ad_concepts\b", "a concept is a leaf: nothing references it")


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
        # One class, written once per function and per line mode: the single-line class (ads_clean_text and ads_text_ok), the multi-line
        # class (the same, keeping the line feed) and the blank-looking spaces (read as a space by the one, refused by the other).
        ranges = [(lo, hi) for lo, hi in INVISIBLE]
        sql = "[" + "".join(sql_range(lo, hi) for lo, hi in ranges) + "]"
        multi = sql.replace(sql_range(0x01, 0x1F), sql_range(0x01, 0x09) + sql_range(0x0B, 0x1F), 1)
        spaces = "[" + "".join(sql_range(lo, hi) for lo, hi in SPACES) + "]"
        c = code(TEXT)
        self.assertEqual(c.count(f"'{sql}'"), 2, "single-line class in ads_clean_text and ads_text_ok")
        self.assertEqual(c.count(f"'{multi}'"), 2, "multi-line class in ads_clean_text and ads_text_ok")
        # ads_clean_text reads a run of spaces, blank-looking ones included, as one space; ads_text_ok refuses a blank-looking space and
        # two spaces in a row.
        self.assertIn(f"'[ {spaces[1:-1]}]+', ' ', 'g'), E' \\n')", code(body(TEXT, "ads_clean_text")))
        self.assertIn(f"and p_text !~ '{spaces}'", code(body(TEXT, "ads_text_ok")))
        self.assertIn("and position('  ' in p_text) = 0", code(body(TEXT, "ads_text_ok")))
        self.assertEqual(ts_ranges("INVISIBLE_RANGES"), ranges)
        self.assertEqual(ts_ranges("BLANK_SPACES"), SPACES)

    def test_the_class_holds_every_character_the_comment_inbox_removes_and_the_two_emoji_selectors(self):
        # BR-L-120: the repository's class of characters nobody sees (modules/comment_replies.py, inbox_clean_text, lib/comment-inbox) is
        # in the shared fixture. Ads text removes all of it, and U+FE0E / U+FE0F too (an ad's words keep no emoji-style selector: the zero
        # width joiner that builds an emoji sequence is removed already, and a selector is then a hidden channel).
        def covered(lo, hi, table):
            return all(any(a <= cp <= b for a, b in table) for cp in range(lo, hi + 1))
        for lo, hi in INBOX["strip"]:
            self.assertTrue(covered(lo, hi, INVISIBLE), hex(lo))
        self.assertTrue(covered(0xFE0E, 0xFE0F, INVISIBLE))
        self.assertEqual([tuple(x) for x in INBOX["space"]], SPACES)
        # The ones the independent review named, one by one: the tag block, the variation selectors and their supplement, the fillers.
        for cp in (0xE0000, 0xE0041, 0xE007F, 0xE0FFF, 0xE0100, 0xE01EF, 0x061C, 0x180E, 0x034F, 0x115F, 0x3164, 0xFFA0, 0x2800, 0xFE00,
                   0xFE0F, 0xFFF9, 0xFFFB, 0x1D173, 0x1D17A, 0x17B4, 0x17B5, 0x2065):
            self.assertTrue(covered(cp, cp, INVISIBLE), hex(cp))

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

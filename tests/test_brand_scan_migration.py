"""Migration 0133 (Ads Factory, Phase 2: the brand scan), pinned from the file: what the security lab cannot see by running it.

* every function body hashes to the value the drift guard, the end state and the rollback name (the three lists agree);
* it replaces nothing and touches no object it did not add: no `create or replace` of an older name, no `alter table` of an older table,
  and the only writes to older tables are accept_brand_scan_fields's into 0131's kits and products;
* the grants are exactly five functions to `authenticated` and five to `service_role`; the helpers to nobody;
* the shipped price is NULL (not on sale), the platform caps are 500 and 5000, the fixed limits are what the docs say;
* the hosting-parent list and the host shape are the worker's (modules/brand_fetch.py), so the database and the fetcher refuse the same names;
* the money path: a hold only after the caps and under the platform lock taken after the organization's; a capture only in finish; a release
  in every failure path;
* the rollback is one transaction, drops exactly what was added, refuses while rows exist or a scan is in flight.
"""

import hashlib
import re
import unittest
from pathlib import Path

from modules import brand_fetch as bf

ROOT = Path(__file__).resolve().parent.parent
MIG = ROOT / "supabase" / "migrations"
FILE = MIG / "0133_brand_scan.sql"
TEXT = FILE.read_text(encoding="utf-8")
ROLLBACK = (ROOT / "docs" / "sql" / "rollback_0133_brand_scan.sql").read_text(encoding="utf-8")

TABLES = ["brand_domains", "brand_domain_checks", "brand_scans", "brand_scan_settings"]
MEMBER = {
    "request_domain_verification": "uuid, text",
    "check_domain_verification": "uuid",
    "quote_brand_scan": "uuid",
    "request_brand_scan": "uuid, text, text, numeric",
    "accept_brand_scan_fields": "uuid, uuid, text[]",
}
WORKER = {
    "claim_domain_check": "text",
    "finish_domain_check": "uuid, text, boolean, text",
    "claim_brand_scan": "text",
    "finish_brand_scan": "uuid, text, jsonb",
    "fail_brand_scan": "uuid, text, text",
}
INTERNAL = {
    "ads_hosting_parent": "text",
    "ads_scan_host_ok": "text",
    "ads_scan_url_ok": "text",
    "brand_scan_field_ok": "jsonb, text",
    "brand_scan_result_ok": "jsonb",
    "brand_scan_price": "",
    "brand_scan_fail_locked": "uuid, text",
    "brand_scan_settings_guard": "",
    "brand_scan_settings_trail": "",
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


GUARD = pins(TEXT, "A function of one of this file's names that already exists", "-- 1. Shapes")
END = pins(TEXT, "-- 10. The end state", "-- Verify (the SQL editor")
RB = pins(ROLLBACK, "begin;", "-- 1. The functions an API role could call.")


class Numbering(unittest.TestCase):
    def test_the_number_is_unique_and_0132_is_left_to_its_own_pull_request(self):
        numbers = sorted(p.name[:4] for p in MIG.glob("*.sql"))
        self.assertEqual(numbers.count("0133"), 1)
        self.assertIn("0131", numbers)
        # 0136 (exports up to 1080p sold by the minute) was reviewed against these pins: it touches the video editor's export functions and
        # 0132's price row only, nothing of 0131's or 0133's.
        # 0137 (Character Studio) was reviewed against these pins: it names no object of 0133 (tests/test_character_studio_migration.py
        # checks that it names no brand_* object), replaces nothing, and 0133's rollback does not wait for it.
        # 0134 (the follow-up) was reviewed against these pins: it replaces exactly one of this file's functions, brand_scan_fail_locked,
        # on this file's body (its own guard names 0133's hash; tests/test_brand_scan_followup_migration.py pins that), and nothing else.
        # 0138 (the operator's Customers page) was reviewed against these pins: three read-only functions over the credit ledger, the
        # workspaces and the generations; nothing of 0131's or 0133's.
        # 0139 (the operator preview of a hidden model: creative_price on 0125's body and two model-registry functions) was reviewed
        # against these pins: nothing of 0131's or 0133's.
        # 0145 (YouTube's "made for kids") was reviewed against these pins: videos columns, one function, the run params validator and
        # the audit list; nothing of 0131's or 0133's.
        # 0142 (one CHECK on model_registry: a model with blocked_countries cannot be beta or ga) was reviewed against these pins:
        # nothing of 0131's or 0133's.
        # 0143 (the probe log's vendor_tool_unsupported word: one check constraint on model_probe_runs) was reviewed against these pins:
        # nothing of 0131's or 0133's.
        # 0146 (Dodo Payments next to Paddle: the payment tables' provider checks and 0034's two subscription functions) was reviewed
        # against these pins: nothing of 0131's or 0133's.
        # 0147 (MCP over OAuth on every plan: 0093's and 0042's functions, oauth_check_credits, oauth_clients.vendor) was reviewed
        # against these pins: nothing of 0131's or 0133's.
        # 0149 (an operator preview priced by resolution: creative_price on 0139's body only) was reviewed against these pins:
        # nothing of 0131's or 0133's.
        # 0151 (the Studio's progress seed: one read-only function over model_registry and model_probe_runs) was reviewed against
        # these pins: nothing of 0131's or 0133's.
        # 0152 (the probe log's vendor_credits: one column on model_probe_runs, an eleven-argument record_model_probe) was reviewed
        # against these pins: nothing of 0131's or 0133's.
        # 0153 (an operator preview priced by quality: creative_price on 0149's body only) was reviewed against these pins: nothing
        # of 0131's or 0133's.
        # 0155 (a quote refuses a shape the model does not list: creative_price on 0153's body only) was reviewed against these
        # pins: nothing of 0131's or 0133's.
        # 0156 (a model's own resolution names: creative_params_problem on 0126's body, creative_price on 0155's) was reviewed against
        # these pins: nothing of 0131's or 0133's.
        # 0157 (the Credits page's Dodo purchase history: one read-only function over payment_events and dodo_checkout_nonces) was
        # reviewed against these pins: nothing of 0131's or 0133's.
        # 0158 (the concept-thumbnail settings are an administrator's: channel_admin_controls and one trigger on channels) was
        # reviewed against these pins: nothing of 0131's or 0133's.
        # 0159 (a quote refuses a clip length the model does not list: creative_price on 0156's body only) was reviewed against
        # these pins: nothing of 0131's or 0133's.
        # 0161 (ChatGPT keeps the client it registered: oauth_gc on 0147's body, one internal helper, one generated column and its index on oauth_clients) was reviewed against these
        # pins: nothing of 0131's or 0133's.
        # 0162 (two read-only API functions for the MCP Studio tools: api_creative_models, api_creative_job_files) was reviewed
        # against these pins: nothing of 0131's or 0133's.
        # 0164 (the site's live public counters: site_settings and three new functions over videos, intents, generations and runs)
        # was reviewed against these pins: nothing of 0131's or 0133's.
        # 0165 (the referral programme: two tables, eight functions, four earlier bodies with one hunk each) was reviewed
        # against these pins: nothing of 0131's or 0133's.
        # 0166 (Film Studio P1: five new film tables and their own functions, its own copies of the text helpers) was reviewed
        # against these pins: nothing of 0131's or 0133's.
        # 0167 (a refund that met a hold collects when the hold is released: refund_purchased_credits on 0034's body, one table, one
        # trigger on credit_transactions) was reviewed against these pins: nothing of 0131's or 0133's.
        # 0168 (an API top-up refund that met a hold collects when the hold is released: api_refund_topup on 0031's body, one table,
        # one trigger on api_ledger) was reviewed against these pins: nothing of 0131's or 0133's.
        # 0170 (api_request_download audits a listed action name: one hunk in 0147's body) was reviewed against these pins:
        # nothing of 0131's or 0133's.
        # 0171 (Film Studio P2: two new tables, money columns on film_takes, creative_jobs.film_take_id, and its own functions) was
        # reviewed against these pins: nothing of 0131's or 0133's.
        # 0191 (a connected assistant's Studio generations: oauth_* functions and tables, 0093's three bodies, the grants' scope check)
        # was reviewed the same way: it reads, replaces and alters nothing these pins guard, and names none of their words.
        # 0172 (an owner's grant reversal that met a hold collects when the hold is released: owner_reverse_grant on 0107's body, the
        # lot trigger on 0167's, one table, one trigger on credit_transactions) was reviewed against these pins: nothing of 0131's or 0133's.
        # 0173 (the seven cleared models on sale: credit_prices rows and model_registry availability / entitlement only) was reviewed
        # against these pins: nothing of 0131's or 0133's.
        # 0174 (rights acknowledgement: two tables, a model_registry column, four functions, two hunks in 0075's create_creative_job)
        # was reviewed against these pins: nothing of 0131's or 0133's.
        # 0182 (owner analytics: two closed tables, owner-only read functions, one index on dodo_checkout_nonces; names nothing these pin)
        # 0183 (trend templates: one new table and its seed; no function, no bucket; alters no existing object) was
        # reviewed the same way.
        # 0184 (owner costs: one closed table, owner-only functions over creative_job_costs, video_costs, provider_balances)
        # 0185 (owner FX rates: one closed table and three owner-only functions)
        # 0186 (trend templates, second set: 'viral' added to creative_templates' category CHECK and ten seed rows; no
        # function, no grant) was reviewed the same way: it names nothing these pin.
        # 0187, 0188 and 0189 (rights acknowledgement inputs; Recraft web_mcp; a job's video and the video list order) were reviewed
        # against these pins: nothing of 0131's or 0133's.
        # 0190 (the probe log's plan_required word: one check constraint on model_probe_runs) was reviewed the same way: names nothing these pin.
        # 0192 (the adult attestation: adult_attestations, two calls, its helpers and hold gate, marked hunks in quote_creative_job,
        # route_model, sellable_models, create_creative_job, api_creative_refusal, creative_platform_reserve, quote_film, start_film and api_create_video) was reviewed the same way: nothing of 0131's or 0133's.
        # 0193 (the public names of the models on sale: one new read-only function over sellable_models; alters nothing, names nothing these pin)
        # 0194 (OpenAI GPT Image on sale once verified and priced) and 0195 (Describe on Claude and GPT, the same shape) were reviewed
        # the same way: model_registry availability / entitlement only, no price, function, table or grant; they name nothing these pin.
        # 0196 (a video run on Google needs an adult answer: two functions, 0192's run gate re-pointed, one hunk each in 0192's route_model,
        # api_create_video, oauth_create_video and 0187's reroute_creative_job) was reviewed the same way: it names nothing of 0131's or 0133's.
        # 0197 (owner brain facts: two owner-only read functions, no table)
        # 0198 (Film Studio P3: the switch per organization; quote_film, start_film and film_claim_segment each one hunk, the take's
        # creative job) was reviewed the same way: it names nothing these pin.
        # 0201 (Brain org facts: one member-only read function, no table)
        # 0202 (channel research: seven new closed tables, its own functions, a youtube_quota_take overload and the ledger's source CHECK
        # extended) was reviewed the same way: it replaces and alters nothing these pin.
        # 0205 (publish to platforms: replaces only publish_request_refusal, which none of these pins name; reads
        # videos.gate_verdict) was reviewed the same way.
        # 0215 (Film Studio archive, resume and assembly re-run: three admin calls and internal helpers; marked hunks in 0166's film_read and
        # archive_film and 0198's start_film, film_claim_segment and claim_creative_job; columns on film_segments, film_takes,
        # film_quotes) was reviewed the same way: it names nothing these pin.
        # 0208 (the database's country gate and the price by picture size: one trigger on creative_jobs, two new functions, marked
        # hunks in creative_params_problem, creative_price, creative_regions_problem and reroute_creative_job) was reviewed the same
        # way: it names nothing these pin.
        # 0222 (retires gemini-omni-1.1-flash: one UPDATE of model_registry.availability, no function or table) names nothing
        # these pin.
        # 0218 (a model's prompt limit, negative prompt and seed refused at the quote: replaces creative_params_problem and
        # creative_price on 0208's bodies and film_price on 0171's, nothing else) was reviewed the same way: it names nothing these pin.
        # 0212 (the recorded film sweep: one closed table, two service-role functions over 0171's film_expire_segments, a pg_cron
        # job where installed; replaces nothing) was reviewed the same way: it names nothing these pin.
        # 0214 (voice_language_problem: one new service-only read function, no table; replaces no body, names nothing these
        # pin) was reviewed the same way.
        # 0227 changes model terms and the audit allow-list, outside these pins.
        # 0220 (the film's voice language at the quote and the start: replaces 0171's film_price and film_precheck, each with one
        # call to 0214's voice_language_problem; no table, no grant) was reviewed the same way: it names nothing these pin.
        # 0214 (voice_language_problem: one new service-only read function, no table; replaces no body, names nothing these
        # pin) was reviewed the same way.
        self.assertEqual([n for n in numbers if n > "0133" and n not in ("0134", "0136", "0137", "0138", "0139", "0142", "0143", "0145", "0146", "0147", "0149", "0151", "0152", "0153", "0155", "0156", "0157", "0158", "0159", "0161", "0162", "0164", "0165", "0166", "0167", "0168", "0170", "0171", "0172", "0173", "0174", "0182", "0183", "0184", "0185", "0186", "0187", "0188", "0189", "0190", "0191", "0192", "0193", "0194", "0195", "0196", "0197", "0198", "0199", "0200", "0201", "0202", "0203", "0204", "0205", "0208", "0209", "0222", "0212", "0215", "0218", "0225", "0214", "0211", "0227", "0220")], [], "a later number needs its own review of this file's pins")
        # 0199 (Nightshift AI: new ai_chat_* tables and their functions; replaces no body, names nothing these pin) was
        # reviewed the same way.
        # 0203 (the owner AI's turn log: one closed table and two owner-only functions; replaces nothing) was reviewed the same way.
        # 0204 (Instagram through Unified Login: three columns on social_accounts, store_social_account on 0028's body) was reviewed
        # against these pins: it names nothing of this file's.
        # 0225 (creative_jobs: the member grant narrowed to named columns, and detail.worker redacted in two event trails; no
        # function, policy or table) was reviewed the same way: it names nothing these pin.
        later = (MIG / "0134_brand_scan_followup.sql").read_text(encoding="utf-8")
        self.assertEqual(re.findall(r"create or replace function public\.(\w+)\(", later), ["brand_scan_fail_locked"])
        self.assertIn(GUARD["brand_scan_fail_locked"], later)
        self.assertIn("0132 is reserved by another open pull request", TEXT)

    def test_the_file_says_it_is_applied_as_one_transaction_and_what_to_verify(self):
        for needle in ("APPLY AS ONE TRANSACTION", "WHAT TO VERIFY BEFORE YOU APPLY", "LIVE ON APPLY"):
            self.assertIn(needle, TEXT)
        self.assertIn("set local lock_timeout", code(TEXT))
        self.assertRegex(ROLLBACK, r"(?m)^begin;$")
        self.assertEqual(len(re.findall(r"(?m)^commit;$", ROLLBACK)), 1)


class Hashes(unittest.TestCase):
    def test_every_function_is_pinned_in_the_guard_the_end_state_and_the_rollback_with_its_real_hash(self):
        want = {name: h(body(TEXT, name)) for name in ALL}
        self.assertEqual(GUARD, want)
        self.assertEqual(END, want)
        self.assertEqual(RB, want)
        self.assertEqual(len(set(want.values())), len(want))
        self.assertNotIn("MD5:", TEXT + ROLLBACK)

    def test_the_signatures_are_written_out_in_all_three(self):
        for name, args in ALL.items():
            self.assertIn(f"('public.{name}({args})', '", TEXT, name)
            self.assertIn(f"('public.{name}({args})', '", ROLLBACK, name)

    def test_no_source_line_carries_a_literal_invisible_character(self):
        for text in (TEXT, ROLLBACK):
            self.assertIsNone(re.search("[­​-‏‪-‮⁠-⁩﻿]", text))


class Scope(unittest.TestCase):
    c = code(TEXT).lower()

    def test_it_creates_exactly_its_own_functions_and_tables(self):
        self.assertEqual(sorted(set(re.findall(r"create or replace function public\.(\w+)\(", self.c))), sorted(ALL))
        self.assertEqual(sorted(re.findall(r"create table if not exists public\.(\w+)", self.c)), sorted(TABLES))

    def test_it_alters_or_drops_no_older_object(self):
        for m in re.findall(r"alter table public\.(\w+)", self.c):
            self.assertIn(m, TABLES)
        for m in re.findall(r"drop (?:trigger|policy) if exists \w+ on public\.(\w+)", self.c):
            self.assertIn(m, TABLES)
        self.assertNotRegex(self.c, r"\bdrop (table|function|column)\b")

    def test_the_only_writes_to_older_tables_are_the_accept_into_0131s_kits_and_products_and_a_failed_scans_pictures(self):
        writes = {(m.group(1), m.group(2)) for m in re.finditer(r"\b(insert into|update|delete from) public\.(\w+)", self.c)}
        older = {w for w in writes if w[1] not in TABLES}
        self.assertEqual(older, {("insert into", "brand_kits"), ("update", "brand_kits"), ("insert into", "brand_products"),
                                 ("insert into", "brand_product_images"), ("update", "media_assets")})
        # A failed scan's pictures: only deleted_at, only this scan's own pictures in its own organization, in one function.
        f = code(body(TEXT, "brand_scan_fail_locked"))
        self.assertIn("update public.media_assets\n       set deleted_at = now()\n     where org_id = x.org_id and source = 'pipeline' and deleted_at is null\n"
                      "       and provenance ->> 'origin' = 'brand_scan' and provenance ->> 'scan_id' = x.id::text;", f)
        for other in set(ALL) - {"brand_scan_fail_locked"}:
            self.assertNotIn("public.media_assets\n       set", code(body(TEXT, other)), other)
        self.assertEqual(self.c.count("update public.media_assets"), 1)
        a = code(body(TEXT, "accept_brand_scan_fields")).lower()
        self.assertIn("continue when fld = any (x.accepted_fields);", a, "a product is added once per scan")
        for _, t in older - {("update", "media_assets")}:
            self.assertIn(f"public.{t}", a)
            for other in set(ALL) - {"accept_brand_scan_fields"}:
                self.assertNotRegex(code(body(TEXT, other)).lower(), rf"\b(insert into|update|delete from) public\.{t}\b", other)

    def test_no_model_publish_or_network_object_is_named(self):
        for word in ("public.render_jobs", "public.creative_jobs", "publish", "public.videos", "pg_net", "net.http", "dblink", "lo_import", "vault",
                     "model_registry", "sellable_models"):
            self.assertFalse(word in self.c, word)


class Grants(unittest.TestCase):
    c = code(TEXT)

    def test_execute_goes_to_authenticated_on_five_and_to_service_role_on_five(self):
        grants = sorted(re.findall(r"grant execute on function public\.(\w+)\(([^)]*)\) to (\w+);", self.c))
        want = sorted([(n, a, "authenticated") for n, a in MEMBER.items()] + [(n, a, "service_role") for n, a in WORKER.items()])
        self.assertEqual(grants, want)

    def test_every_function_is_revoked_from_every_role_first(self):
        for name, args in ALL.items():
            self.assertIn(f"revoke all on function public.{name}({args}) from public, anon, authenticated, service_role;", self.c, name)

    def test_tables_select_only_and_never_the_settings(self):
        self.assertEqual(re.findall(r"grant (\w+) on ", self.c.replace("grant execute", "")), ["select"])
        self.assertIn("grant select on public.brand_domains, public.brand_domain_checks, public.brand_scans to authenticated, service_role;", self.c)
        for t in TABLES:
            self.assertIn(f"alter table public.{t} enable row level security;", self.c)
        policies = re.findall(r"create policy (\w+) on public\.(\w+)\s+for (\w+) to (\w+)\s+using \(([^;]+)\);", self.c)
        self.assertEqual(sorted(p[1] for p in policies), sorted(TABLES[:3]))
        for name, table, cmd, role, using in policies:
            self.assertEqual((name, cmd, role, using.strip()), (f"{table}_select", "select", "authenticated",
                                                                 "org_id in (select public.accessible_org_ids('viewer'))"))

    def test_every_function_pins_its_search_path(self):
        for m in re.finditer(r"create or replace function public\.(\w+)\(.*?\$\$", self.c, re.S):
            self.assertIn("set search_path = public, pg_temp", m.group(0), m.group(1))

    def test_the_workers_functions_are_for_the_trusted_caller_only(self):
        for name in WORKER:
            b = code(body(TEXT, name))
            self.assertLess(b.index("if not public.credits_trusted_caller() then"), b.index("raise exception"), name)

    def test_every_member_function_checks_sign_in_and_the_role_before_it_reads_what_was_sent(self):
        for name in MEMBER:
            b = code(body(TEXT, name))
            first = b.index("\nbegin\n")
            self.assertRegex(b[first:first + 200], r"\b(auth\.uid\(\)|uid) is null", name)
            if "uid is null" in b[first:first + 200] and "auth.uid() is null" not in b[first:first + 200]:
                self.assertIn("uid     uuid := auth.uid();", b, name)
            if name != "quote_brand_scan":
                self.assertIn("'editor')", b, name)
        for name, reads in (("request_domain_verification", "lower(btrim(coalesce(p_host"), ("request_brand_scan", "btrim(coalesce(p_url")):
            b = code(body(TEXT, name))
            self.assertGreater(b.index(reads), b.index("'editor')"), name)


class Money(unittest.TestCase):
    def test_the_price_is_the_databases_and_shipped_null(self):
        c = code(TEXT)
        settings = c[c.index("create table if not exists public.brand_scan_settings"):]
        settings = settings[:settings.index(");")]
        self.assertIn("price_credits         numeric,", settings)
        self.assertIsNone(re.search(r"price_credits\s+numeric\s+(not null|default)", settings))
        self.assertIn("insert into public.brand_scan_settings (id) values (true) on conflict (id) do nothing;", c)
        b = code(body(TEXT, "request_brand_scan"))
        self.assertIn("v_price := public.brand_scan_price();", b)
        self.assertIn("raise exception 'not_on_sale' using errcode = 'NS409';", b)
        self.assertIn("creative_platform_reserve(p_org, v_ref, v_hold)", b, "the hold is computed here, never p_max_credits")
        hold = "v_hold := trim_scale(round(greatest(v_price, coalesce(public.credits_round_up(v_floor), 0)), 2));"
        self.assertIn(hold, b, "the hold is the price raised to job_minimum")
        self.assertIn(hold, code(body(TEXT, "quote_brand_scan")), "and the quote names the same hold")
        # The owner exempted the scan from job_minimum: the CHARGED price is the setting, never raised (only the hold is).
        self.assertNotIn("job_minimum", code(body(TEXT, "brand_scan_price")))
        self.assertIn("if p_max_credits is null or v_price > p_max_credits then", b, "the confirmed price is the charged one, not the hold")
        self.assertIn("public.capture_credits(x.credit_ref, x.price_credits, false)", code(body(TEXT, "finish_brand_scan")))
        self.assertIn("'requested', case when v_ref is null then 0 else v_price end", b, "the scan stores the price, not the hold")
        self.assertIn("exception when sqlstate 'NS402' then\n      raise exception 'scan_hold_unavailable'", b)
        self.assertIn("if v_hold < v_price then", b, "the hold is never below the charge")
        self.assertLess(b.index("if v_hold < v_price then"), b.index("creative_platform_reserve("))
        self.assertNotIn("p_amount", body(TEXT, "finish_brand_scan").split("$$")[0], "the finish takes no amount: it charges the stored price")
        # NaN and the infinities never reach a comparison (NaN is greater than every number, so `price > NaN` is never true).
        guard = "if p_max_credits is not null and not (p_max_credits between 0 and 1000) then"
        self.assertIn(guard, b)
        self.assertLess(b.index(guard), b.index("v_hash := md5("))

    def test_locks_then_caps_then_the_hold_then_the_row(self):
        b = code(body(TEXT, "request_brand_scan"))
        org = b.index("pg_advisory_xact_lock(hashtextextended('brand_scan:' ||")
        replay = b.index("'replayed', true")
        sale = b.index("'not_on_sale'")
        dom = b.index("'domain_not_verified'")
        plat = b.index("pg_advisory_xact_lock(hashtextextended('brand_scan_global', 0))")
        busy = b.index("'platform_busy'")
        hold = b.index("creative_platform_reserve(")
        insert = b.index("insert into public.brand_scans")
        self.assertEqual(sorted([org, replay, sale, dom, plat, busy, hold, insert]), [org, replay, sale, dom, plat, busy, hold, insert])
        self.assertNotRegex(b[:org], r"\bfor (no key update|update|share)\b", "no row lock before the organization's lock")
        self.assertNotRegex(b[:plat], r"\bfor (no key update|update|share)\b", "nor before the platform's")

    def test_capture_only_in_finish_and_a_release_in_every_failure(self):
        c = code(TEXT)
        self.assertEqual(c.count("public.capture_credits(x."), 1)
        self.assertEqual(c.count("capture_credits("), 2, "the prerequisite check and the one capture")
        self.assertIn("capture_credits(x.credit_ref, x.price_credits, false)", code(body(TEXT, "finish_brand_scan")))
        self.assertIn("creative_platform_release(x.credit_ref)", code(body(TEXT, "brand_scan_fail_locked")))
        for name in ("fail_brand_scan", "claim_brand_scan", "request_brand_scan"):
            self.assertIn("brand_scan_fail_locked(", code(body(TEXT, name)), name)
        self.assertNotIn("update public.brand_scans set status = 'failed'", c.replace("\n", " "))

    def test_the_caps_and_fixed_limits(self):
        c = code(TEXT)
        self.assertIn("platform_daily_scans  integer not null default 500,", c)
        self.assertIn("platform_daily_checks integer not null default 5000,", c)
        self.assertIn("v_cap := coalesce(v_cap, 500);", code(body(TEXT, "request_brand_scan")))
        self.assertIn("v_cap := coalesce(v_cap, 5000);", code(body(TEXT, "check_domain_verification")))
        self.assertIn(">= 10 then", code(body(TEXT, "request_domain_verification")))
        self.assertIn("interval '15 seconds'", code(body(TEXT, "check_domain_verification")))
        self.assertIn("create unique index if not exists brand_scans_one_in_flight on public.brand_scans (org_id) where status in ('requested', 'running');", c)
        self.assertIn("raise exception 'platform_busy' using errcode = 'NS429';", c, "the platform's refusal names no number")
        # One organization's share of the day, counted under its own lock, BEFORE the platform's lock and cap; no number in the refusal.
        self.assertIn("org_daily_scans       integer not null default 20,", c)
        self.assertIn("org_daily_checks      integer not null default 200,", c)
        for name, fallback in (("request_brand_scan", "v_ocap := coalesce(v_ocap, 20);"), ("check_domain_verification", "v_ocap := coalesce(v_ocap, 200);")):
            b = code(body(TEXT, name))
            self.assertIn(fallback, b, name)
            refusal = b.index("raise exception 'org_daily_limit' using errcode = 'NS429';")
            self.assertLess(b.index("pg_advisory_xact_lock(hashtextextended('brand_scan:' ||"), refusal, name)
            self.assertLess(refusal, b.index("_global', 0))"), name)


class AgreesWithTheWorker(unittest.TestCase):
    def test_the_hosting_parents_are_the_fetchers(self):
        b = code(body(TEXT, "ads_hosting_parent"))
        listed = set(re.findall(r"'([a-z0-9.]+\.[a-z]+)'", b.split("~")[0]))
        self.assertEqual(listed, set(bf.HOSTING_PARENTS))
        second = re.search(r"'\^\(([a-z|]+)\)\\\.\[a-z\]\{2\}\$'", b).group(1).split("|")
        self.assertEqual(set(second), set(bf.COUNTRY_SECOND_LEVEL))

    def test_the_host_and_url_shapes_are_0131s_and_the_fetchers(self):
        host = re.search(r"p_host ~ '([^']+)'", body(TEXT, "ads_scan_host_ok")).group(1)
        url = re.search(r"p_url ~ '([^']+)'", body(TEXT, "ads_scan_url_ok")).group(1)
        self.assertEqual(url, "^https://" + host[1:-1] + r"(/[\x21-\x7e]*)?$")
        self.assertIn("between 12 and 2048", body(TEXT, "ads_scan_url_ok"))
        self.assertEqual(bf.MAX_DERIVED_URL_CHARS, 2048)
        from modules import dns_txt
        self.assertEqual(dns_txt._HOST.pattern.replace("(?:", "(").rstrip("\\Z"), host[1:-1])

    def test_the_result_places_and_limits_are_the_extractors(self):
        from modules import brand_extract as bx
        b = body(TEXT, "brand_scan_field_ok")
        places = set(re.findall(r"'([a-z_]+)'", b[b.index("(src ->> 'where') not in") + len("(src ->> 'where') not in"):b.index("v := p_field")]))
        self.assertEqual(places, set(bx._WHERE))
        r = body(TEXT, "brand_scan_result_ok")
        self.assertIn("octet_length(p_result::text) > 65536", r)
        self.assertIn("jsonb_array_length(p_result -> 'products') > 8", r)
        self.assertIn("jsonb_array_length(p_result -> 'pages') > 6", r)
        self.assertIn("jsonb_array_length(p_result -> 'notes') > 20", r)

    def test_the_workers_failure_codes_are_closed_words(self):
        src = (ROOT / "modules" / "brand_scan.py").read_text(encoding="utf-8")
        for word in re.findall(r'_Failed\("([^"]+)"\)', src):
            self.assertRegex(word, r"^[a-z0-9_]{1,64}$")
        for code_ in vars(bf).values():
            if isinstance(code_, str) and re.fullmatch(r"[a-z_]+", code_) and len(code_) < 30:
                self.assertRegex(f"fetch_{code_}", r"^[a-z0-9_]{1,64}$")


class Rollback(unittest.TestCase):
    c = code(ROLLBACK)

    def test_it_drops_exactly_what_the_file_added_without_cascade(self):
        self.assertEqual(sorted(re.findall(r"drop table if exists public\.(\w+);", self.c)), sorted(TABLES))
        self.assertEqual(sorted(re.findall(r"drop function if exists public\.(\w+)\(", self.c)), sorted(ALL))
        self.assertNotIn("cascade", self.c.lower())

    def test_it_refuses_while_rows_exist_or_a_scan_is_in_flight(self):
        self.assertIn("nightshift.brand_scan_rollback_delete_rows", self.c)
        self.assertIn("<> 'yes'", self.c)
        self.assertIn("still requested or running", self.c)
        self.assertIn("is not 0133''s body", self.c)


class Documented(unittest.TestCase):
    def test_the_docs_name_the_migration_the_switch_the_price_and_the_rollback(self):
        doc = (ROOT / "docs" / "ADS_FACTORY.md").read_text(encoding="utf-8")
        for needle in ("0133_brand_scan.sql", "rollback_0133_brand_scan.sql", "NIGHTSHIFT_ADS_BRAND_SCAN", "_nightshift.", "not_on_sale",
                       "platform_daily_scans", "tools/brand_scan_worker.py", "modules/dns_txt.py"):
            self.assertIn(needle, doc)
        self.assertIn("0133_brand_scan", (ROOT / "docs" / "MIGRATIONS.md").read_text(encoding="utf-8"))


if __name__ == "__main__":
    unittest.main()

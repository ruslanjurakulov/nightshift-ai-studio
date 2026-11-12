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
        # 0135 (Character Studio) was reviewed against these pins: it names no object of 0133 (tests/test_character_studio_migration.py
        # checks that it names no brand_* object), replaces nothing, and 0133's rollback does not wait for it.
        # 0134 (the follow-up) was reviewed against these pins: it replaces exactly one of this file's functions, brand_scan_fail_locked,
        # on this file's body (its own guard names 0133's hash; tests/test_brand_scan_followup_migration.py pins that), and nothing else.
        self.assertEqual([n for n in numbers if n > "0133" and n not in ("0134", "0135", "0136")], [], "a later number needs its own review of this file's pins")
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

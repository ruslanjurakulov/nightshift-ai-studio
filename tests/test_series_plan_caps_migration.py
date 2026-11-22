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
        # 0128 (an edited picture remembers its original: media_uploads.parent_asset_id, request_upload's seven-argument overload,
        # register_asset) was reviewed against these pins: it mentions none of request_series_plan, series_plans or series_plan_cap_settings,
        # so nothing 0127's hashes guard moves. Any other later number needs its own review of this file's pins.
        # 0129 (an export in another frame: editor_exports.frame_preset / frame_width / frame_height, editor_export_frame() and
        # request_editor_export's three-argument overload) was reviewed the same way: it touches the video editor's export table and
        # functions only and mentions none of the three words below, so nothing 0127's hashes guard moves.
        # 0130 adds isolated agent draft/version tables and a save-only function;
        # reviewed against request_series_plan, series_plans and series_plan_cap_settings pins.
        # 0131 (Ads Factory, Phase 1: brand_kits, brand_products, ad_campaigns, ad_concepts, ads_factory_cap_settings and their functions) was
        # reviewed the same way: it adds its own tables and functions only, replaces nothing, and names none of the three words below (its
        # caps live in their own table). The loop under this line checks exactly that for every reviewed number.
        # 0132 (1440p and 4K editor exports, sold by the minute: editor_exports' credit columns, editor_export_hires_prices, the four-argument
        # request_editor_export) was reviewed the same way: the video editor's export table and functions only, none of the three words.
        # 0133 (Ads Factory, Phase 2: brand_domains, brand_domain_checks, brand_scans, brand_scan_settings and their functions) was
        # reviewed the same way: its own tables and functions, plus writes into 0131's kits and products; none of the three words below.
        # 0136 (exports up to 1080p sold by the minute: a column of 0132's price row and 0132's export functions) was reviewed the same way.
        # 0134 (the brand scan's follow-up: brand_scan_fail_locked only) was reviewed the same way.
        # 0137 (Character Studio: character_swap_* tables and functions) was reviewed the same way: its own tables and functions only,
        # replaces nothing, and names none of the three words below.
        # 0138 (the operator's Customers page: three read-only functions over the credit ledger, workspaces and generations) was reviewed
        # the same way: it replaces nothing and names none of the three words below.
        # 0139 (the operator preview of a hidden model: creative_price on 0125's body, creative_operator_preview, operator_preview_models)
        # was reviewed the same way: it names none of the three words below.
        # 0145 (YouTube's "made for kids": seven videos columns, set_video_made_for_kids, and 0122's render_job_params_valid with one more
        # key) was reviewed the same way: it does not touch request_series_plan (0127's) or the planning tables, and names none of the
        # three words below; it sits on 0122's validator, so 0122's rollback and replay take it off first (tests/security/sec_db.py).
        # 0142 (one CHECK on model_registry: a model with blocked_countries cannot be beta or ga) was reviewed the same way.
        # 0143 (the probe log's vendor_tool_unsupported word: one check constraint on model_probe_runs) was reviewed the same way: it
        # names none of the three words below.
        # 0146 (Dodo Payments next to Paddle: the payment tables' provider checks and 0034's two subscription functions) was reviewed the
        # same way: it names none of the three words below.
        # 0147 (MCP over OAuth on every plan: 0093's and 0042's functions, oauth_check_credits, oauth_clients.vendor) was reviewed the
        # same way: it names none of the three words below.
        # 0149 (an operator preview priced by resolution: creative_price on 0139's body only) was reviewed the same way: it names none
        # of the three words below.
        # 0151 (the Studio's progress seed: one read-only function over model_registry and model_probe_runs) was reviewed the same
        # way: it names none of the three words below.
        # 0152 (the probe log's vendor_credits: one column on model_probe_runs, an eleven-argument record_model_probe) was reviewed the
        # same way: it names none of the three words below.
        # 0153 (an operator preview priced by quality: creative_price on 0149's body only) was reviewed the same way: it names none of
        # the three words below.
        # 0155 (a quote refuses a shape the model does not list: creative_price on 0153's body only) was reviewed the same way: it
        # names none of the three words below.
        # 0156 (a model's own resolution names: creative_params_problem on 0126's body, creative_price on 0155's) was reviewed the same
        # way: it names none of the three words below.
        # 0157 (the Credits page's Dodo purchase history: one read-only function over payment_events and dodo_checkout_nonces) was
        # reviewed the same way: it names none of the three words below.
        # 0158 (the concept-thumbnail settings are an administrator's: channel_admin_controls and one trigger on channels) was
        # reviewed the same way: it names none of the three words below.
        # 0159 (a quote refuses a clip length the model does not list: creative_price on 0156's body only) was reviewed the same
        # way: it names none of the three words below.
        # 0161 (ChatGPT keeps the client it registered: oauth_gc on 0147's body, one internal helper, one generated column and its index on oauth_clients) was reviewed the same way:
        # it names none of the three words below.
        # 0162 (two read-only API functions for the MCP Studio tools: api_creative_models, api_creative_job_files) was reviewed the
        # same way: it names none of the three words below.
        # 0164 (the site's live public counters: site_settings and three new functions; its run count reads only 'daily' and
        # 'repair' jobs) was reviewed the same way: it names none of the three words below.
        # 0165 (the referral programme: two tables, eight functions, four earlier bodies with one hunk each) was reviewed the
        # same way: it names none of the three words below.
        # 0166 (Film Studio P1: five new film tables and their own functions) was reviewed the same way: it names none of the three
        # words below.
        # 0167 (a refund that met a hold collects when the hold is released: refund_purchased_credits on 0034's body, one table, one
        # trigger on credit_transactions) was reviewed the same way: it names none of the three words below.
        # 0168 (an API top-up refund that met a hold collects when the hold is released: api_refund_topup on 0031's body, one table,
        # one trigger on api_ledger) was reviewed the same way: it names none of the three words below.
        # 0170 (api_request_download audits a listed action name: one hunk in 0147's body) was reviewed the same way: it names
        # none of the three words below.
        # 0171 (Film Studio P2: the film's quote, its one credit hold and the settle functions) was reviewed the same way: it names
        # none of the three words below.
        # 0191 (a connected assistant's Studio generations: oauth_* functions and tables, 0093's three bodies, the grants' scope check)
        # was reviewed the same way: it reads, replaces and alters nothing these pins guard, and names none of their words.
        # 0172 (an owner's grant reversal that met a hold collects when the hold is released: owner_reverse_grant, the lot trigger,
        # one table, one trigger on credit_transactions) was reviewed the same way: it names none of the three words below.
        # 0173 (the seven cleared models on sale: credit_prices rows and model_registry availability / entitlement only) was reviewed
        # the same way: it names none of the three words below.
        # 0174 (rights acknowledgement: two tables, a model_registry column, four functions, two hunks in 0075's create_creative_job)
        # was reviewed the same way: it names none of the three words below.
        # 0182 (owner analytics: two closed tables, owner-only read functions, one index on dodo_checkout_nonces; names nothing these pin)
        # 0183 (trend templates: one new table and its seed; no function, no bucket; alters no existing object) was
        # reviewed the same way: it names none of the three words below.
        # 0184 (owner costs: one closed table, owner-only functions over creative_job_costs, video_costs, provider_balances)
        # 0185 (owner FX rates: one closed table and three owner-only functions)
        # 0186 (trend templates, second set: 'viral' added to creative_templates' category CHECK and ten seed rows; no
        # function, no grant) was reviewed the same way: it names nothing these pin.
        # 0187, 0188 and 0189 (rights acknowledgement inputs; Recraft web_mcp; a job's video and the video list order) were reviewed
        # the same way: they name none of the three words below.
        # 0190 (the probe log's plan_required word: one check constraint on model_probe_runs) was reviewed the same way: names nothing these pin.
        # 0192 (the adult attestation: adult_attestations, two calls, its helpers and hold gate, marked hunks in quote_creative_job,
        # route_model, sellable_models, create_creative_job, api_creative_refusal, creative_platform_reserve, quote_film, start_film and api_create_video) was reviewed the same way: it names none of the three words below.
        # 0193 (the public names of the models on sale: one new read-only function over sellable_models; alters nothing, names nothing these pin)
        # 0194 (OpenAI GPT Image on sale once verified and priced) and 0195 (Describe on Claude and GPT, the same shape) were reviewed
        # the same way: model_registry availability / entitlement only, no price, function, table or grant; they name nothing these pin.
        # 0196 (a video run on Google needs an adult answer: two functions, 0192's run gate re-pointed, one hunk each in 0192's route_model,
        # api_create_video, oauth_create_video and 0187's reroute_creative_job) was reviewed the same way: it names none of the three words below.
        # 0197 (owner brain facts: two owner-only read functions, no table)
        # 0198 (Film Studio P3: the switch per organization; quote_film, start_film and film_claim_segment each one hunk, the take's
        # creative job) was reviewed the same way: it names nothing these pin.
        # 0201 (Brain org facts: one member-only read function, no table)
        # 0202 (channel research: seven new closed tables, its own functions, a youtube_quota_take overload and the ledger's source CHECK
        # extended) was reviewed the same way: it replaces and alters nothing these pin.
        # 0205 (publish to platforms: replaces only publish_request_refusal, which none of these pins name; reads
        # videos.gate_verdict) was reviewed the same way.
        # 0222 (retires gemini-omni-1.1-flash: one UPDATE of model_registry.availability, no function or table) names nothing
        # these pin.
        reviewed = ("0128", "0129", "0130", "0131", "0132", "0133", "0134", "0136", "0137", "0138", "0139", "0142", "0143", "0145", "0146", "0147", "0149", "0151", "0152", "0153", "0155", "0156", "0157", "0158", "0159", "0161", "0162", "0164", "0165", "0166", "0167", "0168", "0170", "0171", "0172", "0173", "0174", "0182", "0183", "0184", "0185", "0186", "0187", "0188", "0189", "0190", "0191", "0192", "0193", "0194", "0195", "0196", "0197", "0198", "0199", "0200", "0201", "0202", "0203", "0204", "0205", "0209", "0222")
        # 0199 (Nightshift AI: new ai_chat_* tables and their functions; replaces no body, names nothing these pin) was
        # reviewed the same way.
        # 0203 (the owner AI's turn log: one closed table and two owner-only functions; replaces nothing) was reviewed the same way.
        # 0209 (the owner AI's chat history: owner_ai_* tables and owner-only functions; names nothing these pin) likewise.
        # 0204 (Instagram through Unified Login: three columns on social_accounts, store_social_account on 0028's body) was reviewed
        # against these pins: it names nothing of this file's.
        self.assertEqual([n for n in numbers if n > "0127" and n not in reviewed], [], "0127 is the highest reviewed: a later number needs its own review of this file's pins")
        for n in reviewed:
            text = next(MIG.glob(f"{n}_*.sql")).read_text(encoding="utf-8")
            for word in ("request_series_plan", "series_plans", "series_plan_cap_settings"):
                self.assertNotIn(word, text, f"{n} touches {word}: review it against this file's pins")

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

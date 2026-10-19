"""Migration 0110 (promo and custom brand-channel posts, Telegram only) ships DORMANT and ADDITIVE. These are the checks that
need no database: they read the file and fail if it ever redefines a function the live worker or the owner page calls,
touches an existing grant or trigger, loses a pinned search_path, gives an API role a privilege it must not have, drops a
name from the audit list, or if anything in the application starts to use the two new functions without this list being
widened on purpose. The behaviour (the status machine with the new kinds, the shared cap, the hash, the idempotent
create, the rollback) is attacked in tests/security/test_sec_marketing_promo.py.
"""

import re
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
SQL = (REPO / "supabase" / "migrations" / "0110_marketing_promo_custom.sql").read_text(encoding="utf-8")
CODE = "\n".join(line.split("--", 1)[0] for line in SQL.splitlines())
PREVIOUS = (REPO / "supabase" / "migrations" / "0108_marketing_posts.sql").read_text(encoding="utf-8")
ROLLBACK = (REPO / "docs" / "sql" / "rollback_0110_marketing_promo_custom.sql").read_text(encoding="utf-8")

NEW_FUNCTIONS = {"owner_marketing_create", "marketing_draft_upsert_v2"}
PERMITTED_REDEFINITION = {"audit_action_allowed"}
#: What the live worker, the owner page and the operator bot call: 0110 must not redefine any of it.
LEFT_ALONE = {"marketing_posts_guard", "marketing_texts_ok", "marketing_post_hash", "marketing_cap_used",
              "marketing_posts_no_delete", "marketing_settings_no_delete", "marketing_settings_stamp",
              "marketing_settings_trail", "owner_marketing_get", "owner_marketing_edit", "owner_marketing_approve",
              "owner_marketing_reject", "owner_marketing_kill", "marketing_draft_upsert", "claim_marketing_post",
              "complete_marketing_post", "operator_marketing_summary"}
REUSED = {"owner_guard", "owner_audit", "owner_err", "admin_aal_ok", "take_web_rate", "security_event_log",
          "is_platform_admin", "default_org_id"}


def audit_list(text):
    block = re.search(r"create or replace function public\.audit_action_allowed.*?any \(array\[(.*?)\]::text\[\]\)", text, re.S).group(1)
    return set(re.findall(r"'([a-z_.]+)'", block))


def body(name):
    return re.search(rf"create or replace function public\.{name}\(.*?\n\$\$;", CODE, re.S).group(0)


class MarketingPromoCustomMigration(unittest.TestCase):
    def test_it_creates_exactly_two_functions_and_redefines_only_the_audit_list(self):
        defined = set(re.findall(r"create or replace function public\.(\w+)", CODE))
        self.assertEqual(defined, NEW_FUNCTIONS | PERMITTED_REDEFINITION)
        self.assertEqual(defined & (LEFT_ALONE | REUSED), set())

    def test_it_creates_no_table_trigger_policy_index_or_column_and_removes_nothing(self):
        self.assertIsNone(re.search(r"create table|create (unique )?index|create trigger|create policy|add column|drop column|"
                                    r"alter policy|drop policy|drop trigger|drop table|drop function|drop index|alter function|"
                                    r"alter table [^;]* rename|truncate|enable row level|disable row level|create extension", CODE, re.I))
        # the only table it alters is the posts table, and only by dropping then adding one of its CHECK constraints
        self.assertEqual(set(re.findall(r"alter table public\.(\w+)", CODE)), {"marketing_posts"})
        for stmt in re.findall(r"alter table public\.marketing_posts [^;]*;", CODE):
            self.assertRegex(stmt, r"drop constraint if exists marketing_posts_(kind|source|key_shape)_check;|"
                                   r"add constraint marketing_posts_(kind|source|key_shape)_check\s+check", stmt)
        self.assertEqual(sorted(re.findall(r"add constraint (\w+)", CODE)),
                         ["marketing_posts_key_shape_check", "marketing_posts_kind_check", "marketing_posts_source_check"])
        for stmt in (m.group(0) for m in re.finditer(r"^(?:update|delete|insert|truncate)\b[^;]*", CODE, re.M)):
            self.fail(f"a top-level statement writes data: {stmt[:80]}")
        self.assertRegex(CODE, r"(?m)^set local lock_timeout = '5s';")
        self.assertNotRegex(CODE, r"(?m)^set (?!local)")

    def test_it_never_touches_the_switch_the_cap_or_the_settings(self):
        self.assertNotRegex(CODE, r"marketing_settings")
        self.assertNotIn("marketing_cap_used", CODE)
        self.assertNotIn("max_per_7d", CODE)
        self.assertNotIn("pg_advisory", CODE)

    def test_the_widened_kind_list_keeps_every_old_kind_and_adds_exactly_two(self):
        self.assertIn("check (kind in ('news', 'showcase', 'price', 'promo', 'custom'))", CODE)
        old = set(re.findall(r"'(\w+)'", re.search(r"check \(kind in \((.*?)\)\)", PREVIOUS).group(1)))
        new = set(re.findall(r"'(\w+)'", re.search(r"marketing_posts_kind_check\s+check \(kind in \((.*?)\)\)", CODE).group(1)))
        self.assertEqual((old, new - old), ({"news", "showcase", "price"}, {"promo", "custom"}))
        # the old source shapes are kept verbatim inside the widened check
        for shape in (r"kind = 'news' and source_ref ~ '^pr:#[0-9]{1,7}$'", r"kind = 'price' and source_ref ~ '^plan:[a-z0-9_.:,-]{1,100}$'",
                      r"kind = 'showcase' and source_ref ~ '^asset:[0-9a-f-]{36}$'"):
            self.assertIn(shape, CODE)
            self.assertIn(shape, PREVIOUS)
        self.assertIn(r"kind = 'promo' and source_ref ~ '^promo:[a-z0-9-]{1,60}$'", CODE)
        self.assertIn(r"kind = 'custom' and source_ref ~ '^owner:[0-9a-f-]{36}$'", CODE)
        # still only Telegram: the target CHECK is not touched
        self.assertNotIn("marketing_posts_target_check", CODE)

    def test_the_two_new_keys_are_checked_for_their_shape(self):
        self.assertIn("kind <> 'promo' or idempotency_key = source_ref || ':' || target", CODE)
        self.assertIn(r"idempotency_key ~ ('^custom:[A-Za-z0-9_-]{16,64}:' || target || '$')", CODE)

    def test_the_grants_are_exactly_one_per_new_function_and_no_api_role_keeps_a_default(self):
        grants = re.findall(r"^grant\s+(.*?)\s+on\s+function\s+public\.(\w+)\(([^)]*)\)\s+to\s+([a-z_, ]+);", CODE, re.M | re.S)
        self.assertEqual({(g[0], g[1], g[3].strip()) for g in grants},
                         {("execute", "owner_marketing_create", "authenticated"), ("execute", "marketing_draft_upsert_v2", "service_role")})
        self.assertEqual(len(grants), 2)
        for fn in NEW_FUNCTIONS | PERMITTED_REDEFINITION:
            self.assertRegex(CODE, rf"revoke all on function public\.{fn}\([^)]*\)\s+from public, anon, authenticated, service_role;", fn)
        for m in re.finditer(r"^grant\s.*?;", CODE, re.M | re.S):
            self.assertNotRegex(m.group(0), r"\banon\b|\bto\s+public\b", m.group(0))
        # the revokes and grants name only the new functions and the redefined one
        for m in re.finditer(r"^(?:grant|revoke)\s.*?on\s+function\s+public\.(\w+)", CODE, re.M | re.S):
            self.assertIn(m.group(1), NEW_FUNCTIONS | PERMITTED_REDEFINITION, m.group(0)[:80])
        self.assertNotRegex(CODE, r"on public\.marketing_posts")      # no table privilege is changed

    def test_every_new_function_is_a_definer_that_pins_its_search_path_with_pg_temp_last(self):
        for name in sorted(NEW_FUNCTIONS | PERMITTED_REDEFINITION):
            self.assertIn("set search_path = public, pg_temp", body(name).split("$$")[0], name)
        definers = set(re.findall(r"create or replace function public\.(\w+)\([^$]*?security definer", CODE, re.S))
        self.assertEqual(definers, NEW_FUNCTIONS)

    def test_the_owner_function_goes_through_the_same_front_door_as_the_edit(self):
        fn = body("owner_marketing_create")
        self.assertRegex(fn, r"g := public\.owner_guard\('marketing_create', \d+\);\s+if g is not null then return g; end if;")
        edit = body_of(PREVIOUS, "owner_marketing_edit")
        self.assertRegex(edit, r"g := public\.owner_guard\('marketing_edit', \d+\);")
        self.assertLess(fn.index("owner_guard"), fn.index("insert into public.marketing_posts"))
        self.assertIn("public.marketing_texts_ok(v_texts, false)", fn)
        self.assertIn("public.owner_audit('marketing.create'", fn)
        self.assertNotIn("auth.uid() is null", fn)    # the guard does that, once, in one place
        self.assertIn("p_kind is distinct from 'custom'", fn)
        self.assertIn("on conflict (idempotency_key) do nothing", fn)

    def test_the_owner_function_can_only_make_a_draft(self):
        fn = body("owner_marketing_create")
        insert = re.search(r"insert into public\.marketing_posts \((.*?)\)\s+values", fn, re.S).group(1)
        self.assertEqual([c.strip() for c in insert.split(",")], ["idempotency_key", "kind", "target", "texts", "link", "source_ref"])
        for word in ("status", "approved", "expires_at", "sent_at", "claimed", "media_path", "edited"):
            self.assertNotIn(word, insert)
        self.assertNotRegex(fn, r"update public\.marketing_posts|set status|approved_hash")
        self.assertIn("'custom', 'telegram'", fn)

    def test_the_worker_function_uses_no_caller_identity_and_hands_news_and_price_to_0108(self):
        fn = body("marketing_draft_upsert_v2")
        self.assertNotIn("auth.uid()", fn)
        self.assertIn("p_kind not in ('news', 'price', 'promo')", fn)
        self.assertIn("return public.marketing_draft_upsert(p_idempotency_key, p_kind, p_texts, p_source_ref, p_facts, p_facts_as_of,", fn)
        self.assertIn("p.status = 'draft' and p.edited_at is null", fn)
        # same arguments, same order, as the function it sits beside
        sig = lambda text, name: re.sub(r"\s+", " ", re.search(rf"function public\.{name}\((.*?)\) returns jsonb", text, re.S).group(1))
        self.assertEqual(sig(SQL, "marketing_draft_upsert_v2"), sig(PREVIOUS, "marketing_draft_upsert"))

    def test_the_audit_list_is_0108s_plus_exactly_one_name_and_the_regex_families_are_kept(self):
        old, new = audit_list(PREVIOUS), audit_list(SQL)
        self.assertTrue(old <= new, sorted(old - new))
        self.assertEqual(new - old, {"marketing.create"})
        self.assertGreaterEqual(len(old), 78)
        self.assertIn(r"'^social\.(instagram|tiktok)\.(connect|connect_failed|disconnect)$'", SQL)
        self.assertIn(r"'^learning\.(approve|reject)$'", SQL)
        # nothing but the new name and its comment differs from 0108's body
        norm = lambda text: re.sub(r"--[^\n]*", "", re.search(r"create or replace function public\.audit_action_allowed.*?\n\$\$;", text, re.S).group(0))
        strip_new = lambda text: re.sub(r"\s+", " ", text.replace("'marketing.create',", ""))
        self.assertEqual(strip_new(norm(SQL)), strip_new(norm(PREVIOUS)))

    def test_every_action_the_functions_audit_is_in_the_list(self):
        written = set(re.findall(r"owner_audit\('([a-z_.]+)'", CODE))
        self.assertEqual(written, {"marketing.create"})
        self.assertTrue(written <= audit_list(SQL))

    def test_the_guards_name_only_what_0107_and_0108_made(self):
        for needle in ("to_regprocedure('public.owner_guard(text, integer)') is null",
                       "to_regprocedure('public.owner_audit(text, text, jsonb, text)') is null",
                       "to_regprocedure('public.owner_err(text, text, jsonb)') is null",
                       "to_regprocedure('public.admin_aal_ok()') is null",
                       "to_regclass('public.marketing_posts') is null",
                       "to_regprocedure('public.marketing_texts_ok(jsonb, boolean)') is null",
                       "to_regprocedure('public.marketing_draft_upsert(text, text, jsonb, text, jsonb, timestamptz, text, text, text)') is null",
                       "to_regprocedure('public.audit_action_allowed(text)') is null"):
            self.assertIn(needle, CODE)

    def test_the_merge_order_and_the_applies_on_merge_warning_are_in_the_header(self):
        header = SQL.split("set local lock_timeout", 1)[0]
        self.assertIn("MERGE ORDER", header)
        self.assertIn("tolerant", header)
        self.assertIn("Merging it to main applies it", header)

    def test_the_rollback_file_removes_the_two_functions_and_restores_0108s_audit_list(self):
        self.assertEqual(audit_list(ROLLBACK), audit_list(PREVIOUS))
        for fn, args in (("owner_marketing_create", r"text, jsonb, text, text"),
                         ("marketing_draft_upsert_v2", r"text, text, jsonb, text, jsonb, timestamptz, text, text, text")):
            self.assertRegex(ROLLBACK, rf"drop function if exists public\.{fn}\({args}\);")
        self.assertRegex(ROLLBACK, r"(?m)^begin;$")
        self.assertRegex(ROLLBACK, r"(?m)^commit;$")
        # it narrows the checks back to 0108's text, and only while no promo or custom row exists
        self.assertIn("if exists (select 1 from public.marketing_posts where kind in ('promo', 'custom'))", ROLLBACK)
        self.assertIn("check (kind in ('news', 'showcase', 'price'))", ROLLBACK)
        self.assertNotRegex(re.sub(r"--[^\n]*", "", ROLLBACK), r"(?im)^\s*(delete|truncate|drop table)\b")

    def test_only_the_new_post_form_calls_owner_marketing_create_and_only_the_worker_calls_the_promo_function(self):
        # The existing allow-lists (tests/test_marketing_posts_migration.py and tests/security/test_sec_marketing_posts.py)
        # match owner_marketing_ and marketing_draft_upsert, which the two new names contain. This one pins the stricter
        # fact for 0110 alone. owner_marketing_create is called by the owner page's "New post" form and nowhere else (the
        # route's own comment, the request parser, the form, and the page's tests). marketing_draft_upsert_v2 is called by
        # NOTHING yet: the promo drafting slice widens this on purpose.
        create_users = {
            "command-center/app/api/marketing/route.ts",
            "command-center/lib/marketing-posts.ts",
            "command-center/components/marketing/NewPostPanel.tsx",
            "command-center/components/marketing/MarketingBoard.tsx",
        }
        skip = {"node_modules", ".next", "__pycache__", ".git"}
        create, upsert_v2 = [], []
        for root in ("command-center", "modules", "tools", "supabase/functions", ".github", "main.py"):
            base = REPO / root
            if not base.exists():
                continue
            files = [base] if base.is_file() else base.rglob("*")
            for p in files:
                if p.is_file() and not skip & set(p.parts) and p.suffix in (".ts", ".tsx", ".py", ".js", ".yml", ".yaml", ".sql", ".json"):
                    text = p.read_text(encoding="utf-8", errors="ignore")
                    rel = str(p.relative_to(REPO))
                    if "owner_marketing_create" in text:
                        create.append(rel)
                    if "marketing_draft_upsert_v2" in text:
                        upsert_v2.append(rel)
        # the page's own tests (command-center/tests/marketing-*) name the function they pin; nothing else may
        stray = [f for f in create if f not in create_users and not f.startswith("command-center/tests/marketing-")]
        self.assertEqual(stray, [])
        # The poster worker (slice 4) is the one caller of the promo function; no page, route or bot calls it.
        self.assertEqual([f for f in upsert_v2 if not f.startswith("command-center/tests/marketing-")],
                         ["tools/marketing_worker.py"])
        # and the form really is a caller (the guard above would pass vacuously if it were removed)
        self.assertIn("command-center/lib/marketing-posts.ts", create)


def body_of(text, name):
    return re.search(rf"create or replace function public\.{name}\(.*?\n\$\$;", text, re.S).group(0)


if __name__ == "__main__":
    unittest.main()

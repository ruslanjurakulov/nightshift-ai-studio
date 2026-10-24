"""Migration 0117 (Custom Voice), pinned from the file: what the lab cannot see by running it.

* the channels guard is 0114's body with exactly one block added (the diff the PR shows);
* the audit list is 0116's plus the voice names, nothing else;
* every function is revoked from every API role and granted narrowly; no table is granted to an API role except SELECT to authenticated;
* the migration is dormant: nothing in the application calls its functions, and its only top-level data statements are the backfill
  and the bucket row;
* the word list and the screening patterns in the file are the module's (modules/voice_profiles.py).
"""

import hashlib
import re
import unittest
from pathlib import Path

from modules import voice_profiles as vp

ROOT = Path(__file__).resolve().parent.parent
MIG = ROOT / "supabase" / "migrations"
FILE = MIG / "0117_voice_profiles.sql"
TEXT = FILE.read_text(encoding="utf-8")


def code(sql: str) -> str:
    return "\n".join(line.split("--", 1)[0] for line in sql.splitlines())


def function_body(sql: str, name: str) -> str:
    i = sql.index(f"create or replace function public.{name}")
    return sql[i:sql.index("\n$$;", i) + 4]


def names(sql: str):
    return re.findall(r"(?m)^create or replace function public\.(\w+)\(", sql)


class Numbering(unittest.TestCase):
    def test_it_is_the_highest_migration_and_the_number_is_unique(self):
        numbers = sorted(p.name[:4] for p in MIG.glob("*.sql"))
        self.assertEqual(numbers[-1], "0117")
        self.assertEqual(numbers.count("0117"), 1)

    def test_a_rollback_exists(self):
        self.assertTrue((ROOT / "docs" / "sql" / "rollback_0117_voice_profiles.sql").exists())


class ChannelsGuard(unittest.TestCase):
    def test_it_is_0114s_body_plus_one_marked_block(self):
        old = function_body((MIG / "0114_ai_disclosure_admin_lock.sql").read_text(encoding="utf-8"), "channels_config_guard()")
        new = function_body(TEXT, "channels_config_guard()")
        block = re.search(r"  -- 0117: a custom.*?(?=  if current_user not in)", new, re.S)
        self.assertIsNotNone(block)
        stripped = new.replace(block.group(0), "")
        stripped = stripped.replace("  voice_key text;\n  voice_old jsonb := '{}'::jsonb;\n", "")
        self.assertEqual(stripped, old, "everything outside the 0117 block is 0114's text, character for character")

    def test_the_added_block_runs_before_the_browser_only_return(self):
        new = function_body(TEXT, "channels_config_guard()")
        self.assertLess(new.index("channel_voice_config_problem"), new.index("if current_user not in ('authenticated', 'anon')"))

    def test_the_trigger_is_not_dropped_or_recreated(self):
        c = code(TEXT)
        self.assertNotRegex(c, r"(?i)drop trigger if exists channels_config_guard")
        self.assertNotRegex(c, r"(?i)create trigger channels_config_guard")

    def test_the_pure_validators_are_not_replaced(self):
        c = code(TEXT)
        for n in ("creative_params_problem", "render_job_params_valid", "create_creative_job", "creative_price", "render_jobs_payment_guard"):
            self.assertNotIn(f"function public.{n}", c, n)


class DriftGuard(unittest.TestCase):
    """The file refuses to replace a live body it has not seen (the 0064/0103 lesson). The four md5 values in it are the repo's."""

    @staticmethod
    def body(sql, start):
        i = sql.index(start)
        a = sql.index("$$", i) + 2
        return sql[a:sql.index("$$", a)]

    @staticmethod
    def h(b):
        return hashlib.md5(re.sub(r"\s+", " ", b).encode()).hexdigest()

    def test_the_hashes_in_the_file_are_those_of_0114_0116_and_0117s_own_bodies(self):
        g = "create or replace function public.channels_config_guard() returns trigger"
        a = "create or replace function public.audit_action_allowed(p_action text) returns boolean"
        want = {
            self.h(self.body((MIG / "0114_ai_disclosure_admin_lock.sql").read_text(encoding="utf-8"), g)),
            self.h(self.body(TEXT, g)),
            self.h(self.body((MIG / "0116_visibility_requests.sql").read_text(encoding="utf-8"), a)),
            self.h(self.body(TEXT, a)),
        }
        found = set(re.findall(r"'([0-9a-f]{32})'", code(TEXT.split("1. Pure helpers", 1)[0])))
        self.assertEqual(found, want)

    def test_the_check_runs_before_anything_is_replaced_and_raises(self):
        head = TEXT.split("1. Pure helpers", 1)[0]
        self.assertIn("g <> all (array[", head)
        self.assertIn("a <> all (array[", head)
        self.assertEqual(head.count("that is neither"), 2)
        self.assertLess(TEXT.index("0117 found a channels_config_guard"), TEXT.index("create or replace function public.channels_config_guard()"))


class AttachWritesOnlyTheVoiceKeys(unittest.TestCase):
    def test_attach_voice_to_channel_writes_the_voice_key_and_only_ever_raises_the_voice_declaration(self):
        body = function_body(TEXT, "attach_voice_to_channel(")
        upd = body.split("update public.channels", 1)[1].split("where channel_id", 1)[0]
        self.assertIn("jsonb_build_object(k, pr.provider_voice_id)", upd)
        self.assertIn("jsonb_build_object('ai_disclosure_voice', 'own_clone')", upd)
        self.assertIn("not in ('generic', 'own_clone')", upd, "a stricter declaration is kept")
        self.assertNotRegex(code(body), r"'ai_disclosure'(?!_)")
        self.assertEqual(len(re.findall(r"(?is)\bupdate\s+public\.channels\b", code(TEXT))), 1)


class AuditList(unittest.TestCase):
    @staticmethod
    def actions(sql):
        body = function_body(sql, "audit_action_allowed(p_action text)")
        block = re.search(r"coalesce\(p_action, ''\) = any \(array\[(.*?)\]::text\[\]\)", body, re.S).group(1)
        return set(re.findall(r"'([a-z_.]+)'", code(block))), body

    def test_it_is_0116s_list_plus_the_voice_names(self):
        old, old_body = self.actions((MIG / "0116_visibility_requests.sql").read_text(encoding="utf-8"))
        new, new_body = self.actions(TEXT)
        self.assertEqual(new - old, {"voice.clone_request", "voice.clone_result", "voice.approve", "voice.attach", "voice.detach",
                                     "voice.delete", "voice.sample_delete", "voice.purge"})
        self.assertEqual(old - new, set())
        # the two patterns after the list are kept
        for pattern in ("social\\.(instagram|tiktok)", "learning\\.(approve|reject)"):
            self.assertIn(pattern, new_body)

    def test_every_action_the_file_writes_is_in_the_list(self):
        listed, _ = self.actions(TEXT)
        written = set()
        for m in re.finditer(r"insert into public\.app_audit_log.*?values\s*\((.*?)\)\s*;", code(TEXT), re.S | re.I):
            written.update(re.findall(r"'([a-z_]+\.[a-z_.]+)'", m.group(1)))
        self.assertEqual(written, {"voice.clone_request", "voice.clone_result", "voice.approve", "voice.attach", "voice.detach",
                                   "voice.delete", "voice.sample_delete", "voice.purge"})
        self.assertTrue(written <= listed)


class Privileges(unittest.TestCase):
    def test_every_function_is_revoked_from_every_api_role(self):
        c = code(TEXT)
        for name in set(names(c)):
            self.assertRegex(c, rf"revoke all on function public\.{name}\([^)]*\)\s+from public, anon, authenticated, service_role;", name)

    def test_who_is_granted_what(self):
        c = code(TEXT)
        grants = {(m.group(1), m.group(2)) for m in re.finditer(r"grant execute on function public\.(\w+)\([^)]*\) to ([a-z_, ]+);", c)}
        self.assertEqual(grants, {
            ("channel_voice_config_problem", "authenticated, service_role"),
            ("my_voice_ref", "authenticated"), ("approve_voice", "authenticated"), ("voice_sample_slot_free", "authenticated"),
            ("attach_voice_to_channel", "authenticated"), ("detach_voice_from_channel", "authenticated"),
            ("delete_voice", "authenticated"), ("delete_voice_sample", "authenticated"),
            ("claim_voice_job", "service_role"), ("finish_voice_clone", "service_role"), ("finish_voice_task", "service_role"),
            ("purge_voice_records", "service_role"),
        })

    def test_B1_request_voice_clone_is_granted_to_nobody(self):
        c = code(TEXT)
        self.assertRegex(c, r"revoke all on function public\.request_voice_clone\(")
        self.assertNotRegex(c, r"grant execute on function public\.request_voice_clone")
        self.assertIn("Hard gate", TEXT)

    def test_nothing_is_granted_to_anon_or_public(self):
        for m in re.finditer(r"(?i)grant [^;]*? to ([^;]*);", code(TEXT)):
            self.assertNotRegex(m.group(1), r"(?i)\b(anon|public)\b", m.group(0))

    def test_tables_are_closed_except_select_for_authenticated(self):
        c = code(TEXT)
        table_grants = re.findall(r"grant ([a-z, ]+) on (public\.[a-z_,\s.]+?)\s+to ([a-z_, ]+);", c)
        self.assertEqual(len(table_grants), 1)
        self.assertEqual(table_grants[0][0].strip(), "select")
        self.assertEqual(table_grants[0][2].strip(), "authenticated")
        self.assertNotIn("voice_clone_jobs", table_grants[0][1])
        self.assertNotIn("voice_deletion_records", table_grants[0][1])
        self.assertRegex(c, r"revoke all on public\.user_voice_refs, public\.voice_profiles, public\.voice_consents, public\.voice_deletion_records,\s+public\.voice_clone_jobs, public\.voice_channel_attachments\s+from public, anon, authenticated, service_role;")

    def test_every_definer_pins_its_search_path(self):
        c = code(TEXT)
        for m in re.finditer(r"create or replace function public\.(\w+)\(.*?\n\$\$;", c, re.S):
            head = m.group(0).split("$$", 1)[0]
            if "security definer" in head:
                self.assertIn("set search_path = public, pg_temp", head, m.group(1))
        self.assertGreaterEqual(len(re.findall("security definer", c)), 15)

    def test_every_table_has_rls_on(self):
        c = code(TEXT)
        tables = re.findall(r"create table if not exists public\.(\w+)", c)
        self.assertEqual(len(tables), 6)
        for t in tables:
            self.assertIn(f"alter table public.{t} enable row level security;", c, t)

    def test_only_the_owners_own_rows_are_readable(self):
        policies = re.findall(r"create policy (\w+) on public\.(\w+)\s+for select to authenticated using \(user_id = \(select auth\.uid\(\)\)\);", code(TEXT))
        self.assertEqual({t for _, t in policies}, {"user_voice_refs", "voice_profiles", "voice_consents", "voice_channel_attachments"})

    def test_the_bucket(self):
        c = code(TEXT)
        self.assertIn("'voice-samples', 'voice-samples', false, 52428800", c)
        self.assertIn("public = false", c)
        mimes = re.search(r"allowed_mime_types = array\[(.*?)\]", c, re.S).group(1)
        self.assertTrue(all(m.startswith("'audio/") for m in re.findall(r"'[^']+'", mimes)))
        self.assertEqual(len(re.findall(r"as restrictive for", c)), 4)
        self.assertNotRegex(c, r"(?i)create policy [^;]*for (select|update|delete)[^;]*permissive")
        self.assertEqual(len(re.findall(r"(?i)create policy \w+ on storage\.objects\s+for (select|update|delete|all)", c)), 0,
                         "no permissive read/update/delete policy for the bucket")


class Dormant(unittest.TestCase):
    def test_the_only_top_level_data_statements_are_the_backfill_and_the_bucket(self):
        c = code(TEXT)
        # strip function bodies, then look at what is left at the top level
        top = re.sub(r"\$\$.*?\$\$", "", c, flags=re.S)
        stmts = [s.strip() for s in top.split(";")]
        dml = [s for s in stmts if re.match(r"(?i)(insert|update|delete)\b", s)]
        self.assertEqual(len(dml), 2, dml)
        self.assertTrue(dml[0].startswith("insert into public.user_voice_refs"))
        self.assertTrue(dml[1].startswith("insert into storage.buckets"))

    def test_nothing_calls_a_provider(self):
        c = code(TEXT).lower()
        for needle in ("net.http", "pg_net", "http_post", "http_get", "elevenlabs.io", "xi-api-key", "dblink", "copy "):
            self.assertNotIn(needle, c)

    def test_nothing_in_the_application_calls_the_new_functions(self):
        fns = ["request_voice_clone", "approve_voice", "attach_voice_to_channel", "detach_voice_from_channel", "delete_voice",
               "claim_voice_job", "finish_voice_clone", "finish_voice_task", "purge_voice_records", "my_voice_ref", "voice_usable_by"]
        provider_module = ROOT / "modules" / "voice_profiles.py"  # its delete_voice is the PROVIDER method, not the database function
        for base in ("command-center/app", "command-center/lib", "command-center/components", "tools", "modules", "main.py", ".github", "deploy"):
            p = ROOT / base
            files = [p] if p.is_file() else [f for f in p.rglob("*") if f.is_file() and f.suffix in (".ts", ".tsx", ".py", ".yml", ".yaml", ".sh", ".js")]
            for f in files:
                if f == provider_module:
                    continue
                text = f.read_text(encoding="utf-8", errors="ignore")
                for fn in fns:
                    self.assertIsNone(re.search(rf"\b{fn}\b", text), f"{f.relative_to(ROOT)} mentions {fn}: the migration ships dormant")

    def test_the_migration_declares_the_dormant_boundary(self):
        self.assertIn("FREE plan", TEXT)
        self.assertIn("NOTHING LIVE CAN RUN", TEXT)


class Parity(unittest.TestCase):
    def sql_array(self, name):
        body = function_body(TEXT, f"{name}()")
        arr = re.search(r"select array\[(.*?)\]::text\[\]", body, re.S).group(1)
        return [s.replace("''", "'") for s in re.findall(r"'((?:[^']|'')*)'", arr)]

    def test_the_word_list_is_the_modules(self):
        self.assertEqual(self.sql_array("voice_phrase_words"), list(vp.PHRASE_WORDS))

    def test_the_screening_patterns_are_the_modules(self):
        self.assertEqual(self.sql_array("voice_real_person_patterns"), list(vp.REAL_PERSON_PATTERNS))

    def test_the_declaration_keys(self):
        keys = {"own_voice", "sole_speaker", "over_18", "voice_data_to_provider", "no_impersonation"}
        body = function_body(TEXT, "voice_declarations_problem(p jsonb)")
        self.assertEqual(set(re.findall(r"'([a-z_0-9]+)'", body)) & (keys | {"x"}), keys)

    def test_the_limits_in_the_migration_are_the_documented_ones(self):
        body = function_body(TEXT, "request_voice_clone(")
        self.assertIn("daily   constant integer := 5;", body)
        self.assertIn("slots   constant integer := 3;", body)
        docs = (ROOT / "docs" / "CUSTOM_VOICE.md")
        if docs.exists():
            text = docs.read_text(encoding="utf-8")
            self.assertIn("5 requests", text)
            self.assertIn("3 live voices", text)


if __name__ == "__main__":
    unittest.main()

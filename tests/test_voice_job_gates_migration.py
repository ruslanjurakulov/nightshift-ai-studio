"""Migration 0121 (Custom Voice: the queue gates G2 and G3, and the oracle), pinned from the file: what the lab cannot see by running it.

* claim_voice_job is 0117's body character for character plus ONE marked block; channel_voice_config_problem_core is 0117's
  channel_voice_config_problem body character for character (so nothing of the old rule was edited, only wrapped);
* the six md5 values in the drift guard are those of the bodies in the repo (0117's two and this file's four);
* the rollback restores 0117's two functions byte for byte and carries the same hashes;
* every function is revoked from every API role and granted narrowly; request_voice_clone is not granted and the strict-gate switch is
  not touched; no row of any table is written at the top level;
* only the voice worker (modules/voice_worker.py, tools/voice_worker.py) mentions the two new service-role functions.
"""

import hashlib
import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MIG = ROOT / "supabase" / "migrations"
FILE = MIG / "0121_voice_job_gates.sql"
TEXT = FILE.read_text(encoding="utf-8")
M117 = (MIG / "0117_voice_profiles.sql").read_text(encoding="utf-8")
ROLLBACK = (ROOT / "docs" / "sql" / "rollback_0121_voice_job_gates.sql").read_text(encoding="utf-8")


def code(sql: str) -> str:
    return "\n".join(line.split("--", 1)[0] for line in sql.splitlines())


def function(sql: str, name: str) -> str:
    i = sql.index(f"create or replace function public.{name}")
    return sql[i:sql.index("\n$$;", i) + 4]


def body(fn: str) -> str:
    a = fn.index("$$") + 2
    return fn[a:fn.index("$$", a)]


def h(b: str) -> str:
    return hashlib.md5(re.sub(r"\s+", " ", b).encode()).hexdigest()


class Numbering(unittest.TestCase):
    def test_the_number_is_unique_and_0118_is_still_unused(self):
        numbers = sorted(p.name[:4] for p in MIG.glob("*.sql"))
        self.assertEqual(numbers.count("0121"), 1)
        self.assertNotIn("0118", numbers)

    def test_a_rollback_exists_and_is_one_transaction(self):
        self.assertRegex(ROLLBACK, r"(?m)^begin;$")
        self.assertRegex(ROLLBACK, r"(?m)^commit;$")

    def test_the_file_says_it_is_applied_as_one_transaction(self):
        self.assertIn("APPLY AS ONE TRANSACTION", TEXT)
        self.assertIn("set local lock_timeout", TEXT)
        self.assertNotRegex(code(TEXT), r"(?im)^\s*(begin|commit)\s*;")


class ClaimVoiceJob(unittest.TestCase):
    def test_it_is_0117s_body_plus_one_marked_block(self):
        old = function(M117, "claim_voice_job(")
        new = function(TEXT, "claim_voice_job(")
        block = re.search(r"  -- 0121 \(G2\).*?(?=  -- lost workers\n)", new, re.S)
        self.assertIsNotNone(block)
        self.assertEqual(new.replace(block.group(0), ""), old, "everything outside the 0121 block is 0117's text, character for character")

    def test_the_block_runs_after_the_upload_window_and_before_the_lease_sweep(self):
        new = function(TEXT, "claim_voice_job(")
        self.assertLess(new.index("-- lapse"), new.index("-- 0121 (G2)"))
        self.assertLess(new.index("-- 0121 (G2)"), new.index("-- lost workers"))

    def test_the_block_touches_only_deleted_and_rejected_profiles_and_never_a_clone_that_is_still_leased(self):
        block = re.search(r"  -- 0121 \(G2\).*?(?=  -- lost workers\n)", function(TEXT, "claim_voice_job("), re.S).group(0)
        c = code(block)
        self.assertIn("p.status in ('deleted', 'rejected')", c)
        self.assertIn("q.kind = 'clone'", c)
        self.assertIn("q.heartbeat_at < now() - interval '30 minutes'", c)
        self.assertEqual(len(re.findall(r"(?i)\bupdate public\.", c)), 2)
        self.assertEqual(len(re.findall(r"(?i)\binsert into public\.", c)), 2)
        self.assertNotRegex(c, r"(?i)\bdelete from\b")
        self.assertNotIn("'testing'", c)
        self.assertNotIn("'approved'", c)

    def test_it_is_still_a_definer_with_a_pinned_search_path(self):
        head = function(TEXT, "claim_voice_job(").split("$$", 1)[0]
        self.assertIn("security definer set search_path = public, pg_temp", head)


class Oracle(unittest.TestCase):
    def test_the_core_is_0117s_channel_voice_config_problem_body_character_for_character(self):
        old = function(M117, "channel_voice_config_problem(")
        core = function(TEXT, "channel_voice_config_problem_core(")
        self.assertEqual(body(core), body(old))
        self.assertEqual(core.replace("channel_voice_config_problem_core(", "channel_voice_config_problem(", 1), old,
                         "the header is the same too: the name is the only difference")

    def test_the_wrapper_keeps_the_signature_the_guard_and_the_route_call(self):
        wrapper = function(TEXT, "channel_voice_config_problem(p_channel")
        self.assertIn("channel_voice_config_problem(p_channel text, p_org uuid, p_old jsonb, p_new jsonb)", wrapper)
        self.assertIn("returns text", wrapper)
        self.assertIn("stable security definer set search_path = public, pg_temp", wrapper)

    def test_the_exact_answer_goes_to_the_service_role_and_the_guard_only(self):
        c = code(body(function(TEXT, "channel_voice_config_problem(p_channel")))
        trusted = c.index("public.credits_trusted_caller() or pg_trigger_depth() > 0")
        loop = c.index("foreach key in array keys loop")
        self.assertLess(trusted, loop)
        # the trusted path hands the WHOLE request to the core and returns its answer; nothing else does
        self.assertIn("return public.channel_voice_config_problem_core(p_channel, p_org, p_old, p_new);", c[trusted:loop])
        self.assertEqual(c.count("channel_voice_config_problem_core("), 2)

    def test_everybody_else_is_asked_one_key_at_a_time_and_masked_per_key(self):
        c = code(body(function(TEXT, "channel_voice_config_problem(p_channel")))
        loop = c[c.index("foreach key in array keys loop"):]
        self.assertIn("keys    constant text[] := array['elevenlabs_voice_id', 'elevenlabs_secondary_voice_id'];", c)
        # a single-key old and new, built only from keys that are present
        self.assertIn("one_old := case when o ? key then jsonb_build_object(key, o -> key) else '{}'::jsonb end;", loop)
        self.assertIn("one_new := case when n ? key then jsonb_build_object(key, n -> key) else '{}'::jsonb end;", loop)
        self.assertIn("r := public.channel_voice_config_problem_core(p_channel, p_org, one_old, one_new);", loop)
        # the profile of THIS key, and the one masked return
        self.assertIn("v := public.voice_id_norm(n -> key);", loop)
        self.assertIn("if r is not null and not (is_one and not visible) then\n      return r;", loop)
        self.assertIn("voice_caller_member(ch_org, 'viewer')", c)
        self.assertIn("pr.user_id = auth.uid() or pr.org_id = ch_org", loop)
        self.assertEqual(len(re.findall(r"return r;", c)), 1)
        self.assertTrue(c.rstrip().endswith("return null;\nend"))

    def test_the_membership_is_the_channels_own_organization_never_the_one_the_caller_passes(self):
        c = code(body(function(TEXT, "channel_voice_config_problem(p_channel")))
        self.assertIn("select c.org_id into ch_org from public.channels c where c.channel_id = p_channel", c)
        self.assertNotRegex(c, r"voice_caller_member\(p_org")
        self.assertNotRegex(c, r"pr\.org_id = p_org")

    def test_the_channels_guard_is_not_replaced_here(self):
        c = code(TEXT)
        self.assertNotIn("function public.channels_config_guard", c)
        self.assertNotRegex(c, r"(?i)(drop|create) trigger")


class DriftGuard(unittest.TestCase):
    """The file refuses to replace a live body it has not seen (the 0064/0103 lesson). The hashes in it are the repo's."""

    def test_the_six_hashes_are_0117s_two_bodies_and_this_files_four(self):
        want = {
            h(body(function(M117, "claim_voice_job("))),
            h(body(function(TEXT, "claim_voice_job("))),
            h(body(function(M117, "channel_voice_config_problem("))),
            h(body(function(TEXT, "channel_voice_config_problem(p_channel"))),
            h(body(function(TEXT, "voice_requeue_overdue("))),
            h(body(function(TEXT, "voice_overdue_report("))),
        }
        head = TEXT.split("1. ORACLE", 1)[0]
        found = set(re.findall(r"'([0-9a-f]{32})'", code(head)))
        self.assertEqual(found, want)
        self.assertEqual(len(want), 6)

    def test_the_check_runs_before_anything_is_replaced_and_raises(self):
        head = TEXT.split("1. ORACLE", 1)[0]
        self.assertIn("c <> all (array[", head)
        self.assertIn("p <> all (array[", head)
        self.assertEqual(head.count("that is neither"), 2)
        self.assertEqual(head.count("that is not 0121''s body"), 3)
        self.assertLess(TEXT.index("0121 found a claim_voice_job"), TEXT.index("create or replace function public.claim_voice_job"))
        self.assertLess(TEXT.index("0121 found a channel_voice_config_problem()"), TEXT.index("create or replace function public.channel_voice_config_problem"))

    def test_the_rollback_carries_the_same_hashes_and_0117s_bodies_byte_for_byte(self):
        head = TEXT.split("1. ORACLE", 1)[0]
        pairs = re.findall(r"array\['([0-9a-f]{32})', '([0-9a-f]{32})'\]", head)
        self.assertEqual(re.findall(r"array\['([0-9a-f]{32})', '([0-9a-f]{32})'\]", ROLLBACK), pairs)
        self.assertEqual(function(ROLLBACK, "claim_voice_job("), function(M117, "claim_voice_job("))
        self.assertEqual(function(ROLLBACK, "channel_voice_config_problem("), function(M117, "channel_voice_config_problem("))
        self.assertLess(ROLLBACK.index("create or replace function public.channel_voice_config_problem("),
                        ROLLBACK.index("drop function if exists public.channel_voice_config_problem_core"))


class Privileges(unittest.TestCase):
    NAMES = {"channel_voice_config_problem_core", "channel_voice_config_problem", "claim_voice_job", "voice_requeue_overdue", "voice_overdue_report"}

    def test_the_file_replaces_or_adds_exactly_these_functions(self):
        self.assertEqual(set(re.findall(r"(?m)^create or replace function public\.(\w+)\(", code(TEXT))), self.NAMES)

    def test_every_function_is_revoked_from_every_api_role(self):
        c = code(TEXT)
        for name in self.NAMES:
            self.assertRegex(c, rf"revoke all on function public\.{name}\([^)]*\)\s+from public, anon, authenticated, service_role;", name)

    def test_who_is_granted_what(self):
        c = code(TEXT)
        grants = {(m.group(1), m.group(2)) for m in re.finditer(r"grant execute on function public\.(\w+)\([^)]*\) to ([a-z_, ]+);", c)}
        self.assertEqual(grants, {("channel_voice_config_problem", "authenticated, service_role"), ("claim_voice_job", "service_role"),
                                  ("voice_requeue_overdue", "service_role"), ("voice_overdue_report", "service_role")})

    def test_the_rollback_regrants_what_0117_granted(self):
        c = code(ROLLBACK)
        grants = {(m.group(1), m.group(2)) for m in re.finditer(r"grant execute on function public\.(\w+)\([^)]*\) to ([a-z_, ]+);", c)}
        self.assertEqual(grants, {("channel_voice_config_problem", "authenticated, service_role"), ("claim_voice_job", "service_role")})

    def test_nothing_is_granted_to_anon_or_public(self):
        for sql in (TEXT, ROLLBACK):
            for m in re.finditer(r"(?i)grant [^;]*? to ([^;]*);", code(sql)):
                self.assertNotRegex(m.group(1), r"(?i)\b(anon|public)\b", m.group(0))

    def test_request_voice_clone_and_the_strict_gate_are_not_touched(self):
        c = code(TEXT) + code(ROLLBACK)
        self.assertNotIn("request_voice_clone", c)
        self.assertNotIn("VOICE_GATE_STRICT", c)
        self.assertNotRegex(c, r"(?i)grant [^;]*request_voice_clone")

    def test_every_definer_pins_its_search_path(self):
        c = code(TEXT)
        for m in re.finditer(r"create or replace function public\.(\w+)\(.*?\n\$\$;", c, re.S):
            head = m.group(0).split("$$", 1)[0]
            if "security definer" in head:
                self.assertIn("set search_path = public, pg_temp", head, m.group(1))
        self.assertEqual(len(re.findall("security definer", c)), 5)


class Dormant(unittest.TestCase):
    def test_no_row_of_any_table_is_written_at_the_top_level(self):
        top = re.sub(r"\$\$.*?\$\$", "", code(TEXT), flags=re.S)
        stmts = [s.strip() for s in top.split(";")]
        self.assertEqual([s for s in stmts if re.match(r"(?i)(insert|update|delete|truncate|alter|create (table|index|trigger|policy))\b", s)], [])

    def test_nothing_calls_a_provider(self):
        c = code(TEXT).lower()
        for needle in ("net.http", "pg_net", "http_post", "http_get", "elevenlabs.io", "xi-api-key", "dblink", "copy "):
            self.assertNotIn(needle, c)

    def test_requeue_is_bounded_and_never_names_a_clone(self):
        fn = code(function(TEXT, "voice_requeue_overdue("))
        self.assertIn("cap     constant integer := 20;", fn)
        self.assertIn("limit cap", fn)
        self.assertIn("skip locked", fn)
        self.assertIn("q.kind in ('purge_sample', 'delete_provider')", fn)
        self.assertNotIn("'clone'", fn)
        self.assertIn("extract(year from p_older_than) <> 0 or extract(month from p_older_than) <> 0", fn)
        self.assertIn("secs < 3600 or secs > 2592000", fn)
        self.assertIn("cutoff := now() - make_interval(secs => secs);", fn)
        self.assertIn("exception when unique_violation then", fn)
        self.assertIn("p.status = 'deleted' and p.provider_voice_id is not null", fn)
        self.assertIn("p.sample_state = 'purge_pending' and p.status <> 'pending_verification'", fn)
        self.assertEqual(len(re.findall(r"(?i)\bupdate public\.", fn)), 1)
        self.assertNotRegex(fn, r"(?i)\b(insert into|delete from)\b")

    def test_the_report_returns_numbers_only(self):
        fn = code(function(TEXT, "voice_overdue_report("))
        for forbidden in ("profile_id", "user_id", "q.id", "error_code", "owner_ref", "provider_voice_id,", "name"):
            self.assertNotRegex(fn.split("select jsonb_build_object(", 1)[1], rf"\b{re.escape(forbidden)}\b", forbidden)

    def test_only_the_worker_mentions_the_two_service_role_functions(self):
        allowed = {ROOT / "modules" / "voice_worker.py", ROOT / "tools" / "voice_worker.py"}
        for base in ("command-center/app", "command-center/lib", "command-center/components", "tools", "modules", "main.py", ".github", "deploy"):
            p = ROOT / base
            files = [p] if p.is_file() else [f for f in p.rglob("*") if f.is_file() and f.suffix in (".ts", ".tsx", ".py", ".yml", ".yaml", ".sh", ".js")]
            for f in files:
                if f in allowed:
                    continue
                text = f.read_text(encoding="utf-8", errors="ignore")
                for fn in ("voice_requeue_overdue", "voice_overdue_report", "channel_voice_config_problem_core"):
                    self.assertNotIn(fn, text, f"{f.relative_to(ROOT)} mentions {fn}")

    def test_nothing_starts_the_sweep(self):
        for base in (".github", "deploy"):
            p = ROOT / base
            for f in ([p] if p.is_file() else [f for f in p.rglob("*") if f.is_file()]):
                text = f.read_text(encoding="utf-8", errors="ignore")
                self.assertNotIn("--sweep", text.replace("sweep_stale", ""), f"{f.relative_to(ROOT)} would start the voice sweep")
                self.assertNotIn("voice_worker", text)


if __name__ == "__main__":
    unittest.main()

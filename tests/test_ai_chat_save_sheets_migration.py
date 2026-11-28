"""Migration 0249: the one writer of a Nightshift AI conversation's character sheets and film link. Static checks of the file, its
rollback and the Command Center that calls it; the live behaviour (the merge, the trigger, two connections at once, who may, the
caps, guard, replay, rollback) is in tests/security/test_sec_sheets_writer_0249.py.

What would break without these: the writer growing a write of another BRIEF key, the step or the card (the point is that it writes
two keys only); a grant to anon or the service role; the shape helper or the trigger function callable by an API role; 0199's body
replaced after all; a backslash the live apply path rewrites; or the app calling the writer with a signature the file does not have
(every call a PGRST202, so the race silently stays open).
"""

from __future__ import annotations

import re
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
MIG = REPO / "supabase" / "migrations" / "0249_ai_chat_save_sheets.sql"
ROLLBACK = REPO / "docs" / "sql" / "rollback_0249_ai_chat_save_sheets.sql"
TEXT = MIG.read_text(encoding="utf-8")
ROLLBACK_TEXT = ROLLBACK.read_text(encoding="utf-8")
SIG = "public.ai_chat_save_sheets(uuid, jsonb, jsonb, jsonb)"


def code(text: str) -> str:
    """The SQL with every `--` comment cut (no literal in these files holds two dashes)."""
    return "\n".join(line.split("--", 1)[0] for line in text.splitlines()).lower()


def body(name: str) -> str:
    sql = code(TEXT)
    start = sql.index(f"create or replace function public.{name}(")
    a = sql.index("$$", start) + 2
    return sql[a:sql.index("$$", a)]


class AiChatSaveSheetsMigration(unittest.TestCase):
    def test_one_file_holds_the_number(self):
        self.assertEqual(len(list(MIG.parent.glob("0249_*.sql"))), 1)

    def test_the_writer_is_security_definer_with_a_pinned_path_and_takes_the_row_lock(self):
        sql = code(TEXT)
        self.assertRegex(sql, r"function public\.ai_chat_save_sheets\(p_session uuid, p_sheets jsonb, p_base jsonb, p_film_link jsonb\)\s+"
                              r"returns jsonb\s+language plpgsql volatile security definer set search_path = public, pg_temp")
        b = body("ai_chat_save_sheets")
        self.assertIn("where id = p_session and created_by = v_user for update", b)
        self.assertIn("public.is_org_member(s.org_id, 'editor')", b)

    def test_the_writer_writes_two_keys_only(self):
        b = body("ai_chat_save_sheets")
        updates = re.findall(r"update public\.ai_chat_sessions set ([^;]*?) where", b)
        self.assertEqual(updates, ["brief = v_brief, updated_at = now()"])
        self.assertEqual(sorted(set(re.findall(r"jsonb_set\(v_brief, '\{(\w+)\}'", b))), ["film_link", "ref_sheets"])
        self.assertNotRegex(b, r"set[^;]*\b(step|card|slots|handoff)\s*=")

    def test_grants_only_to_authenticated_and_the_helpers_are_closed(self):
        sql = code(TEXT)
        self.assertIn(f"revoke all on function {SIG} from public, anon, authenticated, service_role;", sql)
        self.assertIn(f"grant execute on function {SIG} to authenticated;", sql)
        self.assertIn("revoke all on function public.ai_chat_sheet_problem(jsonb) from public, anon, authenticated, service_role;", sql)
        self.assertIn("revoke all on function public.ai_chat_sessions_keep_sheets() from public, anon, authenticated, service_role;", sql)
        # Two grants: the writer, and 0199's own grant on the finish_turn it replaces.
        self.assertEqual(re.findall(r"\bgrant execute on function ([^ ]+\([^)]*\)) to authenticated;", sql),
                         ["public.ai_chat_finish_turn(uuid, text, integer, integer, text, jsonb, jsonb, text, jsonb, jsonb)", SIG])
        self.assertEqual(len(re.findall(r"\bgrant ", sql)), 2)

    def test_only_finish_turn_of_0199_is_replaced_and_the_guard_names_the_md5s(self):
        sql = code(TEXT)
        self.assertEqual(sql.count("create or replace function public.ai_chat_finish_turn("), 1)
        for md5 in ("b0420b460b7717b7d084f7a9bdc3e809", "ab9e0cf7f4ee370991fd208128019db5"):
            self.assertIn(md5, TEXT)
            self.assertIn(md5, (REPO / "tests" / "security" / "sec_sheets_writer_0249.py").read_text(encoding="utf-8"))
        self.assertIn("b0420b460b7717b7d084f7a9bdc3e809", ROLLBACK_TEXT)
        for fn in ("ai_chat_save_brief", "ai_chat_start", "ai_chat_reserve_turn", "ai_chat_record_handoff"):
            self.assertNotIn(f"function public.{fn}(", sql, fn)
        self.assertEqual(TEXT.count("16f6ce5d2815675860bbce0a1a1810ac"), 3)  # header, guard, end state
        lab = (REPO / "tests" / "security" / "sec_sheets_writer_0249.py").read_text(encoding="utf-8")
        self.assertIn('"16f6ce5d2815675860bbce0a1a1810ac"', lab)

    def test_the_trigger_keeps_the_stored_keys_unless_the_writer_named_the_row(self):
        b = body("ai_chat_sessions_keep_sheets")
        self.assertIn("current_setting('nightshift.ai_chat_sheets', true)", b)
        self.assertIn("new.brief - 'ref_sheets' - 'film_link'", b)
        w = body("ai_chat_save_sheets")
        on, off = w.index("set_config('nightshift.ai_chat_sheets', s.id::text, true)"), w.index("set_config('nightshift.ai_chat_sheets', '', true)")
        self.assertLess(on, w.index("update public.ai_chat_sessions"))
        self.assertLess(w.index("update public.ai_chat_sessions"), off)
        self.assertRegex(code(TEXT), r"before update of brief on public\.ai_chat_sessions\s+for each row")

    def test_every_cap_is_refused_by_name(self):
        for word in ("too_many_sheets", "sheets_too_large", "too_many_views", "sheet_prompt_too_long", "invalid_sheet", "invalid_film_link",
                     "brief_too_large", "session_closed", "plan_not_ready", "film_conversation", "session_not_found"):
            self.assertIn(f"'{word}", TEXT, word)

    def test_it_has_an_end_state_check_a_verify_block_and_no_backslash(self):
        self.assertIn("0249 end state:", TEXT)
        self.assertIn("-- Verify", TEXT)
        self.assertIn("APPLY AS ONE TRANSACTION", TEXT)
        self.assertIn("set local lock_timeout", code(TEXT))
        self.assertNotIn("\\", TEXT)
        self.assertNotIn("\\", ROLLBACK_TEXT)

    def test_the_rollback_is_one_transaction_and_drops_only_what_0249_added(self):
        self.assertRegex(ROLLBACK_TEXT, r"(?m)^begin;$")
        self.assertEqual(len(re.findall(r"(?m)^commit;$", ROLLBACK_TEXT)), 1)
        sql = code(ROLLBACK_TEXT)
        self.assertEqual(sorted(re.findall(r"drop (?:function|trigger) if exists ([^;( ]+)", sql)),
                         ["ai_chat_sessions_keep_sheets", "public.ai_chat_save_sheets", "public.ai_chat_sessions_keep_sheets",
                          "public.ai_chat_sheet_holds", "public.ai_chat_sheet_problem", "public.ai_chat_sheet_repair"])
        # Besides the CHECK, it puts back exactly 0199's finish_turn (and its grant). The call outcomes keep brief_too_large and no
        # call is relabelled (rule 5; DB L3, Lens 8): no UPDATE and no ALTER of ai_chat_calls at all.
        self.assertEqual(re.findall(r"create or replace function public\.(\w+)\(", sql), ["ai_chat_finish_turn"])
        self.assertEqual(re.findall(r"(?m)^update public\.(\w+)", sql), [])
        self.assertNotIn("ai_chat_calls_outcome_check", sql)
        self.assertNotRegex(sql, r"alter table public\.ai_chat_calls")
        for word in ("delete ", "create table", "create trigger"):
            self.assertNotIn(word, sql, word)
        old = (REPO / "supabase" / "migrations" / "0199_studio_ai_chat.sql").read_text(encoding="utf-8")
        i = old.index("create or replace function public.ai_chat_finish_turn(")
        self.assertIn(old[i:old.index("$$;", i) + 3], ROLLBACK_TEXT)
        # The only ALTERs put 0199's CHECK back exactly in place of 0249's, and only where every conversation fits it (DB M2: else
        # 0249's stays, with a NOTICE); the count and the swap are under one lock (DB L5).
        self.assertEqual(re.findall(r"alter table public\.ai_chat_sessions ([^;]*);", sql), [
            "drop constraint if exists ai_chat_sessions_brief_0249",
            "drop constraint if exists ai_chat_sessions_brief_check",
            "add constraint ai_chat_sessions_brief_check\n      check (jsonb_typeof(brief) = 'object' and octet_length(brief::text) <= 262144)"])
        self.assertIn("raise notice 'rollback 0249: % conversation(s) hold more than 262144 bytes", sql)
        self.assertLess(sql.index("lock table public.ai_chat_sessions in share row exclusive mode;"), sql.index("select count(*) into n"))
        self.assertNotIn("trim their ref_sheets by hand", sql)

    def test_the_sheets_have_their_own_budget_and_the_turn_keeps_0199s(self):
        sql = code(TEXT)
        self.assertIn("octet_length((brief - 'ref_sheets' - 'film_link')::text) <= 262144", sql)
        self.assertIn("octet_length(coalesce(brief -> 'ref_sheets', '[]'::jsonb)::text) <= 196608", sql)
        self.assertIn("octet_length(coalesce(brief -> 'film_link', 'null'::jsonb)::text) <= 8192", sql)
        w = body("ai_chat_save_sheets")
        self.assertIn("octet_length(v_out::text) > 196608", w)
        # Refused past 40, never cut.
        self.assertNotRegex(w, r"where n <= 40")
        self.assertIn("'too_many_sheets', 'the sheets stored and sent together are more than 40'", w)

    def test_the_command_center_calls_the_writer_with_the_files_arguments(self):
        cc = REPO / "command-center"
        calls = []
        for sub in ("app", "lib"):
            for p in (cc / sub).rglob("*.ts"):
                for m in re.finditer(r"rpc\(\"ai_chat_save_sheets\", \{([^}]*)\}", p.read_text(encoding="utf-8")):
                    calls.append((p.name, sorted(k.strip().split(":")[0] for k in m.group(1).split(","))))
        self.assertTrue(calls)
        for name, keys in calls:
            self.assertEqual(keys, ["p_base", "p_film_link", "p_session", "p_sheets"], name)


if __name__ == "__main__":
    unittest.main()

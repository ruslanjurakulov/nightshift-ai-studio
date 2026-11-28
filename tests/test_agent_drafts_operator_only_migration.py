"""supabase/migrations/0234_agent_drafts_operator_only.sql — the Agent Builder draft functions serve platform operators only.

SQL runs in tests/security/test_sec_agent_drafts_operator_only_0234.py (a real Postgres). These pin what must not drift by accident:
each function is 0130's body plus exactly one marked check (take it out and the rest is 0130's text byte for byte), placed after the
sign-in check and before anything else; the hashes in the drift guard, the end state, the Verify block, the rollback and the lab
are the ones recomputed from the files; the rollback puts 0130's bodies back verbatim; the grants are 0130's and nothing else (the
file restricts the bodies, never who may call); and neither file holds a backslash (the live apply path once rewrote them).
"""

import hashlib
import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MIG = ROOT / "supabase" / "migrations"
NEW_TEXT = (MIG / "0234_agent_drafts_operator_only.sql").read_text(encoding="utf-8")
T130 = (MIG / "0130_agent_workflow_drafts.sql").read_text(encoding="utf-8")
ROLLBACK = (ROOT / "docs" / "sql" / "rollback_0234_agent_drafts_operator_only.sql").read_text(encoding="utf-8")
LAB = (ROOT / "tests" / "security" / "sec_db.py").read_text(encoding="utf-8")
DOCS = (ROOT / "docs" / "MIGRATIONS.md").read_text(encoding="utf-8")
LEDGER = (ROOT / "docs" / "security" / "LEDGER.md").read_text(encoding="utf-8")
CODE = "\n".join(line.split("--", 1)[0] for line in NEW_TEXT.splitlines())

SAVE = "save_agent_workflow_draft"
DELETE = "delete_agent_workflow_draft"
#: Comments cut, then white space folded (0230's fingerprint): what the guards, end states, Verify block and rollback compare.
CUT = {SAVE: ("c5175b042a9118080b0d4f12906c202d", "a95607774a410e65ccdefb1989557946"),
       DELETE: ("7b72f3679d8e9de439d753738f8b66bc", "5a506ee8e5b1fd93419b2fce831e3093")}
#: White space folded only: how rollback_0130 pins 0130's bodies, and how the lab tells which body is live.
FOLD = {SAVE: ("7fe9d1359748e6e311f95678843a6b2e", "3ec1e1922060eb771bf57be879d5bfb2"),
        DELETE: ("ef7540b121198f0b79cde9f8975a5c95", "2f7e029a513675feeed6aded38622c63")}
FP_SQL = "md5(regexp_replace(regexp_replace(p.prosrc, '[-][-][^' || chr(10) || chr(13) || ']*', '', 'g'), '[[:space:]]+', ' ', 'g'))"

SIGN_IN = "  if v_user is null then raise exception 'not_authenticated' using errcode = '42501'; end if;\n"
CHECK = ("  -- 0234: operators only until launch. is_platform_admin() is the check the Command Center's isOperator() asks; a NULL is no,\n"
         "  -- and an error in it fails the call, so the check can only refuse.\n"
         "  if not coalesce(public.is_platform_admin(), false) then raise exception 'operator_only' using errcode = '42501'; end if;\n")


def fn_of(text, name):
    return re.search(rf"(?ms)^create or replace function public\.{name}\(.*?^\$\$;\n", text).group(0)


def _body(fn):
    return fn[fn.index("$$") + 2: fn.rindex("$$")]


def fold_md5(fn):
    return hashlib.md5(re.sub(r"[ \t\n\r\f\v]+", " ", _body(fn)).encode()).hexdigest()


def cut_md5(fn):
    # Postgres ends a `--` comment at a newline or a carriage return; so does this cut.
    return hashlib.md5(re.sub(r"[ \t\n\r\f\v]+", " ", re.sub(r"--[^\n\r]*", "", _body(fn))).encode()).hexdigest()


class Bodies(unittest.TestCase):
    def test_each_body_is_0130s_with_exactly_one_check_after_the_sign_in(self):
        for name in (SAVE, DELETE):
            new, old = fn_of(NEW_TEXT, name), fn_of(T130, name)
            self.assertEqual(new.count(CHECK), 1, name)
            self.assertEqual(new.replace(CHECK, ""), old, f"{name}: 0234 changed more of 0130's body than its check")
            self.assertIn(SIGN_IN + CHECK, new, f"{name}: the check must come right after the sign-in check, before any other")

    def test_the_rollback_puts_0130s_bodies_back_verbatim(self):
        for name in (SAVE, DELETE):
            self.assertEqual(fn_of(ROLLBACK, name), fn_of(T130, name), name)

    def test_the_hashes_are_the_ones_recomputed_from_the_files(self):
        for name in (SAVE, DELETE):
            self.assertEqual(cut_md5(fn_of(T130, name)), CUT[name][0], name)
            self.assertEqual(cut_md5(fn_of(NEW_TEXT, name)), CUT[name][1], name)
            self.assertEqual(fold_md5(fn_of(T130, name)), FOLD[name][0], name)
            self.assertEqual(fold_md5(fn_of(NEW_TEXT, name)), FOLD[name][1], name)

    def test_every_guard_names_both_hashes_with_the_same_fingerprint(self):
        for name in (SAVE, DELETE):
            old, new = CUT[name]
            # The drift guard accepts 0130's body or 0234's (a second run), and nothing else; the end state asks for 0234's.
            self.assertIn(f"array['{old}', '{new}']", NEW_TEXT, name)
            self.assertIn(f"is distinct from '{new}' then", NEW_TEXT, name)
            self.assertIn(f"= '{new}' as", NEW_TEXT, name)  # the Verify block
            self.assertIn(f"array['{new}', '{old}']", ROLLBACK, name)
            self.assertIn(f"is distinct from '{old}' then", ROLLBACK, name)
            self.assertIn(FOLD[name][1], LAB, f"{name}: the lab's put-back helper must know 0234's body")
        self.assertGreaterEqual(NEW_TEXT.count(FP_SQL), 6)
        self.assertGreaterEqual(ROLLBACK.count(FP_SQL), 4)

    def test_the_refusal_is_0130s_style(self):
        # 42501 is what 0130 raises for not_authenticated, and draftRpcFailure maps the word to 403 forbidden.
        self.assertEqual(CODE.count("raise exception 'operator_only' using errcode = '42501'"), 2)
        drafts = (ROOT / "command-center" / "lib" / "server" / "agent-drafts.ts").read_text(encoding="utf-8")
        self.assertIn('message === "operator_only"', drafts)


class Grants(unittest.TestCase):
    def test_the_grants_are_0130s_exactly(self):
        for stmt in (
            "revoke all on function public.save_agent_workflow_draft(uuid, integer, jsonb) from public, anon, authenticated, service_role;",
            "revoke all on function public.delete_agent_workflow_draft(uuid) from public, anon, authenticated, service_role;",
            "grant execute on function public.save_agent_workflow_draft(uuid, integer, jsonb) to authenticated;",
            "grant execute on function public.delete_agent_workflow_draft(uuid) to authenticated;",
        ):
            self.assertIn(stmt, T130)
            self.assertIn(stmt, NEW_TEXT)
            self.assertIn(stmt, ROLLBACK)
        self.assertEqual(len(re.findall(r"(?i)\bgrant\s", CODE)), 2)
        self.assertNotRegex(CODE, r"(?i)\bgrant\b[^;]*\bto\s+(anon|service_role|public)\b")


class Shape(unittest.TestCase):
    def test_no_backslash_survives_the_live_apply_path(self):
        self.assertNotIn("\\", NEW_TEXT)
        self.assertNotIn("\\", ROLLBACK)

    def test_guarded_one_transaction_with_an_end_state_and_a_verify_block(self):
        self.assertIn("0234 needs 0130", NEW_TEXT)
        self.assertLess(NEW_TEXT.index("0234 found a save_agent_workflow_draft()"), NEW_TEXT.index("create or replace function"))
        self.assertLess(NEW_TEXT.index("0234 found a delete_agent_workflow_draft()"), NEW_TEXT.index("create or replace function"))
        self.assertIn("set local lock_timeout", NEW_TEXT)
        self.assertIn("0234 end state: a draft function lacks the operator check", NEW_TEXT)
        self.assertIn("0234 end state: a draft function has the wrong grants", NEW_TEXT)
        self.assertIn("-- Verify", NEW_TEXT)
        # Additive: no table, column or policy is created, altered or dropped (the bodies' own writes are 0130's, pinned above).
        self.assertNotRegex(CODE, r"(?i)\b(create table|alter table|create policy|drop )")
        self.assertIn("begin;", ROLLBACK)
        self.assertIn("commit;", ROLLBACK)

    def test_no_other_migration_replaces_the_functions(self):
        others = [p.name for p in MIG.glob("*.sql") if p.name not in ("0130_agent_workflow_drafts.sql", "0234_agent_drafts_operator_only.sql")
                  and re.search(r"function public\.(save|delete)_agent_workflow_draft\(", p.read_text(encoding="utf-8"))]
        self.assertEqual(others, [], "a later body of a draft function needs its md5 in 0234's guard and the rollback")

    def test_registered_in_the_docs_and_the_ledger(self):
        self.assertIn("0234_agent_drafts_operator_only.sql", DOCS)
        self.assertIn("rollback_0234_agent_drafts_operator_only.sql", DOCS)
        self.assertIn("0234", LEDGER)


if __name__ == "__main__":
    unittest.main()

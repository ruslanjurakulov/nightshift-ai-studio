"""Migration 0128 (an edited picture remembers the picture it was made from), pinned from the file.

SQL does not run in this suite; the security lab runs it (tests/security/test_sec_upload_parent.py). What this pins is what a lab cannot see:

  * register_asset() is 0051's body BYTE FOR BYTE except for the lines marked 0128 (so nothing else of the payment-adjacent path moved);
  * the new request_upload() overload takes no defaults (a default would make a six-name call ambiguous for PostgREST), checks sign-in and
    membership BEFORE it looks at the parent, reads the parent itself (live, image, same organization) and then calls the six-argument function;
  * the file adds no grant to a table, no policy, and grants the new overload to authenticated only;
  * the rollback restores 0051's body, whose hash it carries, and the Command Center's routes carry the same words as the database.
"""

import hashlib
import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MIG = ROOT / "supabase" / "migrations"
SQL = (MIG / "0128_upload_parent_asset.sql").read_text()
SQL51 = (MIG / "0051_upload_into_folder.sql").read_text()
ROLLBACK = (ROOT / "docs" / "sql" / "rollback_0128_upload_parent_asset.sql").read_text()
CODE = "\n".join(line.split("--", 1)[0] for line in SQL.splitlines())


def func(text: str, head: str) -> str:
    i = text.index(head)
    return text[i:text.index("$$;", text.index("language plpgsql", i)) + 3]


def md5_of_body(fn: str) -> str:
    a = fn.index("$$") + 2
    return hashlib.md5(re.sub(r"\s+", " ", fn[a:fn.rindex("$$")]).encode()).hexdigest()


REG = "create or replace function public.register_asset("
REQ7 = "create or replace function public.request_upload(\n  p_org uuid, p_filename text, p_mime text, p_bytes bigint, p_project_id uuid, p_folder_id uuid, p_parent_asset_id uuid"


class Migration0128(unittest.TestCase):
    def test_register_asset_is_0051s_body_plus_only_the_marked_lines(self):
        mine = func(SQL, REG)
        kept = "\n".join(ln for ln in mine.splitlines() if "0128" not in ln)
        self.assertEqual(kept, func(SQL51, REG))
        added = [ln.strip() for ln in mine.splitlines() if "0128" in ln]
        self.assertIn("if p_parent_asset_id is null and t.parent_asset_id is not null then   -- 0128", added)
        self.assertEqual(len(added), 10)

    def test_the_parent_comes_from_the_ticket_and_is_rechecked(self):
        reg = " ".join(func(CODE, REG).split())
        self.assertIn("if p_parent_asset_id is null and t.parent_asset_id is not null then "
                      "select pa.id into p_parent_asset_id from public.media_assets pa "
                      "where pa.id = t.parent_asset_id and pa.org_id = t.org_id and pa.deleted_at is null and pa.kind = 'image' for key share; end if;", reg)
        # Inside the upload branch only: generated and rendered files take no parent from any ticket.
        upload_branch = reg.split("if p_source = 'upload' then", 1)[1].split("elsif p_upload_id is not null", 1)[0]
        self.assertIn("t.parent_asset_id", upload_branch)

    def test_the_hashes_in_the_files_are_the_bodies(self):
        pins = re.search(r"in \('([0-9a-f]{32})', '([0-9a-f]{32})'\)", SQL).groups()
        self.assertEqual(pins[0], md5_of_body(func(SQL51, REG)))
        self.assertEqual(pins[1], md5_of_body(func(SQL, REG)))
        req7 = re.search(r"oid = req7\) <> '([0-9a-f]{32})'", SQL).group(1)
        self.assertEqual(req7, md5_of_body(func(SQL, REQ7)))
        # The rollback carries the same three words and 0051's body verbatim.
        self.assertIn(f"is distinct from '{pins[1]}'", ROLLBACK)
        self.assertIn(f"is distinct from '{req7}'", ROLLBACK)
        self.assertIn(f"<> '{pins[0]}'", ROLLBACK)
        self.assertIn(func(SQL51, REG), ROLLBACK)

    def test_the_new_overload_has_no_defaults_and_checks_membership_before_the_parent(self):
        fn = " ".join(func(CODE, REQ7).split())
        self.assertNotIn(" default ", fn.split("returns jsonb", 1)[0])
        self.assertLess(fn.index("auth.uid() is null"), fn.index("p_parent_asset_id is not null"))
        self.assertLess(fn.index("public.is_org_member(p_org)"), fn.index("p_parent_asset_id is not null"))
        self.assertIn("where a.id = p_parent_asset_id and a.org_id = p_org and a.deleted_at is null and a.kind = 'image'", fn)
        self.assertIn("detail = 'reason=parent_not_found'", fn)
        self.assertIn("security definer set search_path = public, pg_temp", fn)
        # Every other gate is the six-argument function's, reached through it.
        self.assertIn("public.request_upload(p_org, p_filename, p_mime, p_bytes, p_project_id, p_folder_id)", fn)

    def test_it_grants_the_new_overload_to_authenticated_only_and_nothing_on_tables(self):
        grants = re.findall(r"grant execute on function public\.(\w+)\(([^)]*)\) to ([a-z_, ]+);", CODE)
        self.assertEqual(sorted((n, a.replace(" ", ""), r) for n, a, r in grants), [
            ("register_asset", "uuid,uuid,text,text,bigint,text,text,integer,integer,numeric,jsonb,bigint,text[],uuid,uuid,uuid,text,uuid", "service_role"),
            ("request_upload", "uuid,text,text,bigint,uuid,uuid,uuid", "authenticated"),
        ])
        for n, a, _ in grants:
            self.assertIn(f"revoke all on function public.{n}({a}) from public, anon, authenticated, service_role;", CODE)
        self.assertNotRegex(CODE, r"grant (select|insert|update|delete|all)\b")
        self.assertNotRegex(CODE, r"\bto anon\b")
        self.assertNotRegex(CODE, r"create policy|alter policy|drop policy|enable row level security|disable row level security")
        self.assertNotIn("drop ", CODE.replace("drop function public.request_upload", ""))

    def test_the_column_is_a_nullable_set_null_reference_and_the_file_is_idempotent(self):
        self.assertIn("alter table public.media_uploads add column if not exists parent_asset_id uuid;", CODE)
        self.assertIn("references public.media_assets (id) on delete set null", CODE)
        self.assertIn("create index if not exists media_uploads_parent_asset_idx", CODE)
        self.assertNotIn("not null", CODE.split("alter table public.media_uploads add column", 1)[1].split(";", 1)[0])
        # No explicit begin / commit: the runner (or the SQL editor) makes it one transaction, as for 0124-0127.
        self.assertNotRegex(CODE, r"(?m)^(begin|commit);")
        self.assertIn("set local lock_timeout = '5s';", CODE)

    def test_it_needs_0051_and_has_a_verify_query(self):
        self.assertIn("apply 0038, 0044, 0049 and 0051 first", CODE)
        self.assertIn("-- Verify (run after applying; every column should read true)", SQL)

    def test_it_is_the_next_number_and_nothing_else_redefines_the_functions_after_it(self):
        numbers = sorted(p.name[:4] for p in MIG.glob("*.sql"))
        self.assertEqual(numbers.count("0128"), 1)
        for p in sorted(MIG.glob("*.sql")):
            if p.name[:4] > "0128":
                text = p.read_text()
                self.assertNotIn("function public.request_upload(", text, p.name)
                self.assertNotIn("function public.register_asset(", text, p.name)

    def test_the_rollback_refuses_before_it_changes_anything(self):
        guard = ROLLBACK.split("-- 1. 0051's body", 1)[0]
        self.assertIn("a later change would be undone", guard)
        self.assertIn("an upload in flight carries a parent", guard)
        self.assertIn("drop column if exists parent_asset_id", ROLLBACK)
        self.assertNotIn("media_assets set", ROLLBACK)  # it never unlinks a finished file


if __name__ == "__main__":
    unittest.main()

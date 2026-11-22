"""Migration 0217 (a channel id may not be a page of the site's own), read as text.

The behaviour (create_channel refuses 'ru', 'RU' and 'privacy' by name, a direct insert or rename violates the CHECK, a
member's ordinary edit still passes, an existing reserved row is named and the constraint left out, the rollback and the
replay) is attacked in a real database by tests/security/test_sec_reserved_channel_ids_0217.py. The app list and the SQL
list are held equal by command-center/tests/reserved-channel-ids.test.ts. This file pins what must hold on every laptop:

* create_channel is 0114's body with only the refusal added, before anything is looked up or written (house rule: never
  drop an earlier check), and nothing between 0114 and 0217 redefined it;
* the rollback holds 0114's body byte for byte;
* the helper's grants are the ones the CHECK needs (the writer's role runs it) and no more.
"""

import re
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
MIGRATIONS = REPO / "supabase" / "migrations"
SQL = (MIGRATIONS / "0217_reserved_channel_ids.sql").read_text(encoding="utf-8")
M114 = (MIGRATIONS / "0114_ai_disclosure_admin_lock.sql").read_text(encoding="utf-8")
ROLLBACK = (REPO / "docs" / "sql" / "rollback_0217_reserved_channel_ids.sql").read_text(encoding="utf-8")


def code(text):
    return "\n".join(line.split("--", 1)[0].rstrip() for line in text.splitlines())


def bodies(text):
    return {m.group(1): m.group(0) for m in re.finditer(r"create or replace function public\.(\w+)\(.*?\n\$\$;\n", text, re.S)}


def lines(sql):
    return [ln for ln in code(sql).splitlines() if ln.strip()]


NEW = bodies(SQL)
OLD = bodies(M114)
CODE = code(SQL)


class BuiltOn0114(unittest.TestCase):
    def test_it_defines_one_helper_and_replaces_only_create_channel(self):
        self.assertEqual(sorted(NEW), ["create_channel", "is_reserved_channel_id"])
        for f in sorted(MIGRATIONS.glob("*.sql")):   # 0114's body is the latest one 0217 builds on
            if "0114" < f.name[:4] < "0217":
                self.assertNotIn("create_channel", bodies(f.read_text(encoding="utf-8")), f.name)

    def test_create_channel_keeps_every_line_of_0114_and_adds_only_the_refusal(self):
        old, new = OLD["create_channel"], NEW["create_channel"]
        self.assertEqual([ln for ln in lines(old) if ln not in lines(new)], [], "a line of 0114's create_channel is gone")
        self.assertEqual([ln for ln in lines(new) if ln not in lines(old)], [
            "  if public.is_reserved_channel_id(p_channel_id) then",
            "    raise exception 'reserved_channel_id: \"%\" is the address of a page of the site, so a channel of that id could not be opened: choose another id',",
            "      p_channel_id using errcode = '22023', hint = 'reserved_channel_id';",
        ])
        self.assertEqual(code(new).count("insert into public.channels"), 1)

    def test_the_refusal_comes_right_after_the_shape_check_and_before_anything_is_looked_up(self):
        new = code(NEW["create_channel"])
        i_shape = new.index("a channel id is a lowercase slug of 2 to 39 characters")
        i_reserved = new.index("public.is_reserved_channel_id(p_channel_id)")
        self.assertLess(i_shape, i_reserved)
        for later in ("channel_credential_build(", "pg_advisory_xact_lock(", "insert into public.channels"):
            self.assertLess(i_reserved, new.index(later), later)

    def test_signature_definer_and_search_path_are_0114s(self):
        self.assertEqual(NEW["create_channel"].split("$$", 1)[0], OLD["create_channel"].split("$$", 1)[0])
        self.assertIn("grant execute on function public.create_channel(text, uuid, text, text, jsonb, jsonb, jsonb, boolean)\n"
                      "  to authenticated, service_role;", CODE)

    def test_the_helper_is_pure_and_granted_to_the_roles_that_write_channels(self):
        head = NEW["is_reserved_channel_id"].split("$$", 1)[0]
        self.assertIn("language sql immutable parallel safe set search_path = pg_catalog, pg_temp", head)
        self.assertNotIn("security definer", head)
        self.assertIn("lower(p_id) = any (array[", NEW["is_reserved_channel_id"])
        self.assertIn("revoke all on function public.is_reserved_channel_id(text) from public, anon, authenticated, service_role;", CODE)
        self.assertIn("grant execute on function public.is_reserved_channel_id(text) to authenticated, service_role;", CODE)
        self.assertNotRegex(CODE, r"grant [^;]*\bto\b[^;]*\b(anon|public)\b")

    def test_the_constraint_is_added_not_valid_then_validated_and_only_when_no_row_breaks_it(self):
        i_scan = CODE.index("where public.is_reserved_channel_id(channel_id);")
        i_return = CODE.index("    return;", i_scan)
        i_add = CODE.index("add constraint channels_channel_id_not_reserved check (not public.is_reserved_channel_id(channel_id)) not valid;")
        i_validate = CODE.index("alter table public.channels validate constraint channels_channel_id_not_reserved;")
        self.assertLess(i_scan, i_return)
        self.assertLess(i_return, i_add)
        self.assertLess(i_add, i_validate)
        self.assertIn("raise warning '0217 did NOT add the constraint", CODE)
        self.assertIn("conname = 'channels_channel_id_not_reserved') then", CODE)   # idempotent: added once

    def test_it_rewrites_no_row(self):
        outside = CODE
        for body in NEW.values():
            outside = outside.replace(code(body), "")
        for forbidden in ("update public.channels", "insert into public.channels", "delete from", "drop table", "grant update",
                          "grant insert"):
            self.assertNotIn(forbidden, outside, forbidden)

    def test_it_stops_loudly_when_what_it_builds_on_is_missing(self):
        self.assertIn("to_regprocedure('public.channel_label_lowering(jsonb)') is null", CODE)
        self.assertIn("to_regprocedure('public.create_channel(text, uuid, text, text, jsonb, jsonb, jsonb, boolean)') is null", CODE)
        self.assertLess(CODE.index("0217 needs 0114_ai_disclosure_admin_lock.sql"), CODE.index("create or replace function"))


class LocksAndTransaction(unittest.TestCase):
    def test_writes_are_locked_out_before_the_scan_so_the_validate_cannot_meet_a_new_reserved_row(self):
        i_lock = CODE.index("lock table public.channels in share row exclusive mode;")
        self.assertLess(i_lock, CODE.index("where public.is_reserved_channel_id(channel_id);"))
        self.assertLess(i_lock, CODE.index("add constraint channels_channel_id_not_reserved"))

    def test_it_says_to_apply_it_as_one_transaction(self):
        self.assertIn("-- APPLY AS ONE TRANSACTION", SQL)
        self.assertLess(SQL.index("-- APPLY AS ONE TRANSACTION"), SQL.index("set local lock_timeout"))
        self.assertNotIn("does not block reads or", SQL)   # the ADD's ACCESS EXCLUSIVE is held to the commit


class ALaterListMustRecheckTheRows(unittest.TestCase):
    """Postgres trusts an immutable function: a create or replace with a longer list leaves rows already stored unchecked.
    So a later migration that redefines the list must scan for rows it now refuses and validate the constraint again."""

    DEFINES = re.compile(r"create\s+(or\s+replace\s+)?function\s+public\.is_reserved_channel_id\s*\(", re.I)

    def test_every_later_redefinition_rescans_and_revalidates(self):
        for f in sorted(MIGRATIONS.glob("*.sql")):
            if f.name[:4] <= "0217":
                continue
            text = code(f.read_text(encoding="utf-8"))
            if not self.DEFINES.search(text):
                continue
            low = text.lower()
            self.assertIn("lock table public.channels", low, f.name)
            self.assertRegex(low, r"where\s+public\.is_reserved_channel_id\(channel_id\)", f.name)
            self.assertRegex(low, r"validate\s+constraint\s+channels_channel_id_not_reserved", f.name)

    def test_the_markers_are_the_ones_0217_itself_carries(self):
        low = CODE.lower()
        self.assertTrue(self.DEFINES.search(CODE))
        self.assertIn("lock table public.channels", low)
        self.assertRegex(low, r"where\s+public\.is_reserved_channel_id\(channel_id\)")
        self.assertRegex(low, r"validate\s+constraint\s+channels_channel_id_not_reserved")


class RollbackPutsBack0114(unittest.TestCase):
    def test_the_rollback_holds_0114s_body_byte_for_byte_and_drops_the_rest(self):
        rb = bodies(ROLLBACK)
        self.assertEqual(sorted(rb), ["create_channel"])
        self.assertEqual(rb["create_channel"], OLD["create_channel"])
        rbc = code(ROLLBACK)
        self.assertIn("alter table public.channels drop constraint if exists channels_channel_id_not_reserved;", rbc)
        self.assertIn("drop function if exists public.is_reserved_channel_id(text);", rbc)
        # the constraint goes before the function it calls
        self.assertLess(rbc.index("drop constraint if exists"), rbc.index("drop function if exists"))
        self.assertRegex(ROLLBACK, r"(?m)^begin;$")
        self.assertRegex(ROLLBACK, r"(?m)^commit;$")


if __name__ == "__main__":
    unittest.main()

"""supabase/migrations/0141_youtube_channel_one_org.sql — one YouTube channel is connected to at most one organization.

SQL does not run in this suite (tests/security/test_sec_youtube_one_org.py does that, against a real Postgres, including the two-session
race). These pin what must not change by accident: the file replaces no existing function and adds exactly its three; every hash it names
(the drift guard over the reviewed write paths, its own bodies in the guard, the end state, the verify block and the rollback) is
recomputed here from the migration files; the check takes the YouTube id's lock BEFORE it reads, reads both sources of "connected" and
compares organizations, refuses with the stable code without naming the holder; the triggers cover the events the header promises; the
duplicate pre-check runs under the table lock and before anything is created; nothing is granted to an API role; the rollback is one
transaction that drops exactly what the file made; and docs/MIGRATIONS.md, the owner's read-only listing and the lab registry know it.
"""

import hashlib
import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MIG = ROOT / "supabase" / "migrations"
NEW_PATH = MIG / "0141_youtube_channel_one_org.sql"
NEW_TEXT = NEW_PATH.read_text(encoding="utf-8")
ROLLBACK_TEXT = (ROOT / "docs" / "sql" / "rollback_0141_youtube_channel_one_org.sql").read_text(encoding="utf-8")
CHECK_TEXT = (ROOT / "docs" / "sql" / "check_0141_youtube_channel_duplicates.sql").read_text(encoding="utf-8")
DOCS = (ROOT / "docs" / "MIGRATIONS.md").read_text(encoding="utf-8")


def code(text):
    return "\n".join(line.split("--", 1)[0] for line in text.splitlines())


CODE = code(NEW_TEXT)


def bodies(text):
    return {m.group(1): m.group(0) for m in re.finditer(r"(?m)^create or replace function public\.(\w+)\(.*?^\$\$;\n", text, re.S)}


def body(fn):
    return fn[fn.index("$$") + 2: fn.rindex("$$")]


def md5_of(fn):
    return hashlib.md5(re.sub(r"\s+", " ", body(fn)).encode()).hexdigest()


NEW = bodies(NEW_TEXT)
OWN = ("youtube_channel_one_org_check", "channel_token_refs_one_org", "channels_youtube_one_org")

#: The write paths the rule was reviewed against, with the migration whose body is the latest (the newest file that defines it).
REVIEWED = {
    "store_channel_token": ("public.store_channel_token(text, text, jsonb)", "0022"),
    "store_operator_channel_token": ("public.store_operator_channel_token(text, text, jsonb)", "0115"),
    "revoke_channel_token": ("public.revoke_channel_token(text)", "0022"),
    "set_channel_credential": ("public.set_channel_credential(text, jsonb, boolean)", "0086"),
    "channel_credential_build": ("public.channel_credential_build(text, uuid, jsonb, boolean, jsonb, boolean)", "0086"),
    "create_channel": ("public.create_channel(text, uuid, text, text, jsonb, jsonb, jsonb, boolean)", "0114"),
    "channel_stamp_from_connection": ("public.channel_stamp_from_connection()", "0086"),
}


def latest_before_0141(name):
    """(file number, definition) of the newest migration before 0141 that create-or-replaces public.<name>."""
    found = None
    for p in sorted(MIG.glob("*.sql")):
        if p.name[:4] >= "0141":
            continue
        b = bodies(p.read_text(encoding="utf-8"))
        if name in b:
            found = (p.name[:4], b[name])
    return found


class WhatItAdds(unittest.TestCase):
    def test_it_adds_three_functions_and_replaces_nothing(self):
        self.assertEqual(set(NEW), set(OWN))
        for name in REVIEWED:
            self.assertNotIn(f"function public.{name}(", CODE, name)
        for fn in OWN:
            self.assertIsNone(latest_before_0141(fn), f"{fn} existed before 0141")
        low = CODE.lower()
        for word in ("drop table", "drop column", "drop function", "drop trigger", "delete from", "truncate", "alter table",
                     "create policy", "create table", "create index", "grant "):
            self.assertNotIn(word, low)
        self.assertNotRegex(low, r"\b(insert\s+into|update\s+public\.|upsert)")

    def test_the_triggers_cover_the_events_the_header_promises(self):
        self.assertIn("create or replace trigger channel_token_refs_one_org\n"
                      "  before insert or update on public.channel_token_refs\n"
                      "  for each row execute function public.channel_token_refs_one_org();", CODE)
        self.assertIn("create or replace trigger channels_youtube_one_org\n"
                      "  before insert or update of credential_ref, org_id on public.channels\n"
                      "  for each row execute function public.channels_youtube_one_org();", CODE)


class TheCheck(unittest.TestCase):
    def test_it_locks_the_id_before_it_reads_and_reads_both_sources_across_organizations(self):
        b = body(NEW["youtube_channel_one_org_check"])
        lock = b.index("perform pg_advisory_xact_lock(hashtextextended('nightshift.youtube_channel:' || y, 0));")
        self.assertLess(lock, b.index("from public.channels c"), "the read comes after the lock")
        self.assertLess(lock, b.index("from public.channel_token_refs r"))
        self.assertEqual(b.count("c.org_id is distinct from p_org"), 2, "both sources compare the ORGANIZATION, not the row")
        self.assertEqual(b.count("<> all (ids)"), 2, "the row being written is left out of both reads")
        self.assertIn("array_remove(coalesce(p_channels, '{}'::text[]), null)", b, "a NULL id must not turn <> all into NULL")
        # (V) a confirmed row and (T) an active Vault connection, both compared after btrim
        self.assertIn("coalesce(c.credential_ref ->> 'verified_at', '') <> ''", b)
        self.assertIn("btrim(c.credential_ref ->> 'youtube_channel_id') = y", b)
        self.assertIn("r.vault_secret_id is not null", b)
        self.assertIn("r.revoked_at is null", b)
        self.assertIn("btrim(r.youtube_channel_id) = y", b)
        self.assertIn("language plpgsql volatile set search_path = public, pg_temp", NEW["youtube_channel_one_org_check"])

    def test_the_refusal_is_stable_and_names_nobody(self):
        b = body(NEW["youtube_channel_one_org_check"])
        refusal = re.search(r"raise exception 'youtube_channel_in_use:[^']*'\s+using errcode = '23P01', hint = 'youtube_channel_in_use';", b)
        self.assertIsNotNone(refusal)
        self.assertNotIn("%", refusal.group(0), "no value is formatted into the refusal")
        self.assertIn("using errcode = '0A000', hint = 'youtube_channel_isolation'", b)
        self.assertIn("current_setting('transaction_isolation') = 'repeatable read'", b)
        # 23P01, never 23505: create_channel turns a unique_violation into 'that channel id is not available'
        self.assertIn("exception when unique_violation then", latest_before_0141("create_channel")[1])
        self.assertNotIn("23505", b)

    def test_the_token_trigger_locks_the_channel_row_before_the_id_and_skips_only_a_refresh(self):
        b = body(NEW["channel_token_refs_one_org"])
        self.assertLess(b.index("for no key update"), b.index("perform public.youtube_channel_one_org_check("))
        self.assertIn("if new.vault_secret_id is null or new.revoked_at is not null then", b)
        self.assertIn("if tg_op = 'UPDATE' and old.vault_secret_id is not null and old.revoked_at is null", b)
        self.assertIn("new.channel_id is not distinct from old.channel_id", b)
        self.assertIn("language plpgsql security definer set search_path = public, pg_temp", NEW["channel_token_refs_one_org"])

    def test_the_channels_trigger_checks_a_new_confirmation_and_every_move(self):
        b = body(NEW["channels_youtube_one_org"])
        self.assertIn("moved  boolean := tg_op = 'INSERT' or new.org_id is distinct from old.org_id;", b)
        self.assertIn("if yv_new is not null and (moved or yv_new is distinct from yv_old) then", b)
        self.assertIn("perform public.youtube_channel_one_org_check(yv_new, new.org_id, ids);", b)
        self.assertIn("perform public.youtube_channel_one_org_check(yt, new.org_id, ids);", b)
        self.assertIn("language plpgsql security definer set search_path = public, pg_temp", NEW["channels_youtube_one_org"])


class GuardOrderAndHashes(unittest.TestCase):
    def test_the_drift_guard_pins_the_reviewed_write_paths_recomputed_from_their_files(self):
        guard = CODE[:CODE.index("lock table")]
        for name, (sig, number) in REVIEWED.items():
            got = latest_before_0141(name)
            self.assertIsNotNone(got, name)
            self.assertEqual(got[0], number, f"{name}'s latest body moved to {got[0]}: review 0141 against it")
            self.assertIn(f"('{sig}', '{md5_of(got[1])}', true)", guard, name)

    def test_its_own_hashes_are_the_bodies_everywhere_they_are_named(self):
        sigs = {"youtube_channel_one_org_check": "public.youtube_channel_one_org_check(text, uuid, text[])",
                "channel_token_refs_one_org": "public.channel_token_refs_one_org()",
                "channels_youtube_one_org": "public.channels_youtube_one_org()"}
        for fn, sig in sigs.items():
            h = md5_of(NEW[fn])
            self.assertIn(f"('{sig}', '{h}', false)", CODE[:CODE.index("lock table")], fn)     # the guard (replay)
            self.assertEqual(NEW_TEXT.count(h), 3, fn)                                          # guard, end state, verify
            self.assertIn(f"('{sig}', '{h}')", ROLLBACK_TEXT, fn)
            self.assertIn(h, DOCS, fn)

    def test_the_order_guard_then_lock_then_duplicates_then_create_then_end_state(self):
        order = [CODE.index("0141 needs 0018_organizations.sql"), CODE.index("0141 found a % that is not the reviewed body"),
                 CODE.index("lock table public.channels, public.channel_token_refs in share row exclusive mode;"),
                 CODE.index("connected in more than one organization"), CODE.index("create or replace function"),
                 CODE.index("create or replace trigger"), CODE.index("0141 end state:")]
        self.assertEqual(order, sorted(order))
        self.assertTrue(CODE.lstrip().startswith("set local lock_timeout = '5s';"))
        self.assertNotRegex(CODE, r"(?m)^(begin|commit);$", "applied as ONE transaction by the caller, like 0139")

    def test_the_duplicate_refusal_gives_counts_only_and_uses_the_listing_s_definition(self):
        block = CODE[CODE.index("lock table"):CODE.index("create or replace function")]
        raise_ = re.search(r"raise exception '0141 found % YouTube channel id\(s\)[^;]*;", block, re.S).group(0)
        self.assertTrue(raise_.rstrip(";").endswith("n_ids, n_rows"), raise_)
        for clause in ("coalesce(c.credential_ref ->> 'verified_at', '') <> ''", "r.vault_secret_id is not null and r.revoked_at is null",
                       "having count(distinct coalesce(org_id::text, '')) > 1"):
            self.assertIn(clause, block)
            self.assertIn(clause, CHECK_TEXT)
        low = code(CHECK_TEXT).lower()
        for word in ("insert", "update", "delete", "alter", "drop", "create", "grant", "lock", "truncate"):
            self.assertNotRegex(low, rf"\b{word}\b", f"the owner's listing must be read-only ({word})")

    def test_no_api_role_may_call_any_of_the_three(self):
        for sig in ("public.youtube_channel_one_org_check(text, uuid, text[])", "public.channel_token_refs_one_org()",
                    "public.channels_youtube_one_org()"):
            self.assertIn(f"revoke all on function {sig} from public, anon, authenticated, service_role;", CODE)
        self.assertNotIn("grant execute", CODE)


class Rollback(unittest.TestCase):
    def test_it_is_one_transaction_and_drops_exactly_what_the_file_made(self):
        rb = code(ROLLBACK_TEXT)
        self.assertEqual(len(re.findall(r"(?m)^begin;$", rb)), 1)
        self.assertEqual(len(re.findall(r"(?m)^commit;$", rb)), 1)
        drops = re.findall(r"(?m)^drop (?:trigger|function) if exists .*;$", rb)
        self.assertEqual(drops, [
            "drop trigger if exists channel_token_refs_one_org on public.channel_token_refs;",
            "drop trigger if exists channels_youtube_one_org on public.channels;",
            "drop function if exists public.channel_token_refs_one_org();",
            "drop function if exists public.channels_youtube_one_org();",
            "drop function if exists public.youtube_channel_one_org_check(text, uuid, text[]);"])
        self.assertNotIn("create or replace", rb, "0141 replaced nothing, so there is nothing to put back")
        self.assertLess(rb.index("rollback 0141 found a % that is not 0141''s body"), rb.index("drop trigger"))


class Registry(unittest.TestCase):
    def test_the_number_is_unique_and_the_lab_and_the_docs_know_it(self):
        numbers = sorted(p.name[:4] for p in MIG.glob("*.sql"))
        self.assertEqual(numbers.count("0141"), 1)
        self.assertIn("0139", numbers)
        expect = (ROOT / "tests" / "security" / "sec_youtube_one_org_0141.py").read_text(encoding="utf-8")
        self.assertIn('functions.update({"youtube_channel_one_org_check": SERVICE})', expect)
        self.assertIn("import sec_youtube_one_org_0141", (ROOT / "tests" / "security" / "sec_expectations.py").read_text(encoding="utf-8"))
        self.assertIn("## One YouTube channel, one organization (0141)", DOCS)
        self.assertIn("docs/sql/check_0141_youtube_channel_duplicates.sql", DOCS)


if __name__ == "__main__":
    unittest.main()

"""Migration 0114 (the AI-disclosure settings that lower the platform label are a platform administrator's), read as text.

The behaviour (an editor, an organization admin and the organization's owner are refused, a platform administrator and the
service role are not, an unrelated edit of a channel that already has a value still passes, the rollback and the replay) is
attacked in a real database by tests/security/test_sec_ai_disclosure_lock.py. This file pins what that cannot see without a
database, and what must hold on every laptop:

* the lock and the Python reader (modules/ai_disclosure.py) accept the same spellings: the whitespace class of the SQL
  helper is exactly the set Python's str.strip() removes, the closed words are the reader's constants, and a value locks
  exactly when the reader would report it as an override;
* the two functions 0114 replaces are 0086's bodies with only the sanctioned lines added (house rule: never drop an earlier
  check), and the bypass convention of 0086 (the browser roles only) is kept;
* every writer of channels.agent_config in the migrations is a known one, so a new SECURITY DEFINER writer cannot slip past
  the trigger unnoticed.
"""

import re
import unittest
from pathlib import Path

from modules import ai_disclosure as reader

REPO = Path(__file__).resolve().parent.parent
MIGRATIONS = REPO / "supabase" / "migrations"
FILE = "0114_ai_disclosure_admin_lock.sql"
SQL = (MIGRATIONS / FILE).read_text(encoding="utf-8")
M86 = (MIGRATIONS / "0086_channel_config_lock.sql").read_text(encoding="utf-8")
ROLLBACK = (REPO / "docs" / "sql" / "rollback_0114_ai_disclosure_admin_lock.sql").read_text(encoding="utf-8")


def code(text):
    return "\n".join(line.split("--", 1)[0].rstrip() for line in text.splitlines())


def bodies(text):
    return {m.group(1): m.group(0) for m in re.finditer(r"create or replace function public\.(\w+)\(.*?\n\$\$;\n", text, re.S)}


def literals(sql):
    return set(re.findall(r"'(?:[^']|'')*'", code(sql)))


def lines(sql):
    return [ln for ln in code(sql).splitlines() if ln.strip()]


NEW = bodies(SQL)
OLD = bodies(M86)
CODE = code(SQL)


def sql_class():
    """The bracket expression of ai_disclosure_norm's trim pattern, as a Python regex character class."""
    m = re.search(r"'\^(\[[^']*\])\+\|(\[[^']*\])\+\$'", NEW["ai_disclosure_norm"])
    assert m and m.group(1) == m.group(2), "the leading and trailing classes must be the same"
    return m.group(1)


def sql_norm(value):
    """ai_disclosure_norm for a JSON string, with the SQL's own pattern run by Python's regex engine."""
    cls = sql_class()
    return re.sub(f"^{cls}+|{cls}+$", "", value).lower()


def sql_lowering(cfg):
    """channel_label_lowering for a JSON object, by the same rule the SQL states."""
    if not isinstance(cfg, dict):
        cfg = {}
    out = []
    if isinstance(cfg.get("ai_disclosure"), str) and sql_norm(cfg["ai_disclosure"]) == "never":
        out.append("ai_disclosure")
    if isinstance(cfg.get("ai_disclosure_voice"), str) and sql_norm(cfg["ai_disclosure_voice"]) == "own_clone":
        out.append("ai_disclosure_voice")
    return out


class TheLockReadsAValueLikeTheReader(unittest.TestCase):
    def test_the_whitespace_class_is_exactly_what_python_strip_removes(self):
        cls = re.compile(sql_class())
        ours = {c for c in map(chr, range(1, 0x110000)) if not 0xD800 <= ord(c) <= 0xDFFF and cls.fullmatch(c)}
        theirs = {c for c in map(chr, range(1, 0x110000)) if not 0xD800 <= ord(c) <= 0xDFFF and c.strip() == ""}
        self.assertEqual(sorted(map(hex, map(ord, ours ^ theirs))), [], "a character is trimmed by one side only")
        self.assertIn("\u00a0", ours)       # NBSP: not in btrim() nor in a C-locale [[:space:]]
        self.assertIn("\u3000", ours)
        self.assertNotIn("\u200b", ours)    # zero-width space is not whitespace to Python either

    def test_lower_case_needs_no_unicode_folding_for_the_two_words(self):
        # SQL lower() and Python lower() can differ outside ASCII; they cannot matter here unless some non-ASCII
        # character lower-cases to a letter of 'never' or 'own_clone'.
        letters = set("neverowcl_")
        odd = [hex(ord(c)) for c in map(chr, range(0x80, 0x110000))
               if not 0xD800 <= ord(c) <= 0xDFFF and set(c.lower()) & letters]
        self.assertEqual(odd, [])

    def test_the_closed_words_are_the_readers_constants(self):
        self.assertEqual(reader.MODE_NEVER, "never")
        self.assertEqual(reader.VOICE_OWN_CLONE, "own_clone")
        self.assertIn("= 'never' then 'ai_disclosure' end", NEW["channel_label_lowering"])
        self.assertIn("= 'own_clone' then 'ai_disclosure_voice' end", NEW["channel_label_lowering"])
        # the only words of each key that lower the label are those two; the others raise or keep it
        self.assertEqual([m for m in reader.MODES if m != "never"], ["auto", "always"])
        self.assertEqual([v for v in reader.VOICES if v != "own_clone"], ["generic", "real_person"])

    def test_a_value_locks_exactly_when_the_reader_reports_an_override(self):
        pads = ["", " ", "\t", "\n", "\u00a0", "\u3000", "\u2003", "\u0085", "\u001f", "\u200b", "\ufeff", "x"]
        words = ["never", "NEVER", "Never", "own_clone", "Own_Clone", "OWN_CLONE", "own-clone", "ownclone", "nevermind",
                 "always", "auto", "generic", "real_person", "", "neverr", "n e v e r"]
        for pre in pads:
            for post in pads:
                for w in words:
                    v = pre + w + post
                    cfg = {"ai_disclosure": v, "ai_disclosure_voice": v}
                    mode_lowers = reader.normalize_mode(v) == "never"
                    voice_lowers = reader.normalize_voice(v) == "own_clone"
                    self.assertEqual(sql_lowering(cfg),
                                     [k for k, on in (("ai_disclosure", mode_lowers), ("ai_disclosure_voice", voice_lowers)) if on],
                                     repr(v))
                    # and the reader's own notion of "a person lowered the label"
                    sig = reader.Signals(known=True, voice=v)
                    overrides = reader.overrides_of(v, sig)
                    self.assertEqual(sorted(overrides), sorted(
                        [o for o, on in (("mode_never", mode_lowers), ("voice_own_clone", voice_lowers)) if on]), repr(v))

    def test_a_value_that_is_not_a_json_string_never_locks_and_never_reads_as_lowering(self):
        for v in (None, 5, True, ["never"], {"x": "never"}, 1.5):
            self.assertEqual(sql_lowering({"ai_disclosure": v, "ai_disclosure_voice": v}), [])
            self.assertEqual(reader.normalize_mode(v), "auto")
            self.assertNotEqual(reader.normalize_voice(v), "own_clone")
        self.assertEqual(sql_lowering([]), [])
        self.assertEqual(sql_lowering("never"), [])
        self.assertIn("jsonb_typeof(p_value) = 'string'", NEW["ai_disclosure_norm"])
        self.assertIn("then lower(regexp_replace(p_value #>> '{}',", NEW["ai_disclosure_norm"])   # the reader's .lower()
        self.assertIn("case when jsonb_typeof(p_cfg) = 'object' then p_cfg else '{}'::jsonb end", NEW["channel_label_lowering"])


class BuiltOnTheLatestBodies(unittest.TestCase):
    def test_it_defines_two_new_helpers_and_replaces_exactly_two_functions_of_0086(self):
        self.assertEqual(sorted(NEW), sorted(["ai_disclosure_norm", "channel_label_lowering", "channels_config_guard", "create_channel"]))
        for name in ("channels_config_guard", "create_channel"):
            self.assertIn(name, OLD)
        # nothing between 0086 and 0114 redefines either (else 0114 would be built on a stale body)
        for f in sorted(MIGRATIONS.glob("*.sql")):
            if "0086" < f.name[:4] < "0114":
                later = bodies(f.read_text(encoding="utf-8"))
                self.assertNotIn("channels_config_guard", later, f.name)
                self.assertNotIn("create_channel", later, f.name)

    def test_the_guard_keeps_every_line_and_literal_of_0086_and_adds_only_the_lowering_check(self):
        old, new = OLD["channels_config_guard"], NEW["channels_config_guard"]
        self.assertEqual(sorted(literals(old) - literals(new)), [], "an earlier literal (check, message, code) was lost")
        self.assertEqual(sorted(literals(new) - literals(old)), ["'ai_disclosure_lock'",
                         "'ai_disclosure_lock: only a platform administrator may set: %'"])
        self.assertEqual([ln for ln in lines(old) if ln not in lines(new)], [], "a line of 0086's guard is gone")
        self.assertEqual([ln for ln in lines(new) if ln not in lines(old)], [
            "  lowering text[];",
            "  lowering := '{}';",
            "  foreach k in array public.channel_label_lowering(n) loop",
            "    if (o -> k) is distinct from (n -> k) then",
            "      lowering := lowering || k;",
            "  if cardinality(lowering) > 0 and not public.is_platform_admin() then",
            "    raise exception 'ai_disclosure_lock: only a platform administrator may set: %', array_to_string(lowering, ', ')",
            "      using errcode = '42501', hint = 'ai_disclosure_lock';",
        ])

    def test_create_channel_keeps_every_line_and_literal_of_0086_and_adds_only_the_lowering_check(self):
        old, new = OLD["create_channel"], NEW["create_channel"]
        self.assertEqual(sorted(literals(old) - literals(new)), [])
        self.assertEqual(sorted(literals(new) - literals(old)), ["'ai_disclosure_lock'",
                         "'ai_disclosure_lock: only a platform administrator may set: %'"])
        self.assertEqual([ln for ln in lines(old) if ln not in lines(new)], [])
        self.assertEqual([ln for ln in lines(new) if ln not in lines(old)], [
            "  if cardinality(public.channel_label_lowering(cfg)) > 0 and not (trusted or public.is_platform_admin()) then",
            "    raise exception 'ai_disclosure_lock: only a platform administrator may set: %',",
            "      array_to_string(public.channel_label_lowering(cfg), ', ') using errcode = '42501', hint = 'ai_disclosure_lock';",
        ])

    def test_the_bypass_is_0086s_the_browser_roles_only_and_the_lock_is_a_platform_admins_not_an_org_admins(self):
        guard = NEW["channels_config_guard"]
        self.assertNotIn("security definer", guard)
        i_bypass = guard.index("if current_user not in ('authenticated', 'anon') then\n    return new;")
        i_lock = guard.index("channel_label_lowering(n)")
        self.assertLess(i_bypass, i_lock, "the service role and the definer functions pass before the lock is looked at")
        lock = guard[i_lock:]
        self.assertIn("not public.is_platform_admin()", lock)
        self.assertNotIn("is_org_member", lock, "an organization admin must not satisfy the lock")
        create = NEW["create_channel"]
        self.assertIn("security definer", create)
        self.assertNotIn("is_org_member(p_org, 'admin')", create[create.index("channel_label_lowering"):create.index("if stamp and")])

    def test_the_new_check_sees_a_write_that_sets_a_value_not_one_that_leaves_it(self):
        guard = NEW["channels_config_guard"]
        self.assertIn("if (o -> k) is distinct from (n -> k) then\n      lowering := lowering || k;", guard)
        # an INSERT compares with an empty blob, so a new channel cannot be created with either value
        self.assertIn("if tg_op = 'INSERT' then\n    o := '{}'::jsonb;", guard)

    def test_the_trigger_and_the_grants_are_repeated_like_0086s(self):
        self.assertIn("create trigger channels_config_guard\n  before insert or update on public.channels\n"
                      "  for each row execute function public.channels_config_guard();", CODE)
        self.assertIn("revoke all on function public.channels_config_guard() from public, anon, authenticated, service_role;", CODE)
        self.assertIn("grant execute on function public.create_channel(text, uuid, text, text, jsonb, jsonb, jsonb, boolean)\n"
                      "  to authenticated, service_role;", CODE)
        for fn in ("ai_disclosure_norm(jsonb)", "channel_label_lowering(jsonb)"):
            self.assertIn(f"revoke all on function public.{fn} from public, anon, authenticated, service_role;", CODE)
            self.assertIn(f"grant execute on function public.{fn} to authenticated, service_role;", CODE)
        self.assertNotRegex(CODE, r"grant [^;]*\bto\b[^;]*\b(anon|public)\b")

    def test_every_function_pins_its_search_path_and_nothing_is_rewritten(self):
        for name, body in NEW.items():
            self.assertIn("set search_path = public, pg_temp", body.split("$$", 1)[0], name)
        outside = CODE
        for body in NEW.values():          # create_channel's own insert is 0086's, unchanged
            outside = outside.replace(code(body), "")
        for forbidden in ("update public.channels", "insert into public.channels", "delete from", "drop table", "alter table",
                          "create table", "create policy", "grant update", "grant insert"):
            self.assertNotIn(forbidden, outside, f"0114 is a lock, not a rewrite: {forbidden}")
        self.assertEqual(code(NEW["create_channel"]).count("insert into public.channels"), 1)

    def test_it_stops_loudly_when_what_it_builds_on_is_missing(self):
        for needle in ("to_regprocedure('public.is_platform_admin()') is null", "to_regprocedure('public.credits_trusted_caller()') is null",
                       "to_regprocedure('public.channels_config_guard()') is null"):
            self.assertIn(needle, CODE)
        self.assertIn("raise exception '0114 needs 0086_channel_config_lock.sql: apply it first'", CODE)


class RollbackPutsBack0086(unittest.TestCase):
    def test_the_rollback_holds_0086s_two_bodies_byte_for_byte_and_drops_the_helpers(self):
        rb = bodies(ROLLBACK)
        for name in ("channels_config_guard", "create_channel"):
            self.assertEqual(rb[name], OLD[name], name)
        self.assertNotIn("channel_label_lowering(", ROLLBACK.replace("drop function if exists public.channel_label_lowering(jsonb);", "")
                         .split("-- Verify")[0].replace("-- ", "").split("begin;", 1)[1])
        self.assertIn("drop function if exists public.channel_label_lowering(jsonb);\ndrop function if exists public.ai_disclosure_norm(jsonb);", ROLLBACK)
        self.assertRegex(ROLLBACK, r"(?m)^begin;$")
        self.assertRegex(ROLLBACK, r"(?m)^commit;$")


class EveryWriterOfAgentConfigIsKnown(unittest.TestCase):
    """The trigger sees the browser roles only. A SECURITY DEFINER function that writes channels.agent_config runs as its
    owner and does not meet it, so each one must be listed here and either never write the two keys or make the check itself
    (create_channel does). Adding a writer fails this test until someone reads that rule."""

    #: migration -> why that file's write to channels cannot lower the label.
    KNOWN = {
        "0001_multi_channel.sql": "seeds the default channel row once with the column's default ({})",
        "0005_verified_channels.sql": "a backfill of status/credential_ref, not agent_config",
        "0018_organizations.sql": "backfills org_id, not agent_config",
        "0056_channel_dna.sql": "set_channel_dna merges ONLY elevenlabs_voice_id and language into agent_config",
        "0086_channel_config_lock.sql": "create_channel (checked again in 0114), credential/status functions, the stamp trigger",
        "0114_ai_disclosure_admin_lock.sql": "this file replaces the guard and create_channel; it writes no row",
    }

    def test_no_migration_writes_channels_without_being_in_the_known_list(self):
        found = set()
        for f in sorted(MIGRATIONS.glob("*.sql")):
            text = code(f.read_text(encoding="utf-8"))
            if re.search(r"(?is)\bupdate\s+(public\.)?channels\b(?!_)", text) or re.search(r"(?is)\binsert\s+into\s+(public\.)?channels\b(?!_)", text) \
                    or re.search(r"(?is)\bagent_config\s*=", text):
                found.add(f.name)
        self.assertEqual(sorted(found - set(self.KNOWN)), [], "a migration writes channels.agent_config: does it go through the lock?")

    def test_set_channel_dna_cannot_set_either_key(self):
        text = (MIGRATIONS / "0056_channel_dna.sql").read_text(encoding="utf-8")
        body = bodies(text)["set_channel_dna"]
        self.assertEqual(re.findall(r"patch := patch \|\| jsonb_build_object\('(\w+)'", body), ["elevenlabs_voice_id", "language"])
        self.assertNotIn("ai_disclosure", body)


if __name__ == "__main__":
    unittest.main()

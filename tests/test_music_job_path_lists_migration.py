"""supabase/migrations/0250_music_in_job_path_lists.sql — sellable_models knows `music` (stream S6).

SQL runs in tests/security/test_sec_music_job_path_0250.py (a real Postgres). These pin what must not drift by accident: 0250's body
is 0192's sellable_models with `'music'` added to its list of known capabilities and nothing else (take the one hunk out and the
code is 0192's text, token for token); the hashes in the drift guard, the end state, the Verify block, the rollback and the lab are
the ones recomputed here from the files; the guard accepts exactly 0192's body and 0250's own; the rollback puts 0192's body back
verbatim; video_music and video_character_swap are named nowhere; no other closed list was widened (the API's and the connected
assistants' lists, film's and the source / style lists keep music out, each for its reason); and neither file holds a backslash.
"""

import hashlib
import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MIG = ROOT / "supabase" / "migrations"
NEW_TEXT = (MIG / "0250_music_in_job_path_lists.sql").read_text(encoding="utf-8")
T192 = (MIG / "0192_adult_attestation.sql").read_text(encoding="utf-8")
T188 = (MIG / "0188_recraft_web_mcp.sql").read_text(encoding="utf-8")
ROLLBACK = (ROOT / "docs" / "sql" / "rollback_0250_music_in_job_path_lists.sql").read_text(encoding="utf-8")
LAB = (ROOT / "tests" / "security" / "sec_db.py").read_text(encoding="utf-8")
EXPECT = (ROOT / "tests" / "security" / "sec_expectations.py").read_text(encoding="utf-8")
DOCS = (ROOT / "docs" / "MIGRATIONS.md").read_text(encoding="utf-8")
OPERATIONS_TS = (ROOT / "command-center" / "lib" / "api" / "operations.ts").read_text(encoding="utf-8")

#: 0230's fingerprint (comments cut, then white space folded): what the guards, the end state and the rollback compare.
SM_0192 = "85aaba9a2ec82dc7f276dd2135b4c7cf"
SM_0250 = "58c81cd592628820d3bd348353e6a5a8"
#: White space folded only: how 0192 pins the body (its own guard and rollback).
FOLD_SM_0192 = "40f61462ddae2fc0e83a0956f4d8b75b"
FOLD_SM_0250 = "c6320684517e3487a8f536105d2d25a2"
FP_SQL = "md5(regexp_replace(regexp_replace({}, '[-][-][^' || chr(10) || chr(13) || ']*', '', 'g'), '[[:space:]]+', ' ', 'g'))"
#: The one hunk, as the file writes it (the rest of the body is 0192's text).
OLD_LINE = "'expand', 'relight', 'erase', 'video_edit', 'video_reframe', 'video_remove_bg') then\n"
#: sellable_models' three hunks, in folded code, and what each was in 0192's: music known; music off the web, by request and in the list.
HUNKS_SM = [
    ("'video_remove_bg', 'music') then", "'video_remove_bg') then"),
    (" if p_capability = 'music' and p_surface <> 'web' then return; end if;", ""),
    (" and (p_surface = 'web' or not ('music' = any (m.capabilities)))", ""),
]
#: api_creative_model_ok (0188's body, and 0250's: music out of its "temporarily off" word), by both fingerprints.
OK_0188 = "861978aa7b3d2d072433a9f6f8d7e857"
OK_0250 = "ab087bc94fd3b9337f94d8dbea5b56ea"
FOLD_OK_0188 = "cbe9f5d42dcdcfddb604d4a30c2f80ae"
FOLD_OK_0250 = "38d1ab91f7a18f4ff6fe10dbf642e3da"


def fn_of(text, name="sellable_models"):
    return re.search(rf"(?ms)^create or replace function public\.{name}\(.*?^\$\$;\n", text).group(0)


def _body(fn):
    return fn[fn.index("$$") + 2: fn.rindex("$$")]


def _cut(s):
    # Postgres ends a `--` comment at a newline or a carriage return; so does this cut.
    return re.sub(r"--[^\n\r]*", "", s)


def _fold(s):
    return re.sub(r"[ \t\n\r\f\v]+", " ", s)


def md5_of(fn):
    return hashlib.md5(_fold(_cut(_body(fn))).encode()).hexdigest()


def fold_md5(fn):
    return hashlib.md5(_fold(_body(fn)).encode()).hexdigest()


def known_list(fn):
    code = _cut(_body(fn))
    m = re.search(r"p_capability not in \((.*?)\) then", code, re.S)
    return re.findall(r"'([a-z0-9_]+)'", m.group(1))


class TheBody(unittest.TestCase):
    new = fn_of(NEW_TEXT)
    old = fn_of(T192)

    def test_the_hashes_are_recomputed_from_the_files(self):
        self.assertEqual(md5_of(self.old), SM_0192)
        self.assertEqual(fold_md5(self.old), FOLD_SM_0192)
        self.assertEqual(md5_of(self.new), SM_0250)
        self.assertEqual(fold_md5(self.new), FOLD_SM_0250)

    def test_the_only_changes_are_music_known_and_kept_to_the_web(self):
        self.assertEqual(known_list(self.new), known_list(self.old) + ["music"])
        self.assertNotIn("music", known_list(self.old))
        # Take 0250's three hunks out and the code is 0192's, token for token.
        self.assertEqual(self.old.count(OLD_LINE), 1)
        undone = _fold(_cut(_body(self.new)))
        for hunk, back in HUNKS_SM:
            self.assertEqual(undone.count(hunk), 1, hunk)
            undone = undone.replace(hunk, back)
        self.assertEqual(undone, _fold(_cut(_body(self.old))))
        # Every added line that is not code is a comment, and the comments name 0250.
        added = [ln for ln in self.new.splitlines() if ln not in self.old.splitlines()]
        comments = [ln for ln in added if ln.strip().startswith("--")]
        self.assertTrue(comments and all("0250" in c for c in comments if c.strip().startswith("-- 0250")))
        self.assertTrue(any("BR-S6-06" in c for c in comments))

    def test_music_is_kept_off_the_api_and_mcp_as_captions_are(self):
        code = _fold(_cut(_body(self.new)))
        # The early return for a music request off the web, right after captions' (BR-S6-06) ...
        caps = "if p_capability = 'captions' and p_surface <> 'web' then return; end if;"
        music = "if p_capability = 'music' and p_surface <> 'web' then return; end if;"
        self.assertIn(caps + " " + music, code)
        # ... and the row filter for the full list (p_capability null), right after captions' own.
        self.assertIn("and (p_surface = 'web' or not ('captions' = any (m.capabilities))) "
                      "and (p_surface = 'web' or not ('music' = any (m.capabilities))) order by", code)

    def test_api_creative_model_ok_changes_only_its_captions_exclusion(self):
        new, old = fn_of(NEW_TEXT, "api_creative_model_ok"), fn_of(T188, "api_creative_model_ok")
        self.assertEqual(md5_of(old), OK_0188)
        self.assertEqual(fold_md5(old), FOLD_OK_0188)
        self.assertEqual(md5_of(new), OK_0250)
        self.assertEqual(fold_md5(new), FOLD_OK_0250)
        undone = _fold(_cut(_body(new))).replace("p_capability not in ('captions', 'music')", "p_capability <> 'captions'")
        self.assertEqual(undone, _fold(_cut(_body(old))))
        self.assertEqual(new[: new.index("as $$")], old[: old.index("as $$")])
        self.assertIn("revoke all on function public.api_creative_model_ok(text, text) from public, anon, authenticated, service_role;",
                      NEW_TEXT)

    def test_the_signature_return_type_and_grants_are_0192s(self):
        head = lambda fn: fn[: fn.index("as $$")]
        self.assertEqual(head(self.new), head(self.old))
        self.assertIn("revoke all on function public.sellable_models(text, text) from public, anon;", NEW_TEXT)
        self.assertIn("grant execute on function public.sellable_models(text, text) to authenticated, service_role;", NEW_TEXT)
        self.assertEqual(len(re.findall(r"(?m)^\s*grant ", NEW_TEXT)), 1)

    def test_the_registry_only_capabilities_stay_unknown(self):
        for text in (NEW_TEXT, ROLLBACK):
            # Not even in a comment (tests/test_sonilo.py holds every migration to that); the lab proves both stay unknown.
            self.assertNotIn("video_character_swap", text)
            self.assertNotIn("video_music", text)
        self.assertNotIn("video_music", known_list(self.new))
        self.assertNotIn("video_character_swap", known_list(self.new))


class TheGuards(unittest.TestCase):
    def test_the_drift_guard_accepts_0192s_body_and_its_own_only(self):
        self.assertIn(FP_SQL.format("p.prosrc"), NEW_TEXT)
        self.assertIn(f"array['{SM_0192}', '{SM_0250}']", NEW_TEXT)
        self.assertIn("0250 found a sellable_models() that is neither 0192''s body nor 0250''s", NEW_TEXT)
        # The guard runs before the replacement, the end state after it.
        self.assertLess(NEW_TEXT.index("0250 found a sellable_models()"), NEW_TEXT.index("create or replace function public.sellable_models("))
        self.assertLess(NEW_TEXT.index("create or replace function public.sellable_models("), NEW_TEXT.index("0250 end state"))

    def test_the_end_state_and_the_verify_block_assert_the_new_hash(self):
        end = NEW_TEXT[NEW_TEXT.index("-- End state"):]
        self.assertIn(f"is distinct from '{SM_0250}'", end)
        self.assertIn("search_path=public, pg_temp", end)
        verify = NEW_TEXT[NEW_TEXT.index("-- Verify"):]
        self.assertIn(f"= '{SM_0250}' as sellable_is_0250s", verify)
        cols = re.findall(r" as (\w+)[,;]", verify)
        self.assertEqual(cols, ["sellable_is_0250s", "music_is_known", "registry_knows_music", "members_can_list", "anon_cannot_list",
                                "model_ok_is_0250s", "no_music_on_the_api", "no_music_on_mcp"])
        self.assertIn(f"= '{OK_0250}' as model_ok_is_0250s", verify)
        self.assertIn(f"is distinct from '{OK_0250}'", end)
        self.assertIn(f"array['{OK_0188}', '{OK_0250}']", NEW_TEXT)

    def test_the_header_states_the_hashes_and_the_sweep(self):
        header = NEW_TEXT[: NEW_TEXT.index("set local lock_timeout")]
        for h in (SM_0192, SM_0250, FOLD_SM_0192, FOLD_SM_0250):
            self.assertIn(h, header)
        for part in ("MUST ADD music", "ALREADY KNOW music", "NO CLOSED LIST", "CORRECTLY EXCLUDE music", "STAY UNKNOWN"):
            self.assertIn(part, header)
        for fn in ("api_creative_models", "oauth_creative_capabilities", "film_take_job", "reroute_creative_job", "route_model",
                   "creative_operator_preview", "claim_creative_job", "capture_credits", "media_mime_kind"):
            self.assertIn(fn, header)

    def test_no_backslash_and_no_double_dash_in_a_literal(self):
        for name, text in (("migration", NEW_TEXT), ("rollback", ROLLBACK)):
            self.assertNotIn(chr(92), text, name)
            code = "\n".join(ln for ln in text.splitlines() if not ln.lstrip().startswith("--"))
            for lit in re.findall(r"'(?:[^']|'')*'", code):
                self.assertNotIn("--", lit, (name, lit))


class TheRollback(unittest.TestCase):
    def test_it_puts_0192s_and_0188s_bodies_back_verbatim(self):
        self.assertEqual(fn_of(ROLLBACK), fn_of(T192))
        self.assertEqual(md5_of(fn_of(ROLLBACK)), SM_0192)
        self.assertEqual(fn_of(ROLLBACK, "api_creative_model_ok"), fn_of(T188, "api_creative_model_ok"))
        self.assertIn(f"array['{OK_0250}', '{OK_0188}']", ROLLBACK)
        self.assertIn(f"is distinct from '{OK_0188}'", ROLLBACK)

    def test_it_refuses_while_a_music_model_is_on_sale(self):
        # A NOTICE would let the dead end back in (routed quotes find nothing, the failover raises 22023): a named refusal.
        self.assertIn("raise exception 'rollback 0250: these music models are on sale", ROLLBACK)
        self.assertNotIn("raise notice", ROLLBACK)
        self.assertIn("'music' = any (capabilities) and availability in ('beta', 'ga')", ROLLBACK)
        self.assertLess(ROLLBACK.index("these music models are on sale"), ROLLBACK.index("create or replace function"))

    def test_it_refuses_an_unknown_body_and_asserts_the_end_state(self):
        self.assertIn(f"array['{SM_0250}', '{SM_0192}']", ROLLBACK)
        self.assertIn("rollback 0250: sellable_models() is neither 0250''s body nor 0192''s", ROLLBACK)
        self.assertIn(f"is distinct from '{SM_0192}'", ROLLBACK)
        self.assertLess(ROLLBACK.index("rollback 0250: sellable_models() is neither"), ROLLBACK.index("create or replace function"))
        self.assertTrue(ROLLBACK.rstrip().endswith("commit;"))
        self.assertIn("\nbegin;\n", ROLLBACK)


class OtherListsStayNarrower(unittest.TestCase):
    """The lists that keep music out on purpose: widening one would sell a web_only model through the API or an assistant, or give
    a film a take kind it has no slot for."""

    def test_the_api_list_has_no_music(self):
        block = OPERATIONS_TS[OPERATIONS_TS.index("export const API_CREATIVE_CAPABILITIES"):]
        self.assertNotIn('"music"', block[: block.index("] as const")])
        self.assertNotRegex(NEW_TEXT, r"(?i)create or replace function public\.(api_creative_models|oauth_creative_capabilities|film_)")

    def test_0250_replaces_one_function_and_alters_nothing(self):
        code = "\n".join(ln.split("--", 1)[0] for ln in NEW_TEXT.splitlines()).lower()
        self.assertEqual(re.findall(r"create or replace function public\.(\w+)", code), ["sellable_models", "api_creative_model_ok"])
        for word in ("alter table", "create table", "insert into", "update public.", "delete from", "drop "):
            self.assertNotIn(word, code, word)


class TheLab(unittest.TestCase):
    def test_the_lab_knows_the_hashes_and_the_chain(self):
        self.assertIn(f'SELLABLE_MODELS_0192 = "{SM_0192}"', LAB)
        self.assertIn(f'SELLABLE_MODELS_0250 = "{SM_0250}"', LAB)
        take_off_0192 = LAB[LAB.index("def take_off_0192"):LAB.index("def put_back_0192")]
        self.assertIn("take_off_0250(conn)", take_off_0192)
        put_back_0192 = LAB[LAB.index("def put_back_0192"):LAB.index("MIGRATION_0196 =")]
        self.assertIn("put_back_0250(conn)", put_back_0192)
        self.assertIn("import sec_music_job_path_0250", EXPECT)

    def test_the_owner_step_is_documented(self):
        self.assertIn("(0250)", DOCS)
        section = DOCS[DOCS.index("(0250)"):]
        self.assertIn("0228", section[:9000])
        self.assertIn("rollback_0250_music_in_job_path_lists.sql", section[:9000])


if __name__ == "__main__":
    unittest.main()

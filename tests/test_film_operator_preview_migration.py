"""supabase/migrations/0235_film_operator_preview.sql — Film Studio lets the platform operator use an operator-preview model in the
operator's own organization (0139's rule), and nowhere else.

SQL does not run in this suite (tests/security/test_sec_film_operator_preview_0235.py does, against a real Postgres). These pin what
must not change by accident: each replaced body is its live predecessor plus exactly the listed hunks (undo them and the rest is the old
text byte for byte), the new overloads are the three-argument ones plus the preview branch only (Seedance still first), the rollback
puts back exactly the predecessors, the hashes in the guards, the end state, the rollback and the lab are recomputed from the files,
neither file holds a backslash, every API role is refused, the lab's chain and sequence lists know the file, the registry marks exactly
the two ElevenLabs rows, and the docs describe it.
"""

import hashlib
import json
import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MIG = ROOT / "supabase" / "migrations"
NEW_TEXT = (MIG / "0235_film_operator_preview.sql").read_text(encoding="utf-8")
ROLLBACK_TEXT = (ROOT / "docs" / "sql" / "rollback_0235_film_operator_preview.sql").read_text(encoding="utf-8")
LAB = (ROOT / "tests" / "security" / "sec_db.py").read_text(encoding="utf-8")
EXPECT = (ROOT / "tests" / "security" / "sec_expectations.py").read_text(encoding="utf-8")
BS = "@@0235_BACKSLASH@@"


def bodies(text):
    """Every `create or replace function public.<name>(` statement, keyed by name and its first parameter list (overloads apart)."""
    # film_price's body is executed from a dollar-quoted string, its backslash spelled BS: read it as the body that reaches the database.
    text = text.replace(BS, "\\").replace("$fp0235$", "\n")
    out = {}
    for m in re.finditer(r"(?m)^create or replace function public\.(\w+)\((.*?)\).*?^\$\$;?", text, re.S):
        out[(m.group(1), len([p for p in m.group(2).split(",") if p.strip()]))] = m.group(0).rstrip(";")
    return out


def md5_of(fn):
    b = fn[fn.index("$$") + 2: fn.rindex("$$")]
    return hashlib.md5(re.sub(r"\s+", " ", b).encode()).hexdigest()


def src(name, n, file):
    return bodies((MIG / file).read_text(encoding="utf-8"))[(name, n)]


NEW = bodies(NEW_TEXT)
BACK = bodies(ROLLBACK_TEXT)
OLD = {("film_price", 1): src("film_price", 1, "0218_creative_prompt_limits.sql"),
       ("film_precheck", 1): src("film_precheck", 1, "0171_films_money.sql"),
       ("film_resume_precheck", 2): src("film_resume_precheck", 2, "0215_film_archive_resume.sql"),
       ("film_apply_settings", 3): src("film_apply_settings", 3, "0166_films_core.sql"),
       ("film_save_scenes", 2): src("film_save_scenes", 2, "0166_films_core.sql")}
BEFORE = {("film_price", 1): "3c22f87be736c073d17d93e040e914e1", ("film_precheck", 1): "ff4fa7e8a6386420f32ab6a3a85a778c",
          ("film_resume_precheck", 2): "aa7275ed5e8520af52cabd03c2f930d8",
          ("film_apply_settings", 3): "248ffb76f60f3a6f4e8b34b85cd0c92b", ("film_save_scenes", 2): "c836631256f669318c9ef499d7c4c54b"}
AFTER = {("film_price", 1): "186d34ffb633bc56a91bbf617b0b7520", ("film_precheck", 1): "826a4c57a5a97ef44634cb7e25d1f11d",
         ("film_resume_precheck", 2): "ca3ccf2b51ddd0b4e3cc71aedee216e4",
         ("film_apply_settings", 3): "f5cdf963343a4b722333eaf0d13bd840", ("film_save_scenes", 2): "d2d32abea21beb742eea14d92ad6e9fd",
         ("film_check_model", 4): "5a2c4ed8d8b56bc63d6d095085ab0361", ("film_model_problem", 4): "48d25f5cb4f21b9cea72658968d9c952"}
CHECK3, PROBLEM3 = "864da632969ae05f964eee1b568a671f", "d828ee349aa5da3aa05ea9db4d8f1b94"

TAG = "-- 0235: the film's organization, so a platform admin's operator preview in the exempt organization passes (and nobody else's).\n"
#: (old, new) for each call 0235 gives the film's organization; the marker line goes above each, at the call's own indentation.
CALLS = {
    ("film_price", 1): [
        ("public.film_model_problem(kmodel, array['t2i', 'edit'], label || ' keyframe_model')",
         "public.film_model_problem(kmodel, array['t2i', 'edit'], label || ' keyframe_model', f.org_id)"),
        ("public.film_model_problem(cmodel, array['i2v'], label || ' clip_model')",
         "public.film_model_problem(cmodel, array['i2v'], label || ' clip_model', f.org_id)"),
        ("public.film_model_problem(f.voice ->> 'model', array['tts'], 'voice.model')",
         "public.film_model_problem(f.voice ->> 'model', array['tts'], 'voice.model', f.org_id)")],
    ("film_precheck", 1): [("public.film_model_problem(mm.model, mm.caps, mm.field)",
                            "public.film_model_problem(mm.model, mm.caps, mm.field, p_film.org_id)")],
    ("film_resume_precheck", 2): [("public.film_model_problem(mm.model, mm.caps, mm.field)",
                                   "public.film_model_problem(mm.model, mm.caps, mm.field, p_film.org_id)")],
    ("film_apply_settings", 3): [("                                             kv.key);", "                                             kv.key, f.org_id);"),
                                 ("public.film_check_model(v ->> 'model', array['tts'], 'voice.model')",
                                  "public.film_check_model(v ->> 'model', array['tts'], 'voice.model', f.org_id)")],
    ("film_save_scenes", 2): [("format('%s %s', label, ck));", "format('%s %s', label, ck), p_film.org_id);")],
}


#: 0235's one hunk in film_price that is not a call: the refs path (a key frame with references, on a model whose adapter does not send
#: them on t2i, is refused before any hold). (old, new), as in 0218's file.
REFS_OLD = """                                                   label, kmodel, ref_max, refs_n));
        elsif cap = 'edit' and stand is null then
"""
REFS_NEW = """                                                   label, kmodel, ref_max, refs_n));
        -- 0235 (refs path): a film's key frame is made from words (film_take_job sends t2i), and an adapter sends references only on
        -- the capabilities it lists (registry inputs.ref_capabilities, checked against the adapter): one that does not list t2i would
        -- refuse this take at submit, after the hold. Not listed, or not stated at all, is refused here, before anything is held.
        elsif refs_n > 0 and not coalesce(jsonb_typeof(spec -> 'inputs' -> 'ref_capabilities') = 'array'
                                          and (spec -> 'inputs' -> 'ref_capabilities') ? 't2i', false) then
          q := jsonb_build_object('priced', false, 'reason', 'refs_not_supported',
                                  'detail', format('%s: %s does not take reference pictures for a key frame made from words; remove the reference pictures or choose a key-frame model that takes them',
                                                   label, kmodel));
        elsif cap = 'edit' and stand is null then
"""


def undo(new):
    """The body with 0235's marker lines removed and its calls given back their three arguments."""
    lines = [ln for ln in new.splitlines(keepends=True) if ln.strip() != TAG.strip()]
    return "".join(lines)


class FilmOperatorPreviewMigration(unittest.TestCase):
    def test_it_replaces_the_five_callers_adds_the_two_overloads_and_writes_nothing(self):
        self.assertEqual(set(NEW), set(OLD) | {("film_check_model", 4), ("film_model_problem", 4)})
        # Outside the function bodies (film_save_scenes' own statements are 0166's, verbatim, and pinned above): no DDL, no row written.
        outside = NEW_TEXT.replace(BS, "\\").replace("$fp0235$", "\n")
        for body in NEW.values():
            outside = outside.replace(body, "")
        code = "\n".join(line.split("--", 1)[0] for line in outside.splitlines()).lower()
        for word in ("drop table", "drop column", "drop function", "delete from", "truncate", "alter table", "create policy",
                     "create table", "grant "):
            self.assertNotIn(word, code)
        self.assertNotRegex(code, r"\b(insert\s+into|update\s+public\.|upsert)")

    def test_each_caller_is_its_live_body_plus_exactly_the_marked_calls(self):
        for key, calls in CALLS.items():
            old, new = OLD[key], NEW[key]
            self.assertEqual(md5_of(old), BEFORE[key], key)
            self.assertEqual(md5_of(new), AFTER[key], key)
            self.assertEqual(new.count(TAG.strip()), len(calls), key)
            if key == ("film_price", 1):
                self.assertEqual(old.count(REFS_OLD), 1)
                self.assertEqual(new.count(REFS_NEW), 1)
                new = new.replace(REFS_NEW, REFS_OLD)
            undone = undo(new)
            for a, b in calls:
                self.assertEqual(old.count(a), 1, (key, a))
                self.assertEqual(undone.count(b), 1, (key, b))
                undone = undone.replace(b, a)
            self.assertEqual(undone, old, f"{key} differs from its live body beyond the marked calls")
            # every call to the check in the new body carries the organization: none was left on the three-argument form
            self.assertNotRegex(new, r"film_(check_model|model_problem)\([^;]*'voice\.model'\)", key)

    def test_the_overloads_are_the_old_check_and_wrapper_plus_the_preview_branch_only(self):
        check3 = src("film_check_model", 3, "0166_films_core.sql")
        problem3 = src("film_model_problem", 3, "0171_films_money.sql")
        self.assertEqual((md5_of(check3), md5_of(problem3)), (CHECK3, PROBLEM3))
        c4, p4 = NEW[("film_check_model", 4)], NEW[("film_model_problem", 4)]
        self.assertEqual(md5_of(c4), AFTER[("film_check_model", 4)])
        self.assertEqual(md5_of(p4), AFTER[("film_model_problem", 4)])
        self.assertEqual(p4.replace("p_field text, p_org uuid)", "p_field text)").replace("p_field, p_org);", "p_field);"), problem3)
        # The check: Seedance refused before anything that could pass a model; the preview branch only after sellable_models.
        seed, sold, pv, refuse = (c4.index("'model_not_offered'"), c4.index("sellable_models(c, 'web')"),
                                  c4.index("creative_operator_preview(p_org, m.availability, m.spec)"), c4.rindex("'model_not_available'"))
        self.assertLess(seed, sold)
        self.assertLess(sold, pv)
        self.assertLess(pv, refuse)
        for proof in ("m.verified_at is not null", "m.verified_probe_id is not null", "not public.model_past_shutdown(m.spec)",
                      "public.model_is_available(m.id)", "m.capabilities && p_caps", "p_org is not null"):
            self.assertIn(proof, c4[pv - 400: refuse])
        # the id rule and the Seedance refusal are 0166's, word for word
        head3 = check3[check3.index("begin\n"): check3.index("  if not exists (select 1 from unnest(p_caps)")]
        self.assertIn(head3, c4)
        self.assertIn("format('%s: %s is not on sale for this', p_field, p_model)", c4)

    def test_the_refs_path_follows_the_count_check_fails_closed_and_names_the_remedy(self):
        fp = NEW[("film_price", 1)]
        self.assertLess(fp.index("if refs_n > ref_max then"), fp.index("-- 0235 (refs path)"))
        self.assertLess(fp.index("-- 0235 (refs path)"), fp.index("elsif cap = 'edit' and stand is null then"))
        # a missing or non-array field is "not supported" (coalesce(..., false) under not), and only t2i counts: the take's path
        self.assertIn("not coalesce(jsonb_typeof(spec -> 'inputs' -> 'ref_capabilities') = 'array'", fp)
        self.assertIn("(spec -> 'inputs' -> 'ref_capabilities') ? 't2i', false)", fp)
        self.assertIn("remove the reference pictures or choose a key-frame model that takes them", fp)
        self.assertIn("THE REFS PATH", NEW_TEXT)

    def test_the_rollback_puts_back_exactly_the_predecessors_and_drops_the_overloads(self):
        self.assertEqual(set(BACK), set(OLD))
        for key in OLD:
            self.assertEqual(BACK[key], OLD[key], key)
        self.assertIn("drop function if exists public.film_model_problem(text, text[], text, uuid);", ROLLBACK_TEXT)
        self.assertIn("drop function if exists public.film_check_model(text, text[], text, uuid);", ROLLBACK_TEXT)
        self.assertLess(ROLLBACK_TEXT.index("rollback 0235: % is neither"), ROLLBACK_TEXT.index("create or replace function"))
        self.assertTrue(ROLLBACK_TEXT.lstrip("-").strip().startswith("rollback_0235"))
        self.assertIn("\nbegin;\n", ROLLBACK_TEXT)
        self.assertTrue(ROLLBACK_TEXT.rstrip().endswith("commit;"))

    def test_no_backslash_in_either_file_and_film_prices_is_put_back_with_chr_92(self):
        for name, text in (("migration", NEW_TEXT), ("rollback", ROLLBACK_TEXT)):
            self.assertNotIn("\\", text, name)
            self.assertIn("[[:space:]]+", text, name)
            self.assertEqual(text.count(f"'{BS}', chr(92))"), 1, name)
        # the one backslash is film_price's clip-length pattern, in both files
        self.assertIn(f"x ~ '^[0-9]{{1,3}}(@@0235_BACKSLASH@@.[0-9]+)?$'", NEW_TEXT)
        self.assertIn(f"x ~ '^[0-9]{{1,3}}(@@0235_BACKSLASH@@.[0-9]+)?$'", ROLLBACK_TEXT)

    def test_the_guards_the_end_state_and_the_rollback_name_the_recomputed_hashes(self):
        for key, h in BEFORE.items():
            self.assertIn(f"'{h}'", NEW_TEXT, key)
            self.assertIn(f"'{h}'", ROLLBACK_TEXT, key)
        for key, h in AFTER.items():
            self.assertGreaterEqual(NEW_TEXT.count(f"'{h}'"), 2, key)  # the drift guard and the end state
            self.assertIn(f"'{h}'", ROLLBACK_TEXT, key)
        for h in (CHECK3, PROBLEM3):
            self.assertIn(f"'{h}'", NEW_TEXT)
            self.assertIn(f"'{h}'", ROLLBACK_TEXT)
        self.assertLess(NEW_TEXT.index("0235 found a %"), NEW_TEXT.index("create or replace function"))
        self.assertIn("0235 end state:", NEW_TEXT)
        self.assertIn("set local lock_timeout = '5s';", NEW_TEXT)
        self.assertIn("-- Verify (run after applying", NEW_TEXT)

    def test_every_body_is_revoked_from_every_api_role(self):
        for sig in ("film_check_model(text, text[], text, uuid)", "film_model_problem(text, text[], text, uuid)",
                    "film_apply_settings(public.films, jsonb, text[])", "film_save_scenes(public.films, jsonb)",
                    "film_precheck(public.films)", "film_resume_precheck(public.films, uuid)", "film_price(public.films)"):
            self.assertIn(f"revoke all on function public.{sig} from public, anon, authenticated, service_role;", NEW_TEXT)
        self.assertNotIn("grant execute", NEW_TEXT.lower())
        self.assertIn('functions.update({"film_check_model": SERVICE, "film_model_problem": SERVICE})',
                      (ROOT / "tests" / "security" / "sec_film_operator_preview_0235.py").read_text(encoding="utf-8"))
        self.assertIn("import sec_film_operator_preview_0235", EXPECT)

    def test_no_later_migration_replaces_what_it_wrote(self):
        later = sorted(p.name for p in MIG.glob("*.sql") if p.name[:4] > "0235")
        for f in later:
            text = (MIG / f).read_text(encoding="utf-8")
            for name, _n in AFTER:
                if f == "0236_film_clip_sound_gate.sql" and name == "film_price":
                    # 0236 (next in Atlas's order) replaces it with this file's body plus one marked hunk and refuses any other
                    # base (tests/test_film_clip_sound_migration.py undoes the hunk back to this file's body).
                    self.assertIn(f"'{AFTER[('film_price', 1)]}', 'af0fb80cce8e92fd2360aa6d5366a942'", text)
                    continue
                self.assertNotIn(f"function public.{name}(", text, (f, name))

    def test_the_number_is_unique_and_the_lab_knows_the_chain(self):
        self.assertEqual(sorted(p.name[:4] for p in MIG.glob("*.sql")).count("0235"), 1)
        for name, key in (("FILM_PRICE_0235", ("film_price", 1)), ("FILM_CHECK_MODEL_0235", ("film_check_model", 4)),
                          ("FILM_MODEL_PROBLEM_0235", ("film_model_problem", 4))):
            self.assertIn(f'{name} = "{AFTER[key]}"', LAB)
        for h in BEFORE.values():
            self.assertTrue(f'"{h}"' in LAB or h == BEFORE[("film_price", 1)], h)
        for fn in ("take_off_0218", "take_off_0215", "take_off_0139"):
            off = LAB[LAB.index(f"def {fn}("):]
            off = off[:off.index("\ndef ")]
            self.assertIn("take_off_0235(", off, fn)
        for fn in ("put_back_0218", "put_back_0215", "put_back_0139"):
            on = LAB[LAB.index(f"def {fn}("):]
            on = on[:on.index("\ndef ")]
            self.assertIn("put_back_0235(", on, fn)
        # take_off_0171 reaches it through take_off_0218, before 0171's rollback
        off = LAB[LAB.index("def take_off_0171("):LAB.index("def put_back_0171(")]
        self.assertLess(off.index("take_off_0218(conn)"), off.index("rollback_0171_body("))
        # Every sequence list that holds 0218 or 0215 ends on 0235 (it refuses to apply without them).
        self.assertIn('ON_0156 = (*ON_0156, "0235_film_operator_preview.sql")', LAB)
        self.assertIn('ON_0139 = (*(f for f in ON_0139 if f != "0235_film_operator_preview.sql"), "0235_film_operator_preview.sql")', LAB)
        on_0124 = LAB[LAB.index("ON_0124 = ("):]
        on_0124 = on_0124[:on_0124.index(")\n")]
        # ... or on 0236, which sits on this file's film_price and comes right after it.
        tail = on_0124.rstrip()
        self.assertTrue(tail.endswith('"0235_film_operator_preview.sql"') or tail.endswith(
            '"0235_film_operator_preview.sql",\n           # 0236 replaces 0235\'s film_price and 0215\'s film_assembly_retryable and refuses '
            'to apply without them: last.\n           "0236_film_clip_sound_gate.sql"'), on_0124[-300:])
        self.assertLess(LAB.index('ON_0156 = (*(f for f in ON_0156 if f != "0230_geo_gate_allow_list.sql")'),
                        LAB.index('ON_0156 = (*ON_0156, "0235_film_operator_preview.sql")'))

    def test_the_header_names_the_overlap_with_0220_and_the_take_time_rule(self):
        for words in ("Draft #920 (0220", "film_take_job (0198)", "credits.is_exempt", "operator_preview_runnable",
                      "python tools/probe_models.py --sync"):
            self.assertIn(words, NEW_TEXT)

    def test_the_docs_describe_it(self):
        docs = (ROOT / "docs" / "MIGRATIONS.md").read_text(encoding="utf-8")
        self.assertIn("## Film Studio: the operator's preview models (0235, provisional)", docs)
        self.assertIn("rollback_0235_film_operator_preview.sql", docs)


class TheRegistrySide(unittest.TestCase):
    """0235 opens nothing by itself: a row needs `"operator_preview": true`, and this pull request sets it on two rows only."""

    def test_only_elevenlabs_v3_and_v4_gain_the_flag_and_they_stay_hidden_terms_gated_tts(self):
        rows = {m["id"]: m for m in json.loads((ROOT / "schemas" / "model_registry.json").read_text(encoding="utf-8"))["models"]}
        tts_marked = sorted(i for i, m in rows.items() if "tts" in m.get("capabilities", []) and m.get("operator_preview") is True)
        self.assertEqual(tts_marked, ["elevenlabs-v3", "elevenlabs-v4"])
        for mid in tts_marked:
            m = rows[mid]
            self.assertIs(m["operator_preview"], True)
            self.assertEqual(m["capabilities"], ["tts"])
            self.assertIn("uz", m["languages"])
            self.assertIn("ru", m["languages"])
            self.assertTrue(m.get("terms_gate"), mid)  # still gated: hidden from every customer, previewed by the operator only
            self.assertNotIn(m.get("availability"), ("beta", "ga"), mid)
        # no other ElevenLabs row is marked
        self.assertEqual(sorted(i for i, m in rows.items() if m.get("provider") == "elevenlabs" and m.get("operator_preview")),
                         ["elevenlabs-v3", "elevenlabs-v4"])


if __name__ == "__main__":
    unittest.main()

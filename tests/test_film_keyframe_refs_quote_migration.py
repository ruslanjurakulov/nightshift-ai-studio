"""supabase/migrations/0239_film_keyframe_refs_quote.sql — a film's key frame is quoted the way its take and the worker make it.

SQL does not run in this suite (tests/security/test_sec_film_keyframe_refs_quote_0239.py and test_sec_breach_0235_refs_take.py do,
against a real Postgres). These pin what must not change by accident: each replaced body is 0235's plus exactly the hunks below (undo
them and the rest is 0235's text byte for byte), the rollback puts back exactly 0235's bodies, the hashes in the guards, the end state,
the rollback and the lab are recomputed from the files, neither file holds a backslash, no API role is granted anything, the file
replaces neither start_film nor film_take_job (a later file does), the lab's chain and sequence lists know it, and the docs describe it.
"""

import hashlib
import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MIG = ROOT / "supabase" / "migrations"
NEW_TEXT = (MIG / "0239_film_keyframe_refs_quote.sql").read_text(encoding="utf-8")
ROLLBACK_TEXT = (ROOT / "docs" / "sql" / "rollback_0239_film_keyframe_refs_quote.sql").read_text(encoding="utf-8")
OLD_TEXT = (MIG / "0235_film_operator_preview.sql").read_text(encoding="utf-8")
OLD_PRICE_TEXT = (MIG / "0236_film_clip_sound_gate.sql").read_text(encoding="utf-8")
LAB = (ROOT / "tests" / "security" / "sec_db.py").read_text(encoding="utf-8")


def bodies(text):
    """Every `create or replace function public.<name>(` statement, keyed by name; film_price's read as the body that reaches the
    database (its backslash placeholder put back)."""
    for tag in ("0235", "0236", "0239"):
        text = text.replace(f"@@{tag}_BACKSLASH@@", "\\").replace(f"$fp{tag}$", "\n")
    out = {}
    for m in re.finditer(r"(?m)^create or replace function public\.(\w+)\(.*?^\$\$;?", text, re.S):
        out[m.group(1)] = m.group(0).rstrip(";")
    return out


def md5_of(fn):
    b = fn[fn.index("$$") + 2: fn.rindex("$$")]
    return hashlib.md5(re.sub(r"\s+", " ", b).encode()).hexdigest()


NEW = bodies(NEW_TEXT)
BACK = bodies(ROLLBACK_TEXT)
#: film_price is 0236's (0235's plus 0236's clip-sound hunk); the two save bodies are 0235's (0236 does not touch them).
OLD = {**{k: v for k, v in bodies(OLD_TEXT).items() if k in ("film_apply_settings", "film_save_scenes")},
       "film_price": bodies(OLD_PRICE_TEXT)["film_price"]}
BEFORE = {"film_price": "af0fb80cce8e92fd2360aa6d5366a942", "film_apply_settings": "f5cdf963343a4b722333eaf0d13bd840",
          "film_save_scenes": "d2d32abea21beb742eea14d92ad6e9fd"}
AFTER = {"film_price": "02016cc4a695a54c5693a5066247269b", "film_apply_settings": "9a2ae594cb08df36973c7e656a7f1c9d",
         "film_save_scenes": "4115ba8800b1b1a702585267d27af17c"}

# 0239's hunks, (old, new), on 0236's film_price and 0235's two save bodies.
APPLY_SETTINGS = [(
"""            perform public.film_check_model(m, case when kv.key = 'keyframe_model' then array['t2i', 'edit'] else array['i2v'] end,
                                             kv.key, f.org_id);
          end if;
""",
"""            perform public.film_check_model(m, case when kv.key = 'keyframe_model' then array['t2i', 'edit'] else array['i2v'] end,
                                             kv.key, f.org_id);
            -- 0239: a key frame is made from words (film_take_job sends t2i and refuses a model without it), so a model on sale only
            -- for editing a picture cannot be the key-frame model: refused here, by name, never priced and then refused at the take.
            if kv.key = 'keyframe_model' and public.film_model_problem(m, array['t2i'], kv.key, f.org_id) is not null then
              perform public.creative_refuse('model_not_available',
                format('%s: %s is not on sale for making a picture from words, and a key frame is made from words; choose a key-frame model that makes a picture from words',
                       kv.key, m));
            end if;
          end if;
""")]

SAVE_SCENES = [(
"""            perform public.film_check_model(m, case when ck = 'keyframe_model' then array['t2i', 'edit'] else array['i2v'] end,
                                             format('%s %s', label, ck), p_film.org_id);
          end if;
""",
"""            perform public.film_check_model(m, case when ck = 'keyframe_model' then array['t2i', 'edit'] else array['i2v'] end,
                                             format('%s %s', label, ck), p_film.org_id);
            -- 0239: a key frame is made from words (film_take_job sends t2i and refuses a model without it), so a model on sale only
            -- for editing a picture cannot be a scene's key-frame model: refused here, by name, never priced and then refused at the take.
            if ck = 'keyframe_model' and public.film_model_problem(m, array['t2i'], format('%s %s', label, ck), p_film.org_id) is not null then
              perform public.creative_refuse('model_not_available',
                format('%s %s: %s is not on sale for making a picture from words, and a key frame is made from words; choose a key-frame model that makes a picture from words',
                       label, ck, m));
            end if;
          end if;
""")]

FILM_PRICE = [
# 1. the declarations the style path needs
(
"""  ref_max  integer;
""",
"""  ref_max  integer;
  refs_k   integer;  -- 0239: the film references the take carries (film_take_job's own count)
  slots    integer;  -- 0239: the model's references left for the style kit's and @characters' pictures
  owners   jsonb;    -- 0239: the kit and the mentioned characters, as the worker reads them
  own      jsonb;    -- 0239
  seen     text[];   -- 0239
  got      text[];   -- 0239
  lost     text[];   -- 0239
  depth    integer;  -- 0239
  n_picked integer;  -- 0239
"""),
# 2. B1: an edit-only key-frame model
(
"""      q := case when kmodel is not null then public.film_model_problem(kmodel, array['t2i', 'edit'], label || ' keyframe_model', f.org_id) end;
""",
"""      q := case when kmodel is not null then public.film_model_problem(kmodel, array['t2i', 'edit'], label || ' keyframe_model', f.org_id) end;
      -- 0239: the key frame is made from words (film_take_job sends t2i and refuses a model without it): a model on sale only for
      -- editing a picture is refused here, by name, before anything is held.
      if q is null and kmodel is not null
         and public.film_model_problem(kmodel, array['t2i'], label || ' keyframe_model', f.org_id) is not null then
        q := jsonb_build_object('priced', false, 'reason', 'model_not_available',
                                'detail', format('%s: %s is not on sale for making a picture from words, and a key frame is made from words; choose a key-frame model that makes a picture from words',
                                                 label, kmodel));
      end if;
"""),
# 3. B2 / B3: what the worker adds beside the film's references, computed before the branch chain
(
"""        if refs_n > ref_max then
""",
"""        -- 0239 (style path): the worker (film_orchestrator._inputs, creative_worker._style) puts the film's references in front and
        -- gives the style kit's and the @characters' pictures only the slots they leave (creative_style.pick_references: in turns,
        -- each character in order of mention and then the kit, a picture shared by two going once). A kit or character with no
        -- description that gets none of its pictures would reach the model as nothing, and the worker refuses that take after the
        -- hold (rule 4): it is counted here exactly that way and refused by name. The pictures are the ones creative_job_style hands
        -- out (live, an image the vendors read), the @names its pattern finds in the visual prompt (the take's prompt), at most 16.
        refs_k := (select count(*) from public.film_refs r
                    where r.film_id = f.id and (r.scene_id is null or r.scene_id = sc.id) and r.asset_id is not null)
                  + (select count(*) from public.film_refs r
                       join public.character_references cr on cr.character_id = r.character_id and cr.org_id = r.org_id
                      where r.film_id = f.id and (r.scene_id is null or r.scene_id = sc.id) and r.character_id is not null);
        slots := case when jsonb_typeof(spec -> 'inputs' -> 'ref_capabilities') = 'array'
                           and (spec -> 'inputs' -> 'ref_capabilities') ? 't2i'
                      then greatest(ref_max - refs_k, 0) else 0 end;
        select coalesce(jsonb_agg(x.o order by x.k1, x.k2), '[]'::jsonb) into owners from (
          select 0 as k1, mn.first_at as k2,
                 jsonb_build_object('name', '@' || c.name, 'described', coalesce(c.description, '') ~ '[^[:space:]]',
                   'refs', coalesce((select jsonb_agg(a.id::text order by cr.position)
                                       from public.character_references cr join public.media_assets a on a.id = cr.asset_id
                                      where cr.character_id = c.id and cr.org_id = f.org_id and a.org_id = f.org_id
                                        and a.kind = 'image' and a.deleted_at is null and a.purged_at is null
                                        and (a.mime in ('image/jpeg', 'image/png', 'image/webp')
                                             or (a.mime in ('image/heic', 'image/heif') and 'display' = any (a.variants)))), '[]'::jsonb)) as o
            from (select lower(m.x[1]) as name, min(m.o) as first_at
                    from regexp_matches(coalesce(sc.visual_prompt, ''),
                                        '(?:^|[^A-Za-z0-9_@])@([A-Za-z0-9_]{2,32})(?![A-Za-z0-9_])', 'g') with ordinality as m(x, o)
                   group by lower(m.x[1]) order by min(m.o) limit 16) mn
            join public.characters c on c.name = mn.name and c.org_id = f.org_id
          union all
          select 1, 0,
                 jsonb_build_object('name', 'the style kit', 'described', coalesce(k.description, '') ~ '[^[:space:]]',
                   'refs', coalesce((select jsonb_agg(a.id::text order by kr.position)
                                       from public.style_kit_references kr join public.media_assets a on a.id = kr.asset_id
                                      where kr.kit_id = k.id and kr.org_id = f.org_id and a.org_id = f.org_id
                                        and a.kind = 'image' and a.deleted_at is null and a.purged_at is null
                                        and (a.mime in ('image/jpeg', 'image/png', 'image/webp')
                                             or (a.mime in ('image/heic', 'image/heif') and 'display' = any (a.variants)))), '[]'::jsonb))
            from public.style_kits k where k.id = f.style_kit_id and k.org_id = f.org_id) x;
        seen := '{}';
        got := '{}';
        n_picked := 0;
        depth := 0;
        while n_picked < slots
              and exists (select 1 from jsonb_array_elements(owners) e where jsonb_array_length(e -> 'refs') > depth) loop
          for own in select e from jsonb_array_elements(owners) with ordinality t(e, i) order by t.i loop
            if jsonb_array_length(own -> 'refs') > depth and n_picked < slots and not ((own -> 'refs' ->> depth) = any (seen)) then
              seen := seen || (own -> 'refs' ->> depth);
              got := got || (own ->> 'name');
              n_picked := n_picked + 1;
            end if;
          end loop;
          depth := depth + 1;
        end loop;
        select coalesce(array_agg(e ->> 'name' order by t.i), '{}') into lost
          from jsonb_array_elements(owners) with ordinality t(e, i)
         where not (e ->> 'described')::boolean and not ((e ->> 'name') = any (got));
        if refs_n > ref_max then
"""),
# 4. B6: never more than film_take_job sends
(
"""                                                   label, kmodel, ref_max, refs_n));
        -- 0235 (refs path)""",
"""                                                   label, kmodel, ref_max, refs_n));
        -- 0239: film_take_job sends a key frame at most 16 reference pictures, whatever the model states (the schema allows 30).
        elsif refs_k > 16 then
          q := jsonb_build_object('priced', false, 'reason', 'refs_not_supported',
                                  'detail', format('%s: a key frame carries at most 16 reference pictures and this scene has %s; remove some',
                                                   label, refs_k));
        -- 0235 (refs path)"""),
# 5. B2 / B3: the refusal
(
"""                                                   label, kmodel));
        elsif cap = 'edit' and stand is null then
""",
"""                                                   label, kmodel));
        -- 0239 (style path): see above.
        elsif cardinality(lost) > 0 then
          q := jsonb_build_object('priced', false, 'reason', 'style_needs_description',
                                  'detail', format('%s: %s %s no description, and %s takes none of %s pictures for this key frame; add a description to the style kit or character, or choose a key-frame model that takes reference pictures',
                                                   label, array_to_string(lost, ' and '),
                                                   case when cardinality(lost) = 1 then 'has' else 'have' end, kmodel,
                                                   case when cardinality(lost) = 1 then 'its' else 'their' end));
        elsif cap = 'edit' and stand is null then
"""),
# 6. B4: a reference character's picture deleted
(
"""      'detail', 'a reference picture or character no longer exists; remove it or choose another'));
  end if;
""",
"""      'detail', 'a reference picture or character no longer exists; remove it or choose another'));
  end if;
  -- 0239: a character is all of its pictures (0166), and the take asks that every one is still in the library (film_take_job): a
  -- picture deleted since is refused here, by name, never priced and then refused at the take.
  if exists (select 1 from public.film_refs r
               join public.character_references cr on cr.character_id = r.character_id and cr.org_id = r.org_id
              where r.film_id = f.id and r.character_id is not null
                and not public.film_asset_live(r.org_id, cr.asset_id, 'image')) then
    refusals := refusals || jsonb_build_array(jsonb_build_object('line', 'film', 'reason', 'reference_missing',
      'detail', 'a picture of a reference character was deleted from the library; remove it from the character, or remove the character from the references'));
  end if;
"""),
]

HUNKS = {"film_apply_settings": APPLY_SETTINGS, "film_save_scenes": SAVE_SCENES, "film_price": FILM_PRICE}


class FilmKeyframeRefsQuoteMigration(unittest.TestCase):
    def test_it_replaces_exactly_three_bodies_and_neither_start_film_nor_film_take_job(self):
        self.assertEqual(set(NEW), set(HUNKS))
        self.assertEqual(set(BACK), set(HUNKS))
        for fn in ("start_film", "film_take_job", "film_precheck", "film_resume_precheck", "film_check_model", "film_model_problem"):
            self.assertNotIn(f"function public.{fn}(", NEW_TEXT, fn)
            self.assertNotIn(f"function public.{fn}(", ROLLBACK_TEXT, fn)
        # Outside the function bodies (film_save_scenes' own statements are 0166's, verbatim, pinned below): no DDL, no row written.
        outside = NEW_TEXT.replace("@@0239_BACKSLASH@@", "\\").replace("$fp0239$", "\n")
        for body in NEW.values():
            outside = outside.replace(body, "")
        code = "\n".join(line.split("--", 1)[0] for line in outside.splitlines()).lower()
        for word in ("drop table", "drop column", "drop function", "delete from", "truncate", "alter table", "create policy",
                     "create table", "grant "):
            self.assertNotIn(word, code)
        self.assertNotRegex(code, r"\b(insert\s+into|update\s+public\.|upsert)")

    def test_each_body_is_its_predecessor_plus_exactly_the_marked_hunks(self):
        for name, hunks in HUNKS.items():
            old, new = OLD[name], NEW[name]
            self.assertEqual(md5_of(old), BEFORE[name], name)
            self.assertEqual(md5_of(new), AFTER[name], name)
            undone = new
            for a, b in hunks:
                self.assertEqual(old.count(a), 1, (name, a[:60]))
                self.assertEqual(new.count(b), 1, (name, b[:60]))
                self.assertIn("-- 0239", b, (name, b[:60]))
                undone = undone.replace(b, a)
            self.assertEqual(undone, old, f"{name} differs from its predecessor's body beyond the listed hunks")
        # 0236's own clip-sound hunk is kept, untouched
        self.assertIn("'clip_sound_not_kept'", NEW["film_price"])
        self.assertEqual(NEW["film_price"].count("-- 0236"), OLD["film_price"].count("-- 0236"))

    def test_the_rollback_puts_back_exactly_the_predecessors_bodies(self):
        for name in HUNKS:
            self.assertEqual(BACK[name], OLD[name], name)
        self.assertLess(ROLLBACK_TEXT.index("rollback 0239: % is neither"), ROLLBACK_TEXT.index("create or replace function"))
        self.assertEqual(len(re.findall(r"(?m)^begin;$", ROLLBACK_TEXT)), 1)
        self.assertTrue(ROLLBACK_TEXT.rstrip().endswith("commit;"))

    def test_the_guards_the_end_state_and_the_rollback_name_the_recomputed_hashes(self):
        for name in HUNKS:
            src = "0236" if name == "film_price" else "0235"
            self.assertIn(f"'{BEFORE[name]}', '{AFTER[name]}', '{src}'", NEW_TEXT, name)
            self.assertIn(f"'{BEFORE[name]}', '{AFTER[name]}', '{src}'", ROLLBACK_TEXT, name)
            self.assertGreaterEqual(NEW_TEXT.count(f"'{AFTER[name]}'"), 3, name)  # guard, end state, Verify
            self.assertIn(f"'{BEFORE[name]}'", ROLLBACK_TEXT.split("-- 0235's body.", 1)[1], name)  # its end state
        self.assertIn("-- 0236's body, its one backslash put back with chr(92).", ROLLBACK_TEXT)
        self.assertLess(NEW_TEXT.index("0239 found a %"), NEW_TEXT.index("create or replace function"))
        self.assertIn("0239 end state:", NEW_TEXT)
        self.assertIn("set local lock_timeout = '5s';", NEW_TEXT)
        self.assertIn("-- Verify (read-only; run after applying", NEW_TEXT)

    def test_no_backslash_and_film_prices_is_put_back_with_chr_92(self):
        for name, text in (("migration", NEW_TEXT), ("rollback", ROLLBACK_TEXT)):
            self.assertNotIn("\\", text, name)
            self.assertIn("[[:space:]]+", text, name)
            self.assertEqual(text.count("'@@0239_BACKSLASH@@', chr(92))"), 1, name)

    def test_no_api_role_is_granted_anything(self):
        for sig in ("film_apply_settings(public.films, jsonb, text[])", "film_save_scenes(public.films, jsonb)", "film_price(public.films)"):
            self.assertIn(f"revoke all on function public.{sig} from public, anon, authenticated, service_role;", NEW_TEXT)
        self.assertNotIn("grant execute", NEW_TEXT.lower())

    def test_every_new_refusal_names_its_remedy(self):
        fp = NEW["film_price"]
        for reason, remedy in (("style_needs_description", "add a description to the style kit or character, or choose a key-frame "
                                                            "model that takes reference pictures"),
                               ("model_not_available", "choose a key-frame model that makes a picture from words"),
                               ("refs_not_supported", "remove some"),
                               ("reference_missing", "remove it from the character, or remove the character from the references")):
            self.assertIn(f"'{reason}'", fp)
            self.assertIn(remedy, fp, reason)
        for name in ("film_apply_settings", "film_save_scenes"):
            self.assertIn("choose a key-frame model that makes a picture from words", NEW[name])
        # the Command Center knows the new word, in every language, with a way forward
        cc = ROOT / "command-center" / "lib"
        self.assertIn('style_needs_description: "fix_and_requote"', (cc / "studio" / "useFilmStart.ts").read_text(encoding="utf-8"))
        for lang in ("en", "ru", "uz"):
            self.assertIn("style_needs_description:", (cc / "i18n" / "studio-timeline" / f"{lang}.ts").read_text(encoding="utf-8"))

    def test_the_style_path_mirrors_the_workers_reading(self):
        fp = NEW["film_price"]
        job_style = (MIG / "0187_rights_acknowledgement_inputs.sql").read_text(encoding="utf-8")
        # creative_job_style's @name pattern, its 16 names, and its picture filter, word for word
        pattern = "'(?:^|[^A-Za-z0-9_@])@([A-Za-z0-9_]{2,32})(?![A-Za-z0-9_])'"
        self.assertIn(pattern, fp)
        self.assertIn(pattern, job_style)
        self.assertIn("group by lower(m.x[1]) order by min(m.o) limit 16", fp)
        for cond in ("a.kind = 'image' and a.deleted_at is null and a.purged_at is null",
                     "(a.mime in ('image/jpeg', 'image/png', 'image/webp')",
                     "or (a.mime in ('image/heic', 'image/heif') and 'display' = any (a.variants))"):
            self.assertIn(cond, job_style)
            self.assertEqual(fp.count(cond), 2, cond)  # the characters' and the kit's
        # creative_style.pick_references: characters in order of mention, then the kit; a shared picture once; names as unusable() says
        from modules import creative_style as cs
        self.assertIn("'the style kit'", fp)
        self.assertIn("'@' || c.name", fp)
        kit = cs.StyleOwner("k", None, "", ())
        self.assertEqual(cs.unusable(cs.StyleInputs(kit, (cs.StyleOwner("c", "hero", "", ()),)), []), ["the style kit", "@hero"])
        self.assertIn("not ((own -> 'refs' ->> depth) = any (seen))", fp)
        # the slots: the film references the take carries, only when the model lists t2i for references
        self.assertIn("then greatest(ref_max - refs_k, 0) else 0 end;", fp)

    def test_the_number_is_unique_and_the_lab_knows_the_chain(self):
        self.assertEqual(sorted(p.name[:4] for p in MIG.glob("*.sql")).count("0239"), 1)
        for const, name in (("FILM_PRICE_0239", "film_price"), ("FILM_APPLY_SETTINGS_0239", "film_apply_settings"),
                            ("FILM_SAVE_SCENES_0239", "film_save_scenes")):
            self.assertIn(f'{const} = "{AFTER[name]}"', LAB)
        # 0239 rides on 0236's helpers, which 0235's (and 0215's, 0218's, 0139's) reach.
        off = LAB[LAB.index("def take_off_0236("):]
        off = off[:off.index("\ndef ")]
        self.assertLess(off.index("take_off_0239(conn)"), off.index("if has_0236(conn):"))
        on = LAB[LAB.index("def put_back_0236("):]
        on = on[:on.index("\ndef ")]
        self.assertIn("put_back_0239(conn)", on)
        self.assertIn("return rollback_0239_if_on() +", LAB[LAB.index("def rollback_0236_if_on("):LAB.index("def put_back_0236(")])
        self.assertIn("return rollback_0236_if_on() +", LAB[LAB.index("def rollback_0235_if_on("):LAB.index("def put_back_0235(")])
        self.assertIn('_BEFORE_0239 = {"public.film_price(public.films)": FILM_PRICE_0236,', LAB)
        for lst in ('ON_0156 = (*ON_0156, "{}")', 'ON_0139 = (*(f for f in ON_0139 if f != "{}")'):
            self.assertLess(LAB.index(lst.format("0235_film_operator_preview.sql")), LAB.index(lst.format("0236_film_clip_sound_gate.sql")))
            self.assertLess(LAB.index(lst.format("0236_film_clip_sound_gate.sql")), LAB.index(lst.format("0239_film_keyframe_refs_quote.sql")))
        on_0124 = LAB[LAB.index("ON_0124 = ("):]
        on_0124 = on_0124[:on_0124.index(")\n")]
        # Last, or followed only by 0241 (on 0239's film_price and film_save_scenes).
        tail = on_0124.rstrip()
        self.assertTrue(tail.endswith('"0239_film_keyframe_refs_quote.sql"') or
                        (tail.endswith('"0241_film_scene_dialogue.sql"') and
                         tail.rindex('"0239_film_keyframe_refs_quote.sql"') < tail.rindex('"0241_film_scene_dialogue.sql"')), on_0124[-200:])

    def test_the_header_says_it_depends_on_0235_and_names_the_worker_side(self):
        for words in ("DEPENDS ON 0235 (0235_film_operator_preview.sql) AND 0236", "neither start_film nor film_take_job", "reserved_slots=len(film refs)",
                      "FilmOrchestrator._inputs counts the references", "WHAT IS NOT COVERED"):
            self.assertIn(words, NEW_TEXT)

    def test_the_docs_describe_it(self):
        docs = (ROOT / "docs" / "MIGRATIONS.md").read_text(encoding="utf-8")
        self.assertIn("## Film Studio: a key frame is quoted the way it is made (0239, provisional)", docs)
        self.assertIn("rollback_0239_film_keyframe_refs_quote.sql", docs)


if __name__ == "__main__":
    unittest.main()

"""supabase/migrations/0218_creative_prompt_limits.sql — the quote refuses a prompt longer than the model takes, a negative prompt its
adapter drops and a seed; an unknown parameter is refused without repeating its name; Film's quote prices the words its takes send.

SQL does not run in this suite (tests/security/test_sec_creative_prompt_limits.py and test_sec_breach_s9_prompt_limits.py do, against a
real Postgres). These pin what must not change by accident: each replaced body is the old body plus exactly the listed hunks (undo them
and the rest is the old text byte for byte), the count is the worker's own (prompt_units), the refusals are raised as every other one,
the drift guards, the end state, the rollback and the lab carry the hashes recomputed from the files, the grants, and the docs.
"""

import hashlib
import re
import unittest
from pathlib import Path

from modules import model_registry as reg

ROOT = Path(__file__).resolve().parent.parent
MIG = ROOT / "supabase" / "migrations"
NEW_TEXT = (MIG / "0218_creative_prompt_limits.sql").read_text(encoding="utf-8")
ROLLBACK_TEXT = (ROOT / "docs" / "sql" / "rollback_0218_creative_prompt_limits.sql").read_text(encoding="utf-8")
LAB = (ROOT / "tests" / "security" / "sec_db.py").read_text(encoding="utf-8")
CODE = "\n".join(line.split("--", 1)[0] for line in NEW_TEXT.splitlines())


def bodies(text):
    return {m.group(1): m.group(0) for m in re.finditer(r"(?m)^create or replace function public\.(\w+)\(.*?^\$\$;\n", text, re.S)}


def md5_of(fn):
    b = fn[fn.index("$$") + 2: fn.rindex("$$")]
    return hashlib.md5(re.sub(r"\s+", " ", b).encode()).hexdigest()


NEW = bodies(NEW_TEXT)
BASE = bodies((MIG / "0208_geo_gate_and_image_size_price.sql").read_text(encoding="utf-8"))
OLD = {"creative_params_problem": BASE["creative_params_problem"], "creative_price": BASE["creative_price"],
       "film_price": bodies((MIG / "0171_films_money.sql").read_text(encoding="utf-8"))["film_price"]}
BEFORE = {"creative_params_problem": "7ccde072309a637d9b07e59f1be45d20", "creative_price": "f61aaddd5686045961addd6f14a02c32",
          "film_price": "5de6c9bb2a74079e2078cad2d91b3c34"}
AFTER = {"creative_params_problem": "0f4b7b7ba92bb20432841a4a5d5f8917", "creative_price": "34ae574dc0261251139c48b6ca1e1983",
         "film_price": "3c22f87be736c073d17d93e040e914e1"}

#: (old text, new text): every change 0218 makes. Nothing else may differ from the old bodies.
PARAMS_HUNKS = [
    ("""  problem  text;
begin
""",
     """  problem  text;
  -- 0218: the keys this function knows, in one place, so that the unknown-key refusal can name them instead of the caller's.
  known    constant text[] := array['prompt', 'negative_prompt', 'aspect_ratio', 'resolution', 'duration_s',
                                    'voice_id', 'seed', 'source_asset_id', 'factor', 'style_kit_id', 'target_language',
                                    'target_resolution', 'end_asset_id', 'language', 'quality', 'audio', 'look',
                                    'regions', 'region_feather', 'image_size'];
begin
"""),
    ("""  for k in select jsonb_object_keys(p_params) loop
    if k not in ('prompt', 'negative_prompt', 'aspect_ratio', 'resolution', 'duration_s',
                 'voice_id', 'seed', 'source_asset_id', 'factor', 'style_kit_id', 'target_language',
                 'target_resolution', 'end_asset_id', 'language', 'quality', 'audio', 'look',
                 -- 0126
                 'regions', 'region_feather',
                 -- 0208
                 'image_size') then
      return format('unknown parameter %s', k);
    end if;
  end loop;
""",
     """  -- 0218: how many keys are unknown and which are known, never a key the caller sent. A key is up to 16 KB of anything (a newline,
  -- "SYSTEM: ..."), and this sentence reaches a connected assistant as the server's own words (api_creative_refusal's detail).
  if exists (select 1 from jsonb_object_keys(p_params) j(x) where j.x <> all (known)) then
    return format('unknown parameter (%s); allowed: %s',
                  (select count(*) from jsonb_object_keys(p_params) j(x) where j.x <> all (known)), array_to_string(known, ', '));
  end if;
"""),
]

PRICE_HUNKS = [
    ("""  vsize   text;
begin
""",
     """  vsize   text;
  -- 0218: a limit from the model's spec, and the prompt's length in the worker's units.
  lim     numeric;
  units   integer;
begin
"""),
    ("""  -- Nor an ending on a model that would drop it.
  if p_params ? 'end_asset_id' and coalesce(m_spec -> 'end_frame', 'false'::jsonb) <> 'true'::jsonb then
    perform public.creative_refuse('invalid_params',
      format('%s cannot end a clip on a chosen picture', mdl));
  end if;
""",
     """  -- Nor an ending on a model that would drop it.
  if p_params ? 'end_asset_id' and coalesce(m_spec -> 'end_frame', 'false'::jsonb) <> 'true'::jsonb then
    perform public.creative_refuse('invalid_params',
      format('%s cannot end a clip on a chosen picture', mdl));
  end if;
  -- 0218: nor a setting the model's adapter would drop, nor a prompt longer than the model takes. Before 0218 each was quoted, held and
  -- queued, and then either refused by the worker after the hold (the length) or sent without the setting while the person paid for
  -- it (CLAUDE.md #4). Refused here, before anything is held, on every path that prices through this function (the Studio, the API,
  -- MCP, the router, Film).
  -- A seed reaches no adapter (modules/capabilities/base.py CapabilityRequest has no seed): refused for every model until one does.
  if p_params ? 'seed' then
    perform public.creative_refuse('seed_not_supported', 'Seeds are not supported yet; remove seed', 'NS400');
  end if;
  -- A negative prompt only for a model whose adapter puts it in the vendor's request: the registry's takes_negative_prompt, which the
  -- sync copies into spec and modules/model_registry.py checks against the adapter. No statement = does not take one. Blank text is no
  -- negative prompt (the worker sends none).
  if btrim(coalesce(p_params ->> 'negative_prompt', '')) <> ''
     and coalesce(m_spec -> 'takes_negative_prompt', 'false'::jsonb) <> 'true'::jsonb then
    perform public.creative_refuse('negative_prompt_not_supported',
      format('%s does not take a negative prompt; remove it or choose a model that does', mdl), 'NS400');
  end if;
  -- The prompt against the model's own limits.max_prompt_chars, in UTF-16 code units, the worker's unit (model_registry.prompt_units):
  -- one per character, two for a character outside the Basic Multilingual Plane (an emoji). A spec that states no positive number is
  -- held to creative_params_problem's 4000 only (every registry entry states one; the Verify block lists any row that does not).
  lim := case when jsonb_typeof(m_spec -> 'limits' -> 'max_prompt_chars') = 'number'
              then (m_spec -> 'limits' ->> 'max_prompt_chars')::numeric end;
  if lim > 0 and jsonb_typeof(p_params -> 'prompt') = 'string' then
    units := 2 * char_length(p_params ->> 'prompt')
             - char_length(regexp_replace(p_params ->> 'prompt', '[\\U00010000-\\U0010FFFF]', '', 'g'));
    if units > lim then
      perform public.creative_refuse('prompt_too_long',
        format('%s characters over this model''s limit of %s; shorten the prompt', units - lim, lim), 'NS400');
    end if;
  end if;
  -- The negative prompt against limits.max_negative_prompt_chars where the adapter has one of its own (Krea: 1024), in characters
  -- (code points), the way that adapter counts it.
  lim := case when jsonb_typeof(m_spec -> 'limits' -> 'max_negative_prompt_chars') = 'number'
              then (m_spec -> 'limits' ->> 'max_negative_prompt_chars')::numeric end;
  if lim > 0 and char_length(p_params ->> 'negative_prompt') > lim then
    perform public.creative_refuse('prompt_too_long',
      format('%s characters over this model''s limit of %s for a negative prompt; shorten it',
             char_length(p_params ->> 'negative_prompt') - lim, lim), 'NS400');
  end if;
"""),
]

FILM_HUNKS = [
    ("""        params := jsonb_build_object('prompt', sc.visual_prompt, 'aspect_ratio', f.aspect)
                  || case when f.style_kit_id is null then '{}'::jsonb else jsonb_build_object('style_kit_id', f.style_kit_id) end
""",
     """        params := jsonb_build_object('prompt', sc.visual_prompt, 'aspect_ratio', f.aspect)
                  || case when f.style_kit_id is null then '{}'::jsonb else jsonb_build_object('style_kit_id', f.style_kit_id) end
                  -- 0218: the negative prompt the take carries (0198), so the quote asks whether this model takes one.
                  || case when btrim(sc.negative_prompt) <> '' then jsonb_build_object('negative_prompt', sc.negative_prompt)
                          else '{}'::jsonb end
"""),
    ("""'params', (params - 'prompt' - 'source_asset_id')""",
     """'params', (params - 'prompt' - 'negative_prompt' - 'source_asset_id')"""),
    ("""                  || case when i = sc.shot_count and sc.last_frame <> 'none' then jsonb_build_object('end_asset_id', stand)
                          else '{}'::jsonb end;
""",
     """                  || case when i = sc.shot_count and sc.last_frame <> 'none' then jsonb_build_object('end_asset_id', stand)
                          else '{}'::jsonb end
                  -- 0218: the words the take sends (0198: the scene's visual prompt, and its negative prompt when it has one), so the
                  -- clip model's own prompt limit and whether it takes a negative prompt are asked here, not by the worker after the hold.
                  || case when btrim(sc.visual_prompt) <> '' then jsonb_build_object('prompt', sc.visual_prompt) else '{}'::jsonb end
                  || case when btrim(sc.negative_prompt) <> '' then jsonb_build_object('negative_prompt', sc.negative_prompt)
                          else '{}'::jsonb end;
"""),
    ("""'params', (params - 'source_asset_id' - 'end_asset_id')""",
     """'params', (params - 'source_asset_id' - 'end_asset_id' - 'prompt' - 'negative_prompt')"""),
]

HUNKS = {"creative_params_problem": PARAMS_HUNKS, "creative_price": PRICE_HUNKS, "film_price": FILM_HUNKS}
LATER = sorted(p.name for p in MIG.glob("*.sql") if p.name[:4] > "0218")


class CreativePromptLimitsMigration(unittest.TestCase):
    def test_it_replaces_the_three_functions_only_and_writes_nothing(self):
        self.assertEqual(set(NEW), set(HUNKS))
        low = CODE.lower()
        for word in ("drop table", "drop column", "drop function", "delete from", "truncate", "alter table", "create policy",
                     "create table", "grant "):
            self.assertNotIn(word, low)
        self.assertNotRegex(low, r"\b(insert\s+into|update\s+public\.|upsert)")

    def test_each_body_is_the_old_one_plus_exactly_the_listed_hunks(self):
        for name, hunks in HUNKS.items():
            old, new = OLD[name], NEW[name]
            self.assertEqual(md5_of(old), BEFORE[name], name)
            self.assertEqual(md5_of(new), AFTER[name], name)
            undone = new
            for a, b in hunks:
                self.assertEqual(old.count(a), 1, (name, a[:60]))
                self.assertEqual(new.count(b), 1, (name, b[:60]))
                undone = undone.replace(b, a)
            self.assertEqual(undone, old, f"{name} differs from its old body beyond the listed hunks")

    def test_no_later_migration_replaces_them(self):
        for f in LATER:
            text = (MIG / f).read_text(encoding="utf-8")
            for name in HUNKS:
                self.assertNotIn(f"function public.{name}(", text, (f, name))

    def test_0208s_size_rule_is_kept_exactly(self):
        # the size hunks of 0208 survive unchanged: every line of 0208's body that names image_size / vsize is still there
        for line in OLD["creative_price"].splitlines():
            if "vsize" in line or "image_size" in line:
                self.assertIn(line, NEW["creative_price"])

    def test_the_refusals_are_raised_as_every_other_one_and_before_any_rate(self):
        cp = NEW["creative_price"]
        for word in ("seed_not_supported", "negative_prompt_not_supported", "prompt_too_long"):
            for m in re.finditer(rf"creative_refuse\('{word}',", cp):
                call = cp[m.start():cp.index("end if;", m.start())]
                self.assertTrue(call.rstrip().endswith("'NS400');"), call)
            at = cp.index(f"'{word}'")
            self.assertLess(cp.index("into m_found, m_unit, m_ent, m_spec, m_avail"), at)
            for later in ("select * into rate from public.credit_prices where unit = m_unit;", "vusd := case",
                          "qty := public.creative_quantity(cap, p_params);"):
                self.assertLess(at, cp.index(later), (word, later))
        # film_try_price catches exactly NS400 and keeps a lowercase word as the line's reason
        film = (MIG / "0171_films_money.sql").read_text(encoding="utf-8")
        self.assertIn("exception when sqlstate 'NS400' then", bodies(film)["film_try_price"])
        self.assertIn("w ~ '^[a-z0-9_]{1,64}$'", bodies(film)["film_try_price"])

    def test_the_count_is_the_workers_utf16_units(self):
        # 2 * code points - code points not above U+FFFF == code points + astral characters == prompt_units
        self.assertIn("units := 2 * char_length(p_params ->> 'prompt')\n"
                      "             - char_length(regexp_replace(p_params ->> 'prompt', '[\\U00010000-\\U0010FFFF]', '', 'g'));",
                      NEW["creative_price"])
        for s in ("a" * 300, "\U0001F600" * 150, "é\U0001F600x￿"):
            astral = sum(1 for ch in s if ord(ch) > 0xFFFF)
            self.assertEqual(2 * len(s) - (len(s) - astral), reg.prompt_units(s))

    def test_the_unknown_key_refusal_never_formats_the_key(self):
        pp = NEW["creative_params_problem"]
        self.assertNotIn("unknown parameter %s", pp)
        self.assertIn("format('unknown parameter (%s); allowed: %s',", pp)
        # the allow-list it names is the TypeScript one plus 0126's region keys
        ts = (ROOT / "command-center" / "lib" / "creative" / "operations.ts").read_text(encoding="utf-8")
        keys = re.findall(r'^\s+"(\w+)",$', ts[ts.index("export const PARAM_KEYS = ["):ts.index("] as const;", ts.index("PARAM_KEYS"))], re.M)
        known = re.findall(r"'(\w+)'", pp[pp.index("known    constant text[] := array["):pp.index("];", pp.index("known    constant"))])
        self.assertEqual(sorted(known), sorted(keys + ["regions", "region_feather"]))
        self.assertLessEqual(len("unknown parameter (99); allowed: " + ", ".join(known)), 300, "api_creative_refusal keeps 300")

    def test_film_prices_the_words_and_keeps_them_out_of_the_lines_params(self):
        fp = NEW["film_price"]
        self.assertIn("'params', (params - 'prompt' - 'negative_prompt' - 'source_asset_id')", fp)
        self.assertIn("'params', (params - 'source_asset_id' - 'end_asset_id' - 'prompt' - 'negative_prompt')", fp)
        # the same words 0198's take puts in the job
        take = (MIG / "0198_film_studio_org_switch.sql").read_text(encoding="utf-8")
        self.assertIn("case when btrim(sc.negative_prompt) <> '' then jsonb_build_object('negative_prompt', sc.negative_prompt)", take)
        self.assertEqual(fp.count("case when btrim(sc.negative_prompt) <> '' then jsonb_build_object('negative_prompt', sc.negative_prompt)"), 2)

    def test_grants_the_guards_the_end_state_and_the_rollback_carry_the_hashes(self):
        for sig in ("creative_params_problem(text, jsonb)", "creative_price(uuid, text, text, jsonb)", "film_price(public.films)"):
            line = f"revoke all on function public.{sig} from public, anon, authenticated, service_role;"
            self.assertIn(line, CODE)
            self.assertIn(line, ROLLBACK_TEXT)
        for name in HUNKS:
            self.assertIn(f"array['{BEFORE[name]}', '{AFTER[name]}']", NEW_TEXT, name)
            self.assertIn(f"array['{AFTER[name]}', '{BEFORE[name]}']", ROLLBACK_TEXT, name)
            self.assertGreaterEqual(NEW_TEXT.count(AFTER[name]), 4, name)  # header, guard, end state, verify
        first = NEW_TEXT.index("create or replace function")
        self.assertLess(NEW_TEXT.index("0218 needs 0208_geo_gate_and_image_size_price.sql"), first)
        self.assertLess(NEW_TEXT.index("to_regprocedure('public.creative_jobs_geo_gate()') is null"), first)
        self.assertLess(NEW_TEXT.index("0218 found a creative_price()"), first)
        self.assertLess(NEW_TEXT.rindex("create or replace function"), NEW_TEXT.index("The end state, asserted inside the transaction"))
        for needle in ("set local lock_timeout = '5s';", "APPLY AS ONE TRANSACTION", "WHAT TO VERIFY BEFORE YOU APPLY", "-- Verify",
                       "LIVE ON APPLY", "notify pgrst, 'reload schema';", "FILM BEHAVIOUR CHANGE", "NOT CHANGED", "REPLACES"):
            self.assertIn(needle, NEW_TEXT)

    def test_the_rollback_restores_the_three_old_bodies_byte_for_byte(self):
        rb = bodies(ROLLBACK_TEXT)
        self.assertEqual(rb, OLD)
        self.assertNotIn("drop function", ROLLBACK_TEXT.lower())
        self.assertEqual(len(re.findall(r"(?m)^begin;$", ROLLBACK_TEXT)), 1)
        self.assertEqual(len(re.findall(r"(?m)^commit;$", ROLLBACK_TEXT)), 1)

    def test_the_number_is_unique_and_the_lab_knows_the_chain(self):
        self.assertEqual(sorted(p.name[:4] for p in MIG.glob("*.sql")).count("0218"), 1)
        for name, h in (("CREATIVE_PARAMS_PROBLEM_0218", AFTER["creative_params_problem"]), ("CREATIVE_PRICE_0218", AFTER["creative_price"]),
                        ("FILM_PRICE_0218", AFTER["film_price"])):
            self.assertIn(f'{name} = "{h}"', LAB)
        self.assertIn("ON_0156 = (*ON_0156, MIGRATION_0218.name)", LAB)
        off = LAB[LAB.index("def take_off_0208("):LAB.index("def put_back_0208(")]
        self.assertLess(off.index("take_off_0218(conn)"), off.index("rollback_0208_body()"))
        self.assertIn("return rollback_0218_if_on() +", LAB[LAB.index("def rollback_0208_body("):LAB.index("def take_off_0208(")])
        self.assertIn("put_back_0218(conn)", LAB[LAB.index("def put_back_0208("):LAB.index("def rollback_0159_body(")])
        self.assertIn("ON_0139 = (*(f for f in ON_0139 if f != MIGRATION_0218.name), MIGRATION_0218.name)", LAB)
        self.assertIn('"0218_creative_prompt_limits.sql")', LAB[LAB.index("ON_0124 = ("):])
        off = LAB[LAB.index("def take_off_0171("):LAB.index("def put_back_0171(")]
        self.assertLess(off.index("take_off_0218(conn)"), off.index("rollback_0171_body("))
        self.assertIn("put_back_0218(", LAB[LAB.index("def put_back_0171("):LAB.index("MIGRATION_0174 =")])

    def test_the_docs_describe_it(self):
        docs = (ROOT / "docs" / "MIGRATIONS.md").read_text(encoding="utf-8")
        self.assertIn("## A quote refuses a prompt longer than the model takes, and settings its adapter would drop (0218)", docs)
        self.assertIn("rollback_0218_creative_prompt_limits.sql", docs)


class TheRegistrySide(unittest.TestCase):
    """0218 reads spec.limits.max_prompt_chars, spec.limits.max_negative_prompt_chars and spec.takes_negative_prompt as the sync copies them."""

    def test_every_synced_row_states_a_positive_prompt_limit(self):
        r = reg.load()
        for row in reg.sync_rows(list(r.values())):
            lim = row["spec"]["limits"]["max_prompt_chars"]
            self.assertIsInstance(lim, int, row["id"])
            self.assertEqual(lim, r[row["id"]].max_prompt_chars)
            self.assertGreater(lim, 0)

    def test_the_worker_refuses_exactly_past_the_same_number(self):
        from modules.capabilities.base import CapabilityRequest

        e = reg.load()["ideogram-3"]
        too_long = f"prompt is longer than {e.max_prompt_chars} characters"
        self.assertNotIn(too_long, e.problems(CapabilityRequest(capability="t2i", prompt="a" * e.max_prompt_chars)))
        self.assertIn(too_long, e.problems(CapabilityRequest(capability="t2i", prompt="a" * (e.max_prompt_chars + 1))))
        self.assertIn(too_long, e.problems(CapabilityRequest(capability="t2i", prompt="\U0001F600" * (e.max_prompt_chars // 2 + 1))))

    def test_the_negative_prompt_limit_is_the_adapters_own(self):
        from modules.capabilities.krea import KreaImageAdapter

        r = reg.load()
        for mid in ("krea-3", "krea-3-regional"):
            self.assertEqual(r[mid].max_negative_prompt_chars, KreaImageAdapter.MAX_NEGATIVE_CHARS)
        self.assertEqual({m.id for m in r.values() if m.max_negative_prompt_chars is not None}, {"krea-3", "krea-3-regional"})


if __name__ == "__main__":
    unittest.main()

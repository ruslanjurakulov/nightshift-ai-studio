"""supabase/migrations/0171_voice_video.sql — "voice to video" sold as a creative job (our own engine, no vendor).

SQL does not run in this suite (tests/security/test_sec_voice_video.py does that, against a real Postgres). These pin what
must not change by accident:

* every function 0171 replaces is the latest earlier body plus exactly the hunks listed here: undo them and the rest is the
  earlier text byte for byte (so applying 0171 keeps every rule the earlier migrations wrote);
* the drift guards accept only those earlier bodies or 0171's own, and the end state, the rollback and the lab carry the
  hashes recomputed from the files;
* the rollback puts every earlier body back byte for byte and refuses to run over anything else;
* the closed lists the hunks extend are the same everywhere (SQL, Python, TypeScript, the engine).
"""

import hashlib
import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MIG = ROOT / "supabase" / "migrations"
NEW_PATH = MIG / "0171_voice_video.sql"
ROLLBACK_PATH = ROOT / "docs" / "sql" / "rollback_0171_voice_video.sql"

#: Where each replaced function's previous body lives: the newest earlier migration that defines it.
PREVIOUS = {
    "model_registry_guard": "0100_video_ai_ops.sql",
    "sellable_models": "0125_model_shutdown.sql",
    "creative_capability_supported": "0100_video_ai_ops.sql",
    "creative_params_problem": "0156_named_resolution_params.sql",
    "creative_source_problem": "0100_video_ai_ops.sql",
    "creative_price": "0159_duration_offered_by_model.sql",
    "api_creative_models": "0162_api_creative_models.sql",
}

LOOKS = ("dusk", "midnight", "golden", "neon", "paper")
LOOK_LIST = "'dusk', 'midnight', 'golden', 'neon', 'paper'"

_AUDIO_SOURCE = """  if p_capability = 'voice_explainer' then
    -- 0171: the person's own narration. An AUDIO file of THIS organization, live, a type the engine reads, of a measured
    -- length of at most ten minutes (one render holds the whole video; the model's own, possibly shorter, limit is
    -- creative_price's), small enough to copy to the worker. Another organization's file reads exactly like a missing one.
    select * into a from public.media_assets
     where id = (p_params ->> 'source_asset_id')::uuid
       and org_id = p_org
       and deleted_at is null and purged_at is null;
    if not found then
      return 'source_asset_id names no recording in this organization''s library';
    end if;
    if a.kind <> 'audio' then
      return 'a voice video starts from an audio recording: pick an audio file (MP3, M4A, WAV, OGG, FLAC, AAC or WebM)';
    end if;
    if a.mime not in ('audio/mpeg', 'audio/mp4', 'audio/wav', 'audio/ogg', 'audio/flac', 'audio/aac', 'audio/webm') then
      return 'this audio type cannot be used here; use MP3, M4A, WAV, OGG, FLAC, AAC or WebM';
    end if;
    if a.duration_s is null or a.duration_s <= 0 then
      return 'the length of this recording is not known, so it cannot be priced; upload it again';
    end if;
    if a.duration_s > 600 then
      return 'a voice video takes recordings of up to 10 minutes; trim this one first';
    end if;
    if a.bytes > 209715200 then
      return 'this recording is larger than 200 MB; use a smaller copy';
    end if;
    return null;
  end if;

"""

#: (old, new) per function: ``old`` occurs once in the previous body, ``new`` once in 0171's, and nothing else differs.
HUNKS = {
    "model_registry_guard": [(
        "      or new.spec -> 'aspect_ratios_by_capability' -> 'video_reframe' is distinct from old.spec -> "
        "'aspect_ratios_by_capability' -> 'video_reframe') then\n",
        "      or new.spec -> 'aspect_ratios_by_capability' -> 'video_reframe' is distinct from old.spec -> "
        "'aspect_ratios_by_capability' -> 'video_reframe'\n"
        "      -- 0171: the looks a model draws a voice video in.\n"
        "      or new.spec -> 'explainer_looks' is distinct from old.spec -> 'explainer_looks') then\n",
    )],
    "sellable_models": [
        ("                              'expand', 'relight', 'erase', 'video_edit', 'video_reframe', 'video_remove_bg') then\n",
         "                              'expand', 'relight', 'erase', 'video_edit', 'video_reframe', 'video_remove_bg',\n"
         "                              'voice_explainer') then\n"),
        ("             'relight_looks', m.spec -> 'relight_looks',\n",
         "             'relight_looks', m.spec -> 'relight_looks',\n"
         "             -- 0171: the looks a voice video is drawn in, so the Studio offers only those.\n"
         "             'explainer_looks', m.spec -> 'explainer_looks',\n"),
    ],
    "creative_capability_supported": [(
        "                          'video_edit', 'video_reframe', 'video_remove_bg')\n",
        "                          'video_edit', 'video_reframe', 'video_remove_bg',\n"
        "                          'voice_explainer')\n",
    )],
    "creative_params_problem": [
        ("  told     boolean := p_capability = 'describe';\n",
         "  told     boolean := p_capability = 'describe';\n"
         "  -- 0171: a voice video. The person's own narration is the whole input and the look the only choice.\n"
         "  narrated boolean := p_capability = 'voice_explainer';\n"),
        ("                                       'video_edit', 'video_reframe', 'video_remove_bg');\n"
         "  -- The output keeps the source's shape",
         "                                       'video_edit', 'video_reframe', 'video_remove_bg',\n"
         "                                       'voice_explainer');\n"
         "  -- The output keeps the source's shape"),
        ("                                           'video_reframe', 'video_remove_bg');\n",
         "                                           'video_reframe', 'video_remove_bg', 'voice_explainer');\n"),
        ("  if (p_capability = 'remove_bg' or voiced or filmed or told or unworded) and p_params ? 'prompt' then\n",
         "  if (p_capability = 'remove_bg' or voiced or filmed or told or unworded or narrated) and p_params ? 'prompt' then\n"),
        ("    if reshaped or grown or reframed or voiced or told then\n      return format('negative_prompt",
         "    if reshaped or grown or reframed or voiced or told or narrated then\n      return format('negative_prompt"),
        ("    if voiced or told then\n      return format('aspect_ratio does not apply to %s', p_capability);",
         "    if voiced or told or narrated then\n      return format('aspect_ratio does not apply to %s', p_capability);"),
        ("    if reshaped or grown or reframed or voiced or told then\n      return format('resolution",
         "    if reshaped or grown or reframed or voiced or told or narrated then\n      return format('resolution"),
        ("    if reshaped or grown or reframed or voiced or told then\n      return format('seed",
         "    if reshaped or grown or reframed or voiced or told or narrated then\n      return format('seed"),
        ("       or (p_params ->> 'source_asset_id') !~ uuid_re then\n      if voiced then\n",
         "       or (p_params ->> 'source_asset_id') !~ uuid_re then\n"
         "      if narrated then\n"
         "        return 'source_asset_id (the id of an audio recording in the media library) is required for voice_explainer';\n"
         "      end if;\n"
         "      if voiced then\n"),
        ("  if p_params ? 'look' then\n    -- relight (0099)",
         "  if narrated then\n"
         "    -- 0171: a voice video is drawn in one look of the closed list: required, and never filled in here. The Studio\n"
         "    -- sends the chip the person sees pressed. The model must list it too (creative_price).\n"
         "    if jsonb_typeof(p_params -> 'look') is distinct from 'string'\n"
         f"       or (p_params ->> 'look') not in ({LOOK_LIST}) then\n"
         "      return 'look (one of dusk, midnight, golden, neon, paper) is required for voice_explainer';\n"
         "    end if;\n"
         "  elsif p_params ? 'look' then\n    -- relight (0099)"),
    ],
    "creative_source_problem": [(
        "  if p_capability in ('voice_change', 'dub', 'captions') then\n    -- 0050's recording check, unchanged.\n",
        _AUDIO_SOURCE + "  if p_capability in ('voice_change', 'dub', 'captions') then\n    -- 0050's recording check, unchanged.\n",
    )],
    "creative_price": [
        ("      format('%s does not reframe a video to %s', mdl, p_params ->> 'aspect_ratio'));\n  end if;\n",
         "      format('%s does not reframe a video to %s', mdl, p_params ->> 'aspect_ratio'));\n  end if;\n"
         "  -- 0171: nor a look of a voice video that the model was not proven (and listed) for.\n"
         "  if cap = 'voice_explainer'\n"
         "     and not coalesce(jsonb_typeof(m_spec -> 'explainer_looks') = 'array'\n"
         "                      and (m_spec -> 'explainer_looks') @> jsonb_build_array(p_params ->> 'look'), false) then\n"
         "    perform public.creative_refuse('invalid_params',\n"
         "      format('%s does not draw the %s look', mdl, p_params ->> 'look'));\n"
         "  end if;\n"),
        ("  if cap in ('voice_change', 'dub', 'video_upscale', 'captions', 'video_edit', 'video_reframe', 'video_remove_bg') then\n",
         "  if cap in ('voice_change', 'dub', 'video_upscale', 'captions', 'video_edit', 'video_reframe', 'video_remove_bg',\n"
         "             'voice_explainer') then\n"),
        ("        format('this model takes videos of up to %s seconds; trim this one first', longest));\n    end if;\n  end if;\n",
         "        format('this model takes videos of up to %s seconds; trim this one first', longest));\n    end if;\n  end if;\n"
         "  if cap = 'voice_explainer' then\n"
         "    -- 0171: the model's own longest recording (limits.max_source_seconds), the video ops' rule: a model that states\n"
         "    -- none is not sold a length its render may refuse after the hold.\n"
         "    longest := case when jsonb_typeof(m_spec -> 'limits' -> 'max_source_seconds') = 'number'\n"
         "                    then (m_spec -> 'limits' ->> 'max_source_seconds')::numeric end;\n"
         "    if longest is null or longest <= 0 then\n"
         "      perform public.creative_refuse('model_not_sellable',\n"
         "        format('%s does not state the longest recording it takes', mdl));\n"
         "    end if;\n"
         "    if qty > longest then\n"
         "      perform public.creative_refuse('source_unavailable',\n"
         "        format('this model makes videos from recordings of up to %s seconds; trim this one first', longest));\n"
         "    end if;\n"
         "  end if;\n"),
    ],
    "api_creative_models": [(
        "                                     'video_remove_bg']::text[];\n",
        "                                     'video_remove_bg', 'voice_explainer']::text[];\n",
    )],
}


def bodies(text):
    return {m.group(1): m.group(0) for m in re.finditer(r"(?m)^create or replace function public\.(\w+)\(.*?^\$\$;\n", text, re.S)}


def body(fn):
    return fn[fn.index("$$") + 2: fn.rindex("$$")]


def md5_of(fn):
    return hashlib.md5(re.sub(r"\s+", " ", body(fn)).encode()).hexdigest()


def previous(name):
    return bodies((MIG / PREVIOUS[name]).read_text(encoding="utf-8"))[name]


def apply_hunks(name, text):
    for old, new in HUNKS[name]:
        assert text.count(old) == 1, (name, old)
        text = text.replace(old, new)
    return text


def code_of(text):
    return "\n".join(line.split("--", 1)[0] for line in text.splitlines())


if NEW_PATH.exists():
    NEW_TEXT = NEW_PATH.read_text(encoding="utf-8")
    NEW = bodies(NEW_TEXT)
    CODE = code_of(NEW_TEXT)
    ROLLBACK_TEXT = ROLLBACK_PATH.read_text(encoding="utf-8")
    LAB = (ROOT / "tests" / "security" / "sec_db.py").read_text(encoding="utf-8")


class BuiltOnTheLatestBodies(unittest.TestCase):
    def test_each_previous_body_is_the_newest_earlier_one(self):
        # A migration numbered below 0171 that replaces one of these after the file it names would make 0171 undo it.
        for name, src in PREVIOUS.items():
            newest = None
            for path in sorted(MIG.glob("*.sql")):
                if path.name < "0171" and name in bodies(path.read_text(encoding="utf-8")):
                    newest = path.name
            self.assertEqual(newest, src, name)

    def test_it_replaces_exactly_these_functions(self):
        self.assertEqual(set(NEW), set(PREVIOUS))

    def test_every_body_is_the_previous_one_plus_exactly_the_listed_hunks(self):
        for name in PREVIOUS:
            new, old = NEW[name], previous(name)
            for o, n in HUNKS[name]:
                self.assertEqual(old.count(o), 1, (name, o))
                self.assertEqual(new.count(n), 1, (name, n))
            undone = new
            for o, n in HUNKS[name]:
                undone = undone.replace(n, o)
            self.assertEqual(undone, old, f"{name} differs from {PREVIOUS[name]} beyond the listed hunks")
            self.assertEqual(apply_hunks(name, old), new, name)

    def test_the_guards_every_earlier_body_keeps_are_still_there(self):
        price = NEW["creative_price"]
        for guard in ("model_is_available(mdl)", "not public.model_past_shutdown(r.spec)", "creative_operator_preview(p_org",
                      "does not offer the %s shape for %s", "is not sold at %s yet", "does not offer a %s-second clip for %s"):
            self.assertIn(guard, price)
        self.assertIn("public.model_is_available(m.id)", NEW["sellable_models"])
        self.assertIn("not public.model_past_shutdown(m.spec)", NEW["sellable_models"])
        self.assertIn("if p_capability = 'captions' and p_surface <> 'web' then\n    return;", NEW["sellable_models"])
        self.assertIn("'regions', 'region_feather') then", NEW["creative_params_problem"])
        self.assertIn("^([0-9]{3,4}p|[24]k)$", NEW["creative_params_problem"])


class TheRules(unittest.TestCase):
    def test_the_price_is_the_recordings_seconds_from_the_database(self):
        price = NEW["creative_price"]
        self.assertRegex(price, r"'video_remove_bg',\s+'voice_explainer'\) then\s+-- The file's measured length[^\n]*\n\s+qty := "
                                r"public\.creative_source_seconds\(p_org, p_params\)")
        # The look and the model's longest input are checked before the rate is read and before anything is held.
        look = price.index("does not draw the %s look")
        self.assertLess(price.index("into m_found, m_unit, m_ent, m_spec, m_avail"), look)
        self.assertLess(look, price.index("select * into rate from public.credit_prices where unit = m_unit;"))
        self.assertIn("%s does not state the longest recording it takes", price)

    def test_the_params_take_a_recording_and_a_look_and_nothing_else(self):
        p = NEW["creative_params_problem"]
        self.assertIn("'look (one of dusk, midnight, golden, neon, paper) is required for voice_explainer'", p)
        self.assertIn("source_asset_id (the id of an audio recording in the media library) is required for voice_explainer", p)
        self.assertEqual(p.count("or told or narrated then"), 4)  # negative_prompt, aspect_ratio, resolution, seed
        # The voice video takes no new key: look and source_asset_id were already accepted (0099, 0046).
        self.assertIn("'target_resolution', 'end_asset_id', 'language', 'quality', 'audio', 'look',", p)

    def test_the_source_is_audio_of_this_organization_at_most_ten_minutes(self):
        s = NEW["creative_source_problem"]
        block = s[s.index("if p_capability = 'voice_explainer' then"):s.index("if p_capability in ('voice_change', 'dub', 'captions') then")]
        for needle in ("and org_id = p_org", "deleted_at is null and purged_at is null", "a.kind <> 'audio'",
                       "a.duration_s > 600", "a.bytes > 209715200", "a.duration_s is null or a.duration_s <= 0"):
            self.assertIn(needle, block)
        self.assertNotIn("'video/", block)

    def test_the_closed_look_list_is_the_same_everywhere(self):
        from modules import voice_explainer as ve
        from modules.capabilities.base import EXPLAINER_LOOKS

        self.assertEqual(ve.LOOKS, LOOKS)
        self.assertEqual(EXPLAINER_LOOKS, LOOKS)
        # The engine's own list (the LookId union; tests/test_voice_explainer.py pins it to ve.LOOKS) in the same order.
        types = (ROOT / "video-engine" / "src" / "explainer" / "types.ts").read_text(encoding="utf-8")
        union = re.search(r"export type LookId\s*=([^;]*);", types).group(1)
        self.assertEqual(tuple(re.findall(r'"([a-z]+)"', union)), LOOKS)
        ops = (ROOT / "command-center" / "lib" / "creative" / "operations.ts").read_text(encoding="utf-8")
        ts = re.search(r"EXPLAINER_LOOKS = \[([^\]]*)\]", ops).group(1)
        self.assertEqual(tuple(re.findall(r'"([a-z]+)"', ts)), LOOKS)
        self.assertIn(f"not in ({LOOK_LIST})", NEW["creative_params_problem"])

    def test_the_capability_is_in_every_closed_list(self):
        for needle in ("'video_edit','video_reframe','video_remove_bg',\n                                   'voice_explainer']::text[]",
                       "'video_edit', 'video_reframe', 'video_remove_bg',\n                        'voice_explainer'));",
                       "between 1 and 20"):
            self.assertIn(needle, CODE)
        ts = (ROOT / "command-center" / "lib" / "api" / "operations.ts").read_text(encoding="utf-8")
        api = re.search(r"API_CREATIVE_CAPABILITIES\s*=\s*\[([^\]]*)\]", ts).group(1)
        sql = re.search(r"s\.capabilities && array\[([^\]]*)\]::text\[\]", NEW["api_creative_models"]).group(1)
        self.assertEqual(sorted(re.findall(r'"([a-z_0-9]+)"', api)), sorted(re.findall(r"'([a-z_0-9]+)'", sql)))
        self.assertIn("voice_explainer", re.findall(r'"([a-z_0-9]+)"', api))

    def test_the_guard_reopens_the_proof_when_the_looks_change(self):
        g = NEW["model_registry_guard"]
        self.assertIn("new.spec -> 'explainer_looks' is distinct from old.spec -> 'explainer_looks'", g)
        self.assertIn("'explainer_looks', m.spec -> 'explainer_looks'", NEW["sellable_models"])


class AppliedSafely(unittest.TestCase):
    def test_the_drift_guards_name_the_previous_and_own_hashes(self):
        first = NEW_TEXT.index("create or replace function")
        for name in PREVIOUS:
            old_md5, new_md5 = md5_of(previous(name)), md5_of(NEW[name])
            # accepted before any body is replaced: the previous body or this file's (a replay)
            self.assertIn(f"'{old_md5}', '{new_md5}'", NEW_TEXT[:first], name)
            # the end state insists on this file's
            self.assertGreaterEqual(NEW_TEXT.count(new_md5), 2, name)
            self.assertIn(f"'{new_md5}', '{old_md5}'", ROLLBACK_TEXT, name)
        self.assertIn("set local lock_timeout = '5s';", NEW_TEXT)
        for needle in ("APPLY AS ONE TRANSACTION", "WHAT TO VERIFY BEFORE YOU APPLY", "-- Verify", "LIVE ON APPLY",
                       "The end state, asserted inside the transaction"):
            self.assertIn(needle, NEW_TEXT)
        self.assertLess(NEW_TEXT.rindex("create or replace function"), NEW_TEXT.index("The end state, asserted inside the transaction"))

    def test_the_constraints_are_guarded_too(self):
        first = NEW_TEXT.index("alter table")
        self.assertIn("pg_get_constraintdef", NEW_TEXT[:first])
        self.assertIn("model_registry_capabilities_check", NEW_TEXT[:first])
        self.assertIn("model_probe_runs_capability_check", NEW_TEXT[:first])

    def test_additive_and_scoped(self):
        low = CODE.lower()
        for word in ("drop table", "drop column", "drop function", "delete from", "truncate", "create policy", "create table"):
            self.assertNotIn(word, low)
        self.assertNotRegex(low, r"\b(insert\s+into|update\s+public\.|upsert)")
        # Nothing goes on sale by applying the file: no model, no price, no availability.
        self.assertNotIn("credit_prices (", low)
        for name, b in NEW.items():
            if "security definer" in b:
                self.assertIn("set search_path = public, pg_temp", b, name)

    def test_grants(self):
        for sig in ("public.creative_capability_supported(text)", "public.creative_params_problem(text, jsonb)",
                    "public.creative_source_problem(uuid, text, jsonb)", "public.creative_price(uuid, text, text, jsonb)"):
            self.assertIn(f"revoke all on function {sig} from public, anon, authenticated, service_role;", CODE)
            self.assertNotIn(f"grant execute on function {sig}", CODE)
        self.assertIn("revoke all on function public.sellable_models(text, text) from public, anon;\n"
                      "grant execute on function public.sellable_models(text, text) to authenticated, service_role;", CODE)
        self.assertIn("revoke all on function public.model_registry_guard() from public, anon, authenticated;", CODE)
        self.assertIn("revoke all on function public.api_creative_models(text, text, text) from public, anon, authenticated, service_role;\n"
                      "grant execute on function public.api_creative_models(text, text, text) to anon;", CODE)

    def test_the_rollback_restores_every_previous_body_byte_for_byte(self):
        rb = bodies(ROLLBACK_TEXT)
        self.assertEqual(set(rb), set(PREVIOUS))
        for name in PREVIOUS:
            self.assertEqual(rb[name], previous(name), name)
        self.assertIn("rollback 0171 found", ROLLBACK_TEXT)
        self.assertNotIn("drop function", ROLLBACK_TEXT.lower())
        self.assertEqual(len(re.findall(r"(?m)^begin;$", ROLLBACK_TEXT)), 1)
        self.assertEqual(len(re.findall(r"(?m)^commit;$", ROLLBACK_TEXT)), 1)
        # A row that lists the capability would break the narrowed CHECK: the rollback refuses while one exists.
        self.assertIn("'voice_explainer' = any (capabilities)", ROLLBACK_TEXT)

    def test_the_number_is_unique_and_the_lab_knows_the_chain(self):
        numbers = [p.name[:4] for p in MIG.glob("*.sql")]
        self.assertEqual(numbers.count("0171"), 1)
        for needle in ("def take_off_0171(", "def put_back_0171(", "def has_0171(", "MIGRATION_0171 =", "ROLLBACK_0171 ="):
            self.assertIn(needle, LAB)
        # 0159's rollback refuses 0171's creative_price, 0162's replay refuses 0171's api_creative_models: 0171 comes off first.
        off = LAB[LAB.index("def take_off_0159("):LAB.index("def put_back_0159(")]
        self.assertIn("take_off_0171(session)", off)
        on = LAB[LAB.index("def put_back_0159("):LAB.index("MIGRATION_0167 =")]
        self.assertIn("put_back_0171(session)", on)

    def test_the_docs_describe_it(self):
        docs = (ROOT / "docs" / "MIGRATIONS.md").read_text(encoding="utf-8")
        self.assertIn("(0171)", docs)
        self.assertIn("rollback_0171_voice_video.sql", docs)
        explainer = (ROOT / "docs" / "VOICE_EXPLAINER.md").read_text(encoding="utf-8")
        self.assertIn("0171", explainer)
        self.assertNotIn("render_jobs` kind", explainer)


if __name__ == "__main__":
    unittest.main()

"""supabase/migrations/0208_geo_gate_and_image_size_price.sql — the database's own country gate, and the price by picture size.

SQL runs in tests/security/test_sec_geo_gate_0208.py (a real Postgres). These pin what must not drift by accident: the two replaced
functions are 0156's / 0159's bodies plus exactly the listed hunks (undo them and the rest is the earlier text byte for byte); the
hashes in the drift guard, the end state, the rollback and the lab are the ones recomputed from the files; the rollback puts the
earlier bodies back verbatim; the claim the web signs (lib/server/geo-claim.ts) is the shape, header, key name and lifetime the SQL
reads; no key is written in a file; and the picture sizes the SQL accepts are the registry schema's and the web's.
"""

import hashlib
import json
import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MIG = ROOT / "supabase" / "migrations"
NEW_TEXT = (MIG / "0208_geo_gate_and_image_size_price.sql").read_text(encoding="utf-8")
T156 = (MIG / "0156_named_resolution_params.sql").read_text(encoding="utf-8")
T159 = (MIG / "0159_duration_offered_by_model.sql").read_text(encoding="utf-8")
T126 = (MIG / "0126_region_edit_run.sql").read_text(encoding="utf-8")
T196 = (MIG / "0196_adult_attestation_google_runs.sql").read_text(encoding="utf-8")
ROLLBACK = (ROOT / "docs" / "sql" / "rollback_0208_geo_gate_and_image_size_price.sql").read_text(encoding="utf-8")
LAB = (ROOT / "tests" / "security" / "sec_db.py").read_text(encoding="utf-8")
CLAIM_TS = (ROOT / "command-center" / "lib" / "server" / "geo-claim.ts").read_text(encoding="utf-8")
OPS_TS = (ROOT / "command-center" / "lib" / "creative" / "operations.ts").read_text(encoding="utf-8")
SCHEMA = json.loads((ROOT / "schemas" / "model_registry.schema.json").read_text(encoding="utf-8"))
REGISTRY = json.loads((ROOT / "schemas" / "model_registry.json").read_text(encoding="utf-8"))["models"]
CODE = "\n".join(line.split("--", 1)[0] for line in NEW_TEXT.splitlines())


def bodies(text):
    return {m.group(1): m.group(0) for m in re.finditer(r"(?m)^create or replace function public\.(\w+)\(.*?^\$\$;\n", text, re.S)}


def md5_of(fn):
    b = fn[fn.index("$$") + 2: fn.rindex("$$")]
    return hashlib.md5(re.sub(r"\s+", " ", b).encode()).hexdigest()


NEW = bodies(NEW_TEXT)
PP_OLD = bodies(T156)["creative_params_problem"]
CP_OLD = bodies(T159)["creative_price"]

PP_HUNKS = [
    ("""                 -- 0126
                 'regions', 'region_feather') then
""", """                 -- 0126
                 'regions', 'region_feather',
                 -- 0208
                 'image_size') then
"""),
]
CP_ANCHORS = [
    "  vcost   numeric;\nbegin\n",
    "    m_unit := m_unit || '_' || regexp_replace(lower(tier), '[^a-z0-9]', '_', 'g');\n  end if;\n",
    "    || case when tier is null then '{}'::jsonb else jsonb_build_object('quality', tier) end\n",
]


class GeoGateImageSizeMigration(unittest.TestCase):
    def test_it_replaces_exactly_these_functions_and_drops_nothing(self):
        self.assertEqual(set(NEW), {"geo_claim_country", "creative_jobs_geo_gate", "creative_params_problem", "creative_price",
                                    "creative_regions_problem", "reroute_creative_job"})
        # reroute_creative_job's own update of the job it moves is 0196's (pinned below as 0196's body plus one hunk), not a data change
        # this file makes on apply.
        low = "\n".join(ln.split("--", 1)[0] for ln in NEW_TEXT.replace(NEW["reroute_creative_job"], "").splitlines()).lower()
        for word in ("drop table", "drop column", "drop function", "delete from", "truncate", "alter table", "create policy",
                     "create table", "grant execute"):
            self.assertNotIn(word, low)
        self.assertNotRegex(low, r"\b(insert\s+into|update\s+public\.|upsert)")

    def test_the_earlier_bodies_are_the_ones_the_guard_names(self):
        self.assertEqual(md5_of(PP_OLD), "25ee9cc62a27ad3a19e71008b04f3f36")
        self.assertEqual(md5_of(CP_OLD), "dafc5edae0000e741ac1b19bd0075790")

    def test_a_region_edit_may_name_a_size_and_nothing_else_changed_in_0126s_regions_check(self):
        # M1: without image_size in this closed list a model sold by size (creative_price refuses it with no size) could never run a
        # region edit. Undoing the one hunk (and its comment) must give 0126's body back byte for byte.
        old = bodies(T126)["creative_regions_problem"]
        self.assertEqual(md5_of(old), "5603be6af36c813d2799eb581bb971cd")
        new = NEW["creative_regions_problem"]
        self.assertEqual(md5_of(new), "bcf4c3e85a977c984ab53a9f00a4cfb6")
        undone = new.replace("""    if k not in ('source_asset_id', 'quality', 'regions', 'region_feather',
                 -- 0208
                 'image_size') then
""", "    if k not in ('source_asset_id', 'quality', 'regions', 'region_feather') then\n").replace(
            "the edge blend, the render tier (which only prices the model's own tiers) and the\n"
            "  -- picture size (0208: the value is creative_params_problem's, the model's list creative_price's) and nothing else",
            "the edge blend and the render tier (which only prices the model's own tiers) and\n  -- nothing else")
        self.assertEqual(undone, old)
        for sig in ("creative_regions_problem(jsonb)", "reroute_creative_job(uuid, text, text)"):
            self.assertIn(f"'public.{sig}'", NEW_TEXT.split("-- A missing key")[0], f"{sig} has no drift guard")

    def test_a_failover_skips_a_country_gated_candidate_instead_of_aborting(self):
        # M2: the routed_model update fires creative_jobs_geo_gate, and the worker has no claim: outside a block its NS400 aborted
        # the whole reroute (and every later candidate). The update must sit inside its own NS400 block that continues the loop.
        old = bodies(T196)["reroute_creative_job"]
        self.assertEqual(md5_of(old), "4e43d78523acacf10799497afef0d39a")
        new = NEW["reroute_creative_job"]
        self.assertEqual(md5_of(new), "7ebae97d8b932edbf565a394c5b9ca56")
        a = new.index("    -- 0208: moving the job onto m")
        b = new.index("    -- The real reason is the platform's")
        block = new[a:b]
        self.assertRegex(block, r"begin\n\s+update public\.creative_jobs[\s\S]*routed_model = m[\s\S]*exception when sqlstate 'NS400' then\n\s+continue;\n\s+end;")
        self.assertEqual(re.sub(r"\s+", " ", new[:a] + new[b:]),
                         re.sub(r"\s+", " ", old.replace(old[old.index("    update public.creative_jobs\n"):old.index("    -- The real reason")], "")))

    def test_creative_params_problem_is_0156s_plus_exactly_the_two_hunks(self):
        new = NEW["creative_params_problem"]
        anchor, hunk = PP_HUNKS[0]
        self.assertEqual(new.count(hunk), 1)
        undone = new.replace(hunk, anchor)
        block = undone[undone.index("  -- 0208: the size of a picture"):undone.index("  if p_params ? 'audio' then")]
        self.assertIn("not in ('512', '1K', '2K', '4K')", block)
        self.assertEqual(undone.replace(block, ""), PP_OLD, "creative_params_problem differs from 0156's beyond the two hunks")

    def test_creative_price_is_0159s_plus_exactly_the_three_hunks(self):
        new = NEW["creative_price"]
        undone = new.replace("  -- 0208: the picture size this quote is for (spec.pricing.variants.by = image_size).\n  vsize   text;\n", "")
        a, b = undone.index("  -- 0208: a picture size only on a model"), undone.index("  -- The video settings (0070).")
        size_block = undone[a:b]
        self.assertIn("m_unit := m_unit || '_' || regexp_replace(lower(vsize), '[^a-z0-9]', '_', 'g');", size_block)
        self.assertIn("is sold by picture size: name image_size", size_block)
        undone = undone.replace(size_block, "")
        undone = undone.replace("    -- 0208: the picture size this price is for.\n"
                                "    || case when vsize is null then '{}'::jsonb else jsonb_build_object('image_size', vsize) end\n", "")
        self.assertEqual(undone, CP_OLD, "creative_price differs from 0159's beyond the three hunks")
        for anchor in CP_ANCHORS:
            self.assertEqual(CP_OLD.count(anchor), 1, anchor)

    def test_every_hash_is_recomputed_from_the_files(self):
        pp, cp = md5_of(NEW["creative_params_problem"]), md5_of(NEW["creative_price"])
        geo, gate = md5_of(NEW["geo_claim_country"]), md5_of(NEW["creative_jobs_geo_gate"])
        for h in (pp, cp):
            self.assertGreaterEqual(NEW_TEXT.count(h), 3, h)       # header, drift guard, end state (and the Verify block)
            self.assertIn(h, ROLLBACK)
        for h in (geo, gate):
            self.assertIn(h, NEW_TEXT)
        self.assertIn(f'CREATIVE_PRICE_0208 = "{cp}"', LAB)
        self.assertIn(f'CREATIVE_PARAMS_PROBLEM_0208 = "{pp}"', LAB)

    def test_the_rollback_puts_the_earlier_bodies_back_verbatim_and_drops_the_gate(self):
        rb = bodies(ROLLBACK)
        self.assertEqual(rb["creative_params_problem"], PP_OLD)
        self.assertEqual(rb["creative_price"], CP_OLD)
        for stmt in ("drop trigger if exists creative_jobs_geo_gate on public.creative_jobs;",
                     "drop function if exists public.creative_jobs_geo_gate();",
                     "drop function if exists public.geo_claim_country();"):
            self.assertIn(stmt, ROLLBACK)

    def test_the_gate_is_a_trigger_on_insert_and_on_a_model_change_and_no_api_role_may_call_it(self):
        self.assertIn("before insert or update of routed_model on public.creative_jobs", NEW_TEXT)
        for sig in ("geo_claim_country()", "creative_jobs_geo_gate()"):
            self.assertIn(f"revoke all on function public.{sig} from public, anon, authenticated, service_role;", NEW_TEXT)
        gate = NEW["creative_jobs_geo_gate"]
        self.assertIn("perform public.creative_refuse('country_unverified'", gate)
        self.assertIn("perform public.creative_refuse('country_blocked'", gate)
        self.assertIn("security definer", gate)

    def test_the_claim_the_web_signs_is_the_one_the_sql_reads(self):
        geo = NEW["geo_claim_country"]
        self.assertIn('GEO_CLAIM_HEADER = "x-nightshift-geo"', CLAIM_TS)
        self.assertIn("->> 'x-nightshift-geo'", geo)
        self.assertIn("'nightshift_geo_claim_key'", geo)
        self.assertIn("nightshift_geo_claim_key", CLAIM_TS)
        ttl = int(re.search(r"GEO_CLAIM_TTL_S = (\d+);", CLAIM_TS).group(1))
        self.assertLessEqual(ttl, 300)
        self.assertIn("parts[4]::numeric > now_s + 300", geo)
        self.assertIn("const body = `v1.${country}.${userId}.${Math.floor(nowS) + GEO_CLAIM_TTL_S}`;", CLAIM_TS)
        self.assertIn('createHmac("sha256", key)', CLAIM_TS)
        self.assertIn("encode(hmac(array_to_string(parts[1:4], '.'), k, 'sha256'), 'hex') <> parts[5]", geo)
        self.assertIn("parts[3]::uuid is distinct from auth.uid()", geo)
        self.assertIn("char_length(k) < 32", geo)
        self.assertIn("MIN_KEY_CHARS = 32", CLAIM_TS)

    def test_no_key_is_written_in_a_file(self):
        for text in (NEW_TEXT, ROLLBACK):
            for m in re.finditer(r"vault\.create_secret\('([^']*)'", text):
                self.assertTrue(m.group(1).startswith("<"), "a Vault value in a migration must be a placeholder")

    def test_the_sizes_are_the_schemas_and_the_webs(self):
        enum = SCHEMA["$defs"]["image_size"]["enum"]
        self.assertEqual(enum, ["512", "1K", "2K", "4K"])
        self.assertIn('export const IMAGE_SIZES = ["512", "1K", "2K", "4K"] as const;', OPS_TS)
        self.assertIn('"image_size",', OPS_TS)
        for m in REGISTRY:
            if ((m.get("pricing") or {}).get("variants") or {}).get("by") == "image_size":
                # creative_price prices a size only for t2i / edit: a model priced by size that made anything else would be unpriced.
                self.assertTrue(set(m["capabilities"]) <= {"t2i", "edit"}, m["id"])
                self.assertTrue(set(m["image_sizes"]) <= set(enum), m["id"])

    def test_the_lab_takes_0208_off_before_0159(self):
        self.assertIn("MIGRATION_0208.name", LAB)
        self.assertIn("return rollback_0208_body() + ", LAB)
        self.assertIn("put_back_0208(session)", LAB)


if __name__ == "__main__":
    unittest.main()

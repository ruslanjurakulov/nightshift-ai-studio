"""Migration 0174 (rights acknowledgement: a recorded, server-enforced "I take responsibility" step), pinned as text.

What would break, and which test says so:

* a replaced body drifting from the one it was built on (a price, hold or refusal silently altered): each of the four is the
  earlier body plus inserted, marked 0174 blocks, and nothing deleted or changed;
* the gate moving before the price (a model refused anyway would ask) or after the ceiling, the hold or the job row (rule 6),
  or before an idempotent replay is answered;
* an input key the database accepts that the gate does not ask about (a new media input would slip past it);
* the requirement becoming removable by the service key, or the guard running as its owner (then everyone passes);
* the record losing its language, or its hourly cap;
* a model opened, or Runway's availability changed, in this PR; the file, the schema, the app and the migration disagreeing;
* md5 pins that no longer describe the files, a rollback that does not put the earlier bodies back verbatim or that drops the
  record, the replay hazard (0075 and 0073 do not protect 0174) not documented.

The lab (tests/security/test_sec_rights_acknowledgement.py) runs the same file on a real PostgreSQL; this test needs none.
"""

from __future__ import annotations

import difflib
import hashlib
import json
import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MIG = ROOT / "supabase" / "migrations"
M0174 = (MIG / "0174_rights_acknowledgement.sql").read_text(encoding="utf-8")
ROLLBACK = (ROOT / "docs" / "sql" / "rollback_0174_rights_acknowledgement.sql").read_text(encoding="utf-8")
MIGRATIONS_DOC = (ROOT / "docs" / "MIGRATIONS.md").read_text(encoding="utf-8")
DOC = (ROOT / "docs" / "RIGHTS_ACKNOWLEDGEMENT.md").read_text(encoding="utf-8")
REGISTRY = json.loads((ROOT / "schemas" / "model_registry.json").read_text(encoding="utf-8"))
SCHEMA = json.loads((ROOT / "schemas" / "model_registry.schema.json").read_text(encoding="utf-8"))
TS = (ROOT / "command-center" / "lib" / "rights-acknowledgement.ts").read_text(encoding="utf-8")

KINDS = ["likeness_photo", "voice_clone", "third_party_content"]
# name -> (the file it was built on, md5 before, md5 after, how many 0174 blocks are inserted)
REPLACED = {
    "create_creative_job": ("0075_model_router.sql", "4c74918fd9d938c8fe4f5a3d26a09d84", "88107b00b0a8c143606ed17f5898c98d", 2),
    "workflow_quote_steps": ("0073_workflow_apps.sql", "48250650e93a951c6b64cad1e73e8a24", "8f9f42da9844571a18a285d87bcffc84", 1),
    "start_workflow_run": ("0073_workflow_apps.sql", "c60ad7a487f7f11bf080ef92629c436e", "8b3c4b4afbc19e6f336c09b4692ad7ed", 1),
    "api_creative_refusal": ("0124_model_switch.sql", "2253296a9c1ac2e5de3c25a2a726398e", "e6ec45d0d912389a05eb2d40261c2c2a", 1),
}
NEW_FUNCTIONS = {
    "rights_acknowledgements_append_only": "e885c3b71a6af4724016c12554ed728e",
    "model_registry_requirement_guard": "598b4f2353046b4851abeb3b82090a2b",
    "rights_acknowledgement_required": "5b27521f352a65bfebba335f584152de",
    "rights_acknowledgement_missing": "426ea90d162535b0ee6f10e752e5fe26",
    "acknowledge_rights": "45f3e5ffdf69999f290363a55e81c303",
    "rights_acknowledgement_status": "d33d9861c2a2e5efca2614aabec3f311",
}


def definition(text: str, name: str) -> str:
    m = re.search(rf"^create or replace function public\.{re.escape(name)}\(.*?^\$\$;$", text, re.S | re.M)
    assert m, name
    return m.group(0)


def pg_md5(defn: str) -> str:
    """md5(regexp_replace(prosrc, '\\s+', ' ', 'g')), the hash every drift guard in this repository uses."""
    body = defn.split("as $$", 1)[1].rsplit("$$;", 1)[0]
    return hashlib.md5(re.sub(r"[ \t\n\r\f\v]+", " ", body).encode()).hexdigest()


def code(sql: str) -> str:
    return "\n".join(line.split("--", 1)[0] for line in sql.splitlines())


def latest(name: str, before: str = "0174") -> str:
    out = None
    for p in sorted(MIG.glob("*.sql")):
        if p.name[:4] >= before:
            continue
        text = p.read_text(encoding="utf-8")
        if re.search(rf"create or replace function public\.{re.escape(name)}\(", text):
            out = (p.name, definition(text, name))
    return out


class BuiltOnTheEarlierBodies(unittest.TestCase):
    def test_each_replaced_body_is_the_earlier_one_plus_inserted_marked_blocks_only(self):
        for name, (src, _old, _new, blocks) in REPLACED.items():
            old = definition((MIG / src).read_text(encoding="utf-8"), name).splitlines()
            new = definition(M0174, name).splitlines()
            ops = [op for op in difflib.SequenceMatcher(a=old, b=new, autojunk=False).get_opcodes() if op[0] != "equal"]
            self.assertEqual([op[0] for op in ops], ["insert"] * blocks, name)
            for _tag, _i1, _i2, j1, j2 in ops:
                self.assertIn("0174", "\n".join(new[j1:j2]), f"{name}: an inserted block names 0174")

    def test_the_earlier_body_is_the_latest_one_before_0174(self):
        for name, (src, *_rest) in REPLACED.items():
            self.assertEqual(latest(name)[0], src, f"{name} was redefined after {src}: rebuild 0174 on the newer body")

    def test_the_md5_pins_describe_the_bodies(self):
        for name, (src, old, new, _b) in REPLACED.items():
            self.assertEqual(pg_md5(definition((MIG / src).read_text(encoding="utf-8"), name)), old, name)
            self.assertEqual(pg_md5(definition(M0174, name)), new, name)
            self.assertGreaterEqual(M0174.count(old), 2, f"{name}: header and drift guard")
            self.assertGreaterEqual(M0174.count(new), 4, f"{name}: header, drift guard, end state and Verify")
        for name, want in NEW_FUNCTIONS.items():
            self.assertEqual(pg_md5(definition(M0174, name)), want, name)
            self.assertIn(f"'{want}'", M0174, f"the drift guard pins {name}")

    def test_it_defines_exactly_these_functions(self):
        self.assertEqual(sorted(re.findall(r"create or replace function public\.(\w+)\(", code(M0174))),
                         sorted([*NEW_FUNCTIONS, *REPLACED]))

    def test_the_grants(self):
        self.assertEqual(sorted(re.findall(r"grant execute on function (.*?);", code(M0174))), sorted([
            "public.create_creative_job(uuid, text, text, jsonb, text, text, numeric) to authenticated",
            "public.start_workflow_run(uuid, uuid, integer, jsonb, numeric) to authenticated",
            "public.acknowledge_rights(text, text, text, text) to authenticated",
            "public.rights_acknowledgement_status(uuid, text, text[]) to authenticated",
        ]))
        for name in [*NEW_FUNCTIONS, *REPLACED]:
            self.assertRegex(M0174, rf"revoke all on function public\.{name}\([^)]*\) from public, anon, authenticated, service_role;")
        for name in ("create_creative_job", "acknowledge_rights", "rights_acknowledgement_status",
                     "rights_acknowledgement_required", "rights_acknowledgement_missing"):
            self.assertIn("security definer set search_path = public, pg_temp as $$", definition(M0174, name), name)


class TheGate(unittest.TestCase):
    def test_it_asks_after_the_price_and_before_the_ceiling_the_hold_and_the_job(self):
        body = definition(M0174, "create_creative_job")
        gate = body.index("ack := public.rights_acknowledgement_missing(p_org, uid, q ->> 'model', p_params);")
        for earlier in ("'replay', true", "q := public.creative_price("):
            self.assertLess(body.index(earlier), gate, earlier)
        for later in ("if p_max_credits is not null and price > p_max_credits then", "public.creative_platform_reserve(",
                      "insert into public.creative_jobs"):
            self.assertLess(gate, body.index(later), later)

    def test_the_gate_asks_about_every_media_input_the_database_accepts(self):
        accepted = sorted(set(re.findall(r"'([a-z_]*asset_id)'", latest("creative_params_problem")[1])))
        asked = sorted(set(re.findall(r"p_params ->> '([a-z_]+)'", definition(M0174, "rights_acknowledgement_missing"))))
        self.assertEqual(asked, accepted, "a media input the database accepts must be asked about too")
        wf = definition(M0174, "workflow_quote_steps")
        in_workflows = re.search(r"\?\| array\[([^\]]*)\]", wf).group(1)
        self.assertEqual(sorted(s.strip().strip("'") for s in in_workflows.split(",")), accepted)
        self.assertIn('export const RIGHTS_SUBJECT_KEYS = ["source_asset_id", "end_asset_id"] as const;', TS)

    def test_workflows_refuse_before_anything_is_held(self):
        start = definition(M0174, "start_workflow_run")
        refuse = start.index("perform public.creative_refuse('acknowledgement_required',")
        self.assertLess(start.index("q := public.workflow_quote_steps(w, vals);"), refuse)
        self.assertLess(refuse, start.index("insert into public.workflow_runs"))
        self.assertLess(refuse, start.index("if not (q ->> 'priced')::boolean then"))

    def test_the_record_is_bound_to_the_session_keeps_its_language_and_is_capped(self):
        body = definition(M0174, "acknowledge_rights")
        self.assertIn("uid    uuid := auth.uid();", body)
        self.assertIn("values (a.org_id, uid, k.kind, k.text_version, p_locale, a.id, a.sha256)", body)
        self.assertIn("not public.is_org_member(a.org_id)", body)
        self.assertIn("p_locale not in ('en', 'ru', 'uz')", body)
        self.assertIn("constraint rights_acknowledgements_locale_check check (locale in ('en', 'ru', 'uz'))", M0174)
        self.assertRegex(body, r"created_at > now\(\) - interval '1 hour'\) >= 60 then")
        # A replay is answered before the cap is counted.
        self.assertLess(body.index("'replay', true"), body.index(">= 60 then"))

    def test_the_record_is_append_only(self):
        c = code(M0174)
        self.assertIn("before update or delete on public.rights_acknowledgements", c)
        self.assertIn("before truncate on public.rights_acknowledgements", c)
        self.assertIn("revoke all on public.rights_acknowledgements from public, anon, authenticated, service_role;", c)
        self.assertEqual(re.findall(r"grant (\w+) on public\.rights_acknowledgements to ([a-z_, ]+);", c), [("select", "authenticated, service_role")])
        self.assertNotRegex(c, r"create policy \w+ on public\.rights_acknowledgements\s+for (insert|update|delete|all)")

    def test_the_requirement_only_grows_and_the_guard_sees_its_caller(self):
        guard = definition(M0174, "model_registry_requirement_guard")
        self.assertNotIn("security definer", guard)
        self.assertIn("current_user is distinct from (select pg_get_userbyid(c.relowner)", guard)
        self.assertIn("not (coalesce(old.requires_acknowledgement, '{}') <@ new.requires_acknowledgement)", guard)
        self.assertIn("before insert or update on public.model_registry", M0174)

    def test_a_spec_of_another_shape_fails_closed(self):
        req = definition(M0174, "rights_acknowledgement_required")
        self.assertIn("else\n      from_spec := array['invalid_requires_acknowledgement'];", req)


class NothingIsOpened(unittest.TestCase):
    def test_no_availability_or_terms_gate_is_changed(self):
        c = code(M0174)
        self.assertNotRegex(c, r"(?i)\bset\s+availability\s*=")
        self.assertNotIn("terms_gate", c)
        self.assertNotIn("insert into public.credit_prices", c)

    def test_only_the_two_runway_entries_are_seeded_and_the_file_says_the_same(self):
        self.assertIn("where id in ('runway-gen4.5', 'runway-gen4-turbo')", M0174)
        self.assertEqual(len(re.findall(r"update public\.model_registry\b", code(M0174))), 1)
        required = {m["id"]: m["requires_acknowledgement"] for m in REGISTRY["models"] if m.get("requires_acknowledgement")}
        self.assertEqual(required, {"runway-gen4.5": ["likeness_photo"], "runway-gen4-turbo": ["likeness_photo"]})

    def test_the_kinds_agree_everywhere(self):
        m = re.search(r"rights_acknowledgement_kinds_kind_check\s+check \(kind in \(([^)]*)\)\)", M0174)
        self.assertEqual([s.strip().strip("'") for s in m.group(1).split(",")], KINDS)
        self.assertGreaterEqual(M0174.count("'likeness_photo', 'voice_clone', 'third_party_content'"), 3)
        self.assertEqual(SCHEMA["$defs"]["model"]["properties"]["requires_acknowledgement"]["items"]["enum"], KINDS)
        self.assertIn('export const RIGHTS_KINDS = ["likeness_photo", "voice_clone", "third_party_content"] as const;', TS)
        for k in KINDS:
            self.assertIn(f"('{k}', '{k}.v1')", M0174)
            self.assertIn(f'{k}: "{k}.v1"', TS)


class TheRollbackAndTheDoc(unittest.TestCase):
    def test_the_rollback_puts_the_earlier_bodies_back_verbatim_and_keeps_the_record(self):
        for name, (src, old, new, _b) in REPLACED.items():
            self.assertEqual(definition(ROLLBACK, name), definition((MIG / src).read_text(encoding="utf-8"), name), name)
            self.assertIn(old, ROLLBACK)
            self.assertIn(new, ROLLBACK)
        self.assertEqual(sorted(re.findall(r"grant execute on function (.*?);", code(ROLLBACK))), sorted([
            "public.create_creative_job(uuid, text, text, jsonb, text, text, numeric) to authenticated",
            "public.start_workflow_run(uuid, uuid, integer, jsonb, numeric) to authenticated"]))
        self.assertTrue(ROLLBACK.rstrip().endswith("commit;") and "\nbegin;\n" in ROLLBACK)
        self.assertNotRegex(code(ROLLBACK), r"(?i)drop table|drop column|delete from|truncate")
        self.assertIn("drop trigger if exists model_registry_requirement_guard on public.model_registry;", ROLLBACK)

    def test_the_file_says_how_to_apply_verify_and_undo_and_what_replay_does(self):
        self.assertIn("APPLY AS ONE TRANSACTION", M0174)
        self.assertIn("set local lock_timeout = '5s';", M0174)
        self.assertIn("-- Verify (run after applying, AND after any manual replay of 0073 or 0075", M0174)
        self.assertIn("rollback_0174_rights_acknowledgement.sql", M0174)
        self.assertIn("Re-running 0075 or 0073 after this file SILENTLY puts the old body back", M0174)
        self.assertIn("It KEEPS the record", M0174)
        self.assertNotIn("refused by 0075's own drift guard", M0174)
        self.assertNotIn("dropped with", M0174)

    def test_the_migration_is_documented(self):
        self.assertIn("(0174)", MIGRATIONS_DOC)
        self.assertIn("0174_rights_acknowledgement.sql", MIGRATIONS_DOC)
        self.assertIn("rollback_0174_rights_acknowledgement.sql", MIGRATIONS_DOC)
        self.assertNotIn("Re-running 0075 after 0174 is refused", MIGRATIONS_DOC)
        self.assertIn(REPLACED["create_creative_job"][2], DOC)
        self.assertIn("pending native review", DOC)
        for k in KINDS:
            self.assertIn(f"`{k}`", DOC)


if __name__ == "__main__":
    unittest.main()

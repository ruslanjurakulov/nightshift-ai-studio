"""Migration 0174 (rights acknowledgement: a recorded, server-enforced "I take responsibility" step), pinned as text.

What would break, and which test says so:

* the job start path drifting from 0075's while the gate is added (a price, hold or refusal silently altered): 0174's
  create_creative_job must be 0075's body plus exactly the two hunks listed here, byte for byte;
* the gate moving after the price, the expiry sweep or the hold (rule 6), or before an idempotent replay is answered;
* an input key the database accepts that the gate does not ask about (a new media input would slip past it);
* a model opened, or Runway's availability changed, in this PR;
* the registry file and the migration disagreeing on which models require which kind;
* md5 pins that no longer describe the files, grants that are not intended, a rollback that does not put 0075's body back
  verbatim or that drops the record, the number not documented.

The lab (tests/security/test_sec_rights_acknowledgement.py) runs the same file on a real PostgreSQL; this test needs none.
"""

from __future__ import annotations

import hashlib
import json
import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MIG = ROOT / "supabase" / "migrations"
M0075 = (MIG / "0075_model_router.sql").read_text(encoding="utf-8")
M0174 = (MIG / "0174_rights_acknowledgement.sql").read_text(encoding="utf-8")
ROLLBACK = (ROOT / "docs" / "sql" / "rollback_0174_rights_acknowledgement.sql").read_text(encoding="utf-8")
MIGRATIONS_DOC = (ROOT / "docs" / "MIGRATIONS.md").read_text(encoding="utf-8")
DOC = (ROOT / "docs" / "RIGHTS_ACKNOWLEDGEMENT.md").read_text(encoding="utf-8")
REGISTRY = json.loads((ROOT / "schemas" / "model_registry.json").read_text(encoding="utf-8"))
SCHEMA = json.loads((ROOT / "schemas" / "model_registry.schema.json").read_text(encoding="utf-8"))
TS = (ROOT / "command-center" / "lib" / "rights-acknowledgement.ts").read_text(encoding="utf-8")

SIG = "public.create_creative_job(uuid, text, text, jsonb, text, text, numeric)"
BODY_0075 = "4c74918fd9d938c8fe4f5a3d26a09d84"
BODY_0174 = "128fa773beb2f3ef30ac8a332088a5e2"
KINDS = ["likeness_photo", "voice_clone", "third_party_content"]
NEW_FUNCTIONS = {
    "rights_acknowledgements_append_only": "e885c3b71a6af4724016c12554ed728e",
    "rights_acknowledgement_required": "bdae111d99c36aad7029cd99295fde7f",
    "rights_acknowledgement_missing": "426ea90d162535b0ee6f10e752e5fe26",
    "acknowledge_rights": "ff9ae30a102df6f68103420266139e2c",
    "rights_acknowledgement_status": "d33d9861c2a2e5efca2614aabec3f311",
}
HUNKS = [
    ("  rt    jsonb;\n",
     "  rt    jsonb;\n"
     "  -- 0174: the first input this person has not acknowledged, for a model that requires an acknowledgement.\n"
     "  ack   jsonb;\n"),
    ("      return jsonb_build_object('job', public.creative_job_json(prior), 'replay', true);\n    end if;\n  end if;\n\n",
     "      return jsonb_build_object('job', public.creative_job_json(prior), 'replay', true);\n    end if;\n  end if;\n\n"
     "  -- 0174: a model whose provider (or the law) makes the person confirm their rights to an input refuses here, before\n"
     "  -- anything is priced or held, unless THIS person acknowledged THIS input in THIS organization at the CURRENT text\n"
     "  -- version (rights_acknowledgement_missing). A replay of a job already created was answered above.\n"
     "  ack := public.rights_acknowledgement_missing(p_org, uid, p_model, p_params);\n"
     "  if ack is not null then\n"
     "    perform public.creative_refuse('acknowledgement_required',\n"
     "      format('kind=%s version=%s subject=%s', ack ->> 'kind', coalesce(ack ->> 'text_version', 'none'), ack ->> 'subject'));\n"
     "  end if;\n\n"),
]


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


class BuiltOn0075(unittest.TestCase):
    def test_create_creative_job_is_0075s_body_plus_the_two_hunks(self):
        body = definition(M0075, "create_creative_job")
        for old, new in HUNKS:
            self.assertEqual(body.count(old), 1, old)
            body = body.replace(old, new)
        self.assertEqual(definition(M0174, "create_creative_job"), body)

    def test_no_migration_between_0075_and_0174_redefines_it(self):
        later = [p.name for p in sorted(MIG.glob("*.sql"))
                 if "0075" < p.name[:4] < "0174"
                 and re.search(r"create or replace function public\.create_creative_job\(", p.read_text(encoding="utf-8"))]
        self.assertEqual(later, [], "create_creative_job was redefined after 0075: rebuild 0174 on the newer body")

    def test_the_md5_pins_describe_the_bodies(self):
        self.assertEqual(pg_md5(definition(M0075, "create_creative_job")), BODY_0075)
        self.assertEqual(pg_md5(definition(M0174, "create_creative_job")), BODY_0174)
        self.assertGreaterEqual(M0174.count(BODY_0075), 2, "header and drift guard name 0075's body")
        self.assertGreaterEqual(M0174.count(BODY_0174), 4, "header, drift guard, end state and Verify name 0174's body")
        for name, want in NEW_FUNCTIONS.items():
            self.assertEqual(pg_md5(definition(M0174, name)), want, name)
            self.assertIn(f"'{want}'", M0174, f"the drift guard pins {name}")

    def test_it_defines_exactly_these_functions(self):
        self.assertEqual(sorted(re.findall(r"create or replace function public\.(\w+)\(", code(M0174))),
                         sorted([*NEW_FUNCTIONS, "create_creative_job"]))

    def test_the_grants(self):
        self.assertIn(f"revoke all on function {SIG} from public, anon, authenticated, service_role;", M0174)
        self.assertEqual(sorted(re.findall(r"grant execute on function (.*?);", code(M0174))), sorted([
            f"{SIG} to authenticated",
            "public.acknowledge_rights(text, text, text) to authenticated",
            "public.rights_acknowledgement_status(uuid, text, text[]) to authenticated",
        ]))
        for name in NEW_FUNCTIONS:
            self.assertRegex(M0174, rf"revoke all on function public\.{name}\([^)]*\) from public, anon, authenticated, service_role;")
        for name in ("create_creative_job", "acknowledge_rights", "rights_acknowledgement_status",
                     "rights_acknowledgement_required", "rights_acknowledgement_missing"):
            self.assertIn("security definer set search_path = public, pg_temp as $$", definition(M0174, name), name)


class TheGate(unittest.TestCase):
    def test_it_refuses_after_a_replay_and_before_the_price_the_sweep_and_the_hold(self):
        body = definition(M0174, "create_creative_job")
        gate = body.index("ack := public.rights_acknowledgement_missing(p_org, uid, p_model, p_params);")
        self.assertLess(body.index("'replay', true"), gate)
        for later in ("perform public.creative_expire_locked(p_org);", "q := public.creative_price(", "public.creative_platform_reserve(",
                      "insert into public.creative_jobs"):
            self.assertLess(gate, body.index(later), later)

    def test_the_gate_asks_about_every_media_input_the_database_accepts(self):
        latest = None
        for p in sorted(MIG.glob("*.sql")):
            text = p.read_text(encoding="utf-8")
            if re.search(r"create or replace function public\.creative_params_problem\(", text):
                latest = definition(text, "creative_params_problem")
        accepted = sorted(set(re.findall(r"'([a-z_]*asset_id)'", latest)))
        asked = sorted(set(re.findall(r"p_params ->> '([a-z_]+)'", definition(M0174, "rights_acknowledgement_missing"))))
        self.assertEqual(asked, accepted, "a media input the database accepts must be asked about too")
        self.assertIn('export const RIGHTS_SUBJECT_KEYS = ["source_asset_id", "end_asset_id"] as const;', TS)

    def test_the_record_is_bound_to_the_session_not_to_an_argument(self):
        body = definition(M0174, "acknowledge_rights")
        self.assertIn("uid  uuid := auth.uid();", body)
        self.assertIn("values (a.org_id, uid, k.kind, k.text_version, a.id, a.sha256)", body)
        self.assertIn("not public.is_org_member(a.org_id)", body)
        self.assertRegex(body, r"p_text_version is distinct from k\.text_version")

    def test_the_record_is_append_only(self):
        c = code(M0174)
        self.assertIn("before update or delete on public.rights_acknowledgements", c)
        self.assertIn("before truncate on public.rights_acknowledgements", c)
        self.assertIn("revoke all on public.rights_acknowledgements from public, anon, authenticated, service_role;", c)
        self.assertEqual(re.findall(r"grant (\w+) on public\.rights_acknowledgements to ([a-z_, ]+);", c), [("select", "authenticated, service_role")])
        self.assertNotRegex(c, r"create policy \w+ on public\.rights_acknowledgements\s+for (insert|update|delete|all)")


class NothingIsOpened(unittest.TestCase):
    def test_no_availability_or_terms_gate_is_changed(self):
        c = code(M0174)
        self.assertNotRegex(c, r"(?i)\bavailability\s*=")
        self.assertNotIn("terms_gate", c)
        self.assertNotIn("credit_prices", c)

    def test_only_the_two_runway_entries_are_seeded_and_the_file_says_the_same(self):
        self.assertIn("where id in ('runway-gen4.5', 'runway-gen4-turbo')", M0174)
        self.assertEqual(len(re.findall(r"update public\.model_registry\b", code(M0174))), 1)
        required = {m["id"]: m["requires_acknowledgement"] for m in REGISTRY["models"] if m.get("requires_acknowledgement")}
        self.assertEqual(required, {"runway-gen4.5": ["likeness_photo"], "runway-gen4-turbo": ["likeness_photo"]})

    def test_the_kinds_agree_everywhere(self):
        m = re.search(r"rights_acknowledgement_kinds_kind_check\s+check \(kind in \(([^)]*)\)\)", M0174)
        self.assertEqual([s.strip().strip("'") for s in m.group(1).split(",")], KINDS)
        self.assertIn("array['likeness_photo', 'voice_clone', 'third_party_content']::text[]", M0174)
        self.assertEqual(SCHEMA["$defs"]["model"]["properties"]["requires_acknowledgement"]["items"]["enum"], KINDS)
        self.assertIn('export const RIGHTS_KINDS = ["likeness_photo", "voice_clone", "third_party_content"] as const;', TS)
        for k in KINDS:
            self.assertIn(f"('{k}', '{k}.v1')", M0174)
            self.assertIn(f'{k}: "{k}.v1"', TS)


class TheRollbackAndTheDoc(unittest.TestCase):
    def test_the_rollback_puts_0075s_body_back_verbatim_and_keeps_the_record(self):
        self.assertEqual(definition(ROLLBACK, "create_creative_job"), definition(M0075, "create_creative_job"))
        self.assertIn(BODY_0174, ROLLBACK)
        self.assertIn(BODY_0075, ROLLBACK)
        self.assertEqual(re.findall(r"grant execute on function (.*?);", code(ROLLBACK)), [f"{SIG} to authenticated"])
        self.assertTrue(ROLLBACK.rstrip().endswith("commit;") and "\nbegin;\n" in ROLLBACK)
        self.assertNotRegex(code(ROLLBACK), r"(?i)drop (table|trigger)|drop column|delete from|truncate")

    def test_the_file_says_how_to_apply_verify_and_undo(self):
        self.assertIn("APPLY AS ONE TRANSACTION", M0174)
        self.assertIn("set local lock_timeout = '5s';", M0174)
        self.assertIn("-- Verify (run after applying", M0174)
        self.assertIn("rollback_0174_rights_acknowledgement.sql", M0174)
        self.assertIn("WHAT TO VERIFY BEFORE YOU APPLY", M0174)

    def test_the_migration_is_documented(self):
        self.assertIn("(0174)", MIGRATIONS_DOC)
        self.assertIn("0174_rights_acknowledgement.sql", MIGRATIONS_DOC)
        self.assertIn("rollback_0174_rights_acknowledgement.sql", MIGRATIONS_DOC)
        self.assertIn(BODY_0174, DOC)
        for k in KINDS:
            self.assertIn(f"`{k}`", DOC)


if __name__ == "__main__":
    unittest.main()

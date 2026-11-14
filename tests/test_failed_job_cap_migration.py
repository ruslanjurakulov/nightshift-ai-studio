"""Migration 0175 (at most 5 failed or refused creative jobs per organization per rolling 24 hours), pinned as text.

What would break, and which test says so:

* a replaced body drifting from the one it was built on (a price, hold, acknowledgement or refusal silently altered): each of
  the four is the earlier body plus ONE inserted, marked 0175 block, and nothing deleted or changed;
* the gate moving before an idempotent replay is answered (a job already made would be refused), or after the price, the
  acknowledgement, the ceiling, the hold or the job row (something would be held first: rule 6);
* a workflow started at the limit, or a waiting step reading "your plan's runs are busy" (rule 5);
* a code that is not the customer's doing counted against them (an outage, a quota, our worker, a model switched off), or one of
  theirs not counted; the operator's credits-exempt organization capped;
* the API answering anything but 429 failed_job_limit, or showing a count it could not read (rule 5);
* md5 pins that no longer describe the files, a rollback that does not put the earlier bodies back verbatim, the replay hazard
  (0083 has no guard) not documented, the numbering lists or the docs not naming 0175.

The lab (tests/security/test_sec_failed_job_cap.py) runs the same file on a real PostgreSQL; this test needs none.
"""

from __future__ import annotations

import difflib
import hashlib
import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MIG = ROOT / "supabase" / "migrations"
M0175 = (MIG / "0175_failed_job_cap.sql").read_text(encoding="utf-8")
ROLLBACK = (ROOT / "docs" / "sql" / "rollback_0175_failed_job_cap.sql").read_text(encoding="utf-8")
MIGRATIONS_DOC = (ROOT / "docs" / "MIGRATIONS.md").read_text(encoding="utf-8")

# name -> (the file it was built on, md5 before, md5 after)
REPLACED = {
    "create_creative_job": ("0174_rights_acknowledgement.sql", "88107b00b0a8c143606ed17f5898c98d", "1ddd39a69de4153e36d02aa372ed5e60"),
    "start_workflow_run": ("0174_rights_acknowledgement.sql", "8b3c4b4afbc19e6f336c09b4692ad7ed", "3a7d8eb57e48badff9ab7e321e6c52f6"),
    "workflow_advance_locked": ("0083_workflow_wait.sql", "2d63f9fb091efa71d8ae466cba0b42db", "b46b5f42927697ebbb8176f8ce527c6d"),
    "api_creative_refusal": ("0174_rights_acknowledgement.sql", "e6ec45d0d912389a05eb2d40261c2c2a", "a5db9f56ba2e83c285beaace621217d8"),
}
NEW_FUNCTIONS = {
    "creative_failed_job_codes": "2abde1f23d4729dec2ee73935f0c1c6c",
    "creative_failed_job_gate": "db8553de657fe2ee8c801879fe8b8735",
}
COUNTED = ["policy", "bad_request", "invalid_params", "source_unavailable", "source_too_large", "provider_error"]
# Codes the worker, the adapters or the database write that are NOT the customer's doing (modules/capabilities/base.py,
# modules/creative_worker.py, 0036, 0124, 0126).
NOT_THE_CUSTOMERS = ["unavailable", "unreachable", "network", "rate_limited", "quota", "provider_quota", "auth", "not_configured",
                     "not_found", "bad_response", "vendor_tool_unsupported", "adapter_missing", "worker_error", "worker_lost",
                     "submit_interrupted", "provider_timeout", "output_lost", "result_not_stored", "credits_unavailable",
                     "hold_below_quote", "no_credit_hold", "hold_not_open", "model_temporarily_off", "no_region_applied",
                     "region_quote_mismatch"]


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


def latest(name: str, before: str = "0175") -> str:
    out = None
    for p in sorted(MIG.glob("*.sql")):
        if p.name[:4] >= before:
            continue
        if re.search(rf"create or replace function public\.{re.escape(name)}\(", p.read_text(encoding="utf-8")):
            out = p.name
    return out


class BuiltOnTheEarlierBodies(unittest.TestCase):
    def test_each_replaced_body_is_the_earlier_one_plus_one_inserted_marked_block(self):
        for name, (src, _old, _new) in REPLACED.items():
            old = definition((MIG / src).read_text(encoding="utf-8"), name).splitlines()
            new = definition(M0175, name).splitlines()
            ops = [op for op in difflib.SequenceMatcher(a=old, b=new, autojunk=False).get_opcodes() if op[0] != "equal"]
            self.assertEqual([op[0] for op in ops], ["insert"], name)
            self.assertIn("0175", "\n".join(new[ops[0][3]:ops[0][4]]), f"{name}: the inserted block names 0175")

    def test_the_earlier_body_is_the_latest_one_before_0175(self):
        for name, (src, *_rest) in REPLACED.items():
            self.assertEqual(latest(name), src, f"{name} was redefined after {src}: rebuild 0175 on the newer body")

    def test_the_md5_pins_describe_the_bodies(self):
        for name, (src, old, new) in REPLACED.items():
            self.assertEqual(pg_md5(definition((MIG / src).read_text(encoding="utf-8"), name)), old, name)
            self.assertEqual(pg_md5(definition(M0175, name)), new, name)
            # The drift guard, the end state and the rollback all name both.
            self.assertIn(f"'{old}', '{new}'", M0175, name)
            self.assertIn(f"'{new}'", ROLLBACK, name)
            self.assertIn(f"'{old}'", ROLLBACK, name)
        for name, want in NEW_FUNCTIONS.items():
            self.assertEqual(pg_md5(definition(M0175, name)), want, name)
            self.assertIn(f"'{want}'", M0175)

    def test_it_defines_exactly_these_functions_and_one_index_and_no_table(self):
        self.assertEqual(sorted(re.findall(r"create or replace function public\.(\w+)\(", M0175)),
                         sorted([*REPLACED, *NEW_FUNCTIONS]))
        self.assertEqual(re.findall(r"create index if not exists (\w+) on public\.creative_jobs \(([^)]*)\)", M0175),
                         [("creative_jobs_failed_window_idx", "org_id, status, finished_at")])
        outside = re.sub(r"(?ms)^create or replace function public\.\w+\(.*?^\$\$;$", "", code(M0175))
        self.assertNotRegex(outside, r"(?i)\b(create table|alter table|insert into|update public|delete from|drop )")

    def test_the_grants_are_restated_and_the_new_functions_are_nobodys(self):
        self.assertIn("grant execute on function public.create_creative_job(uuid, text, text, jsonb, text, text, numeric) to authenticated;", M0175)
        self.assertIn("grant execute on function public.start_workflow_run(uuid, uuid, integer, jsonb, numeric) to authenticated;", M0175)
        for sig in ("creative_failed_job_codes()", "creative_failed_job_gate(uuid)", "workflow_advance_locked(uuid, boolean)",
                    "api_creative_refusal(text, text, text)"):
            self.assertIn(f"revoke all on function public.{sig} from public, anon, authenticated, service_role;", M0175)
            self.assertNotRegex(M0175, rf"grant execute on function public\.{re.escape(sig)}")


class TheGate(unittest.TestCase):
    def test_the_job_gate_comes_after_the_replay_and_before_the_price_the_hold_and_the_job(self):
        body = definition(M0175, "create_creative_job")
        gate = body.index("perform public.creative_failed_job_gate(p_org);")
        self.assertLess(body.index("return jsonb_build_object('job', public.creative_job_json(prior), 'replay', true);"), gate)
        self.assertLess(body.index("perform public.credit_account_lock(p_org);"), gate, "counted under the account lock")
        for later in ("q := public.creative_price(", "public.rights_acknowledgement_missing(", "price > p_max_credits",
                      "public.creative_platform_reserve(", "insert into public.creative_jobs"):
            self.assertLess(gate, body.index(later), later)

    def test_the_workflow_gate_comes_after_the_replay_and_before_the_run_row(self):
        body = definition(M0175, "start_workflow_run")
        gate = body.index("perform public.creative_failed_job_gate(w.org_id);")
        self.assertLess(body.index("return public.workflow_run_json(prior.id) || jsonb_build_object('replay', true);"), gate)
        self.assertLess(body.index("perform public.credit_account_lock(w.org_id);"), gate)
        self.assertLess(gate, body.index("insert into public.workflow_runs"))

    def test_a_waiting_step_keeps_waiting_under_its_own_word(self):
        body = definition(M0175, "workflow_advance_locked")
        self.assertIn("wait_ := sqlstate in ('NS429', 'NS402');", body, "the cap passes like the run limit: the step waits")
        own = body.index("when sqlstate = 'NS429' and sqlerrm = 'failed_job_limit' then 'failed_job_limit'")
        self.assertLess(own, body.index("when sqlstate = 'NS429' then 'run_limit_reached'"), "the narrower word is read first")

    def test_the_counted_codes_are_the_customers_and_nothing_else(self):
        gate = definition(M0175, "creative_failed_job_codes")
        listed = re.findall(r"'([a-z_]+)'", gate.split("array[", 1)[1].split("]", 1)[0])
        self.assertEqual(listed, COUNTED)
        for c in NOT_THE_CUSTOMERS:
            self.assertNotIn(c, listed, c)
            self.assertIn(c, M0175.split("CHANGE (additive", 1)[0], f"the header says why {c} is not counted")

    def test_the_counted_codes_exist_in_the_worker_and_the_adapters(self):
        src = "\n".join(p.read_text(encoding="utf-8") for p in
                        [ROOT / "modules" / "creative_worker.py", ROOT / "modules" / "capabilities" / "base.py",
                         ROOT / "modules" / "media_library.py", ROOT / "modules" / "region_edit.py"])
        for c in COUNTED:
            self.assertIn(f'"{c}"', src, f"{c} is not a code anything writes: the list names a word nobody uses")

    def test_the_window_the_limit_the_exemption_and_the_refusal(self):
        gate = definition(M0175, "creative_failed_job_gate")
        self.assertIn("failed_job_limit constant integer := 5;", gate)
        self.assertEqual(gate.count("j.status = 'failed' and j.finished_at > now() - interval '24 hours'"), 2)
        self.assertIn("public.credits_exempt(p_org)", gate)
        self.assertIn("offset n - failed_job_limit", gate, "retry_at is when the count drops below the limit")
        self.assertIn("perform public.creative_refuse('failed_job_limit',", gate)
        self.assertIn("format('failed=%s limit=%s retry_at=%s'", gate)
        self.assertIn("'YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"')), 'NS429');", gate)
        self.assertIn("frees at time zone 'UTC'", gate)

    def test_the_api_answer(self):
        body = definition(M0175, "api_creative_refusal")
        branch = body.split("if word = 'failed_job_limit' then", 1)[1].split("end if;\n      m :=", 1)[0]
        self.assertEqual(branch.count("public.api_err(429, 'failed_job_limit',"), 2)
        self.assertIn("Nothing was held or charged.", branch)
        self.assertIn("contact support", branch)
        unknown = branch.split("if m is null then", 1)[1].split("end if;", 1)[0]
        self.assertNotRegex(unknown, r"\b\d+ generations|limit is|UTC|%s", "an unread count is never shown as a number (rule 5)")
        self.assertIn("'failed_jobs', m[1]::int, 'limit', m[2]::int", branch)
        # The plan's run limit keeps its own answer after the new branch.
        self.assertLess(body.index("if word = 'failed_job_limit' then"), body.index("'run_limit_reached'"))


class TheRollbackAndTheDocs(unittest.TestCase):
    def test_the_rollback_puts_the_earlier_bodies_back_verbatim(self):
        for name, (src, _old, _new) in REPLACED.items():
            self.assertEqual(definition(ROLLBACK, name), definition((MIG / src).read_text(encoding="utf-8"), name), name)
        for sig in ("creative_failed_job_gate(uuid)", "creative_failed_job_codes()"):
            self.assertIn(f"drop function if exists public.{sig};", ROLLBACK)
        self.assertIn("drop index if exists public.creative_jobs_failed_window_idx;", ROLLBACK)
        self.assertRegex(ROLLBACK, r"(?m)^begin;$")
        self.assertRegex(ROLLBACK, r"(?m)^commit;$")

    def test_the_file_says_how_to_apply_verify_and_undo_and_what_replay_does(self):
        self.assertIn("APPLY AS ONE TRANSACTION", M0175)
        self.assertIn("set local lock_timeout = '5s';", M0175)
        self.assertNotRegex(code(M0175), r"(?im)^\s*(begin|commit)\s*;")
        self.assertIn("-- Verify", M0175)
        self.assertIn("docs/sql/rollback_0175_failed_job_cap.sql", M0175)
        self.assertIn("0083 has no", M0175)
        self.assertIn("merges AFTER 0174", M0175)
        self.assertIn("THE RACE BOUND", M0175)

    def test_the_migration_is_documented(self):
        section = re.split(r"\n## [^\n]*\(0175\)\n", MIGRATIONS_DOC, maxsplit=1)
        self.assertEqual(len(section), 2, "docs/MIGRATIONS.md has a 0175 section")
        for word in ("failed_job_limit", "rollback_0175_failed_job_cap.sql", "after 0174", "credits-exempt"):
            self.assertIn(word, section[1].split("\n## ", 1)[0], word)

    def test_the_number_is_unique_and_follows_0174(self):
        numbers = sorted(p.name[:4] for p in MIG.glob("*.sql"))
        self.assertEqual(numbers.count("0175"), 1)
        self.assertIn("0174", numbers)


if __name__ == "__main__":
    unittest.main()

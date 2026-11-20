"""Migration 0179 (the rights acknowledgement asks about every file a job sends, on the model it runs), pinned as text.

What would break, and which test says so:

* a replaced body drifting from the one it was built on (a failover or a film start silently altered): reroute_creative_job and
  start_film are the earlier bodies plus one inserted, marked 0179 block each, and nothing deleted or changed;
* failover asking after it has already moved the job, or a film asking after the hold (rule 6: before anything is held);
* the gate reading fewer inputs again (style kit pictures, @character pictures), or the @name rule drifting from the one the
  worker uses (modules/creative_style.py MENTION_RE), so a mention the worker sends is one the gate never asks about;
* an internal helper becoming callable by an API role;
* md5 pins that no longer describe the files, or a rollback that does not put the earlier bodies back verbatim.

The lab (tests/security/test_sec_breach_rights_ack_bypass.py and test_sec_breach_rights_ack_films.py) runs the same file on a
real PostgreSQL; this test needs none.
"""

from __future__ import annotations

import difflib
import hashlib
import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MIG = ROOT / "supabase" / "migrations"
M0179 = (MIG / "0179_rights_acknowledgement_inputs.sql").read_text(encoding="utf-8")
ROLLBACK = (ROOT / "docs" / "sql" / "rollback_0179_rights_acknowledgement_inputs.sql").read_text(encoding="utf-8")
STYLE = (ROOT / "modules" / "creative_style.py").read_text(encoding="utf-8")
MIGRATIONS_DOC = (ROOT / "docs" / "MIGRATIONS.md").read_text(encoding="utf-8")

# name -> (the file it was built on, md5 before, md5 after)
REPLACED = {
    "rights_acknowledgement_missing": ("0174_rights_acknowledgement.sql", "426ea90d162535b0ee6f10e752e5fe26",
                                       "ff6645d1c02cb8d542a2156967534c33"),
    "reroute_creative_job": ("0088_router_failover_reason.sql", "55d07640bb22798e2a74bb661ac4f8d0",
                             "9dfc81eb3e77555ee9e04c53b22c84e9"),
    "start_film": ("0171_films_money.sql", "63510a6d9c456e66f658353bab592d38", "0cfb804e3e5d415957df0106b65ef75b"),
}
NEW = {
    "rights_acknowledgement_subjects": "8de7e1ebe43848d31f556a0f7e4047a9",
    "rights_acknowledgement_missing_among": "f3a844885ec3b4fc3b0d45dc80f5e65b",
    "film_acknowledgement_missing": "adc0f941638725a6870fb5999b0f93cf",
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


def latest(name: str, before: str = "0179") -> tuple[str, str]:
    out = None
    for p in sorted(MIG.glob("*.sql")):
        if p.name[:4] >= before:
            continue
        text = p.read_text(encoding="utf-8")
        if re.search(rf"create or replace function public\.{re.escape(name)}\(", text):
            out = (p.name, definition(text, name))
    assert out, name
    return out


class Migration0179(unittest.TestCase):
    def test_the_earlier_body_is_the_latest_one_before_0179(self):
        for name, (src, _was, _now) in REPLACED.items():
            self.assertEqual(latest(name)[0], src, name)

    def test_the_md5_pins_describe_the_bodies(self):
        for name, (src, was, now) in REPLACED.items():
            self.assertEqual(pg_md5(latest(name)[1]), was, name)
            self.assertEqual(pg_md5(definition(M0179, name)), now, name)
            self.assertIn(f"'{was}', '{now}'", M0179, name)
        for name, want in NEW.items():
            self.assertEqual(pg_md5(definition(M0179, name)), want, name)
            self.assertIn(f"'{want}'", M0179, name)

    def test_failover_and_film_start_are_the_earlier_bodies_plus_one_marked_block(self):
        for name in ("reroute_creative_job", "start_film"):
            old = latest(name)[1].splitlines()
            new = definition(M0179, name).splitlines()
            ops = [op for op in difflib.SequenceMatcher(a=old, b=new, autojunk=False).get_opcodes() if op[0] != "equal"]
            self.assertEqual([op[0] for op in ops], ["insert"], name)
            self.assertTrue(new[ops[0][3]].strip().startswith("-- 0179:"), name)

    def test_failover_asks_before_it_moves_the_job(self):
        body = code(definition(M0179, "reroute_creative_job"))
        ask = body.index("rights_acknowledgement_missing(j.org_id, j.requested_by, m, j.params) is not null")
        self.assertLess(body.index("sellable_models(j.capability, surf)"), ask)
        self.assertLess(ask, body.index("update public.creative_jobs"))

    def test_a_film_asks_after_the_price_and_before_the_hold_and_the_takes(self):
        body = code(definition(M0179, "start_film"))
        ask = body.index("film_acknowledgement_missing(f, uid)")
        self.assertLess(body.index("q := public.film_price(f)"), ask)
        for later in ("reserve_credits(org, ref, total)", "insert into public.film_segments", "insert into public.film_takes"):
            self.assertLess(ask, body.index(later), later)
        self.assertIn("'reason', 'acknowledgement_required'", body)
        # The shape the Studio's dialog parses (lib/rights-acknowledgement.ts parseRefusalDetail).
        self.assertIn("format('kind=%s version=%s subject=%s'", body)

    def test_every_input_the_worker_sends_is_a_subject(self):
        subj = code(definition(M0179, "rights_acknowledgement_subjects"))
        for part in ("'source_asset_id'", "'end_asset_id'", "'style_kit_id'", "public.style_kit_references",
                     "public.character_references", "limit 16"):
            self.assertIn(part, subj, part)
        self.assertIn("rights_acknowledgement_subjects(p_org, p_params)", code(definition(M0179, "rights_acknowledgement_missing")))

    def test_the_mention_rule_is_the_workers(self):
        py = re.search(r'MENTION_RE = re\.compile\(r"(.+?)"\)', STYLE).group(1)
        self.assertIn(f"'{py}'", definition(M0179, "rights_acknowledgement_subjects"))

    def test_the_helpers_are_internal(self):
        for name in NEW:
            self.assertIn(f"revoke all on function public.{name}(", M0179)
            self.assertNotRegex(M0179, rf"grant execute on function public\.{name}\(")
        self.assertIn("grant execute on function public.reroute_creative_job(uuid, text, text) to service_role;", M0179)
        self.assertIn("grant execute on function public.start_film(uuid, text, text) to authenticated;", M0179)

    def test_no_model_availability_or_requirement_is_changed(self):
        sql = code(M0179).lower()
        self.assertNotIn("update public.model_registry", sql)
        self.assertNotIn("credit_prices", sql)

    def test_the_rollback_puts_the_earlier_bodies_back_verbatim(self):
        for name in REPLACED:
            self.assertEqual(definition(ROLLBACK, name), latest(name)[1], name)
        for name in NEW:
            self.assertIn(f"drop function if exists public.{name}(", ROLLBACK)

    def test_the_migration_is_documented(self):
        self.assertIn("0179_rights_acknowledgement_inputs.sql", MIGRATIONS_DOC)


if __name__ == "__main__":
    unittest.main()

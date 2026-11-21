"""Migration 0198 (Film Studio P3: the switch per organization, the take's creative job), pinned as text.

What would break, and which test says so:

* a replaced body drifting from the one it was built on (a film start, a quote or the worker's claim silently altered): quote_film,
  start_film and film_claim_segment are the earlier bodies with exactly one marked 0198 hunk each, and undoing that hunk gives the
  earlier body back byte for byte;
* the switch defaulting on, or this file turning the platform's switch on (it must never write film_studio_settings);
* the setter losing owner_guard or its security_events row, or becoming callable by the anon key or the service key;
* the take's job gaining a hold of its own, a payer other than 'film', or a queue status the credit-paid worker would claim;
* md5 pins that no longer describe the file, or a rollback that does not put the earlier bodies back verbatim;
* the migration missing from docs/MIGRATIONS.md.

The lab (tests/security/test_sec_film_worker.py) runs the same file on a real PostgreSQL; this test needs none.
"""

from __future__ import annotations

import hashlib
import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MIG = ROOT / "supabase" / "migrations"
M0198 = (MIG / "0198_film_studio_org_switch.sql").read_text(encoding="utf-8")
ROLLBACK = (ROOT / "docs" / "sql" / "rollback_0198_film_studio_org_switch.sql").read_text(encoding="utf-8")
MIGRATIONS_DOC = (ROOT / "docs" / "MIGRATIONS.md").read_text(encoding="utf-8")

# name -> (the file it was built on, md5 before, md5 after, the earlier line, the line 0198 puts in its place)
REPLACED = {
    "quote_film": ("0192_adult_attestation.sql", "00846d0622ab379810c633b2446436b0", "99d01240ed2df7fb002f674df8891608",
                   "  on_ := public.film_studio_on();\n", "  on_ := public.film_studio_on_for(org);\n"),
    "start_film": ("0192_adult_attestation.sql", "595e90f836f992699cf9e920ad646787", "7971355d754165affaf3e08904b4b078",
                   "  if not public.film_studio_on() then\n", "  if not public.film_studio_on_for(org) then\n"),
    "film_claim_segment": ("0171_films_money.sql", "fddd014f8cbcb72603da0b792cc0d31a", "41debe4563fc9f8b58dd6d3082ad7e24",
                           "", "    if not public.film_studio_on_for(c.org_id) then\n      continue;\n    end if;\n"),
    "film_limits": ("0166_films_core.sql", "9ddbb45ad45efa76265b4f1b22c048bb", "dd9419b91f777a78d0d2b28539b2fb8a",
                    "'target_seconds_min', 60,", "'target_seconds_min', 10,"),
}
NEW = {
    "film_studio_on_for": "e5397c4d359a3113825272463fe93c06",
    "set_org_film_studio_enabled": "7b56b06164a91b5651172470088e867a",
    "film_take_inputs": "c8dc8dfa8b68639a5fd00be52b235ee9",
    "film_take_job": "8f3c00302f86b7bf435088951cc04979",
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


def latest(name: str, before: str = "0198") -> tuple[str, str]:
    out = None
    for p in sorted(MIG.glob("*.sql")):
        if p.name[:4] >= before:
            continue
        text = p.read_text(encoding="utf-8")
        if re.search(rf"create or replace function public\.{re.escape(name)}\(", text):
            out = (p.name, definition(text, name))
    assert out, name
    return out


def undo_hunk(defn: str, earlier_line: str, new_line: str) -> str:
    """The 0198 hunk taken out: its marked comment lines, and its new line(s) back to the earlier line."""
    lines = defn.splitlines(keepends=True)
    kept, i = [], 0
    while i < len(lines):
        if lines[i].lstrip().startswith("-- 0198:"):
            i += 1
            while i < len(lines) and lines[i].lstrip().startswith("--"):
                i += 1
            continue
        kept.append(lines[i])
        i += 1
    out = "".join(kept)
    assert out.count(new_line) == 1, new_line
    return out.replace(new_line, earlier_line)


class Migration0198(unittest.TestCase):
    def test_the_earlier_body_is_the_latest_one_before_0198(self):
        for name, (src, *_rest) in REPLACED.items():
            self.assertEqual(latest(name)[0], src, name)

    def test_the_md5_pins_describe_the_bodies(self):
        for name, (_src, was, now, _a, _b) in REPLACED.items():
            self.assertEqual(pg_md5(latest(name)[1]), was, name)
            self.assertEqual(pg_md5(definition(M0198, name)), now, name)
            self.assertIn(f"'{was}', '{now}'", M0198, name)
        for name, want in NEW.items():
            self.assertEqual(pg_md5(definition(M0198, name)), want, name)
            self.assertIn(f"'{want}'", M0198, name)

    def test_each_replaced_body_is_the_earlier_one_byte_for_byte_once_its_hunk_is_undone(self):
        for name, (_src, _was, _now, earlier_line, new_line) in REPLACED.items():
            new = definition(M0198, name)
            self.assertEqual(new.count("-- 0198:"), 1, name)
            self.assertEqual(undo_hunk(new, earlier_line, new_line), latest(name)[1], name)

    def test_the_switch_is_off_by_default_and_this_file_never_turns_the_platform_on(self):
        self.assertIn("add column if not exists film_studio_enabled boolean not null default false", M0198)
        body = code(M0198)
        self.assertNotRegex(body, r"(update|insert into)\s+public\.film_studio_settings")
        self.assertNotIn("set_film_studio_enabled(true)", body)
        on_for = code(definition(M0198, "film_studio_on_for"))
        self.assertIn("public.film_studio_on()", on_for)
        self.assertIn("coalesce((select s.film_studio_enabled from public.org_film_settings s where s.org_id = p_org), false)", on_for)

    def test_the_start_refuses_by_the_existing_word_before_anything_is_counted(self):
        body = code(definition(M0198, "start_film"))
        gate = body.index("if not public.film_studio_on_for(org) then")
        self.assertIn("creative_refuse('film_studio_disabled'", body[gate:gate + 200])
        for later in ("film_take_rate('start'", "reserve_credits(org, ref, total)", "insert into public.film_segments"):
            self.assertLess(gate, body.index(later), later)

    def test_the_claim_skips_before_it_locks_or_starts_a_hold(self):
        body = code(definition(M0198, "film_claim_segment"))
        skip = body.index("if not public.film_studio_on_for(c.org_id) then")
        self.assertLess(skip, body.index("for no key update skip locked"))
        self.assertLess(skip, body.index("start_credit_reservation(s.credit_ref, s.org_id)"))

    def test_the_setter_is_owner_guarded_audited_and_only_for_signed_in_callers(self):
        body = code(definition(M0198, "set_org_film_studio_enabled"))
        self.assertIn("public.owner_guard('film_studio_org', 10)", body)
        self.assertIn("public.security_event_log('film_studio.org_enabled', 'notice', p_org::text", body)
        self.assertIn("grant execute on function public.set_org_film_studio_enabled(uuid, boolean) to authenticated;", M0198)
        self.assertNotRegex(M0198, r"grant execute on function public\.set_org_film_studio_enabled\(uuid, boolean\) to [^;]*(anon|service_role)")

    def test_the_take_job_is_the_films_holds_nothing_and_is_never_queued(self):
        body = code(definition(M0198, "film_take_job"))
        self.assertIn("public.film_lock_take(p_take, p_worker)", body)
        insert = body[body.index("insert into public.creative_jobs"):body.index("returning * into j")]
        for part in ("'film', t.id", "'running', w", ", 0,\n", "s.created_by", "'exact', t.model"):
            self.assertIn(part, insert, part)
        self.assertNotIn("credit_ref", insert)
        self.assertNotIn("'queued'", insert)
        for fn in ("film_take_job(uuid, text)", "film_studio_on_for(uuid)"):
            self.assertIn(f"grant execute on function public.{fn} to service_role;", M0198)
            self.assertNotRegex(M0198, rf"grant execute on function public\.{re.escape(fn)} to [^;]*(anon|authenticated)")
        self.assertNotIn("grant execute on function public.film_take_inputs", M0198)

    def test_a_film_may_target_ten_seconds_and_nothing_else_of_the_limits_moves(self):
        def limits(defn: str) -> dict:
            return {k: int(v) for k, v in re.findall(r"'([a-z_]+)',\s*(\d+)", defn)}
        old, new = limits(latest("film_limits")[1]), limits(definition(M0198, "film_limits"))
        self.assertEqual(old["target_seconds_min"], 60)
        self.assertEqual(new["target_seconds_min"], 10)
        self.assertEqual({k: v for k, v in new.items() if k != "target_seconds_min"},
                         {k: v for k, v in old.items() if k != "target_seconds_min"})
        # A 15 s advert of two scenes fits every rule: 3-30 s a scene, the film's 10-1200 s.
        self.assertTrue(new["scene_seconds_min"] <= 7 and 8 <= new["scene_seconds_max"] and new["target_seconds_min"] <= 15)
        # The table check repeats the number, and is replaced only when it is 0166's (60) or this file's (10).
        self.assertIn("and target_seconds between 10 and 1200", M0198)
        self.assertIn("d not like '%target_seconds >= 60)%' and d not like '%target_seconds >= 10)%'", M0198)
        self.assertIn("and target_seconds between 60 and 1200", ROLLBACK)
        self.assertIn("film(s) target less than 60 s", ROLLBACK)

    def test_the_rollback_puts_the_earlier_bodies_back_verbatim(self):
        for name, (_src, was, now, _a, _b) in REPLACED.items():
            self.assertEqual(definition(ROLLBACK, name), latest(name)[1], name)
            self.assertIn(f"'{now}'", ROLLBACK, name)
            self.assertIn(f"'{was}'", ROLLBACK, name)
        for name in NEW:
            self.assertRegex(ROLLBACK, rf"drop function if exists public\.{name}\(")
        self.assertNotIn("drop column", ROLLBACK)

    def test_the_file_is_one_transaction_with_a_guard_an_end_state_and_a_verify_block(self):
        self.assertTrue(M0198.lstrip().startswith("-- 0198_film_studio_org_switch.sql"))
        self.assertIn("set local lock_timeout = '5s';", M0198)
        self.assertIn("0198 end state:", M0198)
        self.assertIn("-- Verify (read-only", M0198)

    def test_the_migration_is_listed(self):
        self.assertIn("0198_film_studio_org_switch.sql", MIGRATIONS_DOC)


if __name__ == "__main__":
    unittest.main()

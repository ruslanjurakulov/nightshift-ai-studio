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

# name -> (the file it was built on, md5 before, md5 after, [(the earlier code, the code 0198 puts in its place), ...] per hunk)
REPLACED = {
    "quote_film": ("0192_adult_attestation.sql", "00846d0622ab379810c633b2446436b0", "99d01240ed2df7fb002f674df8891608",
                   [("  on_ := public.film_studio_on();\n", "  on_ := public.film_studio_on_for(org);\n")]),
    "start_film": ("0192_adult_attestation.sql", "595e90f836f992699cf9e920ad646787", "7971355d754165affaf3e08904b4b078",
                   [("  if not public.film_studio_on() then\n", "  if not public.film_studio_on_for(org) then\n")]),
    "film_claim_segment": ("0171_films_money.sql", "fddd014f8cbcb72603da0b792cc0d31a", "40db385bb4e3893e1085ee38dcd6f49b", [
        ("", "    if not public.film_studio_on_for(c.org_id)\n"
             "       and exists (select 1 from public.film_segments x where x.id = c.id and x.status = 'queued') then\n"
             "      continue;\n    end if;\n"),
        ("", "      update public.creative_jobs\n         set worker_id = w, heartbeat_at = now(), updated_at = now()\n"
             "       where film_take_id in (select t.id from public.film_takes t where t.segment_id = s.id and t.status = 'running')\n"
             "         and status in ('running', 'provider_pending', 'processing', 'rendering');\n")]),
    "film_limits": ("0166_films_core.sql", "9ddbb45ad45efa76265b4f1b22c048bb", "dd9419b91f777a78d0d2b28539b2fb8a",
                    [("'target_seconds_min', 60,", "'target_seconds_min', 10,")]),
    "claim_creative_job": ("0036_creative_jobs.sql", "37d708494c1cf39578b0988d58e7f932", "3ca4da96aabe145b34a0275ed4d1c841",
                           [("", "       and payer <> 'film'\n"), ("", "       and payer <> 'film'\n"), ("", "     and q.payer <> 'film'\n")]),
    "cancel_creative_job": ("0036_creative_jobs.sql", "3d7c99b7d355194102fb5982747ccad5", "2720d62c17ae26bce439a28280964575",
                            [("  if not found or not public.is_org_member(j.org_id) then\n",
                              "  if not found or not public.is_org_member(j.org_id) or j.payer = 'film' then\n")]),
    "film_fail_locked": ("0171_films_money.sql", "5c479bb1bff1c0e6218ef9424ddeca49", "0676b7e0f3e3549348044a8915a246cc",
                         [("", "  if t.creative_job_id is not null then\n    perform public.creative_end_locked(t.creative_job_id, 'failed', "
                               "coalesce(p_code, 'provider_error'), coalesce(p_error, p_code));\n  end if;\n")]),
    "film_begin_take": ("0171_films_money.sql", "3f949fee189a8ef37ef776e5a30ec182", "ab9ec7bc2c1e94bfa4835bea2e9f5be4",
                        [("", "  if not public.film_studio_on_for(t.org_id) then\n    perform public.creative_refuse('film_studio_disabled', "
                              "'Film Studio is switched off: no new take begins', 'NS409');\n  end if;\n")]),
    "film_settle_locked": ("0171_films_money.sql", "19938f367460c80103dc97eb7f1fee35", "7caa68e2b6698c81e34c4f965950adf9",
                           [("", "  perform public.creative_end_locked(j.id, 'failed', 'segment_settled', 'the film''s segment was settled')\n"
                                 "     from public.creative_jobs j\n"
                                 "    where j.film_take_id in (select x.id from public.film_takes x where x.segment_id = s.id)\n"
                                 "      and j.status in ('queued', 'running', 'provider_pending', 'processing', 'rendering');\n")]),
}
NEW = {
    "film_studio_on_for": "e5397c4d359a3113825272463fe93c06",
    "set_org_film_studio_enabled": "7b56b06164a91b5651172470088e867a",
    "film_take_inputs": "c8dc8dfa8b68639a5fd00be52b235ee9",
    "film_take_job": "8a28484a7992a4aa2195d78878f3b399",
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


def undo_hunks(defn: str, pairs) -> str:
    """Every 0198 hunk taken out: its marked comment lines (a block that starts with "-- 0198:"), a trailing "-- 0198:" comment, and
    its new code back to the earlier code, one hunk at a time."""
    lines = defn.splitlines(keepends=True)
    kept, i = [], 0
    while i < len(lines):
        if lines[i].lstrip().startswith("-- 0198:"):
            i += 1
            while i < len(lines) and lines[i].lstrip().startswith("--"):
                i += 1
            continue
        kept.append(re.sub(r"\s+-- 0198:[^\n]*", "", lines[i]))
        i += 1
    out = "".join(kept)
    for earlier, new in pairs:
        assert new in out, new
        out = out.replace(new, earlier, 1)
    return out


class Migration0198(unittest.TestCase):
    def test_the_earlier_body_is_the_latest_one_before_0198(self):
        for name, (src, *_rest) in REPLACED.items():
            self.assertEqual(latest(name)[0], src, name)

    def test_the_md5_pins_describe_the_bodies(self):
        for name, (_src, was, now, _pairs) in REPLACED.items():
            self.assertEqual(pg_md5(latest(name)[1]), was, name)
            self.assertEqual(pg_md5(definition(M0198, name)), now, name)
            self.assertIn(f"'{was}', '{now}'", M0198, name)
        for name, want in NEW.items():
            self.assertEqual(pg_md5(definition(M0198, name)), want, name)
            self.assertIn(f"'{want}'", M0198, name)

    def test_each_replaced_body_is_the_earlier_one_byte_for_byte_once_its_hunk_is_undone(self):
        for name, (_src, _was, _now, pairs) in REPLACED.items():
            new = definition(M0198, name)
            self.assertGreaterEqual(new.count("-- 0198:"), 1, name)
            self.assertEqual(undo_hunks(new, pairs), latest(name)[1], name)

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

    def test_the_claim_skips_a_queued_segment_of_an_off_org_before_it_locks_or_starts_a_hold(self):
        body = code(definition(M0198, "film_claim_segment"))
        skip = body.index("if not public.film_studio_on_for(c.org_id)")
        self.assertIn("x.status = 'queued') then", body[skip:skip + 200])
        self.assertLess(skip, body.index("for no key update skip locked"))
        self.assertLess(skip, body.index("start_credit_reservation(s.credit_ref, s.org_id)"))

    def test_the_lease_takes_the_live_take_jobs_with_it_right_after_it_changes_hands(self):
        body = code(definition(M0198, "film_claim_segment"))
        lease = body.index("set worker_id = w, heartbeat_at = now(), attempts = attempts + 1")
        move = body.index("update public.creative_jobs")
        self.assertLess(lease, move)
        self.assertLess(move, body.index("'segment_claimed'"))

    def test_the_credit_queue_never_sweeps_nor_picks_a_film_job(self):
        body = code(definition(M0198, "claim_creative_job"))
        self.assertEqual(body.count("payer <> 'film'"), 3)  # the scan, the re-select under the lock, the queued pick
        self.assertLess(body.index("and q.payer <> 'film'"), body.index("for update skip locked\n   limit 1"))
        self.assertIn("or j.payer = 'film' then", code(definition(M0198, "cancel_creative_job")))

    def test_ending_a_take_ends_its_job_and_nothing_new_begins_while_off(self):
        fail = code(definition(M0198, "film_fail_locked"))
        self.assertLess(fail.index("public.creative_end_locked(t.creative_job_id, 'failed'"), fail.index("film_discard_assets"))
        begin = code(definition(M0198, "film_begin_take"))
        self.assertLess(begin.index("creative_refuse('film_studio_disabled'"), begin.index("set status = 'running'"))
        job = code(definition(M0198, "film_take_job"))
        self.assertEqual(job.count("creative_refuse('film_studio_disabled'"), 2)  # a new job, and a replay never sent
        self.assertIn("j.submit_started_at is null and j.provider_task_id is null and not public.film_studio_on_for(t.org_id)", job)
        self.assertIn("'provider_pending', 'processing', 'rendering')", job)
        self.assertIn("public.voice_usable_by(s.created_by, t.params ->> 'voice_id', t.org_id, f.channel_id, 'use')", job)
        self.assertIn("and new.payer <> 'film')", M0198)
        self.assertIn("when (new.status in ('completed', 'failed', 'expired') and old.status is distinct from new.status)\n", ROLLBACK)

    def test_the_replay_note_says_a_0036_rerun_reverts_silently(self):
        self.assertIn("Re-running 0036 after it\n--   SILENTLY puts the old claim_creative_job", M0198)

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

    def test_film_studio_on_for_keeps_the_shape_the_assembly_session_calls(self):
        """S11's assembly (PR #845) calls it over PostgREST with the service key: name, the one uuid parameter p_org, boolean,
        STABLE, executable by service_role only. Changing any of these breaks that caller."""
        defn = definition(M0198, "film_studio_on_for")
        head = defn.split("as $$", 1)[0]
        self.assertTrue(head.startswith("create or replace function public.film_studio_on_for(p_org uuid) returns boolean\n"), head)
        self.assertRegex(head, r"\blanguage sql stable security definer set search_path = public, pg_temp\b")
        self.assertIn("revoke all on function public.film_studio_on_for(uuid) from public, anon, authenticated, service_role;", M0198)
        self.assertIn("grant execute on function public.film_studio_on_for(uuid) to service_role;", M0198)
        self.assertEqual(len(re.findall(r"grant execute on function public\.film_studio_on_for\(", M0198)), 1)
        self.assertIn("or has_function_privilege('authenticated', 'public.film_studio_on_for(uuid)', 'execute')", M0198)

    def test_the_rollback_puts_the_earlier_bodies_back_verbatim(self):
        for name, (_src, was, now, _pairs) in REPLACED.items():
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

"""supabase/migrations/0145_made_for_kids.sql, read as text (the security lab runs it: tests/security/test_sec_made_for_kids.py).

What would break without these:
  * a replaced body that is not its predecessor plus the marked lines (a silent change riding along);
  * a drift-guard or end-state hash that is not the md5 of the body it names (the file would refuse a correct database, or let a
    wrong one through);
  * the rollback restoring anything but the predecessors byte for byte, or dropping the record of who confirmed what;
  * the run's made_for_kids accepted as anything but true, on a repair, or not at all by the browser's insert policy;
  * the person's function callable by anon or the service key, or without the approver's rule and the confirmation.
"""

import hashlib
import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MIG = ROOT / "supabase" / "migrations"
TEXT = (MIG / "0145_made_for_kids.sql").read_text(encoding="utf-8")
ROLLBACK = (ROOT / "docs" / "sql" / "rollback_0145_made_for_kids.sql").read_text(encoding="utf-8")
M0122 = (MIG / "0122_series_template_carrier.sql").read_text(encoding="utf-8")
M0117 = (MIG / "0117_voice_profiles.sql").read_text(encoding="utf-8")
M0076 = (MIG / "0076_scene_regenerate.sql").read_text(encoding="utf-8")
M0116 = (MIG / "0116_visibility_requests.sql").read_text(encoding="utf-8")

RJPV = "create or replace function public.render_job_params_valid("
AUD = "create or replace function public.audit_action_allowed("
SET = "create or replace function public.set_video_made_for_kids("
APV = "create or replace function public.approve_video_publish("
POLICY = "create policy render_jobs_insert on public.render_jobs"


def code(sql: str) -> str:
    return "\n".join(line.split("--", 1)[0] for line in sql.splitlines())


def body(sql: str, start: str) -> str:
    i = sql.index(start)
    a = sql.index("$$", i) + 2
    return sql[a:sql.index("$$", a)]


def policy(sql: str) -> str:
    i = sql.index(POLICY)
    return sql[i:sql.index(");", i) + 2]


def h(b: str) -> str:
    return hashlib.md5(re.sub(r"\s+", " ", b).encode()).hexdigest()


def added_lines(old: str, new: str):
    o, n = old.splitlines(), new.splitlines()
    out, i = [], 0
    for line in n:
        if i < len(o) and line == o[i]:
            i += 1
        else:
            out.append(line)
    assert i == len(o), f"line {i + 1} of the old body was changed or removed: {o[i]!r}"
    return out


def migrations_before(number: str):
    return sorted(p for p in MIG.glob("*.sql") if p.name[:4] < number)


class WhatItReplaces(unittest.TestCase):
    def test_the_old_bodies_are_the_latest_definitions_before_it(self):
        for fn, want in (("render_job_params_valid", "0122_series_template_carrier.sql"), ("audit_action_allowed", "0117_voice_profiles.sql"),
                         ("approve_video_publish", "0116_visibility_requests.sql")):
            defs = [p.name for p in migrations_before("0145") if re.search(rf"create or replace function public\.{fn}\(", p.read_text(encoding="utf-8"))]
            self.assertEqual(defs[-1], want, fn)
        pols = [p.name for p in migrations_before("0145") if POLICY in p.read_text(encoding="utf-8")]
        self.assertEqual(pols[-1], "0076_scene_regenerate.sql")

    def test_the_params_validator_is_0122s_plus_the_marked_block_and_one_key(self):
        old, new = body(M0122, RJPV), body(TEXT, RJPV)
        self.assertEqual(old.replace("'publish_hint','series','template'];", "'publish_hint','series','template','made_for_kids'];"),
                         re.sub(r"  -- 0145:.*?\n  end if;\n", "", new, flags=re.S), "only the allowed list and the 0145 block differ")
        block = "\n".join(added_lines(old.replace("'template'];", "'template','made_for_kids'];"), new))
        self.assertIn("p ? 'made_for_kids' and (p -> 'made_for_kids' is distinct from 'true'::jsonb or p_kind = 'repair')", block)

    def test_the_audit_list_is_0117s_plus_one_action(self):
        added = added_lines(body(M0117, AUD), body(TEXT, AUD))
        self.assertEqual([ln.strip() for ln in added if not ln.strip().startswith("--")], ["'video.made_for_kids',"])

    def test_approving_is_0116s_body_plus_the_audience_block_and_nothing_else(self):
        added = [ln.strip() for ln in added_lines(body(M0116, APV), body(TEXT, APV)) if not ln.strip().startswith("--")]
        self.assertEqual(added, ["if v.made_for_kids_answered_by is null or v.made_for_kids_answered_cut_sha256 is distinct from p_cut_sha256 then",
                                 "return jsonb_build_object('ok', false, 'error', 'audience_unanswered');", "end if;"])
        # after the row is locked and the refusals are asked, before anything is written
        b = body(TEXT, APV)
        self.assertLess(b.index("for update"), b.index("audience_unanswered"))
        self.assertLess(b.index("video_approve_refusal"), b.index("audience_unanswered"))
        self.assertLess(b.index("audience_unanswered"), b.index("update public.videos"))

    def test_the_insert_policy_is_0076s_plus_one_key(self):
        self.assertEqual(policy(M0076).replace("'publish_hint']", "'publish_hint','made_for_kids']"), policy(TEXT))

    def test_the_hashes_in_the_file_are_the_md5_of_the_bodies_they_name(self):
        header = TEXT.split("set local lock_timeout", 1)[0]
        pins = {"render_job_params_valid": (h(body(M0122, RJPV)), h(body(TEXT, RJPV))),
                "audit_action_allowed": (h(body(M0117, AUD)), h(body(TEXT, AUD))),
                "approve_video_publish": (h(body(M0116, APV)), h(body(TEXT, APV)))}
        for fn, (old, new) in pins.items():
            self.assertRegex(header, rf"--     {fn}\s+{old}\n", fn)
            self.assertRegex(header, rf"--     {fn}\s+{new}\n", fn)
            guard = code(TEXT)
            self.assertIn(f"array['{old}', '{new}']", guard, fn)
        self.assertRegex(header, rf"--     set_video_made_for_kids\s+{h(body(TEXT, SET))}\n")
        end = TEXT[TEXT.index("6. The end state"):]
        for b in (body(TEXT, RJPV), body(TEXT, AUD), body(TEXT, SET), body(TEXT, APV)):
            self.assertIn(h(b), end)

    def test_the_sec_db_helper_pins_the_same_predecessors(self):
        lab = (ROOT / "tests" / "security" / "sec_db.py").read_text(encoding="utf-8")
        self.assertIn(f'"public.render_job_params_valid(jsonb, text)": "{h(body(M0122, RJPV))}"', lab)
        self.assertIn(f'"public.audit_action_allowed(text)": "{h(body(M0117, AUD))}"', lab)
        self.assertIn(f'"public.approve_video_publish(text, text, jsonb)": "{h(body(M0116, APV))}"', lab)


class ThePersonsFunction(unittest.TestCase):
    FN = body(TEXT, SET)

    def test_it_asks_the_approvers_rule_and_holds_the_confirmation(self):
        for needle in ("public.video_approve_access(p_video_id)", "take_web_rate('video_made_for_kids', 20, 600)",
                       "for update", "'confirm_required'", "'already_public'", "'approval_live'",
                       "p_confirm_off is distinct from true", "'video.made_for_kids'"):
            self.assertIn(needle, self.FN, needle)

    def test_the_answer_is_bound_to_the_cut_the_person_watched(self):
        self.assertIn("p_confirm_off boolean,\n                                                          p_cut_sha256 text)", TEXT)
        for needle in ("'cut_changed'", "'cut_unknown'", "'bad_hash'",
                       "made_for_kids_answered_cut_sha256 = p_cut_sha256",
                       "v.made_for_kids_answered_cut_sha256 is not distinct from p_cut_sha256"):
            self.assertIn(needle, self.FN, needle)
        self.assertLess(self.FN.index("'cut_changed'"), self.FN.index("update public.videos"))
        self.assertIn("(made_for_kids_answered_by is null) = (made_for_kids_answered_cut_sha256 is null)", TEXT)

    def test_every_call_is_an_answer_recorded_with_who_and_when(self):
        self.assertIn("made_for_kids_answered_by = uid,", self.FN)
        self.assertIn("made_for_kids_answered_at = now()", self.FN)
        # the pipeline's own value is not an answer: agreeing with it writes
        self.assertIn("if v.made_for_kids_answered_by is not null and v.made_for_kids_answered_cut_sha256 is not distinct from p_cut_sha256\n"
                      "     and v.made_for_kids is not distinct from p_made_for_kids", self.FN)
        self.assertIn("(made_for_kids_answered_by is null) = (made_for_kids_answered_at is null)", TEXT)
        self.assertIn("(made_for_kids_answered_by is null or made_for_kids is not null)", TEXT)

    def test_only_signed_in_users_may_call_it(self):
        c = code(TEXT)
        self.assertIn("revoke all on function public.set_video_made_for_kids(text, boolean, boolean, text) from public, anon, authenticated, service_role;", c)
        self.assertIn("grant execute on function public.set_video_made_for_kids(text, boolean, boolean, text) to authenticated;", c)
        # the three-argument form (never applied) is dropped, and the end state asserts it is gone
        self.assertIn("drop function if exists public.set_video_made_for_kids(text, boolean, boolean);", c)
        self.assertIn("the three-argument set_video_made_for_kids() is still there", TEXT)
        self.assertNotRegex(c, r"grant execute on function public\.set_video_made_for_kids\([^)]*\) to [^;]*(anon|service_role)")
        self.assertIn("security definer set search_path = public, pg_temp", TEXT[TEXT.index(SET):])

    def test_the_column_check_holds_every_writer_to_the_rule(self):
        self.assertIn("(made_for_kids_off_by is null) = (not coalesce(kids_content is true and made_for_kids is false, false))", TEXT)
        self.assertIn("(made_for_kids_off_by is null) = (made_for_kids_off_at is null)", TEXT)


class WhatTheRollbackDoes(unittest.TestCase):
    def test_it_restores_the_predecessors_byte_for_byte_and_guards_on_0145s(self):
        self.assertEqual(body(ROLLBACK, RJPV), body(M0122, RJPV))
        self.assertEqual(body(ROLLBACK, AUD), body(M0117, AUD))
        self.assertEqual(body(ROLLBACK, APV), body(M0116, APV))
        self.assertIn(h(body(TEXT, APV)), ROLLBACK)
        self.assertEqual(policy(ROLLBACK), policy(M0076))
        self.assertIn(h(body(TEXT, RJPV)), ROLLBACK)
        self.assertIn(h(body(TEXT, AUD)), ROLLBACK)
        self.assertIn("drop function if exists public.set_video_made_for_kids(text, boolean, boolean, text);", ROLLBACK)

    def test_it_keeps_the_record(self):
        c = code(ROLLBACK)
        self.assertNotIn("drop column", c)
        self.assertNotIn("videos_made_for_kids_confirmed_check", c)
        self.assertRegex(ROLLBACK, r"(?m)^begin;$")
        self.assertRegex(ROLLBACK, r"(?m)^commit;$")


class TheNumber(unittest.TestCase):
    def test_it_is_the_only_0145(self):
        self.assertEqual([p.name for p in MIG.glob("0145_*.sql")], ["0145_made_for_kids.sql"])


if __name__ == "__main__":
    unittest.main()

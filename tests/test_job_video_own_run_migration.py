"""Migration 0207 (BR-LIVE-05: a job's video id names the job's own long video), pinned as text.

What would break: the job answer naming the run's Short, a repurpose clip, a repaired cut or an earlier run of the same slug (one
of the four conditions dropped); the drift guard pinned to an md5 that no real 0189 body has (the migration would refuse to apply
in production), or to none (a hand-edited live body silently overwritten); the rollback not putting 0189's body back verbatim;
the function's signature, security or search_path drifting from 0189's. The lab (tests/security/test_sec_job_video_0207.py) runs
the file against Postgres; it is CI-only on a box without one.
"""

from __future__ import annotations

import hashlib
import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MIG = ROOT / "supabase" / "migrations"
M0189 = (MIG / "0189_job_video_and_list_order.sql").read_text(encoding="utf-8")
M = (MIG / "0207_render_job_video_id_own_run.sql").read_text(encoding="utf-8")
RB = (ROOT / "docs" / "sql" / "rollback_0207_render_job_video_id_own_run.sql").read_text(encoding="utf-8")
NAME = "render_job_video_id"


def definition(text: str, name: str = NAME) -> str:
    m = re.search(rf"^create or replace function public\.{re.escape(name)}\(.*?^\$\$;$", text, re.S | re.M)
    assert m, name
    return m.group(0)


def body_md5(text: str) -> str:
    """What the guards compute in Postgres: md5(regexp_replace(prosrc, '\\s+', ' ', 'g')), where prosrc of a $$-quoted body is the
    text between the two $$ exactly (leading and trailing newlines included, each collapsed to one space)."""
    m = re.search(r"as \$\$(.*?)\$\$;$", definition(text), re.S | re.M)
    assert m
    return hashlib.md5(re.sub(r"\s+", " ", m.group(1)).encode("utf-8")).hexdigest()


def header(text: str) -> str:
    return definition(text).split("$$", 1)[0]


def where(text: str) -> str:
    """The body with its whitespace collapsed, so a condition is found however the lines wrap."""
    return re.sub(r"\s+", " ", definition(text))


class Migration0207(unittest.TestCase):
    def test_the_job_answers_only_its_own_long_video(self):
        w = where(M)
        for cond in (
            "j.result_slug is not null and v.channel_id = j.channel_id and v.slug = j.result_slug",   # 0189's own filter, kept
            "v.video_format = 'long' and v.parent_video_id is null",                                   # not the Short / a clip
            "v.publish_state is distinct from 'repaired_awaiting_review'",                             # not a repaired cut
            "j.started_at is not null and j.finished_at is not null",                                  # no end: unknown, NULL
            "v.held_at between j.started_at and j.finished_at + interval '2 minutes'",                 # the run's window
            "public.video_listed_at(v.published_at, null) between j.started_at and j.finished_at + interval '2 minutes'",
        ):
            self.assertIn(cond, w)

    def test_signature_security_search_path_and_grants_match_0189(self):
        self.assertEqual(header(M), header(M0189))
        revoke = "revoke all on function public.render_job_video_id(public.render_jobs) from public, anon, authenticated, service_role;"
        self.assertIn(revoke, M0189)
        self.assertIn(revoke, M)
        self.assertIn(revoke, RB)
        self.assertNotRegex(M + RB, r"(?i)\bgrant\b")
        # Nothing else is redefined: api_get_job / oauth_get_job keep 0189's bodies and call this function.
        self.assertEqual(re.findall(r"(?m)^create or replace function public\.(\w+)\(", M), [NAME])

    def test_the_drift_guard_knows_0189s_body_and_this_ones(self):
        was, now = body_md5(M0189), body_md5(M)
        self.assertEqual(was, "09646e55258e153d277f40e7bf03f1c3")   # also 0189's own stated value (its guard and its header)
        self.assertIn(was, M0189)
        guard = M.split("create or replace function", 1)[0]
        self.assertIn(f"h is null or h <> all (array['{was}', '{now}'])", guard)
        self.assertIn("raise exception '0207 found public.render_job_video_id", guard)
        self.assertIn(f"AFTER {now}", M)
        self.assertIn(f"= '{now}' as own_run", M)

    def test_the_rollback_is_guarded_and_puts_0189s_body_back_verbatim(self):
        self.assertIn(f"if h is distinct from '{body_md5(M)}' then", RB)
        self.assertEqual(definition(RB), definition(M0189))
        self.assertRegex(RB, r"(?m)^begin;$")
        self.assertRegex(RB, r"(?m)^commit;$")


if __name__ == "__main__":
    unittest.main()

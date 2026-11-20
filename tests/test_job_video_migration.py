"""Migration 0189 (get_job_status names the video; list_videos newest first), pinned as text.

What would break: a replaced body drifting from 0042's / 0111's (a job or video answer silently changed), the job answer guessing a
video when nothing was recorded, the slug written by anyone but the worker, the worker recording a slug for a failed run, or a
rollback that does not put the earlier bodies back verbatim. The lab (tests/security/test_sec_job_video_0189.py) runs the file.
"""

from __future__ import annotations

import difflib
import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MIG = ROOT / "supabase" / "migrations"
M = (MIG / "0189_job_video_and_list_order.sql").read_text(encoding="utf-8")
RB = (ROOT / "docs" / "sql" / "rollback_0189_job_video_and_list_order.sql").read_text(encoding="utf-8")
WORKER = (ROOT / "tools" / "queue_worker.py").read_text(encoding="utf-8")
BUILT_ON = {"api_list_videos": "0042_web_api_hardening.sql", "api_get_job": "0111_video_safety.sql",
            "oauth_get_job": "0111_video_safety.sql"}


def definition(text: str, name: str) -> str:
    m = re.search(rf"^create or replace function public\.{re.escape(name)}\(.*?^\$\$;$", text, re.S | re.M)
    assert m, name
    return m.group(0)


def latest(name: str) -> tuple[str, str]:
    out = None
    for p in sorted(MIG.glob("*.sql")):
        if p.name[:4] >= "0189":
            continue
        t = p.read_text(encoding="utf-8")
        if re.search(rf"create or replace function public\.{re.escape(name)}\(", t):
            out = (p.name, definition(t, name))
    assert out
    return out


class Migration0189(unittest.TestCase):
    def test_built_on_the_latest_bodies(self):
        for name, src in BUILT_ON.items():
            self.assertEqual(latest(name)[0], src, name)

    def test_the_job_answers_only_add_video_id(self):
        for name in ("api_get_job", "oauth_get_job"):
            old, new = latest(name)[1].splitlines(), definition(M, name).splitlines()
            ops = [o for o in difflib.SequenceMatcher(a=old, b=new, autojunk=False).get_opcodes() if o[0] != "equal"]
            self.assertEqual([o[0] for o in ops], ["insert"], name)
            self.assertIn("'video_id', public.render_job_video_id(j),", "\n".join(new[ops[0][3]:ops[0][4]]))

    def test_no_slug_means_no_video(self):
        body = definition(M, "render_job_video_id")
        self.assertIn("j.result_slug is not null and v.channel_id = j.channel_id and v.slug = j.result_slug", body)

    def test_only_the_worker_writes_the_slug_and_only_once(self):
        guard = definition(M, "render_jobs_result_slug_guard")
        self.assertIn("tg_op = 'INSERT' and new.result_slug is not null", guard)
        self.assertIn("old.result_slug is not null and new.result_slug is distinct from old.result_slug", guard)
        # The worker records it only on the success path, before the job ends.
        i = WORKER.index("if on_success is not None:")
        self.assertLess(i, WORKER.index('return end("succeeded", None, charge=True)', i))

    def test_the_rollback_puts_the_earlier_bodies_back_verbatim(self):
        for name in BUILT_ON:
            self.assertEqual(definition(RB, name), latest(name)[1], name)


if __name__ == "__main__":
    unittest.main()

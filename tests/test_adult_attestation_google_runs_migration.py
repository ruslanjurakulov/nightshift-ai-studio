"""Migration 0196 (a video run on Google needs an adult answer), pinned as text.

What would break, and which test says so:

* a replaced body drifting from the one it was built on: each of the four is the earlier body plus inserted, marked 0196 blocks;
* the database and the Actions dispatch disagreeing about which runs use Google (two rules for one thing), or the pipeline gaining a
  text client or a Google footage provider that neither rule knows about;
* a sessionless writer (the scheduler, the dispatcher, the worker) being refused, or the minor rule weakened;
* the API / MCP video doors answering the Google rule as a 500 or after the hold;
* a failover handing a job to an adults-only model, or the router hiding that it skipped one;
* md5 pins that no longer describe the files, or a rollback that does not put the earlier bodies and 0192's run gate back.

The lab (tests/security/test_sec_adult_attestation_google_runs.py) runs the same file on a real PostgreSQL.
"""

from __future__ import annotations

import difflib
import hashlib
import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MIG = ROOT / "supabase" / "migrations"
M = (MIG / "0196_adult_attestation_google_runs.sql").read_text(encoding="utf-8")
ROLLBACK = (ROOT / "docs" / "sql" / "rollback_0196_adult_attestation_google_runs.sql").read_text(encoding="utf-8")
RUN_BACKEND = (ROOT / "command-center" / "lib" / "runBackend.ts").read_text(encoding="utf-8")
ROUTE = (ROOT / "command-center" / "app" / "api" / "agent" / "run" / "route.ts").read_text(encoding="utf-8")

# name -> (the file it was built on, md5 before, md5 after, how many 0196 blocks are inserted)
REPLACED = {
    "creative_route_quote": ("0075_model_router.sql", "1b88440452f8fa7df45be3187fadcbda", "a00bbb719f3ef0b4b7a89d5e24a9d80a", 1),
    "route_model": ("0192_adult_attestation.sql", "63ee303ce0f98a24fafa6bf934578f81", "102366cbcd31d2d81b1bb67b90a4ed4b", 1),
    "api_create_video": ("0192_adult_attestation.sql", "b8ca36fa1be8f7a4837f095a6d534631", "1e42321dd44b027750d0d76b12321811", 1),
    "oauth_create_video": ("0192_adult_attestation.sql", "0b1807540e03ba06c0d98695a451c147", "3775691c931eb209ed0b38c625a851a4", 1),
    "reroute_creative_job": ("0187_rights_acknowledgement_inputs.sql", "88ddf301ce242fafe8a8051d16ceab9e",
                             "4e43d78523acacf10799497afef0d39a", 1),
}
NEW = ["render_run_google_stages", "adult_attestation_run_gate"]


def definition(text: str, name: str) -> str:
    m = re.search(rf"^create or replace function public\.{re.escape(name)}\(.*?^\$\$;$", text, re.S | re.M)
    assert m, name
    return m.group(0)


def pg_md5(defn: str) -> str:
    body = defn.split("as $$", 1)[1].rsplit("$$;", 1)[0]
    return hashlib.md5(re.sub(r"[ \t\n\r\f\v]+", " ", body).encode()).hexdigest()


def code(sql: str) -> str:
    return "\n".join(line.split("--", 1)[0] for line in sql.splitlines())


def latest(name: str, before: str = "0196") -> str:
    out = None
    for p in sorted(MIG.glob("*.sql")):
        if p.name[:4] < before and re.search(rf"create or replace function public\.{re.escape(name)}\(", p.read_text(encoding="utf-8")):
            out = p.name
    return out


class BuiltOnTheEarlierBodies(unittest.TestCase):
    def test_each_replaced_body_is_the_earlier_one_plus_marked_inserts(self):
        for name, (src, _o, _n, blocks) in REPLACED.items():
            old = definition((MIG / src).read_text(encoding="utf-8"), name).splitlines()
            new = definition(M, name).splitlines()
            ops = [op for op in difflib.SequenceMatcher(a=old, b=new, autojunk=False).get_opcodes() if op[0] != "equal"]
            self.assertEqual([op[0] for op in ops], ["insert"] * blocks, name)
            for _t, _i1, _i2, j1, j2 in ops:
                self.assertIn("0196", "\n".join(new[j1:j2]), name)

    def test_the_earlier_body_is_the_latest_one_before_0196(self):
        for name, (src, *_r) in REPLACED.items():
            self.assertEqual(latest(name), src, name)

    def test_the_md5_pins_describe_the_bodies(self):
        for name, (src, old, new, _b) in REPLACED.items():
            self.assertEqual(pg_md5(definition((MIG / src).read_text(encoding="utf-8"), name)), old, name)
            self.assertEqual(pg_md5(definition(M, name)), new, name)
            self.assertGreaterEqual(M.count(new), 4, f"{name}: header, guard, end state, Verify")

    def test_it_defines_exactly_these_functions(self):
        self.assertEqual(sorted(re.findall(r"create or replace function public\.(\w+)\(", code(M))), sorted([*NEW, *REPLACED]))

    def test_the_rollback_puts_the_earlier_bodies_and_0192s_run_gate_back(self):
        for name, (src, old, new, _b) in REPLACED.items():
            self.assertEqual(definition(ROLLBACK, name), definition((MIG / src).read_text(encoding="utf-8"), name), name)
            self.assertIn(old, ROLLBACK)
            self.assertIn(new, ROLLBACK)
        self.assertIn("for each row execute function public.adult_attestation_refuse_minor();", ROLLBACK)
        self.assertIn("apply 0196 again first", ROLLBACK)
        self.assertTrue(ROLLBACK.rstrip().endswith("commit;"))


class OneRuleForWhichRunsUseGoogle(unittest.TestCase):
    def test_the_database_and_the_dispatch_name_the_same_google_providers(self):
        helper = definition(M, "render_run_google_stages")
        sql_video = set(re.findall(r"p ->> 'video_provider' = '([a-z0-9-]+)'", helper))
        sql_image = set(re.findall(r"p ->> 'image_provider' = '([a-z0-9-]+)'", helper))
        ts_video = set(re.findall(r'"([a-z0-9-]+)"', re.search(r"GOOGLE_VIDEO_PROVIDERS = \[([^\]]*)\]", RUN_BACKEND).group(1)))
        ts_image = set(re.findall(r'"([a-z0-9-]+)"', re.search(r"GOOGLE_IMAGE_PROVIDERS = \[([^\]]*)\]", RUN_BACKEND).group(1)))
        self.assertEqual(sql_video, ts_video)
        self.assertEqual(sql_image, ts_image)
        self.assertEqual(sql_video, {"veo"})
        self.assertEqual(sql_image, {"nano-banana"})
        # The kinds read the same way: text for a daily run and a series plan, a repair fails closed.
        self.assertIn("when 'daily', 'series_plan' then", helper)
        self.assertIn('kind === "daily" || kind === "series_plan" ? "text" : kind === "repair" ? "repair" : "unknown"', RUN_BACKEND)

    def test_the_pipelines_google_providers_are_exactly_these(self):
        vp = (ROOT / "modules" / "video_providers.py").read_text(encoding="utf-8")
        ip = (ROOT / "modules" / "image_providers.py").read_text(encoding="utf-8")
        self.assertIn('VEO = "veo"', vp)
        self.assertIn('"veo": _veo_config', vp)
        self.assertIn('"nano-banana": "GEMINI_API_KEY"', ip)
        # No other footage provider is configured against Google's endpoint.
        self.assertEqual(vp.count("generativelanguage.googleapis.com"), 1)
        self.assertEqual(ip.count("generativelanguage.googleapis.com"), 1)

    def test_the_text_stages_have_one_client_and_it_is_gemini(self):
        """Why 'text' is on every run: no channel or run field picks another text provider. A second text client would make that
        false, and both rules would have to read the field that picks it."""
        others = []
        for p in sorted((ROOT / "modules").glob("*.py")):
            src = p.read_text(encoding="utf-8")
            if re.search(r"^\s*(import|from)\s+(openai|anthropic|mistralai|cohere|groq)\b", src, re.M):
                others.append(p.name)
        self.assertEqual(others, [])
        channels = (ROOT / "modules" / "channels.py").read_text(encoding="utf-8")
        agent = channels.split("class AgentConfig", 1)[1].split("\nclass ", 1)[0]
        self.assertNotRegex(agent, r"\b(text|llm|script|research)_provider\b")
        self.assertIn('GEMINI_MODEL = (os.getenv("GEMINI_MODEL")', (ROOT / "config.py").read_text(encoding="utf-8"))


class TheGates(unittest.TestCase):
    def test_the_run_gate_keeps_the_minor_rule_and_passes_a_sessionless_writer(self):
        g = definition(M, "adult_attestation_run_gate")
        self.assertLess(g.index("if st = 'minor' then"), g.index("'adult_attestation_required'"))
        self.assertIn("if uid is not null and st <> 'adult' then", g)
        self.assertIn("for each row execute function public.adult_attestation_run_gate();", M)

    def test_the_video_doors_answer_a_typed_428_before_the_price_and_the_hold(self):
        for name, later in (("api_create_video", ("v_price := public.api_video_price(v_secs);", "insert into public.api_holds")),
                            ("oauth_create_video", ("v_price := ", "public.reserve_credits("))):
            body = definition(M, name)
            ask = body.index("public.api_err(428, 'adult_attestation_required',")
            self.assertLess(body.index("'adult_only_service'"), ask, name)
            for word in later:
                self.assertLess(ask, body.index(word), (name, word))
            self.assertIn("Confirm you are 18 or older on Create", body)

    def test_the_failover_skips_like_the_acknowledgement(self):
        body = definition(M, "reroute_creative_job")
        ack = body.index("continue when public.rights_acknowledgement_missing(")
        adult = body.index("continue when public.adult_attestation_missing(j.requested_by, m);")
        self.assertLess(ack, adult)
        self.assertLess(adult, body.index("q := public.creative_price(j.org_id, j.capability, m, j.params);"))

    def test_the_route_says_how_many_it_skipped(self):
        self.assertIn("'adult_skipped', adult_skipped,", definition(M, "route_model"))

    def test_the_dispatch_asks_before_it_holds(self):
        ask = ROUTE.index('return NextResponse.json({ error: "adult_attestation_required", google_stages: googleStages }, { status: 428 });')
        self.assertLess(ask, ROUTE.index("await reserveRunCredits("))
        self.assertLess(ask, ROUTE.index("await dispatchDailyVideo("))


if __name__ == "__main__":
    unittest.main()

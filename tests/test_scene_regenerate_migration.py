"""supabase/migrations/0076_scene_regenerate.sql — regenerating one scene is a
priced, confirmed press, paid by its own hold, made with the same source.

SQL does not run in this suite (tests/security/test_sec_scene_regenerate.py
runs the attacks against a real Postgres 16). These pin that 0076 is built on
the LATEST bodies of what it replaces (0041's render_jobs_payment_guard and
render_jobs_terms_frozen: every line kept, in order, only lines added; 0041's
insert policy verbatim plus one clause), that no price is invented, and that
its privileges are explicit."""

import re
import unittest
from pathlib import Path

MIGRATIONS = Path(__file__).resolve().parent.parent / "supabase" / "migrations"
FILE = "0076_scene_regenerate.sql"
SQL = (MIGRATIONS / FILE).read_text()
REPLACED = ["render_jobs_payment_guard", "render_jobs_terms_frozen"]
NEW = ["expire_scene_regenerations", "finish_scene_regeneration", "quote_scene_regenerate",
       "request_scene_regenerate", "scene_regen_plan", "scene_regen_price", "scene_regen_published",
       "scene_regenerations_no_delete", "scene_regenerations_terms_frozen", "start_scene_regeneration"]


def bodies(text):
    return {m.group(1): m.group(0) for m in
            re.finditer(r"create or replace function public\.(\w+)\(.*?\n\$\$;\n", text, re.S)}


def literals(body):
    code = re.sub(r"--[^\n]*", "", body)
    return set(re.findall(r"'(?:[^']|'')*'", code))


def code(body):
    return "\n".join(line.split("--", 1)[0] for line in body.splitlines())


def latest(name):
    """The newest migration BELOW this one that defines ``name``."""
    for f in sorted(MIGRATIONS.glob("*.sql"), reverse=True):
        if f.name >= FILE[:4] or not re.match(r"^\d{4}_", f.name):
            continue
        b = bodies(f.read_text())
        if name in b:
            return f.name, b[name]
    raise AssertionError(name)


def policy(text, name):
    m = re.search(rf"create policy {name} on public\.\w+\n(.*?\n  \);)", text, re.S)
    return m.group(1) if m else None


def latest_policy(name):
    for f in sorted(MIGRATIONS.glob("*.sql"), reverse=True):
        if f.name >= FILE[:4] or not re.match(r"^\d{4}_", f.name):
            continue
        p = policy(f.read_text(), name)
        if p:
            return f.name, p
    raise AssertionError(name)


class BuiltOnTheLatestBodies(unittest.TestCase):
    def test_defines_exactly_these_functions(self):
        self.assertEqual(sorted(bodies(SQL)), sorted(REPLACED + NEW))

    def test_the_bodies_are_taken_from_the_file_that_last_defined_them(self):
        for name in REPLACED:
            self.assertEqual(latest(name)[0], "0041_run_billing_hardening.sql", name)
        for name in NEW:
            with self.assertRaises(AssertionError, msg=f"{name} existed before 0076"):
                latest(name)

    def test_every_line_of_each_old_body_is_still_there_in_order(self):
        for name in REPLACED:
            _, old = latest(name)
            it = iter(bodies(SQL)[name].splitlines())
            for line in old.splitlines():
                self.assertTrue(any(line == n for n in it), f"{name}: line changed or moved: {line!r}")

    def test_every_literal_and_check_survives(self):
        for name in REPLACED:
            _, old = latest(name)
            new = bodies(SQL)[name]
            for lit in literals(old):
                self.assertIn(lit, literals(new), f"{name} lost {lit}")
            for stmt in ("raise exception", "return new;", "credits_exempt(", "accessible_channel_ids('admin')",
                         "is distinct from", "credits_round_up(", "interval '3 hours'", "r.amount < v_need"):
                self.assertGreaterEqual(code(new).count(stmt), code(old).count(stmt), f"{name}: fewer {stmt}")

    def test_the_insert_policy_is_0041s_plus_one_clause(self):
        src, old = latest_policy("render_jobs_insert")
        self.assertEqual(src, "0041_run_billing_hardening.sql")
        new = policy(SQL, "render_jobs_insert")
        self.assertEqual(new, old.replace("    and api_hold_ref is null\n",
                                          "    and api_hold_ref is null\n    and scene_regeneration_id is null\n"))


class TheMoney(unittest.TestCase):
    def setUp(self):
        self.b = {k: code(v) for k, v in bodies(SQL).items()}

    def test_no_price_is_invented(self):
        # An unset unit is 'unpriced' and blocks the button (CLAUDE.md rule 5).
        self.assertNotRegex(code(SQL), r"insert into public\.credit_prices")
        self.assertIn("'status', 'unpriced', 'credits', null", self.b["scene_regen_price"])

    def test_the_hold_is_the_quote_and_the_press_carries_the_price_it_saw(self):
        req = self.b["request_scene_regenerate"]
        self.assertIn("if p_max_credits is null then", req)
        self.assertIn("if v_price > p_max_credits then", req)
        self.assertIn("raise exception 'price_changed'", req)
        self.assertIn("v_res := public.reserve_credits(v_org, v_ref, v_price);", req)
        # Price, then hold, then the rows: a refusal rolls all of it back.
        self.assertLess(req.index("price_changed"), req.index("reserve_credits("))
        self.assertLess(req.index("reserve_credits("), req.index("insert into public.scene_regenerations"))
        self.assertLess(req.index("insert into public.scene_regenerations"), req.index("insert into public.render_jobs"))

    def test_a_replay_holds_nothing_and_a_reused_key_for_another_request_is_refused(self):
        req = self.b["request_scene_regenerate"]
        self.assertIn("pg_advisory_xact_lock(", req)
        self.assertLess(req.index("pg_advisory_xact_lock("), req.index("idempotency_key = p_idem"))
        self.assertLess(req.index("'replayed', true"), req.index("reserve_credits("))
        self.assertIn("raise exception 'idempotency_conflict'", req)
        self.assertIn("create unique index if not exists scene_regenerations_idem_key", SQL)
        self.assertIn("on public.scene_regenerations (video_id) where status in ('queued', 'running');", SQL)

    def test_capture_is_the_quote_and_failure_releases_everything(self):
        fin = self.b["finish_scene_regeneration"]
        self.assertIn("public.capture_credits(r.credit_ref, r.quoted_credits, false)", fin)
        self.assertIn("perform public.release_credits(r.credit_ref);", fin)
        self.assertIn("charged_credits <= coalesce(quoted_credits, 0)", SQL)
        self.assertIn("perform public.release_credits(r.credit_ref);", self.b["expire_scene_regenerations"])

    def test_a_regeneration_job_is_paid_by_its_own_hold_not_the_video_floor(self):
        guard = self.b["render_jobs_payment_guard"]
        link = guard.index("if new.scene_regeneration_id is not null then")
        self.assertLess(link, guard.index("if public.credits_exempt(v_org) then"))
        own = guard.index("if new.scene_regeneration_id is not null then", link + 1)
        self.assertLess(own, guard.index("new.params := coalesce(new.params, '{}'::jsonb);"))
        block = guard[own:guard.index("return new;", own)]
        for cond in ("r.org_id is distinct from v_org", "r.status <> 'open'", "r.started_at is not null",
                     "r.amount < sr.quoted_credits"):
            self.assertIn(cond, block)

    def test_the_regeneration_link_is_frozen_on_the_job(self):
        self.assertIn("new.scene_regeneration_id is distinct from old.scene_regeneration_id",
                      self.b["render_jobs_terms_frozen"])


class TheSourceAndTheGates(unittest.TestCase):
    def setUp(self):
        self.b = {k: code(v) for k, v in bodies(SQL).items()}

    def test_same_never_picks_a_generator_or_falls_back_to_stock(self):
        plan = self.b["scene_regen_plan"]
        for reason in ("generator_not_recorded", "generator_model_not_recorded", "mixed_generators",
                       "generated_stills_not_supported"):
            self.assertIn(f"'{reason}'", plan)
        # Stock replaces a generated scene only when the person chose 'stock'.
        stock = plan.index("if p_source = 'stock' then")
        self.assertIn("'explicit_stock', n_gen > 0", plan[stock:stock + 400])
        self.assertIn("'source_kind', 'generated', 'provider', v_provider, 'model', v_model", plan)

    def test_a_published_video_is_refused_in_the_quote_and_the_press(self):
        self.assertIn("v.video_id !~ '^run-[0-9a-f]{20}$'", self.b["scene_regen_published"])
        self.assertIn("'reason', 'published'", self.b["quote_scene_regenerate"])
        self.assertIn("raise exception 'published'", self.b["request_scene_regenerate"])

    def test_the_quote_and_its_refusals_name_no_generator_or_price_unit(self):
        # BR-L-039: viewers read the quote over PostgREST; the UI shows only
        # the kind of source, so nothing more is returned.
        quote = self.b["quote_scene_regenerate"]
        for leak in ("'provider'", "'model'", "'missing_unit'", "'clip_unit'"):
            self.assertNotIn(leak, quote)
        self.assertIn("raise exception 'unpriced' using errcode = 'NS400';", self.b["request_scene_regenerate"])
        self.assertNotIn("missing_unit", self.b["request_scene_regenerate"])

    def test_the_worker_hands_over_what_was_priced(self):
        # BR-L-033: the run checks the scene on disk against these.
        start = self.b["start_scene_regeneration"]
        for field in ("'previous_asset_ids'", "'generated_clips'", "'stock_assets'"):
            self.assertIn(field, start)

    def test_who_may_press_is_the_run_now_rule(self):
        self.assertIn("accessible_channel_ids('admin')", self.b["request_scene_regenerate"])
        self.assertIn("accessible_channel_ids('viewer')", self.b["quote_scene_regenerate"])

    def test_success_voids_the_approval_and_never_publishes(self):
        fin = self.b["finish_scene_regeneration"]
        self.assertIn("update public.videos set review_state = 'pending'", fin)
        self.assertIn("outcome = 'superseded_by_repair'", fin)
        for word in ("published_at", "privacy", "publish_state", "'approved' where"):
            self.assertNotIn(f"set {word}", fin)
        self.assertNotIn("resume", self.b["request_scene_regenerate"].split("insert into public.render_jobs", 1)[1]
                         .split(";", 1)[0])


class Privileges(unittest.TestCase):
    def test_security_definer_functions_pin_their_search_path(self):
        for name, body in bodies(SQL).items():
            head = body.split("$$", 1)[0]
            self.assertIn("set search_path = public, pg_temp", head, name)

    def test_the_browser_quotes_and_presses_and_nothing_else(self):
        self.assertIn("grant execute on function public.quote_scene_regenerate(text, text, text) to authenticated;", SQL)
        self.assertIn("grant execute on function public.request_scene_regenerate(text, text, text, text, numeric, text) "
                      "to authenticated;", SQL)
        for fn in ("start_scene_regeneration(uuid, bigint)",
                   "finish_scene_regeneration(uuid, bigint, boolean, text, text, jsonb)",
                   "expire_scene_regenerations()"):
            self.assertIn(f"revoke all on function public.{fn} from public, anon, authenticated;", SQL)
            self.assertIn(f"grant execute on function public.{fn} to service_role;", SQL)
        for fn in ("scene_regen_plan(jsonb, text, text)", "scene_regen_price(jsonb)",
                   "scene_regen_published(public.videos)"):
            self.assertIn(f"revoke all on function public.{fn} from public, anon, authenticated, service_role;", SQL)
        grants = re.findall(r"^grant (.*)$", SQL, re.M)
        self.assertEqual(len(grants), 6, grants)

    def test_rls_on_and_no_browser_writes(self):
        self.assertIn("alter table public.scene_regenerations enable row level security;", SQL)
        self.assertIn("revoke all on public.scene_regenerations from public, anon, authenticated, service_role;", SQL)
        self.assertIn("grant select on public.scene_regenerations to authenticated, service_role;", SQL)

    def test_each_trigger_is_created_once(self):
        for trig in re.findall(r"create trigger (\w+)", SQL):
            self.assertEqual(SQL.count(f"create trigger {trig}\n"), 1, trig)

    def test_additive_only(self):
        self.assertNotRegex(code(SQL), r"\bdrop (table|column|function)\b")
        self.assertNotRegex(code(SQL), r"\b(truncate|delete from)\b")

    def test_ends_with_a_verify_query(self):
        self.assertIn("-- Verify (run after applying; every column should read true)", SQL)
        self.assertIn("as search_path_pinned;", SQL.rstrip().splitlines()[-1])


if __name__ == "__main__":
    unittest.main()

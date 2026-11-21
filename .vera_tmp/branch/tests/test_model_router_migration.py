"""Migration 0075 (Model Router v1), read as text.

``create or replace`` keeps the LAST definition. 0075 replaces six functions;
each must be the latest body before it with lines ADDED — never a line lost,
never an earlier check dropped — except one sanctioned line (the
'mode_not_supported' refusal, which now stands only without the router). The
functions the router merely calls (creative_price, creative_params_problem,
sellable_models, quote_creative_job, ...) are NOT replaced, so 0072's captions
and 0070's price variants stand exactly as they are. The behaviour itself is
proven in a real database by tests/security/test_sec_model_router.py.
"""
from __future__ import annotations

import re
import unittest
from pathlib import Path

MIGRATIONS = Path(__file__).resolve().parents[1] / "supabase" / "migrations"
M75 = MIGRATIONS / "0075_model_router.sql"

#: name -> the migration whose body 0075 is built on (the latest before it).
REPLACED = {
    "create_creative_job": "0070_video_price_variants.sql",
    "finish_creative_job": "0036_creative_jobs.sql",
    "creative_job_json": "0036_creative_jobs.sql",
    "api_creative_create": "0062_api_creative.sql",
    "api_creative_job_json": "0062_api_creative.sql",
    "api_creative_refusal": "0062_api_creative.sql",
}
NEW = ("route_model", "creative_route_quote", "quote_creative_route", "reroute_creative_job", "api_creative_quote",
       "creative_jobs_route_recorded")
#: The one line of an old body 0075 changes, and what it became.
SANCTIONED = {
    ("create_creative_job", "  if md <> 'exact' then"):
        "  if md <> 'exact' and to_regprocedure('public.route_model(text, jsonb, text, uuid, text)') is null then",
}


def bodies(text):
    return {m.group(1): m.group(0) for m in
            re.finditer(r"create or replace function public\.(\w+)\(.*?\n\$\$;\n", text, re.S)}


def literals(sql):
    code = re.sub(r"--[^\n]*", "", sql)
    return set(re.findall(r"'(?:[^']|'')*'", code))


def latest_before(name, number=75):
    found = None
    for path in sorted(MIGRATIONS.glob("*.sql")):
        if int(path.name[:4]) >= number:
            continue
        b = bodies(path.read_text())
        if name in b:
            found = (path.name, b[name])
    if found is None:
        raise AssertionError(name)
    return found


class BuiltOnTheLatestBodies(unittest.TestCase):
    def setUp(self):
        self.text = M75.read_text()
        self.new = bodies(self.text)

    def test_it_replaces_exactly_these_and_adds_exactly_these(self):
        self.assertEqual(set(self.new), set(REPLACED) | set(NEW))

    def test_each_replaced_body_is_the_latest_before_0075(self):
        for name, src in REPLACED.items():
            self.assertEqual(latest_before(name)[0], src, name)

    def test_every_literal_of_the_latest_body_is_kept(self):
        for name in REPLACED:
            src, old = latest_before(name)
            for lit in literals(old):
                self.assertIn(lit, self.new[name], f"{name} lost {lit} from {src}")

    def test_lines_are_only_added_in_order_except_the_sanctioned_one(self):
        for name in REPLACED:
            src, old = latest_before(name)
            new_lines = self.new[name].splitlines()
            at = 0
            for line in old.splitlines():
                want = SANCTIONED.get((name, line), line)
                try:
                    at = new_lines.index(want, at) + 1
                except ValueError:
                    self.fail(f"{name}: the line {line!r} of {src} is missing or out of order in 0075")

    def test_the_sanctioned_line_keeps_its_refusal(self):
        body = self.new["create_creative_job"]
        guarded = SANCTIONED[("create_creative_job", "  if md <> 'exact' then")]
        self.assertIn(guarded + "\n    perform public.creative_refuse('mode_not_supported',", body)
        self.assertNotIn("\n  if md <> 'exact' then\n    perform public.creative_refuse('mode_not_supported'", body)

    def test_it_does_not_replace_what_the_router_only_calls(self):
        for name in ("creative_price", "creative_params_problem", "sellable_models", "quote_creative_job",
                     "creative_source_problem", "creative_capability_supported", "model_registry_guard",
                     "creative_style_problem", "advance_creative_job", "claim_creative_job", "cancel_creative_job"):
            self.assertNotIn(name, self.new, name)

    def test_a_later_migration_that_replaces_these_must_keep_the_router(self):
        marks = {"create_creative_job": "route_changed", "finish_creative_job": "j.routed_credits",
                 "creative_job_json": "routed_credits", "api_creative_create": "nightshift.creative_surface",
                 "api_creative_job_json": "routed_model", "api_creative_refusal": "route_changed"}
        for path in sorted(MIGRATIONS.glob("*.sql")):
            if int(path.name[:4]) <= 75:
                continue
            for name, body in bodies(path.read_text()).items():
                if name in marks:
                    self.assertIn(marks[name], body, f"{path.name} replaces {name} without 0075's lines")

    def test_it_refuses_to_apply_on_older_bodies(self):
        for needle in ("0075 needs 0070_video_price_variants.sql (its create_creative_job): apply it first",
                       "0075 needs 0072_captions.sql: apply it first",
                       "0075 needs 0062_api_creative.sql: apply it first"):
            self.assertIn(needle, self.text)
        self.assertLess(self.text.index("0075 needs 0070"), self.text.index("create or replace function"))


class TheRules(unittest.TestCase):
    def setUp(self):
        self.text = M75.read_text()
        self.new = bodies(self.text)

    def test_candidates_come_only_from_the_sellable_list_and_the_live_price(self):
        r = self.new["route_model"]
        self.assertIn("from public.sellable_models(cap, surf) s", r)
        self.assertIn("q := public.creative_price(p_org, cap, m, p_params);", r)
        # Only a refusal skips a model; anything else is an error, not "no model".
        self.assertIn("exception when sqlstate 'NS400' then\n      continue;", r)
        self.assertIn("if c is null or c <= 0 then\n      continue;", r)
        self.assertNotIn("when others", r)
        # Ties end on the model id: the pick is deterministic.
        self.assertIn("order by x.k1, x.k2, x.k3, x.k4, x.e ->> 'model'", r)
        for reason in ("only_option", "cheapest", "fastest", "best_quality", "best_value", "best_available"):
            self.assertIn(f"'{reason}'", r)
        self.assertIn("'no_model_available'", r)

    def test_a_routed_create_needs_the_quoted_pick_and_price_and_reroutes_under_the_lock(self):
        c = self.new["create_creative_job"]
        self.assertLess(c.index("perform public.credit_account_lock(p_org);"),
                        c.index("rt := public.route_model(p_capability, p_params, md, p_org, surf);"))
        self.assertLess(c.index("rt := public.route_model("), c.index("q := public.creative_price("))
        self.assertIn("if nullif(btrim(coalesce(p_model, '')), '') is null or p_max_credits is null then", c)
        self.assertIn("if (rt ->> 'model') is distinct from lower(btrim(p_model)) then", c)
        self.assertIn("'route_changed'", c)
        # BR-L-020: the hold of a routed job is the pick's price, like exact —
        # never the caller's max_credits (which only refuses a higher price).
        self.assertNotIn("p_max_credits, 2", c)
        self.assertIn("       set routed_credits = price,\n", c)
        self.assertNotIn("p_max_credits, 2", self.new["api_creative_create"])
        # BR-L-022: members read the reason and the surface; the candidates are the platform's.
        self.assertIn("routing = jsonb_build_object('reason', rt ->> 'reason', 'surface', surf)\n", c)
        self.assertIn("insert into public.creative_job_routes (job_id, quality_tier, candidates, tried)", c)

    def test_a_routed_job_is_charged_at_most_its_models_price(self):
        f = self.new["finish_creative_job"]
        self.assertIn("if j.routed_credits is not null and charge > j.routed_credits then\n    charge := j.routed_credits;", f)
        self.assertLess(f.index("charge := j.routed_credits;"), f.index("if charge < 0 or charge > j.quoted_credits then"))

    def test_failover_never_for_exact_never_above_the_hold_never_after_a_task(self):
        r = self.new["reroute_creative_job"]
        # BR-L-019: only codes that prove no vendor task exists; never 'unavailable'.
        listed = r.split("if code not in (", 1)[1].split(")", 1)[0]
        self.assertNotIn("'unavailable'", listed)
        self.assertIn("'unreachable'", listed)
        self.assertLess(r.index("if code not in ("), r.index("submit_started_at = null"))
        self.assertEqual(r.count("submit_started_at = null"), 1)
        # BR-L-024: the row describes the model that runs now.
        self.assertIn("credit_unit = coalesce(q ->> 'unit', j.credit_unit),", r)
        self.assertIn("quantity = coalesce((q ->> 'quantity')::numeric, j.quantity),", r)
        self.assertIn("select * into rr from public.creative_job_routes where job_id = p_job for update;", r)
        self.assertIn("update public.creative_job_routes r set tried = r.tried || to_jsonb(m) where r.job_id = p_job;", r)
        self.assertIn("if j.mode = 'exact' or j.routing is null then\n    return null;", r)
        self.assertIn("j.provider_task_id is not null then\n    return null;", r)
        self.assertIn("continue when price is null or price <= 0 or price > j.quoted_credits;", r)
        self.assertIn("continue when j.mode = 'quality' and cq <> q0;", r)
        self.assertIn("continue when j.mode = 'auto' and cq < q0;", r)
        self.assertIn("if jsonb_array_length(tried) >= 3 then", r)
        self.assertIn("q := public.creative_price(j.org_id, j.capability, m, j.params);", r)
        self.assertIn("if not public.credits_trusted_caller() then", r)
        for code in ("'policy'", "'bad_request'", "'provider_timeout'"):
            self.assertNotIn(code, r.split("if code not in (", 1)[1].split(")", 1)[0])

    def test_exact_can_never_carry_a_route_and_a_routed_job_must(self):
        self.assertIn("(mode <> 'exact' or (routing is null and routed_credits is null and fallback_from is null))",
                      self.text)
        self.assertIn("routed_credits <= quoted_credits", self.text)
        t = self.new["creative_jobs_route_recorded"]
        self.assertIn("if found and r.mode <> 'exact' and (r.routing is null or r.routed_credits is null) then", t)
        self.assertIn("create constraint trigger creative_jobs_route_recorded\n"
                      "  after insert or update of mode, routing, routed_credits on public.creative_jobs\n"
                      "  deferrable initially deferred", self.text)

    def test_the_candidates_are_the_platforms_only(self):
        self.assertIn("alter table public.creative_job_routes enable row level security;", self.text)
        self.assertIn("revoke all on table public.creative_job_routes from public, anon, authenticated, service_role;",
                      self.text)
        self.assertNotRegex(self.text, r"grant [^;]*on (table )?public\.creative_job_routes")
        self.assertNotRegex(self.text, r"create policy[^;]*creative_job_routes")

    def test_no_margin_on_the_routed_quote(self):
        q = self.new["creative_route_quote"]
        self.assertIn("return (q - 'margin' - 'credits_per_unit') || jsonb_build_object(", q)
        self.assertNotIn("'margin'", self.new["api_creative_quote"].replace("- 'margin'", ""))

    def test_the_api_routes_among_its_own_models_and_names_no_provider(self):
        a = self.new["api_creative_create"]
        self.assertLess(a.index("perform set_config('nightshift.creative_surface', 'api', true);"),
                        a.index("v_out := public.create_creative_job("))
        q = self.new["api_creative_quote"]
        self.assertIn("p_key_hash text, p_capability text, p_model text, p_params jsonb, p_mode text, p_request_id text\n)", q)
        self.assertIn("return public.api_creative_quote(p_key_hash, p_capability, p_model, p_params, p_request_id);", q)
        self.assertIn("v_q - 'available' - 'display_name' - 'quality_tier' - 'speed_tier'", q)
        self.assertIn(", 'api');", q)
        added = re.sub(r"--[^\n]*", "", self.new["api_creative_job_json"].split("-- 0075", 1)[1])
        self.assertNotIn("provider", added)
        self.assertNotIn("routing'", added)
        # BR-L-021: a failover's reason is neutral on the API.
        self.assertIn("'fallback_reason', case when j.fallback_reason is null then null else 'unavailable' end,", added)
        self.assertNotIn("'fallback_reason', j.fallback_reason", added)

    def test_privileges(self):
        t = self.text
        for line in ("grant execute on function public.quote_creative_route(uuid, text, text, jsonb) to authenticated;",
                     "grant execute on function public.reroute_creative_job(uuid, text, text) to service_role;",
                     "grant execute on function public.api_creative_quote(text, text, text, jsonb, text, text) to anon;",
                     "revoke all on function public.route_model(text, jsonb, text, uuid, text) from public, anon, authenticated, service_role;",
                     "revoke all on function public.creative_route_quote(uuid, text, text, jsonb, text) from public, anon, authenticated, service_role;",
                     "grant execute on function public.create_creative_job(uuid, text, text, jsonb, text, text, numeric) to authenticated;"):
            self.assertIn(line, t)
        self.assertNotRegex(t, r"grant execute on function public\.route_model")
        self.assertNotRegex(t, r"grant execute on function public\.creative_route_quote")
        self.assertNotRegex(t, r"grant (insert|update|delete)[^;]*creative_jobs")
        self.assertIn("-- Verify", t)

    def test_every_security_definer_function_pins_its_search_path(self):
        for name, body in self.new.items():
            if "security definer" in body:
                self.assertIn("set search_path = public, pg_temp", body, name)


if __name__ == "__main__":
    unittest.main()

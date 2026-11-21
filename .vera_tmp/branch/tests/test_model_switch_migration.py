"""Migration 0124 (the owner's per-model and per-provider ON/OFF switch), pinned from the file: what the lab cannot see by running it.

* the five replaced functions are the earlier migrations' bodies with lines ADDED and nothing removed or changed (every added chunk is
  marked 0124), except api_creative_model_ok, which is rewritten around the same last line;
* the md5 values in the drift guard are those of the bodies in the repo (the earlier ones and this file's), and the rollback carries the same
  hashes and restores the earlier text byte for byte;
* DARK: every gate asks model_is_available(), which is true until `enforced`; the settings row is seeded off and never overwritten; the
  owner function refuses while it is off;
* every new table is closed to every API role, every new function is revoked from every API role and granted narrowly, and every definer
  function pins its search_path;
* nothing existing is dropped, no audit list is touched, and no top-level statement writes a row but the seed.
"""

import difflib
import hashlib
import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MIG = ROOT / "supabase" / "migrations"
FILE = MIG / "0124_model_switch.sql"
TEXT = FILE.read_text(encoding="utf-8")
ROLLBACK = (ROOT / "docs" / "sql" / "rollback_0124_model_switch.sql").read_text(encoding="utf-8")

#: name -> the migration whose body is the latest one before this file
REPLACED = {
    "sellable_models": "0100_video_ai_ops.sql",
    "creative_price": "0100_video_ai_ops.sql",
    "advance_creative_job": "0036_creative_jobs.sql",
    "api_creative_model_ok": "0062_api_creative.sql",
    "api_creative_refusal": "0075_model_router.sql",
}
NEW_FUNCTIONS = {
    "model_is_available": "text", "models_switched_off": "", "model_switch_state": "", "model_switch_job_model": "public.creative_jobs",
    "model_switch_target_models": "text, text", "model_switch_stop_jobs": "text[]", "model_switch_counts": "text[]",
    "owner_model_switches": "", "owner_model_switch_preview": "text, text",
    "owner_set_model_switch": "text, text, boolean, text, text, boolean", "owner_model_alert_dismiss": "bigint",
}
NEW_TRIGGER_FUNCTIONS = ("model_availability_log_append_only", "model_availability_settings_guard", "model_availability_settings_trail",
                         "model_switch_note_quota")
TABLES = ("model_availability_settings", "model_availability", "model_availability_log", "model_availability_alerts")


def code(sql: str) -> str:
    return "\n".join(line.split("--", 1)[0] for line in sql.splitlines())


def function(sql: str, name: str) -> str:
    m = re.search(rf"(?m)^create or replace function public\.{re.escape(name)}\(.*?^\$\$;\n", sql, re.S)
    assert m, name
    return m.group(0)


def body(fn: str) -> str:
    a = fn.index("$$") + 2
    return fn[a:fn.rindex("$$")]


def h(b: str) -> str:
    return hashlib.md5(re.sub(r"\s+", " ", b).encode()).hexdigest()


def old_text(name: str) -> str:
    return function((MIG / REPLACED[name]).read_text(encoding="utf-8"), name)


class Numbering(unittest.TestCase):
    def test_the_number_is_unique(self):
        numbers = sorted(p.name[:4] for p in MIG.glob("*.sql"))
        self.assertEqual(numbers.count("0124"), 1)

    def test_a_rollback_exists_and_is_one_transaction(self):
        self.assertRegex(ROLLBACK, r"(?m)^begin;$")
        self.assertRegex(ROLLBACK, r"(?m)^commit;$")
        self.assertIn("set local lock_timeout", ROLLBACK)

    def test_the_file_says_it_is_live_on_apply_and_applied_as_one_transaction(self):
        self.assertIn("LIVE ON APPLY", TEXT)
        self.assertIn("APPLY AS ONE TRANSACTION", TEXT)
        self.assertIn("set local lock_timeout", TEXT)
        self.assertNotRegex(code(TEXT), r"(?im)^\s*(begin|commit)\s*;")

    def test_the_number_choice_names_the_open_work_it_avoids(self):
        self.assertIn("0122", TEXT)
        self.assertIn("0123 belongs to", TEXT)
        self.assertNotIn("open PR", TEXT, "0122 is merged: the header must not call it open")
        self.assertIn("merged as #610", TEXT)

    def test_the_header_states_the_owner_guard_counter_and_what_append_only_means(self):
        self.assertIn("takes one slot of the CALLER'S OWN rate limit", TEXT)
        self.assertIn("append-only against DML only", TEXT)

    def test_the_header_lists_what_the_pipeline_gate_does_not_cover(self):
        for word in ("ElevenLabs", "AssemblyAI", "Runway", "Luma", "xAI", "GitHub Actions"):
            self.assertIn(word, TEXT.split("-- THE IN-FLIGHT RULE")[0], word)
        for f in ("docs/MODEL_SWITCH.md", "modules/model_switch.py"):
            t = (ROOT / f).read_text(encoding="utf-8")
            for word in ("ElevenLabs", "AssemblyAI", "Runway", "Luma", "xAI", "GitHub Actions"):
                self.assertIn(word, t, (f, word))


class NoOracleAndBoundedSweep(unittest.TestCase):
    def test_the_rate_ceiling_and_the_unconditional_off_are_stated_honestly(self):
        head = TEXT.split("-- 5. THE OPTIONAL ALERT")[0]
        for needle in ("take_web_rate('owner:model_switch', 60, 600)", "60 x 200 = 12,000 jobs", "rate_limited' for up to 10 minutes",
                       "unconditional\n--   OFF", "one model_availability_log row and one security_events row"):
            self.assertIn(needle, head, needle)
        doc = (ROOT / "docs" / "MODEL_SWITCH.md").read_text(encoding="utf-8")
        for needle in ("12,000 jobs per window", "unconditional OFF", "one log row and one security\n  event", "not a call count of 500"):
            self.assertIn(needle, doc, needle)
        self.assertNotIn("500 calls", doc)

    def test_model_is_available_answers_true_to_a_caller_who_could_not_be_offered_the_model(self):
        b = code(body(function(TEXT, "model_is_available")))
        self.assertIn("r.availability in ('beta', 'ga') and r.verified_at is not null", b)
        self.assertRegex(b, r"not coalesce\(seen, false\) and not \(public\.is_platform_admin\(\) or public\.credits_trusted_caller\(\)\)")
        # the early answer is a plain TRUE, before anything about the model's switches is read
        self.assertLess(b.index("return true;", b.index("seen, false")), b.index("model_availability a"))

    def test_the_sweep_is_bounded_and_the_owner_function_says_what_is_left(self):
        sweep = code(body(function(TEXT, "model_switch_stop_jobs")))
        self.assertRegex(sweep, r"order by j\.org_id, j\.id\s+limit 200")
        owner = code(body(function(TEXT, "owner_set_model_switch")))
        for needle in ("'remaining'", "'complete'"):
            self.assertIn(needle, owner)
        # the switch row is written before the sweep, and whole: the sweep never decides whether the model is off
        self.assertLess(owner.index("insert into public.model_availability "), owner.index("model_switch_stop_jobs(ids)"))

    def test_the_policy_guard_compares_the_whole_expression_with_the_two_texts_it_may_have(self):
        guard = TEXT.split("-- Every new name is absent")[0]
        self.assertIn("q <> all (array[", guard)
        self.assertIn("is_platform_admin()OR((availability=ANY(ARRAY[''beta'',''ga'']))AND(verified_atISNOTNULL)))", guard)
        self.assertIn("ANDmodel_is_available(id)))", guard)
        self.assertIn("not wc_null or cmd <> 'r' or not perm or not coalesce(roles_ok, false)", guard)
        self.assertIn("p.polroles = array[(select r.oid from pg_roles r where r.rolname = 'authenticated')]::oid[]", guard)
        self.assertNotIn("position('beta' in q)", guard, "the substring check is gone")


class TheReplacedBodies(unittest.TestCase):
    def test_each_is_the_earlier_body_with_marked_lines_added_and_nothing_else(self):
        for name in ("sellable_models", "creative_price", "advance_creative_job", "api_creative_refusal"):
            with self.subTest(name=name):
                old = old_text(name).splitlines()
                new = function(TEXT, name).splitlines()
                ops = [op for op in difflib.SequenceMatcher(None, old, new, autojunk=False).get_opcodes() if op[0] != "equal"]
                self.assertTrue(ops, "nothing was added")
                for tag, a1, a2, b1, b2 in ops:
                    self.assertEqual(tag, "insert", f"{name}: {tag} at old lines {a1}-{a2} (only additions are allowed)")
                    self.assertIn("0124", "\n".join(new[b1:b2]), f"{name}: an added chunk is not marked 0124")

    def test_the_additions_are_exactly_these(self):
        sm = function(TEXT, "sellable_models")
        self.assertEqual(code(sm).count("model_is_available"), 1)
        self.assertIn("and public.model_is_available(m.id)", sm)
        cp = function(TEXT, "creative_price")
        self.assertEqual(code(cp).count("model_is_available"), 1)
        # after the registry lookup (a model that is not sold stays "not sold"), before the entitlement and the price
        self.assertLess(cp.index("'model_not_sellable'"), cp.index("model_temporarily_off"))
        self.assertLess(cp.index("model_temporarily_off"), cp.index("entitlement_required"))
        self.assertLess(cp.index("model_temporarily_off"), cp.index("select * into rate") if "select * into rate" in cp else len(cp))
        adv = function(TEXT, "advance_creative_job")
        self.assertEqual(code(adv).count("model_is_available"), 1)
        gate = adv.index("model_is_available")
        self.assertLess(gate, adv.index("select * into j from public.creative_jobs where id = p_job for update"),
                        "the gate runs BEFORE the job row is locked: creative_end_locked takes the account first")
        self.assertIn("p_step = 'submitting'", adv[:gate][-600:])
        self.assertIn("g0.submit_started_at is null and g0.provider_task_id is null", adv)
        self.assertIn("g0.worker_id is not distinct from w and g0.status = 'running'", adv)
        ref = function(TEXT, "api_creative_refusal")
        self.assertIn("when 'model_temporarily_off' then public.api_err(503, 'model_temporarily_off'", ref)

    def test_api_creative_model_ok_keeps_the_old_answer_as_its_last_line(self):
        old = body(old_text("api_creative_model_ok")).strip().rstrip(";")
        new = function(TEXT, "api_creative_model_ok")
        self.assertTrue(old.startswith("select exists ("))
        self.assertIn("return " + old[len("select "):] + ";", new)
        self.assertIn("returns boolean\n  language plpgsql stable security definer set search_path = public, pg_temp as $$", new)
        c = code(new)
        # it raises only for a model the API would otherwise sell: registered, verified, on sale, not web-only, not captions
        for part in ("r.availability in ('beta', 'ga')", "r.verified_at is not null", "<> 'web_only'", "p_capability <> 'captions'"):
            self.assertIn(part, c)

    def test_every_replaced_function_keeps_its_signature_and_attributes(self):
        for name in REPLACED:
            with self.subTest(name=name):
                old_head = old_text(name).split("$$", 1)[0]
                new_head = function(TEXT, name).split("$$", 1)[0]
                if name == "api_creative_model_ok":
                    self.assertEqual(old_head.replace("language sql", "language plpgsql"), new_head)
                else:
                    self.assertEqual(old_head, new_head)


class TheHashes(unittest.TestCase):
    def guard(self):
        return TEXT.split("do $$\ndeclare\n  s text;", 1)[1].split("-- Every new name is absent", 1)[0]

    def test_the_two_hashes_of_each_replaced_function_are_those_of_the_repo(self):
        g = self.guard()
        for name in REPLACED:
            with self.subTest(name=name):
                m = re.search(rf"{name}\) ?.*?array\['([0-9a-f]{{32}})', '([0-9a-f]{{32}})'\]", g, re.S) or \
                    re.search(rf"array\['([0-9a-f]{{32}})', '([0-9a-f]{{32}})'\]\) then\s+raise exception '0124 found an? {name}\(\)", g)
                self.assertIsNotNone(m, name)
                self.assertEqual(m.group(1), h(body(old_text(name))))
                self.assertEqual(m.group(2), h(body(function(TEXT, name))))

    def test_the_new_names_are_checked_against_this_files_own_bodies(self):
        block = TEXT.split("-- Every new name is absent", 1)[1].split("end $$;", 1)[0]
        pairs = re.findall(r"\['public\.([a-z_]+)\(.*?\)',\s*'([0-9a-f]{32})'\]", block)
        self.assertEqual({n for n, _ in pairs}, set(NEW_FUNCTIONS) | set(NEW_TRIGGER_FUNCTIONS) - {"model_switch_note_quota"} | {"model_switch_note_quota"})
        for name, digest in pairs:
            self.assertEqual(digest, h(body(function(TEXT, name))), name)

    def test_the_rollback_carries_the_same_hashes_and_restores_the_earlier_text_byte_for_byte(self):
        for name in REPLACED:
            with self.subTest(name=name):
                self.assertIn(h(body(old_text(name))), ROLLBACK)
                self.assertIn(h(body(function(TEXT, name))), ROLLBACK)
                self.assertEqual(function(ROLLBACK, name), old_text(name))

    def test_the_policy_is_restored_to_0035s_text(self):
        old = re.search(r"create policy model_registry_select on public\.model_registry.*?;", (MIG / "0035_model_registry.sql").read_text(encoding="utf-8"), re.S).group(0)
        self.assertEqual(re.sub(r"\s+", " ", re.search(r"create policy model_registry_select on public\.model_registry.*?;", ROLLBACK, re.S).group(0)),
                         re.sub(r"\s+", " ", old))
        new = re.search(r"create policy model_registry_select on public\.model_registry.*?;", TEXT, re.S).group(0)
        self.assertIn("public.is_platform_admin()", new)
        self.assertIn("and public.model_is_available(id)", new)
        self.assertIn("availability in ('beta', 'ga') and verified_at is not null", new)


class Dark(unittest.TestCase):
    def test_the_seed_is_off_and_never_overwrites_what_the_owner_set(self):
        c = code(TEXT)
        self.assertIn("enforced               boolean not null default false", c)
        self.assertIn("auto_suggest           boolean not null default false", c)
        self.assertIn("insert into public.model_availability_settings (id) values (true) on conflict (id) do nothing;", c)

    def test_while_dark_every_model_is_available(self):
        fn = code(function(TEXT, "model_is_available"))
        self.assertIn("not coalesce((select s.enforced from public.model_availability_settings s), false)", fn)
        self.assertLess(fn.index("return true"), fn.index("model_availability a"))

    def test_the_owner_function_refuses_to_record_while_dark(self):
        fn = code(function(TEXT, "owner_set_model_switch"))
        self.assertLess(fn.index("'not_enforced'"), fn.index("insert into public.model_availability "))

    def test_an_off_model_row_never_enables_anything(self):
        fn = code(function(TEXT, "model_is_available"))
        self.assertIn("where not a.enabled", fn)
        self.assertNotRegex(fn, r"a\.enabled\s*(=\s*true|\))\s*(then|and)")


class WhoMayDoWhat(unittest.TestCase):
    def test_every_table_is_closed_to_every_api_role_and_has_no_policy(self):
        c = code(TEXT)
        for t in TABLES:
            with self.subTest(table=t):
                self.assertIn(f"alter table public.{t} enable row level security;", c)
                self.assertIn(f"revoke all on public.{t} from public, anon, authenticated, service_role;", c)
        self.assertEqual(re.findall(r"(?i)create policy (\w+) on public\.(\w+)", c), [("model_registry_select", "model_registry")])
        self.assertNotRegex(c, r"(?i)\bgrant\s+(select|insert|update|delete|all)\b")

    def test_every_new_function_is_revoked_from_every_api_role_then_granted_narrowly(self):
        c = code(TEXT)
        for name, args in {**NEW_FUNCTIONS, **{n: "" for n in NEW_TRIGGER_FUNCTIONS}}.items():
            with self.subTest(name=name):
                self.assertIn(f"revoke all on function public.{name}({args}) from public, anon, authenticated, service_role;", c)
        grants = dict(re.findall(r"grant execute on function public\.(\w+)\([^)]*\) to ([a-z_, ]+);", c))
        self.assertEqual(grants, {
            "model_is_available": "authenticated, service_role", "models_switched_off": "authenticated, service_role",
            "model_switch_state": "service_role", "owner_model_switches": "authenticated", "owner_model_switch_preview": "authenticated",
            "owner_set_model_switch": "authenticated", "owner_model_alert_dismiss": "authenticated",
            "sellable_models": "authenticated, service_role", "advance_creative_job": "service_role"})
        self.assertNotIn("anon", " ".join(grants.values()))

    def test_every_definer_function_pins_its_search_path_and_only_pure_helpers_are_not_definers(self):
        for name in list(NEW_FUNCTIONS) + list(NEW_TRIGGER_FUNCTIONS):
            head = function(TEXT, name).split("$$", 1)[0]
            self.assertIn("set search_path = public, pg_temp", head, name)
        not_definer = {n for n in list(NEW_FUNCTIONS) + list(NEW_TRIGGER_FUNCTIONS) if "security definer" not in function(TEXT, n).split("$$", 1)[0]}
        self.assertEqual(not_definer, {"model_switch_job_model", "model_availability_log_append_only", "model_availability_settings_guard"})

    def test_the_owner_writers_go_through_owner_guard_and_the_owner_check(self):
        for name in ("owner_set_model_switch", "owner_model_alert_dismiss"):
            fn = code(function(TEXT, name))
            self.assertIn("public.owner_guard(", fn, name)
            self.assertIn("public.platform_role() is distinct from 'owner'", fn, name)
            self.assertLess(fn.index("public.owner_guard("), fn.index("platform_role"), name)
        for name in ("owner_model_switches", "owner_model_switch_preview"):
            fn = code(function(TEXT, name))
            self.assertIn("auth.uid() is null or not public.is_platform_admin() or public.platform_role() is distinct from 'owner'", fn, name)

    def test_the_audit_is_written_in_the_same_transaction_and_is_not_swallowed(self):
        fn = code(function(TEXT, "owner_set_model_switch"))
        self.assertIn("insert into public.model_availability_log", fn)
        self.assertIn("public.security_event_log('model.switch'", fn)
        self.assertNotIn("exception when others", fn)

    def test_the_trails_never_fail_the_write_they_observe_but_the_owner_function_does(self):
        self.assertIn("exception when others then", code(function(TEXT, "model_availability_settings_trail")))
        self.assertIn("exception when others then", code(function(TEXT, "model_switch_note_quota")))

    def test_the_reasons_are_the_closed_list_in_every_place_that_checks_them(self):
        words = ["out_of_funds", "vendor_outage", "terms_review", "other"]
        c = code(TEXT)
        self.assertIn("coalesce(reason in ('out_of_funds', 'vendor_outage', 'terms_review', 'other'), false)", c,
                      "a NULL reason must not pass a CHECK")
        self.assertIn("array['out_of_funds', 'vendor_outage', 'terms_review', 'other']", c)
        for w in words:
            self.assertGreaterEqual(c.count(f"'{w}'"), 2)


class WhatItDoesNotTouch(unittest.TestCase):
    def test_nothing_existing_is_dropped_but_the_one_policy_and_its_own_triggers(self):
        c = code(TEXT)
        drops = re.findall(r"(?im)^\s*drop\s+(\w+)(?:\s+if\s+exists)?\s+([\w.]+)", c)
        allowed = {("policy", "model_registry_select"), ("trigger", "model_availability_log_append_only"),
                   ("trigger", "model_availability_log_no_truncate"), ("trigger", "model_availability_settings_guard"),
                   ("trigger", "model_availability_settings_no_truncate"), ("trigger", "model_availability_settings_trail"),
                   ("trigger", "model_switch_note_quota")}
        self.assertEqual({d for d in drops}, allowed)
        # constraints are dropped-then-added only on the file's own tables
        for t in re.findall(r"alter table public\.(\w+) drop constraint", c):
            self.assertIn(t, TABLES)

    def test_the_audit_action_list_and_the_credit_functions_are_not_touched(self):
        c = code(TEXT)
        self.assertNotIn("audit_action_allowed", c)
        self.assertNotIn("app_audit_log", c)
        for fn in ("create_creative_job", "finish_creative_job", "claim_creative_job", "reroute_creative_job", "route_model",
                   "creative_end_locked", "workflow_advance_locked", "start_workflow_run"):
            self.assertNotRegex(c, rf"create or replace function public\.{fn}\b", fn)

    def test_the_only_row_written_at_the_top_level_is_the_seed(self):
        c = code(TEXT)
        top = [m for m in re.finditer(r"(?im)^(insert into|update|delete from)\s+public\.(\w+)", c)]
        self.assertEqual([(m.group(1).lower(), m.group(2)) for m in top], [("insert into", "model_availability_settings")])

    def test_it_creates_exactly_one_trigger_on_an_existing_table_and_it_is_narrow(self):
        c = code(TEXT)
        on_creative = re.search(r"create trigger model_switch_note_quota\s+after update of status on public\.creative_jobs\s+for each row\s+"
                                r"when \(new\.status = 'failed' and old\.status is distinct from 'failed' and new\.error_code = 'quota'\)", c)
        self.assertIsNotNone(on_creative)
        self.assertEqual(len(re.findall(r"(?i)create trigger", c)), 6)
        self.assertEqual([t for t in re.findall(r"(?i)create trigger \w+\s+(?:before|after) [a-z ]+ on public\.(\w+)", c) if t not in TABLES],
                         ["creative_jobs"])

    def test_the_stop_rule_is_the_in_flight_rule_in_every_place_that_states_it(self):
        sent = "j.provider_task_id is null and j.submit_started_at is null"
        self.assertIn(sent, code(function(TEXT, "model_switch_stop_jobs")))
        self.assertIn("j.status in ('queued', 'running')", code(function(TEXT, "model_switch_stop_jobs")))
        self.assertIn("for update skip locked", code(function(TEXT, "model_switch_stop_jobs")))
        counts = code(function(TEXT, "model_switch_counts"))
        self.assertIn("j.provider_task_id is null and j.submit_started_at is null", counts)
        self.assertIn("'model_temporarily_off'", code(function(TEXT, "model_switch_stop_jobs")))
        # the lock order of 0036: the organization's account first, then the job
        stop = code(function(TEXT, "model_switch_stop_jobs"))
        self.assertLess(stop.index("credit_account_lock"), stop.index("for update skip locked"))


class WhoUsesTheNewObjects(unittest.TestCase):
    def test_only_the_switch_module_and_the_queue_worker_ask_for_the_state(self):
        hits = []
        for base in ("modules", "tools"):
            for p in (ROOT / base).rglob("*.py"):
                if "model_switch_state" in p.read_text(encoding="utf-8"):
                    hits.append(p.relative_to(ROOT).as_posix())
        self.assertEqual(sorted(hits), ["modules/model_switch.py"])

    def test_no_python_module_calls_an_owner_function_or_reads_a_switch_table(self):
        for base in ("modules", "tools"):
            for p in (ROOT / base).rglob("*.py"):
                t = p.read_text(encoding="utf-8")
                for name in ("owner_set_model_switch", "owner_model_switches", "model_availability"):
                    self.assertNotIn(name, t, f"{p.name} mentions {name}")


if __name__ == "__main__":
    unittest.main()

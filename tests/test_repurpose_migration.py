"""Migration 0080 (multi-clip repurposing), read as text.

The behaviour is proven in a real database by tests/security/test_sec_repurpose.py
(who may ask, the money, the windows, the worker's settle). These pins are what
a reader of the diff cannot easily see:

* nothing existing is replaced or dropped — 0080 reuses 0020's credit functions
  as they are and does not touch the render queue's billing rules (0041), so it
  cannot collide with another migration that replaces them;
* every function pins its search_path, the browser reaches exactly two of them,
  the worker's five are service-only and refuse anyone else;
* no price is seeded (an unset unit is "unpriced", never 0), no provider, model
  or unit name appears in what a member reads;
* the limits in SQL are the limits in modules/repurpose.py;
* a made clip is a held, private row with no gate verdict.
"""

from __future__ import annotations

import re
import unittest
from pathlib import Path

from modules import repurpose

MIGRATIONS = Path(__file__).resolve().parents[1] / "supabase" / "migrations"
FILE = MIGRATIONS / "0080_repurpose.sql"
SQL = FILE.read_text()
CODE = "\n".join(line.split("--", 1)[0] for line in SQL.splitlines())

NEW_FUNCTIONS = {
    "repurpose_requests_terms_frozen", "repurpose_clips_terms_frozen", "repurpose_no_delete", "repurpose_plan",
    "repurpose_master_state", "repurpose_price", "quote_repurpose", "request_repurpose", "repurpose_settle",
    "claim_repurpose_request", "heartbeat_repurpose", "record_repurpose_clip", "finish_repurpose_request",
    "expire_repurpose_requests",
}
BROWSER = {"quote_repurpose", "request_repurpose"}
WORKER = {"claim_repurpose_request", "heartbeat_repurpose", "record_repurpose_clip", "finish_repurpose_request",
          "expire_repurpose_requests"}


def bodies(text):
    return {m.group(1): m.group(0) for m in
            re.finditer(r"create or replace function public\.(\w+)\(.*?\n\$\$;\n", text, re.S)}


def body(name):
    return bodies(CODE)[name]


class Additive(unittest.TestCase):
    def test_it_defines_exactly_these_functions(self):
        self.assertEqual(set(bodies(CODE)), NEW_FUNCTIONS)

    def test_it_replaces_no_earlier_function(self):
        earlier = {}
        for path in sorted(MIGRATIONS.glob("*.sql")):
            if path.name >= FILE.name:
                continue
            for name in bodies(path.read_text()):
                earlier.setdefault(name, path.name)
        clash = {n: earlier[n] for n in NEW_FUNCTIONS if n in earlier}
        self.assertEqual(clash, {}, "0080 would replace a function an earlier migration defines")

    def test_the_render_queues_billing_rules_are_not_touched(self):
        for word in ("render_jobs_payment_guard", "render_jobs_terms_frozen", "render_jobs_insert",
                     "create or replace function public.reserve_credits", "capture_credits(", "release_credits("):
            if word.endswith("("):
                continue
            self.assertNotIn(word, CODE, word)
        self.assertNotRegex(CODE, r"(?i)\binsert into public\.render_jobs\b")

    def test_nothing_is_dropped_or_deleted(self):
        self.assertNotRegex(CODE, r"(?i)\bdrop\s+(table|function|column|policy\s+(?!if exists)|index|trigger\s+(?!if exists))")
        self.assertNotRegex(CODE, r"(?i)\btruncate\b|\bdelete\s+from\b")
        # Only its own tables' constraints, policies and triggers are re-created.
        for m in re.finditer(r"(?i)alter table (public\.\w+)\s+drop constraint if exists", CODE):
            self.assertTrue(m.group(1).startswith("public.repurpose_"), m.group(1))
        for m in re.finditer(r"(?i)drop policy if exists \w+ on (public\.\w+)", CODE):
            self.assertTrue(m.group(1).startswith("public.repurpose_"), m.group(1))
        for m in re.finditer(r"(?i)drop trigger if exists \w+ on (public\.\w+)", CODE):
            self.assertTrue(m.group(1).startswith("public.repurpose_"), m.group(1))

    def test_tables_and_indexes_are_guarded_so_a_replay_is_a_no_op(self):
        self.assertEqual(len(re.findall(r"(?i)\bcreate table\b", CODE)), 2)
        self.assertEqual(len(re.findall(r"(?i)\bcreate table if not exists\b", CODE)), 2)
        self.assertEqual(len(re.findall(r"(?i)\bcreate (unique )?index\b", CODE)),
                         len(re.findall(r"(?i)\bcreate (unique )?index if not exists\b", CODE)))
        self.assertNotRegex(CODE, r"(?i)\badd column\b(?! if not exists)")
        self.assertNotRegex(CODE, r"(?i)\balter table public\.(?!repurpose_)\w+")

    def test_it_checks_what_it_needs_and_says_which_migration_is_missing(self):
        for needle in ("0018_organizations.sql", "0020_credits.sql", "0003, 0013 and 0016"):
            self.assertIn(needle, CODE.replace("\n", " ") + SQL)

    def test_a_verify_query_ends_the_file(self):
        tail = SQL.split("-- Verify", 1)[1]
        for needle in ("rls_on", "browser_cannot_write", "anon_gets_nothing", "worker_functions_are_service_only",
                       "anon_cannot_quote_or_press", "no_price_invented", "search_path_pinned"):
            self.assertIn(needle, tail)
        for name in NEW_FUNCTIONS:
            self.assertIn(f"'{name}'", tail, name)


class Privileges(unittest.TestCase):
    def test_every_function_pins_its_search_path(self):
        for name, text in bodies(CODE).items():
            header = text.split("$$", 1)[0]
            self.assertIn("set search_path = public, pg_temp", header, name)

    def test_browser_functions_are_security_definer_and_check_who_is_asking(self):
        for name in BROWSER:
            text = body(name)
            self.assertIn("security definer", text.split("$$", 1)[0], name)
            self.assertIn("if auth.uid() is null then", text, name)
            self.assertIn("raise exception 'forbidden' using errcode = '42501'", text, name)
        # The press is the Run now rule: an admin of the channel's organization.
        self.assertIn("accessible_channel_ids('admin')", body("request_repurpose"))
        self.assertIn("accessible_channel_ids('viewer')", body("quote_repurpose"))
        # A missing video and another organization's read the same.
        self.assertNotIn("not_found", body("quote_repurpose"))

    def test_the_workers_functions_refuse_everyone_but_the_platform(self):
        for name in WORKER:
            self.assertIn("if not public.credits_trusted_caller() then", body(name), name)

    def test_grants_are_exactly_these(self):
        grants = sorted(re.findall(r"grant execute on function public\.(\w+)\([^)]*\) to ([^;]+);", CODE))
        self.assertEqual(grants, sorted(
            [(n, "authenticated") for n in BROWSER] + [(n, "service_role") for n in WORKER]))
        self.assertNotRegex(CODE, r"\bto anon\b")
        self.assertNotRegex(CODE, r"grant [^;]*\b(insert|update|delete)\b[^;]* to ")
        for name in NEW_FUNCTIONS - BROWSER - WORKER:
            self.assertRegex(CODE, rf"revoke all on function public\.{name}\([^)]*\) from public, anon, authenticated, service_role;")
        for name in WORKER:
            self.assertRegex(CODE, rf"revoke all on function public\.{name}\([^)]*\) from public, anon, authenticated;")
        for name in BROWSER:
            self.assertRegex(CODE, rf"revoke all on function public\.{name}\([^)]*\) from public, anon, service_role;")

    def test_rls_is_on_and_a_browser_can_only_read(self):
        for table in ("repurpose_requests", "repurpose_clips"):
            self.assertIn(f"alter table public.{table} enable row level security;", CODE)
            self.assertIn(f"revoke all on public.{table} from public, anon, authenticated, service_role;", CODE)
            self.assertIn(f"grant select on public.{table} to authenticated, service_role;", CODE)
            self.assertEqual(re.findall(rf"create policy \w+ on public\.{table}\s+for (\w+) to (\w+)", CODE),
                             [("select", "authenticated")])
        self.assertIn("channel_id in (select public.accessible_channel_ids('viewer'))", CODE)


class Money(unittest.TestCase):
    def test_no_price_is_seeded_and_an_unset_one_is_unpriced(self):
        self.assertNotRegex(CODE, r"(?i)insert\s+into\s+public\.credit_prices")
        self.assertNotRegex(CODE, r"(?i)update\s+public\.credit_prices")
        price = body("repurpose_price")
        self.assertIn("select * into base from public.credit_prices where unit = 'repurpose_clip';", price)
        self.assertEqual(price.count("'status', 'unpriced'"), 2)
        self.assertIn("if base.unit is null or p_n is null or p_n < 1 then", price)
        self.assertIn("total <= 0", price)
        self.assertIn("v_unit := public.credits_round_up(base.credits_per_unit * (1 + base.margin));", price)
        self.assertIn("v_floor := public.credits_round_up(coalesce(jm, 0));", price)
        self.assertIn("total := greatest(v_unit * p_n, v_floor);", price)

    def test_the_press_prices_again_holds_exactly_the_quote_and_refuses_a_changed_price(self):
        text = body("request_repurpose")
        for needle in (
            "perform pg_advisory_xact_lock(hashtextextended('repurpose:' || v.video_id, 0));",
            "raise exception 'idempotency_conflict' using errcode = 'NS409';",
            "price := public.repurpose_price(jsonb_array_length(plan -> 'clips'));",
            "raise exception 'unpriced' using errcode = 'NS400';",
            "if p_max_credits is null then",
            "raise exception 'price_required' using errcode = '22023'",
            "if v_price > p_max_credits then",
            "raise exception 'price_changed' using errcode = 'NS409'",
            "v_res := public.reserve_credits(v_org, v_ref, v_price);",
            "v_ref := 'rp-' || replace(v_id::text, '-', '');",
            "raise exception 'in_progress' using errcode = 'NS409';",
        ):
            self.assertIn(needle, text)
        # idempotency is checked before anything is priced or held
        self.assertLess(text.index("idempotency_conflict"), text.index("reserve_credits"))
        self.assertLess(text.index("price_changed"), text.index("reserve_credits"))
        self.assertLess(text.index("pg_advisory_xact_lock"), text.index("select * into prior"))

    def test_a_member_reads_what_is_charged_never_a_unit_margin_or_rate(self):
        for name in ("quote_repurpose", "request_repurpose"):
            text = body(name)
            # (the press reads floor_credits/unit_credits from the internal price to
            # freeze them on its own row; it returns neither)
            for word in ("'unit'", "'margin'", "'missing_unit'", "'credits_per_unit'", "'repurpose_clip'"):
                self.assertNotIn(word, text, f"{name} names {word}")
        self.assertIn("'clip_credits', price -> 'unit_credits'", body("quote_repurpose"))
        self.assertNotIn("floor_credits", body("quote_repurpose"))
        self.assertNotIn("'unit_credits'", body("request_repurpose").split("return jsonb_build_object(")[-1])

    def test_settle_charges_only_the_clips_made_never_above_the_hold(self):
        text = body("repurpose_settle")
        self.assertIn("v_charge := least(r.quoted_credits, greatest(v_made * r.unit_credits, r.floor_credits));", text)
        self.assertIn("public.capture_credits(r.credit_ref, v_charge, false)", text)
        self.assertIn("public.release_credits(r.credit_ref)", text)
        self.assertIn("if v_made = 0 then", text)
        # an ended request answers again with the first answer
        self.assertIn("'replayed', true", text)
        self.assertIn("charged_credits >= 0 and charged_credits <= coalesce(quoted_credits, 0)", CODE)

    def test_the_hold_is_claimed_before_anything_runs_and_a_lost_hold_runs_nothing(self):
        text = body("claim_repurpose_request")
        self.assertIn("public.start_credit_reservation(r.credit_ref, r.org_id)", text)
        self.assertIn("'hold_not_open'", text)
        self.assertIn("for update skip locked", text)
        self.assertIn("attempts < 3", text)
        self.assertLess(text.index("start_credit_reservation"), text.index("set status = 'running'"))

    def test_a_stale_worker_cannot_settle_what_another_took_over(self):
        for name in ("record_repurpose_clip", "finish_repurpose_request"):
            text = body(name)
            self.assertIn("r.status <> 'running' or r.worker_id is distinct from p_worker", text, name)
            self.assertIn("raise exception 'not_claimed' using errcode = 'P0002'", text, name)

    def test_the_sweep_settles_never_leaves_credits_held(self):
        text = body("expire_repurpose_requests")
        self.assertIn("perform public.repurpose_settle(r.id, 'job_ended',", text)
        self.assertIn("interval '26 hours'", text)
        self.assertIn("s.attempts >= 3", text)


class Limits(unittest.TestCase):
    def test_sql_and_python_share_the_limits(self):
        plan = body("repurpose_plan")
        self.assertIn("jsonb_array_length(p_clips) > 5", plan)
        self.assertEqual(repurpose.MAX_CLIPS, 5)
        self.assertIn("lo - fo + 1 > 12", plan)
        self.assertEqual(repurpose.MAX_CLIP_SCENES, 12)
        self.assertIn("if w_dur < 15 then", plan)
        self.assertEqual(repurpose.MIN_CLIP_SECONDS, 15.0)
        self.assertIn("if w_dur > 60 then", plan)
        self.assertEqual(repurpose.MAX_CLIP_SECONDS, 60.0)
        self.assertIn("w_end > a_dur + 0.5", plan)
        self.assertEqual(repurpose.AUDIO_SLACK_S, 0.5)
        self.assertIn("ends[k - 1] - 0.001", plan)
        self.assertEqual(repurpose.EDGE_SLACK_S, 0.001)
        self.assertIn("least(width, height) from public.download_masters", body("repurpose_master_state"))
        self.assertIn("v_side < 720", body("repurpose_master_state"))
        self.assertEqual(repurpose.MIN_SOURCE_SIDE, 720)
        for reason in repurpose.REASONS:
            self.assertIn(f"'{reason}'", plan)

    def test_table_checks_repeat_the_window(self):
        self.assertIn("and duration_s between 15 and 60);", CODE)
        self.assertIn("cardinality(scene_ids) between 1 and 12", CODE)
        self.assertIn("clip_count between 1 and 5", CODE)
        self.assertIn("ordinal between 1 and 5", CODE)

    def test_the_clip_path_shape_is_the_one_the_worker_accepts(self):
        m = re.search(r"local_path ~ '([^']+)'", CODE)
        self.assertIsNotNone(m)
        self.assertEqual(m.group(1), "^output/[a-z0-9][a-z0-9-]{0,63}/repurpose/[0-9a-f]{8}/clip-[0-9]{2}[.]mp4$")
        sample = "output/the-run/repurpose/0123abcd/clip-01.mp4"
        self.assertTrue(repurpose._CLIP_PATH.match(sample) and re.match(m.group(1), sample))


class AMadeClip(unittest.TestCase):
    def test_it_is_a_held_private_short_with_no_gate_verdict(self):
        text = body("record_repurpose_clip")
        insert = text.split("insert into public.videos", 1)[1].split("update public.repurpose_clips", 1)[0]
        for needle in ("null, null,", "'pending', 'held', now(),", "'repurposed_clip'", "'short', r.video_id"):
            self.assertIn(needle, insert)
        for banned in ("'gate'", "'uploaded'", "'public'", "'unlisted'", "'approved'", "preview_path", "manifest"):
            self.assertNotIn(banned, insert, banned)
        # the id, slug and path are built here from the request, never from the worker
        for needle in ("v_vid := 'run-' || substr(encode(sha256(convert_to(r.channel_id || E'\\n' || v_slug, 'UTF8')), 'hex'), 1, 20);",
                       "v_slug := left(r.slug, 40) ||", "v_path := 'output/' || r.slug || '/repurpose/'"):
            self.assertIn(needle, text)
        self.assertNotIn("info ->> 'local_path'", text)
        self.assertNotIn("info ->> 'video_id'", text)
        self.assertNotIn("info ->> 'slug'", text)
        self.assertNotIn("info ->> 'privacy'", text)

    def test_a_clip_is_never_repurposed_again_and_a_blocked_master_is_refused(self):
        text = body("repurpose_master_state")
        for needle in ("return 'is_a_clip';", "return 'gate_blocked';", "return 'rejected';", "return 'no_manifest';",
                       "return 'no_master';", "return 'no_run';", "return 'master_too_small';"):
            self.assertIn(needle, text)

    def test_the_header_names_what_a_clip_never_does(self):
        self.assertIn("Nothing here uploads, publishes or changes", SQL)
        self.assertIn("publish_request_refusal (0029)", SQL)
        self.assertIn("never the 480p review copy", SQL.replace("\n--   ", " ").replace("\n-- ", " "))


class NoBrandNames(unittest.TestCase):
    def test_no_provider_or_model_name_in_the_migration(self):
        for word in ("minimax", "higgsfield", "kling", "veo", "seedance", "wan", "openai", "gemini", "elevenlabs",
                     "pexels", "anthropic", "claude", "sora", "runway", "luma"):
            self.assertNotRegex(SQL.lower(), rf"\b{word}\b", word)


if __name__ == "__main__":
    unittest.main()

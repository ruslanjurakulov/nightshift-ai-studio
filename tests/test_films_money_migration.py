"""Migration 0171 (Film Studio P2: quote_film, start_film, one credit hold per film segment, the worker's settle functions), read as text.

The behaviour (who may quote and start, the pin to the version and the rates, NS402 before anything is held, one start per key and under
concurrency, capture never above the hold, failure and moderation, cancel, the sweep, replay, the drift guard and the rollback) is attacked
in a real database by tests/security/test_sec_films_money.py. This file pins what must hold on every laptop, without a database: money
moves only through 0020's public reservation API and no credit function body is replaced; no price is invented; the file creates only
its own names; every function pins its search path and is revoked from every API role, with exactly two browser calls; the two replaced
constraints are supersets of the earlier files' and the rollback puts those back byte for byte; the drift guard, the end state and the
rollback pin the same bodies.
"""

import re
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
MIGRATIONS = REPO / "supabase" / "migrations"
SQL = (MIGRATIONS / "0171_films_money.sql").read_text(encoding="utf-8")
ROLLBACK = (REPO / "docs" / "sql" / "rollback_0171_films_money.sql").read_text(encoding="utf-8")
M0166 = (MIGRATIONS / "0166_films_core.sql").read_text(encoding="utf-8")
M0036 = (MIGRATIONS / "0036_creative_jobs.sql").read_text(encoding="utf-8")

BROWSER_CALLS = {"public.quote_film(uuid, integer)", "public.start_film(uuid, text, text)"}
#: Granted to signed-in callers too, and refused by owner_guard to anyone but a platform owner/admin (the 0164 switch pattern).
OWNER_CALLS = {"public.set_film_studio_enabled(boolean)"}
SERVICE_CALLS = {
    "public.film_claim_segment(text, interval)", "public.film_heartbeat_segment(uuid, text)", "public.film_begin_take(uuid, text)",
    "public.film_take_succeeded(uuid, text, numeric, uuid, uuid, text)", "public.film_take_failed(uuid, text, text, text, text, numeric)",
    "public.film_begin_assembly(uuid, text)", "public.film_record_assembly(uuid, text, boolean, uuid)",
    "public.film_settle_segment(uuid, text, text)", "public.film_cancel_segment(uuid, text)", "public.film_expire_segments()",
}
NEW_TABLES = ["film_segments", "org_film_settings", "film_quotes", "film_studio_settings"]


def code(text):
    """The SQL without its comments (a comment may name what the code must not do)."""
    return "\n".join(line.split("--", 1)[0].rstrip() for line in text.splitlines())


BODY = code(SQL)
#: The file below its drift guard (the guard names the credit functions it needs, as to_regprocedure signatures).
WORK = code(SQL.split("-- 1. Tables")[1])


def created_functions():
    out = {}
    for m in re.finditer(r"create or replace function (public\.[a-z_]+)\((.*?)\)\s*(?:returns|\n)", BODY, re.S):
        types = []
        for p in [p.strip() for p in m.group(2).split(",") if p.strip()]:
            types.append(re.split(r"\s+default\s+", p, flags=re.I)[0].split()[-1])
        out[f"{m.group(1)}({', '.join(types)})"] = m.start()
    return out


def function_header(start):
    return BODY[start:BODY.index("$$", start)]


def function_body(name):
    return re.search(rf"create or replace function public\.{name}\(.*?\$\$(.*?)\n\$\$;", BODY, re.S).group(1)


def constraint(text, name):
    return re.search(rf"add constraint {name}\n\s+(check \(.*?\));\n", code(text), re.S).group(1)


class FilmsMoneyMigration(unittest.TestCase):
    def test_the_number_is_taken_once(self):
        self.assertEqual([p.name for p in MIGRATIONS.glob("0171_*.sql")], ["0171_films_money.sql"])

    def test_money_moves_only_through_the_public_reservation_api(self):
        # 0020's four doors, called as they are; never the internals (the account lock, the ledger writer, the lots) and never a
        # direct write of a credit table. A replaced credit body would fight 0167 (credit_transactions_apply_lots, refund_purchased_credits) and every later credits file.
        for word in ("credit_account_lock", "credit_log(", "credit_release_locked", "credit_lots_", "creative_platform_reserve",
                     "insert into public.credit_", "update public.credit_", "delete from public.credit_",
                     "credit_transactions_apply_lots", "refund_purchased_credits"):
            self.assertNotIn(word, BODY, word)
        self.assertIn("perform public.reserve_credits(org, ref, total);", BODY)
        self.assertIn("got := public.capture_credits(s.credit_ref, owed, false);", BODY)
        self.assertIn("perform public.release_credits(s.credit_ref);", BODY)
        self.assertIn("public.start_credit_reservation(s.credit_ref, s.org_id)", BODY)
        # The capture is never allowed over the hold.
        self.assertEqual(re.findall(r"capture_credits\([^)]*\)", WORK), ["capture_credits(s.credit_ref, owed, false)"])

    def test_no_function_of_another_file_is_replaced_and_no_price_is_seeded(self):
        for name in re.findall(r"create or replace function public\.([a-z_]+)\(", BODY):
            self.assertRegex(name, r"^(film_[a-z_]+|quote_film|start_film|set_film_studio_enabled)$")
        p1 = set(re.findall(r"create or replace function public\.([a-z_]+)\(", code(M0166)))
        self.assertFalse(p1 & set(re.findall(r"create or replace function public\.([a-z_]+)\(", BODY)))
        # credits_per_unit is NOT NULL and a number would be a guess: the assembly is unpriced until an admin sets it.
        self.assertNotRegex(BODY, r"insert into public\.credit_prices")
        self.assertIn("'film_assembly_minute'", BODY)
        self.assertNotIn("drop table", BODY)
        self.assertNotIn("drop function", BODY)

    def test_nothing_publishes_renders_or_queues_a_job(self):
        for word in ("insert into public.render_jobs", "insert into public.creative_jobs", "publish_requests", "visibility_requests",
                     "create_creative_job", "pg_notify", "net.http"):
            self.assertNotIn(word, BODY, word)

    def test_every_function_pins_its_search_path_and_is_revoked_from_every_api_role(self):
        funcs = created_functions()
        self.assertGreaterEqual(len(funcs), 24)
        for sig, start in funcs.items():
            header = function_header(start)
            self.assertIn("set search_path = public, pg_temp", header, sig)
            self.assertIn(f"revoke all on function {sig} from public, anon, authenticated, service_role;", BODY, sig)

    def test_exactly_two_browser_calls_and_the_state_machine_is_the_service_roles(self):
        granted = re.findall(r"grant execute on function (public\.[^;]+?) to ([a-z_, ]+);", BODY)
        self.assertEqual({sig for sig, who in granted if who == "authenticated"}, BROWSER_CALLS | OWNER_CALLS)
        self.assertEqual({sig for sig, who in granted if who == "service_role"}, SERVICE_CALLS)
        self.assertEqual({who for _, who in granted}, {"authenticated", "service_role"})
        for sig in BROWSER_CALLS | SERVICE_CALLS:
            self.assertIn("security definer", function_header(created_functions()[sig]), sig)
        # An editor quotes; an admin starts (0020's rule for a paid run), and the platform admin alone in the exempt organization.
        self.assertIn("if not public.is_org_member(org, 'editor') then", function_body("quote_film"))
        self.assertIn("if not public.is_org_member(org, 'admin') or (exempt_ and not public.is_platform_admin()) then",
                      function_body("start_film"))
        self.assertIn("g := public.owner_guard('film_studio', 10);", function_body("set_film_studio_enabled"))
        self.assertIn("perform public.security_event_log('film_studio.enabled'", function_body("set_film_studio_enabled"))

    def test_the_new_tables_have_rls_and_no_api_role_writes_them(self):
        for t in NEW_TABLES:
            self.assertIn(f"create table if not exists public.{t} (", BODY)
            self.assertIn(f"alter table public.{t} enable row level security;", BODY)
        for t in ("film_segments", "org_film_settings"):
            self.assertIn(f"create policy {t}_select on public.{t}\n  for select to authenticated", BODY)
        for t in ("film_quotes", "film_studio_settings"):
            self.assertNotIn(f"policy {t}_", BODY)
        self.assertIn("revoke all on public.film_segments, public.org_film_settings, public.film_quotes, public.film_studio_settings\n"
                      "  from public, anon, authenticated, service_role;", BODY)
        for grant in re.findall(r"grant ([a-z, ]+?)(?: \(| on (?!function))", BODY):
            self.assertEqual(grant.strip(), "select", grant)
        auth = dict((t, cols) for cols, t in re.findall(r"grant select \(([^)]*)\)\s+on public\.(\w+) to authenticated;", BODY))
        self.assertEqual(set(auth), {"film_segments", "org_film_settings", "film_takes"})
        for hidden in ("request_hash", "worker_id"):
            self.assertNotIn(hidden, auth["film_segments"])
        self.assertNotIn("provider_task_id", auth["film_takes"])

    def test_one_hold_per_segment_named_fm_and_valid_for_0020(self):
        self.assertIn("ref := 'fm-' || replace(sid::text, '-', '');", BODY)
        job_re = re.search(r"check \(job_id ~ '(.*?)'\)", (MIGRATIONS / "0020_credits.sql").read_text(encoding="utf-8")).group(1)
        self.assertEqual(job_re, "^[A-Za-z0-9][A-Za-z0-9:_-]{0,79}$")
        self.assertRegex("fm-" + "0" * 32, job_re)
        self.assertIn("create unique index if not exists film_segments_live_key on public.film_segments (film_id)\n"
                      "  where status in ('queued', 'running', 'draining');", BODY)
        self.assertEqual(WORK.count("public.reserve_credits("), 1)

    def test_the_two_replaced_constraints_are_supersets_and_the_rollback_restores_the_originals(self):
        before = constraint(M0166, "films_status_check")
        after = constraint(SQL, "films_status_check")
        self.assertEqual(after, before.replace("'planned', 'running'", "'planned', 'queued', 'running'"))
        self.assertEqual(constraint(ROLLBACK, "films_status_check"), before)
        payer_before = constraint(M0036, "creative_jobs_payer_check")
        self.assertEqual(payer_before, "check (payer in ('credits', 'api_balance'))")
        self.assertEqual(constraint(SQL, "creative_jobs_payer_check"), "check (payer in ('credits', 'api_balance', 'film'))")
        self.assertEqual(constraint(ROLLBACK, "creative_jobs_payer_check"), payer_before)
        self.assertIn("check (((payer = 'film') = (film_take_id is not null)) and (payer <> 'film' or credit_ref is null));", BODY)

    def test_moderation_billing_follows_the_scout_facts(self):
        body = function_body("film_moderation_billing")
        self.assertIn("when m.adapter = 'video.runway' then 'billed'", body)
        self.assertIn("when m.adapter = 'video.happyhorse' or m.adapter like 'video.seedance%' then 'not_billed'", body)
        self.assertIn("'unknown')", body)
        failed = function_body("film_fail_locked")
        self.assertIn("'moderated_vendor_billed'", failed)
        self.assertIn("'moderated_vendor_billing_unknown'", failed)
        # L1 (owner policy: match the Studio): a take that delivers nothing is charged nothing, whatever the vendor billed.
        self.assertNotIn("charge := t.confirmed_credits", failed)
        self.assertNotIn("charge := least", failed)
        self.assertIn("'partial_not_delivered'", failed)
        # M1: what a failed take's creative job registered is soft-deleted with it.
        self.assertIn("perform public.film_discard_assets(t.org_id,", failed)
        # One retry within the line, charged 0 (the platform carries the failed try); never for a lost worker.
        self.assertIn("charged_credits = 0, charge_basis = 'retried_not_charged'", failed)
        self.assertIn("and p_failure <> 'worker_lost' then", failed)

    def test_a_take_is_never_charged_above_its_line_and_a_clip_is_judged_by_its_own_measured_length(self):
        self.assertIn("charged_credits between 0 and confirmed_credits", BODY)
        ok = function_body("film_take_succeeded")
        self.assertIn("select a.duration_s into secs from public.media_assets a where a.id = p_result_asset;", ok)
        self.assertIn("(public.film_money_limits() ->> 'min_clip_fraction')::numeric * coalesce(t.duration_s, t.quantity)", ok)
        self.assertIn("set status = 'completed', charged_credits = confirmed_credits", ok)
        self.assertIn("if p_provider_task_id is null", ok)
        self.assertIn("not (p_output_seconds >= 0.01 and p_output_seconds <= 600)", ok)
        self.assertNotIn("p_output_seconds *", ok)  # the number handed to the call is never what is charged
        self.assertIn("perform public.film_discard_assets(t.org_id, array[p_result_asset, p_last_frame_asset]);", ok)
        asm = function_body("film_record_assembly")
        self.assertIn("select a.duration_s into secs from public.media_assets a where a.id = p_result_asset;", asm)
        self.assertNotIn("p_output_seconds", asm)
        self.assertIn("if owed > s.confirmed_credits then", function_body("film_settle_locked"))

    def test_unknown_is_never_zero_in_the_quote(self):
        price = function_body("film_price")
        self.assertIn("""l || '{"credits": null}'::jsonb""", price)
        self.assertIn("total := null;", price)
        self.assertIn("'quote_id', case when total is not null", price)
        # Only the two functions' own refusals are caught, never every error.
        for fn in ("film_try_price", "film_model_problem"):
            self.assertIn("exception when sqlstate 'NS400' then", function_body(fn))
            self.assertNotIn("when others", function_body(fn))

    def test_the_lock_order_is_film_then_segment_then_take(self):
        lock = function_body("film_lock_segment")
        self.assertLess(lock.index("from public.films where id = fid for no key update"),
                        lock.index("from public.film_segments where id = p_segment for update"))
        take = function_body("film_lock_take")
        self.assertLess(take.index("public.film_lock_segment(seg, p_worker, true)"), take.index("for update"))
        claim = function_body("film_claim_segment")
        self.assertLess(claim.index("from public.films where id = c.film_id for no key update skip locked"),
                        claim.index("from public.film_segments where id = c.id for update skip locked"))
        start = function_body("start_film")
        self.assertLess(start.index("pg_advisory_xact_lock"), start.index("for no key update"))
        self.assertLess(start.index("for no key update"), start.index("public.reserve_credits("))

    def test_the_time_limits_sit_inside_0020s_expiry(self):
        lim = dict((k, int(v)) for k, v in re.findall(r"'([a-z_]+)', (\d+)(?![.\d])", function_body("film_money_limits")))
        # A take still in flight is ended, and the segment settled, while 0020 still keeps the hold open (24 h after its start).
        self.assertLess(lim["deadline_hours"] + lim["grace_hours"], 24)
        self.assertLess(lim["grace_hours"], 4)
        self.assertLessEqual(lim["unclaimed_hours"], 3)
        self.assertIn("'min_clip_fraction', 0.9", function_body("film_money_limits"))

    def test_every_refusal_word_is_listed_in_the_header(self):
        header = SQL.split("set local lock_timeout")[0]
        words = set(re.findall(r"creative_refuse\('([a-z_]+)'", BODY))
        for w in words:
            self.assertIn(w, header, w)

    def test_the_drift_guard_the_end_state_and_the_rollback_pin_the_same_bodies(self):
        guard = dict(re.findall(r"\('(public\.[a-z_]+\([^)]*\))', '([0-9a-f]{32})'\)", SQL.split("-- 1. Tables")[0]))
        self.assertEqual(set(guard), set(created_functions()))
        self.assertNotIn("0" * 32, guard.values())
        end = dict(re.findall(r"\('(public\.[a-z_]+\([^)]*\))', '([0-9a-f]{32})'\)", SQL.split("-- 6. The end state")[1]))
        self.assertGreaterEqual(len(end), 5)
        for sig, h in end.items():
            self.assertEqual(guard[sig], h, sig)
        pinned = dict(re.findall(r"\('(public\.[a-z_]+\([^)]*\))', '([0-9a-f]{32})'\)", ROLLBACK))
        self.assertEqual(set(pinned), set(created_functions()))
        for sig, h in pinned.items():
            self.assertEqual(guard[sig], h, sig)

    def test_the_rollback_drops_exactly_what_the_file_creates(self):
        rb = code(ROLLBACK)
        dropped = {re.sub(r"\s+", " ", s) for s in re.findall(r"drop function (public\.[a-z_]+\([^)]*\));", rb)}
        self.assertEqual(dropped, set(created_functions()))
        self.assertEqual(set(re.findall(r"drop table public\.([a-z_]+);", rb)), set(NEW_TABLES))
        added = set(re.findall(r"alter table public\.film_takes add column if not exists ([a-z_]+)", BODY))
        self.assertEqual(set(re.findall(r"alter table public\.film_takes drop column if exists ([a-z_]+);", rb)), added)
        # Every body the file creates is pinned by the rollback (a later change would be undone).
        pinned = set(re.findall(r"\('(public\.[a-z_]+\([^)]*\))', '[0-9a-f]{32}'\)", ROLLBACK))
        self.assertEqual(pinned, set(created_functions()))
        self.assertIn("alter table public.creative_jobs drop column if exists film_take_id;", rb)
        self.assertIn("-- set local nightshift.rollback_0171_discard_segments = 'on';", ROLLBACK)
        # The functions the "a later migration reads film_segments" check spares are this file's own.
        spared = set(re.findall(r"'([a-z_]+)'", re.search(r"p\.proname not in \((.*?)\);", rb, re.S).group(1)))
        reading = {name for sig, start in created_functions().items()
                   for name in [sig.split("(")[0].split(".")[1]] if "film_segments" in function_body(name)}
        self.assertTrue(reading <= spared, reading - spared)
        self.assertTrue(spared <= {sig.split("(")[0].split(".")[1] for sig in created_functions()}, spared)

    def test_it_is_idempotent_guarded_and_verifiable(self):
        self.assertIn("set local lock_timeout", BODY)
        self.assertNotRegex(BODY, r"create table public\.")
        self.assertNotRegex(BODY, r"create (unique )?index (?!if not exists)")
        self.assertEqual(len(re.findall(r"create policy", BODY)), len(re.findall(r"drop policy if exists", BODY)))
        for name in re.findall(r"add constraint (\w+)\n\s+check", BODY):
            self.assertIn(f"drop constraint if exists {name};", BODY, name)
        self.assertIn("-- Verify", SQL)
        self.assertIn("docs/sql/rollback_0171_films_money.sql", SQL)


if __name__ == "__main__":
    unittest.main()

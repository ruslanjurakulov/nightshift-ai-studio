"""supabase/migrations/0164_public_site_stats.sql — the site's live public counters, hidden behind an administrator's switch.

SQL does not run in this suite (tests/security/test_sec_public_stats.py does that, against a real Postgres); these pin what must
never change by accident: the switch is a new one-row table that starts OFF and no API role can touch; the public read is the only
anon door and answers {"visible": false} and nothing else while the switch is off, while nothing is stored, and while fewer than 5
customer workspaces are counted (the k rule against inference by difference); anon never measures on demand and a read-only GET
never errors; the switch's writer is a platform owner/admin's (or the SQL editor's, an allow-list) and writes an audit row; the
read hands out the named aggregate keys only (no org, user, channel, video, title or counted_orgs) and the last run only to the
hour; nothing is coalesced to 0; the operator's own and staff workspaces are left out by id; pg_cron refreshes where installed;
the md5 in the drift guard, the end state and the rollback is each body's own; the number is unique and the numbering tests list it.
"""

import hashlib
import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MIG = ROOT / "supabase" / "migrations"
SQL = (MIG / "0164_public_site_stats.sql").read_text(encoding="utf-8")
ROLLBACK = (ROOT / "docs" / "sql" / "rollback_0164_public_site_stats.sql").read_text(encoding="utf-8")
MIGRATIONS_DOC = (ROOT / "docs" / "MIGRATIONS.md").read_text(encoding="utf-8")
PUBLIC_STATS_DOC = (ROOT / "docs" / "PUBLIC_STATS.md").read_text(encoding="utf-8")
CODE = "\n".join(line.split("--", 1)[0] for line in SQL.splitlines())
FUNCS = ("public_site_stats_measure", "public_site_stats_refresh", "public_site_stats", "set_public_stats_visible")
SIG = {"public_site_stats_measure": "public.public_site_stats_measure()", "public_site_stats_refresh": "public.public_site_stats_refresh()",
       "public_site_stats": "public.public_site_stats()", "set_public_stats_visible": "public.set_public_stats_visible(boolean)"}
EDITOR = ("invoker not in ('anon', 'authenticated', 'service_role', 'authenticator')",
          "pg_has_role(invoker::name, 'postgres', 'member')")


def definition(name: str) -> str:
    m = re.search(r"^create or replace function public\.%s\(.*?^\$\$;$" % name, SQL, re.S | re.M)
    assert m, name
    return m.group(0)


def body(name: str) -> str:
    return definition(name).split("as $$", 1)[1].rsplit("$$;", 1)[0]


def pg_md5(name: str) -> str:
    """md5(regexp_replace(prosrc, '\\s+', ' ', 'g')), the hash every drift guard in this repository uses."""
    return hashlib.md5(re.sub(r"\s+", " ", body(name)).encode()).hexdigest()


class PublicSiteStatsMigration(unittest.TestCase):
    def test_four_functions_one_new_table_and_nothing_replaced(self):
        self.assertEqual(re.findall(r"create or replace function public\.(\w+)\(", CODE), list(FUNCS))
        self.assertEqual(re.findall(r"create table if not exists (\S+)", CODE), ["public.site_settings"])
        self.assertEqual(re.findall(r"(?m)^alter table (\S+)", CODE), ["public.site_settings"])
        self.assertNotRegex(CODE, r"create (unique )?index|drop |create (or replace )?view|create policy|create trigger")

    def test_the_switch_starts_off_in_one_row_no_api_role_can_touch(self):
        self.assertIn("public_stats_visible boolean not null default false,", SQL)
        self.assertIn("id                   boolean primary key default true check (id),", SQL)
        self.assertIn("insert into public.site_settings (id) values (true) on conflict (id) do nothing;", SQL)
        self.assertIn("alter table public.site_settings enable row level security;", SQL)
        self.assertIn("revoke all on public.site_settings from public, anon, authenticated, service_role;", SQL)
        self.assertNotRegex(CODE, r"grant [a-z, ]+ on (table )?public\.site_settings")
        # A missing row reads as hidden: never "visible because nothing said otherwise".
        self.assertIn("shown := coalesce(s.public_stats_visible, false);", body("public_site_stats"))

    def test_definers_with_a_pinned_search_path(self):
        for name in FUNCS:
            head = definition(name).split("as $$", 1)[0]
            self.assertIn("security definer set search_path = public, pg_temp", head, name)

    def test_anon_executes_the_read_only_and_nobody_executes_the_measurement_or_the_refresh(self):
        for name in FUNCS:
            self.assertIn(f"revoke all on function {SIG[name]} from public, anon, authenticated, service_role;", SQL)
        grants = re.findall(r"(?m)^grant execute on function (\S+) to (.+);$", CODE)
        self.assertEqual(grants, [("public.public_site_stats()", "anon, authenticated"),
                                  ("public.set_public_stats_visible(boolean)", "authenticated")])

    def test_the_end_state_asserts_owner_and_every_table_privilege(self):
        self.assertIn("pg_get_userbyid(p.proowner) from pg_proc p where p.oid = to_regprocedure(pair[1])) is distinct from 'postgres'", SQL)
        self.assertIn("foreach r in array array['anon', 'authenticated', 'service_role'] loop", SQL)
        self.assertIn("foreach p in array array['select', 'insert', 'update', 'delete'] loop", SQL)
        self.assertIn("if has_table_privilege(r, 'public.site_settings', p) then", SQL)

    def test_the_sql_editor_is_an_allow_list_in_both_functions(self):
        for name in ("public_site_stats", "set_public_stats_visible"):
            b = body(name)
            for needle in EDITOR:
                self.assertIn(needle, b, name)
            self.assertIn("then session_user::text", b, name)
            self.assertIn("coalesce(nullif(current_setting('request.jwt.claims', true), ''), '') = ''", b, name)

    def test_the_public_read_is_hidden_until_switched_on_stored_and_k_reached(self):
        b = body("public_site_stats")
        self.assertIn("k_min   constant integer := 5;", b)
        hidden = b.index("if not shown or s.stats is null or s.stats_at is null then\n    return jsonb_build_object('visible', false);")
        k_rule = b.index("if coalesce((v ->> 'counted_orgs')::integer, 0) < k_min then\n    return jsonb_build_object('visible', false);")
        shown = b.index("return (v - 'counted_orgs') || jsonb_build_object('visible', true, 'as_of', v_at);")
        self.assertLess(hidden, k_rule)
        self.assertLess(k_rule, shown)
        # The preview (editor or platform admin) carries the count of workspaces; nothing else does.
        preview = b[b.index("if preview then"):b.index("end if;", b.index("if preview then"))]
        self.assertIn("'min_counted_orgs', k_min", preview)
        self.assertIn("shown and coalesce((v ->> 'counted_orgs')::integer, 0) >= k_min", preview)
        self.assertEqual(b.count("return "), 4)

    def test_anon_never_measures_when_nothing_is_stored_and_a_get_never_errors(self):
        b = body("public_site_stats")
        stale = b.index("if v_at <= now() - interval '15 minutes' and pg_try_advisory_xact_lock(hashtext('public.public_site_stats')) then")
        self.assertLess(b.index("if not shown or s.stats is null"), stale)
        self.assertIn("exception when read_only_sql_transaction then\n      null;", b)
        self.assertIn("update public.site_settings set stats = v, stats_at = v_at where id;", b)
        # The only measurement outside the preview and the 15-minute refresh is the switch's and the cron's.
        self.assertEqual(b.count("public.public_site_stats_measure()"), 2)

    def test_turning_it_on_takes_the_first_measurement_and_cron_refreshes_where_installed(self):
        self.assertIn("if p_visible then\n    perform public.public_site_stats_refresh();", body("set_public_stats_visible"))
        r = body("public_site_stats_refresh")
        self.assertLess(r.index("return false;"), r.index("update public.site_settings set stats = public.public_site_stats_measure()"))
        self.assertIn("perform cron.schedule('nightshift-public-site-stats', '*/10 * * * *', 'select public.public_site_stats_refresh()');", SQL)
        self.assertIn("perform cron.unschedule('nightshift-public-site-stats');", SQL)
        self.assertIn("to_regprocedure('cron.schedule(text, text, text)') is not null", SQL)
        self.assertIn("perform cron.unschedule('nightshift-public-site-stats');", ROLLBACK)

    def test_the_switch_is_an_admins_or_the_sql_editors_and_a_change_is_audited(self):
        b = body("set_public_stats_visible")
        guard = b.index("g := public.owner_guard('public_stats', 10);")
        self.assertLess(guard, b.index("public.site_settings"))
        self.assertIn("raise exception 'set_public_stats_visible takes true or false' using errcode = '22023';", b)
        self.assertIn("for update;", b)
        change = b.index("if was is distinct from p_visible then")
        audit = b.index("perform public.security_event_log('site.public_stats', 'notice', 'public_stats_visible',")
        self.assertLess(change, audit)
        self.assertIn("'via', case when editor then 'sql_editor' else 'admin' end", b)
        # The audit row is not swallowed: no exception handler around it.
        self.assertNotIn("exception when", b.lower())

    def test_the_output_names_only_the_aggregates(self):
        measure = body("public_site_stats_measure")
        keys = re.findall(r"^    '(\w+)',$", measure, re.M)
        self.assertEqual(keys, ["videos_rendered", "videos_uploaded_private", "videos_approved", "studio_generations", "last_run_at",
                                "counted_orgs"])
        # Every value is an aggregate: count or a truncated max, never a selected column.
        for value in re.split(r"^    '\w+',$", measure, flags=re.M)[1:]:
            self.assertRegex(value.strip(), r"^\(select (count\(\*\)|count\(distinct \(a\.channel_id, a\.video_id\)\)|count\(distinct o\.org_id\)"
                                            r"|date_trunc\('hour', max\(u\.finished_at\) at time zone 'UTC'\) at time zone 'UTC') from ", value)
        for word in ("title", "topic", "email", "slug", "name", "jsonb_agg", "array_agg", "string_agg"):
            self.assertNotIn(word, measure.lower(), word)
        read = body("public_site_stats")
        self.assertIn("(v - 'counted_orgs')", read)

    def test_nulls_are_never_coalesced_to_zero(self):
        self.assertNotRegex(body("public_site_stats_measure"), r"coalesce\(")
        # The only coalesce to 0 is the k rule's, where a missing count must mean "hidden", never "shown".
        for m in re.finditer(r"coalesce\(([^()]|\([^()]*\))*,\s*0\)", body("public_site_stats")):
            self.assertIn("counted_orgs", m.group(0))

    def test_the_operators_own_and_staff_workspaces_are_left_out_by_id(self):
        m = body("public_site_stats_measure")
        self.assertEqual(m.count("public.default_org_id()"), 1)
        self.assertEqual(m.count("from public.org_members m join public.app_members a on a.user_id = m.user_id"), 1)
        self.assertNotIn("a.email", m)
        self.assertIn("where c.org_id is not null", m)
        self.assertEqual(m.count("not exists (select 1 from internal x where x.org_id ="), 2)
        self.assertEqual(m.count("join counted k on k.channel_id ="), 4)

    def test_what_each_count_counts(self):
        m = body("public_site_stats_measure")
        self.assertIn("where v.cut_sha256 is not null or v.published_at is not null or v.publish_state = 'uploaded'", m)
        self.assertIn("v.privacy = 'private'", m)
        self.assertIn("r.before_privacy = 'private'", m)
        self.assertIn("i.action = 'approve' and i.approved_cut_sha256 is not null and i.created_by is not null", m)
        self.assertIn("j.status = 'completed'", m)
        self.assertIn("r.status = 'succeeded' and r.kind in ('daily', 'repair') and r.finished_at is not null", m)
        self.assertNotRegex(m.lower(), r"percent|\bratio\b|::numeric|\s/\s")

    def test_the_md5_in_the_guard_the_end_state_and_the_rollback_is_each_bodys_own(self):
        for name in FUNCS:
            h = pg_md5(name)
            self.assertEqual(SQL.count(f"['{SIG[name]}', '{h}']"), 2, name)
            self.assertIn(f"['{SIG[name]}', '{h}']", ROLLBACK, name)
            self.assertIn(h, MIGRATIONS_DOC, name)

    def test_prerequisites_are_checked_first_and_it_is_one_transaction(self):
        self.assertIn("set local lock_timeout", CODE)
        self.assertIn("APPLY AS ONE TRANSACTION", SQL)
        self.assertIn("WHAT TO VERIFY BEFORE YOU APPLY", SQL)
        self.assertIn("-- Verify (run after applying", SQL)
        first = SQL.index("create table if not exists public.site_settings (")
        for needle in ("0164 needs 0007", "0164 needs 0018", "0164 needs 0017", "0164 needs 0036", "0164 needs 0107",
                       "0164 needs 0116", "0164 needs videos.publish_state", "0164 needs videos.cut_sha256", "0164 found %"):
            self.assertLess(SQL.index(needle), first, needle)

    def test_the_rollback_refuses_a_foreign_body_drops_only_this_and_is_one_transaction(self):
        self.assertEqual(len(re.findall(r"(?m)^begin;$", ROLLBACK)), 1)
        self.assertEqual(len(re.findall(r"(?m)^commit;$", ROLLBACK)), 1)
        self.assertEqual(re.findall(r"(?m)^drop .*$", ROLLBACK), [
            "drop function if exists public.set_public_stats_visible(boolean);",
            "drop function if exists public.public_site_stats();",
            "drop function if exists public.public_site_stats_refresh();",
            "drop function if exists public.public_site_stats_measure();",
            "drop table if exists public.site_settings;"])

    def test_the_one_command_and_the_k_rule_are_documented(self):
        for line in ("select public.set_public_stats_visible(true);", "select public.set_public_stats_visible(false);"):
            self.assertIn(line, PUBLIC_STATS_DOC)
            self.assertIn(line, SQL)
        self.assertIn("at least 5", PUBLIC_STATS_DOC)
        self.assertIn("counted_orgs", PUBLIC_STATS_DOC)

    def test_the_number_is_unique_documented_and_0163_is_not_taken(self):
        numbers = sorted(p.name[:4] for p in MIG.glob("*.sql"))
        self.assertEqual(numbers.count("0164"), 1)
        self.assertNotIn("0163", numbers, "0163 belongs to #736: if it merged, re-read this file against it")
        self.assertIn("## The site's live public counters (0164)", MIGRATIONS_DOC)
        self.assertIn("0164_public_site_stats.sql", (ROOT / "tests" / "security" / "sec_db.py").read_text(encoding="utf-8"))


if __name__ == "__main__":
    unittest.main()

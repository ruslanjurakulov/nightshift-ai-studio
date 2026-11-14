"""supabase/migrations/0164_public_site_stats.sql — the site's live public counters, hidden behind an administrator's switch.

SQL does not run in this suite (tests/security/test_sec_public_stats.py does that, against a real Postgres); these pin what must
never change by accident: the switch is a new one-row table that starts OFF and no API role can touch; the public read is the only
anon door and, while hidden, answers {"visible": false} and nothing else; the switch's writer is a platform owner/admin's (or the
SQL editor's) and writes an audit row; the read hands out the named aggregate keys only (no org, user, channel, video or title);
nothing is coalesced to 0; the operator's own and staff workspaces are left out by id; the md5 in the drift guard, the end state and
the rollback is each body's own; the number is unique and the numbering tests list it.
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
FUNCS = ("public_site_stats_measure", "public_site_stats", "set_public_stats_visible")
SIG = {"public_site_stats_measure": "public.public_site_stats_measure()", "public_site_stats": "public.public_site_stats()",
       "set_public_stats_visible": "public.set_public_stats_visible(boolean)"}


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
    def test_three_functions_one_new_table_and_nothing_replaced(self):
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

    def test_anon_executes_the_read_only_and_nobody_executes_the_measurement(self):
        for name in FUNCS:
            self.assertIn(f"revoke all on function {SIG[name]} from public, anon, authenticated, service_role;", SQL)
        grants = re.findall(r"(?m)^grant execute on function (\S+) to (.+);$", CODE)
        self.assertEqual(grants, [("public.public_site_stats()", "anon, authenticated"),
                                  ("public.set_public_stats_visible(boolean)", "authenticated")])

    def test_hidden_the_read_answers_visible_false_and_nothing_else_before_it_measures(self):
        b = body("public_site_stats")
        hidden = b.index("if not shown and not preview then\n    return jsonb_build_object('visible', false);")
        self.assertLess(hidden, b.index("public.public_site_stats_measure()"))
        self.assertLess(hidden, b.index("s.stats ||"))
        # Only the SQL editor (no claims AND no API role) and a signed-in platform admin preview the numbers.
        self.assertIn("coalesce(current_setting('role', true), 'none') not in ('anon', 'authenticated', 'service_role')", b)
        self.assertIn("(auth.uid() is not null and public.is_platform_admin())", b)

    def test_anon_cannot_make_it_count_every_call(self):
        b = body("public_site_stats")
        self.assertIn("s.stats_at > now() - interval '5 minutes'", b)
        self.assertIn("pg_try_advisory_xact_lock(hashtext('public.public_site_stats'))", b)
        self.assertIn("update public.site_settings set stats = v, stats_at = v_at where id;", b)
        # as_of is when the numbers were measured, never "now" for an older snapshot.
        self.assertEqual(b.count("jsonb_build_object('visible', true, 'as_of', s.stats_at)"), 2)

    def test_the_switch_is_an_admins_or_the_sql_editors_and_a_change_is_audited(self):
        b = body("set_public_stats_visible")
        guard = b.index("g := public.owner_guard('public_stats', 10);")
        self.assertLess(guard, b.index("public.site_settings"))
        self.assertIn("coalesce(current_setting('role', true), 'none') not in ('anon', 'authenticated', 'service_role')", b)
        self.assertIn("raise exception 'set_public_stats_visible takes true or false' using errcode = '22023';", b)
        self.assertIn("for update;", b)
        change = b.index("if was is distinct from p_visible then")
        audit = b.index("perform public.security_event_log('site.public_stats', 'notice', 'public_stats_visible',")
        self.assertLess(change, audit)
        self.assertIn("'via', case when editor then 'sql_editor' else 'admin' end", b)
        # The audit row is not swallowed: no exception handler around it.
        self.assertNotIn("exception when", b.lower())

    def test_the_output_names_only_the_aggregates(self):
        keys = re.findall(r"^    '(\w+)',$", body("public_site_stats_measure"), re.M)
        self.assertEqual(keys, ["videos_rendered", "videos_uploaded_private", "videos_approved", "studio_generations", "last_run_at"])
        read = body("public_site_stats")
        self.assertEqual(sorted(set(re.findall(r"jsonb_build_object\('(\w+)'", read))), ["visible"])
        self.assertEqual(sorted(set(re.findall(r"'(as_of|visible)'", read))), ["as_of", "visible"])
        measure = body("public_site_stats_measure")
        # Every value is an aggregate: count or max, never a selected column.
        for value in re.split(r"^    '\w+',$", measure, flags=re.M)[1:]:
            self.assertRegex(value.strip(), r"^\(select (count\(\*\)|count\(distinct i\.video_id\)|max\(r\.finished_at\)) from ", value)
        for word in ("title", "topic", "email", "slug", "name", "jsonb_agg", "array_agg", "string_agg"):
            self.assertNotIn(word, measure.lower(), word)

    def test_nulls_are_never_coalesced_to_zero(self):
        for name in ("public_site_stats_measure", "public_site_stats"):
            self.assertNotRegex(body(name), r"coalesce\([^)]*,\s*0\)", name)
        self.assertNotRegex(body("public_site_stats_measure"), r"coalesce\(")

    def test_the_operators_own_and_staff_workspaces_are_left_out_by_id(self):
        m = body("public_site_stats_measure")
        self.assertEqual(m.count("public.default_org_id()"), 2)
        self.assertEqual(m.count("from public.org_members m join public.app_members a on a.user_id = m.user_id"), 2)
        self.assertNotIn("a.email", m)
        self.assertIn("where c.org_id is not null", m)
        # Every per-channel source goes through the counted channels.
        self.assertEqual(m.count("channel_id in (select k.channel_id from counted k)"), 4)

    def test_what_each_count_counts(self):
        m = body("public_site_stats_measure")
        self.assertIn("(v.cut_sha256 is not null or v.published_at is not null or v.publish_state = 'uploaded')", m)
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
            "drop function if exists public.public_site_stats_measure();",
            "drop table if exists public.site_settings;"])

    def test_the_one_command_is_documented_exactly(self):
        for line in ("select public.set_public_stats_visible(true);", "select public.set_public_stats_visible(false);"):
            self.assertIn(line, PUBLIC_STATS_DOC)
            self.assertIn(line, SQL)

    def test_the_number_is_unique_documented_and_0163_is_not_taken(self):
        numbers = sorted(p.name[:4] for p in MIG.glob("*.sql"))
        self.assertEqual(numbers.count("0164"), 1)
        self.assertNotIn("0163", numbers, "0163 belongs to #736: if it merged, re-read this file against it")
        self.assertIn("## The site's live public counters (0164)", MIGRATIONS_DOC)
        self.assertIn("0164_public_site_stats.sql", (ROOT / "tests" / "security" / "sec_db.py").read_text(encoding="utf-8"))


if __name__ == "__main__":
    unittest.main()

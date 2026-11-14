"""Migration 0166 (Film Studio P1: films, the storyboard, references, takes and film_events), read as text.

The behaviour (tenancy, no direct writes, draft only, versions and the lock, one event per change, the limits, frame roles, the Seedance
refusal, idempotency, the replay and the rollback) is attacked in a real database by tests/security/test_sec_films_core.py. This file
pins what must hold on every laptop, without a database: nothing in the file spends, holds or queues; it touches no existing table or
function; every table has RLS and no API role is granted a write; every function pins its search path and is revoked from every API
role, and only the four browser calls are granted; the limits film_limits() hands the app are the ones the table checks enforce; the
replay guard and the rollback cover exactly what the file creates.
"""

import re
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
MIGRATIONS = REPO / "supabase" / "migrations"
SQL = (MIGRATIONS / "0166_films_core.sql").read_text(encoding="utf-8")
ROLLBACK = (REPO / "docs" / "sql" / "rollback_0166_films_core.sql").read_text(encoding="utf-8")

TABLES = ["films", "film_scenes", "film_refs", "film_takes", "film_events"]
BROWSER_CALLS = {
    "public.film_json(uuid)",
    "public.create_film_draft(uuid, text, text, text, jsonb, text)",
    "public.save_film(uuid, integer, jsonb)",
    "public.archive_film(uuid)",
}


def code(text):
    """The SQL without its comments (a comment may name what the code must not do)."""
    return "\n".join(line.split("--", 1)[0].rstrip() for line in text.splitlines())


BODY = code(SQL)


def created_functions():
    """Every `create or replace function public.x(...)` of the file, as its identity signature `public.x(type, type)`."""
    out = {}
    for m in re.finditer(r"create or replace function (public\.[a-z_]+)\((.*?)\)\s*(?:returns|\n)", BODY, re.S):
        params = [p.strip() for p in m.group(2).split(",") if p.strip()]
        types = []
        for p in params:
            p = re.split(r"\s+default\s+", p, flags=re.I)[0].split()
            types.append(p[-1])
        out[f"{m.group(1)}({', '.join(types)})"] = m.start()
    return out


def function_header(start):
    """From `create or replace function` to the body's opening `$$`: where language, security and search_path are declared."""
    return BODY[start:BODY.index("$$", start)]


class FilmsCoreMigration(unittest.TestCase):
    def test_the_number_is_taken_once(self):
        self.assertEqual([p.name for p in MIGRATIONS.glob("0166_*.sql")], ["0166_films_core.sql"])

    def test_nothing_in_the_file_spends_holds_queues_or_publishes(self):
        for word in ("reserve_credits", "capture_credits", "release_credits", "start_credit_reservation", "grant_credits",
                     "create_creative_job", "insert into public.creative_jobs", "insert into public.render_jobs",
                     "credit_transactions", "credit_reservations", "publish_requests", "visibility_requests",
                     "pg_notify", "http_post", "net.http"):
            self.assertNotIn(word, BODY, word)

    def test_it_touches_no_existing_table_or_function(self):
        altered = set(re.findall(r"alter table public\.([a-z_]+)", BODY))
        self.assertEqual(altered, set(TABLES))
        created = {sig.split("(")[0] for sig in created_functions()}
        for name in created:
            self.assertRegex(name, r"^public\.(film_[a-z_]+|create_film_draft|save_film|archive_film)$")
        self.assertNotIn("drop table", BODY)
        self.assertNotIn("drop function", BODY)

    def test_every_table_has_rls_and_no_api_role_is_granted_a_write(self):
        for t in TABLES:
            self.assertIn(f"create table if not exists public.{t} (", BODY)
            self.assertIn(f"alter table public.{t} enable row level security;", BODY)
            self.assertIn(f"create policy {t}_select on public.{t}\n  for select to authenticated", BODY)
        self.assertIn("revoke all on public.films, public.film_scenes, public.film_refs, public.film_takes, public.film_events\n"
                      "  from public, anon, authenticated, service_role;", BODY)
        for grant in re.findall(r"grant ([a-z, ]+?) on (?!function)", BODY):
            self.assertEqual(grant.strip(), "select", grant)
        self.assertNotRegex(BODY, r"create policy [a-z_]+ on public\.film[a-z_]*\s+for (insert|update|delete|all)")

    def test_film_events_is_append_only(self):
        self.assertIn("before update or delete on public.film_events", BODY)
        self.assertIn("before truncate on public.film_events", BODY)

    def test_every_function_pins_its_search_path_and_is_revoked_from_every_api_role(self):
        funcs = created_functions()
        self.assertGreaterEqual(len(funcs), 18)
        for sig, start in funcs.items():
            self.assertIn("set search_path = public, pg_temp", function_header(start), sig)
            self.assertIn(f"revoke all on function {sig} from public, anon, authenticated, service_role;", BODY, sig)

    def test_only_the_four_browser_calls_are_granted_and_only_to_signed_in_users(self):
        granted = re.findall(r"grant execute on function (public\.[^;]+?) to ([a-z_, ]+);", BODY)
        self.assertEqual({sig for sig, _ in granted}, BROWSER_CALLS)
        self.assertEqual({who for _, who in granted}, {"authenticated"})
        for sig in BROWSER_CALLS:
            self.assertIn("security definer", function_header(created_functions()[sig]), sig)

    def test_the_limits_handed_to_the_app_are_the_ones_the_tables_enforce(self):
        lim = dict((k, int(v)) for k, v in re.findall(r"'([a-z_]+)', (\d+)", re.search(
            r"function public\.film_limits\(\).*?\$\$(.*?)\$\$", BODY, re.S).group(1)))
        checks = {
            f"position between 0 and {lim['max_scenes'] - 1}",
            f"planned_seconds between {lim['scene_seconds_min']} and {lim['scene_seconds_max']}",
            f"shot_count between 1 and {lim['max_shots']}",
            f"target_seconds between {lim['target_seconds_min']} and {lim['target_seconds_max']}",
            f"public.film_text_ok(title, 1, {lim['max_title_chars']}, false)",
            f"public.film_text_ok(source_text, 0, {lim['max_script_chars']}, true)",
            f"char_length(source_text) <= {lim['max_topic_chars']}",
            f"public.film_text_ok(narration, 0, {lim['max_narration_chars']}, true)",
            f"public.film_text_ok(visual_prompt, 0, {lim['max_prompt_chars']}, true)",
            f"public.film_text_ok(negative_prompt, 0, {lim['max_negative_chars']}, true)",
            f"position between 0 and {lim['max_film_refs'] - 1}",
            f"(scene_id is null or position between 0 and {lim['max_scene_refs'] - 1})",
        }
        for c in checks:
            self.assertIn(c, BODY, c)
        self.assertEqual(lim["max_film_seconds"], 1200)
        self.assertEqual(lim["max_open_drafts"], 50)

    def test_first_last_and_reference_frames_are_kept_apart(self):
        for col in ("first_frame ", "first_frame_asset_id", "last_frame ", "last_frame_asset_id"):
            self.assertIn(col, re.search(r"create table if not exists public\.film_scenes \((.*?)\n\);", BODY, re.S).group(1))
        takes = re.search(r"create table if not exists public\.film_takes \((.*?)\n\);", BODY, re.S).group(1)
        for col in ("first_frame_asset_id", "last_frame_asset_id", "reference_asset_ids", "result_last_frame_asset_id"):
            self.assertIn(col, takes)
        self.assertIn("(last_frame_asset_id is null or first_frame_asset_id is not null)", BODY)

    def test_the_text_helpers_are_0131s_byte_for_byte_and_nothing_of_0131_is_named(self):
        # A drifted copy would let a hidden character into a visual prompt that the Ads Factory would have removed; a call to
        # 0131's own helpers would break every film call (or block rollback_0131) the day 0131 is rolled back.
        m131 = (MIGRATIONS / "0131_ads_factory.sql").read_text(encoding="utf-8")
        for ads, film in (("ads_clean_text", "film_clean_text"), ("ads_text_ok", "film_text_ok")):
            theirs = re.search(r"create or replace function public\." + ads + r"\(.*?\n\$\$;\n", m131, re.S).group(0)
            ours = re.search(r"create or replace function public\." + film + r"\(.*?\n\$\$;\n", SQL, re.S).group(0)
            self.assertEqual(ours, theirs.replace("public." + ads, "public." + film))
        self.assertNotRegex(BODY, r"public\.ads_")
        self.assertLess(BODY.index("function public.film_text_ok("), BODY.index("create table if not exists public.films ("))

    def test_seedance_is_refused_by_id_adapter_and_vendor_model_but_not_by_vendor(self):
        body = re.search(r"function public\.film_check_model.*?\$\$(.*?)\$\$", BODY, re.S).group(1)
        self.assertIn("p_model ilike '%seedance%'", body)
        self.assertIn("m.adapter ilike 'video.seedance%'", body)
        self.assertIn("coalesce(m.spec ->> 'vendor_model', '') ilike '%seedance%'", body)
        # A Seedream key-frame model is ByteDance's too, and is not Seedance.
        self.assertNotIn("bytedance", body)
        self.assertIn("'model_not_offered'", body)
        self.assertIn("public.sellable_models(c, 'web')", body)

    def test_every_picture_and_channel_foreign_key_has_an_index_and_the_no_action_reason_is_written(self):
        fks = {
            "films": ["channel_id", "music_asset_id"],
            "film_scenes": ["first_frame_asset_id", "last_frame_asset_id"],
            "film_refs": ["scene_id", "asset_id"],
            "film_takes": ["parent_take_id", "first_frame_asset_id", "last_frame_asset_id", "result_asset_id",
                           "result_last_frame_asset_id"],
        }
        for table, cols in fks.items():
            for col in cols:
                self.assertRegex(BODY, rf"create index if not exists \w+\s+on public\.{table} \({col}\b", (table, col))
        self.assertIn("soft-deleted (deleted_at), never hard-deleted", SQL)

    def test_the_review_fixes_hold_in_the_text(self):
        # L1: a whole number written 12.0 is cast through numeric, never straight to integer.
        self.assertNotRegex(BODY, r"(\bv #>> '\{\}'\)|r\.v ->> '[a-z_]+'\))::(integer|smallint)")
        self.assertEqual(len(re.findall(r"::numeric::(integer|smallint)", BODY)), 3)
        # L2 + L3: the film row is locked FOR NO KEY UPDATE, after the membership check, in both writers.
        self.assertNotRegex(BODY, r"for update;")
        for fn in ("save_film", "archive_film"):
            body = re.search(rf"function public\.{fn}\(.*?\$\$(.*?)\$\$", BODY, re.S).group(1)
            self.assertLess(body.index("is_org_member(org, 'editor')"), body.index("for no key update"), fn)
        # L5: one constraint per concern on films; the old catch-all is dropped, never re-added.
        for c in ("films_text_check", "films_format_check", "films_models_check", "films_sound_check", "films_status_check",
                  "films_bookkeeping_check"):
            self.assertIn(f"add constraint {c}\n", BODY)
        self.assertNotIn("add constraint films_check", BODY)
        self.assertIn("drop constraint if exists films_check;", BODY)
        # L6: the identity sequence is closed.
        self.assertIn("revoke all on sequence public.film_events_id_seq from public, anon, authenticated, service_role;", BODY)
        # L7: no audit row is written under a guessed role.
        log = re.search(r"function public\.film_log\(.*?\$\$(.*?)\$\$", BODY, re.S).group(1)
        self.assertNotIn("'viewer'", log)
        self.assertIn("raise exception 'forbidden'", log)
        # L4: a member is granted named columns, never the table; the request hash is not among them.
        self.assertNotRegex(BODY, r"grant select on [^;]*to authenticated")
        auth = re.findall(r"grant select \(([^)]*)\)\s+on public\.(\w+) to authenticated;", BODY)
        self.assertEqual({t for _, t in auth}, set(TABLES))
        self.assertNotIn("request_hash", "".join(cols for cols, _ in auth))
        read = re.search(r"function public\.film_read\(.*?\$\$(.*?)\$\$", BODY, re.S).group(1)
        self.assertNotIn("to_jsonb(f)", read)
        self.assertNotIn("to_jsonb(s)", read)
        self.assertNotIn("to_jsonb(t)", read)
        self.assertIn("'events_truncated'", read)
        # M3: each scene's references are read by scene and film.
        self.assertIn("from public.film_refs r where r.film_id = f.id and r.scene_id = s.id", read)

    def test_every_writer_is_rate_limited_in_the_database_and_storage_is_capped(self):
        for fn, bucket in (("create_film_draft", "create"), ("save_film", "save"), ("archive_film", "archive")):
            body = re.search(rf"function public\.{fn}\(.*?\$\$(.*?)\$\$", BODY, re.S).group(1)
            self.assertIn(f"public.film_take_rate('{bucket}', (lim ->> '{bucket}s_per_hour')::integer)", body, fn)
        rate = re.search(r"function public\.film_take_rate\(.*?\$\$(.*?)\$\$", BODY, re.S).group(1)
        self.assertIn("public.take_web_rate('db.film.' || p_bucket, p_max, 3600)", rate)
        self.assertIn("'NS429'", rate)
        self.assertIn("(select count(*) from public.films where org_id = p_org) >= (lim ->> 'max_films_total')::integer", BODY)
        self.assertIn(">= (lim ->> 'max_events_per_film')::integer", BODY)
        doc = (REPO / "docs" / "FILM_STUDIO.md").read_text(encoding="utf-8")
        self.assertIn("## Storage and erasure", doc)

    def test_the_replay_guard_pins_every_function_the_file_creates(self):
        guard = dict(re.findall(r"\('(public\.[a-z_]+\([^)]*\))', '([0-9a-f]{32})'\)", SQL.split("-- 1. Tables")[0]))
        self.assertEqual(set(guard), set(created_functions()))
        self.assertNotIn("0" * 32, guard.values())

    def test_the_rollback_drops_exactly_what_the_file_creates_and_pins_the_same_bodies(self):
        rb = code(ROLLBACK)
        dropped = {re.sub(r"\s+", " ", s) for s in re.findall(r"drop function (public\.[a-z_]+\([^)]*\));", rb)}
        self.assertEqual(dropped, set(created_functions()))
        self.assertEqual(set(re.findall(r"drop table public\.([a-z_]+);", rb)), set(TABLES))
        guard = dict(re.findall(r"\('(public\.[a-z_]+\([^)]*\))', '([0-9a-f]{32})'\)", SQL))
        pinned = dict(re.findall(r"\('(public\.[a-z_]+\([^)]*\))', '([0-9a-f]{32})'\)", ROLLBACK))
        self.assertEqual(set(pinned), BROWSER_CALLS)
        for sig, h in pinned.items():
            self.assertEqual(guard[sig], h, sig)
        self.assertIn("-- set local nightshift.rollback_0166_discard_films = 'on';", ROLLBACK)

    def test_it_is_idempotent_guarded_and_verifiable(self):
        self.assertIn("set local lock_timeout", BODY)
        self.assertNotRegex(BODY, r"create table public\.")
        self.assertNotRegex(BODY, r"create (unique )?index (?!if not exists)")
        self.assertEqual(len(re.findall(r"create policy", BODY)), len(re.findall(r"drop policy if exists", BODY)))
        self.assertIn("-- Verify", SQL)


if __name__ == "__main__":
    unittest.main()

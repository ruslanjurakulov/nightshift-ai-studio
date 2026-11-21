"""Static pins on migration 0202 (channel research). The behaviour is proven against a real Postgres in
tests/security/test_sec_research.py; these keep the file's shape from drifting in review.

What would break without these:

* a function that runs as its owner without a pinned search_path (a caller's schema could shadow ``public``);
* a reader or writer granted to anon, or a worker function granted to a signed-in member;
* a reader that forgets the 30-day filter (YouTube's limit on stored non-authorized data);
* a derived metric (a ratio, a score) creeping into a cache table or a reader;
* the ledger's source CHECK rewritten so 'visibility' (0116) no longer holds;
* audience text returned under a key the chat could mistake for an instruction.
"""

from __future__ import annotations

import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MIG = ROOT / "supabase" / "migrations" / "0202_channel_research.sql"
ROLLBACK = ROOT / "docs" / "sql" / "rollback_0202_channel_research.sql"

READERS = ("research_own_channel", "research_competitors_view", "research_topic_channels", "research_comment_themes")
WRITERS = ("research_request_refresh", "research_add_competitor", "research_remove_competitor")
WORKER = ("research_claim_request", "research_finish_request", "research_store_channels", "research_store_videos",
          "research_resolve_competitor", "research_store_topic", "research_store_own", "research_purge_stale")


def code(sql: str) -> str:
    """The file without its comments (a comment may mention anything)."""
    return "\n".join(line.split("--", 1)[0] for line in sql.splitlines())


def bodies(sql: str) -> dict:
    out = {}
    for m in re.finditer(r"create or replace function public\.(\w+)\((.*?)\$\$(.*?)\$\$;", sql, re.S):
        out.setdefault(m.group(1), []).append(m.group(2) + "$$" + m.group(3))
    return out


class ChannelResearchMigration(unittest.TestCase):
    sql = MIG.read_text(encoding="utf-8")
    src = code(sql)
    fns = bodies(src)

    def test_every_function_that_runs_as_its_owner_pins_search_path(self):
        definers = [n for n, bs in self.fns.items() for b in bs if "security definer" in b]
        self.assertGreaterEqual(len(definers), len(READERS + WRITERS + WORKER))
        for name, bs in self.fns.items():
            for b in bs:
                header = b.split("$$", 1)[0]
                self.assertIn("set search_path = public, pg_temp", header, name)

    def test_readers_writers_and_worker_functions_are_security_definer(self):
        for name in READERS + WRITERS + WORKER:
            self.assertIn(name, self.fns, name)
            self.assertIn("security definer", self.fns[name][0].split("$$", 1)[0], name)

    def test_grants_members_only_and_the_worker_only(self):
        grants = re.findall(r"grant execute on function public\.(\w+)\([^)]*\) to (\w+);", self.src)
        granted = {}
        for fn, role in grants:
            granted.setdefault(fn, set()).add(role)
        for name in READERS + WRITERS:
            self.assertEqual(granted.get(name), {"authenticated"}, name)
        for name in WORKER:
            self.assertEqual(granted.get(name), {"service_role"}, name)
        self.assertEqual(granted.get("youtube_quota_take"), {"service_role"})
        self.assertNotRegex(self.src, r"\bto (?:[\w, ]*\b)?anon\b")
        self.assertNotRegex(self.src, r"grant (?:select|insert|update|delete|all)[^;]* on (?:table )?public\.research_")
        # Every function is revoked from everyone first; the grants above are the only ones.
        for name in self.fns:
            self.assertRegex(self.src, rf"revoke all on function public\.{name}\([^)]*\)\s+from public, anon, authenticated, service_role;",
                             name)

    def test_every_reader_ignores_rows_older_than_thirty_days(self):
        for name in ("research_own_channel", "research_topic_channels", "research_channel_json", "research_videos_json",
                     "research_competitors_view", "research_comment_themes"):
            self.assertIn("now() - interval '30 days'", self.fns[name][0], name)
        purge = self.fns["research_purge_stale"][0]
        for table in ("research_channel_cache", "research_video_cache", "research_topic_results", "research_own_analytics"):
            self.assertRegex(purge, rf"delete from public\.{table} where fetched_at < now\(\) - interval '30 days'", table)

    def test_cached_rows_carry_fetched_at(self):
        for table in ("research_channel_cache", "research_video_cache", "research_topic_results", "research_own_analytics"):
            block = re.search(rf"create table if not exists public\.{table} \((.*?)\n\);", self.src, re.S).group(1)
            self.assertRegex(block, r"fetched_at\s+timestamptz not null", table)

    def test_no_derived_metric_anywhere(self):
        lowered = self.src.lower()
        for word in ("ratio", "outlier", "velocity", "sentiment", "engagement", "per_subscriber", "views_per", "score", "rate"):
            # Whole words or name parts only ("migration" is not a ratio, take_web_rate is the rate limiter).
            hit = re.search(rf"(?<![a-z_]){word}(?![a-z_])", lowered.replace("take_web_rate", ""))
            self.assertIsNone(hit, f"{word!r} in 0202")
        # No arithmetic between two counts: a division sign next to a count column would be a derived number.
        self.assertNotRegex(lowered, r"(view|subscriber|like|comment)_count\s*[/*]")

    def test_hidden_subscribers_are_null_with_a_flag(self):
        self.assertIn("check (not subscribers_hidden or subscriber_count is null)", self.src)
        self.assertIn("case when coalesce(x.subscribers_hidden, false) then null else x.subscriber_count end",
                      self.fns["research_store_channels"][0])

    def test_the_ledger_source_check_is_extended_not_replaced(self):
        self.assertIn("alter table public.youtube_quota_ledger drop constraint if exists youtube_quota_ledger_source_check;", self.src)
        self.assertIn("check (source in ('visibility', 'research', 'research_search'))", self.src)
        overload = self.fns["youtube_quota_take"]
        self.assertEqual(len(overload), 1, "0202 defines only the six-argument overload")
        self.assertIn("p_source text", overload[0])
        self.assertIn("not in ('research', 'research_search')", overload[0])
        # 0116's five-argument function is not redefined or dropped here.
        self.assertNotRegex(self.src, r"drop function[^;]*youtube_quota_take")

    def test_comment_text_is_only_returned_as_untrusted(self):
        themes = self.fns["research_comment_themes"][0]
        self.assertIn("'untrusted_text'", themes)
        self.assertIn("'untrusted_word'", themes)
        self.assertNotRegex(themes, r"'(body|text|comment|word)'\s*,")
        self.assertIn("grouped by Nightshift, not YouTube data", themes)

    def test_readers_answer_the_tool_contract(self):
        answer = self.fns["research_answer"][0]
        for key in ("'status'", "'fetched_at'", "'source'", "'data'", "'last_request'"):
            self.assertIn(key, answer)
        for st in ("'refreshing'", "'ok'", "'no_data'"):
            self.assertIn(st, answer)
        self.assertIn("'not_connected'", self.fns["research_own_channel"][0])
        self.assertIn("resets at midnight Pacific time", self.fns["research_remedy"][0])

    def test_caps_are_in_the_database(self):
        refresh = self.fns["research_request_refresh"][0]
        self.assertIn("if today >= 3 then", refresh)
        self.assertIn("America/Los_Angeles", refresh)
        self.assertIn("if n >= 20 then", self.fns["research_add_competitor"][0])
        self.assertIn("where status in ('queued', 'running')", self.src)

    def test_the_access_rule_is_the_channel_rows_organization(self):
        access = self.fns["research_channel_access"][0]
        self.assertIn("from public.channels c where c.channel_id = p_channel", access)
        self.assertIn("raise exception 'not_found' using errcode = 'P0002'", access)
        for name in READERS:
            self.assertIn("research_channel_access(p_channel, 'viewer')", self.fns[name][0], name)
        for name in WRITERS:
            self.assertIn("research_channel_access(p_channel, 'editor')", self.fns[name][0], name)

    def test_worker_functions_check_the_trusted_caller(self):
        for name in WORKER:
            self.assertIn("public.credits_trusted_caller()", self.fns[name][0], name)

    def test_it_is_idempotent_and_has_a_verify_block_and_a_rollback(self):
        self.assertNotRegex(self.src, r"create table (?!if not exists)")
        self.assertNotRegex(self.src, r"create (?:unique )?index (?!if not exists)")
        self.assertIn("-- Verify (run as the SQL editor", self.sql)
        rb = ROLLBACK.read_text(encoding="utf-8")
        for name in READERS + WRITERS + WORKER:
            self.assertIn(f"drop function if exists public.{name}(", rb, name)
        self.assertIn("check (source in ('visibility'))", rb)
        self.assertNotIn("youtube_quota_take(text, integer, integer, uuid, integer);", rb.replace(
            "to_regprocedure('public.youtube_quota_take(text, integer, integer, uuid, integer)')", ""))

    def test_fix_round_pins(self):
        # BR-R-001: own uploads have their own, channel-scoped table, and only a public one reaches the shared cache.
        store = self.fns["research_store_videos"][0]
        self.assertIn("delete from pg_temp.research_tmp_videos where privacy_status is distinct from 'public'", store)
        self.assertIn("research_own_videos_json(p_channel, 10, a.youtube_channel_id)", self.fns["research_own_channel"][0])
        self.assertNotIn("research_videos_json(a.youtube_channel_id", self.fns["research_own_channel"][0])
        # BR-R-005: flagged comments never sampled.
        self.assertIn("x.flagged_injection is not true", self.fns["research_comment_themes"][0])
        # Rule 7: every reader and writer asks whether the channel is confirmed.
        for name in READERS + WRITERS[:2]:
            self.assertIn("research_channel_confirmed(p_channel)", self.fns[name][0], name)
        # BR-R-002 (contract): a youtube answer says its strings are third-party text.
        self.assertIn("'untrusted_strings', p_source = 'youtube'", self.fns["research_answer"][0])
        # The customer-facing remedies do not name the operator's secret.
        self.assertNotIn("YOUTUBE_DATA_API_KEY", self.fns["research_remedy"][0])
        self.assertIn("take_web_rate('research_competitor_remove', 40, 3600)", self.fns["research_remove_competitor"][0])

    def test_second_fix_round_pins(self):
        claim = self.fns["research_claim_request"][0]
        self.assertIn("exit when public.research_channel_confirmed(r.channel_id);", claim)
        self.assertIn("set status = 'not_connected', error_code = 'not_connected'", claim)
        finish = self.fns["research_finish_request"][0]
        self.assertIn("public.research_channel_confirmed(r.channel_id)", finish)
        self.assertIn("claimed_competitor_ids", finish)
        self.assertIn("late.added_by", finish)
        self.assertIn("alter table public.research_competitors drop constraint if exists research_competitors_status_check;", self.src)
        self.assertIn("insert into public.research_requests", self.fns["research_purge_stale"][0])
        self.assertIn("set resolved_at = now()", self.fns["research_store_channels"][0])
        self.assertIn("v.fetched_at < c.since", self.fns["research_store_videos"][0])
        self.assertIn("clock_timestamp()", self.fns["research_add_competitor"][0])
        self.assertIn("research_current_youtube_id(p_channel)", self.fns["research_own_channel"][0])

    def test_third_fix_round_pins(self):
        self.assertIn("check (status in ('pending', 'resolved', 'not_found', 'own_channel', 'invalid_ref'))", self.src)
        self.assertIn("add column if not exists last_error text", self.src)
        self.assertIn("'^@[[:alpha:][:digit:]_.-]{3,30}$'", self.fns["research_parse_ref"][0])
        self.assertIn("lower(x.handle) = c.input_ref", self.fns["research_store_channels"][0])
        self.assertIn("q.status = 'running'", self.fns["research_purge_stale"][0])
        self.assertIn("late.created_at >= r.started_at", self.fns["research_finish_request"][0])
        self.assertIn("'started_at', coalesce(r.started_at, now())", self.fns["research_claim_request"][0])
        self.assertIn("lookup_failures + 1 >= 3", self.fns["research_competitor_lookup_failed"][0])


if __name__ == "__main__":
    unittest.main()

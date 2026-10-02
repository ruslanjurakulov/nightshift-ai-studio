"""supabase/migrations/0081_comment_inbox.sql — the comment inbox, the database half.

SQL does not run in this suite, so these pin what matters; the security lab
(tests/security/test_sec_comment_inbox.py) runs the attacks against a real
Postgres 16: nothing is posted without a person's approval, an intent is
append-only, one reply is posted once, hostile text is cleaned and never given
a draft when it is spam/flagged/unclassified, the price comes first (an unset
`reply_draft` price blocks the feature), every worker function is closed to the
browser, another organization reads as not found, and applying the file twice
changes nothing."""

import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
FILE = ROOT / "supabase" / "migrations" / "0081_comment_inbox.sql"
SQL = FILE.read_text()
CODE = "\n".join(line.split("--", 1)[0] for line in SQL.splitlines())

BROWSER = ("quote_reply_draft", "request_reply_draft", "edit_reply_draft", "discard_reply_draft",
           "approve_reply", "retry_reply_post", "dismiss_inbox_comment")
WORKER = ("store_inbox_comments", "inbox_comments_to_classify", "claim_reply_draft", "store_reply_draft",
          "fail_reply_draft", "expire_reply_drafts", "purge_revoked_inbox", "claim_reply_post", "mark_reply_submitting", "finish_reply_post")
INTERNAL = ("inbox_append_only", "inbox_clean_text", "inbox_parse_ts", "inbox_url_like", "inbox_daily_cap", "inbox_channel_ready",
            "inbox_draft_block", "inbox_log", "reply_draft_price")
TABLES = ("inbox_comments", "reply_drafts", "reply_intents", "reply_posts", "inbox_events")
DEFINER = BROWSER + WORKER + ("inbox_channel_ready", "inbox_draft_block", "inbox_log", "reply_draft_price")


def head(name):
    return CODE.split(f"function public.{name}(", 1)[1].split("$$", 1)[0]


def body(name):
    return CODE.split(f"function public.{name}(", 1)[1].split("$$", 2)[1]


def grants(name):
    return [r.strip() for m in re.finditer(rf"grant execute on function public\.{name}\([^)]*\) to ([a-z_, ]+);", CODE)
            for r in m.group(1).split(",")]


class CommentInboxMigration(unittest.TestCase):
    def test_number_is_the_allocated_one_and_unique(self):
        names = sorted(p.name for p in (ROOT / "supabase" / "migrations").glob("0081_*.sql"))
        self.assertEqual(names, ["0081_comment_inbox.sql"])

    def test_is_additive_and_idempotent_and_replaces_no_earlier_function(self):
        for t in TABLES:
            self.assertIn(f"create table if not exists public.{t}", CODE)
            self.assertIn(f"alter table public.{t} enable row level security;", CODE)
        self.assertNotRegex(CODE, r"\bdrop (table|column|function)\b")
        self.assertNotRegex(CODE, r"\balter table public\.(?!(%s)\b)" % "|".join(TABLES))
        created = re.findall(r"create or replace function public\.(\w+)\(", CODE)
        self.assertEqual(sorted(created), sorted(BROWSER + WORKER + INTERNAL))
        for t in ("reply_intents", "inbox_events"):
            self.assertIn(f"drop trigger if exists {t}_append_only on public.{t};", CODE)
        for t in TABLES:
            self.assertIn(f"drop policy if exists {t}_select on public.{t};", CODE)

    def test_every_definer_function_pins_its_search_path(self):
        for name in DEFINER:
            self.assertIn("security definer set search_path = public, pg_temp", head(name), name)
        self.assertEqual(len(re.findall(r"security definer", CODE)), len(DEFINER))
        for name in ("inbox_append_only", "inbox_clean_text", "inbox_url_like", "inbox_daily_cap"):
            self.assertIn("set search_path = public, pg_temp", head(name), name)

    def test_only_the_browser_functions_reach_signed_in_users_and_the_worker_ones_only_the_service_role(self):
        for name in BROWSER:
            self.assertEqual(grants(name), ["authenticated"], name)
        for name in WORKER:
            self.assertEqual(grants(name), ["service_role"], name)
        for name in BROWSER + WORKER + INTERNAL:
            self.assertRegex(CODE, rf"revoke all on function public\.{name}\([^)]*\) from public, anon, authenticated, service_role;", name)
        self.assertEqual(len(re.findall(r"grant execute on function", CODE)), len(BROWSER) + len(WORKER))
        self.assertNotRegex(CODE, r"\bto anon\b")

    def test_every_worker_function_checks_the_caller_is_the_platform(self):
        for name in WORKER:
            self.assertIn("if not public.credits_trusted_caller() then", body(name), name)

    def test_no_api_role_writes_any_table_and_reads_are_scoped_by_channel(self):
        for t in TABLES:
            self.assertIn(f"revoke all on public.{t} from public, anon, authenticated, service_role;", CODE)
            self.assertIn(f"grant select on public.{t} to authenticated;", CODE)
            self.assertRegex(CODE, rf"create policy {t}_select on public\.{t}\s+for select to authenticated\s+"
                                   r"using \(channel_id in \(select public\.accessible_channel_ids\('viewer'\)\)\);")
        self.assertNotRegex(CODE, r"grant [^;]*\b(insert|update|delete|truncate)\b[^;]* to ")
        self.assertEqual(len(re.findall(r"create policy", CODE)), len(TABLES))

    def test_intents_and_events_are_append_only_even_for_the_owner(self):
        for t in ("reply_intents", "inbox_events"):
            self.assertRegex(CODE, rf"create trigger {t}_append_only\s+before update or delete on public\.{t}\s+for each row")
            self.assertRegex(CODE, rf"create trigger {t}_no_truncate\s+before truncate on public\.{t}")
        self.assertIn("raise exception 'append_only' using errcode = '42501'", body("inbox_append_only"))
        t = CODE.split("create table if not exists public.reply_intents", 1)[1].split(");", 1)[0]
        self.assertNotIn("references", t, "an audit row must outlive what it names")
        self.assertIn("constraint reply_intents_draft_key unique (draft_id)", t)
        self.assertIn("constraint reply_intents_comment_key unique (comment_id)", t)

    def test_a_reply_is_posted_once_by_construction(self):
        t = CODE.split("create table if not exists public.reply_posts", 1)[1].split(");", 1)[0]
        self.assertIn("intent_id        uuid not null unique references public.reply_intents (id)", t)
        self.assertIn("check ((status = 'posted') = (youtube_reply_id is not null))", t)
        self.assertIn("submitted_at", t)
        b = body("finish_reply_post")
        self.assertIn("if p.status = 'posted' then", b)
        self.assertIn("p.status <> 'posting' or p.worker_id is distinct from p_worker", b)
        self.assertIn("for update skip locked", body("claim_reply_post"))
        self.assertIn("p.submitted_at is not null", body("claim_reply_post"))

    def test_approval_is_the_only_way_to_an_intent_and_records_who(self):
        self.assertEqual(len(re.findall(r"insert into public\.reply_intents", CODE)), 1)
        self.assertIn("insert into public.reply_intents", body("approve_reply"))
        b = body("approve_reply")
        self.assertIn("public.is_org_member(org, 'editor')", b)
        self.assertIn("approved_by, approved_by_email", b)
        self.assertIn("auth.uid()", b)
        self.assertIn("if d.status <> 'ready' then", b)
        self.assertIn("inbox_channel_ready(c.channel_id)", b)
        self.assertIn("inbox_daily_cap('reply')", b)
        self.assertIn("exception when unique_violation then", b)
        self.assertEqual(len(re.findall(r"insert into public\.reply_posts", CODE)), 1)

    def test_comment_text_is_cleaned_and_bounded_on_the_way_in(self):
        t = CODE.split("create table if not exists public.inbox_comments", 1)[1].split(");", 1)[0]
        self.assertIn("check (char_length(body) between 1 and 2000)", t)
        self.assertIn("char_length(author_name) between 1 and 100", t)
        b = body("store_inbox_comments")
        self.assertIn("public.inbox_clean_text(e ->> 'text', 2000)", b)
        self.assertIn("public.inbox_clean_text(e ->> 'author', 100)", b)
        self.assertIn("jsonb_array_length(p_comments) > 100", b)
        self.assertIn("v.channel_id = p_channel", b)
        self.assertIn("chr(8234)", body("inbox_clean_text"))

    def test_spam_flagged_and_unclassified_comments_are_refused_at_three_points(self):
        for fn in ("inbox_draft_block", "claim_reply_draft", "approve_reply"):
            b = body(fn)
            self.assertIn("flagged_injection", b, fn)
            self.assertIn("'spam'", b, fn)
            self.assertIn("category is null", b, fn)

    def test_the_price_is_never_seeded_and_unknown_is_never_zero(self):
        self.assertNotRegex(CODE, r"insert into public\.credit_prices")
        self.assertNotRegex(CODE, r"update public\.credit_prices")
        b = body("reply_draft_price")
        self.assertIn("unit = 'reply_draft'", b)
        self.assertIn("if rate.unit is null then\n    return null;", b)
        r = body("request_reply_draft")
        self.assertIn("perform public.creative_refuse('unpriced'", r)
        self.assertLess(r.index("'unpriced'"), r.index("creative_platform_reserve"))
        self.assertIn("raise exception 'price_required' using errcode = '22023'", r)
        self.assertIn("perform public.creative_refuse('price_changed'", r)
        self.assertIn("perform public.credit_account_lock(org);", r)
        self.assertIn("idempotency_conflict", r)

    def test_the_quote_never_carries_the_margin_or_the_unit_rate(self):
        b = body("quote_reply_draft")
        for word in ("margin", "credits_per_unit"):
            self.assertNotIn(word, b)

    def test_the_hold_is_captured_at_most_once_and_released_on_every_failure(self):
        self.assertIn("perform public.capture_credits(d.credit_ref, d.quoted_credits);", body("store_reply_draft"))
        for fn in ("fail_reply_draft", "expire_reply_drafts", "claim_reply_draft"):
            self.assertIn("public.creative_platform_release(", body(fn), fn)
        self.assertIn("if d.status = 'ready' then", body("store_reply_draft"))
        self.assertIn("public.inbox_url_like(txt)", body("store_reply_draft"))

    def test_the_worker_is_given_the_minimum_to_draft_and_no_id_or_credential(self):
        b = body("claim_reply_draft")
        out = b.split("return jsonb_build_object(", 1)[1]
        for key in ("draft_id", "channel_name", "tone", "language", "video_title", "comment_text", "category"):
            self.assertIn(f"'{key}'", out)
        self.assertEqual(re.findall(r"(?m)^\s*'([a-z_]+)',", out),
                         ["draft_id", "channel_name", "tone", "language", "video_title", "comment_text", "category"])

    def test_the_posting_scope_and_the_daily_limits(self):
        self.assertIn("'https://www.googleapis.com/auth/youtube.force-ssl' = any (r.scopes)", body("inbox_channel_ready"))
        self.assertIn("r.revoked_at is null", body("inbox_channel_ready"))
        self.assertIn("when 'reply' then 40 when 'draft' then 200", body("inbox_daily_cap"))
        self.assertNotRegex(CODE, r"youtube\.(upload|readonly|partner|force-ssl)'\s*\]")  # no scope list of its own

    def test_a_revoked_connection_takes_its_stored_comments_with_it(self):
        b = body("purge_revoked_inbox")
        self.assertIn("r.revoked_at is not null", b)
        self.assertIn("delete from public.inbox_comments", b)
        self.assertNotIn("reply_intents", b, "the audit trail stays")
        self.assertIn("status in ('pending', 'drafting')", b)
        self.assertIn("status in ('queued', 'posting')", b)

    def test_stored_comments_are_pruned_after_thirty_days_untouched(self):
        b = body("store_inbox_comments")
        self.assertIn("c.fetched_at < now() - interval '30 days'", b)
        self.assertIn("not exists (select 1 from public.reply_drafts d where d.comment_id = c.id)", b)
        self.assertIn("not exists (select 1 from public.reply_intents i where i.comment_id = c.id)", b)

    def test_a_malformed_date_never_aborts_a_batch(self):
        self.assertIn("exception when others then\n  return null;", body("inbox_parse_ts"))
        self.assertIn("public.inbox_parse_ts(e ->> 'published_at')", body("store_inbox_comments"))

    def test_there_is_a_verify_query_at_the_end(self):
        self.assertIn("-- Verify (run after applying; every column should read true)", SQL)
        self.assertTrue(SQL.rstrip().splitlines()[-1].startswith("-- select count(*) = 0 as drafts_still_unpriced"))


if __name__ == "__main__":
    unittest.main()

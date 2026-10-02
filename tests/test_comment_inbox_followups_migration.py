"""Migration 0090 (the comment inbox's follow-ups, Lens-20, BR-L-120 .. BR-L-128), read as text.

The behaviour is proven in a real database by tests/security/test_sec_comment_inbox.py. This file
pins what a database test cannot see (house rule: ``create or replace`` is built on the latest body,
and no earlier check is dropped):

* each of 0081's functions that 0090 replaces is 0081's body (nothing else replaced them) with only
  the sanctioned lines changed, and no string literal of 0081's body is lost;
* every definer function of 0090 pins its search_path and is revoked and then granted explicitly;
* the header says what re-applying 0081 alone does, and nothing here names a provider or a model.
"""
from __future__ import annotations

import re
import unittest
from pathlib import Path

MIGRATIONS = Path(__file__).resolve().parents[1] / "supabase" / "migrations"
M81 = (MIGRATIONS / "0081_comment_inbox.sql").read_text(encoding="utf-8")
M90 = (MIGRATIONS / "0090_inbox_followups.sql").read_text(encoding="utf-8")


def bodies(text):
    return {m.group(1): m.group(0) for m in
            re.finditer(r"create or replace function public\.(\w+)\(.*?\n\$\$;\n", text, re.S)}


def literals(sql):
    code = re.sub(r"--[^\n]*", "", sql)
    return set(re.findall(r"'(?:[^']|'')*'", code))


def lines(sql):
    return [ln for ln in sql.splitlines() if ln.strip() and not ln.strip().startswith("--")]


OLD = bodies(M81)
NEW = bodies(M90)

REPLACED = ["inbox_clean_text", "inbox_draft_block", "quote_reply_draft", "request_reply_draft", "approve_reply",
            "store_inbox_comments", "inbox_comments_to_classify", "claim_reply_post"]
ADDED = ["inbox_org_quota_left", "inbox_channel_quota_left", "set_inbox_org_share"]


def removed(name):
    return [ln for ln in lines(OLD[name]) if ln not in lines(NEW[name])]


def added(name):
    return [ln for ln in lines(NEW[name]) if ln not in lines(OLD[name])]


class ReplacedBodies(unittest.TestCase):
    def test_exactly_these_functions_are_replaced_and_these_added(self):
        self.assertEqual(sorted(k for k in NEW if k in OLD), sorted(REPLACED))
        self.assertEqual(sorted(k for k in NEW if k not in OLD), sorted(ADDED))

    def test_0081s_is_the_latest_body_of_each_replaced_function(self):
        # Nothing between 0081 and 0090 replaced them: the comment inbox's later changes are 0090.
        for path in sorted(MIGRATIONS.glob("*.sql")):
            if not "0081" < path.name[:4] < "0090":
                continue
            text = path.read_text(encoding="utf-8")
            for name in REPLACED:
                self.assertNotRegex(text, rf"create or replace function public\.{name}\(",
                                    f"{path.name} replaces {name}: 0090 must be built on that body")

    def test_no_string_literal_of_an_earlier_body_is_lost(self):
        for name in REPLACED:
            self.assertEqual(sorted(literals(OLD[name]) - literals(NEW[name])), [], name)

    def test_the_new_literals_are_the_sanctioned_ones(self):
        gained = {n: sorted(literals(NEW[n]) - literals(OLD[n])) for n in REPLACED}
        self.assertEqual(gained, {
            "inbox_clean_text": ["' '", "' \\n'"],
            "inbox_draft_block": [],
            "quote_reply_draft": [],
            "request_reply_draft": ["'a reply draft is requested by a member of the channel''s organization'"],
            "approve_reply": ["'already_approved'", "'this draft was already approved with other words'"],
            "store_inbox_comments": [],
            "inbox_comments_to_classify": [],
            "claim_reply_post": ["'quota'", "'{}'"],
        })

    def test_draft_block_changes_only_the_replied_check(self):
        self.assertEqual(removed("inbox_draft_block"), [
            "  if c.status = 'replied' or exists (select 1 from public.reply_intents i where i.comment_id = c.id) then"])
        self.assertEqual(added("inbox_draft_block"), [
            "  if c.status = 'replied'",
            "     or exists (select 1 from public.reply_intents i where i.comment_id = c.id)",
            "     or exists (select 1 from public.reply_intents i",
            "                 where i.channel_id = c.channel_id and i.youtube_comment_id = c.youtube_comment_id) then",
        ])

    def test_quote_adds_only_the_real_member_condition(self):
        self.assertEqual(removed("quote_reply_draft"), [])
        self.assertEqual(added("quote_reply_draft"), ["                 and public.inbox_real_member(org, 'editor')"])

    def test_request_adds_only_the_real_member_check_before_the_exempt_check(self):
        self.assertEqual(removed("request_reply_draft"), [])
        self.assertEqual(added("request_reply_draft"), [
            "  if not public.inbox_real_member(org, 'editor') then",
            "      detail = 'a reply draft is requested by a member of the channel''s organization';",
        ])
        body = NEW["request_reply_draft"]
        self.assertLess(body.index("inbox_real_member(org, 'editor')"), body.index("public.credits_exempt(org) and not"))

    def test_approve_adds_only_the_different_words_refusal(self):
        self.assertEqual(removed("approve_reply"), [])
        self.assertEqual(added("approve_reply"), [
            "    if i.body is distinct from txt then",
            "      perform public.creative_refuse('already_approved', 'this draft was already approved with other words', 'NS409');",
            "    end if;",
        ])
        # The member and real-member checks, the lock order and the cap are all still there.
        for needle in ("is_org_member(org, 'editor')", "inbox_real_member(org, 'editor')", "for update;",
                       "pg_advisory_xact_lock", "invalid_body", "channel_not_ready", "daily_limit"):
            self.assertIn(needle, NEW["approve_reply"], needle)

    def test_classify_cap_replaces_only_the_category_test(self):
        self.assertEqual(removed("inbox_comments_to_classify"),
                         ["                                  and c.category is not null)) q), '{}'::text[]);"])
        self.assertEqual(added("inbox_comments_to_classify"),
                         ["                                  and (c.category is not null or c.classify_attempts >= 3))) q), '{}'::text[]);"])

    def test_store_changes_only_the_attempt_counting(self):
        self.assertEqual(len(removed("store_inbox_comments")), 2)
        self.assertEqual(len(added("store_inbox_comments")), 9)
        self.assertTrue(all("classify_attempts" in ln or "flagged" in ln or "category is null" in ln
                            for ln in added("store_inbox_comments")))
        for needle in ("credits_trusted_caller", "invalid_video", "invalid_comments", "interval '30 days'",
                       "char_length(s.body) >= 1", "jsonb_array_length(p_comments) > 100"):
            self.assertIn(needle, NEW["store_inbox_comments"], needle)

    def test_claim_keeps_every_earlier_check_and_adds_the_quota_wait(self):
        gone = removed("claim_reply_post")
        self.assertEqual(len(gone), 6)
        for needle in ("credits_trusted_caller", "invalid worker", "inbox_quota_remaining() < 60", "for update skip locked",
                       "inbox_channel_ready(i.channel_id)", "channel_not_ready", "interval '15 minutes'", "'reconcile', p.submitted_at is not null"):
            self.assertIn(needle, NEW["claim_reply_post"], needle)
        self.assertIn("inbox_org_quota_left(i.channel_id) < 60", NEW["claim_reply_post"])
        # A post waiting on quota says so, and is not failed or dropped.
        self.assertFalse("quota_exceeded" in NEW["claim_reply_post"])

    def test_the_cleaner_keeps_every_earlier_range_and_adds_the_new_ones(self):
        new = NEW["inbox_clean_text"]
        for needle in ("chr(128) || '-' || chr(159)", "chr(173)", "chr(847)", "chr(1564)", "chr(12644)", "chr(65440)",
                       "chr(65279)", r"E'[\\x01-\\x09\\x0b-\\x1f\\x7f]'"):
            self.assertIn(needle, new, needle)
        for needle in ("chr(6068) || chr(6069)", "chr(6155) || '-' || chr(6159)", "chr(65520) || '-' || chr(65531)",
                       "chr(78896) || '-' || chr(78911)", "chr(113824) || '-' || chr(113827)",
                       "chr(119155) || '-' || chr(119162)", "chr(917504) || '-' || chr(921599)",
                       "chr(160)", "chr(12288)", "E' \\n'"):
            self.assertIn(needle, new, needle)
        # The emoji / text variation selectors still come through.
        self.assertIn("chr(65024) || '-' || chr(65037)", new)
        self.assertFalse("chr(65038)" in new or "chr(65039)" in new)


class EveryFunctionIsLockedDown(unittest.TestCase):
    def test_definer_functions_pin_their_search_path(self):
        code = re.sub(r"--[^\n]*", "", M90)
        seen = 0
        for fn in re.finditer(r"create or replace function public\.(\w+)\(([^)]*)\)(.*?)\n\$\$;", code, re.S):
            head = fn.group(3).split("$$", 1)[0]
            if "security definer" in head:
                seen += 1
                self.assertIn("set search_path = public, pg_temp", head, fn.group(1))
        self.assertEqual(seen, len(ADDED) + sum(1 for n in REPLACED if "security definer" in NEW[n].split("$$", 1)[0]))

    def test_the_new_functions_are_revoked_then_granted_to_exactly_who_may_call_them(self):
        code = re.sub(r"--[^\n]*", "", M90)
        for name, sig, who in (("inbox_org_quota_left", "text", None),
                               ("inbox_channel_quota_left", "text", "service_role"),
                               ("set_inbox_org_share", "integer", "authenticated")):
            self.assertIn(f"revoke all on function public.{name}({sig}) from public, anon, authenticated, service_role;", code)
            grants = re.findall(rf"grant execute on function public\.{name}\({sig}\) to ([a-z_, ]+);", code)
            self.assertEqual(grants, [who] if who else [], name)

    def test_nothing_is_granted_to_anon_or_public(self):
        for grant in re.findall(r"^grant .*$", re.sub(r"--[^\n]*", "", M90), re.M):
            self.assertIsNone(re.search(r"\bto\b.*\b(anon|public)\b", grant), grant)

    def test_only_a_platform_admin_sets_the_share_and_it_is_bounded(self):
        body = NEW["set_inbox_org_share"]
        self.assertIn("is_platform_admin()", body)
        self.assertIn("auth.uid() is null", body)
        self.assertIn("p_percent < 1 or p_percent > 100", body)
        self.assertIn("check (org_share_percent between 1 and 100)", M90)
        self.assertIn("org_share_percent integer not null default 25", M90)


class TheFileItself(unittest.TestCase):
    def test_it_is_additive_and_replay_safe(self):
        code = re.sub(r"--[^\n]*", "", M90).lower()
        # (The retention delete inside store_inbox_comments is 0081's own, unchanged.)
        for banned in ("drop table", "drop column", "drop function", "truncate", "alter column",
                       "drop policy", "disable row level security"):
            self.assertFalse(banned in code, banned)
        self.assertEqual(len(re.findall(r"add column", code)), len(re.findall(r"add column if not exists", code)))
        self.assertIn("reply_posts_wait_reason_check", M90)
        self.assertIn("if not exists (select 1 from pg_constraint", M90)

    def test_the_header_says_reapplying_0081_alone_undoes_the_replaced_bodies(self):
        head = M90.split("do $$", 1)[0]
        self.assertIn("RE-APPLYING 0081 ALONE", head)
        self.assertIn("puts the eight replaced functions back to 0081's", head)
        self.assertIn("REQUIRES 0081", head)
        self.assertIn("Apply 0090 again after it", head)

    def test_it_refuses_to_run_without_0081(self):
        self.assertIn("raise exception '0090 needs the comment inbox", M90)

    def test_a_verify_query_closes_the_file(self):
        tail = M90.split("-- Verify", 1)[1]
        self.assertIn("has_function_privilege", tail)
        self.assertIn("definer_pinned", tail)

    def test_no_provider_or_model_name_anywhere(self):
        for word in ("gemini", "openai", "anthropic", "claude", "gpt", "veo", "kling", "fal.ai", "elevenlabs"):
            self.assertFalse(word in M90.lower(), word)


if __name__ == "__main__":
    unittest.main()

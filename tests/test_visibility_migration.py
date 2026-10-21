"""Migration 0116 (publish when approved: the switch, the queue, the quota ledger) builds on the LATEST body of everything it
redefines and ships with the feature OFF. These are the checks that need no database: they read the file and fail if it ever
drops a line of an old body, widens a grant, lets an API role write a new table, turns the switch on by default or anywhere,
lets the audit list drift from 0112's, changes what approving does while the switch is off, or if the rollback stops being the
exact old text. The behaviour (who may switch it, the queue's rules, the truth rule, the rollback and the replay of the file) is
attacked in tests/security/test_sec_visibility.py.
"""

import re
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
MIGRATIONS = REPO / "supabase" / "migrations"
FILE = "0116_visibility_requests.sql"
SQL = (MIGRATIONS / FILE).read_text(encoding="utf-8")
ROLLBACK = (REPO / "docs" / "sql" / "rollback_0116_visibility_requests.sql").read_text(encoding="utf-8")

REPLACED = {"approve_video_publish": "0112_approve_video_publish.sql", "audit_action_allowed": "0112_approve_video_publish.sql"}
PERSON = {"set_channel_publish_on_approve", "retry_video_visibility"}
WORKER = {"claim_visibility_request", "mark_visibility_submitting", "finish_visibility_request", "visibility_request_refusal",
          "youtube_quota_take", "youtube_quota_refund"}
TRIGGER_FNS = {"channels_publish_switch_guard", "video_visibility_requests_guard"}
NEW = PERSON | WORKER | TRIGGER_FNS | {"visibility_reason_words", "visibility_channel_connected"}
NEW_ACTIONS = ["channel.publish_on_approve", "video.publish_queued", "video.visibility_applied", "video.visibility_refused",
               "video.visibility_failed", "video.visibility_expired", "video.visibility_retry"]


def code(text):
    return "\n".join(line.split("--", 1)[0] for line in text.splitlines())


def bodies(text):
    return {m.group(1): m.group(0) for m in re.finditer(r"create or replace function public\.(\w+)\(.*?\n\$\$;\n", text, re.S)}


def latest(name):
    """(file, body) of the newest migration BELOW this one that defines ``name``."""
    for f in sorted(MIGRATIONS.glob("*.sql"), reverse=True):
        if f.name >= FILE or not re.match(r"^\d{4}_", f.name):
            continue
        b = bodies(f.read_text(encoding="utf-8"))
        if name in b:
            return f.name, b[name]
    raise AssertionError(name)


def audit_list(body):
    block = re.search(r"coalesce\(p_action, ''\) = any \(array\[(.*?)\]::text\[\]\)", body, re.S).group(1)
    return re.findall(r"'([a-z_.]+)'", code(block))


def outside_bodies(text):
    """The migration's own top-level statements: everything except the function bodies between $$ markers."""
    return re.sub(r"\$\$.*?\$\$", "$$ $$", code(text), flags=re.S)


CODE = code(SQL)
NEW_BODIES = bodies(SQL)
TOP = outside_bodies(SQL)


class BuiltOnTheLatestBodies(unittest.TestCase):
    def test_it_defines_exactly_the_two_functions_it_replaces_and_the_new_ones(self):
        self.assertEqual(sorted(NEW_BODIES), sorted([*REPLACED, *NEW]))
        self.assertEqual(sorted(re.findall(r"create or replace function public\.(\w+)", CODE)), sorted([*REPLACED, *NEW]))

    def test_each_old_body_comes_from_the_file_that_last_defined_it(self):
        for name, src in REPLACED.items():
            self.assertEqual(latest(name)[0], src, name)
        for name in NEW:
            with self.assertRaises(AssertionError, msg=f"{name} existed before 0116"):
                latest(name)

    def test_approve_video_publish_is_0112s_body_plus_two_marked_blocks_and_nothing_else(self):
        old, new = latest("approve_video_publish")[1], NEW_BODIES["approve_video_publish"]
        decl_old = "  i      public.review_intents;\nbegin\n"
        decl_new = "  i      public.review_intents;\n  v_switch boolean;   -- 0116\n  v_req    bigint;    -- 0116\n  v_out    jsonb;     -- 0116\nbegin\n"
        ret_old = ("  return jsonb_build_object('ok', true, 'already', false, 'video_id', v.video_id, 'cut_sha256', p_cut_sha256,\n"
                   "                            'decided_at', now(), 'expires_at', v_exp, 'intent_id', i.id);\nend\n$$;\n")
        self.assertEqual(old.count(decl_old), 1)
        self.assertEqual(old.count(ret_old), 1)
        # take the two blocks out of the new body and the rest is 0112's, byte for byte
        start = new.index("\n  -- 0116: on a channel whose")
        stop = new.index("  return v_out;\nend\n$$;\n") + len("  return v_out;\nend\n$$;\n")
        stripped = new[:start] + ret_old + new[stop:]
        self.assertEqual(stripped.replace(decl_new, decl_old), old)
        # every statement of 0112 survives, in the same order (the authorization, the lock, the replay, the refusal, the writes)
        order = ["auth.uid()", "video_approve_access(p_video_id)", "take_web_rate('video_approve', 20, 600)", "for update",
                 "video_approve_refusal(", "update public.videos", "insert into public.review_intents",
                 "insert into public.app_audit_log", "video_visibility_requests"]
        pos = [code(new).index(s) for s in order]
        self.assertEqual(pos, sorted(pos))
        self.assertIn("security definer set search_path = public, pg_temp", new.split("$$")[0])

    def test_with_the_switch_off_nothing_new_runs_and_the_answer_is_the_same_object(self):
        b = code(NEW_BODIES["approve_video_publish"])
        # the only new writes are inside the one `if v_switch is true` block; the switch is read once, from the channel row
        self.assertEqual(b.count("insert into public.video_visibility_requests"), 1)
        block = b[b.index("if v_switch is true then"):b.index("v_out := jsonb_build_object")]
        self.assertIn("insert into public.video_visibility_requests", block)
        self.assertIn("'video.publish_queued'", block)
        self.assertEqual(b.count("v_switch is true"), 1)
        self.assertIn("select c.publish_on_approve into v_switch from public.channels c where c.channel_id = v.channel_id;", b)
        # the key the replay is stopped by is the act itself: video, cut and the decision's own time
        self.assertIn("on conflict (video_id, approved_cut_sha256, decided_at) do nothing", b)
        # the answer gains keys only when a request was queued
        self.assertIn("if v_req is not null then\n    v_out := v_out || jsonb_build_object('queued', true, 'request_id', v_req);", b)
        # it never touches YouTube or a privacy
        self.assertNotRegex(b, r"set[^;]*\bprivacy\b")

    def test_the_audit_list_is_0112s_plus_exactly_the_new_names(self):
        old, new = audit_list(latest("audit_action_allowed")[1]), audit_list(NEW_BODIES["audit_action_allowed"])
        self.assertEqual(sorted(new), sorted([*old, *NEW_ACTIONS]))
        self.assertEqual(len(new), len(set(new)))
        for arm in (r"~ '^social\.(instagram|tiktok)\.(connect|connect_failed|disconnect)$'", r"~ '^learning\.(approve|reject)$'"):
            self.assertIn(arm, NEW_BODIES["audit_action_allowed"])
        inserted = ("    -- 0116: the per-channel switch, a queued request, the worker's results, a person's retry.\n"
                    "    'channel.publish_on_approve', 'video.publish_queued', 'video.visibility_applied', 'video.visibility_refused',\n"
                    "    'video.visibility_failed', 'video.visibility_expired', 'video.visibility_retry',\n")
        self.assertEqual(NEW_BODIES["audit_action_allowed"].count(inserted), 1)
        self.assertEqual(NEW_BODIES["audit_action_allowed"].replace(inserted, ""), latest("audit_action_allowed")[1])

    def test_every_audit_action_the_sql_writes_is_in_the_list(self):
        written = set()
        for insert in re.finditer(r"insert into public\.app_audit_log.*?values\s*\((.*?)\)\s*;", SQL, re.S | re.I):
            written.update(re.findall(r"'([a-z_]+\.[a-z_.]+)'", insert.group(1)))
        self.assertTrue({"video.approve", "video.publish_queued", "video.visibility_retry", "video.visibility_expired",
                         "channel.publish_on_approve"} <= written, sorted(written))
        # video.visibility_<status> is built from the status the worker finished with
        self.assertIn("'video.visibility_' || v_status", CODE)
        listed = set(audit_list(NEW_BODIES["audit_action_allowed"]))
        self.assertEqual(sorted(w for w in written if w not in listed), [])
        for status in ("applied", "refused", "failed", "expired"):
            self.assertIn(f"video.visibility_{status}", listed)


class OffByDefaultAndAdditive(unittest.TestCase):
    def test_the_switch_is_a_not_null_default_false_column_and_nothing_sets_it_true(self):
        self.assertIn("alter table public.channels add column if not exists publish_on_approve boolean not null default false;", TOP)
        # the file never writes true to it, except the person's function with the caller's own value
        self.assertEqual(re.findall(r"publish_on_approve\s*=\s*true", CODE), [])
        sets = re.findall(r"set publish_on_approve = (\w+)", CODE)
        self.assertEqual(sets, ["p_on"])
        self.assertNotRegex(CODE, r"update public\.channels set publish_on_approve = (true|\w*true)")

    def test_it_changes_no_existing_row_policy_or_trigger_and_removes_nothing(self):
        top = TOP.lower()
        for forbidden in ("drop table", "drop column", "truncate", "delete from", "alter table public.render_jobs",
                          "disable row level security", "create view", "create materialized", "create extension", "alter table public.videos",
                          "alter table public.review_intents", "update public."):
            self.assertNotIn(forbidden, top, forbidden)
        # the only drops: two functions of the same name and another shape (an earlier draft), dropped by signature so this file
        # does not fail on them. The file says plainly that it supports fresh databases only: the draft's two TABLES differ and
        # "create table if not exists" does not alter them.
        self.assertIn("THIS FILE SUPPORTS FRESH DATABASES ONLY", SQL)
        self.assertEqual(sorted(re.findall(r"(?m)^drop function if exists (public\.\w+\([^)]*\));", top)),
                         ["public.mark_visibility_submitting(bigint, text)", "public.youtube_quota_take(text, integer, integer)"])
        self.assertEqual(sorted(re.findall(r"(?m)^alter table (public\.\w+) ", top)),
                         ["public.channels", "public.video_visibility_requests", "public.youtube_quota_ledger"])
        self.assertEqual(sorted(re.findall(r"(?m)^(?:create|drop) policy (?:if exists )?(\w+)", top)),
                         ["video_visibility_requests_select", "video_visibility_requests_select", "youtube_quota_ledger_select", "youtube_quota_ledger_select"])
        self.assertEqual(sorted(re.findall(r"(?m)^create trigger (\w+)", top)), ["channels_publish_switch_guard", "video_visibility_requests_guard"])
        self.assertEqual(sorted(re.findall(r"(?m)^create table if not exists (public\.\w+)", top)),
                         ["public.video_visibility_requests", "public.youtube_quota_ledger"])
        # the only statements that change a row are inside function bodies
        self.assertNotRegex(top, r"(?m)^\s*(update|insert into|delete from) ")

    def test_it_waits_at_most_five_seconds_for_a_lock_and_checks_what_it_needs_first(self):
        self.assertIn("set local lock_timeout = '5s';", SQL)
        self.assertLess(SQL.index("set local lock_timeout"), SQL.index("alter table public.channels"))
        guard = SQL[SQL.index("do $$"):SQL.index("-- 1. The per-channel switch")]
        for needed in ("public.channels", "public.approve_video_publish(text, text, jsonb)", "public.video_publish_refusal(text, text)",
                       "public.video_approve_access(text)", "public.video_real_member(uuid, text)", "public.take_web_rate(text, integer, integer)",
                       "public.audit_action_allowed(text)", "public.channel_token_refs", "public.channel_credentials", "public.credits_trusted_caller()"):
            self.assertIn(needed, guard, needed)
        self.assertGreaterEqual(guard.count("raise exception"), 5)

    def test_every_function_pins_its_search_path_and_the_callable_ones_are_definers(self):
        for name in [*REPLACED, *NEW]:
            head = NEW_BODIES[name].split("$$")[0]
            self.assertIn("set search_path = public, pg_temp", head, name)
            if name in TRIGGER_FNS or name in ("audit_action_allowed", "visibility_reason_words"):
                self.assertNotIn("security definer", head, name)     # a trigger runs as its caller on purpose; the lists are pure
            else:
                self.assertIn("security definer", head, name)

    def test_the_new_tables_have_checks_that_keep_the_vocabulary_closed_and_applied_true(self):
        t = TOP
        self.assertIn("status in ('queued', 'applied', 'refused', 'failed', 'expired')", t)
        self.assertIn("reason = any (public.visibility_reason_words())", t)
        self.assertIn("(status = 'queued') = (finished_at is null)", t)
        self.assertIn("status <> 'applied' or (after_privacy = 'public' and reason is null)", t)
        self.assertIn("unique (video_id, approved_cut_sha256, decided_at)", t)
        self.assertIn("approved_cut_sha256 ~ '^[0-9a-f]{64}$'", t)
        # no free-text column on the member-readable table: every text column is an id, a hash, a status, a word or a worker id
        cols = re.findall(r"(?m)^  (\w+)\s+text\b", t[t.index("create table if not exists public.video_visibility_requests"):t.index("create index if not exists video_visibility_requests_claim_idx")])
        self.assertEqual(sorted(cols), sorted(["approved_cut_sha256", "before_privacy", "after_privacy", "channel_id", "claimed_by",
                                               "reason", "status", "video_id"]))


class WhoMayDoWhat(unittest.TestCase):
    def test_no_api_role_can_write_either_table_and_members_read_without_the_workers_columns(self):
        for tbl in ("video_visibility_requests", "youtube_quota_ledger"):
            self.assertIn(f"revoke all on public.{tbl} from public, anon, authenticated, service_role;", TOP)
            self.assertIn(f"alter table public.{tbl} enable row level security;", TOP)
        grants = re.findall(r"(?ms)^grant (.*?) on public\.(\w+) to ([\w, ]+);", TOP)
        for what, tbl, to in grants:
            self.assertTrue(what.strip().startswith("select"), (what, tbl))
            self.assertEqual(to.strip(), "authenticated")
        cols = re.search(r"grant select \((.*?)\)\s+on public\.video_visibility_requests", TOP, re.S).group(1)
        for hidden in ("claimed_by", "claimed_at", "lease_until", "submitting_at"):
            self.assertNotIn(hidden, cols)
        # no column grant on channels at all: the browser roles' list (0086) is not widened by this file
        self.assertNotRegex(TOP, r"grant [^;]* on public\.channels")
        self.assertNotRegex(TOP, r"grant [^;]* to (anon|public)\b")

    def test_the_grants_of_the_functions_are_stated_and_the_internal_ones_have_none(self):
        for fn, sig in (("set_channel_publish_on_approve", "(text, boolean)"), ("retry_video_visibility", "(bigint)"),
                        ("approve_video_publish", "(text, text, jsonb)")):
            self.assertIn(f"revoke all on function public.{fn}{sig} from public, anon, authenticated, service_role;", TOP)
            self.assertIn(f"grant execute on function public.{fn}{sig} to authenticated;", TOP)
        for fn, sig in (("visibility_request_refusal", "(bigint)"), ("claim_visibility_request", "(text)"),
                        ("mark_visibility_submitting", "(bigint, text)"), ("youtube_quota_take", "(text, integer, integer, uuid, integer)"),
                        ("youtube_quota_refund", "(text, integer, uuid)"),
                        ("finish_visibility_request", "(bigint, text, text, text, text, text, integer, integer)")):
            self.assertRegex(TOP, rf"revoke all on function public\.{fn}{re.escape(sig)}\s+from public, anon, authenticated, service_role;")
            self.assertRegex(TOP, rf"grant execute on function public\.{fn}{re.escape(sig)} to service_role;")
        for fn in ("channels_publish_switch_guard()", "video_visibility_requests_guard()", "visibility_reason_words()",
                   "visibility_channel_connected(text)", "audit_action_allowed(text)"):
            self.assertIn(f"revoke all on function public.{fn} from public, anon, authenticated, service_role;", TOP)
            self.assertNotIn(f"grant execute on function public.{fn}", TOP)

    def test_the_workers_functions_check_the_caller_is_the_platform_and_the_persons_check_who_they_are_first(self):
        for name in WORKER:
            self.assertIn("if not public.credits_trusted_caller() then", code(NEW_BODIES[name]).split("begin", 1)[1][:200], name)
        for name in PERSON:
            b = code(NEW_BODIES[name]).split("begin", 1)[1]
            self.assertTrue(b.lstrip().startswith("if uid is null then"), name)
        # the switch's function reads the org from the channel row and asks for a real administrator, like approving does
        b = code(NEW_BODIES["set_channel_publish_on_approve"])
        order = [b.index(s) for s in ("auth.uid()", "from public.channels c where c.channel_id = p_channel_id for update",
                                      "public.is_org_member(org)", "public.is_org_member(org, 'admin')",
                                      "public.video_real_member(org, 'admin')", "take_web_rate('publish_switch', 30, 600)",
                                      "update public.channels set publish_on_approve = p_on")]
        self.assertEqual(order, sorted(order))
        self.assertIn("'channel.publish_on_approve'", b)
        # the switch's guard refuses the API roles, the service key included, outside that function
        g = code(NEW_BODIES["channels_publish_switch_guard"])
        self.assertIn("current_user not in ('anon', 'authenticated', 'service_role')", g)
        self.assertEqual(g.count("errcode = '42501'"), 2)

    def test_applied_is_only_written_with_a_public_read_back_and_the_mirror_follows_it_alone(self):
        f = code(NEW_BODIES["finish_visibility_request"])
        self.assertIn("v_status = 'applied' and v_after is distinct from 'public'", f)
        self.assertIn("raise exception 'applied_needs_readback'", f)
        self.assertEqual(len(re.findall(r"update public\.videos set privacy = v_after", f)), 1)
        self.assertIn("p_reason = any (public.visibility_reason_words())", f)
        self.assertIn("else 'worker_error' end", f)
        # the only writer of videos.privacy in the file, and it takes the read-back value
        self.assertEqual(len(re.findall(r"set privacy\b", CODE)), 1)
        # a retry is bounded: the third claim was the last
        self.assertIn("if v_status = 'queued' and r.attempts >= 3\n     and not (r.submitting_at is not null and r.attempts < 4 and r.lifetime_attempts < 7) then", f)
        c = code(NEW_BODIES["claim_visibility_request"])
        # three claims in a round, six in a request's lifetime (try again resets the first, never the second)
        self.assertIn("v_final := r.attempts >= 3 or r.lifetime_attempts >= 6;", c)
        self.assertIn("lifetime_attempts = lifetime_attempts + 1", c)
        # the sweep ends an approval that ran out, but not a request whose write was marked: that one is read by the worker
        self.assertIn("expires_at <= now() and submitting_at is null", c)
        self.assertIn("for update skip locked", c)
        # organizations are served in turn: the one served longest ago first
        self.assertIn("order by (select max(y.claimed_at) from public.video_visibility_requests y where y.org_id = x.org_id) asc nulls first", c)

    def test_a_marked_request_gets_one_read_only_claim_before_it_is_failed_and_the_marker_refuses_that_claim(self):
        c = code(NEW_BODIES["claim_visibility_request"])
        self.assertIn("v_final := r.attempts >= 3 or r.lifetime_attempts >= 6;", c)
        self.assertIn("if v_final and not (r.submitting_at is not null and r.attempts < 4 and r.lifetime_attempts < 7) then", c)
        self.assertIn("'read_only', v_final", c)
        m = code(NEW_BODIES["mark_visibility_submitting"])
        self.assertIn("if r.attempts > 3 or r.lifetime_attempts > 6 then\n    return 'interrupted';", m)

    def test_units_taken_for_a_write_that_was_never_sent_can_be_given_back_by_the_service_key_alone(self):
        f = code(NEW_BODIES["youtube_quota_refund"])
        self.assertIn("pg_advisory_xact_lock", f)
        # the amount is clamped to the organization's own row and the SAME amount leaves both rows
        self.assertIn("select least(p_units, coalesce(max(l.units), 0)) into v_refund", f)
        self.assertIn("if v_refund > 0 then", f)
        self.assertIn("greatest(l.units - v_refund, 0)", f)
        self.assertNotIn("p_units, 0)", f.replace("least(p_units, coalesce(max(l.units), 0))", ""))
        self.assertIn("l.org_id in (v_all, p_org)", f)
        self.assertIn("credits_trusted_caller()", f)

    def test_the_last_check_and_the_marker_are_one_step_under_row_locks_in_the_order_try_again_uses(self):
        m = code(NEW_BODIES["mark_visibility_submitting"])
        self.assertIn("returns text", NEW_BODIES["mark_visibility_submitting"].split("$$")[0])
        chan = m.index("from public.channels c where c.channel_id = r.channel_id for share")
        req = m.index("from public.video_visibility_requests where id = p_request_id for update")
        vid = m.index("from public.videos v where v.video_id = r.video_id and v.channel_id = r.channel_id for share")
        ask = m.index("public.video_publish_refusal(r.video_id, r.approved_cut_sha256)")
        ask2 = m.index("public.visibility_request_refusal(r.id)")
        mark = m.index("set submitting_at = now()")
        self.assertLess(chan, req)
        self.assertLess(req, vid)
        self.assertLess(vid, ask)
        self.assertLess(ask, ask2)
        self.assertLess(ask2, mark)                      # the marker is the last statement that writes, after both questions
        self.assertEqual(re.findall(r"return '?(\w+)'?;", m), ["not_holder", "not_holder", "interrupted", "why", "ok"])
        # retry takes the same order (request, then video), so the two cannot deadlock; the switch takes the channel FOR UPDATE
        rt = code(NEW_BODIES["retry_video_visibility"])
        self.assertLess(rt.index("video_visibility_requests where id = p_request_id for update"), rt.index("public.videos where video_id = r.video_id"))
        self.assertIn("from public.channels c where c.channel_id = p_channel_id for update", code(NEW_BODIES["set_channel_publish_on_approve"]))

    def test_switching_off_does_not_refuse_a_request_whose_write_was_marked_and_finish_does_not_look_at_the_switch(self):
        s = code(NEW_BODIES["set_channel_publish_on_approve"])
        self.assertIn("where channel_id = p_channel_id and status = 'queued' and submitting_at is null;", s)
        f = code(NEW_BODIES["finish_visibility_request"])
        self.assertNotIn("publish_on_approve", f)
        self.assertNotIn("public.channels", f)
        self.assertIn("'write_marked', r.submitting_at is not null", f)
        self.assertIn("if r.status <> 'queued' or r.claimed_by is distinct from p_worker then", f)

    def test_a_lifetime_cap_a_per_organization_quota_and_a_closed_sequence(self):
        rt = code(NEW_BODIES["retry_video_visibility"])
        self.assertIn("if r.lifetime_attempts >= 6 then", rt)
        self.assertIn("'retry_limit'", rt)
        self.assertNotIn("lifetime_attempts = 0", rt)
        q = code(NEW_BODIES["youtube_quota_take"])
        self.assertIn("v_total + p_units > p_ceiling or v_org + p_units > p_org_ceiling", q)
        self.assertIn("pg_advisory_xact_lock", q)
        self.assertIn("revoke all on sequence public.video_visibility_requests_id_seq from public, anon, authenticated, service_role;", TOP)
        g = code(NEW_BODIES["channels_publish_switch_guard"])
        self.assertIn("new.publish_on_approve := false;", g)
        self.assertIn("before insert or update of publish_on_approve, org_id on public.channels", TOP)
        r = code(NEW_BODIES["visibility_request_refusal"])
        self.assertIn("ch.org_id is distinct from r.org_id", r)

    def test_the_request_level_recheck_asks_for_the_switch_the_same_approval_and_the_channel(self):
        r = code(NEW_BODIES["visibility_request_refusal"])
        words = re.findall(r"return '(\w+)';", r)
        self.assertEqual(words, ["not_enabled", "approval_superseded", "approval_expired", "channel_not_connected"])
        self.assertIn("v.decided_at is distinct from r.decided_at or v.approved_cut_sha256 is distinct from r.approved_cut_sha256", r)
        self.assertIn("visibility_channel_connected(r.channel_id)", r)
        # 0029's own function arrived by an edit after it was first merged: this file must not depend on it
        self.assertNotIn("publish_channel_connected", CODE)


class TheRollbackIsTheExactOldText(unittest.TestCase):
    def test_it_restores_0112s_two_bodies_verbatim(self):
        rb = bodies(ROLLBACK)
        self.assertEqual(sorted(rb), ["approve_video_publish", "audit_action_allowed"])
        self.assertEqual(rb["approve_video_publish"], latest("approve_video_publish")[1])
        self.assertEqual(rb["audit_action_allowed"], latest("audit_action_allowed")[1])

    def test_it_stops_everything_keeps_the_record_and_runs_in_one_transaction(self):
        top = outside_bodies(ROLLBACK)
        for fn in ("set_channel_publish_on_approve(text, boolean)", "retry_video_visibility(bigint)", "claim_visibility_request(text)",
                   "mark_visibility_submitting(bigint, text)", "visibility_request_refusal(bigint)", "youtube_quota_take(text, integer, integer, uuid, integer)",
                   "youtube_quota_refund(text, integer, uuid)", "visibility_channel_connected(text)",
                   "finish_visibility_request(bigint, text, text, text, text, text, integer, integer)"):
            self.assertIn(f"drop function if exists public.{fn};", top)
        for kept in ("channels_publish_switch_guard", "video_visibility_requests_guard", "visibility_reason_words"):
            self.assertNotIn(f"drop function if exists public.{kept}", top)
        for forbidden in ("drop table", "drop column", "delete from", "truncate"):
            self.assertNotIn(forbidden, top.lower(), forbidden)
        # nothing can be acted on after it: the waiting requests are refused and every switch goes off
        self.assertIn("set status = 'refused', reason = 'not_enabled'", ROLLBACK)
        self.assertIn("where status = 'queued' and submitting_at is null;", ROLLBACK)       # never one whose write was marked
        self.assertIn("55000", ROLLBACK)                                                       # a write in flight stops the rollback
        self.assertIn("update public.channels set publish_on_approve = false where publish_on_approve;", top)
        self.assertRegex(ROLLBACK, r"(?m)^begin;$")
        self.assertRegex(ROLLBACK, r"(?m)^commit;$")
        self.assertIn("set local lock_timeout = '5s';", ROLLBACK)
        self.assertIn("grant execute on function public.approve_video_publish(text, text, jsonb) to authenticated;", top)


if __name__ == "__main__":
    unittest.main()

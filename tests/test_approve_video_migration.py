"""Migration 0112 (the review panel's Approve is a decision bound to the exact cut) is ADDITIVE and builds on the LATEST body of
everything it redefines. These are the checks that need no database: they read the file and fail if it ever drops a line of an
old body, widens a grant, adds a table, trigger or second policy, deletes or rewrites a row, lets the audit list drift from
0110's, or if the rollback stops being the exact old text. The behaviour (who may approve, the hash, the expiry, the replay,
the closed insert, the rollback and the replay of the file) is attacked in tests/security/test_sec_approve_video.py.
"""

import re
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
MIGRATIONS = REPO / "supabase" / "migrations"
FILE = "0112_approve_video_publish.sql"
SQL = (MIGRATIONS / FILE).read_text(encoding="utf-8")
ROLLBACK = (REPO / "docs" / "sql" / "rollback_0112_approve_video_publish.sql").read_text(encoding="utf-8")

REPLACED = {"finish_scene_regeneration": "0085_scene_regen_followups.sql", "audit_action_allowed": "0110_marketing_promo_custom.sql"}
NEW = {"approve_video_publish", "video_approve_access", "video_real_member", "video_publish_refusal", "video_approve_refusal"}


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


CODE = code(SQL)
NEW_BODIES = bodies(SQL)


def outside_bodies(text):
    """The migration's own top-level statements: everything except the function bodies between $$ markers."""
    return re.sub(r"\$\$.*?\$\$", "$$ $$", code(text), flags=re.S)


class BuiltOnTheLatestBodies(unittest.TestCase):
    def test_it_defines_exactly_the_two_functions_it_replaces_and_five_new_ones(self):
        self.assertEqual(sorted(NEW_BODIES), sorted([*REPLACED, *NEW]))
        self.assertEqual(sorted(re.findall(r"create or replace function public\.(\w+)", CODE)), sorted([*REPLACED, *NEW]))

    def test_each_old_body_is_taken_from_the_file_that_last_defined_it(self):
        for name, src in REPLACED.items():
            self.assertEqual(latest(name)[0], src, name)
        for name in NEW:
            with self.assertRaises(AssertionError, msg=f"{name} existed before 0112"):
                latest(name)

    def test_finish_scene_regeneration_is_0085s_body_with_one_statement_extended(self):
        old, new = latest("finish_scene_regeneration")[1], NEW_BODIES["finish_scene_regeneration"]
        before = "    update public.videos set review_state = 'pending'\n     where video_id = r.video_id and review_state = 'approved';\n"
        after = ("    -- 0112: the approval goes with the state: its hash, who decided, when and until when.\n"
                 "    update public.videos set review_state = 'pending', approved_cut_sha256 = null, decided_by = null,\n"
                 "           decided_by_email = null, decided_at = null, approval_expires_at = null\n"
                 "     where video_id = r.video_id and review_state = 'approved';\n")
        self.assertEqual(old.count(before), 1)
        self.assertEqual(new, old.replace(before, after))
        # it keeps every statement that handles money and the intents
        for stmt in ("capture_credits(", "release_credits(", "outcome = 'superseded_by_repair'", "outcome = 'repaired'",
                     "scene_regeneration_details", "credits_trusted_caller()", "for update"):
            self.assertEqual(new.count(stmt), old.count(stmt), stmt)
        self.assertIn("security definer set search_path = public, pg_temp", new.split("$$")[0])

    def test_the_audit_list_is_0110s_plus_exactly_one_name(self):
        old, new = audit_list(latest("audit_action_allowed")[1]), audit_list(NEW_BODIES["audit_action_allowed"])
        self.assertEqual(sorted(new), sorted([*old, "video.approve"]))
        self.assertEqual(len(new), len(set(new)))
        # the two regex arms (social connect, learning) are kept as they were
        for arm in (r"~ '^social\.(instagram|tiktok)\.(connect|connect_failed|disconnect)$'", r"~ '^learning\.(approve|reject)$'"):
            self.assertIn(arm, NEW_BODIES["audit_action_allowed"])
        self.assertEqual(NEW_BODIES["audit_action_allowed"].replace(
            "    -- 0112: a person approves the exact cut of an uploaded video (approve_video_publish).\n    'video.approve',\n", ""),
            latest("audit_action_allowed")[1])

    def test_the_insert_policy_is_0033s_plus_one_condition(self):
        old = (MIGRATIONS / "0033_roles_cleanup.sql").read_text(encoding="utf-8")
        old_policy = re.search(r"create policy review_intents_insert on public\.review_intents.*?;\n", old, re.S).group(0)
        new_policy = re.search(r"create policy review_intents_insert on public\.review_intents.*?;\n", SQL, re.S).group(0)
        self.assertEqual(new_policy, old_policy.replace("    channel_id in (select public.accessible_channel_ids('editor'))\n",
                                                        "    channel_id in (select public.accessible_channel_ids('editor'))\n    and action <> 'approve'\n"
                                                        "    and approved_cut_sha256 is null\n"))
        # no later migration touched the policy since 0033
        for f in sorted(MIGRATIONS.glob("*.sql")):
            if "0033" < f.name[:4] < "0112":
                self.assertNotIn("policy review_intents_insert", f.read_text(encoding="utf-8"), f.name)


class AdditiveAndSafeToApplyLive(unittest.TestCase):
    def test_it_creates_no_table_trigger_view_or_second_policy_and_removes_nothing(self):
        top = outside_bodies(SQL).lower()
        for forbidden in ("create table", "create trigger", "create view", "create materialized", "drop table", "drop column", "truncate",
                          "delete from", "create extension", "drop function", "drop trigger", "alter table public.channels",
                          "alter table public.render_jobs", "disable row level security"):
            self.assertNotIn(forbidden, top, forbidden)
        self.assertEqual(re.findall(r"(?m)^(?:create|drop) policy (?:if exists )?(\w+)", top), ["review_intents_insert", "review_intents_insert"])
        # the only statements that change a row are inside function bodies
        self.assertNotRegex(top, r"(?m)^\s*(update|insert into) ")

    def test_every_new_column_is_nullable_without_a_default_and_added_if_missing(self):
        top = outside_bodies(SQL)
        added = re.findall(r"add column if not exists (\w+) (\w+)", top)
        self.assertEqual(sorted(a for a, _ in added),
                         sorted(["cut_sha256", "gate_verdict", "approved_cut_sha256", "decided_by", "decided_by_email", "decided_at",
                                 "approval_expires_at", "approved_cut_sha256"]))
        self.assertNotRegex(top, r"add column[^;,]*\b(default|not null)\b")
        # the checks are added once, guarded, and validated (a new column is NULL on every old row)
        self.assertEqual(CODE.count("not valid"), 4)
        self.assertEqual(CODE.count("validate constraint"), 4)
        self.assertEqual(CODE.count("if not exists (select 1 from pg_constraint"), 4)

    def test_it_waits_at_most_five_seconds_for_a_lock_and_checks_what_it_needs_first(self):
        self.assertIn("set local lock_timeout = '5s';", SQL)
        self.assertLess(SQL.index("set local lock_timeout"), SQL.index("alter table public.videos"))
        guard = SQL[SQL.index("do $$"):SQL.index("-- 1. The columns")]
        for needed in ("public.videos", "public.review_intents", "videos.publish_state", "public.default_org_id()",
                       "public.take_web_rate(text, integer, integer)", "public.audit_action_allowed(text)",
                       "public.finish_scene_regeneration(uuid, bigint, boolean, text, text, jsonb)", "public.my_confirmed_email()"):
            self.assertIn(needed, guard, needed)
        self.assertGreaterEqual(guard.count("raise exception"), 5)
        # nothing in the file depends on an object 0081 gained by an edit after it was merged
        self.assertNotIn("inbox_real_member", CODE)

    def test_every_function_is_a_definer_with_a_pinned_search_path(self):
        for name in [*NEW, *REPLACED]:
            head = NEW_BODIES[name].split("$$")[0]
            if name == "audit_action_allowed":
                self.assertIn("set search_path = public, pg_temp", head)   # 0110's: immutable, not a definer
                continue
            self.assertIn("security definer set search_path = public, pg_temp", head, name)

    def test_the_grants_are_stated(self):
        top = outside_bodies(SQL)
        self.assertIn("revoke all on function public.approve_video_publish(text, text, jsonb) from public, anon, authenticated, service_role;", top)
        self.assertIn("grant execute on function public.approve_video_publish(text, text, jsonb) to authenticated;", top)
        self.assertIn("revoke all on function public.video_real_member(uuid, text) from public, anon, authenticated, service_role;", top)
        self.assertNotIn("grant execute on function public.video_real_member", top)
        self.assertIn("revoke all on function public.video_approve_access(text) from public, anon, authenticated, service_role;", top)
        self.assertIn("grant execute on function public.video_approve_access(text) to authenticated;", top)
        self.assertIn("revoke all on function public.video_publish_refusal(text, text) from public, anon, authenticated, service_role;", top)
        self.assertIn("grant execute on function public.video_publish_refusal(text, text) to service_role;", top)
        self.assertIn("revoke all on function public.video_approve_refusal(text, text) from public, anon, authenticated, service_role;", top)
        self.assertNotIn("grant execute on function public.video_approve_refusal", top)
        self.assertIn("revoke all on function public.audit_action_allowed(text) from public, anon, authenticated, service_role;", top)
        self.assertIn("grant execute on function public.finish_scene_regeneration(uuid, bigint, boolean, text, text, jsonb) to service_role;", top)
        # nothing is ever granted to anon or to public
        self.assertNotRegex(top, r"grant [^;]* to (anon|public)\b")


class TheApprovalRpc(unittest.TestCase):
    body = code(NEW_BODIES["approve_video_publish"])

    def test_authorization_comes_before_anything_is_locked_or_written(self):
        b = self.body
        order = [b.index(s) for s in ("auth.uid()", "video_approve_access(p_video_id)", "take_web_rate('video_approve', 20, 600)",
                                      "for update", "video_approve_refusal(", "update public.videos", "insert into public.review_intents",
                                      "insert into public.app_audit_log")]
        self.assertEqual(order, sorted(order))
        # a caller who cannot see the video gets the answer a missing one gets
        self.assertEqual(b.count("errcode = 'P0002'"), 3)
        self.assertEqual(b.count("errcode = '42501'"), 3)

    def test_the_access_word_is_one_function_in_a_fixed_order_and_the_rpc_asks_it(self):
        a = code(NEW_BODIES["video_approve_access"])
        order = [a.index(s) for s in ("auth.uid() is null", "public.channel_org(v_channel)", "is_org_member(org)", "is_org_member(org, 'admin')",
                                      "video_real_member(org, 'admin')")]
        self.assertEqual(order, sorted(order))
        self.assertEqual(set(re.findall(r"return '(\w+)';", a)), {"not_found", "not_admin", "not_member", "ok"})
        self.assertIn("language plpgsql stable security definer", NEW_BODIES["video_approve_access"])
        # read-only: it writes nothing
        for forbidden in ("insert ", "update ", "delete "):
            self.assertNotIn(forbidden, a)
        # the RPC has no copy of the checks: it only maps the word
        self.assertNotIn("is_org_member", self.body)
        self.assertNotIn("real_member", self.body)

    def test_the_channel_comes_from_the_video_row_never_from_an_argument(self):
        sig = re.search(r"create or replace function public\.approve_video_publish\((.*?)\) returns", CODE, re.S).group(1)
        self.assertEqual([a.strip().split()[0] for a in sig.split(",")], ["p_video_id", "p_cut_sha256", "p_ack"])
        self.assertIn("insert into public.review_intents (channel_id, video_id, action, created_by, approved_cut_sha256, consumed_at, outcome)\n  values (v.channel_id,", self.body.replace("\n  values", "\n  values"))

    def test_it_writes_the_decision_and_the_approval_lasts_24_hours(self):
        self.assertIn("v_exp  timestamptz := now() + interval '24 hours';", self.body)
        self.assertIn("review_state = 'approved', approved_cut_sha256 = p_cut_sha256, decided_by = uid", self.body)
        self.assertIn("approval_expires_at = v_exp", self.body)
        self.assertIn("'video.approve'", self.body)
        # the audit detail carries ids, hashes and flags, never text
        start = self.body.index("jsonb_build_object('video_id'")
        detail = self.body[start:self.body.index("v.channel_id);", start)]
        self.assertEqual(sorted(re.findall(r"'(\w+)',", detail)),
                         sorted(["video_id", "cut_sha256", "gate_allowed", "rights_and_labels", "expires_at", "intent_id"]))

    def test_it_never_touches_privacy_or_youtube(self):
        for name in NEW:
            b = code(NEW_BODIES[name])
            self.assertNotRegex(b, r"set[^;]*\bprivacy\b", name)
            self.assertNotIn("youtube", b.lower().replace("a youtube id", ""), name)

    def test_the_closed_vocabulary_of_the_refusals(self):
        words = set(re.findall(r"return '(\w+)';", code(NEW_BODIES["video_approve_refusal"])))
        self.assertEqual(words, {"video_not_found", "not_uploaded", "gate_blocked", "gate_unknown", "rejected", "already_public",
                                 "no_preview", "cut_unknown", "cut_changed"})
        more = set(re.findall(r"return '(\w+)';", code(NEW_BODIES["video_publish_refusal"])))
        self.assertEqual(more, {"not_approved", "cut_changed", "approval_expired"})
        rpc = set(re.findall(r"'error', '(\w+)'", self.body))
        self.assertEqual(rpc, {"rate_limited", "bad_hash", "ack_required", "already_approved"})


class TheRollbackIsTheExactOldText(unittest.TestCase):
    def test_it_restores_0085_0110_and_0033_verbatim(self):
        rb = bodies(ROLLBACK)
        self.assertEqual(rb["finish_scene_regeneration"], latest("finish_scene_regeneration")[1])
        self.assertEqual(rb["audit_action_allowed"], latest("audit_action_allowed")[1])
        old = (MIGRATIONS / "0033_roles_cleanup.sql").read_text(encoding="utf-8")
        self.assertIn(re.search(r"create policy review_intents_insert on public\.review_intents.*?;\n", old, re.S).group(0), ROLLBACK)

    def test_it_drops_the_three_functions_keeps_the_columns_and_runs_in_one_transaction(self):
        top = outside_bodies(ROLLBACK)
        for fn in ("approve_video_publish(text, text, jsonb)", "video_approve_access(text)", "video_real_member(uuid, text)", "video_publish_refusal(text, text)", "video_approve_refusal(text, text)"):
            self.assertIn(f"drop function if exists public.{fn};", top)
        for forbidden in ("drop column", "delete from", "truncate", "drop table", "update public"):
            self.assertNotIn(forbidden, top.lower(), forbidden)
        self.assertRegex(ROLLBACK, r"(?m)^begin;$")
        self.assertRegex(ROLLBACK, r"(?m)^commit;$")
        self.assertIn("set local lock_timeout = '5s';", ROLLBACK)


if __name__ == "__main__":
    unittest.main()

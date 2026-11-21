"""Migrations 0086, 0087 and 0088 (Breach wave 7 patch), read as text.

The behaviour is proven in a real database by tests/security/
test_sec_breach_channel_config.py, test_sec_breach_audit.py and
test_sec_breach_leaks.py. This file pins what a database test cannot see:

* a function replaced by one of these files is the LATEST body before it with
  only the sanctioned lines changed (house rule: never drop an earlier check);
* every definer function pins its search_path, every function is revoked and
  granted explicitly, nothing is granted to anon or public;
* the writable-column list and the control list the trigger repeats.
"""
from __future__ import annotations

import re
import unittest
from pathlib import Path

MIGRATIONS = Path(__file__).resolve().parents[1] / "supabase" / "migrations"
M86 = (MIGRATIONS / "0086_channel_config_lock.sql").read_text(encoding="utf-8")
M87 = (MIGRATIONS / "0087_audit_and_rate_hardening.sql").read_text(encoding="utf-8")
M88 = (MIGRATIONS / "0088_router_failover_reason.sql").read_text(encoding="utf-8")


def bodies(text):
    return {m.group(1): m.group(0) for m in
            re.finditer(r"create or replace function public\.(\w+)\(.*?\n\$\$;\n", text, re.S)}


def literals(sql):
    code = re.sub(r"--[^\n]*", "", sql)
    return set(re.findall(r"'(?:[^']|'')*'", code))


def lines(sql):
    return [ln for ln in sql.splitlines() if ln.strip() and not ln.strip().startswith("--")]


class ReplacedBodies(unittest.TestCase):
    def test_take_web_rate_is_0042s_body_with_only_the_window_key_changed(self):
        old = bodies((MIGRATIONS / "0042_web_api_hardening.sql").read_text(encoding="utf-8"))["take_web_rate"]
        new = bodies(M87)["take_web_rate"]
        self.assertEqual(sorted(literals(old) - literals(new)), [], "an earlier literal (check, message, code) was lost")
        self.assertEqual(sorted(literals(new) - literals(old)), ["'2 days'", "'@'"])
        # Every check line of the old body is still there, unchanged.
        kept = [ln for ln in lines(old) if "insert into" not in ln and "values (" not in ln and "on conflict" not in ln
                and "delete from" not in ln and "where c.user_id" not in ln and "and c.bucket" not in ln
                and "declare" != ln.strip() and "v_used  integer;" not in ln and "v_start timestamptz;" not in ln]
        missing = [ln for ln in kept if ln not in lines(new)]
        self.assertEqual(missing, [])

    def test_reroute_creative_job_is_0075s_body_with_exactly_the_member_visible_values_changed(self):
        old = bodies((MIGRATIONS / "0075_model_router.sql").read_text(encoding="utf-8"))["reroute_creative_job"]
        new = bodies(M88)["reroute_creative_job"]
        self.assertEqual(sorted(literals(old) - literals(new)), [], "an earlier literal (check, message, code) was lost")
        self.assertEqual(sorted(literals(new) - literals(old)), ["'unavailable'"])
        gone = [ln for ln in lines(old) if ln not in lines(new)]
        self.assertEqual(gone, [
            "       set fallback_from = j.routed_model, fallback_reason = code, routed_model = m,",
            "    update public.creative_job_routes r set tried = r.tried || to_jsonb(m) where r.job_id = p_job;",
            "      jsonb_build_object('from', j.routed_model, 'to', m, 'code', code, 'credits', price));",
        ])
        added = [ln for ln in lines(new) if ln not in lines(old)]
        self.assertEqual(added, [
            "       set fallback_from = j.routed_model, fallback_reason = 'unavailable', routed_model = m,",
            "    update public.creative_job_routes r",
            "       set tried = r.tried || to_jsonb(m), reasons = r.reasons || to_jsonb(code)",
            "     where r.job_id = p_job;",
            "      jsonb_build_object('from', j.routed_model, 'to', m, 'code', 'unavailable', 'credits', price));",
        ])

    def test_the_real_code_never_reaches_a_member_readable_column(self):
        new = bodies(M88)["reroute_creative_job"]
        self.assertNotIn("fallback_reason = code", new)
        self.assertNotIn("'code', code", new)
        self.assertEqual(new.count("reasons = r.reasons || to_jsonb(code)"), 1)
        self.assertIn("alter table public.creative_job_routes add column if not exists reasons jsonb", M88)
        self.assertIn("revoke all on table public.creative_job_routes", (MIGRATIONS / "0075_model_router.sql").read_text())


class EveryFunctionIsLockedDown(unittest.TestCase):
    def test_definer_functions_pin_their_search_path_and_are_revoked_then_granted(self):
        for name, text in (("0086", M86), ("0087", M87), ("0088", M88)):
            code = re.sub(r"--[^\n]*", "", text)
            for fn in re.finditer(r"create or replace function public\.(\w+)\(([^)]*)\)(.*?)\n\$\$;", code, re.S):
                head = fn.group(3).split("$$", 1)[0]
                self.assertIn("set search_path", head, f"{name}: {fn.group(1)} does not pin search_path")
                self.assertRegex(code, rf"revoke all on function public\.{fn.group(1)}\(", f"{name}: {fn.group(1)} is never revoked")
            self.assertNotRegex(code, r"grant [^;]*\bto\b[^;]*\b(anon|public)\b", f"{name} grants to anon or public")
            self.assertNotIn("security definer\n  set search_path = ''", code)

    def test_the_browser_functions_are_granted_to_authenticated_only(self):
        for fn in ("create_channel(text, uuid, text, text, jsonb, jsonb, jsonb, boolean)",
                   "set_channel_credential(text, jsonb, boolean)"):
            self.assertIn(f"grant execute on function public.{fn}\n  to authenticated, service_role;"
                          if fn.startswith("create") else f"grant execute on function public.{fn} to authenticated, service_role;", M86)
        self.assertIn("grant execute on function public.set_channel_status(text, text) to authenticated;", M86)
        self.assertIn("grant execute on function public.take_web_rate(text, integer, integer) to authenticated;", M87)
        self.assertIn("grant execute on function public.reroute_creative_job(uuid, text, text) to service_role;", M88)


class ChannelLock(unittest.TestCase):
    def test_the_browser_roles_lose_insert_and_the_credential_columns(self):
        self.assertIn("revoke insert, update on public.channels from anon, authenticated;", M86)
        grant = re.search(r"grant update \((.*?)\)\s+on public\.channels to authenticated;", M86, re.S).group(1)
        cols = sorted(c.strip() for c in grant.split(","))
        self.assertEqual(cols, sorted(["name", "niche", "agent_config", "schedule_config", "updated_at", "org_id",
                                       "auto_publish", "default_style_kit_id", "dna_format", "dna_aspect", "dna_tone"]))
        for protected in ("credential_ref", "status", "channel_id", "created_at"):
            self.assertNotIn(protected, cols)
        self.assertNotRegex(M86, r"grant\s+insert")

    def test_the_trigger_runs_as_the_caller_and_holds_the_four_controls_to_administrators(self):
        trig = bodies(M86)["channels_config_guard"]
        self.assertNotIn("security definer", trig)
        self.assertIn("if current_user not in ('authenticated', 'anon') then", trig)
        self.assertIn("not public.is_org_member(org, 'admin')", trig)
        self.assertIn("create trigger channels_config_guard\n  before insert or update on public.channels", M86)

    def test_a_member_never_writes_a_stamp_the_database_did_not_make(self):
        build = bodies(M86)["channel_credential_build"]
        self.assertIn("channel_verified_stamp()", build)
        self.assertNotIn("src ->> 'verified_at'", build)
        self.assertNotIn("'verified_at', src", build)
        # The reference is the channel's own id unless the caller is the operator's side.
        self.assertIn("ref := p_channel;\n  if p_ref_ok and p_org = public.default_org_id()", build)

    def test_the_worker_matrix_row_carries_the_flag_the_worker_decides_by(self):
        root = MIGRATIONS.parents[1]
        self.assertIn('operators = bool(getattr(c, "is_operators", False))',
                      (root / "tools" / "list_channels.py").read_text(encoding="utf-8"))
        self.assertIn('allow_env=channel_row.get("is_operators") is True)',
                      (root / "tools" / "queue_worker.py").read_text(encoding="utf-8"))


if __name__ == "__main__":
    unittest.main()

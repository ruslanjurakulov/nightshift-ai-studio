"""Static pins for migration 0227's authorization and gate transitions."""

import re
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
NAME = "0227_owner_model_terms_acceptance.sql"
SQL = (ROOT / "supabase" / "migrations" / NAME).read_text(encoding="utf-8")
ROLLBACK = (ROOT / "docs" / "sql" / f"rollback_{NAME}").read_text(encoding="utf-8")


def definition(name):
    match = re.search(rf"create or replace function public\.{name}\([^\n]*\)(.*?)\n\$\$;", SQL, re.S)
    if match is None:
        raise AssertionError(f"Missing migration function {name}")
    return match.group(1)


class OwnerModelTermsAcceptanceMigration(unittest.TestCase):
    def test_only_the_platform_owner_may_change_acceptance(self):
        for name in ("owner_accept_model_terms", "owner_revoke_model_terms"):
            with self.subTest(function=name):
                fn = definition(name)
                self.assertIn("security definer set search_path = public, pg_temp", fn)
                self.assertRegex(fn, r"if auth.uid\(\) is null or public\.platform_role\(\) is distinct from 'owner' then\s+"
                                     r"raise exception 'owner_required' using errcode = '42501';")
                self.assertRegex(SQL, rf"revoke all on function public\.{name}\([^\n]*\) from public, anon, authenticated, service_role;")
                self.assertRegex(SQL, rf"grant execute on function public\.{name}\([^\n]*\) to authenticated;")

    def test_direct_access_is_closed_and_read_is_operator_only(self):
        self.assertIn("alter table public.model_terms_acceptance enable row level security;", SQL)
        self.assertIn("revoke all on table public.model_terms_acceptance from public, anon, authenticated", SQL)
        read = definition("model_terms_acceptance_admin")
        self.assertIn("security definer set search_path = public, pg_temp", read)
        self.assertIn("if auth.uid() is null or not public.is_platform_admin() then", read)

    def test_bytedance_and_unknown_models_are_refused(self):
        accept = definition("owner_accept_model_terms")
        self.assertIn("if not found then", accept)
        self.assertRegex(accept, r"if m\.provider = 'bytedance' then\s+raise exception 'bytedance_forbidden'")

    def test_acceptance_requires_the_current_nonempty_gate_and_exact_id(self):
        accept = definition("owner_accept_model_terms")
        self.assertIn("coalesce(m.spec ->> 'terms_gate', '') = ''", accept)
        self.assertIn("m.spec ->> 'terms_gate' is distinct from p_gate", accept)
        self.assertRegex(accept, r"if p_confirm is distinct from m\.id then\s+raise exception 'bad_confirm'")
        self.assertIn("update public.model_registry set spec = spec - 'terms_gate' where id = m.id", accept)
        self.assertNotRegex(accept, r"set\s+availability\s*=")

    def test_acceptance_records_the_vendor_after_clearing_the_gate(self):
        self.assertIn("provider text not null,\n  adapter text not null,\n  vendor_model text,", SQL)
        accept = definition("owner_accept_model_terms")
        self.assertRegex(
            accept,
            r"update public\.model_registry set spec = spec - 'terms_gate' where id = m\.id;\s+"
            r"insert into public\.model_terms_acceptance \(model_id, gate, provider, adapter, vendor_model, accepted_by\)\s+"
            r"values \(m\.id, p_gate, m\.provider, m\.adapter, m\.spec ->> 'vendor_model', auth\.uid\(\)\)",
        )

    def test_sync_strips_only_the_accepted_gate_for_the_same_vendor(self):
        self.assertRegex(SQL, r"create trigger model_terms_acceptance_guard\s+"
                              r"before update of spec, provider, adapter on public\.model_registry")
        trigger = definition("model_terms_acceptance_guard")
        self.assertRegex(
            trigger,
            r"elsif new\.provider <> 'bytedance' and exists \(\s+"
            r"select 1 from public\.model_terms_acceptance a\s+"
            r"where a\.model_id = new\.id and a\.gate = incoming_gate\s+"
            r"and a\.provider = new\.provider and a\.adapter = new\.adapter\s+"
            r"and a\.vendor_model is not distinct from new\.spec ->> 'vendor_model'\s+"
            r"\) then\s+new\.spec := new\.spec - 'terms_gate';\s+"
            r"elsif new\.availability in \('beta', 'ga'\)\s+"
            r"and exists \(select 1 from public\.model_terms_acceptance a where a\.model_id = new\.id\) then\s+"
            r"(--[^\n]*\s+)*new\.availability := 'hidden';",
        )

    def test_a_gated_model_that_was_never_accepted_still_fails_the_check_loudly(self):
        # Hiding silently is only for a model the owner put on sale through an acceptance; any other gated model on sale
        # must keep failing 0035's CHECK, so a bad sync stops instead of quietly taking a model off sale.
        trigger = definition("model_terms_acceptance_guard")
        self.assertNotRegex(trigger, r"elsif new\.availability in \('beta', 'ga'\) then")

    def test_an_ungated_sync_consumes_the_acceptance(self):
        trigger = definition("model_terms_acceptance_guard")
        self.assertIn("incoming_gate text := nullif(new.spec ->> 'terms_gate', '');", trigger)
        self.assertRegex(trigger, r"if incoming_gate is null then\s+"
                                  r"delete from public\.model_terms_acceptance where model_id = old\.id;")

    def test_revocation_restores_the_gate_and_hides_a_model_on_sale(self):
        revoke = definition("owner_revoke_model_terms")
        delete = "delete from public.model_terms_acceptance where model_id = m.id returning gate into recorded_gate"
        self.assertIn(delete, revoke)
        self.assertIn("restored_gate := coalesce(nullif(m.spec ->> 'terms_gate', ''), recorded_gate)", revoke)
        self.assertIn("spec = jsonb_set(spec, '{terms_gate}', to_jsonb(restored_gate))", revoke)
        self.assertIn("case when availability in ('beta', 'ga') then 'hidden' else availability end", revoke)

    def test_rollback_restores_gates_before_removing_records(self):
        self.assertRegex(ROLLBACK, r"(?s)update public\.model_registry.*?jsonb_set.*?a\.gate.*?drop table public\.model_terms_acceptance;")
        self.assertIn("a.provider = m.provider and a.adapter = m.adapter", ROLLBACK)
        self.assertIn("a.vendor_model is not distinct from m.spec ->> 'vendor_model'", ROLLBACK)

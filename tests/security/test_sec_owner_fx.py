"""Named attacks on the owner's frozen exchange rates (migration 0185), and what a frozen rate may be.

Everyone but the platform owner is refused before anything is read (an admin too); anon and the service role cannot execute;
the table is closed; with 0107's gate on, a password-only owner cannot write. A rate is one per day and currency, setting it
again replaces it, and nothing absurd is stored: no UZS-to-UZS, no future day, no zero, no NaN, no anonymous source.
"""

from __future__ import annotations

import uuid

import pytest

from sec_db import ANON, SERVICE, acting, as_superuser, user

CALLS = [
    ("select public.owner_analytics_fx_set('2026-10-02', 'USD', 12000, 'CBU')", None),
    ("select public.owner_analytics_fx_delete('2026-10-02', 'USD')", None),
    ("select * from public.owner_analytics_fx_rates('2026-01-01', '2026-12-31')", None),
]
IDS = ["set", "delete", "rates"]


@pytest.mark.parametrize("call", CALLS, ids=IDS)
@pytest.mark.parametrize("who", ["alice", "dana", "admin"])
def test_everyone_but_the_owner_is_refused(conn, sc, who, call):
    with as_superuser(conn, commit=False) as su:
        admin = user("fx-admin", "fx-admin@example.test")
        su.rows("insert into auth.users (id, email, email_confirmed_at) values (%s, %s, now()) returning 1", [admin.uid, admin.email])
        su.rows("insert into public.app_members (user_id, email, role) values (%s, %s, 'admin') returning 1", [admin.uid, admin.email])
        actor = {"alice": sc.alice.actor, "dana": sc.dana, "admin": admin}[who]
        with acting(conn, actor) as s:
            out = s.run(*call)
    assert not out.ok and out.sqlstate == "42501" and out.error == "not available", out


@pytest.mark.parametrize("call", CALLS, ids=IDS)
def test_anon_and_the_service_role_cannot_execute_them(conn, sc, call):
    for who in (ANON, SERVICE):
        with acting(conn, who) as s:
            out = s.run(*call)
        assert not out.ok and out.sqlstate == "42501", (who.name, out)


def test_the_table_is_closed_even_to_the_owner(conn, sc):
    for who in (sc.operator, sc.alice.actor, SERVICE):
        with acting(conn, who) as s:
            sel = s.run("select * from public.owner_fx_rates")
            ins = s.run("insert into public.owner_fx_rates (rate_date, currency, uzs_per_unit, source, entered_by) "
                        "values ('2026-10-03', 'USD', 1, 'x', %s)", [sc.operator.uid])
        assert not sel.ok and sel.sqlstate == "42501", (who.name, sel)
        assert not ins.ok and ins.sqlstate == "42501", (who.name, ins)


@pytest.mark.parametrize("args", [
    "'2026-10-02', 'UZS', 1, 'CBU'",
    "'2026-10-02', 'usd', 1, 'CBU'",
    "'2099-01-01', 'USD', 1, 'CBU'",
    "'-infinity', 'USD', 1, 'CBU'",
    "'2026-10-02', 'USD', 0, 'CBU'",
    "'2026-10-02', 'USD', 'NaN', 'CBU'",
    "'2026-10-02', 'USD', 1e9, 'CBU'",
    "'2026-10-02', 'USD', 1, '   '",
])
def test_an_absurd_rate_is_refused(conn, sc, args):
    with acting(conn, sc.operator) as s:
        out = s.run(f"select public.owner_analytics_fx_set({args})")
    assert not out.ok and out.sqlstate == "22023", (args, out)


def test_one_rate_per_day_and_currency_and_setting_it_again_replaces_it(conn, sc):
    with acting(conn, sc.operator) as s:
        s.value("select public.owner_analytics_fx_set('2026-10-02', 'USD', 12000.12345, ' CBU ')")
        s.value("select public.owner_analytics_fx_set('2026-10-02', 'USD', 12100, 'CBU, corrected')")
        rows = s.rows("select rate_date::text, currency, uzs_per_unit::text, source from public.owner_analytics_fx_rates('2026-10-02', '2026-10-02')")
        gone = s.value("select public.owner_analytics_fx_delete('2026-10-02', 'USD')")
        again = s.value("select public.owner_analytics_fx_delete('2026-10-02', 'USD')")
    assert rows == [("2026-10-02", "USD", "12100.0000", "CBU, corrected")], rows
    assert (gone, again) == (True, False)


def test_with_the_mfa_gate_on_a_password_only_owner_cannot_freeze_a_rate(conn, sc):
    with as_superuser(conn, commit=False) as su:
        su.rows("update public.owner_security_settings set admin_aal2_required = true returning 1")
        su.rows("insert into auth.mfa_factors (id, user_id, status) values (%s, %s, 'verified') returning 1", [str(uuid.uuid4()), sc.operator.uid])
        with acting(conn, sc.operator) as s:
            out = s.run("select public.owner_analytics_fx_set('2026-10-02', 'USD', 1, 'CBU')")
            read = s.run("select count(*) from public.owner_analytics_fx_rates('2026-01-01', '2026-12-31')")
    assert not out.ok and out.sqlstate == "NS401", out
    assert read.ok, read

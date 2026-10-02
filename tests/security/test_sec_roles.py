"""Regressions for the holes migration 0033 (roles cleanup) closes.

Each test here failed against 0001–0032 and passes with 0033:

* The operator's own data (provider balances, top-ups and billing settings,
  legacy global scores, the platform roster, and the channel-less rows of the
  event / alert / audit streams) was readable by ANY member of the default
  organization — every account that existed when 0018 ran, and anyone invited
  to the operator's org since — not only by the platform admin.
* current_app_role() answered 'viewer' for every signed-in account, so "the
  caller has at least viewer" was true of any signup.
* review_intents accepted another organization's video id under the caller's
  own channel.
* The tenancy helpers were executable by anon; channel_org() told the internet
  which organization owns any channel id.

Dana is the default-org member: a viewer of the operator's organization who is
not on the platform roster.
"""

from __future__ import annotations

import pytest

from sec_db import ANON, acting

OPERATOR_TABLES = ["app_members", "provider_balances", "provider_billing_settings", "provider_topups",
                   "topic_performance"]
MIXED_STREAMS = ["system_events", "alert_events", "app_audit_log"]


@pytest.mark.parametrize("table", OPERATOR_TABLES)
def test_a_default_org_member_does_not_read_operator_tables(conn, sc, table):
    with acting(conn, sc.dana) as s:
        rows = s.rows(f"select 1 from public.{table}")
    assert rows == [], f"{table}: a default-org member who is not a platform admin reads {len(rows)} rows"
    with acting(conn, sc.operator) as s:  # control: the platform admin still does
        assert s.rows(f"select 1 from public.{table}") != []


@pytest.mark.parametrize("table", MIXED_STREAMS)
def test_a_default_org_member_does_not_read_global_stream_rows(conn, sc, table):
    with acting(conn, sc.dana) as s:
        global_rows = s.rows(f"select 1 from public.{table} where channel_id is null")
        own_org_rows = s.rows(f"select 1 from public.{table} where channel_id = 'default'")
    assert global_rows == [], f"{table}: a default-org member reads the operator's channel-less rows"
    if table == "system_events":  # the stream the scenario seeds on the default channel
        assert own_org_rows != [], f"{table}: org membership itself must keep working (default channel rows)"
    with acting(conn, sc.operator) as s:
        assert s.rows(f"select 1 from public.{table} where channel_id is null") != []


@pytest.mark.parametrize("table,insert", [
    ("alert_events", "insert into public.alert_events (kind, severity, channel_id, title) values ('x', 'info', null, 't')"),
    ("app_audit_log", "insert into public.app_audit_log (actor_user_id, action, channel_id) values (auth.uid(), 'secret.write', null)"),
])
def test_only_the_platform_admin_writes_global_stream_rows(conn, sc, table, insert):
    with acting(conn, sc.dana) as s:
        out = s.run(insert)
    assert not out.ok and out.sqlstate == "42501", f"{table}: {out!r}"
    with acting(conn, sc.operator) as s:
        assert s.run(insert).ok


@pytest.mark.parametrize("insert", [
    "insert into public.provider_topups (provider, amount_usd) values ('elevenlabs', 5)",
    "insert into public.provider_billing_settings (provider) values ('gemini')",
    "update public.provider_billing_settings set low_balance_days = 3",
])
def test_only_the_platform_admin_writes_provider_billing(conn, sc, insert):
    for who in (sc.dana, sc.bob.actor):
        with acting(conn, who) as s:
            out = s.run(insert)
        assert (not out.ok) or out.rowcount == 0, (who.name, out)
    with acting(conn, sc.operator) as s:
        out = s.run(insert)
    assert out.ok and out.rowcount == 1, out


def test_a_default_org_member_still_sees_the_default_orgs_channels(conn, sc):
    # The cleanup takes away operator data, not org membership.
    with acting(conn, sc.dana) as s:
        assert s.value("select count(*) from public.videos where video_id = %s", [sc.operator_video]) == 1


def test_current_app_role_has_no_default_for_people_off_the_roster(conn, sc):
    for who in (sc.bob.actor, sc.alice.actor, sc.stranger, sc.dana):
        with acting(conn, who) as s:
            assert s.value("select public.current_app_role()") is None, who.name
            assert s.value("select public.bind_current_member()") is None, who.name
            assert s.value("select public.app_role_rank(public.current_app_role())") == 0, who.name
    with acting(conn, sc.operator) as s:
        assert s.value("select public.current_app_role()") == "owner"
        assert s.value("select public.bind_current_member()") == "owner"


def test_review_intent_must_name_a_video_on_its_own_channel(conn, sc):
    q = "insert into public.review_intents (channel_id, video_id, action) values (%s, %s, 'approve')"
    with acting(conn, sc.bob.actor) as s:
        control = s.run(q, [sc.bob.channel, sc.bob.video])
        foreign = s.run(q, [sc.bob.channel, sc.alice.video])
        operator = s.run(q, [sc.bob.channel, sc.operator_video])
        no_video = s.run(q, [sc.bob.channel, None])
    assert control.ok, control
    assert no_video.ok, no_video
    assert not foreign.ok and foreign.sqlstate == "42501", f"Bob filed an intent on org A's video: {foreign!r}"
    assert not operator.ok and operator.sqlstate == "42501", operator


@pytest.mark.parametrize("call", [
    "select public.channel_org('chan-a')",
    "select public.app_members_empty()",
    "select public.is_org_member('00000000-0000-0000-0000-000000000001', 'viewer')",
    "select count(*) from public.accessible_channel_ids('viewer')",
])
def test_anon_cannot_probe_tenancy(conn, sc, call):
    with acting(conn, ANON) as s:
        out = s.run(call)
    assert not out.ok and out.sqlstate == "42501", out

"""Migration 0205 (Instagram API with Unified Login) against a real Postgres.

What must hold:
* an Instagram connect is a Unified Login one with its configuration id, or it is refused (an old Instagram Login token
  could only fail on graph.facebook.com, so storing one would be a connection that never works);
* the three new keys are Instagram-only and validated;
* the binding stays per organization: a second organization that connects the same IG account gets its own row and its
  own Vault secret, and the first organization's row, token and marker are untouched;
* an old Instagram Login row is kept as it was (no update, no delete) and reads as "reconnect needed" by its auth_flow;
* nothing returns or stores a token outside Vault.
"""

from __future__ import annotations

import json

from sec_db import acting, as_superuser

TOKEN = "EAAB" + "x" * 60


def _store(s, org, platform, meta, refresh=None):
    return s.run("select public.store_social_account(%s, %s, %s, %s, %s::jsonb)",
                 [org, platform, TOKEN, refresh, json.dumps(meta)])


def _ig(external_id, **extra):
    return {"external_id": external_id, "username": "acct", "scopes": [], **extra}


def test_an_instagram_connect_must_be_unified_login_with_its_configuration(conn, sc):
    with acting(conn, sc.bob.actor) as s:
        old = _store(s, sc.bob.org, "instagram", _ig("17841400000000001"))
        no_cfg = _store(s, sc.bob.org, "instagram", _ig("17841400000000001", auth_flow="unified_login"))
        bad_cfg = _store(s, sc.bob.org, "instagram", _ig("17841400000000001", auth_flow="unified_login",
                                                         config_id="12; drop"))
        bad_biz = _store(s, sc.bob.org, "instagram", _ig("17841400000000001", auth_flow="unified_login",
                                                         config_id="987654321", client_business_id="x"))
        wrong_flow = _store(s, sc.bob.org, "instagram", _ig("17841400000000001", auth_flow="instagram_login",
                                                            config_id="987654321"))
        tiktok = _store(s, sc.bob.org, "tiktok", {"external_id": "open-1", "config_id": "987654321"}, refresh="rft." + "y" * 40)
        # A claimed scope outside the connect flow's list is still refused (0028's rule, kept).
        scopes = _store(s, sc.bob.org, "instagram", _ig("17841400000000001", auth_flow="unified_login",
                                                        config_id="987654321", scopes=["instagram_manage_insights"]))
    for out in (old, no_cfg, bad_cfg, bad_biz, wrong_flow, tiktok, scopes):
        assert not out.ok and out.sqlstate == "22023", out
        assert TOKEN not in (out.error or "")


def test_a_unified_login_connect_is_stored_with_its_ids_and_no_token_in_the_row(conn, sc):
    with acting(conn, sc.bob.actor) as s:
        out = _store(s, sc.bob.org, "instagram", _ig("17841400000000002", auth_flow="unified_login",
                                                     config_id="987654321", client_business_id="555"))
        assert out.ok, out
        ret = out.rows[0][0]
        assert set(ret) == {"id", "platform", "external_id", "connected"}, ret
        row = s.rows("select auth_flow, config_id, client_business_id, status, scopes, to_jsonb(a)::text "
                     "from public.social_accounts a where id = %s", [ret["id"]])[0]
    assert row[:5] == ("unified_login", "987654321", "555", "connected", [])
    assert TOKEN not in row[5]


def test_another_org_connecting_the_same_account_gets_its_own_row_and_never_touches_the_first(conn, sc):
    with as_superuser(conn, commit=False) as s:
        alice_ext = s.value("select external_id from public.social_accounts where id = %s", [sc.alice.social_account])
        before = s.rows("select a.auth_flow, a.status, a.updated_at, x.access_secret_id from public.social_accounts a "
                        "join public.social_account_secrets x on x.account_id = a.id where a.id = %s",
                        [sc.alice.social_account])[0]
    with acting(conn, sc.bob.actor) as s:
        # Bob's own org: allowed, and it is a new row of Bob's.
        mine = _store(s, sc.bob.org, "instagram", _ig(alice_ext, auth_flow="unified_login", config_id="987654321"))
        # Alice's org: refused outright (0028's editor check, first).
        theirs = _store(s, sc.alice.org, "instagram", _ig(alice_ext, auth_flow="unified_login", config_id="987654321"))
        # And no direct write on the table, whatever the column.
        poke = s.run("update public.social_accounts set auth_flow = 'unified_login' where id = %s", [sc.alice.social_account])
        assert mine.ok, mine
        new_id = mine.rows[0][0]["id"]
        new_org = s.value("select org_id from public.social_accounts where id = %s", [new_id])
        # The ground truth, read in the same (uncommitted) transaction as the database owner.
        s.rows("reset role")
        after = s.rows("select a.auth_flow, a.status, a.updated_at, x.access_secret_id from public.social_accounts a "
                       "join public.social_account_secrets x on x.account_id = a.id where a.id = %s",
                       [sc.alice.social_account])[0]
    assert new_id != sc.alice.social_account and str(new_org) == sc.bob.org
    assert not theirs.ok and theirs.sqlstate == "42501", theirs
    assert not poke.ok and poke.sqlstate == "42501", poke
    assert after == before


def test_an_old_instagram_login_row_is_kept_as_it_was(conn, sc):
    # The lab's seeded rows stand for connections made before 0205: still there, still 'connected' in the table, and
    # marked only by the absence of 'unified_login' (the Command Center shows "reconnect needed"; the worker refuses).
    with as_superuser(conn, commit=False) as s:
        rows = s.rows("select auth_flow, config_id, client_business_id, status from public.social_accounts "
                      "where id in (%s, %s)", [sc.alice.social_account, sc.bob.social_account])
    assert sorted(rows) == [(None, None, None, "connected")] * 2


def test_a_reconnect_through_unified_login_turns_the_old_row_into_a_new_one(conn, sc):
    with as_superuser(conn, commit=False) as s:
        ext = s.value("select external_id from public.social_accounts where id = %s", [sc.bob.social_account])
    with acting(conn, sc.bob.actor) as s:
        out = _store(s, sc.bob.org, "instagram", _ig(ext, auth_flow="unified_login", config_id="987654321"))
        assert out.ok, out
        assert out.rows[0][0]["id"] == sc.bob.social_account
        flow = s.value("select auth_flow from public.social_accounts where id = %s", [sc.bob.social_account])
    assert flow == "unified_login"


def test_anon_and_the_browser_cannot_read_a_token_or_widen_the_grant(conn, sc):
    with as_superuser(conn, commit=False) as s:
        grants = s.rows(
            "select has_function_privilege('anon', 'public.store_social_account(uuid, text, text, text, jsonb)', 'EXECUTE'), "
            "has_table_privilege('authenticated', 'public.social_accounts', 'UPDATE'), "
            "has_table_privilege('authenticated', 'public.social_account_secrets', 'SELECT')")[0]
    assert grants == (False, False, False)


def test_the_public_api_reports_an_old_instagram_row_as_not_connected_and_a_unified_one_as_connected(conn, sc):
    """Lens M1: api_list_connected_accounts (0042's body) said connected = status = 'connected', so the public API and the
    MCP tools called an old Instagram Login row connected. 0205's hunk: an Instagram row is connected only with
    auth_flow = 'unified_login'. TikTok is unchanged."""
    from sec_db import ANON

    def listed():
        with acting(conn, ANON) as s:
            out = s.run("select public.api_list_connected_accounts(%s, null)", [sc.bob.api_key_hash])
        assert out.ok, out
        body = out.rows[0][0]
        accounts = (body.get("data") or body).get("accounts") if isinstance(body, dict) else None
        assert isinstance(accounts, list), body
        return {a["account_id"]: a["connected"] for a in accounts if a.get("account_id")}

    assert listed()[sc.bob.social_account] is False
    with as_superuser(conn, commit=False) as s:
        s.rows("update public.social_accounts set auth_flow = 'unified_login', config_id = '987654321' where id = %s returning 1",
               [sc.bob.social_account])
        out = s.run("select public.api_list_connected_accounts(%s, null)", [sc.bob.api_key_hash])
        body = out.rows[0][0]
        accounts = (body.get("data") or body).get("accounts")
        assert {a["account_id"]: a["connected"] for a in accounts if a.get("account_id")}[sc.bob.social_account] is True

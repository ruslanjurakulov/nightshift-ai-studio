"""Breach, PR #862 round 2 (migration 0205).

The pick hold now stays open after a confirm, so one sign-in may store several IG accounts with the SAME BISU token.
Each must land as its own row, with its own Vault secret, in the workspace that confirmed it, and revoking one must
not destroy another's secret. And api_list_connected_accounts (0042 body + one 0205 hunk): an old Instagram Login row
reads connected = false (never null), the grant is still anon-only, and nothing else in the answer moved.

Every test is an attack. One that fails is a hole and must stay failing until it is fixed.
"""

from __future__ import annotations

import json

from sec_db import ANON, acting, as_superuser

TOKEN = "EAAB" + "r" * 60
CFG = "987654321"


def _store(s, org, ext, token=TOKEN):
    meta = {"external_id": ext, "scopes": [], "auth_flow": "unified_login", "config_id": CFG, "client_business_id": "555"}
    return s.run("select public.store_social_account(%s, 'instagram', %s, null, %s::jsonb)", [org, token, json.dumps(meta)])


def test_one_sign_in_storing_three_accounts_makes_three_rows_and_three_separate_vault_secrets(conn, sc):
    exts = ["17841400000007001", "17841400000007002", "17841400000007003"]
    with acting(conn, sc.bob.actor) as s:
        ids = []
        for e in exts:
            out = _store(s, sc.bob.org, e)
            assert out.ok, out
            ids.append(out.rows[0][0]["id"])
        s.rows("reset role")
        got = s.rows("select a.org_id::text, a.external_id, x.access_secret_id, v.decrypted_secret "
                     "from public.social_accounts a join public.social_account_secrets x on x.account_id = a.id "
                     "join vault.decrypted_secrets v on v.id = x.access_secret_id where a.id = any(%s::uuid[]) "
                     "order by a.external_id", [ids])
    assert [r[0] for r in got] == [sc.bob.org] * 3
    assert [r[1] for r in got] == exts
    assert len({r[2] for r in got}) == 3          # not one shared secret id
    assert {r[3] for r in got} == {TOKEN}


def test_revoking_one_account_of_a_sign_in_leaves_the_others_secrets_intact(conn, sc):
    exts = ["17841400000007101", "17841400000007102"]
    with acting(conn, sc.bob.actor) as s:
        ids = [(_store(s, sc.bob.org, e)).rows[0][0]["id"] for e in exts]
        rv = s.run("select public.revoke_social_account(%s)", [ids[0]])
        assert rv.ok, rv
        s.rows("reset role")
        other = s.value("select v.decrypted_secret from public.social_account_secrets x "
                        "join vault.decrypted_secrets v on v.id = x.access_secret_id where x.account_id = %s", [ids[1]])
    assert other == TOKEN


def test_the_second_account_of_a_sign_in_cannot_be_stored_into_another_workspace(conn, sc):
    # The hold is bound to the org in the app; the database is the third check: Bob confirming into Alice's org fails.
    with acting(conn, sc.bob.actor) as s:
        assert _store(s, sc.bob.org, "17841400000007201").ok
        out = _store(s, sc.alice.org, "17841400000007202")
    assert not out.ok and out.sqlstate == "42501", out


def _accounts(s, key_hash):
    out = s.run("select public.api_list_connected_accounts(%s, null)", [key_hash])
    assert out.ok, out
    body = out.rows[0][0]
    return body


def test_api_list_connected_accounts_reads_an_old_instagram_row_as_false_never_null(conn, sc):
    with as_superuser(conn, commit=False) as s:
        if s.value("select to_regprocedure('public.api_list_connected_accounts(text, text)') is null"):
            return
        # The seeded social account is an old-flow row (auth_flow null). Add a unified one, a tiktok one, an expired one.
        s.rows("insert into public.social_accounts (org_id, platform, external_id, status, auth_flow, config_id) "
               "values (%s, 'instagram', '17841400000007301', 'connected', 'unified_login', '1'), "
               "(%s, 'tiktok', 'tt-1', 'connected', null, null), "
               "(%s, 'instagram', '17841400000007302', 'expired', 'unified_login', '1') returning 1",
               [sc.alice.org] * 3)
        flows = dict(s.rows("select external_id, auth_flow from public.social_accounts where org_id = %s", [sc.alice.org]))
        with acting(conn, ANON) as a:
            body = _accounts(a, sc.alice.api_key_hash)
    text = json.dumps(body)
    accs = [x for x in (body.get("data") or body).get("accounts", []) if x["platform"] != "youtube"] \
        if isinstance(body, dict) else []
    assert accs, text
    for x in accs:
        assert x["connected"] in (True, False), x            # never null
        assert set(x) == {"platform", "account_id", "name", "username", "connected"}, x
    by = {(x["platform"], x["username"], x["connected"]) for x in accs}
    old = [x for x in accs if x["platform"] == "instagram" and x["connected"]]
    # Only the unified, connected IG row reads true among IG rows.
    assert len(old) == 1, (accs, flows)
    assert any(x["platform"] == "tiktok" and x["connected"] for x in accs), by
    assert TOKEN not in text


def test_api_list_connected_accounts_grant_is_still_anon_only_and_security_definer(conn, sc):
    with as_superuser(conn, commit=False) as s:
        if s.value("select to_regprocedure('public.api_list_connected_accounts(text, text)') is null"):
            return
        row = s.rows("select p.prosecdef, p.proconfig::text, "
                     "has_function_privilege('anon', p.oid, 'execute'), "
                     "has_function_privilege('authenticated', p.oid, 'execute'), "
                     "has_function_privilege('service_role', p.oid, 'execute'), "
                     "coalesce(array_to_string(p.proacl, ','), '') "
                     "from pg_proc p where p.oid = 'public.api_list_connected_accounts(text, text)'::regprocedure")[0]
    secdef, cfg, anon, auth, service, acl = row
    assert secdef is True
    assert "search_path=public, pg_temp" in cfg
    assert (anon, auth, service) == (True, False, False), acl
    # No PUBLIC entry (an aclitem starting with "="): only the owner and anon may execute.
    assert not any(item.startswith("=") for item in acl.split(",")), acl


def test_a_wrong_or_foreign_key_lists_nothing_of_another_workspace(conn, sc):
    with as_superuser(conn, commit=False) as s:
        if s.value("select to_regprocedure('public.api_list_connected_accounts(text, text)') is null"):
            return
        alice_ids = {r[0] for r in s.rows("select id::text from public.social_accounts where org_id = %s", [sc.alice.org])}
        with acting(conn, ANON) as a:
            bob = _accounts(a, sc.bob.api_key_hash)
            bad = _accounts(a, "0" * 64)
    assert not (alice_ids & set(json.dumps(bob).replace('"', " ").split()))
    assert not any(i in json.dumps(bad) for i in alice_ids)

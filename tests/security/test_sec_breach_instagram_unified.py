"""Breach, PR #862 / migration 0205 (Instagram API with Unified Login).

Lab half (real Postgres, tests/security/bootstrap.sql + every migration): who may call store_social_account, what p_meta
can smuggle in, whether workspace B can reach workspace A's row or Vault secret for the same IG account, and whether a
forged claim reads a token. Worker half (no database, mocked HTTP, never Meta): an old-flow row, a limit read that could
fail open, error 190, and config_issue.

Every test is an attack. One that fails is a hole and must stay failing until it is fixed.
"""

from __future__ import annotations

import json

import pytest

from sec_db import ANON, SERVICE, acting, as_superuser
from sec_scenario import seat_invitee

from modules import social_publish as sp
from tests.test_social_publish import LIMIT_OK, Base, FakeHTTP, FakeStore, FakeTokens, Resp
from tests.test_social_publish import TOKEN as WORKER_TOKEN

TOKEN = "EAAB" + "q" * 60
CFG = "987654321"


def _store(s, org, platform="instagram", meta=None, token=TOKEN, refresh=None):
    return s.run("select public.store_social_account(%s, %s, %s, %s, %s::jsonb)",
                 [org, platform, token, refresh, json.dumps(meta if meta is not None else {})])


def _ig(external_id="17841400000009001", **extra):
    return {"external_id": external_id, "scopes": [], "auth_flow": "unified_login", "config_id": CFG, **extra}


# ── who may call store_social_account ──────────────────────────────────────────────────────────────────────────────


def test_a_viewer_of_the_workspace_cannot_connect_an_instagram_account(conn, sc):
    with acting(conn, sc.invitee) as s:
        seat_invitee(s, sc)
        out = _store(s, sc.alice.org, meta=_ig())
    assert not out.ok and out.sqlstate == "42501", out


def test_a_stranger_anon_and_the_service_key_cannot_connect(conn, sc):
    with acting(conn, sc.stranger) as s:
        stranger = _store(s, sc.alice.org, meta=_ig())
    with acting(conn, ANON) as s:
        anon = _store(s, sc.alice.org, meta=_ig())
    with acting(conn, SERVICE) as s:
        service = _store(s, sc.alice.org, meta=_ig())
    for out in (stranger, anon, service):
        assert not out.ok and out.sqlstate == "42501", out


def test_a_forged_service_role_claim_on_a_browser_session_reads_no_token(conn, sc):
    # social_trusted_caller() believes auth.role() from the claims; the EXECUTE grant (service_role only) is the wall.
    with acting(conn, sc.bob.actor) as s:
        s.run("select set_config('request.jwt.claims', %s, true)", [json.dumps({"role": "service_role", "sub": sc.bob.actor.uid})])
        forged = s.run("select * from public.read_social_token(%s)", [sc.alice.social_account])
        status = s.run("select public.set_social_account_status(%s, 'connected')", [sc.alice.social_account])
        s.run("select set_config('request.jwt.claims', '', true)")
        empty = s.run("select * from public.read_social_token(%s)", [sc.alice.social_account])
    for out in (forged, status, empty):
        assert not out.ok and out.sqlstate == "42501", out


# ── p_meta injection ───────────────────────────────────────────────────────────────────────────────────────────────


@pytest.mark.parametrize("meta, platform, refresh", [
    (_ig(config_id="1" * 65), "instagram", None),                       # oversized id
    (_ig(config_id="١٢٣"), "instagram", None),           # Arabic-Indic digits are not [0-9]
    (_ig(config_id="123\n456"), "instagram", None),
    (_ig(config_id="-1"), "instagram", None),
    (_ig(config_id="1e9"), "instagram", None),
    (_ig(config_id=None), "instagram", None),
    (_ig(config_id=[CFG]), "instagram", None),
    (_ig(config_id={"id": CFG}), "instagram", None),
    (_ig(auth_flow=["unified_login"]), "instagram", None),
    (_ig(auth_flow={"v": "unified_login"}), "instagram", None),
    (_ig(auth_flow="UNIFIED_LOGIN"), "instagram", None),
    (_ig(auth_flow="unified_login​"), "instagram", None),
    (_ig(client_business_id="5" * 65), "instagram", None),
    (_ig(client_business_id="0x1f"), "instagram", None),
    (_ig(status="revoked"), "instagram", None),                         # a column name is not a meta key
    (_ig(org_id="00000000-0000-0000-0000-000000000001"), "instagram", None),
    (_ig(created_by="00000000-0000-0000-0000-000000000001"), "instagram", None),
    (_ig(), "instagram", "rft." + "r" * 40),                            # Instagram has no refresh token
    ({"external_id": "open-1", "auth_flow": "unified_login"}, "tiktok", "rft." + "r" * 40),
    ({"external_id": "open-1", "client_business_id": "555"}, "tiktok", "rft." + "r" * 40),
    ({"external_id": "open-1", "config_id": CFG}, "tiktok", "rft." + "r" * 40),
    (_ig(external_id="../../17841400000009001"), "instagram", None),
    (_ig(external_id="1" * 129), "instagram", None),
])
def test_p_meta_cannot_smuggle_a_flow_an_id_or_a_column(conn, sc, meta, platform, refresh):
    with acting(conn, sc.bob.actor) as s:
        out = _store(s, sc.bob.org, platform, meta, refresh=refresh)
    assert not out.ok and out.sqlstate == "22023", out
    assert TOKEN not in (out.error or "")


def test_an_oversized_display_field_is_cut_not_stored_whole(conn, sc):
    with acting(conn, sc.bob.actor) as s:
        out = _store(s, sc.bob.org, meta=_ig(username="u" * 100_000, display_name="d" * 100_000,
                                             avatar_url="javascript:alert(1)"))
        assert out.ok, out
        row = s.rows("select char_length(username), char_length(display_name), avatar_url "
                     "from public.social_accounts where id = %s", [out.rows[0][0]["id"]])[0]
    assert row == (100, 200, None)


def test_the_table_constraints_hold_even_for_the_database_owner(conn, sc):
    with as_superuser(conn, commit=False) as s:
        tiktok_flow = s.run("insert into public.social_accounts (org_id, platform, external_id, status, created_by, auth_flow) "
                            "values (%s, 'tiktok', 'oid-x', 'connected', %s, 'unified_login')",
                            [sc.bob.org, sc.bob.actor.uid])
        other_flow = s.run("update public.social_accounts set auth_flow = 'instagram_login' where id = %s",
                           [sc.bob.social_account])
        bad_cfg = s.run("update public.social_accounts set config_id = '12a' where id = %s", [sc.bob.social_account])
        bad_biz = s.run("update public.social_accounts set client_business_id = '' where id = %s", [sc.bob.social_account])
    for out in (tiktok_flow, other_flow, bad_cfg, bad_biz):
        assert not out.ok and out.sqlstate == "23514", out


# ── workspace binding ──────────────────────────────────────────────────────────────────────────────────────────────


def test_workspace_b_connecting_a_s_ig_account_never_reaches_a_s_row_or_vault_secret(conn, sc):
    with as_superuser(conn, commit=False) as s:
        ext = s.value("select external_id from public.social_accounts where id = %s", [sc.alice.social_account])
        a_secret = s.value("select access_secret_id from public.social_account_secrets where account_id = %s",
                           [sc.alice.social_account])
        a_plain = s.value("select decrypted_secret from vault.decrypted_secrets where id = %s", [a_secret])
    with acting(conn, sc.bob.actor) as s:
        mine = _store(s, sc.bob.org, meta=_ig(external_id=ext, client_business_id="777"))
        assert mine.ok, mine
        # Through RLS, Bob sees his row and not Alice's, whatever column he names.
        seen = s.rows("select id, org_id, auth_flow, config_id, client_business_id from public.social_accounts "
                      "where external_id = %s", [ext])
        secrets = s.run("select * from public.social_account_secrets")
        vault_read = s.run("select * from vault.decrypted_secrets")
        b_id = mine.rows[0][0]["id"]
        s.rows("reset role")
        b_secret = s.value("select access_secret_id from public.social_account_secrets where account_id = %s", [b_id])
        a_after = s.rows("select x.access_secret_id, v.decrypted_secret, a.auth_flow, a.client_business_id "
                         "from public.social_accounts a join public.social_account_secrets x on x.account_id = a.id "
                         "join vault.decrypted_secrets v on v.id = x.access_secret_id where a.id = %s",
                         [sc.alice.social_account])[0]
    assert [str(r[1]) for r in seen] == [sc.bob.org]
    assert not secrets.ok and secrets.sqlstate == "42501", secrets
    assert not vault_read.ok and vault_read.sqlstate == "42501", vault_read
    assert b_secret != a_secret
    assert a_after == (a_secret, a_plain, None, None)


def test_an_editor_of_b_cannot_connect_into_a_even_naming_a_s_existing_account(conn, sc):
    with as_superuser(conn, commit=False) as s:
        ext = s.value("select external_id from public.social_accounts where id = %s", [sc.alice.social_account])
    with acting(conn, sc.bob.actor) as s:
        out = _store(s, sc.alice.org, meta=_ig(external_id=ext))
    assert not out.ok and out.sqlstate == "42501", out


def test_the_token_lives_only_in_vault_never_in_a_row_a_label_or_an_error(conn, sc):
    with acting(conn, sc.bob.actor) as s:
        out = _store(s, sc.bob.org, meta=_ig(external_id="17841400000009077"))
        assert out.ok, out
        assert TOKEN not in json.dumps(out.rows[0][0])
        acc = out.rows[0][0]["id"]
        s.rows("reset role")
        row = s.value("select to_jsonb(a)::text from public.social_accounts a where id = %s", [acc])
        sec = s.value("select to_jsonb(x)::text from public.social_account_secrets x where account_id = %s", [acc])
        meta = s.value("select coalesce(v.name, '') || ' ' || coalesce(v.description, '') from public.social_account_secrets x "
                       "join vault.secrets v on v.id = x.access_secret_id where x.account_id = %s", [acc])
        audit = s.value("select count(*) from public.app_audit_log where detail::text like %s", [f"%{TOKEN}%"])
        events = s.value("select count(*) from public.events where coalesce(metadata::text, '') like %s", [f"%{TOKEN}%"]) \
            if s.value("select to_regclass('public.events') is not null") else 0
    for text in (row, sec, meta):
        assert TOKEN not in text
    assert (audit, events) == (0, 0)


def test_the_database_cannot_tell_an_old_token_and_does_not_enforce_the_allowlist(conn, sc):
    """ACCEPTED, not a hole (reported Low): store_social_account is a browser-callable RPC (0028), so an editor can store
    any well-formed token with auth_flow='unified_login' and any config_id, from a workspace that is not on
    INSTAGRAM_UNIFIED_ORGS. The allowlist and the token kind are app-side only. The row is the caller's own workspace's,
    the token is the caller's, and a token graph.facebook.com refuses dies at the first publish as error 190 (expired,
    once, below). Pinned so a change to that bound is noticed."""
    with acting(conn, sc.bob.actor) as s:
        out = _store(s, sc.bob.org, meta=_ig(external_id="17841400000009088", config_id="1"),
                     token="IGQWR" + "o" * 60)   # the shape of an old Instagram Login token
        assert out.ok, out
        org = s.value("select org_id from public.social_accounts where id = %s", [out.rows[0][0]["id"]])
    assert str(org) == sc.bob.org


def test_error_190_cannot_loop_an_expired_account_takes_no_new_publish_request(conn, sc):
    with as_superuser(conn, commit=False) as s:
        s.rows("update public.social_accounts set status = 'expired' where id = %s returning 1", [sc.bob.social_account])
        vid = s.value("select video_id from public.publish_requests where id = %s", [sc.bob.publish_request])
        s.rows("select set_config('request.jwt.claims', %s, true)", [json.dumps(sc.bob.actor.claims())])
        s.rows("set local role authenticated")
        out = s.rows("insert into public.publish_requests (video_id, account_id) values (%s, %s) returning status, reason",
                     [vid, sc.bob.social_account])
    assert out == [("refused", "account_not_connected")]


# ── the worker ─────────────────────────────────────────────────────────────────────────────────────────────────────


class _RefusingPartialStore(FakeStore):
    """A database that refuses the partial-success word (a reason check, a stale constraint)."""

    def update(self, rid, worker_id, values):
        self.updates.append(values)
        if values.get("reason") == sp.REASON_PARTIAL:
            return False
        return None


class BreachWorkerTests(Base):
    G = sp.IG_GRAPH

    def http(self, limit=None, publish=None):
        g = self.G
        return FakeHTTP({
            ("GET", f"{g}/17841400000/content_publishing_limit"): [limit or Resp(200, LIMIT_OK)],
            ("POST", f"{g}/17841400000/media_publish"): [publish or Resp(200, {"id": "MEDIA1"})],
            ("POST", f"{g}/17841400000/media"): [Resp(200, {"id": "CONT1"})],
            ("GET", f"{g}/CONT1"): [Resp(200, {"status_code": "FINISHED"})],
            ("GET", f"{g}/MEDIA1"): [Resp(200, {"permalink": "https://www.instagram.com/reel/abc/"})],
        })

    def test_an_old_flow_row_never_reaches_meta_with_its_token(self):
        for flow in (None, "", "UNIFIED_LOGIN", "unified_login ", "instagram_login"):
            with self.subTest(flow=flow):
                http = self.http()
                store = FakeStore(video=self.video, http=http, flow=flow)
                self.assertEqual(self.run_req(store, FakeTokens("instagram"), http=http), "refused")
                self.assertEqual(store.final["reason"], "instagram_reconnect")
                self.assertEqual((http.calls, store.staged), ([], []))

    def test_a_limit_read_never_fails_open(self):
        answers = (
            Resp(200, {"data": [{"quota_usage": 3, "config": {"quota_total": 0}}]}),
            Resp(200, {"data": [{"quota_usage": -1, "config": {"quota_total": 50}}]}),
            Resp(200, {"data": [{"quota_usage": "3", "config": {"quota_total": 50}}]}),
            Resp(200, {"data": [{"quota_usage": 3.0, "config": {"quota_total": 50}}]}),
            Resp(200, {"data": [{"quota_usage": 3, "config": {"quota_total": "50"}}]}),
            Resp(200, {"data": [{"quota_usage": 3, "config": [50]}]}),
            Resp(200, {"data": {"quota_usage": 3, "config": {"quota_total": 50}}}),
            Resp(200, {"error": {"code": 1, "message": "x"}}),
            Resp(200, []),
            Resp(302, {}),
            Resp(404, {"error": {"code": 100}}),
        )
        for answer in answers:
            with self.subTest(answer=answer._body, status=answer.status_code):
                http = self.http(limit=answer)
                store = FakeStore(video=self.video, http=http)
                self.assertEqual(self.run_req(store, FakeTokens("instagram"), http=http), "failed")
                self.assertIn(store.final["reason"], ("limit_unreadable",))
                self.assertEqual((store.staged, [c for c in http.calls if c[0] == "POST"]), ([], []))

    def test_a_limit_read_that_raises_stops_with_the_type_only_and_no_token(self):
        class Boom(FakeHTTP):
            def get(self, url, **kw):
                if url.endswith("/content_publishing_limit"):
                    raise ConnectionError(f"{url}?access_token={kw['params']['access_token']}")
                return super().get(url, **kw)
        http = Boom({})
        store = FakeStore(video=self.video, http=http)
        self.assertEqual(self.run_req(store, FakeTokens("instagram"), http=http), "failed")
        self.assertEqual(store.staged, [])
        self.assertNotIn(WORKER_TOKEN, json.dumps(store.updates))

    def test_error_190_marks_the_account_once_and_nothing_is_retried(self):
        for where in ("limit", "publish"):
            with self.subTest(where=where):
                dead = Resp(400, {"error": {"code": 190, "error_subcode": 460, "message": f"bad token {WORKER_TOKEN}"}})
                http = self.http(limit=dead if where == "limit" else None, publish=dead if where == "publish" else None)
                store = FakeStore(video=self.video, http=http)
                tokens = FakeTokens("instagram")
                self.assertEqual(self.run_req(store, tokens, http=http), "failed")
                self.assertEqual(store.final["reason"], "token_expired")
                self.assertEqual(tokens.statuses, [("acc1", "expired")])
                self.assertEqual(sum(1 for c in http.calls if c[1].endswith("/media_publish")), 1 if where == "publish" else 0)
                self.assertNotIn(WORKER_TOKEN, json.dumps(store.updates))

    def test_config_issue_in_any_present_shape_is_never_a_clean_success(self):
        for issue in ("CAPTION_NOT_ATTACHED", ["USER_TAGGING_FAILURE"], {"a": "CAPTION_NOT_ATTACHED"}, False, 0,
                      "caption_not_attached", f"x {WORKER_TOKEN}"):
            with self.subTest(issue=issue):
                http = self.http(publish=Resp(200, {"id": "MEDIA1", "config_issue": issue}))
                store = FakeStore(video=self.video, http=http)
                self.assertEqual(self.run_req(store, FakeTokens("instagram"), http=http), "published")
                self.assertEqual(store.final["reason"], "published_partially")
                self.assertNotIn(WORKER_TOKEN, json.dumps(store.updates))

    def test_a_refused_partial_write_does_not_fall_back_to_a_clean_published(self):
        http = self.http(publish=Resp(200, {"id": "MEDIA1", "config_issue": "CAPTION_NOT_ATTACHED"}))
        store = _RefusingPartialStore(video=self.video, http=http)
        self.run_req(store, FakeTokens("instagram"), http=http)
        clean = [u for u in store.updates if u.get("status") == "published" and not u.get("reason")]
        self.assertEqual(clean, [])

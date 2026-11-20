"""An HD download requested through the public API (api_request_download), in a real database.

Found in the security lab: the function audited its own work as `video.download`, a name 0087's audit list
(audit_action_allowed) never had, and app_audit_log_stamp refuses an unknown action for the anon role every API call
runs as. The function's own `exception when others` turned that into `500 internal_error` and undid the block, so every
new paid, redownload or exempt download through the API failed and charged nothing; only the "reused" answer (which
writes no audit row) worked. Migration 0170 makes the function audit the name the Command Center's own download route
writes for the same act, `video.download_request` (command-center/app/api/downloads/route.ts), and leaves the audit
list exactly as it was.

Each test calls the real function as PostgREST would (role anon, the key's hash as the argument) inside one
transaction that is rolled back, and reads the ground truth (the request row, the hold, the ledger, the audit row)
as the database owner inside that same transaction.
"""

from __future__ import annotations

import hashlib
import json
from contextlib import contextmanager

import psycopg

import sec_db
from sec_db import ANON, MIGRATIONS, REPO

from sec_scenario import DEFAULT_ORG

MIGRATION = MIGRATIONS / "0170_api_download_audit.sql"
ROLLBACK = REPO / "docs" / "sql" / "rollback_0170_api_download_audit.sql"
SIGNATURE = "public.api_request_download(text, text, text, text, text, text)"
BODY_0147 = "055003f8a2fb5390bbd1b5f7820e6e2e"
BODY_0170 = "b59ca71d0e0379e217e47a6987c9ed0c"


@contextmanager
def _txn(conn):
    with conn.transaction(force_rollback=True):
        yield conn


def _owner(conn) -> None:
    conn.execute("reset role")
    conn.execute("select set_config('request.jwt.claims', '', true)")
    conn.execute("select set_config('request.jwt.claim.role', '', true)")


def _download(conn, key_hash: str, video: str, quality: str) -> dict:
    """One call the way /api/v1/downloads makes it: the anon role, the key's hash, no idempotency key."""
    conn.execute("select set_config('request.jwt.claims', %s, true)", [json.dumps(ANON.claims())])
    conn.execute("select set_config('request.jwt.claim.role', 'anon', true)")
    conn.execute("set local role anon")
    try:
        return conn.execute("select public.api_request_download(%s, %s, %s, null, null, null)",
                            [key_hash, video, quality]).fetchone()[0]
    finally:
        _owner(conn)


def _one(conn, q, p=None):
    return conn.execute(q, p).fetchone()


def _account(conn, org):
    return _one(conn, "select balance_cents, reserved_cents from public.api_accounts where org_id = %s", [org])


def _audit_rows(conn, video):
    return conn.execute("select action, target, channel_id, actor_user_id::text, detail from public.app_audit_log "
                        "where target = %s and detail ->> 'via' = 'api' order by id", [video]).fetchall()


def _price(conn, video, quality):
    return int(_one(conn, "select ceil(public.download_credits_price(m.duration_seconds, %s) * p.cents)::bigint "
                          "from public.download_masters m, public.api_prices p "
                          "where m.video_id = %s and p.unit = 'download_cents_per_credit'", [quality, video])[0])


def test_a_paid_api_download_is_accepted_holds_its_price_and_writes_its_audit_row(conn, sc):
    a = sc.alice
    with _txn(conn):
        _owner(conn)
        price = _price(conn, a.video, "720p")
        assert price > 0
        bal0, res0 = _account(conn, a.org)
        ledger0 = _one(conn, "select count(*) from public.api_ledger where org_id = %s", [a.org])[0]

        res = _download(conn, a.api_key_hash, a.video, "720p")

        assert res["ok"] is True and res["status"] == 201, res
        data = res["data"]
        assert (data["price_cents"], data["free_reason"], data["reused"], data["quality"]) == (price, None, False, "720p"), data
        row = _one(conn, "select org_id::text, channel_id, status, charged, free_reason, paid_until > now() + interval '6 days', "
                         "requested_by::text from public.download_requests where id = %s", [data["id"]])
        assert row == (a.org, a.channel, "queued", 0, None, True, a.actor.uid), row
        # The hold is the price, on the API balance, tied to this request; nothing is captured yet.
        hold = _one(conn, "select ref, amount_cents, key_id::text, status from public.api_holds where download_request_id = %s", [data["id"]])
        assert hold is not None and hold[1:] == (price, a.api_key_id, "open"), hold
        assert _account(conn, a.org) == (bal0, res0 + price)
        led = conn.execute("select kind, amount_cents, hold_ref, key_id::text, balance_after, reserved_after from public.api_ledger "
                           "where org_id = %s order by id desc limit 1", [a.org]).fetchone()
        assert led == ("hold", price, hold[0], a.api_key_id, bal0, res0 + price), led
        assert _one(conn, "select count(*) from public.api_ledger where org_id = %s", [a.org])[0] == ledger0 + 1
        # The request is logged once, with its cost, as the month's spend reads it.
        assert _one(conn, "select status, cost_cents from public.api_requests where key_id = %s and endpoint = 'downloads.create' "
                          "order by id desc limit 1", [a.api_key_id]) == (201, price)
        # Exactly one audit row, under the name the site's download route writes, filed as the key's creator.
        rows = _audit_rows(conn, a.video)
        assert len(rows) == 1, rows
        action, target, channel, actor, detail = rows[0]
        assert (action, target, channel, actor) == ("video.download_request", a.video, a.channel, a.actor.uid)
        assert detail == {"download_id": data["id"], "quality": "720p", "price_cents": price, "free_reason": None,
                          "via": "api", "api_key_id": a.api_key_id}, detail


def test_the_same_request_again_is_reused_and_neither_holds_nor_audits_twice(conn, sc):
    a = sc.alice
    with _txn(conn):
        _owner(conn)
        first = _download(conn, a.api_key_hash, a.video, "720p")
        assert first["status"] == 201, first
        after_first = (_account(conn, a.org), _one(conn, "select count(*) from public.api_holds where org_id = %s", [a.org])[0])
        again = _download(conn, a.api_key_hash, a.video, "720p")
        assert again["status"] == 200 and again["data"]["reused"] is True and again["data"]["id"] == first["data"]["id"], again
        assert again["data"]["price_cents"] == 0
        assert (_account(conn, a.org), _one(conn, "select count(*) from public.api_holds where org_id = %s", [a.org])[0]) == after_first
        assert len(_audit_rows(conn, a.video)) == 1


def test_a_redownload_inside_the_paid_window_is_free_and_audited(conn, sc):
    a = sc.alice
    with _txn(conn):
        _owner(conn)
        # A request paid for two days ago whose file has since expired: the seven days it bought are still running.
        conn.execute("insert into public.download_requests (org_id, channel_id, video_id, quality, status, charged, paid_until, "
                     "expires_at, requested_by) values (%s, %s, %s, '720p', 'expired', 0, now() + interval '5 days', "
                     "now() - interval '1 hour', %s)", [a.org, a.channel, a.video, a.actor.uid])
        acc0 = _account(conn, a.org)
        holds0 = _one(conn, "select count(*) from public.api_holds where org_id = %s", [a.org])[0]
        ledger0 = _one(conn, "select count(*) from public.api_ledger where org_id = %s", [a.org])[0]

        res = _download(conn, a.api_key_hash, a.video, "720p")

        assert res["ok"] is True and res["status"] == 201, res
        assert (res["data"]["price_cents"], res["data"]["free_reason"], res["data"]["reused"]) == (0, "redownload", False), res
        assert _account(conn, a.org) == acc0
        assert _one(conn, "select count(*) from public.api_holds where org_id = %s", [a.org])[0] == holds0
        assert _one(conn, "select count(*) from public.api_ledger where org_id = %s", [a.org])[0] == ledger0
        assert _one(conn, "select free_reason, paid_until > now() + interval '4 days' from public.download_requests where id = %s",
                    [res["data"]["id"]]) == ("redownload", True)
        assert _one(conn, "select cost_cents from public.api_requests where key_id = %s and endpoint = 'downloads.create' "
                          "order by id desc limit 1", [a.api_key_id])[0] == 0
        rows = _audit_rows(conn, a.video)
        assert [(r[0], r[4]["free_reason"], r[4]["price_cents"]) for r in rows] == [("video.download_request", "redownload", None)], rows


def test_the_exempt_organization_downloads_free_and_audited(conn, sc):
    op, vid = sc.operator, sc.operator_video
    key = hashlib.sha256(b"api-download-exempt").hexdigest()
    with _txn(conn):
        _owner(conn)
        assert _one(conn, "select public.credits_exempt(%s)", [DEFAULT_ORG])[0] is True
        conn.execute("insert into public.api_settings (org_id, activated_at, activated_by, terms_version) values (%s, now(), %s, 'v1') "
                     "on conflict (org_id) do update set activated_at = now()", [DEFAULT_ORG, op.uid])
        key_id = str(_one(conn, "insert into public.api_keys (org_id, name, key_hash, created_by) "
                                "values (%s, 'exempt', %s, %s) returning id", [DEFAULT_ORG, key, op.uid])[0])
        conn.execute("insert into public.download_masters (video_id, org_id, width, height, duration_seconds, bytes) "
                     "values (%s, %s, 1920, 1080, 90, 1000)", [vid, DEFAULT_ORG])
        holds0 = _one(conn, "select count(*) from public.api_holds where org_id = %s", [DEFAULT_ORG])[0]

        res = _download(conn, key, vid, "1080p")

        assert res["ok"] is True and res["status"] == 201, res
        assert (res["data"]["price_cents"], res["data"]["free_reason"]) == (0, "exempt"), res
        assert _one(conn, "select count(*) from public.api_holds where org_id = %s", [DEFAULT_ORG])[0] == holds0
        rows = _audit_rows(conn, vid)
        assert len(rows) == 1, rows
        assert rows[0][0] == "video.download_request" and rows[0][3] == op.uid
        assert rows[0][4]["free_reason"] == "exempt" and rows[0][4]["api_key_id"] == key_id


def test_another_organizations_key_still_gets_404_and_leaves_nothing(conn, sc):
    a, b = sc.alice, sc.bob
    with _txn(conn):
        _owner(conn)
        before = (_account(conn, b.org), _one(conn, "select count(*) from public.download_requests")[0])
        res = _download(conn, b.api_key_hash, a.video, "720p")
        assert res["status"] == 404 and res["error"]["code"] == "video_not_found", res
        assert (_account(conn, b.org), _one(conn, "select count(*) from public.download_requests")[0]) == before
        assert _audit_rows(conn, a.video) == []


def test_the_audit_list_is_not_widened(conn, sc):
    """The fix renamed the function's action; it did not add one. The old name, and a made-up one, are still refused for
    a browser's insert and from inside a definer function, and the name the API now writes is accepted on both paths."""
    with _txn(conn):
        _owner(conn)
        allowed = dict(conn.execute("select a, public.audit_action_allowed(a) from unnest(array["
                                    "'video.download', 'video.download_request', 'video.downloads', 'nope.never']) a").fetchall())
        assert allowed == {"video.download": False, "video.download_request": True, "video.downloads": False, "nope.never": False}
    # The browser's own insert (lib/server/audit.ts), as a signed-in member.
    who = sc.alice.actor
    for action, ok in (("video.download", False), ("nope.never", False), ("video.download_request", True)):
        with _txn(conn):
            conn.execute("select set_config('request.jwt.claims', %s, true)", [json.dumps(who.claims())])
            conn.execute("set local role authenticated")
            try:
                with conn.transaction():
                    conn.execute("insert into public.app_audit_log (actor_user_id, action, target, detail, channel_id) "
                                 "values (%s, %s, %s, '{}'::jsonb, %s)", [who.uid, action, sc.alice.video, sc.alice.channel])
                got = None
            except psycopg.Error as e:
                got = e.sqlstate
            _owner(conn)
        assert got == (None if ok else "22023"), (action, got)
    # A definer function running for the anon role (api_audit, as every api_* calls it) is held to the same list.
    a = sc.alice
    for action, ok in (("video.download", False), ("video.download_request", True)):
        with _txn(conn):
            conn.execute("select set_config('request.jwt.claims', %s, true)", [json.dumps(ANON.claims())])
            conn.execute("set local role anon")
            ctx = json.dumps({"created_by": a.actor.uid, "key_id": a.api_key_id})
            try:
                with conn.transaction():
                    # anon may not call api_audit itself; a superuser-owned definer wrapper is what api_request_download is.
                    conn.execute("reset role")
                    conn.execute("create function pg_temp.audit_as_api(c jsonb, act text) returns void language sql security definer "
                                 "set search_path = public, pg_temp as $f$ select public.api_audit(c, act, 'vid-x', null, '{}'::jsonb) $f$")
                    conn.execute("set local role anon")
                    conn.execute("select pg_temp.audit_as_api(%s::jsonb, %s)", [ctx, action])
                got = None
            except psycopg.Error as e:
                got = e.sqlstate
            _owner(conn)
        assert got == (None if ok else "22023"), (action, got)


# ── the migration: its body, its replay, its rollback, its drift guard ──────────────────────────────────────────────

def _body_md5(conn):
    return _one(conn, "select md5(regexp_replace(prosrc, '\\s+', ' ', 'g')) from pg_proc where oid = to_regprocedure(%s)",
                [SIGNATURE])[0]


def _sql(path):
    return "\n".join(ln for ln in path.read_text(encoding="utf-8").splitlines() if ln.strip() not in ("begin;", "commit;"))


def test_the_live_body_is_0170s_and_its_grants_are_0147s(conn, sc):
    with _txn(conn):
        _owner(conn)
        # 0192 (the adult gate) sits on 0170's body, which 0170's replay and rollback refuse to touch: off inside this transaction.
        sec_db.take_off_0192(conn)
        assert _body_md5(conn) == BODY_0170
        grants = {r: _one(conn, "select has_function_privilege(%s, %s, 'execute')", [r, SIGNATURE])[0]
                  for r in ("anon", "authenticated", "service_role")}
        assert grants == {"anon": True, "authenticated": False, "service_role": False}, grants
        assert _one(conn, "select prosecdef and proconfig = array['search_path=public, pg_temp'] from pg_proc "
                          "where oid = to_regprocedure(%s)", [SIGNATURE])[0] is True


def test_the_files_verify_query_reads_true_in_every_column(conn, sc):
    text = MIGRATION.read_text(encoding="utf-8")
    block = text.split("-- Verify (run after applying", 1)[1].split("\n-- select\n", 1)[1]
    query = "select\n" + "\n".join(ln[3:] for ln in block.splitlines() if ln.startswith("--   ") or ln.startswith("-- from"))
    with _txn(conn):
        _owner(conn)
        # 0192 (the adult gate) sits on 0170's body, which 0170's replay and rollback refuse to touch: off inside this transaction.
        sec_db.take_off_0192(conn)
        cur = conn.execute(query)
        row = dict(zip([d.name for d in cur.description], cur.fetchone()))
    assert len(row) == 4 and all(v is True for v in row.values()), row


def test_replaying_0170_changes_nothing_and_the_download_still_works(conn, sc):
    a = sc.alice
    with _txn(conn):
        _owner(conn)
        # 0192 (the adult gate) sits on 0170's body, which 0170's replay and rollback refuse to touch: off inside this transaction.
        sec_db.take_off_0192(conn)
        conn.execute(_sql(MIGRATION))
        conn.execute(_sql(MIGRATION))
        assert _body_md5(conn) == BODY_0170
        res = _download(conn, a.api_key_hash, a.video, "720p")
        assert res["status"] == 201, res


def test_the_rollback_puts_0147s_body_back_and_0170_applies_again(conn, sc):
    a = sc.alice
    with _txn(conn):
        _owner(conn)
        # 0192 (the adult gate) sits on 0170's body, which 0170's replay and rollback refuse to touch: off inside this transaction.
        sec_db.take_off_0192(conn)
        conn.execute(_sql(ROLLBACK))
        assert _body_md5(conn) == BODY_0147
        # 0147's body is the bug: the download fails closed again, and charges nothing.
        acc0 = _account(conn, a.org)
        broken = _download(conn, a.api_key_hash, a.video, "720p")
        assert broken["status"] == 500 and broken["error"]["code"] == "internal_error", broken
        assert _account(conn, a.org) == acc0
        assert _one(conn, "select has_function_privilege('anon', %s, 'execute')", [SIGNATURE])[0] is True
        conn.execute(_sql(MIGRATION))
        assert _body_md5(conn) == BODY_0170
        assert _download(conn, a.api_key_hash, a.video, "720p")["status"] == 201


def test_the_drift_guard_and_the_rollback_refuse_a_body_they_were_not_written_on(conn, sc):
    with _txn(conn):
        _owner(conn)
        conn.execute("create or replace function public.api_request_download(p_key_hash text, p_video_id text, p_quality text, "
                     "p_idem_key text default null, p_fingerprint text default null, p_request_id text default null) returns jsonb "
                     "language plpgsql volatile security definer set search_path = public, pg_temp as $f$ begin return '{}'::jsonb; end $f$")
        for path, words in ((MIGRATION, "neither the one it was written on nor 0170"), (ROLLBACK, "is not 0170's body")):
            try:
                with conn.transaction():
                    conn.execute(_sql(path))
                raise AssertionError(f"{path.name} applied over a body it was not written on")
            except psycopg.Error as e:
                assert words in str(e), (path.name, str(e))

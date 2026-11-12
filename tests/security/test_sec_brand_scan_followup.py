"""Migration 0134 (the brand scan's follow-up): a failed scan keeps a picture that a brand kit or a product already uses.

0133's brand_scan_fail_locked() deleted every picture the worker had stored for a scan that failed, including one a member had put into a
kit (its logo) or a product (its pictures) while the scan was running. 0134 keeps those, and these tests prove it:

  * on every path that fails a scan (the worker's failure, the claim's sweep, the request's sweep), a picture a kit or a product
    references stays, and every other picture of the scan is deleted as before;
  * the filters are exact: the scan's own organization, source `pipeline`, origin `brand_scan`, the scan's id;
  * a kit write that is still open when the scan fails is waited for (real concurrent transactions), so its picture stays too;
  * the file: its catalogue guard (every column of 0131's tables that references a picture), its body guard, a replay, the rollback
    (0133's body back, byte for byte; 0133's own rollback then works), and that it touches no other object.

Everything runs inside transactions that are rolled back, except the race (committed rows it purges) and the test that needs a database of
its own. Nothing calls a provider and nothing is fetched.
"""

from __future__ import annotations

import json
import threading
import time
import uuid

import psycopg
import pytest

import sec_db
from sec_db import SERVICE, as_superuser
from test_sec_brand_scan import (U, WORKER, Org, RaceWorld, become, claim, domain, fingerprint, ready_scan, result, scan,  # noqa: F401
                                 w)
from test_sec_series_tables import _dsn

MIGRATION = sec_db.MIGRATION_0134
ROLLBACK = sec_db.ROLLBACK_0134
FN = "public.brand_scan_fail_locked(uuid,text)"
MD5_0133 = "67e8ee83bde9ec4512a3d6135c9c07ee"
MD5_0134 = "fd10914ccff5aa66264ab96265e59c38"


def body(path) -> str:
    return "\n".join(ln for ln in path.read_text(encoding="utf-8").splitlines() if ln.strip() not in ("begin;", "commit;"))


def live_md5(s) -> str:
    become(s, None)
    return s.value("select md5(regexp_replace(prosrc, '\\s+', ' ', 'g')) from pg_proc where oid = %s::regprocedure", [FN])


def picture(s, org, scan_id, *, source="pipeline", origin="brand_scan"):
    """A picture with the scan in its provenance, as the worker stores one (register_asset, service key)."""
    become(s, SERVICE)
    return str(s.value("select public.register_asset(gen_random_uuid(), %s, 'image', 'image/png', 1000, %s, %s, p_width => 64, "
                       "p_height => 64, p_provenance => %s::jsonb) ->> 'id'",
                       [org.id, uuid.uuid4().hex * 2, source, json.dumps({"origin": origin, "scan_id": str(scan_id), "role": "logo"})]))


def deleted(s, ids):
    become(s, None)
    return dict(s.rows("select id::text, deleted_at is not null from public.media_assets where id = any(%s::uuid[])", [list(ids)]))


def kit_with_logo(s, org, logo):
    become(s, org.ed)
    return s.value("select public.save_brand_kit(%s, null, 'Mine', null, %s, array['#000000'], array['Arial'], 'Calm.')", [org.id, logo])


def product_with(s, org, kit, pic):
    become(s, org.ed)
    return s.value("select public.save_brand_product(%s, null, 'Mug', '', '', array[%s]::uuid[])", [kit, pic])


def fail(s, sid, code="robots"):
    become(s, SERVICE)
    return s.value("select public.fail_brand_scan(%s, %s, %s)", [sid, WORKER, code])


def test_the_database_holds_0134s_body(conn, w):
    assert live_md5(w.su) == MD5_0134


def test_a_failed_scan_keeps_the_pictures_a_kit_or_a_product_uses_and_deletes_the_rest(conn, w):
    s = w.su
    sid = scan(s, w.org, U).rows[0][0]["id"]
    assert claim(s)["scan_id"] == sid
    logo, mug, spare = picture(s, w.org, sid), picture(s, w.org, sid), picture(s, w.org, sid)
    kit = kit_with_logo(s, w.org, logo)
    product_with(s, w.org, kit, mug)
    assert fail(s, sid)["status"] == "failed"
    assert deleted(s, [logo, mug, spare]) == {logo: False, mug: False, spare: True}
    assert w.org.account() == (100, 0), "the hold is released all the same"
    become(s, None)
    assert str(s.value("select logo_asset_id from public.brand_kits where id = %s", [kit])) == logo
    assert s.value("select count(*) from public.brand_product_images where asset_id = %s", [mug]) == 1


def test_each_filter_holds_its_own_line(conn, w):
    """Only the scan's own pictures go: its organization, source pipeline, origin brand_scan, its id. Each other picture names the scan
    in its provenance but misses exactly one of them."""
    s = w.su
    other = Org(s)
    sid = scan(s, w.org, U).rows[0][0]["id"]
    claim(s)
    mine = picture(s, w.org, sid)
    rendered = picture(s, w.org, sid, source="render")              # another kind of library picture whose provenance names the scan
    generated = picture(s, w.org, sid, source="generated")
    elsewhere = picture(s, other, sid)                              # another organization's picture naming this scan
    not_ours = picture(s, w.org, sid, origin="editor")
    another_scan = picture(s, w.org, uuid.uuid4())
    fail(s, sid)
    assert deleted(s, [mine, rendered, generated, elsewhere, not_ours, another_scan]) == {
        mine: True, rendered: False, generated: False, elsewhere: False, not_ours: False, another_scan: False}


def test_the_sweeps_keep_a_used_picture_too(conn, w):
    s = w.su
    # The claim's sweep: a scan nobody took within 2 hours.
    a = scan(s, w.org, U).rows[0][0]["id"]
    used_a, spare_a = picture(s, w.org, a), picture(s, w.org, a)
    kit = kit_with_logo(s, w.org, used_a)
    become(s, None)
    s.rows("update public.brand_scans set created_at = now() - interval '3 hours' where id = %s returning 1", [a])
    assert claim(s) is None
    # The request's sweep: a worker that went quiet.
    b = scan(s, w.org, U).rows[0][0]["id"]
    used_b, spare_b = picture(s, w.org, b), picture(s, w.org, b)
    product_with(s, w.org, kit, used_b)
    become(s, None)
    s.rows("update public.brand_scans set status = 'running', worker_id = 'gone', claimed_at = now() - interval '20 minutes' where id = %s "
           "returning 1", [b])
    assert scan(s, w.org, U).ok
    become(s, None)
    assert s.rows("select error_code from public.brand_scans where id = any(%s::uuid[]) order by created_at", [[a, b]]) == [("expired",), ("expired",)]
    assert deleted(s, [used_a, spare_a, used_b, spare_b]) == {used_a: False, spare_a: True, used_b: False, spare_b: True}


def test_a_ready_scan_and_a_second_failure_change_nothing(conn, w):
    s = w.su
    sid = ready_scan(s, w.org)
    pic = picture(s, w.org, sid)
    assert fail(s, sid)["replayed"] is True
    assert deleted(s, [pic]) == {pic: False}


# ═══ the race: a kit write still open when the scan fails ═════════════════════════════════════════════════════════════════

def _as(c, who):
    c.execute("select set_config('request.jwt.claims', %s, true)", [json.dumps(who.claims())])
    c.execute("select set_config('request.jwt.claim.role', %s, true)", [who.role])
    c.execute(psycopg.sql.SQL("set local role {}").format(psycopg.sql.Identifier(who.role)))


def test_a_kit_write_still_open_when_the_scan_fails_is_waited_for_and_its_picture_stays(conn, sc):
    race = RaceWorld(conn)
    o, _ = race.orgs[0]
    try:
        with as_superuser(conn) as su:
            sid = scan(su, o, "https://race0.scan.test/").rows[0][0]["id"]
            assert claim(su)["scan_id"] == sid
            pic, spare = picture(su, o, sid), picture(su, o, sid)
        dsn = _dsn(conn)
        kit_tx = psycopg.connect(dsn)
        try:
            _as(kit_tx, o.ed)
            kit = kit_tx.execute("select public.save_brand_kit(%s, null, 'Race kit', null, %s, array['#000000'], array['Arial'], 'Calm.')",
                                 [o.id, pic]).fetchone()[0]
            done, out = threading.Event(), {}

            def failing():
                try:
                    with psycopg.connect(dsn) as c:
                        _as(c, SERVICE)
                        out["pid"] = c.execute("select pg_backend_pid()").fetchone()[0]
                        out["row"] = c.execute("select public.fail_brand_scan(%s, %s, 'robots')", [sid, WORKER]).fetchone()[0]
                        c.commit()
                except psycopg.Error as e:
                    out["error"] = str(e)
                done.set()

            t = threading.Thread(target=failing)
            t.start()
            waited = False
            for _ in range(100):
                if done.is_set():
                    break
                with psycopg.connect(sec_db.admin_dsn(), autocommit=True) as watch:
                    if out.get("pid") and watch.execute("select wait_event_type = 'Lock' from pg_stat_activity where pid = %s",
                                                        [out["pid"]]).fetchone() == (True,):
                        waited = True
                        break
                time.sleep(0.05)
            assert waited and not done.is_set(), ("the failure must wait for the open kit write", out)
            kit_tx.commit()
            t.join(timeout=30)
            assert done.is_set() and out.get("row", {}).get("status") == "failed", out
        finally:
            kit_tx.close()
        with as_superuser(conn, commit=False) as su:
            assert deleted(su, [pic, spare]) == {pic: False, spare: True}
            assert str(su.value("select logo_asset_id from public.brand_kits where id = %s", [kit])) == pic
    finally:
        race.purge()


# ═══ the file ═════════════════════════════════════════════════════════════════════════════════════════════════════════════

def test_a_replay_changes_nothing(conn, w):
    s = w.su
    before = (fingerprint(s, True), fingerprint(s, False))
    s.conn.execute(MIGRATION.read_text(encoding="utf-8"))
    s.conn.execute(MIGRATION.read_text(encoding="utf-8"))
    assert (fingerprint(s, True), fingerprint(s, False)) == before


def test_the_file_and_the_rollback_refuse_a_body_somebody_changed_by_hand(conn, w):
    s = w.su
    become(s, None)
    definition = s.value("select pg_get_functiondef(%s::regprocedure)", [FN])
    s.conn.execute(definition.replace("begin", "begin /* changed by hand */", 1))
    changed = live_md5(s)
    out = s.run(MIGRATION.read_text(encoding="utf-8"))
    assert not out.ok and "neither 0133's body nor 0134's" in out.error, out
    out = s.run(body(ROLLBACK))
    assert not out.ok and "rollback 0134" in out.error and "neither 0134's body nor 0133's" in out.error, out
    assert live_md5(s) == changed


def test_the_file_refuses_a_new_picture_column_of_0131s_tables(conn, w):
    """A column of a brand kit or product table that references a picture must be checked by the function first."""
    s = w.su
    become(s, None)
    s.conn.execute("alter table public.brand_products add column hero_asset_id uuid references public.media_assets (id)")
    out = s.run(MIGRATION.read_text(encoding="utf-8"))
    assert not out.ok and "extend brand_scan_fail_locked first" in out.error and "brand_products.hero_asset_id" in out.error, out


def test_the_rollback_puts_0133s_body_back_then_0133s_rollback_runs_and_0134_applies_again(conn, w):
    s = w.su
    rollback = ROLLBACK.read_text(encoding="utf-8")
    assert rollback.count("\nbegin;\n") == 1 and rollback.count("\ncommit;\n") == 1
    others = fingerprint(s, False)
    become(s, None)
    s.conn.execute(body(ROLLBACK))
    assert live_md5(s) == MD5_0133
    for role in ("public", "anon", "authenticated", "service_role"):
        assert not s.value("select has_function_privilege(%s, %s, 'execute')", [role, FN]), role
    s.conn.execute(body(ROLLBACK))                                   # 0133's body is accepted: running it again changes nothing
    assert live_md5(s) == MD5_0133 and fingerprint(s, False) == others
    # With 0134 off, 0133's own rollback is no longer refused for the body.
    s.conn.execute("set local nightshift.brand_scan_rollback_delete_rows = 'yes'")
    s.conn.execute(body(sec_db.ROLLBACK_0133))
    assert s.value("select to_regprocedure(%s) is null", [FN])
    s.conn.execute(sec_db.MIGRATION_0133.read_text(encoding="utf-8"))
    s.conn.execute(MIGRATION.read_text(encoding="utf-8"))
    assert live_md5(s) == MD5_0134


def test_0134_touches_no_object_but_its_one_function(conn, sc):
    admin = sec_db.admin_dsn()
    name = f"ns_scan_followup_{uuid.uuid4().hex[:8]}"
    dsn = sec_db.create_database(admin, name)
    try:
        sec_db.apply_files(dsn, [f for f in sec_db.build_sequence() if not f.name.startswith("0134_")])
        with psycopg.connect(dsn, autocommit=True) as c:
            s = sec_db.Session(c)
            assert live_md5(s) == MD5_0133

            def everything():
                return s.rows("select p.oid::regprocedure::text, md5(p.prosrc), coalesce(p.proacl::text, ''), p.prosecdef, "
                              "coalesce(p.proconfig::text, '') from pg_proc p where p.pronamespace = 'public'::regnamespace order by 1")

            before, tables = everything(), (fingerprint(s, True), fingerprint(s, False))
            c.execute(MIGRATION.read_text(encoding="utf-8"))
            after = everything()
            changed = [a for a, b in zip(before, after) if a != b]
            assert len(before) == len(after) and [r[0] for r in changed] == ["brand_scan_fail_locked(uuid,text)"], changed
            assert changed[0][2:] == next(b for b in before if b[0] == changed[0][0])[2:], "grants, definer and search_path unchanged"
            assert {k: v for k, v in fingerprint(s, True).items() if k != "functions"} == {k: v for k, v in tables[0].items() if k != "functions"}
            assert fingerprint(s, False) == tables[1]
    finally:
        sec_db.drop_database(admin, name)

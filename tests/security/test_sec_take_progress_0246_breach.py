"""Breach's attacks on migration 0246 (film_take_progress, film_segment_assembly_progress and the five column grants), beyond what
test_sec_take_progress_0246_0248.py already pins. Against the money lab's own scratch database (its fixtures, reused).

Ledger (Breach, 2026-11-28, 79cb10593):

* B-0246-1 (LOW, confirmed, FAILING until fixed): a worker that lost its lease while its progress write waited on the take's row
  lock still writes. film_take_progress is one UPDATE ... FROM film_segments; the segment is a joined (not locked) relation, so
  after the row lock is released Postgres re-checks only the take's new version and keeps the segment row the statement first
  read (worker_id = the old worker). film_heartbeat_segment, a single-table UPDATE, re-checks worker_id on the new version and
  refuses. Reach: the service role only, and the value written is a percent / status word of the same vendor task: an honest
  reader sees a figure from the previous worker until the new one writes. Fix (not made here): lock the segment first
  (select ... for share / for update, the film -> segment -> take order of film_lock_take) or re-check worker_id inside the
  UPDATE's target. Test: test_a_worker_that_lost_the_lease_while_its_write_waited_writes_nothing.
* Everything else below passes and is pinned so it stays that way: Infinity / -Infinity / a tiny negative are NULL; a take of a
  segment another worker holds, a finished take, a settled segment's assembly, a finished assembly: false; forged
  request.jwt.claims under the authenticated / anon role; no API role but service_role may execute either writer; no API role may
  insert or update any of the five columns; anon reads none of them; 0246 and 0248 roll back and re-apply in either order, with
  progress already stored, and each works without the other.
"""

from __future__ import annotations

import json
import threading
import time
from decimal import Decimal

import psycopg
import pytest

from test_sec_films_money import a, b, db, err, no_live_segment  # noqa: F401 — the money lab's fixtures, reused as they are
from test_sec_take_progress_0246_0248 import progress_of, running_take, write

TAKE_PROGRESS = "public.film_take_progress(uuid, text, numeric, text)"
ASSEMBLY_PROGRESS = "public.film_segment_assembly_progress(uuid, text, numeric)"
API_ROLES = ("anon", "authenticated", "authenticator", "service_role", "public")
COLUMNS = (("film_takes", "progress"), ("film_takes", "vendor_state"), ("film_takes", "progress_at"),
           ("film_segments", "assembly_progress"), ("film_segments", "assembly_progress_at"))


def _roles(db):
    return [r for r in API_ROLES if r == "public" or db.su("select 1 from pg_roles where rolname = %s", [r])]


def test_infinity_and_a_tiny_negative_are_not_known_and_99_996_is_not_above_100(db, a):
    _f, _s, kf, _t = running_take(db, a)
    for pct in ("Infinity", "-Infinity", "-0.001", "1e400"):
        try:
            assert write(db, kf, "w-1", pct, "running") is True
        except psycopg.Error as e:  # 1e400 does not fit numeric's cast? then it is refused, also fine
            assert e.sqlstate in ("22003",), (pct, e.sqlstate)
            continue
        assert progress_of(db, kf)[0] is None, pct
    assert write(db, kf, "w-1", "99.996", "running") is True
    assert progress_of(db, kf)[0] == Decimal("100.00")  # rounding of a measured figure, never above 100 (CHECK holds)


def test_a_word_outside_ascii_or_with_a_newline_is_not_a_word(db, a):
    _f, _s, kf, _t = running_take(db, a)
    for word in ("runninɡ", "running\n", "running\nsk_live_abc", "ıdle", "r​unning", "ｒunning", "running "):
        assert write(db, kf, "w-1", 10, word) is True
        assert progress_of(db, kf)[1] is None, repr(word)


def test_a_take_of_a_segment_another_worker_holds_is_not_written_by_this_one(db, a, b):
    _fa, _sa, kfa, _ta = running_take(db, a)                       # w-1 holds a's segment
    fb = db.film(b)
    sb = db.quoted_start(b, fb)
    assert db.claim("w-2")["id"] == sb["id"]
    kfb = db.takes(sb["id"])[0][0]
    db.begin(kfb, "w-2")
    assert write(db, kfb, "w-1", 77, "running") is False          # w-1 holds *a* segment, not this one
    assert write(db, kfa, "w-2", 77, "running") is False
    assert progress_of(db, kfb)[0] is None and progress_of(db, kfa)[0] is None


def test_a_finished_take_and_a_finished_or_settled_assembly_are_not_written(db, a):
    film = db.film(a)
    s = db.quoted_start(a, film)
    assert db.claim()["id"] == s["id"]
    rows = db.takes(s["id"])
    kf, clip = rows[0][0], rows[1][0]
    db.make(a, kf, "keyframe")
    assert write(db, kf, "w-1", 5, "running") is False             # completed
    db.begin(clip)
    db.fail(clip, "provider_error")
    assert write(db, clip, "w-1", 5, "running") is False           # failed
    db.cancel(s["id"])
    assert db.svc("select public.film_segment_assembly_progress(%s, 'w-1', 5)", [s["id"]]) is False
    assert db.su("select progress from public.film_takes where id in (%s, %s)", [kf, clip]) == [(None,), (None,)]


def _forged(db, role, q, p):
    with psycopg.connect(db.dsn, autocommit=False) as c:
        c.execute("select set_config('request.jwt.claims', %s, true)", [json.dumps({"role": "service_role", "sub": None})])
        c.execute("select set_config('request.jwt.claim.role', 'service_role', true)")
        c.execute(f"set local role {role}")
        try:
            return c.execute(q, p).fetchall()
        finally:
            c.rollback()


@pytest.mark.parametrize("role", ["authenticated", "anon"])
def test_forged_service_role_claims_under_an_api_role_cannot_write(db, a, role):
    _f, seg, kf, _t = running_take(db, a)
    for q, p in (("select public.film_take_progress(%s, 'w-1', 50, 'running')", [kf]),
                 ("select public.film_segment_assembly_progress(%s, 'w-1', 50)", [seg]),
                 ("update public.film_takes set progress = 50, vendor_state = 'x' where id = %s", [kf]),
                 ("update public.film_segments set assembly_progress = 50 where id = %s", [seg])):
        state, _m, _d = err(lambda: _forged(db, role, q, p))
        assert state == "42501", (role, q)
    assert progress_of(db, kf)[0] is None


def test_only_service_role_may_execute_the_writers_and_no_api_role_may_write_the_columns(db):
    for r in _roles(db):
        for sig in (TAKE_PROGRESS, ASSEMBLY_PROGRESS):
            can = db.su("select has_function_privilege(%s, %s, 'execute')", [r, sig])[0][0]
            assert can is (r == "service_role"), (r, sig)
        for table, col in COLUMNS:
            if r == "public":
                continue
            ins, upd = db.su("select has_column_privilege(%s, %s, %s, 'insert'), has_column_privilege(%s, %s, %s, 'update')",
                             [r, f"public.{table}", col, r, f"public.{table}", col])[0]
            assert (ins, upd) == (False, False), (r, table, col)
    for table, col in COLUMNS:
        assert db.su("select has_column_privilege('anon', %s, %s, 'select')", [f"public.{table}", col])[0][0] is False


def test_a_worker_that_lost_the_lease_while_its_write_waited_writes_nothing(db, a):
    """B-0246-1. w-1's write blocks on the take's row lock; meanwhile its lease goes stale and w-2 claims the segment; the lock is
    released. film_take_progress must then answer false and write nothing, as film_heartbeat_segment answers false for w-1."""
    _f, seg, kf, _t = running_take(db, a)
    out = {}
    with psycopg.connect(db.dsn, autocommit=False) as holder:
        holder.execute("select 1 from public.film_takes where id = %s for no key update", [kf])

        def stale_write():
            with psycopg.connect(db.dsn, autocommit=False) as c:
                c.execute("select set_config('request.jwt.claims', %s, true)", [json.dumps({"role": "service_role"})])
                c.execute("set local role service_role")
                out["hit"] = c.execute("select public.film_take_progress(%s, 'w-1', 13, 'stale')", [kf]).fetchone()[0]
                c.commit()

        t = threading.Thread(target=stale_write)
        t.start()
        # Wait until w-1's statement is blocked on the row lock (its snapshot of the segment already read).
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            waiting = db.su("select count(*) from pg_stat_activity where datname = current_database() "
                            "and wait_event_type = 'Lock' and query like '%%film_take_progress%%'")[0][0]
            if waiting:
                break
            time.sleep(0.05)
        assert waiting, "the stale write never blocked; the race could not be set up"
        # The lease runs out and another worker takes the segment over.
        db.su("update public.film_segments set heartbeat_at = now() - interval '2 hours' where id = %s", [seg])
        got = db.claim("w-2")
        assert got and got["id"] == seg
        assert db.su("select worker_id from public.film_segments where id = %s", [seg])[0][0] == "w-2"
        holder.rollback()
        t.join(10)
    assert db.svc("select public.film_heartbeat_segment(%s, 'w-1')", [seg]) is False
    assert out.get("hit") is False, "a worker that no longer holds the segment wrote the take's progress"
    assert progress_of(db, kf)[1] != "stale"


def test_0246_and_0248_roll_back_and_apply_in_either_order_with_progress_stored(db, a):
    import sec_db

    _f, _s, kf, _t = running_take(db, a)
    assert write(db, kf, "w-1", 42, "running") is True
    with psycopg.connect(db.dsn, autocommit=False) as c:
        c.execute(sec_db.MIGRATION_0246.read_text(encoding="utf-8"))           # replay over a stored figure
        assert c.execute("select progress from public.film_takes where id = %s", [kf]).fetchone()[0] == Decimal("42.00")
        sec_db.take_off_0246(c)                                                # 0246 off first, 0248 still there
        assert c.execute("select to_regprocedure('public.film_take_typical_seconds(uuid)') is not null").fetchone()[0]
        c.execute("select set_config('request.jwt.claims', %s, true)", [json.dumps({"role": "authenticated", "sub": a.viewer})])
        c.execute("set local role authenticated")
        assert isinstance(c.execute("select public.film_take_typical_seconds(%s)", [_f]).fetchone()[0], list)
        c.execute("reset role")
        sec_db.take_off_0248(c)
        sec_db.put_back_0248(c)                                                # 0248 back before 0246
        sec_db.put_back_0246(c)
        assert c.execute("select progress from public.film_takes where id = %s", [kf]).fetchone()[0] is None
        assert c.execute("select has_column_privilege('authenticated', 'public.film_takes', 'vendor_state', 'select'), "
                         "has_function_privilege('authenticated', %s, 'execute')", [TAKE_PROGRESS]).fetchone() == (True, False)
        c.rollback()

"""Migrations 0246 (a running take's vendor percent and status word, the assembly's percent) and 0248 (typical take durations),
against the real schema and the real film worker functions (0171, 0198), as the money lab builds them.

What would break:

* a writer other than the worker that holds the take's segment (another worker, a member, anon) moving a take's progress, or
  the worker writing it for a take that is not running, or for an assembly that is not running;
* a figure outside 0..100 stored (clamped or as it came), or a status "word" that is free text stored: the columns' CHECK and
  the writer's own drop agree;
* a member of another organization reading a take's progress, or a member not reading their own;
* the medians: computed from another organization's takes, answered to someone who may not read the film (or answered with
  any id), a take that never started or failed counted, or n not returned so a caller could show a figure that rests on two;
* the end state of either file not being what it says.

Every test builds its own organization; the module's database is the money lab's.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from decimal import Decimal

import pytest

from test_sec_films_money import a, b, db, err, no_live_segment  # noqa: F401 — the money lab's fixtures, reused as they are

FOLD = ("select md5(regexp_replace(regexp_replace(p.prosrc, '[-][-][^' || chr(10) || chr(13) || ']*', '', 'g'), "
        "'[[:space:]]+', ' ', 'g')) from pg_proc p where p.oid = %s::regprocedure")
TAKE_PROGRESS = "public.film_take_progress(uuid, text, numeric, text)"
ASSEMBLY_PROGRESS = "public.film_segment_assembly_progress(uuid, text, numeric)"
TYPICAL = "public.film_take_typical_seconds(uuid)"


def running_take(db, o):
    """A started film whose first take (the key frame) is running under worker w-1."""
    film = db.film(o)
    s = db.quoted_start(o, film)
    assert db.claim()["id"] == s["id"]
    takes = db.takes(s["id"])
    kf = takes[0][0]
    db.begin(kf)
    return film, s["id"], kf, takes


def progress_of(db, take):
    return db.su("select progress, vendor_state, progress_at is not null from public.film_takes where id = %s", [take])[0]


def write(db, take, worker, pct, word):
    return db.svc("select public.film_take_progress(%s, %s, %s::numeric, %s)", [take, worker, pct, word])


# ── the bodies and the grants ───────────────────────────────────────────────

def test_the_live_bodies_and_grants_are_the_files(db):
    assert db.su(FOLD, [TAKE_PROGRESS])[0][0] == "e3c572fc3cc3b95d7dd113b223e837d3"
    assert db.su(FOLD, [ASSEMBLY_PROGRESS])[0][0] == "bac224571284b836694d51f2aed8bccb"
    assert db.su(FOLD, [TYPICAL])[0][0] == "1cbe7f01e8425f45355df594816935a4"
    for sig in (TAKE_PROGRESS, ASSEMBLY_PROGRESS):
        row = db.su("select has_function_privilege('service_role', %s, 'execute'), has_function_privilege('authenticated', %s, "
                    "'execute'), has_function_privilege('anon', %s, 'execute'), p.prosecdef from pg_proc p "
                    "where p.oid = %s::regprocedure", [sig, sig, sig, sig])[0]
        assert row == (True, False, False, True), sig
    row = db.su("select has_function_privilege('authenticated', %s, 'execute'), has_function_privilege('anon', %s, 'execute'), "
                "has_function_privilege('service_role', %s, 'execute')", [TYPICAL, TYPICAL, TYPICAL])[0]
    assert row == (True, False, False)
    for col in ("progress", "vendor_state", "progress_at"):
        assert db.su("select has_column_privilege('authenticated', 'public.film_takes', %s, 'select'), "
                     "has_column_privilege('authenticated', 'public.film_takes', %s, 'update')", [col, col])[0] == (True, False)
    assert db.su("select has_column_privilege('authenticated', 'public.film_segments', 'assembly_progress', 'select'), "
                 "has_table_privilege('service_role', 'public.film_takes', 'update'), "
                 "has_column_privilege('authenticated', 'public.film_takes', 'provider_task_id', 'select')")[0] == (True, False, False)


# ── who can write ───────────────────────────────────────────────────────────

def test_only_the_worker_holding_the_segment_writes_a_running_takes_progress(db, a):
    _film, _seg, kf, takes = running_take(db, a)
    assert write(db, kf, "w-1", 37.5, "running") is True
    assert progress_of(db, kf) == (Decimal("37.50"), "running", True)
    # Another worker, an empty worker, a take that is not running: false, and nothing moves.
    assert write(db, kf, "w-2", 90, "running") is False
    assert write(db, kf, "  ", 90, "running") is False
    clip = takes[1][0]
    assert write(db, clip, "w-1", 90, "running") is False
    assert progress_of(db, kf)[0] == Decimal("37.50")
    assert db.su("select progress from public.film_takes where id = %s", [clip])[0][0] is None


@pytest.mark.parametrize("role", ["authenticated", "anon"])
def test_a_member_or_anon_cannot_call_the_writers_or_update_the_columns(db, a, role):
    _film, seg, kf, _takes = running_take(db, a)
    user = a.admin if role == "authenticated" else None
    state, _msg, _detail = err(lambda: db.act(role, user, "select public.film_take_progress(%s, 'w-1', 50, 'running')", [kf]))
    assert state == "42501"
    state, _msg, _detail = err(lambda: db.act(role, user, "select public.film_segment_assembly_progress(%s, 'w-1', 50)", [seg]))
    assert state == "42501"
    state, _msg, _detail = err(lambda: db.act(role, user, "update public.film_takes set progress = 99 where id = %s", [kf]))
    assert state == "42501"
    assert progress_of(db, kf)[0] is None


def test_an_out_of_range_figure_or_a_sentence_is_stored_as_not_known_never_clamped(db, a):
    _film, _seg, kf, _takes = running_take(db, a)
    for pct, word in ((140, "running"), (-1, "running"), ("NaN", "running"), (50, "Task failed: quota for key sk-1"),
                      (50, "9lives"), (50, "x" * 33)):
        assert write(db, kf, "w-1", pct, word) is True
        got = progress_of(db, kf)
        if word == "running":
            assert got[0] is None, (pct, got)
        else:
            assert (got[0], got[1]) == (Decimal("50.00"), None), (word, got)
    # The CHECK holds the same rule for anything that writes the row (a definer of a later file, the owner by hand).
    state, _msg, _detail = err(lambda: db.su("update public.film_takes set progress = 101 where id = %s", [kf]))
    assert state == "23514"
    state, _msg, _detail = err(lambda: db.su("update public.film_takes set vendor_state = 'Not A Word' where id = %s", [kf]))
    assert state == "23514"


def test_the_assembly_percent_is_written_only_while_the_assembly_runs_and_only_by_its_worker(db, a):
    film = db.film(a)
    s = db.quoted_start(a, film)
    assert db.claim()["id"] == s["id"]
    assert db.svc("select public.film_segment_assembly_progress(%s, 'w-1', 10)", [s["id"]]) is False   # not running yet
    db.finish_all(a, s["id"])
    db.svc("select public.film_begin_assembly(%s, 'w-1')", [s["id"]])
    assert db.svc("select public.film_segment_assembly_progress(%s, 'w-2', 10)", [s["id"]]) is False
    assert db.svc("select public.film_segment_assembly_progress(%s, 'w-1', 61.257)", [s["id"]]) is True
    assert db.su("select assembly_progress, assembly_progress_at is not null from public.film_segments where id = %s",
                 [s["id"]])[0] == (Decimal("61.26"), True)
    assert db.svc("select public.film_segment_assembly_progress(%s, 'w-1', 100.5)", [s["id"]]) is True
    assert db.su("select assembly_progress from public.film_segments where id = %s", [s["id"]])[0][0] is None


# ── who can read ────────────────────────────────────────────────────────────

def test_members_read_their_own_takes_progress_and_no_one_elses(db, a, b):
    _film, seg, kf, _takes = running_take(db, a)
    write(db, kf, "w-1", 12, "queued")
    mine = db.act("authenticated", a.viewer, "select progress, vendor_state from public.film_takes where id = %s", [kf])
    assert mine == [(Decimal("12.00"), "queued")]
    seg_row = db.act("authenticated", a.viewer, "select assembly_progress from public.film_segments where id = %s", [seg])
    assert seg_row == [(None,)]
    assert db.act("authenticated", b.admin, "select progress from public.film_takes where id = %s", [kf]) == []
    assert db.act("authenticated", b.admin, "select assembly_progress from public.film_segments where id = %s", [seg]) == []
    state, _msg, _detail = err(lambda: db.act("anon", None, "select progress from public.film_takes where id = %s", [kf]))
    assert state == "42501"


# ── the medians (0248) ──────────────────────────────────────────────────────

def _timed(db, take, seconds, ago_min):
    end = datetime.now(timezone.utc) - timedelta(minutes=ago_min)
    db.su("update public.film_takes set started_at = %s, finished_at = %s where id = %s",
          [end - timedelta(seconds=seconds), end, take])


def typical(db, who, film):
    return db.one("authenticated", who, "select public.film_take_typical_seconds(%s)", [film])


def test_medians_are_the_films_organizations_own_with_n_and_no_ids(db, a, b):
    film_a = db.film(a)
    s = db.quoted_start(a, film_a)
    assert db.claim()["id"] == s["id"]
    made = db.finish_all(a, s["id"])
    takes = {t[0]: t[1] for t in db.takes(s["id"])}
    clips = [t for t, k in takes.items() if k == "clip"]
    kf = next(t for t, k in takes.items() if k == "keyframe")
    assert len(clips) >= 2 and made
    for i, c in enumerate(clips):
        _timed(db, c, 60 + 30 * i, 10 + i)        # 60 s, 90 s, ...
    _timed(db, kf, 12, 5)
    db.cancel(s["id"])

    # Another organization's slow clips on the same model never move a's figure.
    film_b = db.film(b)
    sb = db.quoted_start(b, film_b)
    assert db.claim()["id"] == sb["id"]
    db.finish_all(b, sb["id"])
    for t, k in ((t[0], t[1]) for t in db.takes(sb["id"])):
        _timed(db, t, 3000, 3)
    db.cancel(sb["id"])

    got = {(r["model"], r["capability"]): r for r in typical(db, a.viewer, film_a)}
    clip_model = db.su("select model from public.film_takes where id = %s", [clips[0]])[0][0]
    kf_model = db.su("select model from public.film_takes where id = %s", [kf])[0][0]
    want = sorted(60 + 30 * i for i in range(len(clips)))
    med = (want[len(want) // 2] if len(want) % 2 else (want[len(want) // 2 - 1] + want[len(want) // 2]) / 2)
    r = got[(clip_model, "i2v")]
    assert (Decimal(str(r["median_s"])), r["n"]) == (Decimal(str(round(med, 1))), len(clips))
    assert r["n"] < 3, "this lab film has fewer than three clips: the caller must see n and show no figure"
    assert (got[(kf_model, "t2i")]["median_s"], got[(kf_model, "t2i")]["n"]) == (12, 1)
    for row in got.values():
        assert set(row) == {"model", "capability", "median_s", "n"}
    # b sees only b's.
    gb = {(r["model"], r["capability"]): r for r in typical(db, b.viewer, film_b)}
    assert gb[(clip_model, "i2v")]["median_s"] == 3000


def test_a_failed_or_never_started_take_is_not_a_duration_and_three_takes_are_n_3(db, a):
    film = db.film(a)
    s = db.quoted_start(a, film)
    assert db.claim()["id"] == s["id"]
    rows = db.takes(s["id"])
    kf, clip1 = rows[0][0], rows[1][0]
    db.make(a, kf, "keyframe")
    db.begin(clip1)
    db.fail(clip1, "provider_error")
    _timed(db, clip1, 999, 2)
    db.cancel(s["id"])
    got = {(r["model"], r["capability"]) for r in typical(db, a.viewer, film)}
    assert not any(cap == "i2v" for _m, cap in got)
    # Three completed key frames of three films: n = 3, the first figure the plan may show.
    for i in range(2):
        f = db.film(a)
        s2 = db.quoted_start(a, f)
        assert db.claim()["id"] == s2["id"]
        k = db.takes(s2["id"])[0][0]
        db.make(a, k, "keyframe")
        db.cancel(s2["id"])
    db.su("update public.film_takes set started_at = finished_at - interval '20 seconds' where org_id = %s and kind = 'keyframe' "
          "and status = 'completed'", [a.org])
    row = next(r for r in typical(db, a.viewer, film) if r["capability"] == "t2i")
    assert (row["n"], row["median_s"]) == (3, 20)


def test_someone_who_may_not_read_the_film_gets_not_found_whether_or_not_it_exists(db, a, b):
    film = db.film(a)
    for f in (film, "00000000-0000-4000-8000-0000000000aa"):
        state, msg, _detail = err(lambda: typical(db, b.admin, f))
        assert state == "P0002" and "not_found" in msg
    state, _msg, _detail = err(lambda: db.act("anon", None, "select public.film_take_typical_seconds(%s)", [film]))
    assert state == "42501"

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
    assert db.su(FOLD, [TAKE_PROGRESS])[0][0] == "28911b1d6dbdd1bb6176c9617c1aba8c"
    assert db.su(FOLD, [ASSEMBLY_PROGRESS])[0][0] == "bac224571284b836694d51f2aed8bccb"
    assert db.su(FOLD, [TYPICAL])[0][0] == "8e988e75f11d8fa798d2504b71483727"
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

_MODEL_N = [0]


def _model():
    """A model id of this test's own: the platform window spans every organization of the lab, so no other test may feed it."""
    _MODEL_N[0] += 1
    return f"lab-median-{_MODEL_N[0]}"


def _takes(db, o, model, seconds, status="completed", film=None):
    """Completed key-frame takes of ``model`` in a film of ``o`` (one per figure in ``seconds``), finished a minute apart, written
    straight into film_takes as the worker's functions leave them (the timings are what 0248 reads). Returns the film."""
    film = film or db.film(o)
    scene = db.su("select id from public.film_scenes where film_id = %s order by position limit 1", [film])[0][0]
    now = datetime.now(timezone.utc)
    for i, secs in enumerate(seconds):
        end = now - timedelta(minutes=1 + i)
        db.su("insert into public.film_takes (film_id, org_id, scene_id, version, shot_index, kind, attempt, status, model, params, "
              "started_at, finished_at) values (%s, %s, %s, %s, 0, 'keyframe', 1, %s, %s, '{}'::jsonb, %s, %s)",
              [film, o.org, scene, 100 + db.su("select count(*) from public.film_takes where film_id = %s", [film])[0][0],
               status, model, end - timedelta(seconds=secs), end])
    return film


def typical(db, who, film):
    return db.one("authenticated", who, "select public.film_take_typical_seconds(%s)", [film])


def row_for(db, who, film, model):
    rows = [r for r in typical(db, who, film) if r["model"] == model]
    assert len(rows) == 1, rows
    return rows[0]


def test_yours_with_three_takes_gives_its_median_and_n_in_whole_seconds(db, a):
    m = _model()
    film = _takes(db, a, m, [10.4, 10.6, 11.5])
    assert row_for(db, a.viewer, film, m) == {"model": m, "capability": "t2i", "basis": "yours", "median_s": 11, "n": 3}


def test_fewer_than_three_of_yours_and_five_workspaces_of_four_give_the_platform_figure_with_no_n_and_no_count(db, a):
    m = _model()
    film = _takes(db, a, m, [500, 600])                  # yours: n = 2, not enough
    for secs in ([10, 12, 14, 16], [20, 22, 24, 26], [30, 31, 32, 33], [40, 41, 42, 43], [50, 50, 50, 50]):
        _takes(db, db.new_org(), m, secs)
    r = row_for(db, a.viewer, film, m)
    # The median of the six workspaces' own medians (550, 13, 23, 31.5, 41.5, 50): (31.5 + 41.5) / 2 = 36.5, whole seconds 37.
    assert r == {"model": m, "capability": "t2i", "basis": "platform", "median_s": 37}
    assert set(r) == {"model", "capability", "basis", "median_s"}


def test_four_workspaces_however_busy_give_nothing(db, a):
    m = _model()
    film = _takes(db, a, m, [60], status="failed")       # the film has a take of the model; a failed one is not a duration
    for _ in range(4):
        _takes(db, db.new_org(), m, [30] * 30)
    assert row_for(db, a.viewer, film, m) == {"model": m, "capability": "t2i", "basis": None}


def test_one_busy_workspace_does_not_set_the_platform_figure(db, a):
    # One workspace of 100 slow takes and four of one fast take each: 20 (its cap) + 4 = 24 takes from 5 workspaces passes the
    # floor, and the figure is the median of the five workspaces' medians (1000, 10, 20, 30, 40) = 30, never near the busy one's.
    m = _model()
    film = _takes(db, a, m, [5], status="failed")
    _takes(db, db.new_org(), m, [1000] * 100)
    for secs in (10, 20, 30, 40):
        _takes(db, db.new_org(), m, [secs])
    assert row_for(db, a.viewer, film, m) == {"model": m, "capability": "t2i", "basis": "platform", "median_s": 30}


def test_both_floors_hold_five_workspaces_and_twenty_takes(db, a):
    # One workspace of 100 and three of one: 4 workspaces, nothing, however many takes.
    m = _model()
    film = _takes(db, a, m, [5], status="failed")
    _takes(db, db.new_org(), m, [100] * 100)
    for secs in (10, 20, 30):
        _takes(db, db.new_org(), m, [secs])
    assert row_for(db, a.viewer, film, m)["basis"] is None
    # Five workspaces with 15 + 4 = 19 takes: below 20, nothing.
    m2 = _model()
    film2 = _takes(db, a, m2, [5], status="failed")
    _takes(db, db.new_org(), m2, [100] * 15)
    for secs in (10, 20, 30, 40):
        _takes(db, db.new_org(), m2, [secs])
    assert row_for(db, a.viewer, film2, m2)["basis"] is None


def test_a_workspace_counts_over_its_own_last_twenty_only(db, a):
    # The 20 newest at 10 s, 10 older at 1000 s: the window is the 20 newest (n = 20), so the median is 10, not pulled up.
    m = _model()
    film = _takes(db, a, m, [10] * 20 + [1000] * 10)
    assert row_for(db, a.viewer, film, m) == {"model": m, "capability": "t2i", "basis": "yours", "median_s": 10, "n": 20}


def test_only_the_films_own_models_are_answered(db, a, b):
    m = _model()
    film = _takes(db, a, m, [10, 11, 12])
    _takes(db, b, _model(), [10, 11, 12])                 # another workspace's model: never named in a's answer
    assert {r["model"] for r in typical(db, a.viewer, film)} == {m}


def test_someone_who_may_not_read_the_film_gets_not_found_whether_or_not_it_exists(db, a, b):
    film = db.film(a)
    for f in (film, "00000000-0000-4000-8000-0000000000aa"):
        state, msg, _detail = err(lambda: typical(db, b.admin, f))
        assert state == "P0002" and "not_found" in msg
    state, _msg, _detail = err(lambda: db.act("anon", None, "select public.film_take_typical_seconds(%s)", [film]))
    assert state == "42501"


# ── replay, rollback and the guard ──────────────────────────────────────────

def test_both_files_replay_onto_themselves_roll_back_and_apply_again_and_refuse_a_foreign_body(db):
    import psycopg

    import sec_db

    with psycopg.connect(db.dsn, autocommit=False) as c:
        for path in (sec_db.MIGRATION_0246, sec_db.MIGRATION_0248):
            c.execute(path.read_text(encoding="utf-8"))          # a second run of each changes nothing and raises nothing
        sec_db.take_off_0248(c)
        sec_db.take_off_0246(c)
        gone = c.execute("select to_regprocedure(%s), to_regprocedure(%s), (select count(*) from information_schema.columns "
                         "where table_schema = 'public' and table_name = 'film_takes' and column_name in "
                         "('progress', 'vendor_state', 'progress_at'))", [TAKE_PROGRESS, TYPICAL]).fetchone()
        assert gone == (None, None, 0)
        sec_db.put_back_0246(c)
        sec_db.put_back_0248(c)
        assert c.execute(FOLD, [TAKE_PROGRESS]).fetchone()[0] == "28911b1d6dbdd1bb6176c9617c1aba8c"
        c.execute("create or replace function public.film_take_typical_seconds(p_film uuid) returns jsonb "
                  "language sql stable security definer set search_path = public, pg_temp as $$ select '[]'::jsonb $$")
        with pytest.raises(psycopg.Error) as e:
            c.execute(sec_db.MIGRATION_0248.read_text(encoding="utf-8"))
        assert "is not this file's" in str(e.value)
        c.rollback()
    for path in (sec_db.MIGRATION_0246, sec_db.MIGRATION_0248, sec_db.ROLLBACK_0246, sec_db.ROLLBACK_0248):
        assert "\\" not in path.read_text(encoding="utf-8"), path

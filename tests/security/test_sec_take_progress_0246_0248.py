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
    assert db.su(FOLD, [TYPICAL])[0][0] == "2b78ecab9db4e806d97d9774d1f61c61"
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
    """A model id of this test's own: the operator's figure is shared by every test of the lab, so no other test may feed it."""
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


OPERATOR_ORG = "00000000-0000-0000-0000-000000000001"   # public.default_org_id(): the organization the credits exempt (0020)
_OPERATOR = {}


def operator(db):
    """The operator's organization (credits_exempt), with four people of its own, as an Org the money lab's helpers take."""
    # Keyed by the database: every module has a scratch database of its own, and an Org made in one does not exist in another.
    if db.dsn not in _OPERATOR:
        import uuid as _uuid

        from test_sec_films_money import Org

        assert db.su("select public.credits_exempt(%s)", [OPERATOR_ORG])[0][0] is True
        if not db.su("select 1 from public.organizations where id = %s", [OPERATOR_ORG]):
            db.su("insert into public.organizations (id, name, slug) values (%s, 'Nightshift', 'nightshift-lab')", [OPERATOR_ORG])
        people = [str(_uuid.uuid4()) for _ in range(4)]
        for u, role in zip(people, ("owner", "admin", "editor", "viewer")):
            db.su("insert into auth.users (id, email) values (%s, %s)", [u, f"{role}-{u[:8]}@operator.lab"])
            db.su("insert into public.org_members (org_id, user_id, email, role) values (%s, %s, %s, %s)",
                  [OPERATOR_ORG, u, f"{role}-{u[:8]}@operator.lab", role])
        db.film_org_on(OPERATOR_ORG)
        _OPERATOR[db.dsn] = Org(OPERATOR_ORG, *people)
    return _OPERATOR[db.dsn]


def test_two_of_yours_and_the_operators_three_give_nightshifts_figure_with_no_n(db, a):
    m = _model()
    film = _takes(db, a, m, [500, 600])                  # yours: n = 2, not enough
    _takes(db, operator(db), m, [40, 44, 47.6])
    r = row_for(db, a.viewer, film, m)
    assert r == {"model": m, "capability": "t2i", "basis": "nightshift", "median_s": 44}
    assert set(r) == {"model", "capability", "basis", "median_s"}


def test_the_operators_two_takes_give_nothing(db, a):
    m = _model()
    film = _takes(db, a, m, [60], status="failed")
    _takes(db, operator(db), m, [40, 44])
    assert row_for(db, a.viewer, film, m) == {"model": m, "capability": "t2i", "basis": None}


def test_a_hundred_customer_workspaces_give_nothing(db, a):
    m = _model()
    film = _takes(db, a, m, [60], status="failed")
    for i in range(100):
        _takes(db, db.new_org(image=False), m, [10 + i])
    assert row_for(db, a.viewer, film, m) == {"model": m, "capability": "t2i", "basis": None}


def test_customer_takes_never_move_the_operators_figure(db, a):
    m = _model()
    film = _takes(db, a, m, [60], status="failed")
    _takes(db, operator(db), m, [30, 31, 32])
    before = row_for(db, a.viewer, film, m)
    assert before == {"model": m, "capability": "t2i", "basis": "nightshift", "median_s": 31}
    for secs in ([1] * 20, [5000] * 20, [31] * 3, [2, 3, 4]):
        _takes(db, db.new_org(image=False), m, secs)
    assert row_for(db, a.viewer, film, m) == before


def test_the_operator_itself_gets_its_own_figure_as_yours(db):
    m = _model()
    op = operator(db)
    film = _takes(db, op, m, [20, 22, 24])
    assert row_for(db, op.viewer, film, m) == {"model": m, "capability": "t2i", "basis": "yours", "median_s": 22, "n": 3}


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

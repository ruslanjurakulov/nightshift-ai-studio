"""Migration 0249: ai_chat_save_sheets is the one writer of a conversation's brief.ref_sheets and brief.film_link, under the row lock,
and a trigger keeps them from every other BRIEF writer (0199's ai_chat_save_brief and ai_chat_finish_turn, and anything later).

#980 (Lens M2) left a window: both the sheets route and the turn route re-read the stored sheets and wrote the WHOLE BRIEF through
0199, so a write landing between one's read and its write was put back to the older list. A lost approval cannot be recovered. These
pin what closes it:

* a sheets write and a turn's whole-BRIEF write at the same moment (two connections, the row lock between them, both orders) lose
  nothing: the approval stays, the turn's own keys are written; two sheets writers (two tabs) keep both views;
* the merge is the app's (lib/brain/ref-sheets mergeConcurrent): the caller's changed view wins, otherwise the later attempt and
  then the further state; only ref_sheets and film_link change, never another key, the step or the card;
* another person, a colleague who is not the author, a viewer and a signed-out caller write nothing; a handed-off plan is
  session_closed, a plan not yet chosen plan_not_ready, a project's storyboard conversation film_conversation;
* the caps are refused by name and write nothing; a film link to another workspace's film is refused;
* the guard refuses a changed ai_chat_save_brief; the file replays onto itself; the rollback removes it and 0199's writes drop the
  sheets again, as before (that is the race it reopens), and the stored sheets stay.
"""

from __future__ import annotations

import json
import threading
import time
import uuid

import psycopg
import pytest
from psycopg import sql

import sec_db
import sec_sheets_writer_0249 as writer
import test_sec_series_tables as st
from sec_db import as_superuser, user
from sec_films_0166 import FILM

MIGRATION = sec_db.MIGRATION_0249
ROLLBACK = sec_db.ROLLBACK_0249

SAVE = "select public.ai_chat_save_sheets(%s, %s::jsonb, %s::jsonb, %s::jsonb)"
BRIEF = "select public.ai_chat_save_brief(%s, %s::jsonb, 'ready')"


# ── one rolled-back transaction, acting as each caller in turn ──────────────────

def become(s, who):
    s.conn.execute("reset role")
    if who is None:
        s.conn.execute("select set_config('request.jwt.claims', '', true)")
        return s
    s.conn.execute("select set_config('request.jwt.claims', %s, true)", [json.dumps(who.claims())])
    s.conn.execute("select set_config('request.jwt.claim.role', %s, true)", [who.role])
    s.conn.execute(sql.SQL("set local role {}").format(sql.Identifier(who.role)))
    return s


def as_(s, who, q, p=None):
    become(s, who)
    try:
        return s.run(q, p)
    finally:
        become(s, None)


def refused(s, who, q, p):
    """The refusal's message (creative_refuse's code), or None when the call went through."""
    out = as_(s, who, q, p)
    if out.ok:
        return None
    return out.error.split("ERROR:", 1)[-1].strip()


def key(n: int) -> str:
    return "sheet:" + format(n, "048x")


def view(name, status="planned", attempt=0, **kw):
    v = {"view": name, "prompt": f"a {name} portrait", "asset_id": None, "status": status, "job_id": None, "attempt": attempt,
         "error": None, "key": None}
    v.update(kw)
    return v


def sheet(cid="c1", stage=None, views=None):
    return {"character_id": cid, "stage": stage, "views": views if views is not None else [view("front"), view("side"), view("back")]}


def j(x):
    return None if x is None else json.dumps(x)


def stored(su, sid):
    become(su, None)
    return su.value("select brief from public.ai_chat_sessions where id = %s", [sid])


def front(brief, cid="c1", stage=None):
    s = next(x for x in brief["ref_sheets"] if x["character_id"] == cid and x["stage"] == stage)
    return {v["view"]: v for v in s["views"]}


def put(su, sid, sql_set, params):
    """A setup write as the database owner, past the keep-sheets trigger the way ai_chat_save_sheets passes it (the row named in the
    transaction-local setting, cleared after): without it the trigger keeps the stored sheets, which is what the tests below pin."""
    become(su, None)
    su.conn.execute("select set_config('nightshift.ai_chat_sheets', %s, true)", [str(sid)])
    su.rows(f"update public.ai_chat_sessions set {sql_set} where id = %s returning 1", [*params, sid])
    su.conn.execute("select set_config('nightshift.ai_chat_sheets', '', true)")


def put_sheets(su, sid, sheets):
    put(su, sid, "brief = jsonb_set(brief, '{ref_sheets}', %s::jsonb)", [json.dumps(sheets)])


BASE_BRIEF = {"version": 1, "kind": "short", "title": "Before", "characters": [{"id": "c1", "name": "Mira"}]}


@pytest.fixture()
def w(conn, sc):
    """Alice's seeded conversation as a chosen plan (step ready) with one sheet, a colleague editor of her workspace, a viewer with a
    conversation of their own, and Bob."""
    with as_superuser(conn, commit=False) as su:
        x = type("W", (), {})()
        x.su, x.alice, x.bob, x.org = su, sc.alice.actor, sc.bob.actor, sc.alice.org
        x.sid = sc.alice.ai_chat_session
        x.bob_sid = sc.bob.ai_chat_session
        x.sheets = [sheet()]
        put(su, x.sid, "step = 'ready', card = '{\"id\": \"kept\"}'::jsonb, brief = %s::jsonb",
            [json.dumps({**BASE_BRIEF, "ref_sheets": x.sheets})])
        x.colleague = member(su, x.org, "editor")
        x.viewer = member(su, x.org, "viewer")
        x.viewer_sid = su.value("insert into public.ai_chat_sessions (org_id, created_by, model, step, brief) "
                                "values (%s, %s, 'anthropic-claude-sonnet-5-5', 'ready', %s::jsonb) returning id",
                                [x.org, x.viewer.uid, json.dumps({**BASE_BRIEF, "ref_sheets": x.sheets})])
        x.scenes = [str(r[0]) for r in su.rows("select id from public.film_scenes where film_id = %s order by position", [FILM["a"]])]
        yield x


def member(su, org, role):
    who = user(f"sheets-{role}", f"sheets-{role}-{uuid.uuid4().hex[:6]}@sheets0249.lab")
    su.rows("insert into auth.users (id, email) values (%s, %s) returning 1", [who.uid, who.email])
    su.rows("insert into public.org_members (org_id, user_id, email, role) values (%s, %s, %s, %s) returning 1",
            [org, who.uid, who.email, role])
    return who


# ── what it writes ───────────────────────────────────────────────────────────────

def test_the_author_writes_only_the_sheets_never_another_key_the_step_or_the_card(w):
    mine = [sheet(views=[view("front", "making", key=key(1)), view("side"), view("back")])]
    out = as_(w.su, w.alice, SAVE, [w.sid, j(mine), j(w.sheets), None])
    assert out.ok, out
    assert out.rows[0][0]["ref_sheets"] == mine
    b = stored(w.su, w.sid)
    assert b["ref_sheets"] == mine
    assert {k: v for k, v in b.items() if k != "ref_sheets"} == BASE_BRIEF
    row = w.su.rows("select step, card from public.ai_chat_sessions where id = %s", [w.sid])[0]
    assert row == ("ready", {"id": "kept"})


def test_the_merge_is_the_apps_the_callers_change_wins_otherwise_the_later_attempt_then_the_further_state(w):
    # Stored meanwhile by another writer: front approved, side made, back on its second attempt.
    meanwhile = [sheet(views=[view("front", "approved", asset_id=str(uuid.uuid4())), view("side", "ready", asset_id=str(uuid.uuid4())),
                              view("back", "planned", attempt=1)])]
    put_sheets(w.su, w.sid, meanwhile)
    # This request started from the seeded list and changed only the side (a redo: attempt 1, planned); its front and back are the
    # base's own (planned, attempt 0).
    mine = [sheet(views=[view("front"), view("side", "planned", attempt=1), view("back")])]
    out = as_(w.su, w.alice, SAVE, [w.sid, j(mine), j(w.sheets), None])
    assert out.ok, out
    v = front(stored(w.su, w.sid))
    assert v["front"]["status"] == "approved"                     # unchanged by the caller: the further state stays
    assert v["side"] == view("side", "planned", attempt=1)        # the caller's change: theirs, even though "earlier"
    assert v["back"]["attempt"] == 1                               # unchanged by the caller: the later attempt stays


def test_a_sheet_only_one_side_has_is_kept_and_a_new_one_is_added(w):
    put_sheets(w.su, w.sid, [sheet(), sheet("c2")])
    out = as_(w.su, w.alice, SAVE, [w.sid, j([sheet("c3")]), j([]), None])
    assert out.ok, out
    assert [s["character_id"] for s in stored(w.su, w.sid)["ref_sheets"]] == ["c1", "c2", "c3"]


def test_the_same_save_twice_answers_the_same_and_changes_nothing_more(w):
    mine = [sheet(views=[view("front", "approved", asset_id=str(uuid.uuid4())), view("side"), view("back")])]
    first = as_(w.su, w.alice, SAVE, [w.sid, j(mine), j(w.sheets), None])
    again = as_(w.su, w.alice, SAVE, [w.sid, j(mine), j(w.sheets), None])
    assert first.ok and again.ok
    assert first.rows[0][0] == again.rows[0][0]
    assert stored(w.su, w.sid)["ref_sheets"] == mine


def test_the_film_link_is_written_alone_and_only_to_the_workspaces_own_film(w):
    link = {"film_id": FILM["a"], "scenes": [{"brief": "s1", "film": w.scenes[0]}]}
    out = as_(w.su, w.alice, SAVE, [w.sid, None, None, j(link)])
    assert out.ok, out
    b = stored(w.su, w.sid)
    assert b["film_link"] == link and b["ref_sheets"] == w.sheets
    # Bob's film, or Bob's scene under Alice's film: refused, nothing written.
    other = {"film_id": FILM["b"], "scenes": []}
    assert refused(w.su, w.alice, SAVE, [w.sid, None, None, j(other)]) == "invalid_film_link"
    bob_scene = w.su.value("select id::text from public.film_scenes where film_id = %s limit 1", [FILM["b"]])
    mixed = {"film_id": FILM["a"], "scenes": [{"brief": "s1", "film": bob_scene}]}
    assert refused(w.su, w.alice, SAVE, [w.sid, None, None, j(mixed)]) == "invalid_film_link"
    assert refused(w.su, w.alice, SAVE, [w.sid, None, None, j({"film_id": FILM["a"], "scenes": [], "x": 1})]) == "invalid_film_link"
    assert stored(w.su, w.sid)["film_link"] == link
    assert refused(w.su, w.alice, SAVE, [w.sid, None, None, None]) == "invalid_params"


# ── every other writer keeps them (the trigger) ──────────────────────────────────

def test_a_whole_brief_without_the_sheets_keeps_the_stored_ones(w):
    link = {"film_id": FILM["a"], "scenes": [{"brief": "s1", "film": w.scenes[0]}]}
    assert as_(w.su, w.alice, SAVE, [w.sid, None, None, j(link)]).ok
    out = as_(w.su, w.alice, BRIEF, [w.sid, json.dumps({**BASE_BRIEF, "title": "After"})])
    assert out.ok, out
    b = stored(w.su, w.sid)
    assert b["title"] == "After"
    assert b["ref_sheets"] == w.sheets and b["film_link"] == link


def test_a_whole_brief_carrying_an_older_copy_keeps_the_newer_stored_one(w):
    """The race itself, in one transaction: the turn route read the sheets, an approval landed, the route writes what it read."""
    approved = [sheet(views=[view("front", "approved", asset_id=str(uuid.uuid4())), view("side"), view("back")])]
    assert as_(w.su, w.alice, SAVE, [w.sid, j(approved), j(w.sheets), None]).ok
    stale = {**BASE_BRIEF, "title": "After", "ref_sheets": w.sheets, "film_link": {"film_id": FILM["b"], "scenes": []}}
    assert as_(w.su, w.alice, BRIEF, [w.sid, json.dumps(stale)]).ok
    b = stored(w.su, w.sid)
    assert b["title"] == "After"
    assert b["ref_sheets"] == approved
    assert "film_link" not in b          # a link the row did not have is not taken from a whole-BRIEF write either


def test_a_chat_turns_finish_keeps_them_too(w):
    approved = [sheet(views=[view("front", "approved", asset_id=str(uuid.uuid4())), view("side"), view("back")])]
    assert as_(w.su, w.alice, SAVE, [w.sid, j(approved), j(w.sheets), None]).ok
    call = w.su.value("insert into public.ai_chat_calls (org_id, user_id, session_id, model, outcome) "
                      "values (%s, %s, %s, 'anthropic-claude-sonnet-5-5', 'pending') returning id", [w.org, w.alice.uid, w.sid])
    out = as_(w.su, w.alice, "select public.ai_chat_finish_turn(%s, 'ok', 1, 1, 'hi', null, null, 'ready', %s::jsonb, null)",
              [call, json.dumps({**BASE_BRIEF, "title": "Turned"})])
    assert out.ok, out
    b = stored(w.su, w.sid)
    assert b["title"] == "Turned" and b["ref_sheets"] == approved


def test_even_the_database_owner_cannot_drop_them_with_a_plain_update(w):
    w.su.rows("update public.ai_chat_sessions set brief = '{}'::jsonb where id = %s returning 1", [w.sid])
    assert stored(w.su, w.sid) == {"ref_sheets": w.sheets}


def test_the_flag_names_one_row_and_is_cleared_after_the_write(w):
    """ai_chat_save_sheets clears its setting at once: a later whole-BRIEF write in the same transaction is overruled again."""
    approved = [sheet(views=[view("front", "approved", asset_id=str(uuid.uuid4())), view("side"), view("back")])]
    assert as_(w.su, w.alice, SAVE, [w.sid, j(approved), j(w.sheets), None]).ok
    assert w.su.value("select coalesce(current_setting('nightshift.ai_chat_sheets', true), '')") == ""
    w.su.conn.execute("select set_config('nightshift.ai_chat_sheets', %s, true)", [w.bob_sid])
    w.su.rows("update public.ai_chat_sessions set brief = '{}'::jsonb where id = %s returning 1", [w.sid])
    w.su.conn.execute("select set_config('nightshift.ai_chat_sheets', '', true)")
    assert stored(w.su, w.sid)["ref_sheets"] == approved


# ── who may ──────────────────────────────────────────────────────────────────────

def test_another_person_a_colleague_and_a_viewer_write_nothing(w):
    mine = [sheet(views=[view("front", "approved", asset_id=str(uuid.uuid4())), view("side"), view("back")])]
    assert refused(w.su, w.bob, SAVE, [w.sid, j(mine), j(w.sheets), None]) == "session_not_found"
    assert refused(w.su, w.colleague, SAVE, [w.sid, j(mine), j(w.sheets), None]) == "session_not_found"
    # A viewer's own conversation (a demoted author): read as missing, as 0199's save_brief says it.
    assert refused(w.su, w.viewer, SAVE, [w.viewer_sid, j(mine), j(w.sheets), None]) == "session_not_found"
    assert stored(w.su, w.sid)["ref_sheets"] == w.sheets
    assert stored(w.su, w.viewer_sid)["ref_sheets"] == w.sheets


def test_signed_out_and_anon_write_nothing(w):
    nobody = sec_db.Actor("sheets-nobody", "authenticated")
    out = as_(w.su, nobody, SAVE, [w.sid, j(w.sheets), j([]), None])
    assert not out.ok and out.sqlstate == "42501"
    out = as_(w.su, sec_db.ANON, SAVE, [w.sid, j(w.sheets), j([]), None])
    assert not out.ok and out.sqlstate == "42501"
    out = as_(w.su, sec_db.SERVICE, SAVE, [w.sid, j(w.sheets), j([]), None])
    assert not out.ok and out.sqlstate == "42501"
    for who in (w.alice, sec_db.ANON):
        out = as_(w.su, who, "select public.ai_chat_sheet_problem('{}'::jsonb)")
        assert not out.ok and out.sqlstate == "42501"


@pytest.mark.parametrize("step,brief_extra,code", [
    ("created", {}, "session_closed"),
    ("proposing", {}, "plan_not_ready"),
    ("asking", {}, "plan_not_ready"),
    ("ready", {"film_plan": {"film_id": "x"}}, "film_conversation"),
])
def test_a_plan_that_is_not_writable_is_refused_by_name_and_keeps_its_sheets(w, step, brief_extra, code):
    w.su.rows("update public.ai_chat_sessions set step = %s, brief = brief || %s::jsonb where id = %s returning 1",
              [step, json.dumps(brief_extra), w.sid])
    mine = [sheet(views=[view("front", "approved", asset_id=str(uuid.uuid4())), view("side"), view("back")])]
    assert refused(w.su, w.alice, SAVE, [w.sid, j(mine), j(w.sheets), None]) == code
    assert stored(w.su, w.sid)["ref_sheets"] == w.sheets


# ── the caps ─────────────────────────────────────────────────────────────────────

def _bad(name):
    good = view("front")
    cases = {
        "too_many_sheets": [sheet(f"c{i}") for i in range(41)],
        "sheets_too_large": [sheet(f"c{i}", views=[view(n, prompt="p" * 2000) for n in ("front", "side", "back")]) for i in range(40)],
        "too_many_views": [sheet(views=[view("front"), view("side"), view("back"), view("front")])],
        "sheet_prompt_too_long": [sheet(views=[view("front", prompt="p" * 4001)])],
        "invalid_sheet:extra key": [{**sheet(), "owner": "x"}],
        "invalid_sheet:view key": [sheet(views=[{**good, "url": "https://x"}])],
        "invalid_sheet:twice": [sheet(views=[view("front"), view("front")])],
        "invalid_sheet:dup sheet": [sheet(), sheet()],
        "invalid_sheet:job id": [sheet(views=[view("front", job_id="not-a-uuid")])],
        "invalid_sheet:status": [sheet(views=[view("front", "paid")])],
        "invalid_sheet:attempt": [sheet(views=[view("front", attempt="1")])],
        "invalid_sheet:attempt range": [sheet(views=[view("front", attempt=1000)])],
        "invalid_sheet:key": [sheet(views=[view("front", key="sheet:zz")])],
        "invalid_sheet:error": [sheet(views=[view("front", "failed", error="Not A Word")])],
        "invalid_sheet:character": [sheet("c 1")],
        "invalid_sheet:stage missing": [{"character_id": "c1", "views": []}],
        "invalid_sheet:not a list": {"character_id": "c1"},
    }
    return cases[name]


@pytest.mark.parametrize("case", [
    "too_many_sheets", "sheets_too_large", "too_many_views", "sheet_prompt_too_long", "invalid_sheet:extra key",
    "invalid_sheet:view key", "invalid_sheet:twice", "invalid_sheet:dup sheet", "invalid_sheet:job id", "invalid_sheet:status",
    "invalid_sheet:attempt", "invalid_sheet:attempt range", "invalid_sheet:key", "invalid_sheet:error", "invalid_sheet:character",
    "invalid_sheet:stage missing", "invalid_sheet:not a list",
])
def test_a_list_over_a_cap_or_out_of_shape_is_refused_by_name_and_writes_nothing(w, case):
    code = case.split(":", 1)[0]
    assert refused(w.su, w.alice, SAVE, [w.sid, j(_bad(case)), j(w.sheets), None]) == code
    # The base the caller started from is held to the same rules.
    assert refused(w.su, w.alice, SAVE, [w.sid, j(w.sheets), j(_bad(case)), None]) == code
    assert stored(w.su, w.sid)["ref_sheets"] == w.sheets


def test_forty_full_sheets_fit(w):
    full = [sheet(f"c{i}", views=[view(n, prompt="p" * 300) for n in ("front", "side", "back")]) for i in range(40)]
    out = as_(w.su, w.alice, SAVE, [w.sid, j(full), j([]), None])
    assert out.ok, out
    assert len(stored(w.su, w.sid)["ref_sheets"]) == 40


def test_a_malformed_stored_sheet_is_dropped_from_the_merge_not_kept(w):
    put_sheets(w.su, w.sid, [{"character_id": "bad id", "views": "x"}, sheet()])
    assert as_(w.su, w.alice, SAVE, [w.sid, j([sheet("c2")]), j([]), None]).ok
    assert [s["character_id"] for s in stored(w.su, w.sid)["ref_sheets"]] == ["c1", "c2"]


def test_one_bad_stored_view_drops_only_that_view_and_bad_fields_read_as_their_defaults(w):
    """As the app's readSheets: a sheet with one unreadable view keeps its other views (a paid picture's job id among them)."""
    job = str(uuid.uuid4())
    legacy = {"character_id": "c1", "stage": None, "extra": 1, "views": [
        view("front", "approved", job_id=job, asset_id=str(uuid.uuid4())),
        {"view": "side", "prompt": 7, "status": "ready"},                      # no string prompt: this view only is dropped
        {"view": "back", "prompt": "b", "status": "paid", "attempt": "x", "job_id": "nope", "key": "k", "error": "Bad"},
    ]}
    put_sheets(w.su, w.sid, [legacy])
    assert as_(w.su, w.alice, SAVE, [w.sid, j([sheet("c2")]), j([]), None]).ok
    s = stored(w.su, w.sid)["ref_sheets"][0]
    assert s["character_id"] == "c1" and "extra" not in s
    v = {x["view"]: x for x in s["views"]}
    assert set(v) == {"front", "back"}
    assert v["front"]["job_id"] == job and v["front"]["status"] == "approved"
    assert v["back"] == {"view": "back", "prompt": "b", "status": "planned", "attempt": 0, "job_id": None, "asset_id": None,
                         "key": None, "error": None}


def test_a_merge_past_forty_sheets_is_refused_never_cut(w):
    """Both reviewers on 0249: 40 stored plus one new is refused by name; the 40 stay, none is dropped."""
    forty = [sheet(f"c{i}") for i in range(40)]
    put_sheets(w.su, w.sid, forty)
    assert refused(w.su, w.alice, SAVE, [w.sid, j([sheet("c99")]), j([]), None]) == "too_many_sheets"
    assert len(stored(w.su, w.sid)["ref_sheets"]) == 40


def test_a_merge_over_the_sheets_budget_is_refused_by_name(w):
    """Each list under 196608 bytes, the two together over it: sheets_too_large, never the CHECK's raw 23514."""
    big = lambda pre: [sheet(f"{pre}{i}", views=[view(n, prompt="p" * 1450) for n in ("front", "side", "back")]) for i in range(20)]  # noqa: E731
    put_sheets(w.su, w.sid, [])
    assert as_(w.su, w.alice, SAVE, [w.sid, j(big("a")), j([]), None]).ok
    assert as_(w.su, w.alice, SAVE, [w.sid, j(big("b")), j([]), None]).ok        # 40 sheets, ~191 KB: fits
    third = [sheet("a0", views=[view(n, prompt="q" * 4000) for n in ("front", "side", "back")])]
    assert refused(w.su, w.alice, SAVE, [w.sid, j(third), j(big("a")), None]) == "sheets_too_large"


def test_the_sheets_have_their_own_budget_a_turn_is_measured_alone(w):
    """BR-SW-08's fix, both sides: a turn near 0199's own 262144 still saves with 191 KB of sheets on the row; a turn over it on
    its own is refused by name (brief_too_large, the remedy said), not by the CHECK's raw 23514."""
    full = [sheet(f"c{i}", views=[view(n, prompt="p" * 1450) for n in ("front", "side", "back")]) for i in range(40)]
    assert as_(w.su, w.alice, SAVE, [w.sid, j(full), j([]), None]).ok
    near = {**BASE_BRIEF, "notes": "n" * 250000}
    out = as_(w.su, w.alice, BRIEF, [w.sid, json.dumps(near)])
    assert out.ok, out
    b = stored(w.su, w.sid)
    assert b["notes"] == near["notes"] and len(b["ref_sheets"]) == 40
    over = {**BASE_BRIEF, "notes": "n" * 262144}
    out = as_(w.su, w.alice, BRIEF, [w.sid, json.dumps(over)])
    assert not out.ok and out.sqlstate == "NS400" and "brief_too_large" in out.error, out


def test_a_paid_turn_is_never_left_pending_by_sheets_near_their_cap(w):
    """Atlas on BR-SW-08: sheets at their cap, then a turn whose BRIEF with them is far over 0199's old 262144 (191 KB + 250 KB).
    The turn's own BRIEF fits 0199's 262144, so finish_turn records the call as 'ok', stores the turn, and keeps the sheets: no
    sheets can make a paid turn roll back, so no refusal before the vendor call is needed for them."""
    full = [sheet(f"c{i}", views=[view(n, prompt="p" * 1450) for n in ("front", "side", "back")]) for i in range(40)]
    assert as_(w.su, w.alice, SAVE, [w.sid, j(full), j([]), None]).ok
    become(w.su, None)
    sheets_bytes = w.su.value("select octet_length((brief -> 'ref_sheets')::text) from public.ai_chat_sessions where id = %s", [w.sid])
    assert 180000 < sheets_bytes <= 196608, sheets_bytes
    call = w.su.value("insert into public.ai_chat_calls (org_id, user_id, session_id, model, outcome) "
                      "values (%s, %s, %s, 'anthropic-claude-sonnet-5-5', 'pending') returning id", [w.org, w.alice.uid, w.sid])
    turn = {**BASE_BRIEF, "notes": "n" * 250000}
    assert len(json.dumps(turn)) + sheets_bytes > 262144
    out = as_(w.su, w.alice, "select public.ai_chat_finish_turn(%s, 'ok', 1, 1, 'hi', null, null, 'ready', %s::jsonb, null)",
              [call, json.dumps(turn)])
    assert out.ok, out
    become(w.su, None)
    assert w.su.value("select outcome from public.ai_chat_calls where id = %s", [call]) == "ok"
    b = stored(w.su, w.sid)
    assert b["notes"] == turn["notes"] and len(b["ref_sheets"]) == 40


def test_the_brief_check_counts_the_sheets_apart_and_still_holds_the_turn_to_262144(w):
    become(w.su, None)
    defs = dict(w.su.rows("select conname, pg_get_constraintdef(oid) from pg_constraint "
                          "where conrelid = 'public.ai_chat_sessions'::regclass and contype = 'c'"))
    assert "ai_chat_sessions_brief_check" not in defs
    d = defs["ai_chat_sessions_brief_0249"]
    for part in ("262144", "196608", "8192", "'ref_sheets'", "'film_link'"):
        assert part in d, d


# ── two connections at once ──────────────────────────────────────────────────────

class Committed:
    """A conversation of Alice's that is committed, so two connections can race on its row; removed afterwards."""

    def __init__(self, conn, sc, sheets):
        self.conn, self.alice = conn, sc.alice.actor
        with as_superuser(conn, commit=True) as su:
            self.sid = str(su.value("insert into public.ai_chat_sessions (org_id, created_by, model, step, brief) "
                                    "values (%s, %s, 'anthropic-claude-sonnet-5-5', 'ready', %s::jsonb) returning id",
                                    [sc.alice.org, self.alice.uid, json.dumps({**BASE_BRIEF, "ref_sheets": sheets})]))

    def brief(self):
        with as_superuser(self.conn, commit=False) as su:
            return su.value("select brief from public.ai_chat_sessions where id = %s", [self.sid])

    def purge(self):
        with as_superuser(self.conn, commit=True) as su:
            su.rows("delete from public.ai_chat_sessions where id = %s returning 1", [self.sid])


def _as_alice(c, who):
    c.execute("select set_config('request.jwt.claims', %s, true)", [json.dumps(who.claims())])
    c.execute("select set_config('request.jwt.claim.role', %s, true)", [who.role])
    c.execute(sql.SQL("set local role {}").format(sql.Identifier(who.role)))


def _waiting(conn, pid) -> bool:
    with as_superuser(conn, commit=False) as su:
        return bool(su.value("select exists (select 1 from pg_stat_activity where pid = %s and wait_event_type = 'Lock')", [pid]))


def _race(conn, first_sql, first_params, second_sql, second_params, who):
    """The first call holds the row lock (its transaction left open), the second is started and seen waiting on it, then the first
    commits and the second finishes. Returns the second's error, if any."""
    errors = []
    started = threading.Event()
    pid_box = []
    with psycopg.connect(st._dsn(conn), autocommit=False) as a:
        _as_alice(a, who)
        a.execute(first_sql, first_params).fetchall()

        def second():
            try:
                with psycopg.connect(st._dsn(conn), autocommit=False) as b:
                    pid_box.append(b.info.backend_pid)
                    _as_alice(b, who)
                    started.set()
                    b.execute(second_sql, second_params).fetchall()
                    b.commit()
            except Exception as e:  # noqa: BLE001 - reported to the test below
                errors.append(e)
                started.set()

        t = threading.Thread(target=second)
        t.start()
        started.wait(10)
        deadline = time.time() + 10
        while time.time() < deadline and not (pid_box and _waiting(conn, pid_box[0])):
            time.sleep(0.05)
        assert pid_box and _waiting(conn, pid_box[0]), "the second writer never waited on the first one's row lock"
        a.commit()
        t.join(30)
    return errors


def test_an_approval_and_a_turns_whole_brief_at_the_same_moment_lose_nothing(conn, sc):
    base = [sheet()]
    race = Committed(conn, sc, base)
    try:
        approved = [sheet(views=[view("front", "approved", asset_id=str(uuid.uuid4())), view("side"), view("back")])]
        # The turn route read the sheets BEFORE the approval and carries that copy (carrySheets), exactly the lost-update case.
        stale_turn = {**BASE_BRIEF, "title": "Turned", "ref_sheets": base}
        errors = _race(conn, SAVE, [race.sid, j(approved), j(base), None], BRIEF, [race.sid, json.dumps(stale_turn)], race.alice)
        assert not errors, errors
        b = race.brief()
        assert b["title"] == "Turned"
        assert front(b)["front"]["status"] == "approved"
    finally:
        race.purge()


def test_a_turns_whole_brief_first_and_the_approval_after_lose_nothing(conn, sc):
    base = [sheet()]
    race = Committed(conn, sc, base)
    try:
        approved = [sheet(views=[view("front", "approved", asset_id=str(uuid.uuid4())), view("side"), view("back")])]
        stale_turn = {**BASE_BRIEF, "title": "Turned", "ref_sheets": []}
        errors = _race(conn, BRIEF, [race.sid, json.dumps(stale_turn)], SAVE, [race.sid, j(approved), j(base), None], race.alice)
        assert not errors, errors
        b = race.brief()
        assert b["title"] == "Turned"
        assert front(b)["front"]["status"] == "approved"
    finally:
        race.purge()


def test_two_tabs_saving_different_views_at_once_keep_both(conn, sc):
    base = [sheet()]
    race = Committed(conn, sc, base)
    try:
        tab1 = [sheet(views=[view("front", "approved", asset_id=str(uuid.uuid4())), view("side"), view("back")])]
        job = str(uuid.uuid4())
        tab2 = [sheet(views=[view("front"), view("side", "making", job_id=job, key=key(7)), view("back")])]
        errors = _race(conn, SAVE, [race.sid, j(tab1), j(base), None], SAVE, [race.sid, j(tab2), j(base), None], race.alice)
        assert not errors, errors
        v = front(race.brief())
        assert v["front"]["status"] == "approved"
        assert v["side"]["job_id"] == job and v["side"]["status"] == "making"
    finally:
        race.purge()


# ── the file itself: guard, replay, rollback ─────────────────────────────────────

def _rollback_body() -> str:
    text = ROLLBACK.read_text(encoding="utf-8")
    return "\n".join(ln for ln in text.splitlines() if ln.strip() not in ("begin;", "commit;"))


def md5_of(conn, sig):
    return conn.execute("select md5(regexp_replace(prosrc, '[[:space:]]+', ' ', 'g')) from pg_proc where oid = to_regprocedure(%s)",
                        [sig]).fetchone()[0]


def test_the_guard_is_the_live_body(conn):
    for sig, want in writer.GUARD:
        assert md5_of(conn, sig) == want, sig
    assert sec_db.has_0249(conn)


def test_the_guard_refuses_a_changed_save_brief(conn):
    with psycopg.connect(st._dsn(conn), autocommit=False) as c:
        c.execute(_rollback_body())
        src = c.execute("select prosrc from pg_proc where oid = to_regprocedure('public.ai_chat_save_brief(uuid, jsonb, text)')").fetchone()[0]
        changed = src.replace("card = null,", "card = null, slots = slots,")
        assert changed != src
        c.execute(sql.SQL("create or replace function public.ai_chat_save_brief(p_session uuid, p_brief jsonb, p_step text) returns void "
                          "language plpgsql volatile security definer set search_path = public, pg_temp as {}").format(sql.Literal(changed)))
        with pytest.raises(psycopg.Error) as e:
            c.execute(MIGRATION.read_text(encoding="utf-8"))
        assert "0249 found public.ai_chat_save_brief with an unknown body" in str(e.value)
        c.rollback()


def test_the_file_replays_onto_itself(conn):
    with psycopg.connect(st._dsn(conn), autocommit=False) as c:
        c.execute(MIGRATION.read_text(encoding="utf-8"))
        c.execute(MIGRATION.read_text(encoding="utf-8"))
        n = c.execute("select count(*) from pg_trigger where tgrelid = 'public.ai_chat_sessions'::regclass "
                      "and tgname = 'ai_chat_sessions_keep_sheets'").fetchone()[0]
        assert n == 1
        c.rollback()


def test_rerunning_0199_leaves_the_writer_and_the_trigger_on(conn):
    with psycopg.connect(st._dsn(conn), autocommit=False) as c:
        c.execute((sec_db.MIGRATIONS / "0199_studio_ai_chat.sql").read_text(encoding="utf-8"))
        assert sec_db.has_0249(c)
        assert c.execute("select count(*) from pg_trigger where tgname = 'ai_chat_sessions_keep_sheets'").fetchone()[0] == 1
        c.rollback()


def test_the_rollback_removes_it_keeps_the_stored_sheets_and_0199_writes_as_before(conn, sc):
    with psycopg.connect(st._dsn(conn), autocommit=False) as c:
        sid = sc.alice.ai_chat_session
        c.execute("select set_config('nightshift.ai_chat_sheets', %s, true)", [sid])
        c.execute("update public.ai_chat_sessions set step = 'ready', brief = %s::jsonb where id = %s",
                  [json.dumps({**BASE_BRIEF, "ref_sheets": [sheet()]}), sid])
        c.execute("select set_config('nightshift.ai_chat_sheets', '', true)")
        c.execute(_rollback_body())
        assert not sec_db.has_0249(c)
        assert c.execute("select count(*) from pg_trigger where tgname = 'ai_chat_sessions_keep_sheets'").fetchone()[0] == 0
        assert c.execute("select to_regprocedure('public.ai_chat_sheet_problem(jsonb)') is null").fetchone()[0]
        assert c.execute("select to_regprocedure('public.ai_chat_sheet_repair(jsonb)') is null").fetchone()[0]
        assert c.execute("select pg_get_constraintdef(oid) from pg_constraint where conrelid = 'public.ai_chat_sessions'::regclass "
                         "and conname = 'ai_chat_sessions_brief_check'").fetchone()[0] == \
            "CHECK (((jsonb_typeof(brief) = 'object'::text) AND (octet_length((brief)::text) <= 262144)))"
        assert c.execute("select brief -> 'ref_sheets' from public.ai_chat_sessions where id = %s", [sid]).fetchone()[0] == [sheet()]
        # 0199's whole-BRIEF write is the only writer again: a BRIEF without sheets drops them (the race 0249 closed reopens).
        _as_alice(c, sc.alice.actor)
        c.execute(BRIEF, [sid, json.dumps(BASE_BRIEF)])
        c.execute("reset role")
        assert c.execute("select brief ? 'ref_sheets' from public.ai_chat_sessions where id = %s", [sid]).fetchone()[0] is False
        # And it applies again on top.
        c.execute(MIGRATION.read_text(encoding="utf-8"))
        assert sec_db.has_0249(c)
        c.rollback()


def test_the_rollback_refuses_by_name_while_a_conversation_holds_more_than_0199s_check_and_changes_nothing(conn, sc):
    with psycopg.connect(st._dsn(conn), autocommit=False) as c:
        sid = sc.alice.ai_chat_session
        full = [sheet(f"c{i}", views=[view(n, prompt="p" * 1450) for n in ("front", "side", "back")]) for i in range(40)]
        c.execute("select set_config('nightshift.ai_chat_sheets', %s, true)", [sid])
        c.execute("update public.ai_chat_sessions set brief = %s::jsonb where id = %s",
                  [json.dumps({**BASE_BRIEF, "notes": "n" * 100000, "ref_sheets": full}), sid])
        c.execute("select set_config('nightshift.ai_chat_sheets', '', true)")
        c.execute("savepoint rb")
        with pytest.raises(psycopg.Error) as e:
            c.execute(_rollback_body())
        assert "rollback 0249: 1 conversation(s) hold more than 262144 bytes" in str(e.value)
        c.execute("rollback to savepoint rb")
        assert sec_db.has_0249(c)
        c.rollback()


def test_the_guard_refuses_a_hand_changed_brief_check(conn):
    with psycopg.connect(st._dsn(conn), autocommit=False) as c:
        c.execute(_rollback_body())
        c.execute("alter table public.ai_chat_sessions drop constraint ai_chat_sessions_brief_check")
        c.execute("alter table public.ai_chat_sessions add constraint ai_chat_sessions_brief_check "
                  "check (jsonb_typeof(brief) = 'object' and octet_length(brief::text) <= 999999)")
        with pytest.raises(psycopg.Error) as e:
            c.execute(MIGRATION.read_text(encoding="utf-8"))
        assert "ai_chat_sessions_brief_check with an unknown definition" in str(e.value)
        c.rollback()


def test_neither_the_file_nor_its_rollback_holds_a_backslash():
    for path in (MIGRATION, ROLLBACK):
        assert "\\" not in path.read_text(encoding="utf-8"), path.name


def test_the_files_fold_reads_the_body_as_the_shorthand_does(conn):
    for sig, _ in writer.GUARD:
        a = conn.execute("select md5(regexp_replace(prosrc, '[[:space:]]+', ' ', 'g')), md5(regexp_replace(prosrc, '\\s+', ' ', 'g')) "
                         "from pg_proc where oid = to_regprocedure(%s)", [sig]).fetchone()
        assert a[0] == a[1], sig

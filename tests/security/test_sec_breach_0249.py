"""Breach, second round on 0249 (ai_chat_save_sheets, the keep-sheets trigger, finish_turn's brief_too_large hunk).

BRK-01 .. BRK-06. Each test is an attack an author, a stranger or a signed-out caller can make, pinned as the behaviour that must
hold. A test here that fails is an open hole and stays failing (never skipped) until it is fixed:

* BRK-02 FAILS on 06990be0f: sheets of an earlier plan are kept forever (the writer never drops a stored sheet, the trigger keeps
  them from every other writer), so a conversation re-planned with another cast passes 40 sheets and every later sheets save is
  refused as too_many_sheets, with no path in the API that can ever clear the stale ones.

Everything else held when this file was written and is kept as a regression pin.
"""

from __future__ import annotations

import json
import shutil
import subprocess
import uuid

import pytest

import sec_db
from sec_db import as_superuser
from test_sec_sheets_writer_0249 import (BASE_BRIEF, BRIEF, SAVE, Committed, _race, as_, become, front, j,
                                         refused, sheet, stored, view, w)  # noqa: F401 - w is the fixture

FINISH = "select public.ai_chat_finish_turn(%s, %s, %s, %s, 'hi', null, '{}'::jsonb, 'ready', %s::jsonb, null)"
LIMIT = 262144
BRIEF_SIZE_TS = sec_db.REPO / "command-center" / "lib" / "brain" / "brief-size.ts"

# Node script: a JSON list of BRIEFs on stdin, briefBytes of each on stdout (one per line). brief-size.ts imports nothing, so
# node's type stripping loads it as it is: the app's own function is measured, not a Python copy of it.
NODE_SCRIPT = """
const m = await import(process.argv[2]);
process.stdin.setEncoding("utf8");  // a Buffer chunk cut inside a character would read as U+FFFD
let s = "";
for await (const c of process.stdin) s += c;
for (const b of JSON.parse(s)) console.log(m.briefBytes(b));
"""


def _new_call(su, org, uid, sid):
    return su.value("insert into public.ai_chat_calls (org_id, user_id, session_id, model, outcome) "
                    "values (%s, %s, %s, 'anthropic-claude-sonnet-5-5', 'pending') returning id", [org, uid, sid])


def _db_bytes(su, brief) -> int:
    become(su, None)
    return su.value("select octet_length((%s::jsonb - 'ref_sheets' - 'film_link')::text)", [json.dumps(brief, ensure_ascii=False)])


def _ts_bytes(tmp_path, briefs) -> list[int]:
    node = shutil.which("node")
    assert node, "node is needed to measure the app's briefBytes (command-center/lib/brain/brief-size.ts)"
    script = tmp_path / "brief_bytes.mjs"
    script.write_text(NODE_SCRIPT, encoding="utf-8")
    out = subprocess.run([node, "--experimental-strip-types", "--no-warnings", str(script), str(BRIEF_SIZE_TS)],
                         input=json.dumps(briefs, ensure_ascii=False), capture_output=True, text=True, timeout=60, check=False)
    assert out.returncode == 0, out.stderr
    return [int(x) for x in out.stdout.split()]


# ── BRK-01: the app's measure and the database's agree on a mostly multibyte 263 KB BRIEF ─────────────────────────────────────

MIXES = {
    # 2-byte UTF-8 (the owner's Russian and Uzbek Cyrillic)
    "cyrillic": "Жизнь Ўзбекистон ",
    # 3-byte UTF-8
    "cjk": "物語の始まり ",
    # 4-byte UTF-8, two UTF-16 units in JS: the case a .length count would get wrong
    "emoji": "🎬🌙✨🐉 ",
    # escapes both sides must spell the same way: quote, backslash, newline, tab, a C0 control, U+2028/2029 (JSON.stringify does
    # not escape them, and neither does jsonb), a combining mark and a ZWJ sequence
    "escapes": 'он сказал "да"\\ \n\t\u0001    é 👩‍👩‍👧 ',
}


def _brief_of_db_size(su, mix: str, target: int, extra=None) -> dict:
    """A BRIEF whose own part (sheets and link taken out) is exactly `target` bytes as the database measures it, mostly `mix`."""
    b = {**BASE_BRIEF, **(extra or {}), "notes": ""}
    unit = MIXES[mix]
    per = _db_bytes(su, {"x": unit}) - _db_bytes(su, {"x": ""})
    b["notes"] = unit * ((target - _db_bytes(su, b)) // per)
    gap = target - _db_bytes(su, b)
    assert 0 <= gap < per + 8, gap
    b["notes"] += "x" * gap
    assert _db_bytes(su, b) == target
    return b


@pytest.mark.parametrize("mix", sorted(MIXES))
def test_brk_01_brief_bytes_agrees_with_jsonb_on_a_multibyte_brief_at_the_limit(w, tmp_path, mix):
    """The turn route ends a turn as brief_too_large on briefBytes > 262144, and 0249's finish_turn on octet_length(jsonb::text) >
    262144. If they disagree, either the route refuses a turn the database would have stored, or it sends 'ok' for one the database
    then silently ends as brief_too_large while the route answers the reply as stored (rule 5: a turn shown that is not there). At
    exactly 262144 and 262145 bytes, mostly multibyte, with the sheets and link along (counted apart), both must say the same."""
    sheets = [sheet()]
    link = {"film_id": str(uuid.uuid4()), "scenes": []}
    briefs = [_brief_of_db_size(w.su, mix, t) for t in (LIMIT, LIMIT + 1)]
    # The real route sends the stored sheets and link along (carried); neither side may count them.
    briefs = [{**b, "ref_sheets": sheets, "film_link": link} for b in briefs]
    db = [_db_bytes(w.su, b) for b in briefs]
    ts = _ts_bytes(tmp_path, briefs)
    assert db == [LIMIT, LIMIT + 1]
    assert ts == db, f"{mix}: briefBytes {ts} vs octet_length(jsonb::text) {db}"
    # And finish_turn decides on the same side of the line as the route: 'ok' stored at 262144, brief_too_large at 262145.
    for b, expect in zip(briefs, ("ok", "brief_too_large")):
        become(w.su, None)
        call = _new_call(w.su, w.org, w.alice.uid, w.sid)
        out = as_(w.su, w.alice, FINISH, [call, "ok", 10, 20, json.dumps(b, ensure_ascii=False)])
        assert out.ok, out
        become(w.su, None)
        assert w.su.value("select outcome from public.ai_chat_calls where id = %s", [call]) == expect, (mix, len(json.dumps(b)))


# ── BRK-02: a re-planned conversation's stale sheets block every later save, and nothing can clear them ────────────────────────

def test_brk_02_sheets_of_an_earlier_plan_never_lock_the_conversation_out_of_saving_its_current_plan(w):
    """FAILS on 06990be0f (open hole, Medium: an author's own conversation loses its character sheets for good).

    Character ids and stage ids come from the model (logic.ts readCharacters: sid(o.id, ...)), so a person who asks for another
    proposal and chooses it gets a new cast with new keys. The app sends only the CURRENT plan's sheets (mergeSheets keeps plan
    keys only, at most 40). 0249 keeps every stored sheet the caller did not send, and its trigger keeps them from save_brief and
    finish_turn. Plan one saved 30 sheets; plan two has 15: the merge is 45 and is refused as too_many_sheets, and the same for
    every later save (phase 1 of makeSheets included: no picture can ever be made in this conversation again). There is no call in
    the API that removes a stored sheet, so there is no remedy the person can act on but to abandon the conversation."""
    plan1 = [sheet(f"p1_{i}") for i in range(30)]
    assert as_(w.su, w.alice, SAVE, [w.sid, j(plan1), j([]), None]).ok
    # Re-proposed and chosen again: the plan step is 'ready' once more with a new cast.
    plan2 = [sheet(f"p2_{i}") for i in range(15)]
    # Whatever a whole-BRIEF writer says, the old ones stay (that is the trigger's job, and it holds):
    assert as_(w.su, w.alice, BRIEF, [w.sid, json.dumps({**BASE_BRIEF, "ref_sheets": plan2})]).ok
    assert len(stored(w.su, w.sid)["ref_sheets"]) == 31
    # The sheets route's save of the current plan (the list as the app sends it, its base the plan as it read it):
    code = refused(w.su, w.alice, SAVE, [w.sid, j(plan2), j(plan2), None])
    assert code is None, (
        f"the current plan's 15 sheets are refused ({code}) because 31 stale sheets of an earlier plan are kept and nothing can "
        "remove them: the conversation can never save or make a character sheet again")


# ── BRK-03: the brief_too_large path cannot be used on someone else's call, signed out, twice, or to make a turn free ─────────

def test_brk_03_another_person_cannot_end_my_paid_call_as_brief_too_large(w):
    become(w.su, None)
    call = _new_call(w.su, w.org, w.alice.uid, w.sid)
    assert refused(w.su, w.bob, FINISH, [call, "brief_too_large", 0, 0, None]) == "call_not_found"
    assert refused(w.su, w.colleague, FINISH, [call, "brief_too_large", 0, 0, None]) == "call_not_found"
    out = as_(w.su, None, FINISH, [call, "brief_too_large", 0, 0, None])
    assert not out.ok
    become(w.su, None)
    assert w.su.value("select outcome from public.ai_chat_calls where id = %s", [call]) == "pending"


def test_brk_03_a_call_ended_as_brief_too_large_is_counted_like_a_paid_turn(w):
    """A direct RPC could otherwise end the author's own call by name to have it forgiven: brief_too_large is counted by
    ai_chat_used (0199 forgives only not_sent, not_configured, vendor_refused and refused)."""
    become(w.su, None)
    used0 = w.su.value("select public.ai_chat_used(%s)", [w.org])
    call = _new_call(w.su, w.org, w.alice.uid, w.sid)
    assert as_(w.su, w.alice, FINISH, [call, "brief_too_large", None, None, None]).ok
    become(w.su, None)
    assert w.su.value("select public.ai_chat_used(%s)", [w.org]) == used0 + 1
    # Unknown tokens stay unknown (rule 5), never 0.
    assert w.su.rows("select tokens_in, tokens_out from public.ai_chat_calls where id = %s", [call])[0] == (None, None)


def test_brk_03_two_finishes_of_one_call_at_once_end_it_once(conn, sc):
    """The route's brief_too_large and a direct 'refused' (the one outcome a member would want: forgiven) racing on one call: the
    second waits on the call's row lock, then reads it finished and is refused; the call stays brief_too_large."""
    race = Committed(conn, sc, [sheet()])
    try:
        with as_superuser(conn, commit=True) as su:
            call = str(_new_call(su, sc.alice.org, race.alice.uid, race.sid))
        errors = _race(conn, FINISH, [call, "brief_too_large", 5, 6, None], FINISH, [call, "refused", None, None, None], race.alice)
        assert len(errors) == 1 and "call_not_found" in str(errors[0]), errors
        with as_superuser(conn, commit=False) as su:
            assert su.rows("select outcome, tokens_in, tokens_out from public.ai_chat_calls where id = %s", [call])[0] == \
                ("brief_too_large", 5, 6)
    finally:
        with as_superuser(conn, commit=True) as su:
            su.rows("delete from public.ai_chat_calls where session_id = %s returning 1", [race.sid])
        race.purge()


# ── BRK-04: a chat turn's finish racing a sheets write, both orders: no deadlock, nothing lost ─────────────────────────────────

@pytest.mark.parametrize("first", ["sheets", "turn"])
def test_brk_04_finish_turn_and_save_sheets_at_once_keep_the_approval_and_the_turn(conn, sc, first):
    base = [sheet()]
    race = Committed(conn, sc, base)
    try:
        with as_superuser(conn, commit=True) as su:
            call = str(_new_call(su, sc.alice.org, race.alice.uid, race.sid))
        asset = str(uuid.uuid4())
        approved = [sheet(views=[view("front", "approved", asset_id=asset), view("side"), view("back")])]
        # The turn carries the copy it read before the approval (the lost-update case), and its own new key.
        turn = {**BASE_BRIEF, "title": "After", "ref_sheets": base}
        s = (SAVE, [race.sid, j(approved), j(base), None])
        t = (FINISH, [call, "ok", 1, 1, json.dumps(turn)])
        a, b = (s, t) if first == "sheets" else (t, s)
        errors = _race(conn, a[0], a[1], b[0], b[1], race.alice)
        assert not errors, errors
        got = race.brief()
        assert got["title"] == "After"
        assert front(got)["front"]["status"] == "approved" and front(got)["front"]["asset_id"] == asset
        with as_superuser(conn, commit=False) as su:
            assert su.value("select outcome from public.ai_chat_calls where id = %s", [call]) == "ok"
    finally:
        with as_superuser(conn, commit=True) as su:
            su.rows("delete from public.ai_chat_calls where session_id = %s returning 1", [race.sid])
        race.purge()


# ── BRK-05: the internal helpers are not reachable from an API role ────────────────────────────────────────────────────────────

@pytest.mark.parametrize("fn", ["ai_chat_sheet_repair", "ai_chat_sheet_problem"])
def test_brk_05_the_sheet_helpers_are_not_callable_by_a_member_or_anon(w, fn):
    q = f"select public.{fn}(%s::jsonb)"
    out = as_(w.su, w.alice, q, [json.dumps(sheet())])
    assert not out.ok and out.sqlstate == "42501", (fn, out)
    become(w.su, None)
    w.su.conn.execute("set local role anon")
    out = w.su.run(q, [json.dumps(sheet())])
    become(w.su, None)
    assert not out.ok and out.sqlstate == "42501", (fn, out)

def test_brk_05_a_hostile_stored_list_cannot_break_the_writer(w):
    """A list written through 0199 before 0249 (or by hand) with numbers jsonb can hold but an integer cannot (1e400 attempts,
    fractional, negative), statuses of the wrong type and a views list of 50: the writer repairs it as readSheets does and writes,
    never a raw 22003 that would lock the author out of their sheets."""
    hostile = [{"character_id": "c1", "stage": None, "views": [
        {"view": "front", "prompt": "p", "status": 7, "attempt": 1e400, "asset_id": "nope", "job_id": 5, "error": "BAD", "key": "k"},
        {"view": "side", "prompt": "p", "status": "approved", "attempt": -3.5},
        *[{"view": "back", "prompt": "p", "status": "planned", "attempt": 10 ** 30} for _ in range(50)]]}]
    become(w.su, None)
    w.su.conn.execute("select set_config('nightshift.ai_chat_sheets', %s, true)", [str(w.sid)])
    # 1e400 as jsonb text (json.dumps cannot write it).
    w.su.rows("update public.ai_chat_sessions set brief = jsonb_set(brief, '{ref_sheets}', "
              "replace(%s, '\"__BIG__\"', '1e400')::jsonb) where id = %s returning 1",
              [json.dumps(hostile).replace("Infinity", '"__BIG__"'), w.sid])
    w.su.conn.execute("select set_config('nightshift.ai_chat_sheets', '', true)")
    # Only the front is sent: the stored side (approved, its attempt unreadable) is kept as readSheets would read it.
    mine = [sheet(views=[view("front", "ready", attempt=2)])]
    out = as_(w.su, w.alice, SAVE, [w.sid, j(mine), j([]), None])
    assert out.ok, out
    v = front(stored(w.su, w.sid))
    assert v["front"]["status"] == "ready" and v["front"]["attempt"] == 2
    assert v["side"]["status"] == "approved"


# ── BRK-06: a viewer of the workspace (or a removed author) cannot use the writer, and the answer never shows another's sheets ──

def test_brk_06_an_author_demoted_to_viewer_writes_nothing_and_reads_nothing_back(w):
    become(w.su, None)
    w.su.rows("update public.org_members set role = 'viewer' where org_id = %s and user_id = %s returning 1", [w.org, w.alice.uid])
    forged = [sheet(views=[view("front", "approved", asset_id=str(uuid.uuid4())), view("side"), view("back")])]
    assert refused(w.su, w.alice, SAVE, [w.sid, j(forged), j([]), None]) == "session_not_found"
    assert stored(w.su, w.sid)["ref_sheets"] == w.sheets

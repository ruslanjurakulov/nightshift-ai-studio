"""Named attacks on an export in another frame (migration 0129).

request_editor_export's three-argument overload lets a member ask for the saved revision in ONE frame of a closed list, so one edit
can be exported 16:9, 9:16, 1:1 and 4:5 without a copy of the project. What must hold:

  * the frame is an id of the database's own list (schemas/export_presets.json) and nothing else: null, a size typed as text, a padded
    or upper-case id, a pattern, SQL, a number, JSON are ONE refusal (invalid_frame) and write no row; width and height on the row are
    the list's, never the caller's;
  * the table cannot hold an odd, zero, negative or oversized frame, or only part of one, even by the owner's hand;
  * every gate of 0054 still stands with a frame: another organization's project reads as missing (whether or not the frame is a real
    one, so the list is looked at only after membership), a stranger and the anon key get nothing, a stale revision, a deleted file, a
    too-long document are refused with 0054's words, and no credit is touched;
  * a member's role decides exactly what it decided before: whoever may ask for a plain export may ask for a frame, nobody else;
  * EACH frame is one export against the organization's limits: three waiting or rendering, twenty a day; the same frame of the same
    project twice is refused; the two-argument function is unchanged and still refuses while anything of the project is in flight;
  * nobody but the function writes the frame columns, and the worker's claim hands them over as they were written;
  * the file adds an overload and replaces nothing, applies twice, refuses a body it has not seen, and its rollback takes it out
    (refusing while an export in flight carries a frame) and can be followed by the migration again.

0132 (1440p and 4K, sold by the minute) builds on this file: it replaces the list with nine formats and adds a fourth overload. The
tests that replay 0129 or apply its rollback take 0132 off first (sec_db.take_off_0132, inside their own rolled-back transaction); the
race database is built without it. The paid frames are tested in test_sec_editor_hires_export.py.

Every flow runs in one transaction that is rolled back, switching between the member's session and the worker's (service role) the way
PostgREST would serve each of them.
"""

from __future__ import annotations

import json
import os
import re
import threading
import time
import uuid

import psycopg
import pytest

import sec_db
from sec_db import ANON, SERVICE, acting, as_superuser
from sec_editor_0054 import PROJECT, VIDEO, doc
from sec_scenario import seat_invitee
from test_sec_upload_folder import back_to_owner, become

MIGRATION = sec_db.MIGRATIONS / "0129_editor_export_frame.sql"
ROLLBACK = sec_db.REPO / "docs" / "sql" / "rollback_0129_editor_export_frame.sql"
PRESETS = json.loads((sec_db.REPO / "schemas" / "export_presets.json").read_text(encoding="utf-8"))["presets"]
FREE = [p for p in PRESETS if p["width"] * p["height"] <= 1920 * 1080]
REQ2_SIG = "public.request_editor_export(uuid, integer)"
REQ3_SIG = "public.request_editor_export(uuid, integer, text)"
LIST_SIG = "public.editor_export_frame(text)"
REQ2 = "select public.request_editor_export(%s, %s)"
REQ3 = "select public.request_editor_export(%s, %s, %s)"
SAVE = "select public.save_editor_project(%s, %s, %s, %s::jsonb)"
CREATE = "select public.create_editor_project(%s, %s, %s::jsonb)"
CLAIM = "select id::text, frame_preset, frame_width, frame_height from public.claim_editor_export(%s)"
BEFORE_HASH = "6d37b4d75092708981c28a56879c89b4"
FRAME_ROW = "select frame_preset, frame_width, frame_height from public.editor_exports where id = %s"


def refused(out, sqlstate: str, word: str | None = None) -> bool:
    return (not out.ok) and out.sqlstate == sqlstate and (word is None or word in (out.error or ""))


def clear(s, org: str) -> None:
    """As the owner: nothing of this organization is waiting or was asked today, so each test counts from zero."""
    back_to_owner(s)
    s.conn.execute("delete from public.editor_exports where org_id = %s", [org])


def exports_of(s, org: str) -> int:
    back_to_owner(s)
    return s.value("select count(*) from public.editor_exports where org_id = %s", [org])


def in_flight(s, org: str) -> list:
    back_to_owner(s)
    # Sorted: every row of one transaction has the same created_at, so the order they were asked in is not recorded.
    return sorted(r[0] for r in s.rows("select coalesce(frame_preset, '-') from public.editor_exports "
                                       "where org_id = %s and status in ('queued', 'rendering')", [org]))


# ── asking for a frame ──────────────────────────────────────────────────────

def test_a_member_exports_the_saved_revision_in_a_frame_of_the_list(conn, sc):
    with as_superuser(conn, commit=False) as s:
        clear(s, sc.bob.org)
        become(s, sc.bob.actor)
        eid = s.value(REQ3, [PROJECT["b"], 1, "vertical_1080p"])
        back_to_owner(s)
        row = s.rows("select org_id::text, project_id::text, rev, status, requested_by::text, frame_preset, frame_width, frame_height, "
                     "doc = (select doc from public.editor_projects where id = %s), duration_s::float "
                     "from public.editor_exports where id = %s", [PROJECT["b"], eid])
    assert row == [(sc.bob.org, PROJECT["b"], 1, "queued", sc.bob.actor.uid, "vertical_1080p", 1080, 1920, True, 6.0)], row


def test_every_format_of_the_presets_file_is_accepted_with_exactly_its_size(conn, sc):
    # The five free formats; the four paid ones after them (0132) cannot be queued through this overload (0132 refuses them), see below.
    assert [p["id"] for p in FREE] == ["youtube_1080p", "youtube_720p", "vertical_1080p", "square_1080", "feed_4x5_1080"]
    with as_superuser(conn, commit=False) as s:
        for p in FREE:
            clear(s, sc.bob.org)
            become(s, sc.bob.actor)
            eid = s.value(REQ3, [PROJECT["b"], 1, p["id"]])
            back_to_owner(s)
            assert s.rows(FRAME_ROW, [eid]) == [(p["id"], p["width"], p["height"])], p
        # The list answers for the file's formats and nothing else, in the file's order.
        listed = s.rows("select f.id, f.width, f.height from unnest(%s::text[]) with ordinality as i(id, n), "
                        "public.editor_export_frame(i.id) f order by i.n", [[p["id"] for p in PRESETS]])
        # A paid frame through THIS overload: 0132's body refuses it as hires_needs_paid_export (and its CHECK would refuse a row without a
        # quote), and nothing is written.
        paid = []
        for p in PRESETS[5:]:
            clear(s, sc.bob.org)
            become(s, sc.bob.actor)
            paid.append(s.run(REQ3, [PROJECT["b"], 1, p["id"]]))
            paid[-1] = (paid[-1], exports_of(s, sc.bob.org))
    assert listed == [(p["id"], p["width"], p["height"]) for p in PRESETS]
    for out, written in paid:
        assert refused(out, "NS400", "hires_needs_paid_export") and written == 0, out


BAD_FRAMES = [
    None, "", " ", "project", "vertical_4k", "vertical", "1080p", "vertical_1080", "vertical_1080pp",
    " vertical_1080p", "vertical_1080p ", "vertical_1080p\n", "\tvertical_1080p", "VERTICAL_1080P", "Vertical_1080p",
    "1080x1920", "1080X1920", "1080×1920", "1080:1920", "9:16", "16:9", "1080", "1920", "0", "-1", "0x0", "-1080x-1920",
    "1081x1921", "8192x8192", "99999x99999", "4096x4096", "1e9x1e9", "NaN", "Infinity",
    "vertical_1080p'; drop table public.editor_exports; --", "' or '1'='1", "vertical_1080p' or ''='", "$$; select 1; $$",
    "vertical_1080p%", "%", "_", "*", ".*", "vertical_%", "v%", "vertical_1080p,square_1080", "youtube_1080p|vertical_1080p",
    '{"width": 8192, "height": 8192}', '["vertical_1080p"]', '"vertical_1080p"', "null", "true",
    "vertіcal_1080p",          # a Cyrillic i
    "vertical_1080p​",    # a zero-width space after it
    "ｖertical_1080p",         # a full-width v
    "x" * 10000,
]


@pytest.mark.parametrize("bad", BAD_FRAMES, ids=[repr(b)[:40] for b in BAD_FRAMES])
def test_a_frame_that_is_not_an_id_of_the_list_is_one_refusal_and_writes_nothing(conn, sc, bad):
    with as_superuser(conn, commit=False) as s:
        clear(s, sc.bob.org)
        become(s, sc.bob.actor)
        out = s.run(REQ3, [PROJECT["b"], 1, bad])
        written = exports_of(s, sc.bob.org)
        still_there = s.value("select to_regclass('public.editor_exports') is not null")
    assert refused(out, "NS400", "invalid_frame"), (bad, out)
    assert written == 0 and still_there


@pytest.mark.parametrize("sql_literal", ["1080", "1920.0", "true", "'{\"w\": 1}'::jsonb", "array['vertical_1080p']", "row(1080, 1920)",
                                         "'vertical_1080p'::bytea", "point(1080, 1920)"])
def test_a_frame_that_is_not_text_does_not_reach_the_function(conn, sc, sql_literal):
    with as_superuser(conn, commit=False) as s:
        clear(s, sc.bob.org)
        become(s, sc.bob.actor)
        out = s.run(f"select public.request_editor_export(%s, 1, {sql_literal})", [PROJECT["b"]])
        written = exports_of(s, sc.bob.org)
    assert (not out.ok) and out.sqlstate in ("42883", "42725", "42846", "22P02"), (sql_literal, out)
    assert written == 0


def test_there_is_no_way_to_pass_a_size(conn, sc):
    """No overload takes a width or a height, by position or by name (PostgREST calls by name)."""
    with as_superuser(conn, commit=False) as s:
        clear(s, sc.bob.org)
        args = [r[0] for r in s.rows("select pg_get_function_identity_arguments(p.oid) from pg_proc p "
                                     "where p.proname = 'request_editor_export' and p.pronamespace = 'public'::regnamespace order by 1")]
        become(s, sc.bob.actor)
        outs = [s.run("select public.request_editor_export(%s, 1, 'vertical_1080p', 8192, 8192)", [PROJECT["b"]]),
                s.run("select public.request_editor_export(p_project => %s, p_rev => 1, p_frame => 'vertical_1080p', p_width => 8192)", [PROJECT["b"]]),
                s.run("select public.request_editor_export(p_project => %s, p_rev => 1, p_width => 8192, p_height => 8192)", [PROJECT["b"]])]
        written = exports_of(s, sc.bob.org)
    # 0132's paid overload takes a number of credits the person confirmed, never a size.
    assert args == ["p_project uuid, p_rev integer", "p_project uuid, p_rev integer, p_frame text",
                    "p_project uuid, p_rev integer, p_frame text, p_max_credits numeric"]
    for out in outs:
        assert refused(out, "42883"), out
    assert written == 0


# ── the table itself ────────────────────────────────────────────────────────

BAD_ROWS = [
    ("vertical_1080p", 1081, 1920), ("vertical_1080p", 1080, 1921), ("vertical_1080p", 0, 0), ("vertical_1080p", -1080, -1920),
    ("vertical_1080p", 14, 14), ("vertical_1080p", 4098, 1080), ("vertical_1080p", 1080, 4098), ("vertical_1080p", 4096, 4096),
    ("vertical_1080p", 2562, 1440), ("vertical_1080p", 8192, 8192), ("vertical_1080p", 2147483646, 2),
    ("vertical_1080p", None, 1920), ("vertical_1080p", 1080, None), ("vertical_1080p", None, None), (None, 1080, 1920),
    (None, 1080, None), (None, None, 1920), ("Vertical", 1080, 1920), ("vertical 1080p", 1080, 1920), ("", 1080, 1920),
    ("x" * 33, 1080, 1920),
]


@pytest.mark.parametrize("bad", BAD_ROWS, ids=[repr(b)[:48] for b in BAD_ROWS])
def test_the_table_cannot_hold_a_frame_outside_the_limits_or_half_of_one(conn, sc, bad):
    with as_superuser(conn, commit=False) as s:
        clear(s, sc.bob.org)
        become(s, sc.bob.actor)
        eid = s.value(REQ3, [PROJECT["b"], 1, "square_1080"])
        back_to_owner(s)      # the OWNER's hand: no API role can write the table at all (below)
        out = s.run("update public.editor_exports set frame_preset = %s, frame_width = %s, frame_height = %s where id = %s", [*bad, eid])
        row = s.rows(FRAME_ROW, [eid])
    assert (not out.ok) and out.sqlstate in ("23514", "22003"), (bad, out)
    assert row == [("square_1080", 1080, 1080)]


def test_the_largest_frame_the_table_takes_is_1440p(conn, sc):
    """0129 stopped a frame at 2560x1440. Since 0132 a row WITHOUT a quote stops at 1080p pixels, and one with a quote at 4K."""
    with as_superuser(conn, commit=False) as s:
        clear(s, sc.bob.org)
        become(s, sc.bob.actor)
        eid = s.value(REQ3, [PROJECT["b"], 1, "square_1080"])
        back_to_owner(s)
        free_top = s.run("update public.editor_exports set frame_width = 1080, frame_height = 1920 where id = %s", [eid])
        unpaid = s.run("update public.editor_exports set frame_width = 2560, frame_height = 1440 where id = %s", [eid])
        low = s.run("update public.editor_exports set frame_width = 16, frame_height = 16 where id = %s", [eid])
        paid = s.run("update public.editor_exports set frame_width = 3840, frame_height = 2160, quoted_credits = 1 where id = %s", [eid])
        over = s.run("update public.editor_exports set frame_width = 3840, frame_height = 2162, quoted_credits = 1 where id = %s", [eid])
    assert free_top.ok and low.ok and paid.ok, (free_top, low, paid)
    assert refused(unpaid, "23514") and refused(over, "23514"), (unpaid, over)


@pytest.mark.parametrize("who_name", ["bob", "alice", "stranger", "anon", "service"])
def test_no_api_role_writes_the_frame_columns(conn, sc, who_name):
    who = {"bob": sc.bob.actor, "alice": sc.alice.actor, "stranger": sc.stranger, "anon": ANON, "service": SERVICE}[who_name]
    with as_superuser(conn, commit=False) as s:
        clear(s, sc.bob.org)
        become(s, sc.bob.actor)
        eid = s.value(REQ3, [PROJECT["b"], 1, "square_1080"])
        become(s, who)
        outs = [
            s.run("update public.editor_exports set frame_preset = 'vertical_1080p', frame_width = 1080, frame_height = 1920 where id = %s", [eid]),
            s.run("update public.editor_exports set frame_width = 2560, frame_height = 1440 where id = %s", [eid]),
            s.run("update public.editor_exports set frame_preset = null, frame_width = null, frame_height = null where id = %s", [eid]),
            s.run("insert into public.editor_exports (org_id, project_id, rev, doc, duration_s, requested_by, frame_preset, frame_width, frame_height) "
                  "values (%s, %s, 1, '{}'::jsonb, 1, gen_random_uuid(), 'square_1080', 1080, 1080)", [sc.bob.org, PROJECT["b"]]),
        ]
        back_to_owner(s)
        row = s.rows(FRAME_ROW, [eid])
    for out in outs:
        assert refused(out, "42501"), (who_name, out)
    assert row == [("square_1080", 1080, 1080)]


@pytest.mark.parametrize("who_name", ["bob", "anon", "service"])
def test_the_list_is_internal(conn, sc, who_name):
    who = {"bob": sc.bob.actor, "anon": ANON, "service": SERVICE}[who_name]
    with acting(conn, who) as s:
        out = s.run("select * from public.editor_export_frame('vertical_1080p')")
    assert refused(out, "42501"), (who_name, out)


# ── other organizations, strangers, roles ───────────────────────────────────

def test_another_orgs_project_reads_as_missing_whatever_the_frame(conn, sc):
    with as_superuser(conn, commit=False) as s:
        clear(s, sc.alice.org)
        become(s, sc.bob.actor)
        real = s.run(REQ3, [PROJECT["a"], 1, "vertical_1080p"])
        junk = s.run(REQ3, [PROJECT["a"], 1, "8192x8192"])
        null = s.run(REQ3, [PROJECT["a"], 1, None])
        made_up = s.run(REQ3, ["00000000-0000-4000-8000-000000000000", 1, "vertical_1080p"])
        plain = s.run(REQ2, [PROJECT["a"], 1])
        written = exports_of(s, sc.alice.org)
    # One answer for all of them: Alice's project id tells Bob nothing, and neither does the list (it is looked at after membership).
    for out in (real, junk, null, made_up):
        assert (out.sqlstate, out.error) == (plain.sqlstate, plain.error) == ("P0002", "not_found"), (out, plain)
    assert written == 0


def test_a_project_of_another_org_cannot_be_exported_into_ones_own(conn, sc):
    """Bob is a member of his own organization; that gives him nothing over Alice's project, with or without a frame."""
    with as_superuser(conn, commit=False) as s:
        clear(s, sc.alice.org)
        clear(s, sc.bob.org)
        become(s, sc.bob.actor)
        out = s.run(REQ3, [PROJECT["a"], 1, "square_1080"])
        back_to_owner(s)
        rows = s.value("select count(*) from public.editor_exports where project_id = %s or org_id = %s", [PROJECT["a"], sc.bob.org])
    assert refused(out, "P0002", "not_found") and rows == 0


@pytest.mark.parametrize("who_name", ["stranger", "dana"])
def test_a_signed_in_outsider_gets_not_found(conn, sc, who_name):
    who = {"stranger": sc.stranger, "dana": sc.dana}[who_name]
    with as_superuser(conn, commit=False) as s:
        clear(s, sc.alice.org)
        become(s, who)
        out = s.run(REQ3, [PROJECT["a"], 1, "vertical_1080p"])
        bad = s.run(REQ3, [PROJECT["a"], 1, "nonsense"])
        written = exports_of(s, sc.alice.org)
    assert refused(out, "P0002", "not_found") and refused(bad, "P0002", "not_found"), (out, bad)
    assert written == 0


@pytest.mark.parametrize("who_name", ["anon", "service"])
def test_the_anon_key_and_the_service_role_cannot_call_the_overload(conn, sc, who_name):
    who = {"anon": ANON, "service": SERVICE}[who_name]
    with as_superuser(conn, commit=False) as s:
        clear(s, sc.alice.org)
        become(s, who)
        out = s.run(REQ3, [PROJECT["a"], 1, "vertical_1080p"])
        written = exports_of(s, sc.alice.org)
    assert refused(out, "42501"), (who_name, out)
    assert written == 0


def test_a_role_may_ask_for_a_frame_exactly_when_it_may_ask_for_a_plain_export(conn, sc):
    """0054 lets every member of the organization export, a viewer too. The overload must not be wider or narrower than that:
    for each caller the two functions give the same kind of answer."""
    callers = {"owner": sc.alice.actor, "viewer": sc.invitee, "other-org": sc.bob.actor, "stranger": sc.stranger, "dana": sc.dana}
    answers = {}
    for name, who in callers.items():
        with as_superuser(conn, commit=False) as s:
            clear(s, sc.alice.org)
            if name == "viewer":
                seat_invitee(s, sc)
            become(s, who)
            if name in ("owner", "viewer"):
                assert s.value("select public.org_role(%s)", [sc.alice.org]) == name
            plain = s.run(REQ2, [PROJECT["a"], 1])
            clear(s, sc.alice.org)
            become(s, who)
            framed = s.run(REQ3, [PROJECT["a"], 1, "square_1080"])
        answers[name] = ((plain.ok, plain.sqlstate), (framed.ok, framed.sqlstate))
    for name, (plain, framed) in answers.items():
        assert plain == framed, (name, answers)
    assert answers["owner"][1] == (True, None) and answers["viewer"][1] == (True, None), answers
    for name in ("other-org", "stranger", "dana"):
        assert answers[name][1] == (False, "P0002"), answers


# ── 0054's other gates, with a frame ────────────────────────────────────────

def test_the_revision_the_files_and_the_length_are_checked_as_before(conn, sc):
    with as_superuser(conn, commit=False) as s:
        clear(s, sc.bob.org)
        become(s, sc.bob.actor)
        stale = s.run(REQ3, [PROJECT["b"], 7, "square_1080"])
        null_rev = s.run(REQ3, [PROJECT["b"], None, "square_1080"])
        too_long = doc(VIDEO["b"])
        too_long["tracks"][1]["clips"][0]["end_s"] = 1801
        rev = s.value(SAVE, [PROJECT["b"], 1, None, json.dumps(too_long)])
        long_out = s.run(REQ3, [PROJECT["b"], rev, "square_1080"])
        rev = s.value(SAVE, [PROJECT["b"], rev, None, json.dumps(doc(VIDEO["b"]))])
        # The file is deleted after the save: the export is refused, as it is without a frame.
        assert s.value("select public.soft_delete_asset(%s)", [VIDEO["b"]]) is True
        gone_file = s.run(REQ3, [PROJECT["b"], rev, "square_1080"])
        gone_file_plain = s.run(REQ2, [PROJECT["b"], rev])
        written = exports_of(s, sc.bob.org)
    assert refused(stale, "NS409", "stale_revision") and refused(null_rev, "NS409", "stale_revision"), (stale, null_rev)
    assert refused(long_out, "NS400", "too_long"), long_out
    assert refused(gone_file, "NS400", "invalid_asset"), gone_file
    assert (gone_file.sqlstate, gone_file.error) == (gone_file_plain.sqlstate, gone_file_plain.error)
    assert written == 0


def test_a_bad_frame_is_refused_before_the_revision_is_even_compared(conn, sc):
    with as_superuser(conn, commit=False) as s:
        clear(s, sc.bob.org)
        become(s, sc.bob.actor)
        out = s.run(REQ3, [PROJECT["b"], 99, "8192x8192"])
    assert refused(out, "NS400", "invalid_frame"), out


def test_a_deleted_project_is_gone_and_its_waiting_frame_exports_are_failed(conn, sc):
    with as_superuser(conn, commit=False) as s:
        clear(s, sc.bob.org)
        become(s, sc.bob.actor)
        eid = s.value(REQ3, [PROJECT["b"], 1, "feed_4x5_1080"])
        assert s.value("select public.delete_editor_project(%s)", [PROJECT["b"]]) is True
        after = s.run(REQ3, [PROJECT["b"], 1, "square_1080"])
        back_to_owner(s)
        row = s.rows("select status, reason, frame_preset from public.editor_exports where id = %s", [eid])
    assert refused(after, "P0002", "not_found"), after
    assert row == [("failed", "project_deleted", "feed_4x5_1080")]


def test_an_export_in_a_frame_holds_and_charges_no_credits(conn, sc):
    ledger = ("select (select count(*) from public.credit_transactions where org_id = %(o)s), "
              "(select count(*) from public.credit_reservations where org_id = %(o)s), "
              "(select balance from public.credit_accounts where org_id = %(o)s)")
    with as_superuser(conn, commit=False) as s:
        clear(s, sc.bob.org)
        before = s.rows(ledger, {"o": sc.bob.org})
        become(s, sc.bob.actor)
        for frame in ("vertical_1080p", "square_1080", "feed_4x5_1080"):
            assert s.run(REQ3, [PROJECT["b"], 1, frame]).ok
        back_to_owner(s)
        after = s.rows(ledger, {"o": sc.bob.org})
    assert after == before


# ── each frame is one export against the limits ─────────────────────────────

def test_the_same_frame_of_the_same_project_twice_is_refused(conn, sc):
    with as_superuser(conn, commit=False) as s:
        clear(s, sc.bob.org)
        become(s, sc.bob.actor)
        first = s.run(REQ3, [PROJECT["b"], 1, "vertical_1080p"])
        again = s.run(REQ3, [PROJECT["b"], 1, "vertical_1080p"])
        flying = in_flight(s, sc.bob.org)
        # Once it is rendering it still blocks; once it has finished the same frame may be asked again.
        s.conn.execute("update public.editor_exports set status = 'rendering' where org_id = %s", [sc.bob.org])
        become(s, sc.bob.actor)
        while_rendering = s.run(REQ3, [PROJECT["b"], 1, "vertical_1080p"])
        back_to_owner(s)
        s.conn.execute("update public.editor_exports set status = 'failed', reason = 'test' where org_id = %s", [sc.bob.org])
        become(s, sc.bob.actor)
        afterwards = s.run(REQ3, [PROJECT["b"], 1, "vertical_1080p"])
    assert first.ok and afterwards.ok, (first, afterwards)
    assert refused(again, "NS409", "export_in_progress") and refused(while_rendering, "NS409", "export_in_progress"), (again, while_rendering)
    assert flying == ["vertical_1080p"]


def test_other_frames_wait_beside_it_up_to_the_organizations_three_and_the_fourth_is_refused(conn, sc):
    with as_superuser(conn, commit=False) as s:
        clear(s, sc.bob.org)
        become(s, sc.bob.actor)
        outs = [s.run(REQ3, [PROJECT["b"], 1, f]) for f in ("vertical_1080p", "square_1080", "feed_4x5_1080", "youtube_720p")]
        flying = in_flight(s, sc.bob.org)
        become(s, sc.bob.actor)
        plain = s.run(REQ2, [PROJECT["b"], 1])
    assert [o.ok for o in outs] == [True, True, True, False], outs
    assert refused(outs[3], "NS409", "export_in_progress"), outs[3]
    assert flying == sorted(["vertical_1080p", "square_1080", "feed_4x5_1080"])
    assert refused(plain, "NS409", "export_in_progress"), plain


def test_the_three_places_are_the_organizations_not_the_projects(conn, sc):
    with as_superuser(conn, commit=False) as s:
        clear(s, sc.bob.org)
        become(s, sc.bob.actor)
        other = s.value(CREATE, [sc.bob.org, "Second", json.dumps(doc(VIDEO["b"]))])
        assert s.run(REQ3, [PROJECT["b"], 1, "vertical_1080p"]).ok
        assert s.run(REQ3, [PROJECT["b"], 1, "square_1080"]).ok
        # The same frame on ANOTHER project is another file: allowed, and it takes the third place.
        assert s.run(REQ3, [other, 1, "vertical_1080p"]).ok
        fourth = s.run(REQ3, [other, 1, "square_1080"])
        fourth_plain = s.run(REQ2, [other, 1])
        # And another organization is not held back by this one being full.
        clear(s, sc.alice.org)
        become(s, sc.alice.actor)
        theirs = s.run(REQ3, [PROJECT["a"], 1, "vertical_1080p"])
    assert refused(fourth, "NS409", "export_in_progress") and refused(fourth_plain, "NS409", "export_in_progress"), (fourth, fourth_plain)
    assert theirs.ok, theirs


def test_a_plain_export_in_flight_takes_a_place_and_a_frame_in_flight_blocks_the_plain_one(conn, sc):
    with as_superuser(conn, commit=False) as s:
        clear(s, sc.bob.org)
        become(s, sc.bob.actor)
        assert s.run(REQ2, [PROJECT["b"], 1]).ok
        # A frame is a different file from the plain export: it may wait beside it ...
        assert s.run(REQ3, [PROJECT["b"], 1, "vertical_1080p"]).ok
        assert s.run(REQ3, [PROJECT["b"], 1, "square_1080"]).ok
        # ... but the plain one counted: that was the organization's three.
        full = s.run(REQ3, [PROJECT["b"], 1, "feed_4x5_1080"])
        flying = in_flight(s, sc.bob.org)
        clear(s, sc.bob.org)
        become(s, sc.bob.actor)
        assert s.run(REQ3, [PROJECT["b"], 1, "vertical_1080p"]).ok
        # The two-argument function is 0054's: it refuses while ANYTHING of the project is in flight.
        plain = s.run(REQ2, [PROJECT["b"], 1])
    assert refused(full, "NS409", "export_in_progress"), full
    assert flying == sorted(["-", "vertical_1080p", "square_1080"])
    assert refused(plain, "NS409", "export_in_progress"), plain


def test_each_frame_counts_toward_the_twenty_a_day(conn, sc):
    with as_superuser(conn, commit=False) as s:
        clear(s, sc.bob.org)
        for _ in range(18):
            s.conn.execute("insert into public.editor_exports (org_id, project_id, rev, doc, duration_s, status, requested_by) "
                           "values (%s, %s, 1, '{}'::jsonb, 1, 'failed', gen_random_uuid())", [sc.bob.org, PROJECT["b"]])
        become(s, sc.bob.actor)
        nineteenth = s.run(REQ3, [PROJECT["b"], 1, "vertical_1080p"])
        twentieth = s.run(REQ3, [PROJECT["b"], 1, "square_1080"])
        over = s.run(REQ3, [PROJECT["b"], 1, "feed_4x5_1080"])
        total = exports_of(s, sc.bob.org)
        # Finished frame exports of today count like any other: nothing can be asked until the day moves on.
        s.conn.execute("update public.editor_exports set status = 'failed', reason = 'test' where org_id = %s", [sc.bob.org])
        become(s, sc.bob.actor)
        still = s.run(REQ3, [PROJECT["b"], 1, "feed_4x5_1080"])
        still_plain = s.run(REQ2, [PROJECT["b"], 1])
        back_to_owner(s)
        s.conn.execute("update public.editor_exports set created_at = now() - interval '25 hours' where org_id = %s", [sc.bob.org])
        become(s, sc.bob.actor)
        next_day = s.run(REQ3, [PROJECT["b"], 1, "feed_4x5_1080"])
    assert nineteenth.ok and twentieth.ok, (nineteenth, twentieth)
    assert refused(over, "NS429", "daily_limit") and total == 20, (over, total)
    assert refused(still, "NS429", "daily_limit") and refused(still_plain, "NS429", "daily_limit"), (still, still_plain)
    assert next_day.ok, next_day


def test_a_refused_frame_leaves_no_row_and_spends_nothing_of_the_day(conn, sc):
    with as_superuser(conn, commit=False) as s:
        clear(s, sc.bob.org)
        become(s, sc.bob.actor)
        for _ in range(40):
            assert not s.run(REQ3, [PROJECT["b"], 1, "8192x8192"]).ok
            assert not s.run(REQ3, [PROJECT["b"], 3, "square_1080"]).ok
        assert exports_of(s, sc.bob.org) == 0
        become(s, sc.bob.actor)
        assert s.run(REQ3, [PROJECT["b"], 1, "square_1080"]).ok


def test_a_format_of_the_projects_own_size_is_the_projects_own_frame_while_the_plain_export_is_in_flight(conn, sc):
    """Project B is 1920x1080, which is youtube_1080p's size: asking for it beside the plain export would be the same picture twice."""
    with as_superuser(conn, commit=False) as s:
        clear(s, sc.bob.org)
        assert s.value("select (doc -> 'width')::int * 10000 + (doc -> 'height')::int from public.editor_projects where id = %s",
                       [PROJECT["b"]]) == 19201080
        become(s, sc.bob.actor)
        assert s.run(REQ2, [PROJECT["b"], 1]).ok
        same = s.run(REQ3, [PROJECT["b"], 1, "youtube_1080p"])
        other = s.run(REQ3, [PROJECT["b"], 1, "vertical_1080p"])
        flying = in_flight(s, sc.bob.org)
        # The other way round: the same size asked as a format first, then once more (the plain one refuses anything in flight).
        clear(s, sc.bob.org)
        become(s, sc.bob.actor)
        assert s.run(REQ3, [PROJECT["b"], 1, "youtube_1080p"]).ok
        again = s.run(REQ3, [PROJECT["b"], 1, "youtube_1080p"])
        plain = s.run(REQ2, [PROJECT["b"], 1])
    assert refused(same, "NS409", "export_in_progress"), same
    assert other.ok, other
    assert flying == sorted(["-", "vertical_1080p"])
    assert refused(again, "NS409", "export_in_progress") and refused(plain, "NS409", "export_in_progress"), (again, plain)


def test_the_size_of_a_plain_export_in_flight_is_the_size_of_the_document_it_copied(conn, sc):
    with as_superuser(conn, commit=False) as s:
        clear(s, sc.bob.org)
        # A plain export asked while the project was 1080x1920 (the project has been saved in another size since).
        vertical = doc(VIDEO["b"])
        vertical["width"], vertical["height"] = 1080, 1920
        s.conn.execute("insert into public.editor_exports (org_id, project_id, rev, doc, duration_s, requested_by) "
                       "values (%s, %s, 1, %s::jsonb, 6, gen_random_uuid())", [sc.bob.org, PROJECT["b"], json.dumps(vertical)])
        become(s, sc.bob.actor)
        that_size = s.run(REQ3, [PROJECT["b"], 1, "vertical_1080p"])
        own_size_now = s.run(REQ3, [PROJECT["b"], 1, "youtube_1080p"])
        # A row whose document holds no number for its size (no API path writes one) matches no frame and raises nothing.
        clear(s, sc.bob.org)
        for odd in ({"width": "1080", "height": "1920"}, {"width": None}, {}, {"width": [1080], "height": {"h": 1920}}):
            s.conn.execute("insert into public.editor_exports (org_id, project_id, rev, doc, duration_s, status, requested_by) "
                           "values (%s, %s, 1, %s::jsonb, 6, 'queued', gen_random_uuid())", [sc.bob.org, PROJECT["b"], json.dumps(odd)])
            become(s, sc.bob.actor)
            out = s.run(REQ3, [PROJECT["b"], 1, "vertical_1080p"])
            assert refused(out, "NS409", "export_in_progress") or out.ok, (odd, out)
            assert out.sqlstate != "22P02", (odd, out)
            clear(s, sc.bob.org)
        # 1080.0 is 1080: jsonb compares numbers by value.
        vertical["width"], vertical["height"] = 1080.0, 1920.0
        s.conn.execute("insert into public.editor_exports (org_id, project_id, rev, doc, duration_s, requested_by) "
                       "values (%s, %s, 1, %s::jsonb, 6, gen_random_uuid())", [sc.bob.org, PROJECT["b"], json.dumps(vertical)])
        become(s, sc.bob.actor)
        float_size = s.run(REQ3, [PROJECT["b"], 1, "vertical_1080p"])
    assert refused(that_size, "NS409", "export_in_progress"), that_size
    assert own_size_now.ok, own_size_now
    assert refused(float_size, "NS409", "export_in_progress"), float_size


def test_an_empty_or_unreadable_document_is_refused_with_a_frame_as_without(conn, sc):
    with as_superuser(conn, commit=False) as s:
        clear(s, sc.bob.org)
        become(s, sc.bob.actor)
        empty = {"version": 1, "width": 1920, "height": 1080, "fps": 30,
                 "tracks": [{"id": "t1", "kind": "T", "clips": [{"id": "x", "start_s": 0, "end_s": 0, "text": "a"}]}]}
        rev = s.value(SAVE, [PROJECT["b"], 1, None, json.dumps(empty)])
        out_empty, plain_empty = s.run(REQ3, [PROJECT["b"], rev, "square_1080"]), s.run(REQ2, [PROJECT["b"], rev])
        unreadable = dict(empty, tracks=[{"id": "t1", "kind": "T", "clips": [{"id": "x", "start_s": "soon", "end_s": "later", "text": "a"}]}])
        rev = s.value(SAVE, [PROJECT["b"], rev, None, json.dumps(unreadable)])
        out_bad, plain_bad = s.run(REQ3, [PROJECT["b"], rev, "square_1080"]), s.run(REQ2, [PROJECT["b"], rev])
        written = exports_of(s, sc.bob.org)
    assert refused(out_empty, "NS400", "empty") and (out_empty.sqlstate, out_empty.error) == (plain_empty.sqlstate, plain_empty.error), (out_empty, plain_empty)
    assert refused(out_bad, "NS400", "invalid_doc") and (out_bad.sqlstate, out_bad.error) == (plain_bad.sqlstate, plain_bad.error), (out_bad, plain_bad)
    assert written == 0


def test_a_rendering_export_takes_one_of_the_organizations_three_places(conn, sc):
    with as_superuser(conn, commit=False) as s:
        clear(s, sc.bob.org)
        become(s, sc.bob.actor)
        assert s.run(REQ3, [PROJECT["b"], 1, "vertical_1080p"]).ok
        back_to_owner(s)
        s.conn.execute("update public.editor_exports set status = 'rendering' where org_id = %s", [sc.bob.org])
        become(s, sc.bob.actor)
        assert s.run(REQ3, [PROJECT["b"], 1, "square_1080"]).ok
        assert s.run(REQ3, [PROJECT["b"], 1, "feed_4x5_1080"]).ok
        fourth = s.run(REQ3, [PROJECT["b"], 1, "youtube_720p"])
        # Done and failed ones take no place.
        back_to_owner(s)
        s.conn.execute("update public.editor_exports set status = 'done', asset_id = %s where org_id = %s and status = 'rendering'",
                       [s.value("select public.register_asset(gen_random_uuid(), %s, 'video', 'video/mp4', 10, repeat('6', 64), 'render') ->> 'id'",
                                [sc.bob.org]), sc.bob.org])
        become(s, sc.bob.actor)
        after_done = s.run(REQ3, [PROJECT["b"], 1, "youtube_720p"])
    assert refused(fourth, "NS409", "export_in_progress"), fourth
    assert "max_active" in (fourth.error or "") or fourth.sqlstate == "NS409"
    assert after_done.ok, after_done


@pytest.mark.parametrize("age,counts", [("23 hours 59 minutes", True), ("24 hours 1 minute", False)])
def test_the_daily_count_is_the_last_24_hours(conn, sc, age, counts):
    with as_superuser(conn, commit=False) as s:
        clear(s, sc.bob.org)
        for _ in range(20):
            s.conn.execute("insert into public.editor_exports (org_id, project_id, rev, doc, duration_s, status, requested_by, created_at) "
                           "values (%s, %s, 1, '{}'::jsonb, 1, 'failed', gen_random_uuid(), now() - %s::interval)", [sc.bob.org, PROJECT["b"], age])
        become(s, sc.bob.actor)
        out = s.run(REQ3, [PROJECT["b"], 1, "square_1080"])
    if counts:
        assert refused(out, "NS429", "daily_limit"), out
    else:
        assert out.ok, out


# ── two connections at once ─────────────────────────────────────────────────
# A database of its own: these tests COMMIT (a race needs two transactions that see each other's commits), and the last one runs the
# rollback for real. One tenant, built the way the scenario builds one, without touching the session lab's ids.

@pytest.fixture(scope="module")
def race():
    from sec_editor_0054 import register
    from sec_scenario import _create_org, _signup

    dsn = sec_db.admin_dsn()
    name = f"ns_security_race_{uuid.uuid4().hex[:8]}"
    db = sec_db.build(dsn, name)
    c = psycopg.connect(db, autocommit=True)
    try:
        who = sec_db.user("racer", f"racer-{uuid.uuid4().hex[:6]}@example.com")
        _signup(c, who)
        org = _create_org(c, who, "Race org")
        video = register(c, org, "race-video")
        # The races are 0129's and its rollback's; 0132 (which replaces 0129's list) is taken off in this database for good.
        with as_superuser(c) as s:
            sec_db.take_off_0132(s)
        projects = []
        with acting(c, who, commit=True) as s:
            for i in range(4):
                projects.append(str(s.value(CREATE, [org, f"Race {i}", json.dumps(doc(video))])))
        yield {"dsn": db, "conn": c, "who": who, "org": org, "projects": projects}
    finally:
        c.close()
        if not os.environ.get("NIGHTSHIFT_SECURITY_KEEP"):
            sec_db.drop_database(dsn, name)


def _session(dsn: str, who) -> psycopg.Connection:
    """A connection with an open transaction in which PostgREST would be serving `who`."""
    c = psycopg.connect(dsn)
    c.execute("select set_config('request.jwt.claims', %s, true)", [json.dumps(who.claims())])
    c.execute("select set_config('request.jwt.claim.role', %s, true)", [who.role])
    c.execute(f"set local role {who.role}")
    return c


def _reset(r) -> None:
    with as_superuser(r["conn"]) as s:
        s.conn.execute("delete from public.editor_exports where org_id = %s", [r["org"]])


def _together(calls, hold_s: float = 0.4):
    """Run each call in its own connection and transaction, all started at once; each commits `hold_s` after its call answered.
    Returns each call's outcome: ("ok", value) or (sqlstate, first line of the message)."""
    barrier = threading.Barrier(len(calls))
    out = [None] * len(calls)

    def one(i, fn):
        c = fn["open"]()
        try:
            barrier.wait()
            try:
                v = c.execute(fn["sql"], fn["args"]).fetchone()[0]
                time.sleep(hold_s)
                c.commit()
                out[i] = ("ok", v)
            except psycopg.Error as e:
                c.rollback()
                out[i] = (e.sqlstate, str(e).splitlines()[0])
        finally:
            c.close()

    threads = [threading.Thread(target=one, args=(i, fn)) for i, fn in enumerate(calls)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(30)
    return out


def test_four_requests_at_once_on_four_projects_queue_exactly_three(race):
    _reset(race)
    open_ = lambda: _session(race["dsn"], race["who"])  # noqa: E731
    out = _together([{"open": open_, "sql": REQ3, "args": [p, 1, "vertical_1080p"]} for p in race["projects"]])
    oks = [o for o in out if o[0] == "ok"]
    refusals = [o for o in out if o[0] != "ok"]
    assert len(oks) == 3, out
    assert refusals == [("NS409", "export_in_progress")], out
    with as_superuser(race["conn"], commit=False) as s:
        assert s.value("select count(*) from public.editor_exports where org_id = %s and status = 'queued'", [race["org"]]) == 3
    _reset(race)


def test_two_requests_at_once_at_nineteen_today_queue_exactly_one(race):
    _reset(race)
    with as_superuser(race["conn"]) as s:
        for _ in range(19):
            s.conn.execute("insert into public.editor_exports (org_id, project_id, rev, doc, duration_s, status, requested_by) "
                           "values (%s, %s, 1, '{}'::jsonb, 1, 'failed', gen_random_uuid())", [race["org"], race["projects"][3]])
    open_ = lambda: _session(race["dsn"], race["who"])  # noqa: E731
    out = _together([{"open": open_, "sql": REQ3, "args": [race["projects"][0], 1, "square_1080"]},
                     {"open": open_, "sql": REQ3, "args": [race["projects"][1], 1, "feed_4x5_1080"]}])
    assert sorted(o[0] for o in out) == ["NS429", "ok"], out
    with as_superuser(race["conn"], commit=False) as s:
        assert s.value("select count(*) from public.editor_exports where org_id = %s", [race["org"]]) == 20
    _reset(race)


def _rollback_sql(timeout: str = "2s") -> str:
    """The rollback file as the owner pastes it (with its own begin / commit), with a shorter lock wait so a test does not sit 5 s."""
    text = ROLLBACK.read_text(encoding="utf-8")
    assert text.count("set local lock_timeout = '5s';") == 1
    return text.replace("set local lock_timeout = '5s';", f"set local lock_timeout = '{timeout}';")


def _rolled_back(r) -> bool:
    with as_superuser(r["conn"], commit=False) as s:
        return s.value(f"select to_regprocedure('{REQ3_SIG}') is null")


def _queued_of(r) -> int:
    with as_superuser(r["conn"], commit=False) as s:
        return s.value("select count(*) from public.editor_exports where org_id = %s and status in ('queued', 'rendering')", [r["org"]])


def _put_back(r) -> None:
    if _rolled_back(r):
        _reset(r)
        r["conn"].execute(MIGRATION.read_text(encoding="utf-8"))


@pytest.mark.parametrize("a_commits_after", [0.3, None], ids=["request-commits-while-rollback-waits", "request-outlasts-the-wait"])
def test_a_rollback_racing_a_framed_request_never_leaves_it_queued_without_its_frame(race, a_commits_after):
    """Connection A asks for a framed export and keeps its transaction open; B pastes the rollback. Either B refuses (it sees the
    export in flight, or it cannot get its lock in time) or the rollback goes through with no export of A's left waiting. Never:
    rollback applied and A's export queued, which the worker would render in the project's frame."""
    _put_back(race)
    _reset(race)
    a = _session(race["dsn"], race["who"])
    a.execute(REQ3, [race["projects"][0], 1, "vertical_1080p"])
    result = {}

    def b():
        c = psycopg.connect(race["dsn"], autocommit=True)
        try:
            c.execute(_rollback_sql())
            result["b"] = "applied"
        except psycopg.Error as e:
            result["b"] = (e.sqlstate, str(e).splitlines()[0])
        finally:
            c.close()

    t = threading.Thread(target=b)
    t.start()
    if a_commits_after is not None:
        time.sleep(a_commits_after)
        a.commit()
        t.join(20)
    else:
        t.join(20)
        a.commit()
    a.close()
    applied = _rolled_back(race)
    queued = _queued_of(race)
    try:
        assert not (applied and queued), (result, applied, queued)
        assert result["b"] != "applied" and not applied, result
        if a_commits_after is not None:
            assert "an export in flight carries a frame" in result["b"][1], result
        else:
            assert result["b"][0] == "55P03", result          # lock_not_available: it waited and stopped, changing nothing
        assert queued == 1
    finally:
        _put_back(race)
        _reset(race)


def test_a_request_racing_a_rollback_in_progress_fails_and_leaves_nothing(race):
    """B has run the rollback and not committed yet; A asks for a framed export meanwhile. A waits for B, then fails (its function or
    its columns are gone): the rollback is applied and A left nothing behind."""
    _put_back(race)
    _reset(race)
    b = psycopg.connect(race["dsn"])
    b.execute("\n".join(ln for ln in _rollback_sql().splitlines() if ln.strip() not in ("begin;", "commit;")))
    result = {}

    def a():
        c = _session(race["dsn"], race["who"])
        try:
            result["a"] = ("ok", c.execute(REQ3, [race["projects"][1], 1, "square_1080"]).fetchone()[0])
            c.commit()
        except psycopg.Error as e:
            c.rollback()
            result["a"] = (e.sqlstate, str(e).splitlines()[0])
        finally:
            c.close()

    t = threading.Thread(target=a)
    t.start()
    time.sleep(0.5)
    assert t.is_alive(), result           # A waits for B's lock instead of writing past it
    b.commit()
    b.close()
    t.join(20)
    try:
        assert _rolled_back(race)
        assert result["a"][0] != "ok", result
        assert _queued_of(race) == 0
    finally:
        _put_back(race)
        _reset(race)


# ── the worker's side ───────────────────────────────────────────────────────

def test_the_worker_is_handed_the_frame_as_it_was_written_and_a_plain_export_has_none(conn, sc):
    with as_superuser(conn, commit=False) as s:
        clear(s, sc.bob.org)
        clear(s, sc.alice.org)
        become(s, sc.bob.actor)
        framed = s.value(REQ3, [PROJECT["b"], 1, "feed_4x5_1080"])
        become(s, sc.alice.actor)
        plain = s.value(REQ2, [PROJECT["a"], 1])
        back_to_owner(s)
        s.conn.execute("update public.editor_exports set status = 'failed' where id not in (%s, %s) and status in ('queued', 'rendering')", [framed, plain])
        become(s, SERVICE)
        claimed = {r[0]: r[1:] for r in (s.rows(CLAIM, ["w-frame"]) + s.rows(CLAIM, ["w-frame"]))}
        files = [r[0] for r in s.rows("select id::text from public.editor_export_assets(%s)", [framed])]
        own = s.value("select public.register_asset(gen_random_uuid(), %s, 'video', 'video/mp4', 10, repeat('7', 64), 'render', "
                      "p_width => 1080, p_height => 1350) ->> 'id'", [sc.bob.org])
        done = s.value("select public.finish_editor_export(%s, 'w-frame', %s, null)", [framed, own])
        back_to_owner(s)
        row = s.rows("select status, asset_id::text, frame_preset, frame_width, frame_height from public.editor_exports where id = %s", [framed])
    assert claimed == {str(framed): ("feed_4x5_1080", 1080, 1350), str(plain): (None, None, None)}, claimed
    assert VIDEO["b"] in files
    assert done == "done" and row == [("done", own, "feed_4x5_1080", 1080, 1350)]


def test_the_two_argument_call_is_unchanged_and_writes_no_frame(conn, sc):
    with as_superuser(conn, commit=False) as s:
        sec_db.take_off_0136(s)   # 0132's body or 0054's: 0136 builds on 0132's and is taken off first
        clear(s, sc.bob.org)
        become(s, sc.bob.actor)
        eid = s.value(REQ2, [PROJECT["b"], 1])
        busy = s.run(REQ2, [PROJECT["b"], 1])
        back_to_owner(s)
        row = s.rows(FRAME_ROW, [eid])
        body = s.value(f"select md5(regexp_replace(prosrc, '\\s+', ' ', 'g')) from pg_proc where oid = '{REQ2_SIG}'::regprocedure")
    assert row == [(None, None, None)]
    assert refused(busy, "NS409", "export_in_progress")
    # 0054's body, or 0132's (0054's plus its refusal of a project above 1080p) while 0132 is applied.
    assert body in (BEFORE_HASH, _pinned_0132("req2"))


def test_the_api_roles_reach_the_overloads_they_should(conn):
    with as_superuser(conn, commit=False) as s:
        rows = s.rows(
            "select pg_get_function_identity_arguments(p.oid), p.prosecdef, p.proconfig::text, "
            "has_function_privilege('authenticated', p.oid, 'EXECUTE'), has_function_privilege('anon', p.oid, 'EXECUTE'), "
            "has_function_privilege('service_role', p.oid, 'EXECUTE'), has_function_privilege('public', p.oid, 'EXECUTE') "
            "from pg_proc p where p.proname = 'request_editor_export' and p.pronamespace = 'public'::regnamespace order by 1")
        lst = s.rows(
            "select p.prosecdef, p.proconfig::text, has_function_privilege('authenticated', p.oid, 'EXECUTE'), "
            "has_function_privilege('anon', p.oid, 'EXECUTE'), has_function_privilege('service_role', p.oid, 'EXECUTE'), "
            f"has_function_privilege('public', p.oid, 'EXECUTE') from pg_proc p where p.oid = '{LIST_SIG}'::regprocedure")
    assert [r[0] for r in rows] == ["p_project uuid, p_rev integer", "p_project uuid, p_rev integer, p_frame text",
                                    "p_project uuid, p_rev integer, p_frame text, p_max_credits numeric"], rows
    for args, secdef, config, authed, anon, service, public in rows:
        assert (secdef, authed, anon, service, public) == (True, True, False, False, False), (args, rows)
        assert "search_path=public, pg_temp" in config, config
    assert lst == [(False, '{"search_path=public, pg_temp"}', False, False, False, False)], lst


# ── the file ────────────────────────────────────────────────────────────────

def _pinned(text: str) -> tuple[str, str]:
    """The two hashes the migration carries for its own bodies (the three-argument overload, the list)."""
    req3 = re.search(r"oid = req3\) <> '([0-9a-f]{32})'", text).group(1)
    lst = re.search(r"oid = lst\) <> '([0-9a-f]{32})'", text).group(1)
    return req3, lst


def _hash(s, sig: str):
    return s.value(f"select md5(regexp_replace(prosrc, '\\s+', ' ', 'g')) from pg_proc where oid = to_regprocedure('{sig}')")


def _rollback_text() -> str:
    return "\n".join(ln for ln in ROLLBACK.read_text(encoding="utf-8").splitlines() if ln.strip() not in ("begin;", "commit;"))


def drift(s, sig: str, find: str, put: str) -> None:
    """One of the live functions with one line changed, as if somebody had edited it by hand."""
    src = s.value(f"select pg_get_functiondef('{sig}'::regprocedure)")
    assert src.count(find) == 1, (sig, find)
    s.conn.execute(src.replace(find, put))


def _pinned_0132(name: str) -> str:
    return re.search(rf"oid = {name}\) <> '([0-9a-f]{{32}})'", sec_db.MIGRATION_0132.read_text(encoding="utf-8")).group(1)


def test_the_live_bodies_are_the_ones_the_file_pins(conn):
    req3, lst = _pinned(MIGRATION.read_text(encoding="utf-8"))
    with as_superuser(conn, commit=False) as s:
        sec_db.take_off_0136(s)   # 0136 builds on 0132's bodies and is taken off first
        # The list and the two request functions are 0132's while 0132 is applied (it replaced them), and 0129's / 0054's again once 0132
        # is taken off.
        on = sec_db.has_0132(s)
        assert (_hash(s, REQ2_SIG), _hash(s, REQ3_SIG)) == ((_pinned_0132("req2"), _pinned_0132("req3")) if on else (BEFORE_HASH, req3))
        assert _hash(s, LIST_SIG) == (_pinned_0132("lst") if on else lst)
        sec_db.take_off_0132(s)
        assert (_hash(s, REQ2_SIG), _hash(s, REQ3_SIG), _hash(s, LIST_SIG)) == (BEFORE_HASH, req3, lst)


def test_the_file_applies_twice_and_changes_nothing(conn, sc):
    with as_superuser(conn, commit=False) as s:
        sec_db.take_off_0132(s)
        clear(s, sc.bob.org)
        become(s, sc.bob.actor)
        eid = s.value(REQ3, [PROJECT["b"], 1, "square_1080"])
        back_to_owner(s)
        before = (_hash(s, REQ2_SIG), _hash(s, REQ3_SIG), _hash(s, LIST_SIG))
        s.conn.execute(MIGRATION.read_text(encoding="utf-8"))
        s.conn.execute(MIGRATION.read_text(encoding="utf-8"))
        assert (_hash(s, REQ2_SIG), _hash(s, REQ3_SIG), _hash(s, LIST_SIG)) == before
        assert s.value("select count(*) from pg_proc where proname = 'request_editor_export' and pronamespace = 'public'::regnamespace") == 2
        assert s.value("select count(*) from pg_constraint where conname = 'editor_exports_frame_shape'") == 1
        # A row written before the re-run keeps its frame.
        assert s.rows(FRAME_ROW, [eid]) == [("square_1080", 1080, 1080)]


@pytest.mark.parametrize("sig,find,put,says", [
    (REQ2_SIG, ">= 20 then", ">= 21 then", "not 0054's body"),
    (REQ3_SIG, ">= 20 then", ">= 21 then", "three-argument request_editor_export() that is not this file's"),
    (LIST_SIG, "('square_1080', 1080, 1080)", "('square_1080', 8192, 8192)", "editor_export_frame() that is not this file's"),
])
def test_the_file_refuses_a_body_it_has_not_seen_and_changes_nothing(conn, sig, find, put, says):
    with as_superuser(conn, commit=False) as s:
        sec_db.take_off_0132(s)
        drift(s, sig, find, put)
        drifted = _hash(s, sig)
        out = s.run(MIGRATION.read_text(encoding="utf-8"))
        assert _hash(s, sig) == drifted       # the hand edit is still there: the file did not paper over it
    assert (not out.ok) and says in out.error, out


def test_the_file_refuses_without_0054(conn):
    with as_superuser(conn, commit=False) as s:
        sec_db.take_off_0132(s)
        s.conn.execute(_rollback_text())
        s.conn.execute("drop function public.request_editor_export(uuid, integer)")
        out = s.run(MIGRATION.read_text(encoding="utf-8"))
    assert (not out.ok) and "apply 0054_editor_projects.sql first" in out.error, out


def test_the_rollback_takes_it_out_and_the_file_applies_again(conn, sc):
    req3, lst = _pinned(MIGRATION.read_text(encoding="utf-8"))
    with as_superuser(conn, commit=False) as s:
        sec_db.take_off_0132(s)
        clear(s, sc.bob.org)
        become(s, sc.bob.actor)
        done = s.value(REQ3, [PROJECT["b"], 1, "square_1080"])
        back_to_owner(s)
        s.conn.execute("update public.editor_exports set status = 'failed', reason = 'test' where id = %s", [done])
        s.conn.execute(_rollback_text())
        assert _hash(s, REQ2_SIG) == BEFORE_HASH
        assert (_hash(s, REQ3_SIG), _hash(s, LIST_SIG)) == (None, None)
        assert s.value("select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'editor_exports' "
                       "and column_name like 'frame%%'") == 0
        assert s.value("select count(*) from pg_constraint where conname = 'editor_exports_frame_shape'") == 0
        # The finished export row is still there (without its frame), and exporting works the way it did before 0129.
        assert s.value("select status from public.editor_exports where id = %s", [done]) == "failed"
        become(s, sc.bob.actor)
        assert s.run(REQ2, [PROJECT["b"], 1]).ok
        # The Command Center's three-argument call is simply not found: it answers "not available" for that frame.
        gone = s.run(REQ3, [PROJECT["b"], 1, "square_1080"])
        assert refused(gone, "42883"), gone
        back_to_owner(s)
        s.conn.execute("update public.editor_exports set status = 'failed', reason = 'test' where org_id = %s", [sc.bob.org])
        s.conn.execute(MIGRATION.read_text(encoding="utf-8"))
        assert (_hash(s, REQ2_SIG), _hash(s, REQ3_SIG), _hash(s, LIST_SIG)) == (BEFORE_HASH, req3, lst)
        become(s, sc.bob.actor)
        again = s.value(REQ3, [PROJECT["b"], 1, "vertical_1080p"])
        back_to_owner(s)
        assert s.rows(FRAME_ROW, [again]) == [("vertical_1080p", 1080, 1920)]
        assert s.value("select has_function_privilege('authenticated', %s, 'EXECUTE') and not has_function_privilege('anon', %s, 'EXECUTE')",
                       [REQ3_SIG, REQ3_SIG]) is True


@pytest.mark.parametrize("status", ["queued", "rendering"])
def test_the_rollback_refuses_while_an_export_in_flight_carries_a_frame(conn, sc, status):
    with as_superuser(conn, commit=False) as s:
        sec_db.take_off_0132(s)
        clear(s, sc.bob.org)
        become(s, sc.bob.actor)
        eid = s.value(REQ3, [PROJECT["b"], 1, "square_1080"])
        back_to_owner(s)
        s.conn.execute("update public.editor_exports set status = %s where id = %s", [status, eid])
        out = s.run(_rollback_text())
        assert (not out.ok) and "an export in flight carries a frame" in out.error, out
        assert _hash(s, REQ3_SIG) is not None
        # A plain export in flight does not hold it back; once the frame export has ended the rollback goes through.
        s.conn.execute("update public.editor_exports set status = 'failed', reason = 'test' where id = %s", [eid])
        become(s, sc.bob.actor)
        assert s.run(REQ2, [PROJECT["b"], 1]).ok
        back_to_owner(s)
        s.conn.execute(_rollback_text())
        assert _hash(s, REQ3_SIG) is None


@pytest.mark.parametrize("sig,find,put,says", [
    (REQ3_SIG, ">= 20 then", ">= 21 then", "the three-argument request_editor_export() is missing or is not 0129's body"),
    (LIST_SIG, "('square_1080', 1080, 1080)", "('square_1080', 1080, 1082)", "editor_export_frame() is missing or is not 0129's body"),
    (REQ2_SIG, ">= 20 then", ">= 21 then", "the two-argument request_editor_export() is not 0054's body"),
])
def test_the_rollback_refuses_a_body_that_is_not_the_one_it_knows(conn, sig, find, put, says):
    with as_superuser(conn, commit=False) as s:
        s.conn.execute("update public.editor_exports set status = 'failed', reason = 'test' where status in ('queued', 'rendering')")
        sec_db.take_off_0132(s)
        drift(s, sig, find, put)
        out = s.run(_rollback_text())
        assert _hash(s, REQ3_SIG) is not None and _hash(s, LIST_SIG) is not None
    assert (not out.ok) and says in out.error, out

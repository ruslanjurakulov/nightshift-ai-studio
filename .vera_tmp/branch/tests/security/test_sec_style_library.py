"""Named attacks on the Style Library's add function (migration 0065).

The table-by-table isolation tests already prove that Bob (org B) cannot read,
change, delete, move or insert Alice's (org A) kit rows, and that no API role
can insert or update style_kits directly. These prove the paths where the
check lives in plpgsql: who may call add_library_style_kit, that the same
library style is one kit per organization however many times it is pressed
(and a second press never overwrites the person's edits), the limits, and
that the new library_id column cannot be written or moved by anyone but the
function.

Every attack runs in a transaction that is rolled back.
"""

from __future__ import annotations

from contextlib import contextmanager

import pytest

from sec_db import ANON, SERVICE, acting, as_superuser
from sec_style_0047 import IMAGES, KIT
from sec_style_0065 import ADD

DESC = "Two inks on cream stock. Avoid the glossy, symmetrical, over-saturated stock-AI look: no gradients."


def add(s, org, lib="linocut-print", name="Linocut", desc=DESC):
    return s.run(ADD, [org, lib, name, desc])


@contextmanager
def committed_kit(conn, who, org, lib="linocut-print"):
    """A library kit that survives the transaction that made it, so another caller can aim at it; removed after."""
    with acting(conn, who, commit=True) as s:
        kit = add(s, org, lib=lib).rows[0][0]["id"]
    try:
        yield kit
    finally:
        with as_superuser(conn, commit=True) as s:
            s.rows("delete from public.style_kits where id = %s returning 1", [kit])


def kit_rows(conn, org: str):
    with as_superuser(conn, commit=False) as s:
        return s.rows(
            "select id::text, library_id, name, description from public.style_kits "
            "where org_id = %s and library_id is not null order by created_at, id", [org])


# ── who may call it ─────────────────────────────────────────────────────────

def test_an_editor_adds_a_kit_with_no_references(conn, sc):
    with acting(conn, sc.alice.actor) as s:
        out = add(s, sc.alice.org)
        assert out.ok, out
        got = out.rows[0][0]
        assert got["created"] is True
        row = s.rows("select org_id::text, library_id, name, description, created_by::text "
                     "from public.style_kits where id = %s", [got["id"]])[0]
        assert row == (sc.alice.org, "linocut-print", "Linocut", DESC, sc.alice.actor.uid)
        # The library's text is the direction: no pictures are needed, and none are made up.
        assert s.value("select count(*) from public.style_kit_references where kit_id = %s", [got["id"]]) == 0


def test_bob_cannot_add_to_alices_org(conn, sc):
    before = kit_rows(conn, sc.alice.org)
    for who in (sc.bob.actor, sc.stranger):
        with acting(conn, who) as s:
            out = add(s, sc.alice.org)
        assert not out.ok and out.sqlstate == "42501", (who.name, out)
    assert kit_rows(conn, sc.alice.org) == before


def test_anon_cannot_call_it_at_all(conn, sc):
    with acting(conn, ANON) as s:
        out = add(s, sc.alice.org)
    assert not out.ok and out.sqlstate == "42501", out


def test_the_service_key_does_not_get_it_either(conn, sc):
    # Adding is a person's act in their own session (created_by, the editor check); nothing else may.
    with acting(conn, SERVICE) as s:
        out = add(s, sc.alice.org)
    assert not out.ok and out.sqlstate == "42501", out


def test_a_viewer_cannot_add(conn, sc):
    # Dana is a viewer of the operator's default organization.
    with as_superuser(conn, commit=False) as s:
        default_org = s.value("select org_id::text from public.org_members where user_id = %s", [sc.dana.uid])
    with acting(conn, sc.dana) as s:
        out = add(s, default_org)
    assert not out.ok and out.sqlstate == "42501", out


def test_no_organization_is_forbidden_not_a_crash(conn, sc):
    with acting(conn, sc.alice.actor) as s:
        out = add(s, None)
    assert not out.ok and out.sqlstate == "42501", out


# ── one kit per library style per organization ──────────────────────────────

def test_a_second_press_is_the_same_kit_and_overwrites_nothing(conn, sc):
    with acting(conn, sc.alice.actor) as s:
        first = add(s, sc.alice.org).rows[0][0]
        # The person edits their copy's name; another press (even with other text) must leave it alone.
        again = add(s, sc.alice.org, name="Hijacked", desc="different words").rows[0][0]
        assert again == {"id": first["id"], "created": False}
        assert s.rows("select name, description from public.style_kits where id = %s", [first["id"]]) == [("Linocut", DESC)]
        assert s.value("select count(*) from public.style_kits where org_id = %s and library_id = 'linocut-print'",
                       [sc.alice.org]) == 1


def test_two_organizations_each_get_their_own_kit(conn, sc):
    with acting(conn, sc.alice.actor) as s:
        a = add(s, sc.alice.org).rows[0][0]["id"]
    with acting(conn, sc.bob.actor) as s:
        b = add(s, sc.bob.org).rows[0][0]["id"]
    assert a != b


def test_the_database_itself_refuses_a_duplicate_however_it_is_written(conn, sc):
    with as_superuser(conn, commit=False) as s:
        s.value("insert into public.style_kits (org_id, name, description, library_id) values (%s, 'X', '', 'dup-style') returning 1",
                [sc.alice.org])
        out = s.run("insert into public.style_kits (org_id, name, description, library_id) values (%s, 'Y', '', 'dup-style')",
                    [sc.alice.org])
    assert not out.ok and out.sqlstate == "23505", out


# ── input limits ────────────────────────────────────────────────────────────

@pytest.mark.parametrize("lib", [None, "", "x", "Linocut-Print", "linocut_print", "../etc/passwd", "a" * 49, "-bad", "bad-", "bad--id", "has space", "emoji-🙂"])
def test_a_malformed_library_id_is_refused(conn, sc, lib):
    before = kit_rows(conn, sc.alice.org)
    with acting(conn, sc.alice.actor) as s:
        out = add(s, sc.alice.org, lib=lib)
    assert not out.ok and out.sqlstate == "NS400" and "invalid_library_id" in out.error, (lib, out)
    assert kit_rows(conn, sc.alice.org) == before


@pytest.mark.parametrize("name,desc,word", [
    ("", DESC, "invalid_name"),
    ("   ", DESC, "invalid_name"),
    ("n" * 61, DESC, "invalid_name"),
    ("Linocut", "", "invalid_description"),
    ("Linocut", "   ", "invalid_description"),
    ("Linocut", "d" * 2001, "invalid_description"),
])
def test_a_bad_name_or_description_is_refused(conn, sc, name, desc, word):
    with acting(conn, sc.alice.actor) as s:
        out = add(s, sc.alice.org, name=name, desc=desc)
    assert not out.ok and out.sqlstate == "NS400" and word in out.error, out


def test_the_edge_lengths_are_accepted_and_control_characters_are_stripped(conn, sc):
    with acting(conn, sc.alice.actor) as s:
        out = add(s, sc.alice.org, lib="ab", name="n\x07" * 1 + "x" * 59, desc="d" * 2000)
        assert out.ok, out
        row = s.rows("select name, description from public.style_kits where id = %s", [out.rows[0][0]["id"]])[0]
        assert len(row[0]) == 60 and "\x07" not in row[0] and len(row[1]) == 2000
        out = add(s, sc.alice.org, lib="a" * 48)
        assert out.ok, out


def test_the_per_organization_cap_holds_and_a_full_organization_can_still_press_what_it_has(conn, sc):
    with acting(conn, sc.alice.actor) as s:
        have = s.value("select count(*) from public.style_kits where org_id = %s", [sc.alice.org])
        for i in range(50 - have):
            assert add(s, sc.alice.org, lib=f"fill-{i}").ok
        out = add(s, sc.alice.org, lib="one-too-many")
        assert not out.ok and out.sqlstate == "NS429" and "limit_reached" in out.error, out
        # Already there: idempotent even at the cap.
        again = add(s, sc.alice.org, lib="fill-0")
        assert again.ok and again.rows[0][0]["created"] is False


# ── the column cannot be written or moved by anyone else ────────────────────

def test_no_api_role_can_write_library_id_directly(conn, sc):
    with committed_kit(conn, sc.alice.actor, sc.alice.org) as kit:
        for who in (sc.alice.actor, sc.bob.actor, sc.stranger, SERVICE, ANON):
            with acting(conn, who) as s:
                upd = s.run("update public.style_kits set library_id = 'stolen' where id = %s", [kit])
                ins = s.run("insert into public.style_kits (org_id, name, description, library_id) values (%s, 'n', '', 'x1')", [sc.alice.org])
            assert not upd.ok and upd.sqlstate in ("42501", "0A000"), (who.name, upd)
            assert not ins.ok and ins.sqlstate == "42501", (who.name, ins)
        assert [r[1] for r in kit_rows(conn, sc.alice.org)] == ["linocut-print"]


def test_bob_cannot_read_alices_library_kits(conn, sc):
    with committed_kit(conn, sc.alice.actor, sc.alice.org):
        for who in (sc.bob.actor, sc.stranger, ANON):
            with acting(conn, who) as s:
                out = s.run("select count(*) from public.style_kits where library_id is not null and org_id = %s", [sc.alice.org])
            assert (not out.ok) or out.rows == [(0,)], (who.name, out)
        with acting(conn, sc.alice.actor) as s:
            assert s.value("select count(*) from public.style_kits where library_id = 'linocut-print'") == 1


def test_editing_a_library_kit_keeps_its_library_id_and_then_needs_its_pictures(conn, sc):
    with acting(conn, sc.alice.actor) as s:
        kit = add(s, sc.alice.org).rows[0][0]["id"]
        # The ordinary save path still asks for 3-12 pictures — a library kit is not a loophole around that.
        few = s.run("select public.save_style_kit(%s, %s, 'Mine', 'mine', %s::uuid[])", [sc.alice.org, kit, IMAGES["a"][:2]])
        assert not few.ok and few.sqlstate == "NS400" and "too_few_references" in few.error, few
        ok = s.run("select public.save_style_kit(%s, %s, 'Mine', 'mine', %s::uuid[])", [sc.alice.org, kit, IMAGES["a"][:3]])
        assert ok.ok, ok
        assert s.rows("select library_id, name from public.style_kits where id = %s", [kit]) == [("linocut-print", "Mine")]
        # After editing, pressing "Add" again still finds the same kit and leaves the edit alone.
        again = add(s, sc.alice.org).rows[0][0]
        assert again == {"id": kit, "created": False}


def test_bob_cannot_edit_or_delete_alices_library_kit(conn, sc):
    with committed_kit(conn, sc.alice.actor, sc.alice.org) as kit:
        with acting(conn, sc.bob.actor) as b:
            out = b.run("select public.save_style_kit(%s, %s, 'pwned', 'pwned', %s::uuid[])", [None, kit, IMAGES["b"][:3]])
            assert not out.ok and out.sqlstate == "P0002", out
            gone = b.run("delete from public.style_kits where id = %s", [kit])
            assert gone.ok and gone.rowcount == 0, gone
        assert [r[1] for r in kit_rows(conn, sc.alice.org)] == ["linocut-print"]


def test_a_library_kit_is_a_usable_look_for_a_generation_in_its_own_org_only(conn, sc):
    q = "select public.creative_style_problem(%s, 't2i', jsonb_build_object('style_kit_id', %s::text))"
    with committed_kit(conn, sc.alice.actor, sc.alice.org, "usable-look") as kit:
        # The check is internal (granted to no API role); run it as the database owner, the way
        # creative_job_style and the pricing function call it.
        with as_superuser(conn, commit=False) as s:
            mine = s.run(q, [sc.alice.org, kit])
            theirs = s.run(q, [sc.bob.org, kit])
        assert mine.ok and mine.rows[0][0] is None, mine
        assert theirs.ok and theirs.rows[0][0] is not None, theirs

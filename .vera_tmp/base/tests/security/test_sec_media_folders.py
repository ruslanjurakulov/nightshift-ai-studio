"""Named attacks on media library folders (migration 0049).

The table-by-table isolation tests already prove that Bob (org B) cannot read,
change, delete, move or insert Alice's (org A) folder rows directly. These
prove the paths where the check lives in plpgsql or a trigger: the three
functions (save / delete a folder, move files), the same-organization guard
on media_assets.folder_id (whoever writes it), the counts, and the limits.

Every attack runs in a transaction that is rolled back.
"""

from __future__ import annotations

import json
import uuid

import pytest

from sec_db import ANON, SERVICE, acting, as_superuser
from sec_folders_0049 import FILED, FOLDER, LOOSE, register

SAVE = "select public.save_media_folder(%s, %s, %s)"
DELETE = "select public.delete_media_folder(%s, %s)"
MOVE = "select public.move_media_assets(%s, %s, %s::uuid[])"
COUNTS = "select folder_id::text, assets from public.media_folder_counts(%s)"


def folder_row(conn, folder: str):
    with as_superuser(conn, commit=False) as s:
        rows = s.rows("select org_id::text, name from public.media_folders where id = %s", [folder])
    return rows[0] if rows else None


def folders_of(conn, assets):
    with as_superuser(conn, commit=False) as s:
        rows = s.rows("select id::text, folder_id::text from public.media_assets where id = any(%s::uuid[])", [list(assets)])
    return dict(rows)


def become(s, who) -> None:
    """Inside a superuser transaction (after seeding something only the owner
    may write), act as `who` for the rest of it."""
    s.conn.execute("select set_config('request.jwt.claims', %s, true)", [json.dumps(who.claims())])
    s.conn.execute("select set_config('request.jwt.claim.role', %s, true)", [who.role])
    s.conn.execute(f"set local role {who.role}")


def refused(out, sqlstate: str, word: str | None = None) -> bool:
    return (not out.ok) and out.sqlstate == sqlstate and (word is None or word in (out.error or ""))


# ── reading ─────────────────────────────────────────────────────────────────

def test_another_org_reads_none_of_alices_folders(conn, sc):
    for who in (sc.bob.actor, sc.stranger, sc.dana, ANON):
        with acting(conn, who) as s:
            out = s.run("select count(*) from public.media_folders where org_id = %s", [sc.alice.org])
        assert (not out.ok) or out.rows == [(0,)], f"media_folders as {who.name}: {out!r}"
    # Positive control: Alice sees hers.
    with acting(conn, sc.alice.actor) as s:
        assert s.value("select count(*) from public.media_folders where org_id = %s", [sc.alice.org]) == 1


def test_another_org_cannot_see_which_folder_alices_files_are_in(conn, sc):
    with acting(conn, sc.bob.actor) as s:
        out = s.run("select folder_id from public.media_assets where id = any(%s::uuid[])", [FILED["a"]])
    assert out.ok and out.rows == [], out


def test_counts_are_the_callers_own_view(conn, sc):
    with acting(conn, sc.alice.actor) as s:
        mine = dict(s.rows(COUNTS, [sc.alice.org]))
    assert mine[FOLDER["a"]] == len(FILED["a"])
    assert mine[None] >= len(LOOSE["a"])
    for who in (sc.bob.actor, sc.stranger, sc.dana):
        with acting(conn, who) as s:
            out = s.run(COUNTS, [sc.alice.org])
        assert out.ok and out.rows == [], f"{who.name} counts org A's files: {out!r}"
    with acting(conn, ANON) as s:
        out = s.run(COUNTS, [sc.alice.org])
    assert refused(out, "42501"), out


# ── creating, renaming, deleting ────────────────────────────────────────────

def test_bob_cannot_create_a_folder_in_alices_org(conn, sc):
    with acting(conn, sc.bob.actor) as s:
        out = s.run(SAVE, [sc.alice.org, None, "Mine now"])
    assert refused(out, "42501"), out


def test_bob_cannot_rename_alices_folder(conn, sc):
    before = folder_row(conn, FOLDER["a"])
    for org in (None, sc.bob.org, sc.alice.org):
        with acting(conn, sc.bob.actor) as s:
            out = s.run(SAVE, [org, FOLDER["a"], "pwned"])
        # Another org's folder reads as missing, never as "forbidden".
        assert refused(out, "P0002"), (org, out)
    assert folder_row(conn, FOLDER["a"]) == before


def test_bob_cannot_delete_alices_folder(conn, sc):
    for org in (None, sc.bob.org, sc.alice.org):
        with acting(conn, sc.bob.actor) as s:
            out = s.run(DELETE, [org, FOLDER["a"]])
        assert refused(out, "P0002"), (org, out)
    assert folder_row(conn, FOLDER["a"]) is not None
    assert set(folders_of(conn, FILED["a"]).values()) == {FOLDER["a"]}


def test_another_orgs_folder_and_a_made_up_one_are_the_same_refusal(conn, sc):
    with acting(conn, sc.bob.actor) as s:
        theirs = (s.run(SAVE, [None, FOLDER["a"], "x"]), s.run(DELETE, [None, FOLDER["a"]]),
                  s.run(MOVE, [sc.bob.org, FOLDER["a"], LOOSE["b"][:1]]))
        made_up = (s.run(SAVE, [None, str(uuid.uuid4()), "x"]), s.run(DELETE, [None, str(uuid.uuid4())]),
                   s.run(MOVE, [sc.bob.org, str(uuid.uuid4()), LOOSE["b"][:1]]))
    for t, m in zip(theirs, made_up):
        assert (t.sqlstate, t.error) == (m.sqlstate, m.error), (t, m)


@pytest.mark.parametrize("who", ["stranger", "anon"])
def test_outsiders_cannot_write(conn, sc, who):
    actor = {"stranger": sc.stranger, "anon": ANON}[who]
    with acting(conn, actor) as s:
        create = s.run(SAVE, [sc.alice.org, None, "x"])
        rename = s.run(SAVE, [None, FOLDER["a"], "x"])
        delete = s.run(DELETE, [None, FOLDER["a"]])
        move = s.run(MOVE, [sc.alice.org, None, FILED["a"]])
    assert refused(create, "42501"), create
    # anon may not even call them; a signed-in stranger is told "not found".
    for out in (rename, delete):
        assert (not out.ok) and out.sqlstate in ("42501", "P0002"), out
    assert refused(move, "42501"), move
    assert folder_row(conn, FOLDER["a"]) == (sc.alice.org, "Brand A")
    assert set(folders_of(conn, FILED["a"]).values()) == {FOLDER["a"]}


def test_a_viewer_reads_folders_but_cannot_write_them(conn, sc):
    # Dana is a viewer of the operator's default organization: she reads, she
    # does not write — the same rule channels and style kits follow.
    with as_superuser(conn, commit=False) as s:
        org = s.value("select public.default_org_id()::text")
    asset = register(conn, org, "default-org-file")
    with as_superuser(conn, commit=False) as s:
        folder = str(s.value("insert into public.media_folders (org_id, name) values (%s, 'Operator') returning id", [org]))
        become(s, sc.dana)
        assert s.value("select count(*) from public.media_folders where id = %s", [folder]) == 1
        outs = [s.run(SAVE, [org, None, "Dana's"]), s.run(SAVE, [None, folder, "renamed"]),
                s.run(DELETE, [None, folder]), s.run(MOVE, [org, folder, [asset]])]
    for out in outs:
        assert refused(out, "42501"), out


def test_no_api_role_writes_folders_or_folder_ids_directly(conn, sc):
    for who in (sc.alice.actor, sc.bob.actor, SERVICE):
        with acting(conn, who) as s:
            ins = s.run("insert into public.media_folders (org_id, name) values (%s, 'direct')", [sc.alice.org])
            upd = s.run("update public.media_folders set name = 'direct' where id = %s", [FOLDER["a"]])
            dele = s.run("delete from public.media_folders where id = %s", [FOLDER["a"]])
            mv = s.run("update public.media_assets set folder_id = null where id = any(%s::uuid[])", [FILED["a"]])
        for out in (ins, upd, dele, mv):
            assert (not out.ok) or out.rowcount == 0, (who.name, out)
    assert folder_row(conn, FOLDER["a"]) == (sc.alice.org, "Brand A")
    assert set(folders_of(conn, FILED["a"]).values()) == {FOLDER["a"]}


# ── moving files ────────────────────────────────────────────────────────────

def test_bob_cannot_move_his_files_into_alices_folder(conn, sc):
    with acting(conn, sc.bob.actor) as s:
        own_org = s.run(MOVE, [sc.bob.org, FOLDER["a"], LOOSE["b"]])
        her_org = s.run(MOVE, [sc.alice.org, FOLDER["a"], LOOSE["b"]])
    assert refused(own_org, "P0002"), own_org
    assert refused(her_org, "42501"), her_org
    assert set(folders_of(conn, LOOSE["b"]).values()) == {None}
    with as_superuser(conn, commit=False) as s:
        assert s.value("select count(*) from public.media_assets where folder_id = %s", [FOLDER["a"]]) == len(FILED["a"])


def test_bob_cannot_move_alices_files_into_his_folder_or_out_of_hers(conn, sc):
    with acting(conn, sc.bob.actor) as s:
        into_mine = s.run(MOVE, [sc.bob.org, FOLDER["b"], LOOSE["a"]])
        out_of_hers = s.run(MOVE, [sc.bob.org, None, FILED["a"]])
        as_her = s.run(MOVE, [sc.alice.org, None, FILED["a"]])
    assert refused(into_mine, "NS400", "invalid_asset"), into_mine
    assert refused(out_of_hers, "NS400", "invalid_asset"), out_of_hers
    assert refused(as_her, "42501"), as_her
    assert set(folders_of(conn, LOOSE["a"]).values()) == {None}
    assert set(folders_of(conn, FILED["a"]).values()) == {FOLDER["a"]}


def test_one_foreign_id_refuses_the_whole_move(conn, sc):
    mixed = [LOOSE["b"][0], LOOSE["a"][0], LOOSE["b"][1]]
    with acting(conn, sc.bob.actor) as s:
        out = s.run(MOVE, [sc.bob.org, FOLDER["b"], mixed])
    assert refused(out, "NS400", "invalid_asset"), out
    # All or nothing: Bob's own two did not move either.
    assert set(folders_of(conn, LOOSE["b"]).values()) == {None}


def test_another_orgs_file_and_a_made_up_one_are_the_same_refusal(conn, sc):
    with acting(conn, sc.bob.actor) as s:
        theirs = s.run(MOVE, [sc.bob.org, FOLDER["b"], [LOOSE["a"][1]]])
        made_up = s.run(MOVE, [sc.bob.org, FOLDER["b"], [str(uuid.uuid4())]])
    assert (theirs.sqlstate, theirs.error) == (made_up.sqlstate, made_up.error), (theirs, made_up)


def test_a_deleted_file_cannot_be_moved(conn, sc):
    with acting(conn, sc.bob.actor) as s:
        assert s.value("select public.soft_delete_asset(%s)", [LOOSE["b"][0]]) is True
        out = s.run(MOVE, [sc.bob.org, FOLDER["b"], [LOOSE["b"][0]]])
    assert refused(out, "NS400", "invalid_asset"), out


@pytest.mark.parametrize("ids,word", [
    ([], "no_assets"),
    ("too_many", "too_many_assets"),
    ("with_null", "invalid_asset"),
])
def test_move_size_is_bounded(conn, sc, ids, word):
    if ids == "too_many":
        ids = [LOOSE["b"][0]] + [str(uuid.uuid4()) for _ in range(200)]
    elif ids == "with_null":
        ids = [LOOSE["b"][0], None]
    with acting(conn, sc.bob.actor) as s:
        out = s.run(MOVE, [sc.bob.org, FOLDER["b"], ids])
    assert refused(out, "NS400", word), out


def test_a_member_moves_in_and_out_and_a_repeat_changes_nothing(conn, sc):
    with acting(conn, sc.alice.actor) as s:
        assert s.value(MOVE, [sc.alice.org, FOLDER["a"], LOOSE["a"]]) == 2
        # Already there: not an error, nothing changes.
        assert s.value(MOVE, [sc.alice.org, FOLDER["a"], LOOSE["a"] + LOOSE["a"]]) == 0
        assert s.value(MOVE, [sc.alice.org, None, LOOSE["a"]]) == 2
        assert s.value("select count(*) from public.media_assets where id = any(%s::uuid[]) and folder_id is null",
                       [LOOSE["a"]]) == 2


# ── the guard holds for every writer ────────────────────────────────────────

def test_even_the_owner_cannot_put_a_file_in_another_orgs_folder(conn, sc):
    with as_superuser(conn, commit=False) as s:
        out = s.run("update public.media_assets set folder_id = %s where id = %s", [FOLDER["a"], LOOSE["b"][0]])
        assert refused(out, "P0002"), out
        out = s.run("update public.media_assets set folder_id = %s where id = %s", [str(uuid.uuid4()), LOOSE["b"][0]])
        assert not out.ok, out


def test_deleting_a_folder_keeps_its_files_in_all_files(conn, sc):
    with acting(conn, sc.alice.actor) as s:
        assert s.value(DELETE, [sc.alice.org, FOLDER["a"]]) is True
        rows = s.rows("select folder_id, deleted_at from public.media_assets where id = any(%s::uuid[])", [FILED["a"]])
    assert rows == [(None, None)] * len(FILED["a"])
    # Rolled back: the seed is intact for the other tests.
    assert folder_row(conn, FOLDER["a"]) is not None


# ── names and limits ────────────────────────────────────────────────────────

@pytest.mark.parametrize("name", ["", "   ", "\t\n", "n" * 61])
def test_folder_names_are_bounded(conn, sc, name):
    with acting(conn, sc.bob.actor) as s:
        out = s.run(SAVE, [sc.bob.org, None, name])
    assert refused(out, "NS400", "invalid_name"), out


def test_names_are_cleaned_and_unique_per_org_ignoring_case(conn, sc):
    with acting(conn, sc.bob.actor) as s:
        clash = s.run(SAVE, [sc.bob.org, None, "  brand   b "])
        made = s.value(SAVE, [sc.bob.org, None, " Client\u0007  work\n2024 "])
        name = s.value("select name from public.media_folders where id = %s", [made])
        # Alice's folder name is free in Bob's org: unique per org, not globally.
        same_as_alices = s.run(SAVE, [sc.bob.org, None, "Brand A"])
        # Renaming a folder to its own name in another case is not a clash.
        recase = s.run(SAVE, [None, FOLDER["b"], "BRAND B"])
    assert refused(clash, "NS409", "name_taken"), clash
    assert name == "Client work 2024"
    assert same_as_alices.ok, same_as_alices
    assert recase.ok, recase


def test_the_org_cap_on_folders_holds(conn, sc):
    with as_superuser(conn, commit=False) as s:
        s.rows("insert into public.media_folders (org_id, name) select %s, 'filler ' || g "
               "from generate_series(1, 199) g returning 1", [sc.bob.org])
        become(s, sc.bob.actor)
        out = s.run(SAVE, [sc.bob.org, None, "One too many"])
        # Renaming is not creating: still allowed at the cap.
        rename = s.run(SAVE, [None, FOLDER["b"], "Renamed at the cap"])
    assert refused(out, "NS429", "limit_reached"), out
    assert rename.ok, rename

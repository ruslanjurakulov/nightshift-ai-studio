"""Named attacks on style kits and characters (migration 0047).

The table-by-table isolation tests already prove that Bob (org B) cannot read,
change, delete, move or insert Alice's (org A) kit, character and reference
rows. These prove the paths where the check lives in plpgsql or a trigger:
the two save functions, the reference guard (another organization's asset can
never become a reference, whoever writes the row), and a channel's default
kit (only a kit of the channel's own organization).

Every attack runs in a transaction that is rolled back.
"""

from __future__ import annotations

import uuid

import pytest

from sec_db import ANON, SERVICE, acting, as_superuser
from sec_style_0047 import CHARACTER, IMAGES, KIT, VIDEO, register

SAVE_KIT = "select public.save_style_kit(%s, %s, %s, %s, %s::uuid[])"
SAVE_CHAR = "select public.save_character(%s, %s, %s, %s, %s, %s::uuid[])"


def kit_row(conn, kit: str):
    with as_superuser(conn, commit=False) as s:
        rows = s.rows("select org_id::text, name, description from public.style_kits where id = %s", [kit])
        refs = s.rows("select asset_id::text from public.style_kit_references where kit_id = %s order by position", [kit])
    return (rows[0] if rows else None), [r[0] for r in refs]


def char_row(conn, ch: str):
    with as_superuser(conn, commit=False) as s:
        rows = s.rows("select org_id::text, name, description from public.characters where id = %s", [ch])
        refs = s.rows("select asset_id::text from public.character_references where character_id = %s order by position", [ch])
    return (rows[0] if rows else None), [r[0] for r in refs]


def channel_kit(conn, channel: str):
    with as_superuser(conn, commit=False) as s:
        v = s.value("select default_style_kit_id::text from public.channels where channel_id = %s", [channel])
    return v


# ── reading ─────────────────────────────────────────────────────────────────

@pytest.mark.parametrize("table", ["style_kits", "characters", "style_kit_references", "character_references"])
def test_another_org_reads_nothing_of_alices(conn, sc, table):
    for who in (sc.bob.actor, sc.stranger, sc.dana, ANON):
        with acting(conn, who) as s:
            out = s.run(f"select count(*) from public.{table} where org_id = %s", [sc.alice.org])
        assert (not out.ok) or out.rows == [(0,)], f"{table} as {who.name}: {out!r}"
    # Positive control: Alice does see her own.
    with acting(conn, sc.alice.actor) as s:
        assert s.value(f"select count(*) from public.{table} where org_id = %s", [sc.alice.org]) >= 1


# ── writing through the save functions ──────────────────────────────────────

def test_bob_cannot_create_a_kit_in_alices_org(conn, sc):
    with acting(conn, sc.bob.actor) as s:
        out = s.run(SAVE_KIT, [sc.alice.org, None, "Mine now", "", IMAGES["b"][:3]])
    assert not out.ok and out.sqlstate == "42501", out


def test_bob_cannot_overwrite_alices_kit(conn, sc):
    before = kit_row(conn, KIT["a"])
    for org in (None, sc.bob.org, sc.alice.org):
        with acting(conn, sc.bob.actor) as s:
            out = s.run(SAVE_KIT, [org, KIT["a"], "pwned", "pwned", IMAGES["b"][:3]])
        # Another org's kit reads as missing, never as "forbidden".
        assert not out.ok and out.sqlstate == "P0002", (org, out)
    assert kit_row(conn, KIT["a"]) == before


def test_bob_cannot_overwrite_alices_character(conn, sc):
    before = char_row(conn, CHARACTER["a"])
    with acting(conn, sc.bob.actor) as s:
        out = s.run(SAVE_CHAR, [None, CHARACTER["a"], "pwned", "character", "", IMAGES["b"][:1]])
    assert not out.ok and out.sqlstate == "P0002", out
    assert char_row(conn, CHARACTER["a"]) == before


@pytest.mark.parametrize("who", ["stranger", "anon", "dana"])
def test_outsiders_cannot_save(conn, sc, who):
    actor = {"stranger": sc.stranger, "anon": ANON, "dana": sc.dana}[who]
    with acting(conn, actor) as s:
        kit = s.run(SAVE_KIT, [sc.alice.org, None, "x", "", IMAGES["a"][:3]])
        ch = s.run(SAVE_CHAR, [sc.alice.org, None, "villain", "character", "", IMAGES["a"][:1]])
    assert not kit.ok and kit.sqlstate == "42501", kit
    assert not ch.ok and ch.sqlstate == "42501", ch


def test_a_viewer_of_an_org_cannot_write_its_kits(conn, sc):
    # Dana is a viewer of the operator's default organization: she reads, she
    # does not write — the same rule channels follow.
    with as_superuser(conn, commit=False) as s:
        default_org = s.value("select public.default_org_id()::text")
    img = register(conn, default_org, "default-org-img-1")
    with acting(conn, sc.dana) as s:
        out = s.run(SAVE_CHAR, [default_org, None, "op_hero", "character", "", [img]])
    assert not out.ok and out.sqlstate == "42501", out


# ── references must be the same organization's ─────────────────────────────

def test_bob_cannot_reference_alices_asset_in_his_kit(conn, sc):
    mixed = [IMAGES["b"][0], IMAGES["b"][1], IMAGES["a"][0]]
    with acting(conn, sc.bob.actor) as s:
        create = s.run(SAVE_KIT, [sc.bob.org, None, "Stolen look", "", mixed])
        update = s.run(SAVE_KIT, [None, KIT["b"], "Stolen look", "", mixed])
    for out in (create, update):
        assert not out.ok and out.sqlstate == "NS400" and "invalid_reference" in (out.error or ""), out
    assert IMAGES["a"][0] not in kit_row(conn, KIT["b"])[1]


def test_bob_cannot_reference_alices_asset_in_his_character(conn, sc):
    with acting(conn, sc.bob.actor) as s:
        out = s.run(SAVE_CHAR, [sc.bob.org, None, "copycat", "character", "", [IMAGES["a"][0]]])
    assert not out.ok and out.sqlstate == "NS400" and "invalid_reference" in (out.error or ""), out


def test_an_unknown_asset_and_another_orgs_asset_are_the_same_refusal(conn, sc):
    with acting(conn, sc.bob.actor) as s:
        theirs = s.run(SAVE_CHAR, [sc.bob.org, None, "probe", "character", "", [IMAGES["a"][1]]])
        made_up = s.run(SAVE_CHAR, [sc.bob.org, None, "probe", "character", "", [str(uuid.uuid4())]])
    assert (theirs.sqlstate, theirs.error) == (made_up.sqlstate, made_up.error), (theirs, made_up)


def test_even_the_service_role_and_owner_cannot_write_a_cross_org_reference(conn, sc):
    # The trigger is the last line: a reference row pointing at another
    # organization's asset is refused for every writer, not just the functions.
    with as_superuser(conn, commit=False) as s:
        out = s.run("insert into public.style_kit_references (kit_id, org_id, asset_id, position) "
                    "values (%s, %s, %s, 5)", [KIT["b"], sc.bob.org, IMAGES["a"][2]])
        assert not out.ok and out.sqlstate == "NS400", out
        # Claiming the asset's org instead breaks the kit's composite key.
        out = s.run("insert into public.style_kit_references (kit_id, org_id, asset_id, position) "
                    "values (%s, %s, %s, 5)", [KIT["b"], sc.alice.org, IMAGES["a"][2]])
        assert not out.ok and out.sqlstate == "23503", out
        out = s.run("insert into public.character_references (character_id, org_id, asset_id, position) "
                    "values (%s, %s, %s, 5)", [CHARACTER["b"], sc.bob.org, IMAGES["a"][2]])
        assert not out.ok and out.sqlstate == "NS400", out
    with acting(conn, SERVICE) as s:
        out = s.run("insert into public.style_kit_references (kit_id, org_id, asset_id, position) "
                    "values (%s, %s, %s, 5)", [KIT["b"], sc.bob.org, IMAGES["a"][2]])
        assert not out.ok, out


@pytest.mark.parametrize("table", ["style_kit_references", "character_references"])
def test_no_api_role_writes_references_directly(conn, sc, table):
    owner = "kit_id" if table == "style_kit_references" else "character_id"
    target = KIT["b"] if table == "style_kit_references" else CHARACTER["b"]
    for who in (sc.bob.actor, SERVICE):
        with acting(conn, who) as s:
            ins = s.run(f"insert into public.{table} ({owner}, org_id, asset_id, position) values (%s, %s, %s, 6)",
                        [target, sc.bob.org, IMAGES["b"][4]])
            dele = s.run(f"delete from public.{table} where {owner} = %s", [target])
        assert not ins.ok and ins.sqlstate == "42501", (who.name, ins)
        assert not dele.ok and dele.sqlstate == "42501", (who.name, dele)


def test_a_video_or_deleted_asset_is_not_a_reference(conn, sc):
    with acting(conn, sc.bob.actor) as s:
        video = s.run(SAVE_CHAR, [sc.bob.org, None, "clip", "character", "", [VIDEO["b"]]])
        assert not video.ok and video.sqlstate == "NS400", video
        assert s.value("select public.soft_delete_asset(%s)", [IMAGES["b"][4]]) is True
        gone = s.run(SAVE_CHAR, [sc.bob.org, None, "ghost", "character", "", [IMAGES["b"][4]]])
        assert not gone.ok and gone.sqlstate == "NS400", gone


# ── limits ──────────────────────────────────────────────────────────────────

@pytest.mark.parametrize("n,code", [(2, "too_few_references"), (13, "too_many_references")])
def test_kit_reference_count_is_bounded(conn, sc, n, code):
    extra = [register(conn, sc.bob.org, f"b-bulk-{i}") for i in range(13)]
    with acting(conn, sc.bob.actor) as s:
        out = s.run(SAVE_KIT, [sc.bob.org, None, "Bounds", "", extra[:n]])
    assert not out.ok and out.sqlstate == "NS400" and code in (out.error or ""), out


def test_character_reference_count_is_bounded(conn, sc):
    nine = [register(conn, sc.bob.org, f"b-char-bulk-{i}") for i in range(9)]
    with acting(conn, sc.bob.actor) as s:
        none = s.run(SAVE_CHAR, [sc.bob.org, None, "empty", "character", "", []])
        many = s.run(SAVE_CHAR, [sc.bob.org, None, "crowd", "character", "", nine])
        dup = s.run(SAVE_CHAR, [sc.bob.org, None, "twice", "character", "", [nine[0], nine[0]]])
    assert not none.ok and "too_few_references" in (none.error or ""), none
    assert not many.ok and "too_many_references" in (many.error or ""), many
    assert not dup.ok and "duplicate_reference" in (dup.error or ""), dup


def test_the_minimum_holds_at_commit_for_any_writer(conn, sc):
    # The owner writing a kit with a single reference directly: the deferred
    # count check refuses it when the transaction commits.
    import psycopg

    with pytest.raises(psycopg.Error) as e:
        with as_superuser(conn) as s:
            kit = s.value("insert into public.style_kits (org_id, name) values (%s, 'Thin') returning id", [sc.bob.org])
            s.rows("insert into public.style_kit_references (kit_id, org_id, asset_id, position) "
                   "values (%s, %s, %s, 0) returning 1", [kit, sc.bob.org, IMAGES["b"][0]])
    assert e.value.sqlstate == "NS400"
    with as_superuser(conn, commit=False) as s:
        assert s.value("select count(*) from public.style_kits where name = 'Thin'") == 0


@pytest.mark.parametrize("name,description,code", [
    ("x" * 61, "", "invalid_name"),
    ("   ", "", "invalid_name"),
    ("ok", "d" * 2001, "invalid_description"),
])
def test_kit_text_sizes_are_bounded(conn, sc, name, description, code):
    with acting(conn, sc.bob.actor) as s:
        out = s.run(SAVE_KIT, [sc.bob.org, None, name, description, IMAGES["b"][:3]])
    assert not out.ok and out.sqlstate == "NS400" and code in (out.error or ""), out


@pytest.mark.parametrize("name", ["a", "Has Space", "x" * 33, "émoji", "a-b", "", "@"])
def test_character_names_follow_the_pattern(conn, sc, name):
    with acting(conn, sc.bob.actor) as s:
        out = s.run(SAVE_CHAR, [sc.bob.org, None, name, "character", "", IMAGES["b"][:1]])
    assert not out.ok and out.sqlstate == "NS400" and "invalid_name" in (out.error or ""), out


def test_character_names_are_unique_per_org_not_globally(conn, sc):
    # Both seeded tenants already have @hero; a second one in org B is taken.
    with acting(conn, sc.bob.actor) as s:
        out = s.run(SAVE_CHAR, [sc.bob.org, None, "@Hero", "product", "", IMAGES["b"][1:2]])
        ok = s.value(SAVE_CHAR, [sc.bob.org, None, "@Sidekick_2", "product", "", IMAGES["b"][1:2]])
        name = s.value("select name from public.characters where id = %s", [ok])
    assert not out.ok and out.sqlstate == "NS409", out
    assert name == "sidekick_2"


def test_the_org_cap_on_kits_holds(conn, sc):
    with as_superuser(conn, commit=False) as s:
        s.rows("insert into public.style_kits (org_id, name) select %s, 'filler ' || g "
               "from generate_series(1, 49) g returning 1", [sc.bob.org])
        s.conn.execute("select set_config('request.jwt.claims', %s, true)",
                       [f'{{"role": "authenticated", "sub": "{sc.bob.actor.uid}", "email": "{sc.bob.actor.email}"}}'])
        s.conn.execute("set local role authenticated")
        out = s.run(SAVE_KIT, [sc.bob.org, None, "One too many", "", IMAGES["b"][:3]])
    assert not out.ok and out.sqlstate == "NS429", out


# ── deleting ────────────────────────────────────────────────────────────────

def test_bob_cannot_delete_alices_kit_or_character(conn, sc):
    with acting(conn, sc.bob.actor) as s:
        k = s.run("delete from public.style_kits where id = %s", [KIT["a"]])
        c = s.run("delete from public.characters where id = %s", [CHARACTER["a"]])
    assert k.ok and k.rowcount == 0, k
    assert c.ok and c.rowcount == 0, c
    assert kit_row(conn, KIT["a"])[0] is not None
    assert char_row(conn, CHARACTER["a"])[0] is not None


def test_deleting_a_kit_clears_the_channel_default_and_its_references(conn, sc):
    with acting(conn, sc.alice.actor) as s:
        out = s.run("delete from public.style_kits where id = %s", [KIT["a"]])
        assert out.ok and out.rowcount == 1, out
        s.conn.execute("reset role")
        assert s.value("select default_style_kit_id from public.channels where channel_id = %s", [sc.alice.channel]) is None
        assert s.value("select count(*) from public.style_kit_references where kit_id = %s", [KIT["a"]]) == 0
    # Rolled back: the seed is intact for the other tests.
    assert channel_kit(conn, sc.alice.channel) == KIT["a"]


# ── a channel's default kit ─────────────────────────────────────────────────

def test_bob_cannot_attach_alices_kit_to_his_channel(conn, sc):
    with acting(conn, sc.bob.actor) as s:
        out = s.run("update public.channels set default_style_kit_id = %s where channel_id = %s",
                    [KIT["a"], sc.bob.channel])
    assert not out.ok and out.sqlstate == "P0002", out
    assert channel_kit(conn, sc.bob.channel) == KIT["b"]


def test_bob_cannot_attach_a_kit_to_alices_channel(conn, sc):
    for kit in (KIT["b"], None):
        with acting(conn, sc.bob.actor) as s:
            out = s.run("update public.channels set default_style_kit_id = %s where channel_id = %s",
                        [kit, sc.alice.channel])
        assert (not out.ok) or out.rowcount == 0, out
    assert channel_kit(conn, sc.alice.channel) == KIT["a"]


def test_no_writer_can_point_a_channel_at_another_orgs_kit(conn, sc):
    with acting(conn, SERVICE) as s:
        out = s.run("update public.channels set default_style_kit_id = %s where channel_id = %s",
                    [KIT["a"], sc.bob.channel])
    assert not out.ok and out.sqlstate == "P0002", out
    with as_superuser(conn, commit=False) as s:
        out = s.run("insert into public.channels (channel_id, name, niche, status, org_id, default_style_kit_id) "
                    "values ('chan-sneak', 'Sneak', 'tech', 'PAUSED', %s, %s)", [sc.bob.org, KIT["a"]])
    assert not out.ok and out.sqlstate == "P0002", out


def test_moving_a_channel_leaves_its_old_orgs_kit_behind(conn, sc):
    with as_superuser(conn, commit=False) as s:
        s.rows("update public.channels set org_id = %s where channel_id = %s returning 1",
               [sc.alice.org, sc.bob.channel])
        assert s.value("select default_style_kit_id from public.channels where channel_id = %s",
                       [sc.bob.channel]) is None

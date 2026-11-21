"""Migration 0119: an editor can no longer RAISE or REMOVE a channel's monthly spend limit, and the Channels page writes its
settings through one atomic function.

The attacker is an editor of an ordinary customer organization (alice's), writing the row the way the Command Center does
(PostgREST: UPDATE on channels, and the patch_channel_agent_config RPC), and the same person holding a stale page. What must
NOT change is checked beside it: setting a first limit, keeping it, lowering it, every other key of the blob, the
administrator, the service role and the definer functions.

The cases are command-center/tests/fixtures/channel-risk-cases.json, the file the worker's reader and the page are tested
with: `stored` binds the SQL reading of a value to the worker's, `changes` is who may move a limit from what to what.

Everything runs on the shared, rolled-back scenario (conftest ``conn`` / ``sc``), except the concurrency tests, which need
two committed sessions and clean up after themselves.
"""

from __future__ import annotations

import json
import random
import re
import sys
import threading
import time
import uuid
from decimal import Decimal

import psycopg
import pytest
from psycopg import sql

import sec_db
from sec_db import ANON, SERVICE, acting, as_superuser, user
from sec_dna_0056 import SET_DNA, VOICE

sys.path.insert(0, str(__import__("pathlib").Path(__file__).resolve().parents[2]))
from modules.channels import AgentConfig, _as_optional_float  # noqa: E402  (the reader the SQL mirror must agree with)

MIGRATION = sec_db.REPO / "supabase" / "migrations" / "0119_channel_settings_guard.sql"
M0117 = sec_db.REPO / "supabase" / "migrations" / "0117_voice_profiles.sql"
ROLLBACK = sec_db.REPO / "docs" / "sql" / "rollback_0119_channel_settings_guard.sql"
FIXTURE_FILE = sec_db.REPO / "command-center" / "tests" / "fixtures" / "channel-risk-cases.json"

KEY = "spend_ceiling_usd"
RPC = "select public.patch_channel_agent_config(%s, %s::jsonb)"
ABSENT = object()


# -- the shared cases ---------------------------------------------------------------------------------------------------

def _raw(value) -> str:
    """The JSON text of a fixture value, with numbers kept EXACTLY as written (1e400 is a number the worker reads as inf)."""
    if isinstance(value, Decimal):
        return format(value, "f")
    if isinstance(value, list):
        return "[" + ",".join(_raw(v) for v in value) + "]"
    if isinstance(value, dict):
        return "{" + ",".join(json.dumps(k) + ":" + _raw(v) for k, v in value.items()) + "}"
    return json.dumps(value)


_TEXT = FIXTURE_FILE.read_text(encoding="utf-8")
EXACT = json.loads(_TEXT, parse_float=Decimal, parse_int=Decimal)
NATIVE = json.loads(_TEXT)
STORED = [(_raw(e["raw"]), n["worker"], n["raw"]) for e, n in zip(EXACT["stored"], NATIVE["stored"])]
CHANGES = [(c["why"], _raw(c["old"]) if "old" in c else ABSENT, _raw(c["new"]) if "new" in c else ABSENT, c["editor"])
           for c in EXACT["changes"]]
CHANGE_IDS = [c[0] for c in CHANGES]


# -- plumbing -----------------------------------------------------------------------------------------------------------

def become(s, who):
    """Continue the same transaction as another API caller (the database owner when who is None)."""
    s.conn.execute("reset role")
    if who is None:
        s.conn.execute("select set_config('request.jwt.claims', '', true)")
        return s
    s.conn.execute("select set_config('request.jwt.claims', %s, true)", [json.dumps(who.claims())])
    s.conn.execute(sql.SQL("set local role {}").format(sql.Identifier(who.role)))
    return s


def put(s, channel, raw):
    """The database owner stores the limit exactly as given (raw JSON text, or no key)."""
    become(s, None)
    if raw is ABSENT:
        s.conn.execute("update public.channels set agent_config = agent_config - %s where channel_id = %s", [KEY, channel])
    else:
        s.conn.execute("update public.channels set agent_config = jsonb_set(agent_config, %s, %s::jsonb) where channel_id = %s",
                       [[KEY], raw, channel])


def holds(s, channel, raw) -> bool:
    """Is the stored limit exactly `raw` (jsonb equality; no key for ABSENT)?"""
    become(s, None)
    if raw is ABSENT:
        return s.value("select not (agent_config ? %s) from public.channels where channel_id = %s", [KEY, channel])
    return s.value("select (agent_config -> %s) is not distinct from %s::jsonb from public.channels where channel_id = %s",
                   [KEY, raw, channel])


def config(s, channel) -> dict:
    become(s, None)
    return s.value("select agent_config from public.channels where channel_id = %s", [channel]) or {}


def direct(s, channel, raw):
    """What a script with an editor's session sends: one UPDATE of the blob with the limit set, or the key removed."""
    if raw is ABSENT:
        return s.run("update public.channels set agent_config = agent_config - %s where channel_id = %s", [KEY, channel])
    return s.run("update public.channels set agent_config = jsonb_set(agent_config, %s, %s::jsonb) where channel_id = %s",
                 [[KEY], raw, channel])


def via_rpc(s, channel, raw):
    return s.run(RPC, [channel, json.dumps({KEY: None}) if raw is ABSENT else '{"%s": %s}' % (KEY, raw)])


def locked(out) -> bool:
    return (not out.ok) and out.sqlstate == "42501" and "spend_ceiling_lock" in (out.error or "")


def error_of(conn, who, query, params):
    """(sqlstate, hint, message) of a statement that must fail, as `who`."""
    with acting(conn, who) as s:
        try:
            s.conn.execute(query, params)
        except psycopg.Error as e:
            return e.diag.sqlstate, e.diag.message_hint, e.diag.message_primary
    raise AssertionError("the statement was not refused")


class World:
    pass


@pytest.fixture()
def world(conn, sc):
    """A rolled-back transaction in which alice's organization has a viewer, an editor and an admin besides its owner, and
    the channel carries a limit of 50 and the seeded voice/language."""
    with as_superuser(conn, commit=False) as su:
        w = World()
        w.su = su
        w.channel = sc.alice.channel
        w.members = {}
        for role in ("viewer", "editor", "admin"):
            who = user(f"cs-{role}", f"cs-{role}@a.test")
            su.rows("insert into auth.users (id, email, email_confirmed_at) values (%s, %s, now()) returning 1", [who.uid, who.email])
            su.rows("insert into public.org_members (org_id, user_id, email, role) values (%s, %s, %s, %s) returning 1",
                    [sc.alice.org, who.uid, who.email, role])
            w.members[role] = who
        w.members["owner"] = sc.alice.actor
        w.viewer, w.editor, w.admin, w.owner = (w.members[r] for r in ("viewer", "editor", "admin", "owner"))
        w.bob = sc.bob.actor
        w.stranger = sc.stranger
        put(su, w.channel, "50")
        yield w


# -- the SQL reading of a value is the worker's -------------------------------------------------------------------------

def _sql_ceilings(s, raws):
    """channel_spend_ceiling of each JSON text, in order (one round trip)."""
    become(s, None)
    rows = s.rows("select t.i, public.channel_spend_ceiling(t.v) from jsonb_array_elements(%s::jsonb) with ordinality t(v, i) order by 1",
                  ["[" + ",".join(raws) + "]"])
    assert [r[0] for r in rows] == list(range(1, len(raws) + 1))
    return [r[1] for r in rows]


def test_the_sql_reading_of_every_stored_shape_in_the_fixture_is_what_the_worker_enforces(conn):
    with as_superuser(conn, commit=False) as s:
        got = _sql_ceilings(s, [raw for raw, _w, _n in STORED])
    for (raw, worker, native), mine in zip(STORED, got):
        assert mine == worker, (raw, mine, worker)
        assert _as_optional_float(native) == worker, "the fixture and the worker disagree: fix the fixture first"
        assert AgentConfig.from_dict({KEY: native}).spend_ceiling_usd == worker


def test_a_missing_key_and_sql_null_are_no_limit(conn):
    with as_superuser(conn, commit=False) as s:
        assert s.value("select public.channel_spend_ceiling(null)") is None
        assert s.value("select public.channel_spend_ceiling('{}'::jsonb -> 'spend_ceiling_usd')") is None
        assert s.value("select public.channel_spend_ceiling('null'::jsonb)") is None


def _random_texts(rnd: random.Random, n: int):
    alphabet = "0123456789.eE+- \t\n\r\f\v ٢۵_xXnaif﻿ ​\u0085"
    out = []
    for _ in range(n):
        out.append("".join(rnd.choice(alphabet) for _ in range(rnd.randint(0, 9))))
    ws = [" ", "\t", "\n", "\r", "\f", "\v", ""]
    for _ in range(n):   # shaped like numbers, so most of them are valid
        digits = "".join(rnd.choice("0123456789") for _ in range(rnd.randint(0, 24)))
        frac = "." + "".join(rnd.choice("0123456789") for _ in range(rnd.randint(0, 24))) if rnd.random() < 0.5 else ""
        exp = rnd.choice(["e", "E"]) + rnd.choice(["", "+", "-"]) + str(rnd.choice([0, 1, 2, 5, 10, 100, 307, 308, 309, 320, 323, 324, 325, 400, 99999]))\
            if rnd.random() < 0.4 else ""
        out.append(rnd.choice(ws) + rnd.choice(["", "+", "-"]) + digits + frac + exp + rnd.choice(ws))
    return out


def test_the_sql_reading_agrees_with_the_workers_reader_on_random_text(conn):
    """6000 strings, half of them number-shaped (signs, decimals, exponents up to overflow and underflow, white space of every ASCII
    kind), half random from an alphabet that holds the look-alikes (NBSP, BOM, Arabic-Indic digits, underscore, hex, nan, inf)."""
    texts = _random_texts(random.Random(119), 3000)
    with as_superuser(conn, commit=False) as s:
        got = _sql_ceilings(s, [json.dumps(t) for t in texts])
    bad = [(t, a, _as_optional_float(t)) for t, a in zip(texts, got) if a != _as_optional_float(t)]
    assert bad == [], bad[:10]
    assert sum(1 for g in got if g is not None) > 500, "the corpus must exercise valid numbers, not only refusals"


def test_the_sql_reading_agrees_with_the_workers_reader_on_json_numbers(conn):
    rnd = random.Random(1190)
    texts = ["0", "-0", "-0.0", "1", "25", "25.5", "1e308", "1.7976931348623157e308", "1.7976931348623159e308", "1e309", "1e400",
             "5e-324", "4e-324", "1e-323", "1e-400", "1" + "0" * 400, "-1" + "0" * 400, "123456789012345678901234567890",
             "0.1", "0.30000000000000004", "9007199254740993", "9007199254740992.5"]
    for _ in range(1500):
        whole = str(rnd.randint(0, 9)) if rnd.random() < 0.3 else str(rnd.randint(1, 9)) + "".join(rnd.choice("0123456789") for _ in range(rnd.randint(0, 29)))
        frac = "." + "".join(rnd.choice("0123456789") for _ in range(rnd.randint(1, 30))) if rnd.random() < 0.5 else ""
        exp = rnd.choice("eE") + rnd.choice(["", "+", "-"]) + str(rnd.randint(0, 420)) if rnd.random() < 0.6 else ""
        texts.append(rnd.choice(["", "-"]) + whole + frac + exp)
    with as_superuser(conn, commit=False) as s:
        got = _sql_ceilings(s, texts)
    bad = []
    for t, a in zip(texts, got):
        want = _as_optional_float(json.loads(t))
        if a != want:
            bad.append((t, a, want))
    assert bad == [], bad[:10]


# -- the lock: the fixture's change cases -------------------------------------------------------------------------------

@pytest.mark.parametrize("why,old,new,verdict", CHANGES, ids=CHANGE_IDS)
def test_an_editor_is_held_to_the_fixture_by_a_direct_update(conn, sc, world, why, old, new, verdict):
    put(world.su, world.channel, old)
    become(world.su, world.editor)
    out = direct(world.su, world.channel, new)
    if verdict == "allowed":
        assert out.ok and out.rowcount == 1, out
        assert holds(world.su, world.channel, new)
    else:
        assert locked(out), out
        assert holds(world.su, world.channel, old), "the refused write left its value behind"


@pytest.mark.parametrize("why,old,new,verdict", CHANGES, ids=CHANGE_IDS)
def test_an_administrator_and_the_owner_may_make_every_change_in_the_fixture(conn, sc, world, why, old, new, verdict):
    for who in (world.admin, world.owner):
        put(world.su, world.channel, old)
        become(world.su, who)
        out = direct(world.su, world.channel, new)
        assert out.ok and out.rowcount == 1, (who.name, out)
        assert holds(world.su, world.channel, new)


@pytest.mark.parametrize("why,old,new,verdict", CHANGES, ids=CHANGE_IDS)
def test_the_service_role_may_make_every_change_in_the_fixture(conn, sc, world, why, old, new, verdict):
    put(world.su, world.channel, old)
    become(world.su, SERVICE)
    out = direct(world.su, world.channel, new)
    assert out.ok and out.rowcount == 1, out
    assert holds(world.su, world.channel, new)




def _rpc_accepts_number(raw: str) -> bool:
    v = json.loads(raw)
    return isinstance(v, (int, float)) and not isinstance(v, bool) and 0 < v <= 1_000_000


@pytest.mark.parametrize("why,old,new,verdict", CHANGES, ids=CHANGE_IDS)
def test_the_rpc_never_lets_an_editor_do_what_the_table_refuses(conn, sc, world, why, old, new, verdict):
    """Through patch_channel_agent_config the same change is refused, by the lock or because the function takes only a number
    above 0 (text, a list, a boolean never reach the blob); a change the lock allows and the function can express goes through."""
    put(world.su, world.channel, old)
    become(world.su, world.editor)
    out = via_rpc(world.su, world.channel, new)
    if verdict == "refused":
        assert not out.ok and out.sqlstate in ("42501", "22023"), out
        assert holds(world.su, world.channel, old), "the refused patch left its value behind"
    elif new is ABSENT or json.loads(new) is None:
        assert out.ok, out
        assert holds(world.su, world.channel, ABSENT)
    elif _rpc_accepts_number(new):
        assert out.ok, out
        assert holds(world.su, world.channel, new)
    else:
        assert not out.ok and out.sqlstate == "22023", out    # text and the like are for the table; the function stores numbers


HINT_STATEMENTS = [
    ("update public.channels set agent_config = agent_config || '{\"spend_ceiling_usd\": 500}'::jsonb where channel_id = %s", None),
    (RPC, '{"spend_ceiling_usd": 500}'),
    (RPC, '{"spend_ceiling_usd": null}'),
]


@pytest.mark.parametrize("query,patch", HINT_STATEMENTS, ids=["update", "rpc raise", "rpc remove"])
def test_the_refusal_names_the_hint_the_command_center_maps(conn, sc, world, query, patch):
    become(world.su, world.editor)
    params = [world.channel] if patch is None else [world.channel, patch]
    with pytest.raises(psycopg.errors.InsufficientPrivilege) as raised:
        world.su.conn.execute(query, params)
    d = raised.value.diag
    assert d.sqlstate == "42501" and d.message_hint == "spend_ceiling_lock", d.message_primary
    assert d.message_primary.startswith("spend_ceiling_lock:")


# -- the ways round, one by one -----------------------------------------------------------------------------------------

def test_an_editor_cannot_dodge_by_replacing_the_blob_nesting_the_write_or_deleting_the_key(conn, sc, world):
    become(world.su, world.editor)
    ch = world.channel
    attacks = [
        "update public.channels set agent_config = '{}'::jsonb where channel_id = %s",
        "update public.channels set agent_config = '[]'::jsonb where channel_id = %s",
        "update public.channels set agent_config = 'null'::jsonb where channel_id = %s",
        "update public.channels set agent_config = '5'::jsonb where channel_id = %s",
        "update public.channels set agent_config = '{\"spend_ceiling_usd\": 5000}'::jsonb where channel_id = %s",
        "update public.channels set agent_config = agent_config - 'spend_ceiling_usd' where channel_id = %s",
        "update public.channels set agent_config = agent_config #- '{spend_ceiling_usd}' where channel_id = %s",
        "update public.channels set agent_config = jsonb_set(agent_config, '{spend_ceiling_usd}', '5000') where channel_id = %s",
        "update public.channels set agent_config = jsonb_set(agent_config, '{spend_ceiling_usd}', '\"5000\"') where channel_id = %s",
        "update public.channels set agent_config = jsonb_set(agent_config, '{spend_ceiling_usd}', 'null') where channel_id = %s",
        "update public.channels set agent_config = coalesce(agent_config, '{}') || '{\"spend_ceiling_usd\": 5000, \"language\": \"Russian\"}' where channel_id = %s",
        "update public.channels set agent_config = (agent_config - 'spend_ceiling_usd') || '{\"Spend_Ceiling_USD\": 1}' where channel_id = %s",
        "update public.channels set agent_config = agent_config || jsonb_build_object('spend_ceiling_usd', 1e400::numeric) where channel_id = %s",
    ]
    for attack in attacks:
        out = world.su.run(attack, [ch] * attack.count("%s"))
        assert not out.ok and out.sqlstate in ("42501", "0A000", "21000"), (attack, out)
        become(world.su, world.editor)
    assert holds(world.su, ch, "50")
    become(world.su, world.editor)


def test_two_writes_in_one_transaction_each_judged_against_the_row_before_it(conn, sc, world):
    """Lowering to 10 is the editor's; raising back to 40 afterwards is not, even though 40 is below what the page was drawn with."""
    become(world.su, world.editor)
    assert direct(world.su, world.channel, "10").ok
    assert locked(direct(world.su, world.channel, "40"))
    assert holds(world.su, world.channel, "10")


def test_a_limit_the_worker_ignores_does_not_lock_anything(conn, sc, world):
    """A stored 'abc' is no limit (the worker enforces nothing), so an editor may set a real one over it, and removing it is no change."""
    for junk in ('"abc"', "0", "true", "[]", "null", '"\\u0662\\u0665"'):
        put(world.su, world.channel, junk)
        become(world.su, world.editor)
        assert direct(world.su, world.channel, "25").ok
        put(world.su, world.channel, junk)
        become(world.su, world.editor)
        assert direct(world.su, world.channel, ABSENT).ok


def test_unrelated_edits_of_a_channel_that_has_a_limit_still_succeed(conn, sc, world):
    ch = world.channel
    become(world.su, world.editor)
    assert world.su.run("update public.channels set name = 'Renamed' where channel_id = %s", [ch]).rowcount == 1
    assert world.su.run("update public.channels set schedule_config = schedule_config || '{\"time\": \"07:00\"}' where channel_id = %s", [ch]).ok
    # the Voice / Cast / Style editors write back the blob they loaded with one key changed
    whole = config(world.su, ch)
    become(world.su, world.editor)
    out = world.su.run("update public.channels set agent_config = %s::jsonb where channel_id = %s",
                       [json.dumps(whole | {"language": "Russian", "tts_provider": "edge"}), ch])
    assert out.ok and out.rowcount == 1, out
    assert config(world.su, ch)[KEY] == 50 and config(world.su, ch)["language"] == "Russian"
    # ... and a page drawn before an administrator LOWERED the limit would put the old, higher one back: refused, not silent
    stale = whole | {KEY: 80}
    become(world.su, world.editor)
    assert locked(world.su.run("update public.channels set agent_config = %s::jsonb where channel_id = %s", [json.dumps(stale), ch]))
    # ... and one drawn before an administrator SET it would drop it: refused too
    become(world.su, world.editor)
    assert locked(world.su.run("update public.channels set agent_config = %s::jsonb where channel_id = %s",
                               [json.dumps({k: v for k, v in whole.items() if k != KEY}), ch]))
    assert config(world.su, ch)[KEY] == 50


def test_the_other_controls_are_still_an_administrators_and_the_two_locks_do_not_mask_each_other(conn, sc, world):
    ch = world.channel
    become(world.su, world.editor)
    out = world.su.run("update public.channels set agent_config = agent_config || '{\"storyboard_review\": true}' where channel_id = %s", [ch])
    assert not out.ok and out.sqlstate == "42501" and "only an administrator of this organization may change" in out.error, out
    become(world.su, world.editor)
    out = world.su.run("update public.channels set agent_config = agent_config || '{\"ai_disclosure\": \"never\"}' where channel_id = %s", [ch])
    assert not out.ok and "ai_disclosure_lock" in out.error, out
    become(world.su, world.admin)
    out = world.su.run("update public.channels set agent_config = agent_config || '{\"storyboard_review\": true, \"spend_ceiling_usd\": 5000}' where channel_id = %s", [ch])
    assert out.ok and out.rowcount == 1, out


# -- who is held to it --------------------------------------------------------------------------------------------------

@pytest.mark.parametrize("role", ["viewer", "stranger", "bob"])
def test_someone_who_cannot_write_the_channel_still_cannot(conn, sc, world, role):
    who = {"viewer": world.viewer, "stranger": world.stranger, "bob": world.bob}[role]
    become(world.su, who)
    out = direct(world.su, world.channel, "5000")
    assert out.ok and out.rowcount == 0, out        # the table's policy: no row to update
    become(world.su, who)
    out = world.su.run(RPC, [world.channel, '{"spend_ceiling_usd": 5000}'])
    assert not out.ok and out.sqlstate == "42501" and "channel not found or not yours" in out.error, out
    assert holds(world.su, world.channel, "50")


def test_an_administrator_of_another_organization_cannot_touch_alices_limit(conn, sc, world):
    """Bob administers his own organization; that gives him nothing on alice's channel, by either door."""
    become(world.su, world.bob)
    assert world.su.run("select public.is_org_member(%s, 'admin')", [sc.bob.org]).rows[0][0] is True
    become(world.su, world.bob)
    out = direct(world.su, world.channel, "5000")
    assert out.ok and out.rowcount == 0, out
    become(world.su, world.bob)
    assert not world.su.run(RPC, [world.channel, '{"spend_ceiling_usd": 5000}']).ok
    assert holds(world.su, world.channel, "50")


def test_anon_cannot_call_the_function_or_write_the_table(conn, sc, world):
    become(world.su, ANON)
    out = world.su.run(RPC, [world.channel, '{"watch_next": false}'])
    assert not out.ok and out.sqlstate == "42501" and "permission denied" in out.error, out
    become(world.su, ANON)
    assert not direct(world.su, world.channel, "5000").ok
    assert holds(world.su, world.channel, "50")


def test_the_service_role_does_not_get_the_function_it_has_no_need_of(conn, sc, world):
    become(world.su, SERVICE)
    out = world.su.run(RPC, [world.channel, '{"watch_next": false}'])
    assert not out.ok and out.sqlstate == "42501", out


def test_definer_functions_and_the_database_owner_are_not_held_to_it(conn, sc, world):
    """The convention of 0086/0114/0117: the guard holds the browser roles; a definer function runs as its owner. A definer function
    written here that raises the limit proves the guard does not block that path (set_channel_dna and attach_voice_to_channel are
    two that exist, and neither touches the key); and that such a function WOULD be a way round, which is why
    patch_channel_agent_config is not one."""
    become(world.su, None)
    world.su.conn.execute(
        "create function public.t_raise_limit(p text) returns void language plpgsql security definer set search_path = public, pg_temp as $f$ "
        "begin update public.channels set agent_config = agent_config || '{\"spend_ceiling_usd\": 9999}' where channel_id = p; end $f$")
    world.su.conn.execute("grant execute on function public.t_raise_limit(text) to authenticated")
    become(world.su, world.editor)
    assert world.su.run("select public.t_raise_limit(%s)", [world.channel]).ok
    assert holds(world.su, world.channel, "9999")
    # the database owner (the SQL editor) too
    put(world.su, world.channel, ABSENT)
    assert holds(world.su, world.channel, ABSENT)


def test_set_channel_dna_still_works_for_an_editor_and_leaves_the_limit_alone(conn, sc, world):
    become(world.su, world.editor)
    out = world.su.run(SET_DNA, [world.channel, None, [], VOICE, "ru", None, None, "calm"])
    assert out.ok, out
    cfg = config(world.su, world.channel)
    assert cfg["language"] == "Russian" and cfg[KEY] == 50


def test_create_channel_may_carry_a_limit_and_the_new_channel_is_then_locked(conn, sc, world):
    create = "select public.create_channel(%s, %s, %s, 'travel', %s::jsonb, '{}'::jsonb, null, false)"
    for who in (world.admin, world.owner):
        become(world.su, who)
        cid = f"cs-new-{who.name}"
        out = world.su.run(create, [cid, sc.alice.org, "x", '{"spend_ceiling_usd": 40}'])
        assert out.ok, out
        assert holds(world.su, cid, "40")
        become(world.su, world.editor)
        assert locked(direct(world.su, cid, "41"))
        become(world.su, world.editor)
        assert direct(world.su, cid, "39").ok


# -- patch_channel_agent_config -----------------------------------------------------------------------------------------

def test_an_editor_patches_the_settings_the_page_writes_and_nothing_else_moves(conn, sc, world):
    ch = world.channel
    before = config(world.su, ch)
    become(world.su, world.editor)
    out = world.su.run(RPC, [ch, '{"pinned_comment": false, "watch_next": false, "spend_ceiling_usd": 12.5}'])
    assert out.ok, out
    result = out.rows[0][0]
    assert result["ok"] is True
    after = config(world.su, ch)
    assert after == before | {"pinned_comment": False, "watch_next": False, KEY: 12.5}
    assert result["agent_config"] == after
    become(world.su, world.editor)
    assert world.su.run(RPC, [ch, '{"watch_next": null}']).ok
    assert "watch_next" not in config(world.su, ch) and config(world.su, ch)["pinned_comment"] is False
    # the stamp the page wrote before is written here too
    assert world.su.value("select updated_at from public.channels where channel_id = %s", [ch]) > "2026"


def test_a_blob_that_is_not_an_object_is_read_as_empty_not_crashed_on(conn, sc, world):
    for junk in ("[]", "5", "null", '"x"'):
        become(world.su, None)
        world.su.conn.execute("update public.channels set agent_config = %s::jsonb where channel_id = %s", [junk, world.channel])
        become(world.su, world.editor)
        out = world.su.run(RPC, [world.channel, '{"watch_next": false}'])
        assert out.ok and out.rows[0][0]["agent_config"] == {"watch_next": False}, (junk, out)


@pytest.mark.parametrize("patch", [
    None, "[]", '"x"', "5", "true", "null", "{}",
])
def test_a_patch_that_is_not_a_non_empty_object_is_refused(conn, sc, world, patch):
    become(world.su, world.editor)
    out = world.su.run(RPC, [world.channel, patch])
    assert not out.ok and out.sqlstate == "22023" and "invalid_patch" in out.error, out


@pytest.mark.parametrize("key", [
    "auto_publish", "publish_gate", "require_two_person_publish", "ai_disclosure", "ai_disclosure_voice", "elevenlabs_voice_id",
    "elevenlabs_secondary_voice_id", "credential_ref", "org_id", "status", "language", "shorts", "remix_enabled", "visual_style_prompt",
    "Spend_Ceiling_USD", "spend_ceiling_usd ", " watch_next", "spend_ceiling_usd​", "", "__proto__", "constructor", "a" * 5000,
])
def test_a_key_that_is_not_on_the_list_is_refused_for_everyone_and_nothing_is_written(conn, sc, world, key):
    before = config(world.su, world.channel)
    for who in (world.editor, world.admin, world.owner):
        become(world.su, who)
        out = world.su.run(RPC, [world.channel, json.dumps({key: True, "watch_next": False})])
        assert not out.ok and out.sqlstate == "22023" and "invalid_patch" in out.error, (who.name, out)
    assert config(world.su, world.channel) == before, "one bad key refuses the whole patch: the allowed key beside it was not written"


@pytest.mark.parametrize("patch", [
    '{"spend_ceiling_usd": "25"}', '{"spend_ceiling_usd": 0}', '{"spend_ceiling_usd": -1}', '{"spend_ceiling_usd": 1000000.01}',
    '{"spend_ceiling_usd": true}', '{"spend_ceiling_usd": false}', '{"spend_ceiling_usd": []}', '{"spend_ceiling_usd": {}}',
    '{"spend_ceiling_usd": 1e400}', '{"spend_ceiling_usd": 5e-400}', '{"spend_ceiling_usd": "1e2"}',
    '{"pinned_comment": "false"}', '{"pinned_comment": 0}', '{"pinned_comment": 1}', '{"pinned_comment": []}', '{"pinned_comment": {}}',
    '{"watch_next": "no"}', '{"watch_next": 0}', '{"storyboard_review": "true"}', '{"storyboard_review": 1}',
])
def test_a_value_of_the_wrong_kind_is_refused_even_for_an_administrator(conn, sc, world, patch):
    before = config(world.su, world.channel)
    become(world.su, world.admin)
    out = world.su.run(RPC, [world.channel, patch])
    assert not out.ok and out.sqlstate == "22023" and "invalid_patch" in out.error, out
    assert config(world.su, world.channel) == before


def test_the_largest_and_smallest_numbers_the_page_offers_are_accepted(conn, sc, world):
    for value in ("1000000", "0.01", "1e-5"):
        become(world.su, world.admin)
        out = world.su.run(RPC, [world.channel, '{"spend_ceiling_usd": %s}' % value])
        assert out.ok, (value, out)


def test_the_function_runs_the_same_guard_as_a_direct_write(conn, sc, world):
    ch = world.channel
    # storyboard_review is an administrator's, here too
    become(world.su, world.editor)
    out = world.su.run(RPC, [ch, '{"storyboard_review": true}'])
    assert not out.ok and out.sqlstate == "42501" and "only an administrator" in out.error, out
    become(world.su, world.editor)
    out = world.su.run(RPC, [ch, '{"storyboard_review": null}'])
    assert out.ok, "removing a key that was never set changes nothing, so it is not a change of the control"
    become(world.su, world.admin)
    assert world.su.run(RPC, [ch, '{"storyboard_review": true}']).ok
    become(world.su, world.editor)
    out = world.su.run(RPC, [ch, '{"storyboard_review": false}'])
    assert not out.ok and out.sqlstate == "42501", out
    become(world.su, world.editor)
    out = world.su.run(RPC, [ch, '{"storyboard_review": null}'])
    assert not out.ok and out.sqlstate == "42501", out
    assert config(world.su, ch)["storyboard_review"] is True
    # the limit: set / lower / keep for an editor, raise and remove for an administrator
    become(world.su, world.editor)
    assert world.su.run(RPC, [ch, '{"spend_ceiling_usd": 20}']).ok
    for patch in ('{"spend_ceiling_usd": 20.01}', '{"spend_ceiling_usd": 999999}', '{"spend_ceiling_usd": null}'):
        become(world.su, world.editor)
        out = world.su.run(RPC, [ch, patch])
        assert locked(out), (patch, out)
    become(world.su, world.editor)
    assert world.su.run(RPC, [ch, '{"spend_ceiling_usd": 20}']).ok
    become(world.su, world.admin)
    assert world.su.run(RPC, [ch, '{"spend_ceiling_usd": 30}']).ok
    assert world.su.run(RPC, [ch, '{"spend_ceiling_usd": null}']).ok
    assert KEY not in config(world.su, ch)


def test_a_missing_channel_reads_like_a_channel_that_is_not_yours(conn, sc, world):
    become(world.su, world.editor)
    gone = world.su.run(RPC, ["no-such-channel", '{"watch_next": false}'])
    become(world.su, world.bob)
    foreign = world.su.run(RPC, [world.channel, '{"watch_next": false}'])
    assert (gone.sqlstate, gone.error) == (foreign.sqlstate, foreign.error) == ("42501", "channel not found or not yours")


# -- what the function is --------------------------------------------------------------------------------------------------

def test_the_function_is_a_single_update_that_runs_as_the_caller(conn, sc):
    with as_superuser(conn, commit=False) as s:
        sec, cfg, src, vol = s.rows("select prosecdef, proconfig, prosrc, provolatile from pg_proc "
                                    "where oid = 'public.patch_channel_agent_config(text,jsonb)'::regprocedure")[0]
        assert sec is False, "a definer function would run the UPDATE as the table owner, which the guard lets through"
        assert cfg == ["search_path=public, pg_temp"] and vol == "v"
        assert len(re.findall(r"(?is)\bupdate\s+public\.channels\b", src)) == 1
        assert not re.search(r"(?is)\b(insert|delete)\b", re.sub(r"--[^\n]*", "", src).replace("'", " "))
        assert not re.search(r"(?i)\bselect\b[^;]*\bfrom\s+public\.channels\b", src), "no read-then-write: one statement"
        guard_sec, guard_cfg = s.rows("select prosecdef, proconfig from pg_proc where oid = 'public.channels_config_guard()'::regprocedure")[0]
        assert guard_sec is False and guard_cfg == ["search_path=public, pg_temp"]
        helper = s.rows("select prosecdef, proconfig, provolatile from pg_proc where oid = 'public.channel_spend_ceiling(jsonb)'::regprocedure")[0]
        assert helper == (False, ["search_path=public, pg_temp"], "i")


def test_the_grants_are_what_the_file_says(conn):
    with as_superuser(conn, commit=False) as su:
        def priv(sig):
            return [su.value("select has_function_privilege(%s, %s::regprocedure, 'EXECUTE')", [r, sig]) for r in ("anon", "authenticated", "service_role")]
        assert priv("public.patch_channel_agent_config(text, jsonb)") == [False, True, False]
        assert priv("public.channel_spend_ceiling(jsonb)") == [False, True, True]
        assert priv("public.channels_config_guard()") == [False, False, False]
        # PUBLIC holds nothing on either new function
        for sig in ("public.patch_channel_agent_config(text, jsonb)", "public.channel_spend_ceiling(jsonb)"):
            acl = su.value("select proacl::text from pg_proc where oid = %s::regprocedure", [sig]).strip("{}").split(",")
            assert not [a for a in acl if a.startswith("=")], acl
        assert su.value("select count(*) from pg_trigger where tgrelid = 'public.channels'::regclass and tgname = 'channels_config_guard' and not tgisinternal") == 1


def test_the_guard_keeps_every_check_it_had(conn):
    with as_superuser(conn, commit=False) as su:
        body = su.value("select pg_get_functiondef('public.channels_config_guard()'::regprocedure)")
    for needle in ("channel_voice_config_problem", "channel_label_lowering", "ai_disclosure_lock", "voice_not_allowed",
                   "if current_user not in ('authenticated', 'anon')", "only an administrator of this organization may change",
                   "a channel is created paused with no credential", "spend_ceiling_lock"):
        assert needle in body, needle
    assert body.index("spend_ceiling_lock") > body.index("ai_disclosure_lock") > body.index("if current_user not in ('authenticated', 'anon')")


# -- concurrent writers lose no keys ------------------------------------------------------------------------------------

RACE_CHANNEL = "cs-race"


class Shared:
    pass


@pytest.fixture()
def shared(conn, sc):
    """Committed rows (two threads need real sessions): a channel in alice's organization, two editors and an administrator.
    Removed again whatever the test did."""
    s = Shared()
    s.dsn = psycopg.conninfo.make_conninfo(sec_db.admin_dsn(), dbname=conn.info.dbname)
    s.editors = [user(f"cs-race-e{i}", f"cs-race-e{i}@a.test") for i in range(3)]
    s.admin = user("cs-race-admin", "cs-race-admin@a.test")
    members = [(u, "editor") for u in s.editors] + [(s.admin, "admin")]
    try:
        with as_superuser(conn, commit=True) as su:
            for who, role in members:
                su.rows("insert into auth.users (id, email, email_confirmed_at) values (%s, %s, now()) returning 1", [who.uid, who.email])
                su.rows("insert into public.org_members (org_id, user_id, email, role) values (%s, %s, %s, %s) returning 1",
                        [sc.alice.org, who.uid, who.email, role])
            su.rows("insert into public.channels (channel_id, name, niche, status, org_id, agent_config) "
                    "values (%s, 'race', 'n', 'PAUSED', %s, '{\"language\": \"English\", \"spend_ceiling_usd\": 50}'::jsonb) returning 1",
                    [RACE_CHANNEL, sc.alice.org])
        yield s
    finally:
        with as_superuser(conn, commit=True) as su:
            su.conn.execute("delete from public.channels where channel_id = %s", [RACE_CHANNEL])
            su.conn.execute("delete from public.org_members where user_id = any (%s::uuid[])", [[u.uid for u, _ in members]])
            su.conn.execute("delete from auth.users where id = any (%s::uuid[])", [[u.uid for u, _ in members]])


class Remote:
    """One browser session: its own connection, one open transaction as `who`."""

    def __init__(self, dsn, who):
        self.c = psycopg.connect(dsn, autocommit=False)
        self.c.execute("select set_config('request.jwt.claims', %s, true)", [json.dumps(who.claims())])
        self.c.execute(sql.SQL("set local role {}").format(sql.Identifier(who.role)))

    def patch(self, patch):
        try:
            return ("ok", self.c.execute(RPC, [RACE_CHANNEL, json.dumps(patch)]).fetchone()[0])
        except psycopg.Error as e:
            return ("error", e.diag.sqlstate, e.diag.message_hint)

    def commit(self):
        self.c.commit()

    def close(self):
        self.c.close()


def _race_config(conn):
    with as_superuser(conn, commit=False) as su:
        return su.value("select agent_config from public.channels where channel_id = %s", [RACE_CHANNEL])


def _reset_race(conn, cfg):
    with as_superuser(conn, commit=True) as su:
        su.conn.execute("update public.channels set agent_config = %s::jsonb where channel_id = %s", [json.dumps(cfg), RACE_CHANNEL])


def _wait_until_blocked(conn, n=1, seconds=10):
    deadline = time.time() + seconds
    while time.time() < deadline:
        with as_superuser(conn, commit=False) as su:
            waiting = su.value("select count(*) from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock' "
                               "and query like '%patch_channel_agent_config%'")
        if waiting >= n:
            return
        time.sleep(0.05)
    raise AssertionError("the second writer never waited for the first one's row lock")


def test_a_writer_that_waits_for_the_row_lock_keeps_the_key_the_first_one_wrote(conn, sc, shared):
    """The page used to read agent_config, merge one key and write the object back: the second writer put the first one's key back to
    what it had read. The function merges in the one UPDATE, after the row lock is granted."""
    a, b = Remote(shared.dsn, shared.editors[0]), Remote(shared.dsn, shared.editors[1])
    result = {}
    try:
        assert a.patch({"pinned_comment": False})[0] == "ok"            # holds the row lock, uncommitted
        t = threading.Thread(target=lambda: result.update(b=b.patch({"watch_next": False})))
        t.start()
        _wait_until_blocked(conn)
        a.commit()
        t.join(10)
        assert not t.is_alive() and result["b"][0] == "ok", result
        b.commit()
    finally:
        a.close(), b.close()
    cfg = _race_config(conn)
    assert cfg["pinned_comment"] is False and cfg["watch_next"] is False
    assert cfg["language"] == "English" and cfg[KEY] == 50


def test_an_editor_racing_an_administrators_lowering_is_judged_against_the_lowered_limit(conn, sc, shared):
    """The editor's page was drawn at 50 and 30 is lower, so a check made before the wait would let it through; the guard runs on the
    row the lock hands over, which an administrator just lowered to 10."""
    adm, ed = Remote(shared.dsn, shared.admin), Remote(shared.dsn, shared.editors[0])
    result = {}
    try:
        assert adm.patch({KEY: 10})[0] == "ok"
        t = threading.Thread(target=lambda: result.update(e=ed.patch({KEY: 30})))
        t.start()
        _wait_until_blocked(conn)
        adm.commit()
        t.join(10)
        assert not t.is_alive()
    finally:
        adm.close(), ed.close()
    assert result["e"] == ("error", "42501", "spend_ceiling_lock"), result
    assert _race_config(conn)[KEY] == 10


def test_many_writers_at_once_lose_no_key(conn, sc, shared):
    keys = [(shared.editors[0], {"pinned_comment": False}), (shared.editors[1], {"watch_next": False}),
            (shared.editors[2], {KEY: 20}), (shared.admin, {"storyboard_review": True})]
    for round_ in range(6):
        _reset_race(conn, {"language": "English", KEY: 50, "tts_provider": "edge"})
        sessions = [Remote(shared.dsn, who) for who, _ in keys]
        barrier = threading.Barrier(len(keys))
        results = [None] * len(keys)

        def work(i):
            barrier.wait()
            results[i] = sessions[i].patch(keys[i][1])
            sessions[i].commit()

        threads = [threading.Thread(target=work, args=(i,)) for i in range(len(keys))]
        try:
            [t.start() for t in threads]
            [t.join(20) for t in threads]
        finally:
            [s.close() for s in sessions]
        assert [r[0] for r in results] == ["ok"] * len(keys), (round_, results)
        cfg = _race_config(conn)
        assert cfg == {"language": "English", "tts_provider": "edge", KEY: 20, "pinned_comment": False, "watch_next": False,
                       "storyboard_review": True}, (round_, cfg)


# -- the 0117 drift guard, the replay and the rollback ------------------------------------------------------------------

def _guard_0117() -> str:
    text = M0117.read_text(encoding="utf-8")
    i = text.index("create or replace function public.channels_config_guard() returns trigger")
    return text[i: text.index("\n$$;", i) + 4]


def test_the_migration_accepts_0117s_body_and_its_own_and_nothing_else(conn, sc):
    migration = MIGRATION.read_text(encoding="utf-8")
    with as_superuser(conn, commit=False) as s:
        live = s.value("select pg_get_functiondef('public.channels_config_guard()'::regprocedure)")
        assert "spend_ceiling_lock" in live
        # 0117's body: the migration applies on it
        s.conn.execute(_guard_0117())
        assert "spend_ceiling_lock" not in s.value("select pg_get_functiondef('public.channels_config_guard()'::regprocedure)")
        assert s.run(migration).ok
        applied = s.value("select pg_get_functiondef('public.channels_config_guard()'::regprocedure)")
        assert applied == live, "applying 0119 on 0117's body gives the body the lab already had"
        # a replay on its own body
        assert s.run(migration).ok
        assert s.value("select pg_get_functiondef('public.channels_config_guard()'::regprocedure)") == applied
        # the same body with white space changed (CRLF line ends, tabs) is the same body
        body = s.value("select prosrc from pg_proc where oid = 'public.channels_config_guard()'::regprocedure")
        s.conn.execute("create or replace function public.channels_config_guard() returns trigger language plpgsql set search_path = public, pg_temp "
                       "as $f$" + body.replace("\n", "\r\n\n").replace("  ", "\t") + "$f$")
        assert s.run(migration).ok
        # a foreign body is refused and nothing is replaced: 0117's with one character of its text changed, and 0114's older one
        foreign = _guard_0117().replace("hint = 'voice_not_allowed'", "hint = 'voice_not_allowed2'", 1)
        assert foreign != _guard_0117()
        s.conn.execute(foreign)
        out = s.run(migration)
        assert not out.ok and out.sqlstate == "P0001" and "neither" in out.error and "0117" in out.error, out
        assert "voice_not_allowed2" in s.value("select pg_get_functiondef('public.channels_config_guard()'::regprocedure)")
        assert s.value("select to_regprocedure('public.patch_channel_agent_config(text,jsonb)')") is not None   # created by the lab build, untouched
        m0114 = (sec_db.REPO / "supabase" / "migrations" / "0114_ai_disclosure_admin_lock.sql").read_text(encoding="utf-8")
        i = m0114.index("create or replace function public.channels_config_guard() returns trigger")
        s.conn.execute(m0114[i: m0114.index("\n$$;", i) + 4])
        out = s.run(migration)
        assert not out.ok and "neither" in out.error, "0117 must be applied first"


def test_the_hash_in_the_file_is_the_one_the_database_computes(conn):
    head = MIGRATION.read_text(encoding="utf-8").split("1. The limit a stored value means", 1)[0]
    hashes = set(re.findall(r"'([0-9a-f]{32})'", head))
    with as_superuser(conn, commit=False) as s:
        live = s.value("select md5(regexp_replace(prosrc, '\\s+', ' ', 'g')) from pg_proc where oid = 'public.channels_config_guard()'::regprocedure")
        s.conn.execute(_guard_0117())
        theirs = s.value("select md5(regexp_replace(prosrc, '\\s+', ' ', 'g')) from pg_proc where oid = 'public.channels_config_guard()'::regprocedure")
    assert hashes == {live, theirs} and len(hashes) == 2


def test_the_rollback_puts_0117s_guard_back_and_0119_applies_again(conn, sc):
    """The rollback restores channels_config_guard byte for byte (and its grants), drops the two functions, leaves the trigger and
    every row alone, and the migration applies again on top; a replay of the migration changes nothing."""
    admin = sec_db.admin_dsn()
    base = f"ns_csg_base_{uuid.uuid4().hex[:8]}"
    base_dsn = sec_db.create_database(admin, base)
    sig = "public.channels_config_guard()"
    try:
        sec_db.apply_files(base_dsn, [f for f in sec_db.build_sequence() if not f.name.startswith("0119_")])
        with psycopg.connect(base_dsn, autocommit=True) as b:
            want = (b.execute("select pg_get_functiondef(%s::regprocedure)", [sig]).fetchone()[0],
                    b.execute("select proacl::text from pg_proc where oid = %s::regprocedure", [sig]).fetchone()[0])
            fns = [r[0] for r in b.execute("select p.oid::regprocedure::text from pg_proc p where pronamespace = 'public'::regnamespace order by 1")]
    finally:
        sec_db.drop_database(admin, base)
    rollback = ROLLBACK.read_text(encoding="utf-8")
    assert re.search(r"(?m)^begin;$", rollback) and re.search(r"(?m)^commit;$", rollback)
    body = "\n".join(ln for ln in rollback.splitlines() if ln.strip() not in ("begin;", "commit;"))
    migration = MIGRATION.read_text(encoding="utf-8")
    with as_superuser(conn, commit=False) as su:
        def snapshot():
            return (su.value("select pg_get_functiondef(%s::regprocedure)", [sig]),
                    su.value("select proacl::text from pg_proc where oid = %s::regprocedure", [sig]))
        trig = "select oid, tgtype, tgenabled, pg_get_triggerdef(oid) from pg_trigger where tgrelid = 'public.channels'::regclass and tgname = 'channels_config_guard'"
        applied = snapshot()
        trigger_before = su.rows(trig)
        rows_before = su.value("select md5(string_agg(agent_config::text, ',' order by channel_id)) from public.channels")
        su.conn.execute(migration)                                       # a replay
        assert snapshot() == applied and su.rows(trig) == trigger_before
        su.conn.execute(body)
        assert snapshot() == want, "0117's guard is back, byte for byte"
        assert su.rows(trig) == trigger_before
        assert [r[0] for r in su.rows("select p.oid::regprocedure::text from pg_proc p where pronamespace = 'public'::regnamespace order by 1")] == fns
        assert su.value("select md5(string_agg(agent_config::text, ',' order by channel_id)) from public.channels") == rows_before
        su.conn.execute(body)                                            # the rollback replays
        su.conn.execute(migration)
        assert snapshot() == applied
        # the rollback refuses a guard it has not seen
        su.conn.execute(_guard_0117().replace("hint = 'voice_not_allowed'", "hint = 'voice_not_allowed2'", 1))
        out = su.run(body)
        assert not out.ok and "neither" in out.error, out


def test_the_functions_own_editor_check_does_not_lean_on_the_tables_policy(conn, sc, world):
    """The table's update policy already keeps a viewer out; the function checks the role itself too, so loosening the policy one day
    does not turn the function into a way for a viewer to write."""
    become(world.su, None)
    world.su.conn.execute("alter table public.channels disable row level security")
    for who in (world.viewer, world.stranger, world.bob):
        become(world.su, who)
        out = world.su.run(RPC, [world.channel, '{"watch_next": false}'])
        assert not out.ok and out.sqlstate == "42501" and "channel not found or not yours" in out.error, (who.name, out)
    assert "watch_next" not in config(world.su, world.channel)
    # and the editor still can with the policy off (the function's own check passes them)
    become(world.su, world.editor)
    assert world.su.run(RPC, [world.channel, '{"watch_next": false}']).ok


def test_a_session_with_no_user_is_told_to_sign_in(conn, sc, world):
    """The authenticated role with a token that names no user (auth.uid() is null)."""
    nobody = sec_db.Actor("nobody", "authenticated")
    become(world.su, nobody)
    out = world.su.run(RPC, [world.channel, '{"watch_next": false}'])
    assert not out.ok and out.sqlstate == "42501" and "sign in first" in out.error, out

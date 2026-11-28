"""Migration 0130: Agent Builder private drafts, attacked through the only two doors (save_agent_workflow_draft and
delete_agent_workflow_draft) and through the tables themselves.

What would break without these, guard by guard (each test names the guard it pins; removing that guard from the migration makes it
fail):
  * sign-in: a call without auth.uid() is not_authenticated (42501), never a NOT NULL error or a row;
  * the closed document: every key, every JSON type, every value of format / layoutVersion / version, the node and edge counts, the node
    id pattern, uniqueness, the registry of types, the label and name rules (raw length, a visible character, no control, direction,
    zero-width or tag characters), the empty config, the edge kinds, duplicates, an export without a review, the position keys, shapes
    and bounds, and the byte size: each is its own refusal with the function's own message (22023), so a guard that is removed cannot
    hide behind a neighbouring one;
  * the limits: 50 plans a person (under an advisory lock: two creates at once at 49 make exactly one), the newest 30 versions kept;
  * versions: a new plan takes no expected version but null or 0; an existing one takes exactly its current version; two saves at once
    on the same version make one version and one version_conflict (the row lock);
  * the owner: another person's plan reads as missing for save and delete, and nobody else reads it;
  * the grants: anon and service_role call neither function; no API role writes either table; the table's own CHECK caps a document;
  * the rollback (docs/sql/rollback_0130_agent_workflow_drafts.sql) refuses while plans exist, takes everything out with its override,
    and 0130 applies again after it.

Since 0234 only a platform operator may call either function (test_sec_agent_drafts_operator_only_0234.py attacks that). These tests
attack 0130's own guards, which 0234 leaves verbatim, so each caller here is made a platform admin for its one rolled-back
transaction (`acting` below); the race database's caller is one for good.
"""

from __future__ import annotations

import copy
import json
import os
import threading
import time
import uuid
from contextlib import contextmanager

import psycopg
import pytest
from psycopg import sql

import sec_db
from sec_agent_drafts_0130 import DOCUMENT, SAVE
from sec_db import ANON, SERVICE, as_superuser, user

DELETE = "select public.delete_agent_workflow_draft(%s)"

def _promote(conn, who) -> None:
    """`who` on the platform roster as an admin, so is_platform_admin() (0234's check) is true for them."""
    if who.role != "authenticated" or not who.uid:
        return
    conn.execute("insert into public.app_members (user_id, email, role) select %s, %s, 'admin' "
                 "where not exists (select 1 from public.app_members where user_id = %s)", [who.uid, who.email, who.uid])
    conn.execute("update public.app_members set role = 'admin' where user_id = %s and role not in ('owner', 'admin')", [who.uid])


@contextmanager
def acting(conn, who, *, commit: bool = False, also=()):
    """sec_db.acting, with `who` (and `also`) made platform admins first, as the database owner in the same transaction: rolled
    back with it unless `commit` (only in the race database, whose caller is an admin for good anyway)."""
    with conn.transaction(force_rollback=not commit):
        for w in (who, *also):
            _promote(conn, w)
        conn.execute("select set_config('request.jwt.claims', %s, true)", [json.dumps(who.claims())])
        conn.execute("select set_config('request.jwt.claim.role', %s, true)", [who.role])
        conn.execute(sql.SQL("set local role {}").format(sql.Identifier(who.role)))
        yield sec_db.Session(conn)

MIGRATION = sec_db.MIGRATIONS / "0130_agent_workflow_drafts.sql"
ROLLBACK = sec_db.REPO / "docs" / "sql" / "rollback_0130_agent_workflow_drafts.sql"
TABLES = ("public.agent_workflow_drafts", "public.agent_workflow_draft_versions")


def doc(mutate=None) -> dict:
    d = copy.deepcopy(DOCUMENT)
    if mutate:
        mutate(d)
    return d


def _save(s, draft_id=None, version=None, document=None, raw=None):
    return s.run(SAVE, [draft_id, version, raw if raw is not None else json.dumps(document if document is not None else DOCUMENT)])


def _new(s, document=None) -> tuple[str, int]:
    out = _save(s, document=document)
    assert out.ok, out
    return str(out.rows[0][0]), out.rows[0][1]


def _refused(out, message: str, sqlstate: str = "22023"):
    assert not out.ok and out.sqlstate == sqlstate and out.error == message, out


# ── who may call ────────────────────────────────────────────────────────────

def test_the_owner_saves_versions_and_nobody_else_reads_or_writes_them(conn, sc):
    with acting(conn, sc.alice.actor, also=(sc.bob.actor,)) as s:
        draft_id, version = _new(s)
        assert version == 1
        second = _save(s, draft_id, 1)
        assert second.ok and second.rows[0][1] == 2, second
        _refused(_save(s, draft_id, 1), "version_conflict", "40001")
        s.conn.execute("select set_config('request.jwt.claims', %s, true)", [json.dumps(sc.bob.actor.claims())])
        assert s.value("select count(*) from public.agent_workflow_drafts where id = %s", [draft_id]) == 0
        assert s.value("select count(*) from public.agent_workflow_draft_versions where draft_id = %s", [draft_id]) == 0
        _refused(_save(s, draft_id, 2), "draft_not_found", "P0002")
        _refused(s.run(DELETE, [draft_id]), "draft_not_found", "P0002")
        s.conn.execute("select set_config('request.jwt.claims', %s, true)", [json.dumps(sc.alice.actor.claims())])
        assert s.value("select count(*) from public.agent_workflow_draft_versions where draft_id = %s", [draft_id]) == 2
        assert s.value("select current_version from public.agent_workflow_drafts where id = %s", [draft_id]) == 2


def test_another_persons_seeded_plan_is_missing_for_save_and_delete_and_stays_whole(conn, sc):
    with acting(conn, sc.bob.actor) as s:
        _refused(_save(s, sc.alice.agent_draft, 2), "draft_not_found", "P0002")
        _refused(s.run(DELETE, [sc.alice.agent_draft]), "draft_not_found", "P0002")
        _refused(s.run(DELETE, [str(uuid.uuid4())]), "draft_not_found", "P0002")
        _refused(s.run(DELETE, [None]), "draft_not_found", "P0002")
        s.conn.execute("reset role")
        assert s.value("select current_version from public.agent_workflow_drafts where id = %s", [sc.alice.agent_draft]) == 2
        assert s.value("select count(*) from public.agent_workflow_draft_versions where draft_id = %s", [sc.alice.agent_draft]) == 2


def test_a_call_without_a_signed_in_user_is_refused_as_such(conn, sc):
    nobody = sec_db.Actor("nobody", "authenticated")  # the authenticated role with no `sub`: auth.uid() is null
    with acting(conn, nobody) as s:
        _refused(_save(s), "not_authenticated", "42501")
        _refused(s.run(DELETE, [sc.alice.agent_draft]), "not_authenticated", "42501")


@pytest.mark.parametrize("who", [ANON, SERVICE], ids=["anon", "service_role"])
def test_the_anon_key_and_the_service_role_call_neither_function(conn, sc, who):
    with acting(conn, who) as s:
        for out in (_save(s), s.run(DELETE, [sc.alice.agent_draft])):
            assert not out.ok and out.sqlstate == "42501" and "permission denied" in out.error, out


def test_the_owner_deletes_a_plan_and_all_of_its_versions(conn, sc):
    with acting(conn, sc.alice.actor) as s:
        draft_id, _ = _new(s)
        assert _save(s, draft_id, 1).ok
        assert s.run(DELETE, [draft_id]).ok
        assert s.value("select count(*) from public.agent_workflow_drafts where id = %s", [draft_id]) == 0
        s.conn.execute("reset role")
        assert s.value("select count(*) from public.agent_workflow_draft_versions where draft_id = %s", [draft_id]) == 0
        assert s.value("select count(*) from public.agent_workflow_drafts where id = %s", [sc.alice.agent_draft]) == 1


def test_no_api_role_writes_either_table_and_rls_is_on(conn):
    with as_superuser(conn, commit=False) as s:
        for table in TABLES:
            assert s.value("select relrowsecurity from pg_class where oid = %s::regclass", [table])
            assert s.value("select has_table_privilege('authenticated', %s, 'SELECT')", [table])
            for role in ("anon", "authenticated", "service_role"):
                for priv in ("INSERT", "UPDATE", "DELETE", "TRUNCATE"):
                    assert not s.value("select has_table_privilege(%s, %s, %s)", [role, table, priv]), (role, table, priv)
            for role in ("anon", "service_role"):
                assert not s.value("select has_table_privilege(%s, %s, 'SELECT')", [role, table]), (role, table)


def test_the_tables_own_check_caps_a_stored_document(conn, sc):
    with as_superuser(conn, commit=False) as s:
        big = json.dumps({"pad": "x" * 150_001})
        out = s.run("insert into public.agent_workflow_draft_versions (draft_id, version, owner_id, document) "
                    "values (%s, 99, %s, %s::jsonb)", [sc.alice.agent_draft, sc.alice.actor.uid, big])
        assert not out.ok and out.sqlstate == "23514", out


# ── the document ────────────────────────────────────────────────────────────

def _set(path, value):
    def m(d):
        target = d
        for key in path[:-1]:
            target = target[key]
        target[path[-1]] = value
    return m


def _drop(path):
    def m(d):
        target = d
        for key in path[:-1]:
            target = target[key]
        del target[path[-1]]
    return m


def _node(i, **kw):
    return _set(("workflow", "nodes", i), {**DOCUMENT["workflow"]["nodes"][i], **kw})


def _brands(n):
    """`n` brand nodes and nothing else: a graph that passes every rule but a count."""
    def m(d):
        d["workflow"]["nodes"] = [{"id": f"b{i}", "type": "brand.input", "label": f"B{i}"} for i in range(n)]
        d["workflow"]["edges"] = []
        d["positions"] = {}
    return m


def _fan(brands, prompts):
    """Every brand into every prompt: brands * prompts distinct, allowed edges."""
    def m(d):
        d["workflow"]["nodes"] = ([{"id": f"b{i}", "type": "brand.input", "label": "B"} for i in range(brands)]
                                  + [{"id": f"p{j}", "type": "prompt.compose", "label": "P"} for j in range(prompts)])
        d["workflow"]["edges"] = [{"source": f"b{i}", "target": f"p{j}"} for i in range(brands) for j in range(prompts)]
        d["positions"] = {}
    return m


def _extra_node(**node):
    def m(d):
        d["workflow"]["nodes"].append({"id": "extra", "type": "brand.input", "label": "Extra", **node})
    return m


def _extra_edge(**edge):
    def m(d):
        d["workflow"]["edges"].append(edge)
    return m


def _workflow_only_name(d):
    d.clear()
    d["workflow"] = {"name": "x"}


DRAFT, NAME, NODE, EDGE, POS = "invalid_agent_draft", "invalid_agent_draft_name", "invalid_agent_node", "invalid_agent_edge", "invalid_agent_position"

BAD = [
    # top level: exactly four keys, each of its type and value
    ("only-a-workflow-name", _workflow_only_name, DRAFT),
    ("no-format", _drop(("format",)), DRAFT),
    ("no-layout-version", _drop(("layoutVersion",)), DRAFT),
    ("no-positions", _drop(("positions",)), DRAFT),
    ("extra-top-key", _set(("run",), True), DRAFT),
    ("other-format", _set(("format",), "nightshift.agent-run"), DRAFT),
    ("layout-2", _set(("layoutVersion",), 2), DRAFT),
    ("layout-string", _set(("layoutVersion",), "1"), DRAFT),
    ("workflow-array", _set(("workflow",), []), DRAFT),
    ("positions-array", _set(("positions",), []), DRAFT),
    # workflow: exactly four keys
    ("workflow-extra-key", _set(("workflow", "execute"), True), DRAFT),
    ("workflow-no-edges", _drop(("workflow", "edges")), DRAFT),
    ("workflow-version-2", _set(("workflow", "version"), 2), DRAFT),
    ("workflow-version-string", _set(("workflow", "version"), "1"), DRAFT),
    ("nodes-object", _set(("workflow", "nodes"), {}), DRAFT),
    ("edges-object", _set(("workflow", "edges"), {}), DRAFT),
    ("65-nodes", _brands(65), DRAFT),
    ("129-edges", _fan(43, 3), DRAFT),
    # name
    ("name-object", _set(("workflow", "name"), {"a": 1}), NAME),
    ("name-number", _set(("workflow", "name"), 5), NAME),
    ("name-empty", _set(("workflow", "name"), ""), NAME),
    ("name-121", _set(("workflow", "name"), "n" * 121), NAME),
    ("name-padded-past-120", _set(("workflow", "name"), "a" + " " * 140_000), NAME),
    ("name-spaces-only", _set(("workflow", "name"), "   "), NAME),
    ("name-ideographic-space-only", _set(("workflow", "name"), "\u3000\u00a0"), NAME),
    ("name-rtl-override", _set(("workflow", "name"), "Plan \u202egnp.exe"), NAME),
    ("name-bidi-isolate", _set(("workflow", "name"), "Plan \u2066x\u2069"), NAME),
    ("name-ansi", _set(("workflow", "name"), "\x1b[31mred"), NAME),
    ("name-newline", _set(("workflow", "name"), "two\nlines"), NAME),
    ("name-zero-width", _set(("workflow", "name"), "in\u200bvisible"), NAME),
    ("name-tag-block", _set(("workflow", "name"), "hi\U000e0041\U000e0042"), NAME),
    ("name-c1", _set(("workflow", "name"), "a\u0085b"), NAME),
    # nodes
    ("node-string", _set(("workflow", "nodes", 0), "brand"), NODE),
    ("node-extra-key", _node(0, code="rm -rf /"), NODE),
    ("node-no-label", _drop(("workflow", "nodes", 0, "label")), NODE),
    ("node-id-number", _node(0, id=7), NODE),
    ("node-id-boolean", _node(0, id=True), NODE),  # its text "true" would pass the pattern
    ("node-id-digit-first", _node(0, id="1brand"), NODE),
    ("node-id-space", _node(0, id="br and"), NODE),
    ("node-id-65", _node(0, id="b" * 65), NODE),
    ("node-id-duplicate", _extra_node(id="brand"), NODE),
    ("node-type-not-in-registry", _extra_node(type="shell.execute"), NODE),
    ("node-type-number", _extra_node(type=1), NODE),
    ("node-type-null", _extra_node(type=None), NODE),  # a JSON null made every test on the type NULL and voided the type map
    ("node-type-null-on-the-first-node", _node(0, type=None), NODE),
    ("node-type-missing-value-object", _extra_node(type={}), NODE),
    ("label-number", _node(0, label=3), NODE),
    ("label-empty", _node(0, label=""), NODE),
    ("label-81", _node(0, label="l" * 81), NODE),
    ("label-a-and-140k-spaces", _node(0, label="a" + " " * 140_000), NODE),
    ("label-spaces-only", _node(0, label="  "), NODE),
    ("label-rtl-override", _node(0, label="\u202eBrand"), NODE),
    ("label-ansi", _node(0, label="\x1b]8;;https://x\x07Brand"), NODE),
    ("label-zero-width", _node(0, label="Br\u200dand"), NODE),
    ("label-tag-block", _node(0, label="Brand\U000e0069"), NODE),
    ("label-bom", _node(0, label="\ufeffBrand"), NODE),
    ("config-with-key", _node(2, config={"apiKey": "forbidden"}), NODE),
    ("config-array", _node(2, config=[]), NODE),
    # edges
    ("edge-string", _set(("workflow", "edges", 0), "brand>prompt"), EDGE),
    ("edge-extra-key", _set(("workflow", "edges", 0), {"source": "brand", "target": "prompt", "when": "always"}), EDGE),
    ("edge-no-target", _set(("workflow", "edges", 0), {"source": "brand"}), EDGE),
    ("edge-source-number", _set(("workflow", "edges", 0), {"source": 1, "target": "prompt"}), EDGE),
    # A node whose id is "true" and an edge naming it with the JSON boolean: only the type check tells them apart.
    ("edge-source-boolean", lambda d: (d["workflow"]["nodes"].append({"id": "true", "type": "brand.input", "label": "T"}),
                                       d["workflow"]["edges"].append({"source": True, "target": "prompt"})), EDGE),
    ("edge-target-boolean", lambda d: (d["workflow"]["nodes"].append({"id": "true", "type": "prompt.compose", "label": "T"}),
                                       d["workflow"]["edges"].append({"source": "brand", "target": True})), EDGE),
    ("edge-unknown-node", _extra_edge(source="ghost", target="prompt"), EDGE),
    ("edge-duplicate", _extra_edge(source="brand", target="prompt"), EDGE),
    ("edge-skips-the-prompt", _extra_edge(source="brand", target="image"), EDGE),
    ("edge-skips-the-review", _extra_edge(source="image", target="export"), EDGE),
    ("edge-self", _extra_edge(source="prompt", target="prompt"), EDGE),
    ("export-without-review", lambda d: d["workflow"]["edges"].pop(), EDGE),
    # positions
    ("position-not-a-node", _set(("positions", "ghost"), {"x": 1, "y": 1}), POS),
    ("position-array", _set(("positions", "brand"), [1, 1]), POS),
    ("position-extra-key", _set(("positions", "brand"), {"x": 1, "y": 1, "z": 1}), POS),
    ("position-no-y", _set(("positions", "brand"), {"x": 1}), POS),
    ("position-string", _set(("positions", "brand"), {"x": "5", "y": 1}), POS),
    ("position-y-string", _set(("positions", "brand"), {"x": 1, "y": "5"}), POS),
    ("position-negative", _set(("positions", "brand"), {"x": -1, "y": 1}), POS),
    ("position-y-negative", _set(("positions", "brand"), {"x": 1, "y": -1}), POS),
    ("position-fraction", _set(("positions", "brand"), {"x": 1.5, "y": 1}), POS),
    ("position-x-2201", _set(("positions", "brand"), {"x": 2201, "y": 1}), POS),
    ("position-y-1601", _set(("positions", "brand"), {"x": 1, "y": 1601}), POS),
    ("position-x-9999", _set(("positions", "brand"), {"x": 9999, "y": 1}), POS),
]


@pytest.mark.parametrize("mutate,message", [b[1:] for b in BAD], ids=[b[0] for b in BAD])
def test_a_document_outside_the_rules_is_refused_by_its_own_guard_and_writes_nothing(conn, sc, mutate, message):
    with acting(conn, sc.stranger) as s:
        _refused(_save(s, document=doc(mutate)), message)
        assert s.value("select count(*) from public.agent_workflow_drafts") == 0


@pytest.mark.parametrize("raw,message", [
    ("[]", DRAFT),
    ("null", DRAFT),
    ('"nightshift.agent-draft"', DRAFT),
], ids=["array", "json-null", "string"])
def test_a_document_that_is_not_an_object_is_refused(conn, sc, raw, message):
    with acting(conn, sc.stranger) as s:
        _refused(_save(s, raw=raw), message)


@pytest.mark.parametrize("number", ["1e400", "1e100000", "123456789012345678901234567890", "2200.0000000001", "-1e-400"])
def test_a_position_number_of_any_size_is_the_functions_own_refusal_not_an_overflow(conn, sc, number):
    raw = json.dumps(doc()).replace('"brand": {"x": 20, "y": 20}', '"brand": {"x": %s, "y": 20}' % number)
    assert number in raw
    with acting(conn, sc.stranger) as s:
        _refused(_save(s, raw=raw), POS)


def test_a_document_over_150000_bytes_is_too_large_before_anything_else_is_read(conn, sc):
    with acting(conn, sc.stranger) as s:
        _refused(_save(s, document=doc(_set(("pad",), "x" * 150_001))), "agent_draft_too_large")


GOOD = [
    ("as-seeded", None),
    ("config-absent", lambda d: [n.pop("config") for n in d["workflow"]["nodes"]]),
    ("name-120-and-label-80", lambda d: (d["workflow"].update(name="n" * 120), d["workflow"]["nodes"][0].update(label="l" * 80))),
    ("emoji-and-accents", lambda d: (d["workflow"].update(name="Été \u2728\ufe0f plan"), d["workflow"]["nodes"][0].update(label="Marque \U0001f3a8"))),
    ("corners-of-the-canvas", _set(("positions",), {"brand": {"x": 0, "y": 0}, "export": {"x": 2200, "y": 1600}})),
    ("64-nodes", _brands(64)),
    ("128-edges", _fan(32, 4)),
    ("empty-graph", _brands(0)),
    ("every-kind", lambda d: d["workflow"].update(
        nodes=[{"id": i, "type": t, "label": i} for i, t in (
            ("b", "brand.input"), ("c", "product.catalog"), ("p", "prompt.compose"), ("i", "image.generate"),
            ("v", "vector.generate"), ("m", "video.generate"), ("r", "review.approval"), ("e", "asset.export"))],
        edges=[{"source": a, "target": b} for a, b in (
            ("b", "p"), ("c", "p"), ("p", "i"), ("p", "v"), ("p", "m"), ("i", "r"), ("v", "r"), ("m", "r"), ("r", "e"))])
     or d.update(positions={})),
]


@pytest.mark.parametrize("mutate", [g[1] for g in GOOD], ids=[g[0] for g in GOOD])
def test_a_document_inside_the_rules_is_saved(conn, sc, mutate):
    with acting(conn, sc.stranger) as s:
        _new(s, doc(mutate))


# ── versions and limits ─────────────────────────────────────────────────────

@pytest.mark.parametrize("expected", [None, 0])
def test_a_new_plan_takes_no_expected_version_or_zero(conn, sc, expected):
    with acting(conn, sc.stranger) as s:
        out = _save(s, None, expected)
        assert out.ok and out.rows[0][1] == 1, out


@pytest.mark.parametrize("expected", [1, 3, -1])
def test_a_new_plan_with_an_expected_version_is_a_conflict_and_writes_nothing(conn, sc, expected):
    with acting(conn, sc.stranger) as s:
        _refused(_save(s, None, expected), "version_conflict", "40001")
        assert s.value("select count(*) from public.agent_workflow_drafts") == 0


@pytest.mark.parametrize("expected", [None, 0, 2])
def test_an_existing_plan_takes_exactly_its_current_version(conn, sc, expected):
    with acting(conn, sc.stranger) as s:
        draft_id, _ = _new(s)
        _refused(_save(s, draft_id, expected), "version_conflict", "40001")
        assert s.value("select current_version from public.agent_workflow_drafts where id = %s", [draft_id]) == 1


def test_fifty_plans_a_person_and_the_fifty_first_is_refused(conn, sc):
    with acting(conn, sc.stranger) as s:
        for _ in range(50):
            _new(s)
        _refused(_save(s), "agent_draft_limit")
        assert s.value("select count(*) from public.agent_workflow_drafts") == 50
    with acting(conn, sc.bob.actor) as s:  # another person's fifty are not his
        _new(s)


def test_the_newest_thirty_versions_are_kept_and_older_ones_pruned(conn, sc):
    with acting(conn, sc.stranger) as s:
        draft_id, version = _new(s)
        for _ in range(34):
            out = _save(s, draft_id, version)
            assert out.ok, out
            version = out.rows[0][1]
        assert version == 35
        kept = [r[0] for r in s.rows("select version from public.agent_workflow_draft_versions where draft_id = %s order by version", [draft_id])]
        assert kept == list(range(6, 36)), kept
        assert s.value("select current_version from public.agent_workflow_drafts where id = %s", [draft_id]) == 35


def test_thirty_versions_are_all_kept(conn, sc):
    with acting(conn, sc.stranger) as s:
        draft_id, version = _new(s)
        for _ in range(29):
            version = _save(s, draft_id, version).rows[0][1]
        assert s.value("select count(*) from public.agent_workflow_draft_versions where draft_id = %s", [draft_id]) == 30
        assert s.value("select min(version) from public.agent_workflow_draft_versions where draft_id = %s", [draft_id]) == 1


# ── two connections at once ─────────────────────────────────────────────────
# A database of its own: these tests COMMIT (a race needs two transactions that see each other's commits), and the last one runs the
# rollback for real.

@pytest.fixture(scope="module")
def race():
    from sec_scenario import _signup

    dsn = sec_db.admin_dsn()
    name = f"ns_security_agent_race_{uuid.uuid4().hex[:8]}"
    db = sec_db.build(dsn, name)
    c = psycopg.connect(db, autocommit=True)
    try:
        who = user("racer", f"racer-{uuid.uuid4().hex[:6]}@example.com")
        _signup(c, who)
        _promote(c, who)  # the racer is a platform admin in this database for good (0234)
        yield {"dsn": db, "conn": c, "who": who}
    finally:
        c.close()
        if not os.environ.get("NIGHTSHIFT_SECURITY_KEEP"):
            sec_db.drop_database(dsn, name)


def _session(dsn: str, who) -> psycopg.Connection:
    c = psycopg.connect(dsn)
    c.execute("select set_config('request.jwt.claims', %s, true)", [json.dumps(who.claims())])
    c.execute("select set_config('request.jwt.claim.role', %s, true)", [who.role])
    c.execute(f"set local role {who.role}")
    return c


def _reset(r) -> None:
    with as_superuser(r["conn"]) as s:
        s.conn.execute("delete from public.agent_workflow_drafts where owner_id = %s", [r["who"].uid])


def _together(r, calls, hold_s: float = 0.4):
    """Each (draft_id, expected) save in its own connection and transaction, all started at once; each commits `hold_s` after it
    answered. Returns ("ok", version) or (sqlstate, message) per call."""
    barrier = threading.Barrier(len(calls))
    out = [None] * len(calls)

    def one(i, args):
        c = _session(r["dsn"], r["who"])
        try:
            barrier.wait()
            try:
                v = c.execute(SAVE, [*args, json.dumps(DOCUMENT)]).fetchone()[1]
                time.sleep(hold_s)
                c.commit()
                out[i] = ("ok", v)
            except psycopg.Error as e:
                c.rollback()
                out[i] = (e.sqlstate, str(e).splitlines()[0])
        finally:
            c.close()

    threads = [threading.Thread(target=one, args=(i, a)) for i, a in enumerate(calls)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(30)
    return out


def _count(r) -> int:
    with as_superuser(r["conn"], commit=False) as s:
        return s.value("select count(*) from public.agent_workflow_drafts where owner_id = %s", [r["who"].uid])


def test_two_creates_at_once_at_forty_nine_plans_make_exactly_one(race):
    _reset(race)
    with acting(race["conn"], race["who"], commit=True) as s:
        for _ in range(49):
            _new(s)
    out = _together(race, [(None, None), (None, None)])
    assert sorted(o[0] for o in out) == ["22023", "ok"], out
    assert ("22023", "agent_draft_limit") in out, out
    assert _count(race) == 50
    _reset(race)


def test_two_saves_at_once_on_the_same_version_make_one_version_and_one_conflict(race):
    _reset(race)
    with acting(race["conn"], race["who"], commit=True) as s:
        draft_id, _ = _new(s)
    out = _together(race, [(draft_id, 1), (draft_id, 1)])
    assert sorted(out) == [("40001", "version_conflict"), ("ok", 2)], out
    with as_superuser(race["conn"], commit=False) as s:
        assert s.value("select count(*) from public.agent_workflow_draft_versions where draft_id = %s", [draft_id]) == 2
    _reset(race)


# ── the rollback ────────────────────────────────────────────────────────────

def _rollback_sql(override: bool = False) -> str:
    text = ROLLBACK.read_text(encoding="utf-8")
    assert text.count("set local lock_timeout = '5s';") == 1
    text = text.replace("set local lock_timeout = '5s';", "set local lock_timeout = '2s';")
    if override:
        marker = "-- set local nightshift.rollback_0130_discard_drafts = 'on';"
        assert text.count(marker) == 1
        text = text.replace(marker, marker[3:])
    return text


def _paste(r, text: str) -> None:
    """The file as the owner pastes it, on a connection of its own (a refusal leaves that connection's transaction aborted)."""
    with psycopg.connect(r["dsn"], autocommit=True) as c:
        c.execute(text)


def _gone(r) -> bool:
    with as_superuser(r["conn"], commit=False) as s:
        return s.value("select to_regclass('public.agent_workflow_drafts') is null "
                       "and to_regprocedure('public.save_agent_workflow_draft(uuid, integer, jsonb)') is null")


def test_the_rollback_refuses_while_plans_exist_then_takes_everything_out_with_its_override_and_0130_applies_again(race):
    _reset(race)
    with acting(race["conn"], race["who"], commit=True) as s:
        _new(s)
    # rollback_0130 refuses 0234's bodies (it would undo them silently): 0234 comes off first, and goes back on at the end.
    with pytest.raises(psycopg.Error) as e:
        _paste(race, _rollback_sql())
    assert "not 0130's body" in str(e.value), e.value
    sec_db.take_off_0234(race["conn"])
    with pytest.raises(psycopg.Error) as e:
        _paste(race, _rollback_sql())
    assert "plans exist" in str(e.value), e.value
    assert not _gone(race) and _count(race) == 1

    _paste(race, _rollback_sql(override=True))
    assert _gone(race)
    with as_superuser(race["conn"], commit=False) as s:
        assert s.value("select to_regprocedure('public.delete_agent_workflow_draft(uuid)') is null")
        assert s.value("select to_regclass('public.agent_workflow_draft_versions') is null")

    race["conn"].execute(MIGRATION.read_text(encoding="utf-8"))
    assert not _gone(race)
    with acting(race["conn"], race["who"]) as s:
        _new(s)
    # An empty database needs no override.
    _paste(race, _rollback_sql())
    assert _gone(race)
    race["conn"].execute(MIGRATION.read_text(encoding="utf-8"))
    sec_db.put_back_0234(race["conn"])
    assert sec_db.has_0234(race["conn"])


def test_the_rollback_refuses_a_function_that_is_not_0130s(race):
    _reset(race)
    with as_superuser(race["conn"], commit=False) as s:
        s.conn.execute(sec_db.rollback_0234_body())  # 0130's bodies, so the tampered one below is the only difference
        body = s.value("select pg_get_functiondef('public.delete_agent_workflow_draft(uuid)'::regprocedure)")
        s.conn.execute(body.replace("if not found then", "if not found and true then"))
        with pytest.raises(psycopg.Error) as e:
            s.conn.execute("\n".join(ln for ln in _rollback_sql().splitlines() if ln.strip() not in ("begin;", "commit;")))
        assert "not 0130's body" in str(e.value), e.value

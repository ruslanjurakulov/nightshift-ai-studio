"""Tenant isolation, table by table, for every RLS table in the database.

Bob (org B) is the attacker and Alice (org A) the victim throughout. For each
table in sec_expectations.TABLES:

  read    Bob sees only org B's rows — and does see them, where the table is
          his to read (the positive control); a stranger with no organization
          and the anon key see nothing that is not declared public.
  update  Bob cannot change a single row of Alice's.
  delete  Bob cannot delete a single row of Alice's.
  move    Bob cannot re-point one of his own rows at Alice's organization,
          channel or video (the WITH CHECK half of each policy).
  insert  Bob cannot create a row in Alice's scope, by cloning one of his own
          rows and pointing it at hers; and he can insert into his own scope
          exactly where the table declares an insert path.

An attack "fails" when Postgres refuses it (a privilege or policy error, a
trigger's refusal) or when it touches zero rows. Every attack runs in a
transaction that is rolled back, so no test can depend on another's leftovers.
"""

from __future__ import annotations

import json
import random
import uuid

import pytest

from psycopg import sql

from sec_db import ANON, acting, as_superuser
from sec_expectations import TABLES, Kind
from sec_scenario import DEFAULT_ORG

ALL = sorted(TABLES)
SCOPED = sorted(t for t, k in TABLES.items() if k.kind in ("org", "channel", "video"))


def T(table: str) -> sql.Composed:
    return sql.SQL("public.{}").format(sql.Identifier(table))


# ── ground truth ────────────────────────────────────────────────────────────

def owner_of(sc, kind: Kind, row: dict):
    """The organization a row belongs to, as the expectations define it;
    'platform' for the operator's channel-less rows."""
    if kind.kind == "org":
        return row.get(kind.col)
    if kind.kind == "channel":
        ch = row.get(kind.col)
        if ch is None:
            return "platform" if kind.null_is_platform else None
        return sc.org_of_channel(ch)
    if kind.kind == "video":
        return sc.org_of_video(row.get(kind.col))
    return None


def scope_value(sc, tenant, kind: Kind):
    return {"org": tenant.org, "channel": tenant.channel, "video": tenant.video}[kind.kind]


def scope_predicate(sc, tenant, table: str):
    """SQL + params selecting `tenant`'s rows of `table` (every row, for a
    table that belongs to nobody in particular)."""
    kind = TABLES[table]
    if kind.kind in ("org", "channel", "video"):
        return sql.SQL("{} = %s").format(sql.Identifier(kind.col)), [scope_value(sc, tenant, kind)]
    return sql.SQL("true"), []


def _selectable(conn, table: str, role: str) -> list[str]:
    with as_superuser(conn, commit=False) as s:
        return [r[0] for r in s.rows(
            "select column_name from information_schema.columns "
            "where table_schema = 'public' and table_name = %s "
            "and has_column_privilege(%s, format('public.%%I', table_name), column_name, 'SELECT') "
            "order by ordinal_position", [table, role])]


def read_as(conn, who, table: str):
    """Every row `who` can see, as dicts of the columns their role may select
    (api_keys, for one, withholds key_hash column by column)."""
    cols = _selectable(conn, table, who.role)
    if not cols:
        with acting(conn, who) as s:
            return s.run(sql.SQL("select to_jsonb(t) from {} t").format(T(table)))
    obj = sql.SQL(", ").join(sql.SQL("{}, {}").format(sql.Literal(c), sql.Identifier(c)) for c in cols)
    with acting(conn, who) as s:
        return s.run(sql.SQL("select jsonb_build_object({}) from {}").format(obj, T(table)))


def count_as_owner(s, table: str, pred, params) -> int:
    return s.value(sql.SQL("select count(*) from {} where ").format(T(table)) + pred, params)


def refused(out) -> bool:
    return (not out.ok) or out.rowcount == 0


# ── reads ───────────────────────────────────────────────────────────────────

@pytest.mark.parametrize("table", ALL)
def test_tenant_reads_only_its_own_rows(conn, sc, table):
    kind = TABLES[table]
    out = read_as(conn, sc.bob.actor, table)
    rows = [r[0] for r in out.rows] if out.ok else []
    if kind.kind in ("platform", "service"):
        assert rows == [], f"{table}: Bob (a customer) reads operator/service rows: {rows[:3]}"
        return
    if kind.kind == "public":
        assert out.ok, f"{table} is declared public but a signed-in user cannot read it: {out!r}"
        return
    owners = {owner_of(sc, kind, r) for r in rows}
    leaked = [r for r in rows if owner_of(sc, kind, r) != sc.bob.org]
    assert not leaked, f"{table}: Bob reads rows that are not org B's: {leaked[:3]}"
    if kind.own_read:
        assert sc.bob.org in owners, f"{table}: Bob cannot read his own rows ({out!r}) — the isolation check would be vacuous"


@pytest.mark.parametrize("table", ALL)
def test_stranger_with_no_organization_reads_nothing(conn, sc, table):
    kind = TABLES[table]
    out = read_as(conn, sc.stranger, table)
    if kind.kind == "public":
        assert out.ok
        return
    assert (not out.ok) or out.rows == [], f"{table}: a signed-in stranger reads {[r[0] for r in out.rows][:3]}"


@pytest.mark.parametrize("table", ALL)
def test_anon_reads_nothing(conn, sc, table):
    kind = TABLES[table]
    out = read_as(conn, ANON, table)
    if kind.kind == "public" and kind.anon:
        assert out.ok
        return
    assert (not out.ok) or out.rows == [], f"{table}: the anon key reads {[r[0] for r in out.rows][:3]}"


@pytest.mark.parametrize("table", SCOPED)
def test_platform_admin_still_reads_every_tenant(conn, sc, table):
    # The other half of isolation: the operator must not be locked out of a
    # customer's data by a tightened policy (support, refunds, abuse).
    kind = TABLES[table]
    if not kind.own_read:
        pytest.fail(f"{table}: scoped tables are expected to be readable by their tenant")
    out = read_as(conn, sc.operator, table)
    assert out.ok, out
    owners = {owner_of(sc, kind, r[0]) for r in out.rows}
    assert {sc.alice.org, sc.bob.org} <= owners, f"{table}: the platform admin sees only {owners}"


# ── updates and deletes ─────────────────────────────────────────────────────

def _update_column(conn, table: str, role: str):
    """The column an UPDATE attack writes, and its type. Preference: one the
    grant allows (so the attack reaches the row-level check instead of
    stopping at the privilege), not part of a key (a blind write to a key
    collides with itself and fails for the wrong reason), text first (any
    value is valid). Else the first column."""
    uniques = _unique_columns(conn, table)
    with as_superuser(conn, commit=False) as s:
        cols = s.rows(
            "select column_name, udt_name, "
            "has_column_privilege(%s, format('public.%%I', table_name), column_name, 'UPDATE') "
            "from information_schema.columns where table_schema = 'public' and table_name = %s order by ordinal_position",
            [role, table])
    ranked = sorted(cols, key=lambda c: (not c[2], c[0] in uniques, c[1] not in ("text", "varchar")))
    name, udt, _ = ranked[0]
    return name, udt


def _different(udt: str, current):
    """A value of type `udt` that differs from `current`."""
    if udt in ("text", "varchar"):
        return "pwned" if current != "pwned" else "pwned2"
    if udt == "bool":
        return not bool(current)
    if udt in ("int2", "int4", "int8", "float4", "float8", "numeric"):
        return (current or 0) + 1
    if udt == "uuid":
        return str(uuid.uuid4())
    if udt in ("json", "jsonb"):
        return json.dumps({"pwned": True})
    if udt in ("timestamptz", "timestamp", "date"):
        return "2001-01-01"
    return None


def _snapshot(s, table: str, col: str, pred, params) -> list:
    return sorted(json.dumps(r[0], default=str) for r in s.rows(
        sql.SQL("select {} from {} where ").format(sql.Identifier(col), T(table)) + pred, params))


def _blind_update(conn, who, table: str, victim_pred, victim_params):
    """UPDATE with no WHERE clause and a constant on the right: nothing is
    read, so only the UPDATE policies stand between the caller and every row
    (a WHERE clause would pull the SELECT policies in and hide a loose UPDATE
    policy). Returns (outcome, victim rows before, after)."""
    col, udt = _update_column(conn, table, who.role)
    with as_superuser(conn, commit=False) as s:
        before = _snapshot(s, table, col, victim_pred, victim_params)
        current = s.value(sql.SQL("select {} from {} where ").format(sql.Identifier(col), T(table)) + victim_pred
                          + sql.SQL(" limit 1"), victim_params)
    value = _different(udt, current)
    with acting(conn, who) as s:
        out = s.run(sql.SQL("update {} set {} = %s::{}").format(T(table), sql.Identifier(col), sql.Identifier(udt)),
                    [value])
        s.conn.execute("reset role")
        after = _snapshot(s, table, col, victim_pred, victim_params)
    return out, before, after


def _blind_delete(conn, who, table: str, victim_pred, victim_params):
    with as_superuser(conn, commit=False) as s:
        before = count_as_owner(s, table, victim_pred, victim_params)
    with acting(conn, who) as s:
        out = s.run(sql.SQL("delete from {}").format(T(table)))
        s.conn.execute("reset role")
        after = count_as_owner(s, table, victim_pred, victim_params)
    return out, before, after


def _victim(sc, table: str):
    """Alice's rows; for a table that belongs to nobody in particular, every row."""
    return scope_predicate(sc, sc.alice, table)


@pytest.mark.parametrize("table", ALL)
def test_tenant_cannot_update_another_tenants_rows(conn, sc, table):
    pred, params = _victim(sc, table)
    col, _ = _update_column(conn, table, "authenticated")
    with acting(conn, sc.bob.actor) as s:
        targeted = s.run(sql.SQL("update {} set {c} = {c} where ").format(T(table), c=sql.Identifier(col)) + pred, params)
    assert refused(targeted), f"{table}: Bob updated {targeted.rowcount} of org A's rows"
    out, before, after = _blind_update(conn, sc.bob.actor, table, pred, params)
    assert before == after, f"{table}: a blind UPDATE by Bob changed org A's rows ({out!r})"


@pytest.mark.parametrize("table", ALL)
def test_tenant_cannot_delete_another_tenants_rows(conn, sc, table):
    pred, params = _victim(sc, table)
    with acting(conn, sc.bob.actor) as s:
        targeted = s.run(sql.SQL("delete from {} where ").format(T(table)) + pred, params)
    assert refused(targeted), f"{table}: Bob deleted {targeted.rowcount} of org A's rows"
    out, before, after = _blind_delete(conn, sc.bob.actor, table, pred, params)
    assert before == after, f"{table}: a blind DELETE by Bob removed {before - after} of org A's rows ({out!r})"


@pytest.mark.parametrize("table", ALL)
def test_stranger_and_anon_cannot_update_or_delete(conn, sc, table):
    everything = (sql.SQL("true"), [])
    for who in (sc.stranger, ANON):
        out, before, after = _blind_update(conn, who, table, *everything)
        assert before == after, f"{table}: a blind UPDATE by {who.name} changed rows ({out!r})"
        out, before, after = _blind_delete(conn, who, table, *everything)
        assert before == after, f"{table}: a blind DELETE by {who.name} removed {before - after} rows ({out!r})"


@pytest.mark.parametrize("table", SCOPED)
def test_tenant_cannot_move_own_rows_into_another_tenant(conn, sc, table):
    kind = TABLES[table]
    col = sql.Identifier(kind.col)
    target = scope_value(sc, sc.alice, kind)
    pred, params = scope_predicate(sc, sc.bob, table)
    with acting(conn, sc.bob.actor) as s:
        out = s.run(sql.SQL("update {} set {} = %s where ").format(T(table), col) + pred, [target, *params])
    assert refused(out), f"{table}: Bob moved {out.rowcount} of his rows into org A"


# ── inserts ─────────────────────────────────────────────────────────────────

def _columns(conn, table: str, role: str):
    with as_superuser(conn, commit=False) as s:
        return s.rows(
            """
            select c.column_name, c.udt_name,
                   (c.column_default is not null or c.is_identity = 'YES') as has_default,
                   has_column_privilege(%s, format('public.%%I', c.table_name), c.column_name, 'INSERT')
              from information_schema.columns c
             where c.table_schema = 'public' and c.table_name = %s
             order by c.ordinal_position
            """, [role, table])


def _unique_columns(conn, table: str) -> set[str]:
    with as_superuser(conn, commit=False) as s:
        rows = s.rows(
            """
            select a.attname from pg_constraint k
              join pg_attribute a on a.attrelid = k.conrelid and a.attnum = any (k.conkey)
             where k.conrelid = format('public.%%I', %s::text)::regclass and k.contype in ('p', 'u')
            union
            select a.attname from pg_index i
              join pg_attribute a on a.attrelid = i.indrelid and a.attnum = any (i.indkey)
             where i.indrelid = format('public.%%I', %s::text)::regclass and i.indisunique
               and i.indpred is null  -- a partial index is conditional; its columns are often foreign keys
            """, [table, table])
    return {r[0] for r in rows}


def _fresh(value, udt: str):
    if value is None:
        return None
    if udt == "uuid":
        return str(uuid.uuid4())
    if udt in ("int2", "int4", "int8"):
        return random.randint(10_000_000, 99_999_999)
    if udt in ("float4", "float8", "numeric"):
        return float(value) + random.random() / 1000
    if udt in ("text", "varchar"):
        return f"{value}-x{random.randint(1000, 9999)}"
    return value


def _clone(conn, sc, table: str, tenant, role: str, scope_to=None):
    """One of `tenant`'s rows as an insertable dict: unique keys refreshed,
    only the columns `role` may insert, and (optionally) its scope column
    pointed at `scope_to`."""
    kind = TABLES[table]
    pred, params = scope_predicate(sc, tenant, table)
    with as_superuser(conn, commit=False) as s:
        row = s.value(sql.SQL("select to_jsonb(t) from {} t where ").format(T(table)) + pred + sql.SQL(" limit 1"), params)
    assert row is not None, f"{table}: the scenario seeded no row for org {tenant.key.upper()}"
    uniques = _unique_columns(conn, table) | set(kind.mutate)
    out = {}
    for name, udt, has_default, may_insert in _columns(conn, table, role):
        if not may_insert:
            continue
        if kind.col == name and scope_to is not None:
            out[name] = scope_to
        elif name in uniques and name != kind.col:
            if has_default:
                continue
            out[name] = _fresh(row.get(name), udt)
        else:
            out[name] = row.get(name)
    return out


def _insert(s, table: str, row: dict):
    if not row:
        return s.run(sql.SQL("insert into {} default values").format(T(table)))
    cols = sql.SQL(", ").join(sql.Identifier(c) for c in row)
    return s.run(
        sql.SQL("insert into {t} ({cols}) select {cols} from jsonb_populate_record(null::{t}, %s::jsonb)")
        .format(t=T(table), cols=cols),
        [json.dumps(row, default=str)])


@pytest.mark.parametrize("table", ALL)
def test_tenant_inserts_into_its_own_scope_only_where_declared(conn, sc, table):
    kind = TABLES[table]
    if kind.kind not in ("org", "channel", "video"):
        row = _clone(conn, sc, table, sc.bob, "authenticated")
        with acting(conn, sc.bob.actor) as s:
            out = _insert(s, table, row)
        assert refused(out), f"{table}: a customer inserted into a {kind.kind} table"
        return
    row = _clone(conn, sc, table, sc.bob, "authenticated")
    with acting(conn, sc.bob.actor) as s:
        out = _insert(s, table, row)
    if kind.own_insert:
        assert out.ok and out.rowcount == 1, f"{table}: declared own_insert but Bob cannot insert his own row: {out!r}"
    else:
        assert refused(out), (f"{table}: Bob can insert rows directly ({out!r}) — declare own_insert=True in "
                              "sec_expectations if that is intended")


@pytest.mark.parametrize("table", SCOPED)
def test_tenant_cannot_insert_into_another_tenant(conn, sc, table):
    kind = TABLES[table]
    victim = scope_value(sc, sc.alice, kind)
    row = _clone(conn, sc, table, sc.bob, "authenticated", scope_to=victim)
    pred, params = scope_predicate(sc, sc.alice, table)
    with acting(conn, sc.bob.actor) as s:
        out = _insert(s, table, row)
        s.conn.execute("reset role")
        after = count_as_owner(s, table, pred, params)
    with as_superuser(conn, commit=False) as s:
        before = count_as_owner(s, table, pred, params)
    assert after == before, f"{table}: Bob created a row in org A ({out!r})"


@pytest.mark.parametrize("table", ALL)
def test_stranger_and_anon_cannot_insert(conn, sc, table):
    for who, role in ((sc.stranger, "authenticated"), (ANON, "anon")):
        row = _clone(conn, sc, table, sc.bob, role)
        with acting(conn, who) as s:
            out = _insert(s, table, row)
        assert refused(out), f"{table}: {who.name} inserted a row ({out!r})"


def test_the_default_org_is_nobody_elses(conn, sc):
    # The operator's own organization is where every pre-SaaS channel lives.
    for who in (sc.bob.actor, sc.stranger):
        with acting(conn, who) as s:
            assert s.value("select public.is_org_member(%s, 'viewer')", [DEFAULT_ORG]) is False
            assert s.rows("select 1 from public.channels where org_id = %s", [DEFAULT_ORG]) == []

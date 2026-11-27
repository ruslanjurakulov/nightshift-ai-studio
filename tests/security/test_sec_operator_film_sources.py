"""The operator bot's film reads (modules/operator_bot/sources.py), run against the real 0166/0171 schema.

The unit tests (tests/test_operator_film_alerts.py) feed the alert engine canned rows through a fake that ignores every
PostgREST filter, so they cannot show that the columns exist, that the service role may read them, or that a jsonb path
select and the ``not_captured`` filter mean what the Python expects. Here the bot's OWN read parameters are captured from
``OperatorSources`` and turned into the SQL PostgREST produces for them (``a:detail->>b`` is ``"detail"->>'b' as "a"``,
``detail->>x=not.is.null`` is ``"detail"->>'x' is not null``), executed as ``service_role`` (the role the bot's key is),
against rows the real 0171 functions wrote:

  * a settle whose hold 0020 had already released (``segment_settled`` with ``detail.not_captured``);
  * a settle that captured everything (no ``not_captured``): the filter must leave it out;
  * a skipped segment (``film_record_skip``, the function 0171's claim and sweep call);
  * the security_events fallback, written by ``security_event_log`` with film_record_skip's own detail shape;
  * an open segment queued past the 15 minute line.

What would break: a renamed column or a missing grant (the read fails, the gate goes blind), a path select that returns
something other than the text the Python parses, a filter that lets ordinary settles fill the row limit, or the database's
own message reaching the bot. A translation the helper does not know fails the test rather than being guessed.

``film_sweep_status()`` (0212) is not in this branch's migration chain (it lives on claude/nsai-s2-sweep); its part is
skipped with that reason until it is, and then runs.
"""

from __future__ import annotations

import json
import re
from datetime import datetime, timedelta, timezone
from decimal import Decimal

import psycopg
import pytest
from psycopg.rows import dict_row

from modules.operator_bot import alerts, analysis
from modules.operator_bot.config import OperatorConfig
from modules.operator_bot.sources import OperatorSources
from test_sec_films_money import a, claims, db, no_live_segment  # noqa: F401 — the money lab's fixtures, reused as they are

_COL = re.compile(r"[a-z_][a-z0-9_]*")
_PATH = re.compile(r"^([a-z_][a-z0-9_]*)->>([a-z_][a-z0-9_]*)$")


def _expr(name: str) -> str:
    """A PostgREST column or ``col->>key`` path as SQL; anything else is refused."""
    m = _PATH.match(name)
    if m:
        return f'"{m.group(1)}"->>\'{m.group(2)}\''
    assert _COL.fullmatch(name), f"the lab does not translate column {name!r}"
    return f'"{name}"'


def postgrest_sql(table: str, params: dict) -> tuple[str, list]:
    """The SELECT PostgREST builds for ``GET /rest/v1/<table>?<params>``, for the operators the bot uses."""
    assert _COL.fullmatch(table), table
    cols = []
    for item in params["select"].split(","):
        alias, _, path = item.partition(":")
        cols.append(f'{_expr(path)} as "{alias}"' if path else _expr(alias))
    where, args, order, limit = [], [], "", ""
    for key, cond in params.items():
        if key == "select":
            continue
        if key == "order":
            col, _, way = cond.partition(".")
            assert way in ("asc", "desc"), cond
            order = f" order by {_expr(col)} {way}"
        elif key == "limit":
            limit = f" limit {int(cond)}"
        elif cond == "not.is.null":
            where.append(f"{_expr(key)} is not null")
        elif cond == "is.null":
            where.append(f"{_expr(key)} is null")
        elif cond.startswith("eq."):
            where.append(f"{_expr(key)}::text = %s")
            args.append(cond[3:])
        elif cond.startswith("gte."):
            where.append(f"{_expr(key)} >= %s::timestamptz")
            args.append(cond[4:])
        elif cond.startswith("in.(") and cond.endswith(")"):
            where.append(f"{_expr(key)}::text = any(%s)")
            args.append(cond[4:-1].split(","))
        else:
            raise AssertionError(f"the lab does not translate {key}={cond}")
    return (f"select {', '.join(cols)} from public.{table}" + (f" where {' and '.join(where)}" if where else "")
            + order + limit), args


def _json(v):
    """What PostgREST's JSON would carry: text for ids, timestamps and numerics."""
    if isinstance(v, datetime):
        return v.isoformat()
    if isinstance(v, Decimal):
        return str(v)
    if v is None or isinstance(v, (bool, int, float, str)):
        return v
    return str(v)


class LabSync:
    """A SupabaseSync stand-in that runs every read as service_role against the lab, and keeps the SQL it ran."""

    enabled = True

    def __init__(self, dsn: str):
        self.dsn = dsn
        self.ran: list = []

    def select_strict(self, table, params=None):
        q, args = postgrest_sql(table, dict(params or {}))
        self.ran.append((table, q))
        with psycopg.connect(self.dsn, autocommit=False, row_factory=dict_row) as c:
            c.execute("select set_config('request.jwt.claims', %s, true)", [claims("service_role")])
            c.execute("set local role service_role")
            rows = c.execute(q, args).fetchall()
            c.rollback()
        return [{k: _json(v) for k, v in r.items()} for r in rows]

    def rpc_strict(self, name, body=None):
        assert _COL.fullmatch(name), name
        with psycopg.connect(self.dsn, autocommit=False) as c:
            c.execute("select set_config('request.jwt.claims', %s, true)", [claims("service_role")])
            c.execute("set local role service_role")
            out = c.execute(f"select public.{name}()").fetchone()[0]
            c.rollback()
        return out


MESSAGE = "lab: PROMPT-TEXT a lighthouse at dusk, the database's own words"


def ops_for(db):
    sync = LabSync(db.dsn)
    cfg = OperatorConfig(app_url="https://app.example.test", github_repo="owner/repo")
    return OperatorSources(sync, lambda *_args: (None, None), cfg, now=lambda: datetime.now(timezone.utc)), sync


def test_the_bots_film_reads_run_as_the_service_role_on_the_real_schema_and_mean_what_the_python_expects(db, a):
    # 1. A settle that could not capture: the hold was released under a half-made film (0171's own path).
    short = db.film(a)
    seg_short = db.quoted_start(a, short)
    assert db.claim()["id"] == seg_short["id"]
    db.make(a, db.takes(seg_short["id"])[0][0], "keyframe")
    db.su("select public.release_credits(%s)", [seg_short["credit_ref"]])
    db.settle(seg_short["id"], "hold_expired")
    # 2. A settle with nothing uncaptured: never claimed, cancelled; segment_settled without the key.
    plain = db.film(a)
    seg_plain = db.quoted_start(a, plain)
    db.cancel(seg_plain["id"])
    ordinary = db.su("select count(*) from public.film_events where event = 'segment_settled' "
                     "and not (detail ? 'not_captured')")[0][0]
    assert ordinary >= 1, "the lab needs an ordinary settle to show the filter leaves it out"
    # 3. A skipped segment, through the function 0171's claim and sweep call, with a message the bot must never read.
    db.su("select public.film_record_skip(%s, %s, %s, 'claim', '40P01', %s)", [short, a.org, seg_short["id"], MESSAGE])
    # 4. The fallback row, in film_record_skip's own detail shape.
    db.su("select public.security_event_log('film.segment_skipped', 'warning', %s, jsonb_build_object("
          "'call', 'sweep', 'sqlstate', '23505', 'message', %s::text, 'film_events_failed', 'XX000'))",
          [seg_plain["id"], MESSAGE])
    # 5. An open segment nobody claimed for 30 minutes.
    stuck_film = db.film(a)
    seg_open = db.quoted_start(a, stuck_film)
    db.su("update public.film_segments set created_at = now() - interval '30 minutes' where id = %s", [seg_open["id"]])

    ops, sync = ops_for(db)
    since = datetime.now(timezone.utc) - timedelta(hours=24)

    ev = ops.film_alert_events(since)
    assert ev.ok, ev.note
    settled = [r for r in ev.data if r["event"] == "segment_settled"]
    assert [r["film_id"] for r in settled] == [str(short)], "only the settle WITH not_captured comes back"
    assert settled[0]["segment_id"] == str(seg_short["id"]) and settled[0]["org_id"] == str(a.org)
    assert analysis.film_not_captured(settled[0]) == 3.0, settled[0]          # ->> is text; the Python parses it
    skipped = [r for r in ev.data if r["event"] == "segment_skipped"]
    assert [(r["segment_id"], r["call"], r["sqlstate"]) for r in skipped] == [(str(seg_short["id"]), "claim", "40P01")]

    fb = ops.film_skip_fallbacks(since)
    assert fb.ok, fb.note
    assert [(r["target"], r["call"], r["sqlstate"]) for r in fb.data] == [(str(seg_plain["id"]), "sweep", "23505")]

    seg = ops.film_open_segments()
    assert seg.ok, seg.note
    assert {r["id"] for r in seg.data} == {str(seg_open["id"])}
    assert set(seg.data[0]) == {"id", "org_id", "status", "created_at", "claimed_at", "heartbeat_at", "updated_at"}

    # Nothing read carries the database's message, an actor or a whole detail.
    everything = json.dumps([ev.data, fb.data, seg.data])
    assert "PROMPT-TEXT" not in everything and "film_events_failed" not in everything and "@" not in everything
    assert all('"detail" as' not in q and "actor" not in q and "*" not in q for _t, q in sync.ran), sync.ran

    # And the engine turns exactly these rows into the four alerts, keyed on the real ids.
    found = {x.key: x for x in alerts.detect(ops, 15000) if x.kind == "film"}
    nc = [k for k in found if k.startswith("film:not_captured:")]
    assert len(nc) == 1 and found[nc[0]].severity == "critical" and "3.00 credits" in found[nc[0]].line
    assert any(k.startswith("film:skipped:") and not k.startswith("film:skipped:sec:") for k in found)
    assert any(k.startswith("film:skipped:sec:") for k in found)
    assert f"film:stuck:{seg_open['id']}" in found
    assert all("PROMPT-TEXT" not in x.line and str(a.org) not in x.line for x in found.values())


def test_film_sweep_status_is_read_as_the_service_role_when_0212_is_applied(db):
    if not db.su("select to_regprocedure('public.film_sweep_status()') is not null")[0][0]:
        pytest.skip("0212 (film_sweep_status) is not in this branch's migration chain: it is on claude/nsai-s2-sweep. "
                    "This part runs once both are merged.")
    ops, _sync = ops_for(db)
    sec = ops.film_sweep_status()
    assert sec.ok, sec.note
    st = analysis.film_sweep_state(sec.data)
    assert st["answered"] is True and st["overdue"] in (True, False, None)
    assert st["after_min"] is not None and st["open"] is not None

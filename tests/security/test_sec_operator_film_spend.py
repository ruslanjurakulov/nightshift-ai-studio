"""The film spend watch's reads (modules/operator_bot/sources.py ``film_spend``), run against the real schema.

The unit tests (tests/test_operator_film_spend.py) feed canned rows through a fake that ignores every PostgREST filter, so
they cannot show that the columns exist, that the service role may read them, that ``creative_jobs.film_take_id`` is how a
take's job is found, or that ``spec->pricing->>provider_usd_per_unit`` picks out the registry's figure. Here the bot's OWN
read parameters are turned into the SQL PostgREST builds for them and executed as ``service_role`` (the role the bot's key
is), against rows the real functions wrote: 0171's start, claim, begin, succeed, fail and cancel, 0198's
``film_take_job`` (the one writer of a film take's creative job) and 0037's ``record_creative_job_cost``:

  * film 1: a key frame whose cost row has a quantity only (as every adapter writes it), on a model priced in variants,
    estimated at its dearest variant (past the warn line), and a clip that failed at its vendor with no cost row (not
    recorded);
  * film 2, another organization: a key frame whose row carries its own usd_estimate (recorded, past the stop line), and a
    clip on a model whose variant table states no figure (unknown, never 0 and never its base figure).

What would break: a renamed column or a missing grant (the watch goes blind), a path select that returns something other
than the text the Python parses, a sum that differs from the one the runbook's SQL computes, a prompt or a price source's
text reaching the bot, or a failed call (price_source failed_call, written through the workers' own record path) priced as
a delivered one, read as recorded, or read as USD 0. A translation the helper does not know fails the test rather than being guessed.
"""

from __future__ import annotations

import json
import re
from datetime import datetime, timedelta, timezone
from decimal import Decimal

import psycopg
import pytest
from psycopg.rows import dict_row

from modules.operator_bot import alerts
from modules.operator_bot.config import OperatorConfig
from modules.operator_bot.sources import OperatorSources
from test_sec_films_money import a, claims, db, no_live_segment  # noqa: F401 — the money lab's fixtures, reused as they are

_COL = re.compile(r"[a-z_][a-z0-9_]*")
_PATH = re.compile(r"^([a-z_][a-z0-9_]*)((?:->[a-z_][a-z0-9_]*)*)->(>?)([a-z_][a-z0-9_]*)$")

KEYFRAME_USD_PER_IMAGE = Decimal("6.5")     # img-key's DEAREST variant: one picture puts film 1 past USD 6
RECORDED_USD = Decimal("8.25")              # film 2's recorded row: past USD 8


def _expr(name: str) -> str:
    """A PostgREST column or ``col->a->>b`` path as SQL; anything else is refused."""
    m = _PATH.match(name)
    if m:
        hops = "".join(f"->'{h}'" for h in m.group(2).split("->") if h)
        return f'"{m.group(1)}"{hops}->{m.group(3)}\'{m.group(4)}\''
    assert _COL.fullmatch(name), f"the lab does not translate column {name!r}"
    return f'"{name}"'


def postgrest_sql(table: str, params: dict) -> tuple[str, list]:
    """The SELECT PostgREST builds for ``GET /rest/v1/<table>?<params>``, for the operators the bot's spend reads use."""
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
    """What PostgREST's JSON would carry: text for ids and timestamps, a number for a numeric."""
    if isinstance(v, datetime):
        return v.isoformat()
    if isinstance(v, Decimal):
        return float(v)
    if v is None or isinstance(v, (bool, int, float, str)):
        return v
    if isinstance(v, (dict, list)):
        return json.loads(json.dumps(v))      # a json path select (``a->b``) arrives as JSON, as PostgREST sends it
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


def take_job(db, take, worker="w-1"):
    out = db.svc("select public.film_take_job(%s, %s)", [take, worker])
    assert out["ok"] is True, out
    return out["job_id"]


def record_cost(db, job, unit, quantity, usd=None):
    db.svc("select public.record_creative_job_cost(%s, 'acme', 'exact', 'acme-lab', %s, %s::numeric, %s::numeric, %s)",
           [job, unit, quantity, usd, "lab price page" if usd is not None else None])


def test_the_columns_the_watch_reads_are_the_ones_0037_0166_and_0171_made(db):
    cols = dict(db.su("select table_name || '.' || column_name, data_type from information_schema.columns "
                      "where table_schema = 'public' and table_name in ('creative_job_costs', 'creative_jobs', 'film_takes') "
                      "and column_name in ('job_id', 'quantity', 'unit', 'usd_estimate', 'film_take_id', 'routed_model', "
                      "'requested_model', 'kind', 'attempt', 'status', 'film_id')"))
    assert cols["creative_job_costs.usd_estimate"] == "numeric"
    assert cols["creative_job_costs.quantity"] == "numeric"
    assert cols["creative_job_costs.unit"] == "text"
    assert cols["creative_jobs.film_take_id"] == "uuid"
    assert {"creative_jobs.routed_model", "creative_jobs.requested_model", "film_takes.kind", "film_takes.attempt",
            "film_takes.status", "film_takes.film_id"} <= set(cols)
    for table in ("films", "film_segments", "film_takes", "creative_jobs", "creative_job_costs", "model_registry"):
        assert db.su("select has_table_privilege('service_role', %s, 'SELECT')", [f"public.{table}"])[0][0], table
        assert not db.su("select has_table_privilege('service_role', %s, 'UPDATE')", ["public.creative_job_costs"])[0][0]


class _CapturingSession:
    """The HTTP session under CreativeRest: keeps the body record_cost posts, so the lab writes exactly what the worker sends."""

    def __init__(self):
        self.bodies = []

    def post(self, url, json=None, timeout=None, headers=None):
        assert url.endswith("/rest/v1/rpc/record_creative_job_cost"), url
        self.bodies.append(dict(json))

        class _R:
            status_code = 204

            @staticmethod
            def json():
                return None

        return _R()


def record_failed_call(db, job, capability, params, unit):
    """A failed call's row through the workers' own path: the registry adapter's usage for what was asked
    (creative_worker.failed_call_usage), sent by CreativeRest.record_cost, executed as the service role by 0037's function."""
    from types import SimpleNamespace

    from modules import creative_adapters as ca
    from modules import creative_worker as cw

    entry = SimpleNamespace(raw={"pricing": {"unit": unit}}, provider="acme", vendor_model_for=lambda cap: "acme-lab")
    request = cw.GenerationRequest(job_id=str(job), org_id="", capability=capability, model="m", params=params)
    usage = cw.failed_call_usage(ca.RegistryAdapter(entry, adapter=object(), sync_store={}), request)
    session = _CapturingSession()
    cw.CreativeRest("https://lab.example", "lab-key", session=session).record_cost(str(job), usage)
    (body,) = session.bodies
    db.svc("select public.record_creative_job_cost(%s, %s, %s, %s, %s, %s::numeric, %s::numeric, %s)",
           [body["p_job"], body["p_provider"], body["p_route"], body["p_vendor_model"], body["p_unit"], body["p_quantity"],
            body["p_usd"], body["p_price_source"]])
    return body


def test_a_failed_call_written_by_the_worker_is_estimated_as_one_and_a_failed_picture_is_unknown(db, a):
    film = db.film(a)
    s = db.quoted_start(a, film)
    assert db.claim()["id"] == s["id"]
    takes = db.takes(s["id"])
    kf, clip = takes[0][0], takes[1][0]
    db.begin(kf)
    body_kf = record_failed_call(db, take_job(db, kf), "t2i", {"prompt": "a lighthouse"}, "image")
    db.fail(kf, "provider_error")
    # 0171's retry of the key frame delivers (its own row is not this test's), so the clip has a picture to start from.
    retry = next(r[0] for r in db.takes(s["id"]) if r[1] == "keyframe" and r[9] == 2)
    db.begin(retry)
    take_job(db, retry)
    db.succeed(retry, None, db.output(a.org, retry, "image", "image/png"))
    db.begin(clip)
    body_clip = record_failed_call(db, take_job(db, clip), "i2v", {"duration_s": 10, "prompt": "a lighthouse"}, "second")
    db.fail(clip, "provider_error")
    db.cancel(s["id"])
    assert (body_kf["p_price_source"], body_kf["p_quantity"], body_kf["p_usd"]) == ("failed_call", None, None)
    assert (body_clip["p_price_source"], body_clip["p_quantity"]) == ("failed_call", 10.0)
    stored = db.su("select c.unit, c.quantity, c.usd_estimate, c.price_source from public.creative_job_costs c "
                   "join public.creative_jobs j on j.id = c.job_id join public.film_takes t on t.id = j.film_take_id "
                   "where t.film_id = %s order by c.unit", [film])
    assert [tuple(r) for r in stored] == [("image", None, None, "failed_call"), ("second", Decimal("10.0000"), None, "failed_call")]

    saved = db.su("select id, spec from public.model_registry where id in ('img-key', 'vid-clip')")
    try:
        _watch_the_failed_calls(db, film, kf, clip)
    finally:
        # The registry is shared with the next test of this module, which starts its films on these models.
        for model_id, spec in saved:
            db.su("update public.model_registry set spec = %s::jsonb where id = %s", [json.dumps(spec), model_id])


def _watch_the_failed_calls(db, film, kf, clip):
    db.su("update public.model_registry set spec = spec || jsonb_build_object('pricing', jsonb_build_object("
          "'unit', 'image', 'provider_usd_per_unit', 0.04, 'source_url', 'https://lab.example', 'as_of', '2026-11-01', "
          "'confirmed', false)) where id = 'img-key'")
    db.su("update public.model_registry set spec = spec || jsonb_build_object('pricing', jsonb_build_object("
          "'unit', 'second', 'provider_usd_per_unit', 0.05, 'source_url', 'https://lab.example', 'as_of', '2026-11-01', "
          "'confirmed', false)) where id = 'vid-clip'")

    sync = LabSync(db.dsn)
    cfg = OperatorConfig(app_url="https://app.example.test", github_repo="owner/repo")
    ops = OperatorSources(sync, lambda *_args: (None, None), cfg, now=lambda: datetime.now(timezone.utc))
    one = ops.film_spend_for(str(film))
    assert one.ok, one.note
    f = one.data[0]
    # The clip: 10 s asked x 0.05 = 0.50, an estimate of a failed call. The failed picture: no count, so unknown, never
    # USD 0; the retry that delivered wrote no row here, so it is the second unknown line (not recorded).
    assert (f["usd"], f["basis"], f["unknown"]) == (Decimal("0.5"), "estimated_failed_call", 2)
    by_take = {t["id"]: t for t in f["takes"]}
    assert (by_take[str(clip)]["basis"], by_take[str(clip)]["usd"]) == ("estimated_failed_call", Decimal("0.5"))
    assert (by_take[str(kf)]["state"], by_take[str(kf)]["usd"]) == ("unknown", None)
    assert "failed_call" not in json.dumps(one.data, default=str).replace("estimated_failed_call", "")


def _cleanup_sql():
    from pathlib import Path

    text = (Path(__file__).resolve().parents[2] / "docs" / "sql" / "oneoff_duplicate_film_cost_rows.sql").read_text(encoding="utf-8")
    read = text.split("-- 1. READ FIRST", 1)[1].split("-- 2. ONLY IF", 1)[0]
    read = "\n".join(ln for ln in read.splitlines()[1:] if not ln.lstrip().startswith("--"))
    block = text.split("-- begin;", 1)[1].split("-- commit;", 1)[0]
    delete = "\n".join(ln[3:] if ln.startswith("-- ") else ln.lstrip("-") for ln in block.splitlines())
    return read, delete


def test_the_owners_one_off_cleanup_lists_and_removes_only_a_second_delivered_row_of_one_call(db, a):
    film = db.film(a)
    s = db.quoted_start(a, film)
    assert db.claim()["id"] == s["id"]
    takes = db.takes(s["id"])
    kf, clip = takes[0][0], takes[1][0]
    db.begin(kf)
    job_kf = take_job(db, kf)
    record_cost(db, job_kf, "image", 1)          # the call's row ...
    record_cost(db, job_kf, "image", 1)          # ... written again by the claim that resumed it (the #964 window)
    db.succeed(kf, None, db.output(a.org, kf, "image", "image/png"))
    db.begin(clip)
    job_clip = take_job(db, clip)
    record_cost(db, job_clip, "second", 10, Decimal("0.5"))          # priced rows are never candidates
    record_cost(db, job_clip, "second", 10, Decimal("0.5"))
    record_failed_call(db, job_clip, "i2v", {"duration_s": 10}, "second")
    record_failed_call(db, job_clip, "i2v", {"duration_s": 10}, "second")  # nor are failed calls
    narration = next(r[0] for r in takes if r[1] == "narration")
    db.begin(narration)
    job_narr = take_job(db, narration)
    record_cost(db, job_narr, "character", 12)   # two scenes of twelve characters: two calls, never a duplicate
    record_cost(db, job_narr, "character", 12)
    db.cancel(s["id"])
    ours = [str(job_kf), str(job_clip), str(job_narr)]

    read, delete = _cleanup_sql()
    found = [r for r in db.su(read) if str(r[2]) in ours]
    assert len(found) == 1, found
    dup_id, kept_id, job = found[0][0], found[0][1], str(found[0][2])
    assert job == str(job_kf) and dup_id != kept_id
    before = dict(db.su("select job_id::text, count(*) from public.creative_job_costs where job_id::text = any(%s) group by 1", [ours]))

    with psycopg.connect(db.dsn, autocommit=False) as c:
        c.execute(delete)
        c.commit()
    after = dict(db.su("select job_id::text, count(*) from public.creative_job_costs where job_id::text = any(%s) group by 1", [ours]))
    assert after[str(job_kf)] == before[str(job_kf)] - 1 == 1
    assert after[str(job_clip)] == before[str(job_clip)] == 4
    assert after[str(job_narr)] == 2
    assert db.su("select id from public.creative_job_costs where id = %s", [kept_id]) == [(kept_id,)]
    # The table is append-only again for everyone else.
    with psycopg.connect(db.dsn, autocommit=True) as c:
        with pytest.raises(psycopg.Error, match="append-only"):
            c.execute("delete from public.creative_job_costs where id = %s", [kept_id])

# Last: it prices the lab models in variant tables that leave them off sale for a film started after it.

def test_the_bots_spend_reads_run_as_the_service_role_and_sum_what_the_runbook_sql_sums(db, a):
    # Film 1: an estimated key frame, then a clip that fails at its vendor with no cost row (as the worker leaves it today).
    film1 = db.film(a)
    s1 = db.quoted_start(a, film1)
    assert db.claim()["id"] == s1["id"]
    takes1 = db.takes(s1["id"])
    kf1, clip1 = takes1[0][0], takes1[1][0]
    db.begin(kf1)
    job_kf1 = take_job(db, kf1)
    record_cost(db, job_kf1, "image", 1)                       # quantity only: usd_estimate NULL, by design
    db.succeed(kf1, None, db.output(a.org, kf1, "image", "image/png"))
    db.begin(clip1)
    take_job(db, clip1)
    db.fail(clip1, "provider_error")
    db.cancel(s1["id"])

    # Film 2, another organization: a recorded dollar row, and a clip on a model with no figure.
    b = db.new_org()
    film2 = db.film(b)
    s2 = db.quoted_start(b, film2)
    assert db.claim()["id"] == s2["id"]
    takes2 = db.takes(s2["id"])
    kf2, clip2 = takes2[0][0], takes2[1][0]
    db.begin(kf2)
    record_cost(db, take_job(db, kf2), "image", 1, RECORDED_USD)
    db.succeed(kf2, None, db.output(b.org, kf2, "image", "image/png"))
    db.begin(clip2)
    record_cost(db, take_job(db, clip2), "second", 10)
    db.cancel(s2["id"])

    # The registry's prices, set after the starts: the lab's quote reads a price-variant table as a sellable model's
    # credit units, which these lab models do not have. The key-frame model is priced in variants (base 1.00, 4K 6.50):
    # the watch estimates at the dearest. The clip model states a base figure but a variant table with no figure in it:
    # unknown, never the base.
    db.su("update public.model_registry set spec = spec || jsonb_build_object('pricing', jsonb_build_object("
          "'unit', 'image', 'provider_usd_per_unit', 1.0, 'source_url', 'https://lab.example', 'as_of', '2026-11-01', "
          "'confirmed', false, 'variants', jsonb_build_object('by', 'image_size', 'prices', "
          "jsonb_build_object('1K', 1.0, '4K', %s::numeric, '8K', null)))) where id = 'img-key'", [KEYFRAME_USD_PER_IMAGE])
    db.su("update public.model_registry set spec = spec || jsonb_build_object('pricing', jsonb_build_object("
          "'unit', 'second', 'provider_usd_per_unit', 0.05, 'source_url', 'https://lab.example', 'as_of', '2026-11-01', "
          "'confirmed', false, 'variants', jsonb_build_object('by', 'resolution', 'prices', "
          "jsonb_build_object('720p', null, '1080p', null)))) where id = 'vid-clip'")

    sync = LabSync(db.dsn)
    cfg = OperatorConfig(app_url="https://app.example.test", github_repo="owner/repo")
    ops = OperatorSources(sync, lambda *_args: (None, None), cfg, now=lambda: datetime.now(timezone.utc))
    sec = ops.film_spend(datetime.now(timezone.utc) - timedelta(hours=24))
    assert sec.ok, sec.note
    by_film = {f["film_id"]: f for f in sec.data}
    assert {str(film1), str(film2)} <= set(by_film)

    f1, f2 = by_film[str(film1)], by_film[str(film2)]
    assert (f1["usd"], f1["basis"], f1["unknown"], f1["org_id"]) == (KEYFRAME_USD_PER_IMAGE, "estimated_highest", 1, str(a.org))
    states1 = {t["id"]: t["state"] for t in f1["takes"]}
    assert (states1[str(kf1)], states1[str(clip1)]) == ("costed", "not_recorded")
    assert (f2["usd"], f2["basis"], f2["unknown"]) == (RECORDED_USD, "recorded", 1)
    states2 = {t["id"]: t["state"] for t in f2["takes"]}
    assert (states2[str(kf2)], states2[str(clip2)]) == ("costed", "unknown")

    # The runbook's own SQL (S2_LIVE_TEST.md step 4) on the same rows: the recorded dollars agree, and for film 1 it
    # reads NULL, which is why the watch estimates from the quantity instead of trusting that sum.
    runbook = ("select sum(usd_estimate) from public.creative_job_costs c join public.creative_jobs j on j.id = c.job_id "
               "where j.film_take_id in (select id from public.film_takes where film_id = %s)")
    assert db.su(runbook, [film2])[0][0] == RECORDED_USD
    assert db.su(runbook, [film1])[0][0] is None
    truth1 = db.su("select sum(c.quantity * (select max(v::text::numeric) from jsonb_each(r.spec->'pricing'->'variants'->'prices') e(k, v) "
                   "where jsonb_typeof(v) = 'number')) "
                   "from public.creative_job_costs c join public.creative_jobs j on j.id = c.job_id "
                   "join public.model_registry r on r.id = coalesce(j.routed_model, j.requested_model) "
                   "join public.film_takes t on t.id = j.film_take_id where t.film_id = %s "
                   "and c.unit = r.spec->'pricing'->>'unit'", [film1])[0][0]
    assert Decimal(truth1) == f1["usd"]

    # The single-film read of tools/film_spend.py answers the same.
    one = ops.film_spend_for(str(film1))
    assert one.ok and one.data[0]["usd"] == f1["usd"] and one.data[0]["unknown"] == 1

    # Nothing read carries a prompt, a parameter, an error text or a price source.
    everything = json.dumps(sec.data, default=str)
    assert "lighthouse" not in everything and "lab price page" not in everything
    tables = {t for t, _q in sync.ran}
    assert tables == {"film_segments", "film_takes", "creative_jobs", "creative_job_costs", "model_registry", "films"}
    for _t, q in sync.ran:
        for word in ("prompt", "params", "error", "*"):
            assert word not in q, q
    # price_source is read as a column (a failed call is labelled as one), and its text never reaches the bot's output.
    assert any(t == "creative_job_costs" and '"price_source"' in q for t, q in sync.ran)

    # And the engine turns exactly these rows into the three alerts, keyed on the real film ids.
    found = {x.key: x for x in alerts.detect(ops, 15000) if x.key.startswith("film:spend")}
    assert found[f"film:spend:{film1}:6"].severity == "warn"
    assert found[f"film:spend:{film2}:8"].severity == "critical"
    assert "runbook step 6" in found[f"film:spend:{film2}:8"].line
    assert f"film:spend_unrecorded:{film1}" in found and f"film:spend_unrecorded:{film2}" in found
    assert all(str(film1) not in x.line and str(a.org) not in x.line for x in found.values())

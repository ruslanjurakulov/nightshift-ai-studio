"""A request may name a model's own resolution (768p, 2k, 4k ...), and such a name is sold only at its own price (migration 0156).

Before 0156, creative_params_problem refused every resolution outside 480p 540p 720p 1080p 1440p 2160p before any model was read, so
MiniMax H3's 768p and 2k (and Vidu's 2k, LTX's 4k ...) could be reached only as a pinned default or not at all: on the live database a
t2v job for minimax-h3-max with {"resolution": "768p"} was refused `invalid_params` while the same job without it ran at 768p. These tests
run the real quote and the real create on a real Postgres and pin what must hold:

* a model's own names are quoted at their own variant (the operator's preview figure, or a credit_prices row on a model on sale), the
  quote names the resolution, and the job carries it (what the worker sends);
* a name of the wrong case or shape ("2K", "768", "8k", "768p ") is refused `invalid_params` before any model is read, and a well-formed
  name the model does not list is refused `invalid_params` ("does not offer"): never mapped to another resolution;
* a name 0156 opens is never sold by a base row or a flat price: a model priced by resolution that pins no default (sold by its base row,
  like Veo 3.1, whose 4k costs the vendor more) and a flat-priced model refuse it `unpriced`, even with a stray variant row; a
  capability without resolution variants refuses it `invalid_params`;
* the six names accepted before are answered exactly as before (rolled back to 0155 and 0126, compared on a corpus);
* the file: needs 0155 and 0126, its guards refuse a hand edit, a replay changes nothing, its rollback restores both bodies byte for byte.

Every row is made inside a rolled-back transaction. The file-level test runs on a scratch database.
"""

from __future__ import annotations

import json
import uuid
from types import SimpleNamespace

import pytest

import sec_db
from sec_scenario import DEFAULT_ORG, MODEL_SOLD
from test_sec_api_creative import Db
from test_sec_operator_preview import _become
from test_sec_preview_price_by_resolution import SECONDS, _make, _params, _unit

H3 = "lab-h3"
H3_PRICING = {"unit": "second", "provider_usd_per_unit": 0.08, "variants": {"by": "resolution", "prices": {"768p": 0.08, "2k": 0.13}}}
OLD_SIX = ("480p", "540p", "720p", "1080p", "1440p", "2160p")


def _call(conn, who, q, params):
    """Run q as `who` in a savepoint; returns ('ok', value) or (sqlstate, code, detail)."""
    try:
        with conn.transaction():
            _become(conn, who)
            v = conn.execute(q, params).fetchone()[0]
            _become(conn, None)
            return "ok", v
    except Exception as e:                                      # noqa: BLE001 - the SQLSTATE, code and detail are the assertion
        diag = getattr(e, "diag", None)
        return getattr(e, "sqlstate", None), str(e).strip().splitlines()[0], getattr(diag, "message_detail", None)


def _quote(conn, who, org, mid, params, cap="t2v"):
    return _call(conn, who, "select public.quote_creative_job(%s, %s, %s, %s::jsonb)", [org, cap, mid, json.dumps(params)])


def _create(conn, who, org, mid, params, maxc=1000):
    return _call(conn, who, "select public.create_creative_job(%s, 't2v', %s, %s::jsonb, 'exact', null, %s::numeric)",
                 [org, mid, json.dumps(params), maxc])


def _h3(conn, **kw):
    kw.setdefault("resolutions", ("768p", "2k"))
    kw.setdefault("pricing", H3_PRICING)
    _make(conn, H3, **kw)


def _row(conn, unit, credits, margin=0.5):
    conn.execute("insert into public.credit_prices (unit, credits_per_unit, margin) values (%s, %s, %s)", [unit, credits, margin])


# ── the bug: a model's own names reach their own price ──────────────────────────────────────────────────────────────────

@pytest.mark.parametrize("res,cost", [("768p", 8.0), ("2k", 13.0)])
def test_the_operator_preview_of_h3_quotes_a_named_768p_and_2k_at_their_own_figures(conn, sc, res, cost):
    with conn.transaction(force_rollback=True):
        _become(conn, None)
        _h3(conn)
        state, q = _quote(conn, sc.operator, DEFAULT_ORG, H3, _params(resolution=res))
        assert state == "ok", q
        assert (float(q["credits_per_unit"]), q["resolution"], q["unit"], q["preview"]) == (cost, res, _unit(H3) + "_" + res, True), q


def test_a_named_2k_job_carries_2k_and_its_quote(conn, sc):
    with conn.transaction(force_rollback=True):
        _become(conn, None)
        _h3(conn)
        state, q = _quote(conn, sc.operator, DEFAULT_ORG, H3, _params(resolution="2k"))
        assert state == "ok", q
        got = _create(conn, sc.operator, DEFAULT_ORG, H3, _params(resolution="2k"))
        assert got[0] == "ok", got
        out = got[1]
        row = conn.execute("select params ->> 'resolution', quoted_credits from public.creative_jobs where id = %s",
                           [out["job"]["id"]]).fetchone()
        assert row[0] == "2k" and float(row[1]) == float(q["credits"]), row


def test_a_model_on_sale_sells_a_named_2k_at_its_own_row_and_holds_it(conn, sc):
    with conn.transaction(force_rollback=True):
        _become(conn, None)
        _h3(conn, availability="beta", entitlement=None)
        _row(conn, _unit(H3) + "_768p", 5)
        _row(conn, _unit(H3) + "_2k", 9)
        state, q = _quote(conn, sc.alice.actor, sc.alice.org, H3, _params(resolution="2k"))
        assert state == "ok", q
        assert (float(q["credits_per_unit"]), q["unit"], q["resolution"]) == (13.5, _unit(H3) + "_2k", "2k"), q
        assert "preview" not in q and float(q["credits"]) == 13.5 * SECONDS
        state, q768 = _quote(conn, sc.alice.actor, sc.alice.org, H3, _params(resolution="768p"))
        assert state == "ok" and float(q768["credits_per_unit"]) == 7.5 and q768["unit"] == _unit(H3) + "_768p", q768
        # bob creates: alice's organization is at its parallel run limit in the lab scenario
        state, qb = _quote(conn, sc.bob.actor, sc.bob.org, H3, _params(resolution="2k"))
        assert state == "ok" and qb["credits"] == q["credits"], qb
        got = _create(conn, sc.bob.actor, sc.bob.org, H3, _params(resolution="2k"))
        assert got[0] == "ok", got
        out = got[1]
        row = conn.execute("select params ->> 'resolution', quoted_credits, credit_ref is not null from public.creative_jobs "
                           "where id = %s", [out["job"]["id"]]).fetchone()
        # a customer's job: held at the 2k quote, and the job carries 2k (what the worker sends)
        assert (row[0], float(row[1]), row[2]) == ("2k", float(q["credits"]), True), row


def test_a_named_2k_without_a_row_of_its_own_is_unpriced_never_768ps_row(conn, sc):
    with conn.transaction(force_rollback=True):
        _become(conn, None)
        _h3(conn, availability="beta", entitlement=None)
        _row(conn, _unit(H3) + "_768p", 5)
        got = _quote(conn, sc.alice.actor, sc.alice.org, H3, _params(resolution="2k"))
        assert got[:2] == ("NS400", "unpriced"), got
        before = conn.execute("select count(*) from public.creative_jobs").fetchone()[0]
        assert _create(conn, sc.alice.actor, sc.alice.org, H3, _params(resolution="2k"))[:2] == ("NS400", "unpriced")
        assert conn.execute("select count(*) from public.creative_jobs").fetchone()[0] == before


# ── unknown names stay refused, early, and are never mapped ──────────────────────────────────────────────────────────────

@pytest.mark.parametrize("res", ["2K", "768P", "768", "8k", "768p ", " 2k", "2k\n", "1k", "99p", "12345p", "", "4kp", 768])
def test_a_name_of_the_wrong_case_or_shape_is_refused_before_any_model_is_read(conn, sc, res):
    with conn.transaction(force_rollback=True):
        _become(conn, None)
        _h3(conn)
        for mid in (H3, "no-such-model"):
            got = _quote(conn, sc.operator, DEFAULT_ORG, mid, _params(resolution=res))
            assert got[:2] == ("NS400", "invalid_params") and "resolution must be" in (got[2] or ""), (res, mid, got)


@pytest.mark.parametrize("res", ["480p", "1080p", "4k", "360p", "1440p"])
def test_a_well_formed_name_the_model_does_not_list_is_refused_not_mapped(conn, sc, res):
    with conn.transaction(force_rollback=True):
        _become(conn, None)
        _h3(conn)
        got = _quote(conn, sc.operator, DEFAULT_ORG, H3, _params(resolution=res))
        assert got[:2] == ("NS400", "invalid_params") and "does not offer" in (got[2] or ""), (res, got)


# ── a newly accepted name is never sold by a base row or a flat price ───────────────────────────────────────────────────

VEO = "lab-veo"
VEO_PRICING = {"unit": "second", "provider_usd_per_unit": 0.1,
               "variants": {"by": "resolution", "prices": {"720p": 0.1, "1080p": 0.12, "4k": 0.3}}}
FLAT = "lab-hailuo"


def test_a_model_priced_by_resolution_without_a_pinned_default_sells_only_the_old_names_by_its_base_row(conn, sc):
    with conn.transaction(force_rollback=True):
        _become(conn, None)
        _make(conn, VEO, availability="beta", entitlement=None, pricing=VEO_PRICING, resolutions=("720p", "1080p", "4k"), default=None)
        _row(conn, _unit(VEO), 10)
        # 0070's rule for a model that pins no resolution, unchanged: the base row, and the quote names no resolution.
        state, q = _quote(conn, sc.alice.actor, sc.alice.org, VEO, _params(resolution="1080p"))
        assert state == "ok" and q["unit"] == _unit(VEO) and "resolution" not in q, q
        # 4k costs the vendor three times the base row's figure: refused, never sold at the base row's rate.
        got = _quote(conn, sc.alice.actor, sc.alice.org, VEO, _params(resolution="4k"))
        assert got[:2] == ("NS400", "unpriced") and "is not sold at 4k" in (got[2] or ""), got
        # a stray row for the variant does not sell it either: this model is not priced by its variants (0070)
        _row(conn, _unit(VEO) + "_4k", 30)
        assert _quote(conn, sc.alice.actor, sc.alice.org, VEO, _params(resolution="4k"))[:2] == ("NS400", "unpriced")
        before = conn.execute("select count(*) from public.creative_jobs").fetchone()[0]
        assert _create(conn, sc.alice.actor, sc.alice.org, VEO, _params(resolution="4k"))[:2] == ("NS400", "unpriced")
        assert conn.execute("select count(*) from public.creative_jobs").fetchone()[0] == before


def test_a_flat_priced_model_sells_a_newly_accepted_name_at_no_price(conn, sc):
    with conn.transaction(force_rollback=True):
        _become(conn, None)
        _make(conn, FLAT, availability="beta", entitlement=None, pricing={"unit": "second", "provider_usd_per_unit": None},
              resolutions=("768p", "1080p"), default=None)
        _row(conn, _unit(FLAT), 5)
        state, q = _quote(conn, sc.alice.actor, sc.alice.org, FLAT, _params(resolution="1080p"))
        assert state == "ok" and q["unit"] == _unit(FLAT), q                     # as before 0156
        got = _quote(conn, sc.alice.actor, sc.alice.org, FLAT, _params(resolution="768p"))
        assert got[:2] == ("NS400", "unpriced"), got
        # no resolution named: as before (the base row; the adapter sends its own default)
        assert _quote(conn, sc.alice.actor, sc.alice.org, FLAT, _params())[0] == "ok"


def test_the_operator_preview_of_a_model_without_a_pinned_default_never_takes_a_new_names_figure(conn, sc):
    with conn.transaction(force_rollback=True):
        _become(conn, None)
        _make(conn, VEO, pricing=VEO_PRICING, resolutions=("720p", "1080p", "4k"), default=None)
        got = _quote(conn, sc.operator, DEFAULT_ORG, VEO, _params(resolution="4k"))
        assert got[:2] == ("NS400", "unpriced"), got


IMG = "lab-img-open"


def _image_model(conn):
    """A picture model on sale to everyone (no entitlement), at one flat price a picture."""
    conn.execute("insert into public.model_registry (id, display_name, provider, adapter, capabilities, spec, credit_unit, entitlement) "
                 "values (%s, %s, 'lab', 'image.openai', array['t2i'], %s::jsonb, %s, null)",
                 [IMG, IMG, json.dumps({"vendor_model": "lab-img", "output": "image", "terms_gate": None}),
                  f"model_{IMG.replace('-', '_')}_image"])
    conn.execute("select public.record_model_probe(%s, 'image.openai', 'lab-img', 't2i', true, null, null, 900, 1234, 'security-lab')",
                 [IMG])
    conn.execute("update public.model_registry set availability = 'beta' where id = %s", [IMG])
    _row(conn, f"model_{IMG.replace('-', '_')}_image", 4)


def test_a_capability_without_resolution_variants_refuses_a_new_name(conn, sc):
    with conn.transaction(force_rollback=True):
        _become(conn, None)
        _image_model(conn)
        # the positive control: without a resolution, and with one of the six, the same request is quoted (as before 0156)
        assert _quote(conn, sc.alice.actor, sc.alice.org, IMG, {"prompt": "x"}, cap="t2i")[0] == "ok"
        assert _quote(conn, sc.alice.actor, sc.alice.org, IMG, {"prompt": "x", "resolution": "1080p"}, cap="t2i")[0] == "ok"
        for res in ("2k", "4k", "768p"):
            got = _quote(conn, sc.alice.actor, sc.alice.org, IMG, {"prompt": "x", "resolution": res}, cap="t2i")
            assert got[:2] == ("NS400", "invalid_params") and "does not offer" in (got[2] or ""), (res, got)


# ── everything else is answered as before ────────────────────────────────────────────────────────────────────────────

def test_with_0156_rolled_back_only_the_newly_accepted_names_change(conn, sc):
    with conn.transaction(force_rollback=True):
        _become(conn, None)
        # This measures 0156's own body: 0159 (which sits on it, and refuses a length a model does not list) comes off first.
        conn.execute(sec_db.rollback_0159_body())
        assert sec_db.has_0156(conn)
        _h3(conn, resolutions=("480p", "768p", "2k"),
            pricing={"unit": "second", "provider_usd_per_unit": 0.08,
                     "variants": {"by": "resolution", "prices": {"480p": 0.05, "768p": 0.08, "2k": 0.13}}})
        _make(conn, VEO, availability="beta", entitlement=None, pricing=VEO_PRICING, resolutions=("720p", "1080p", "4k"), default=None)
        _row(conn, _unit(VEO), 10)
        _make(conn, "lab-sold-h3", availability="beta", entitlement=None, pricing=H3_PRICING, resolutions=("720p", "768p", "2k"),
              default="768p")
        _row(conn, _unit("lab-sold-h3") + "_720p", 4)
        _row(conn, _unit("lab-sold-h3") + "_2k", 9)
        _image_model(conn)
        names = [None, *OLD_SIX, "768p", "2k", "4k", "360p", "2K", "bad"]
        cases = []
        for who, org in ((sc.operator, DEFAULT_ORG), (sc.alice.actor, sc.alice.org)):
            for mid in (H3, VEO, "lab-sold-h3", MODEL_SOLD, "no-such-model"):
                for res in names:
                    cases.append((who, org, mid, _params() if res is None else _params(resolution=res), "t2v", res))
            for mid in (IMG, MODEL_SOLD):
                for res in names:
                    cases.append((who, org, mid, {"prompt": "x"} if res is None else {"prompt": "x", "resolution": res}, "t2i", res))
        with_0156 = [_quote(conn, who, org, mid, p, cap) for who, org, mid, p, cap, _ in cases]
        _become(conn, None)
        conn.execute(sec_db.rollback_0156_body())
        assert not sec_db.has_0156(conn) and sec_db.has_0155(conn)
        without = [_quote(conn, who, org, mid, p, cap) for who, org, mid, p, cap, _ in cases]
        same, opened = [], []
        for (who, org, mid, p, cap, res), a, b in zip(cases, with_0156, without):
            (same if res is None or res in OLD_SIX else opened).append((mid, cap, res, a, b))
        # Every answer for no name or one of the six, refusals and their words included, is 0155's.
        assert [x for x in same if x[3] != x[4]] == [], [x for x in same if x[3] != x[4]][:3]
        assert any(x[3][0] == "ok" for x in same), "the positive control"
        # Every new name was refused by 0126's closed list before the model was read.
        assert all(x[4][:2] == ("NS400", "invalid_params") and "must be one of" in (x[4][2] or "") for x in opened), opened[:3]
        # And with 0156 only a model's own variant sells one.
        sold = {(x[0], x[2]) for x in opened if x[3][0] == "ok"}
        assert sold == {(H3, "768p"), (H3, "2k"), ("lab-sold-h3", "2k")}, sold
        conn.execute(sec_db.MIGRATION_0156.read_text(encoding="utf-8"))
        assert sec_db.has_0156(conn)
        conn.execute(sec_db.MIGRATION_0159.read_text(encoding="utf-8"))
        assert sec_db.has_0159(conn)


# ── the file itself: order, drift guards, replay, rollback ─────────────────────────────────────────────────────────────

PP = "public.creative_params_problem(text,jsonb)"
CP = "public.creative_price(uuid,text,text,jsonb)"
PP_0126 = "6e815ae544cbb23d7f03845465f8ce6a"


def _md5_conn(conn, sig):
    return conn.execute(f"select md5(regexp_replace(prosrc, '\\s+', ' ', 'g')) from pg_proc where oid = '{sig}'::regprocedure").fetchone()[0]


def test_the_lab_takes_the_whole_chain_off_and_puts_it_back_from_0156s_bodies(conn, sc):
    # has_0149, has_0153 and has_0155 compare their own hashes only: from 0156's body the chain must still be found, or 0139's
    # rollback refuses.
    session = SimpleNamespace(conn=conn)
    with conn.transaction(force_rollback=True):
        _become(conn, None)
        # The lab ends at 0218, on 0208, which sits on 0159's creative_price (itself on 0156's) and on 0156's creative_params_problem.
        assert sec_db.has_0218(conn) and sec_db.has_0208(conn) and sec_db.has_0159(conn) and not sec_db.has_0156(conn)
        assert not sec_db.has_0155(conn)
        assert _md5_conn(conn, PP) == sec_db.CREATIVE_PARAMS_PROBLEM_0218
        sec_db.take_off_0139(session)
        assert _md5_conn(conn, CP) == "e0c4a7806642086398558cf322c95a0d", "0125's body"
        assert _md5_conn(conn, PP) == PP_0126, "0126's body"
        sec_db.put_back_0139(session)
        assert (_md5_conn(conn, PP), _md5_conn(conn, CP)) == (sec_db.CREATIVE_PARAMS_PROBLEM_0218, sec_db.CREATIVE_PRICE_0224)


def _md5s(d):
    return tuple(d.su(f"select md5(regexp_replace(prosrc, '\\s+', ' ', 'g')) from pg_proc where oid = '{sig}'::regprocedure")[0][0]
                 for sig in (PP, CP))


def test_the_file_needs_0155_its_guards_refuse_a_hand_edit_and_its_rollback_restores_both_bodies(lab):
    admin = sec_db.admin_dsn()
    name = f"ns_named_res_{uuid.uuid4().hex[:8]}"
    base = sec_db.create_database(admin, name)
    try:
        # everything up to 0153, without 0155 (and so without this file)
        sec_db.apply_files(base, [f for f in sec_db.build_sequence() if f.name not in sec_db.ON_0153])
        d = Db(base)
        assert _md5s(d) == (PP_0126, sec_db.CREATIVE_PRICE_0153)
        m0156 = sec_db.MIGRATION_0156.read_text(encoding="utf-8")
        with pytest.raises(Exception) as cm:
            d.su(m0156)
        assert "0156 found a creative_price() that is neither 0155's body nor 0156's" in str(cm.value)
        assert _md5s(d) == (PP_0126, sec_db.CREATIVE_PRICE_0153), "nothing left behind"
        d.su(sec_db.MIGRATION_0155.read_text(encoding="utf-8"))
        d.su(m0156)
        mine = (sec_db.CREATIVE_PARAMS_PROBLEM_0156, sec_db.CREATIVE_PRICE_0156)
        assert _md5s(d) == mine
        d.su(m0156)                                                        # the replay
        assert _md5s(d) == mine
        # 0155's and 0126's replays refuse 0156's bodies: the chain is taken off from the top
        with pytest.raises(Exception) as cm:
            d.su(sec_db.MIGRATION_0155.read_text(encoding="utf-8"))
        assert "0155 found a creative_price() that is neither 0153's body nor 0155's" in str(cm.value)
        with pytest.raises(Exception) as cm:
            d.su((sec_db.MIGRATIONS / "0126_region_edit_run.sql").read_text(encoding="utf-8"))
        assert "0126 found a creative_params_problem() that is neither 0100's body nor 0126's" in str(cm.value)
        d.su(sec_db.ROLLBACK_0156.read_text(encoding="utf-8"))
        assert _md5s(d) == (PP_0126, sec_db.CREATIVE_PRICE_0155), "byte for byte"
        assert d.su(f"select has_function_privilege('authenticated', '{PP}', 'EXECUTE') or "
                    f"has_function_privilege('authenticated', '{CP}', 'EXECUTE') or "
                    f"has_function_privilege('service_role', '{CP}', 'EXECUTE')")[0][0] is False
        d.su(m0156)
        assert _md5s(d) == mine
        # a hand edit of either function: the file and its rollback refuse, naming the function
        for sig, word in ((PP, "creative_params_problem"), (CP, "creative_price")):
            body = d.su(f"select pg_get_functiondef('{sig}'::regprocedure)")[0][0]
            d.su(body.replace("begin\n", "begin\n  -- edited by hand\n", 1))
            with pytest.raises(Exception) as cm:
                d.su(m0156)
            assert f"0156 found a {word}() that is neither" in str(cm.value)
            with pytest.raises(Exception) as cm:
                d.su(sec_db.ROLLBACK_0156.read_text(encoding="utf-8"))
            assert f"rollback 0156 found a {word}() that is neither 0156's body" in str(cm.value)
            d.su(body)                                                     # put this file's body back for the next one
            assert _md5s(d) == mine
    finally:
        sec_db.drop_database(admin, name)

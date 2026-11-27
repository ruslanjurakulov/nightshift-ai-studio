"""Migration 0218 in a real database: a prompt longer than the model takes, a negative prompt its adapter would drop and a seed are
refused before anything is held, on the Studio's own path and in Film's quote; and the file's order, guards and rollback.

What would break without each pin:
  * create_creative_job (what the Studio and the creative API call) with a 2001-character prompt on an ideogram-3 row (limit 2000):
    without 0218 the job is created and the credits held, and only the worker refuses (after the hold);
  * negative_prompt and seed on the rows of ideogram-3 / 4 / 4.5, openai-gpt-image-2.6-*, minimax-h3* and recraft-v4.1, synced from the
    real registry file: refused at the QUOTE with their own words, not later by the worker (or silently dropped by the adapter); on a
    model whose adapter sends a negative prompt (kling-v3, krea-3) it is not refused; Krea's own 1024-character limit is the quote's;
  * quote_film: a scene whose clip model does not take its negative prompt, or whose visual prompt is longer than the clip model takes,
    is refused on THAT scene's line with the word (film_try_price catches NS400), not as an error for the whole quote; and a priced
    line's params (what start_film copies into the take and the quote_id hashes) still carry no prompt;
  * the file: it needs 0208's creative_price, its guard refuses any other body, a replay changes nothing, and its rollback puts the three
    bodies back byte for byte (and the lab's take_off_0159 / take_off_0171 take it off first).

Runs in test_sec_films_money's module database (it commits; every row this file adds is its own) and, for the file itself, a scratch
database of its own.
"""

from __future__ import annotations

import json
import sys
import uuid
from pathlib import Path

import psycopg
import pytest

import sec_db
import test_sec_films_money as fm

db = fm.db  # the 0171 lab database (module fixture): Film is on, lab models are sold

REPO = Path(__file__).resolve().parents[2]
NOT_TAKERS = ["ideogram-3", "ideogram-4", "ideogram-4.5", "openai-gpt-image-2.6-sunburst", "openai-gpt-image-2.6-flare",
              "minimax-h3", "minimax-h3-highspeed", "minimax-h3-lite", "minimax-h3-max", "recraft-v4.1"]
TAKERS = ["kling-v3", "krea-3"]


def _registry():
    sys.path.insert(0, str(REPO))
    from modules import model_registry as mr

    return mr


def _sell_real_rows(d, ids):
    """The real registry rows, sold the ordinary way in the lab: synced, probed, beta, a price per base unit and per variant. The plan
    and terms gates are opened: the attack is on the params, not on who may buy the model."""
    mr = _registry()
    rows = mr.sync_rows([mr.get(i) for i in ids])
    for r in rows:
        r["entitlement"] = "any"
        r["spec"]["terms_gate"] = None
    # The sync is the whole registry: the module's own lab models go with it, or it would take them off sale.
    lab = [{"id": m, "display_name": m, "provider": prov, "adapter": a, "capabilities": caps, "credit_unit": unit,
            "entitlement": "any", "spec": {"vendor_model": "acme-" + m, "output": a.split(".")[0], **spec}}
           for m, prov, a, caps, unit, _rate, spec in fm.MODELS]
    d.su("select public.sync_model_registry(%s::jsonb)", [json.dumps(lab + rows)])
    for m, *_x in fm.MODELS:
        d.su("update public.model_registry set availability = 'beta' where id = %s", [m])
    for r in rows:
        for cap in r["capabilities"]:
            d.su("select public.record_model_probe(%s, %s, %s, %s, true, null, null, 10, 100, 'security-lab')",
                 [r["id"], r["adapter"], r["spec"]["vendor_model"], cap])
        d.su("update public.model_registry set availability = 'beta' where id = %s", [r["id"]])
        variants = (r["spec"]["pricing"].get("variants") or {}).get("prices") or {}
        for unit in [r["credit_unit"], *(mr.credit_unit_for(r["id"], r["spec"]["pricing"]["unit"], k) for k in variants)]:
            d.su("insert into public.credit_prices (unit, credits_per_unit, margin) values (%s, 2, 0) on conflict (unit) do nothing", [unit])
    return {r["id"]: r for r in rows}


def _params(row, **extra):
    cap = "t2i" if "t2i" in row["capabilities"] else "t2v"
    p = {"prompt": "a lighthouse at dawn"}
    if cap == "t2v":
        p["duration_s"] = row["spec"]["durations_s"][0]
    if (row["spec"]["pricing"].get("variants") or {}).get("by") == "image_size":
        p["image_size"] = row["spec"]["image_sizes"][0]  # 0208: a model priced by size is asked one
    return cap, {**p, **extra}


def _err(fn):
    try:
        fn()
    except psycopg.Error as e:
        return e.sqlstate, str(e).splitlines()[0], e.diag.message_detail or ""
    return None


def _quote(d, o, cap, model, params):
    return _err(lambda: d.one("authenticated", o.owner, "select public.quote_creative_job(%s::uuid, %s, %s, %s::jsonb)",
                              [o.org, cap, model, json.dumps(params)]))


def _create(d, o, cap, model, params):
    return _err(lambda: d.one("authenticated", o.owner,
                              "select public.create_creative_job(%s::uuid, %s, %s, %s::jsonb, 'exact', null, 1000::numeric)",
                              [o.org, cap, model, json.dumps(params)]))


def _ground(d, o):
    return (d.account(o.org), d.su("select count(*) from public.creative_jobs where org_id = %s", [o.org])[0][0],
            d.su("select count(*) from public.credit_reservations where org_id = %s", [o.org])[0][0])


# ── the Studio's path ────────────────────────────────────────────────────────────

def test_create_creative_job_refuses_a_prompt_over_the_models_limit_with_no_job_and_nothing_held(db):
    rows = _sell_real_rows(db, ["ideogram-3"])
    assert rows["ideogram-3"]["spec"]["limits"]["max_prompt_chars"] == 2000
    o = db.new_org(image=False)
    before = _ground(db, o)
    assert _create(db, o, "t2i", "ideogram-3", {"prompt": "a" * 2001}) == (
        "NS400", "prompt_too_long", "1 character over this model's limit of 2000; shorten the prompt")
    assert _quote(db, o, "t2i", "ideogram-3", {"prompt": "\U0001F600" * 1001})[1] == "prompt_too_long"  # 1001 code points, 2002 units
    assert _ground(db, o) == before, "no job, no hold, no charge"
    assert _quote(db, o, "t2i", "ideogram-3", {"prompt": "a" * 2000}) is None, "the boundary is quoted"


@pytest.mark.parametrize("model", NOT_TAKERS)
@pytest.mark.parametrize("extra, word", [({"negative_prompt": "text, watermark"}, "negative_prompt_not_supported"),
                                         ({"seed": 7}, "seed_not_supported")], ids=["negative_prompt", "seed"])
def test_negative_prompt_and_seed_are_refused_at_the_quote_for_the_real_rows(db, model, extra, word):
    rows = _sell_real_rows(db, [model])
    o = db.new_org(image=False)
    cap, plain = _params(rows[model])
    got = _quote(db, o, cap, model, plain)
    assert got is None or got[1] not in ("negative_prompt_not_supported", "seed_not_supported", "prompt_too_long"), got
    before = _ground(db, o)
    cap, params = _params(rows[model], **extra)
    got = _quote(db, o, cap, model, params)
    assert got is not None and got[:2] == ("NS400", word), got
    assert got[2] == ({"seed_not_supported": "Seeds are not supported yet; remove seed"}.get(word)
                      or f"{model} does not take a negative prompt; remove it or choose a model that does"), got
    assert _create(db, o, cap, model, params)[1] == word
    assert _ground(db, o) == before


@pytest.mark.parametrize("model", TAKERS)
def test_a_model_whose_adapter_sends_a_negative_prompt_is_not_refused_one_but_still_refuses_a_seed(db, model):
    rows = _sell_real_rows(db, [model])
    assert rows[model]["spec"]["takes_negative_prompt"] is True
    o = db.new_org(image=False)
    cap, params = _params(rows[model], negative_prompt="text, watermark")
    got = _quote(db, o, cap, model, params)
    assert got is None or got[1] != "negative_prompt_not_supported", got
    cap, params = _params(rows[model], seed=1)
    assert _quote(db, o, cap, model, params)[1] == "seed_not_supported"


def test_krea_s_own_negative_prompt_limit_is_the_quotes(db):
    rows = _sell_real_rows(db, ["krea-3"])
    assert rows["krea-3"]["spec"]["limits"]["max_negative_prompt_chars"] == 1024
    o = db.new_org(image=False)
    got = _quote(db, o, "t2i", "krea-3", {"prompt": "x", "image_size": "1K", "negative_prompt": "n" * 1025})
    assert got == ("NS400", "prompt_too_long", "1 character over this model's limit of 1024 for a negative prompt; shorten it"), got
    got = _quote(db, o, "t2i", "krea-3", {"prompt": "x", "image_size": "1K", "negative_prompt": "n" * 1024})
    assert got is None or got[1] != "prompt_too_long", got


def test_a_blank_negative_prompt_is_no_negative_prompt(db):
    rows = _sell_real_rows(db, ["ideogram-3"])
    o = db.new_org(image=False)
    assert _quote(db, o, "t2i", "ideogram-3", {"prompt": "x", "negative_prompt": "   "}) is None
    assert rows


# ── Film ───────────────────────────────────────────────────────────────────────────

def _line(q, kind, scene=0):
    return [ln for ln in q["lines"] if ln["line"] == kind and ln["position"] == scene]


def test_quote_film_refuses_a_negative_prompt_on_the_scene_line_whose_model_does_not_take_one(db):
    o = db.new_org()
    fid = db.film(o, scenes=[{**fm.SCENES[0], "negative_prompt": "blurry"}, fm.SCENES[1]])
    q = db.quote(o.editor, fid)
    assert q["priced"] is False and q["total"] is None, q
    # the key frame (img-key) and each clip shot of scene 1 (vid-clip) carry the negative prompt; scene 2 has none
    for ln in _line(q, "keyframe") + _line(q, "clip"):
        assert ln["priced"] is False and ln["reason"] == "negative_prompt_not_supported", ln
        assert "does not take a negative prompt" in ln["detail"]
    assert all(ln["priced"] for ln in _line(q, "clip", 1)), q["lines"]
    assert {r["reason"] for r in q["refusals"]} == {"negative_prompt_not_supported"}
    # removing it prices the film again, and nothing in a priced line carries the words
    db.save(o.editor, fid, db.version(fid), {"scenes": [{**fm.SCENES[0], "negative_prompt": ""}, fm.SCENES[1]]})
    q = db.quote(o.editor, fid)
    assert q["priced"] is True, q["refusals"]
    for ln in q["lines"]:
        assert "prompt" not in (ln.get("params") or {}) and "negative_prompt" not in (ln.get("params") or {}), ln


def test_quote_film_refuses_a_visual_prompt_longer_than_the_clip_model_takes_on_the_clip_lines(db):
    o = db.new_org()
    db.su("update public.model_registry set spec = jsonb_set(spec, '{limits}', coalesce(spec -> 'limits', '{}'::jsonb) "
          "|| '{\"max_prompt_chars\": 30}'::jsonb) where id = 'vid-clip'")
    try:
        fid = db.film(o, scenes=[{**fm.SCENES[0], "visual_prompt": "a lighthouse at dusk, waves breaking on the rocks"}, fm.SCENES[1]])
        q = db.quote(o.editor, fid)
        assert q["priced"] is False
        assert all(ln["reason"] == "prompt_too_long" and "limit of 30" in ln["detail"] for ln in _line(q, "clip")), q["lines"]
        assert all(ln["priced"] for ln in _line(q, "keyframe")), "the key-frame model's own limit is not the clip model's"
        assert all(ln["priced"] for ln in _line(q, "clip", 1)), "scene 2 has no visual prompt of its own"
    finally:
        db.su("update public.model_registry set spec = spec #- '{limits,max_prompt_chars}' where id = 'vid-clip'")


# ── the file: order, guards, replay, rollback ──────────────────────────────────────

SIGS = {"creative_params_problem": "public.creative_params_problem(text,jsonb)",
        "creative_price": "public.creative_price(uuid,text,text,jsonb)",
        "film_price": "public.film_price(public.films)"}


def _md5s(d):
    return {k: d.su(f"select md5(regexp_replace(prosrc, '\\s+', ' ', 'g')) from pg_proc where oid = '{s}'::regprocedure")[0][0]
            for k, s in SIGS.items()}


AFTER = {"creative_params_problem": sec_db.CREATIVE_PARAMS_PROBLEM_0218, "creative_price": sec_db.CREATIVE_PRICE_0218,
         "film_price": sec_db.FILM_PRICE_0218}
BEFORE = {"creative_params_problem": sec_db.CREATIVE_PARAMS_PROBLEM_0208, "creative_price": sec_db.CREATIVE_PRICE_0208,
          "film_price": "5de6c9bb2a74079e2078cad2d91b3c34"}


def test_the_file_needs_0208_its_guard_refuses_a_hand_edit_and_its_rollback_restores_every_body(lab):
    from test_sec_api_creative import Db

    admin = sec_db.admin_dsn()
    name = f"ns_prompt_limits_{uuid.uuid4().hex[:8]}"
    base = sec_db.create_database(admin, name)
    try:
        sec_db.apply_files(base, [f for f in sec_db.build_sequence() if f.name not in sec_db.ON_0156])
        d = Db(base)
        assert _md5s(d)["creative_price"] == sec_db.CREATIVE_PRICE_0156
        m = sec_db.MIGRATION_0218.read_text(encoding="utf-8")
        # without 0208 (0159 alone, or neither) the file refuses and changes nothing
        d.su(sec_db.MIGRATION_0159.read_text(encoding="utf-8"))
        with pytest.raises(Exception) as cm:
            d.su(m)
        assert "0218 needs 0208_geo_gate_and_image_size_price.sql" in str(cm.value)
        assert _md5s(d)["creative_price"] == sec_db.CREATIVE_PRICE_0159
        d.su(sec_db.MIGRATION_0208.read_text(encoding="utf-8"))
        assert _md5s(d) == BEFORE
        d.su(m)
        assert _md5s(d) == AFTER
        d.su(m)  # the replay
        assert _md5s(d) == AFTER
        # 0208's replay refuses 0218's body: the chain comes off from the top
        with pytest.raises(Exception):
            d.su(sec_db.MIGRATION_0208.read_text(encoding="utf-8"))
        assert _md5s(d) == AFTER
        d.su(sec_db.ROLLBACK_0218.read_text(encoding="utf-8"))
        assert _md5s(d) == BEFORE, "byte for byte"
        d.su(m)
        for sig in SIGS.values():
            assert d.su("select has_function_privilege('authenticated', %s, 'EXECUTE') or has_function_privilege('service_role', %s, "
                        "'EXECUTE') or has_function_privilege('anon', %s, 'EXECUTE')", [sig, sig, sig]) == [(False,)], sig
        # a hand edit of any of the three is refused by the file and by its rollback
        body = d.su(f"select pg_get_functiondef('{SIGS['film_price']}'::regprocedure)")[0][0]
        d.su(body.replace("begin\n", "begin\n  -- edited by hand\n", 1))
        with pytest.raises(Exception) as cm:
            d.su(m)
        assert "0218 found a film_price() that is neither 0171's body nor 0218's" in str(cm.value)
        with pytest.raises(Exception) as cm:
            d.su(sec_db.ROLLBACK_0218.read_text(encoding="utf-8"))
        assert "rollback 0218 found a film_price() that is neither 0218's body nor 0171's" in str(cm.value)
    finally:
        sec_db.drop_database(admin, name)


def test_the_labs_take_off_helpers_take_0218_off_first_and_put_it_back(lab):
    from test_sec_api_creative import Db

    admin = sec_db.admin_dsn()
    name = f"ns_prompt_limits_lab_{uuid.uuid4().hex[:8]}"
    base = sec_db.create_database(admin, name)
    try:
        sec_db.apply_files(base, sec_db.build_sequence())
        d = Db(base)
        # The full chain ends at 0228 (S6) on 0224 (S10) on 0218: one hunk of 0228 in each of the two shared bodies.
        after = {**AFTER, "creative_price": sec_db.CREATIVE_PRICE_0228, "creative_params_problem": sec_db.CREATIVE_PARAMS_PROBLEM_0228}
        assert _md5s(d) == after
        with psycopg.connect(base, autocommit=False) as c:
            sec_db.take_off_0171(c)
            assert c.execute("select to_regprocedure('public.film_price(public.films)')").fetchone()[0] is None
            sec_db.put_back_0171(c)
            c.commit()
        assert _md5s(d) == after
        with psycopg.connect(base, autocommit=False) as c:
            class S:
                conn = c
            sec_db.take_off_0159(S)
            assert sec_db.has_0156(c) and not sec_db.has_0218(c)
            sec_db.put_back_0159(S)
            c.commit()
        assert _md5s(d) == after
    finally:
        sec_db.drop_database(admin, name)


def NEW_PLAIN_CP():
    """0218's own creative_price statement, as the file has it (the plain body, without 0224's line)."""
    import re

    text = sec_db.MIGRATION_0218.read_text(encoding="utf-8")
    return re.search(r"(?m)^create or replace function public\.creative_price\(.*?^\$\$;\n", text, re.S).group(0)


def test_on_0224s_base_the_file_keeps_0224s_line_its_rollback_puts_it_back_and_the_quote_still_refuses(lab):
    """Stream S10's 0224 (not on main) adds one line to 0208's creative_price. Simulated: a stub credits_per_unit_now(text) and 0208's
    body plus that line; 0218 must then create its own body plus the line (never drop 0224's price), and its rollback 0208's plus it."""
    import re

    from test_sec_api_creative import Db

    admin = sec_db.admin_dsn()
    name = f"ns_prompt_limits_0224_{uuid.uuid4().hex[:8]}"
    base = sec_db.create_database(admin, name)
    try:
        sec_db.apply_files(base, [f for f in sec_db.build_sequence() if f.name not in (sec_db.MIGRATION_0218.name, sec_db.MIGRATION_0228.name)])
        d = Db(base)
        assert _md5s(d) == BEFORE
        d.su("create function public.credits_per_unit_now(p_unit text) returns numeric language sql stable "
             "set search_path = public, pg_temp as $$ select credits_per_unit from public.credit_prices where unit = p_unit $$")
        text = (sec_db.MIGRATIONS / "0208_geo_gate_and_image_size_price.sql").read_text(encoding="utf-8")
        body = re.search(r"(?m)^create or replace function public\.creative_price\(.*?^\$\$;\n", text, re.S).group(0)
        anchor = "    select * into rate from public.credit_prices where unit = m_unit;\n"
        d.su(body.replace(anchor, anchor + "    rate.credits_per_unit := public.credits_per_unit_now(rate.unit);  -- 0224: a dated price "
                                           "(credit_price_schedule) once it is in force\n"))
        assert _md5s(d)["creative_price"] == sec_db.CREATIVE_PRICE_0208_0224
        m = sec_db.MIGRATION_0218.read_text(encoding="utf-8")
        d.su(m)
        assert _md5s(d) == {**AFTER, "creative_price": sec_db.CREATIVE_PRICE_0218_0224}
        with psycopg.connect(base, autocommit=True) as c:
            assert sec_db.has_0218(c) and sec_db.has_0208(c)
        d.su(m)  # the replay keeps the variant
        assert _md5s(d)["creative_price"] == sec_db.CREATIVE_PRICE_0218_0224
        assert "credits_per_unit_now" in d.su(f"select pg_get_functiondef('{SIGS['creative_price']}'::regprocedure)")[0][0]
        assert d.su(f"select has_function_privilege('authenticated', '{SIGS['creative_price']}', 'EXECUTE')") == [(False,)]
        d.su(sec_db.ROLLBACK_0218.read_text(encoding="utf-8"))
        assert _md5s(d) == {**BEFORE, "creative_price": sec_db.CREATIVE_PRICE_0208_0224}, "0224's line survives the rollback"
        # Statement by statement (psql without one transaction, every statement its own commit): the base is read from durable facts,
        # so it ends at 0218's body plus 0224's line, never at 0218's plain body.
        import subprocess

        for f, want in ((sec_db.MIGRATION_0218, sec_db.CREATIVE_PRICE_0218_0224), (sec_db.ROLLBACK_0218, sec_db.CREATIVE_PRICE_0208_0224),
                        (sec_db.MIGRATION_0218, sec_db.CREATIVE_PRICE_0218_0224)):
            out = subprocess.run(["psql", "-X", "-q", "-v", "ON_ERROR_STOP=1", base, "-f", str(f)], capture_output=True, text=True)
            assert out.returncode == 0, out.stderr[-500:]
            assert _md5s(d)["creative_price"] == want, f.name
        # an interrupted run (its plain body in, its 0224 step not yet) is completed by running the file again
        d.su(NEW_PLAIN_CP())
        assert _md5s(d)["creative_price"] == sec_db.CREATIVE_PRICE_0218
        d.su(m)
        assert _md5s(d)["creative_price"] == sec_db.CREATIVE_PRICE_0218_0224
        d.su(m)
        assert _md5s(d)["creative_price"] == sec_db.CREATIVE_PRICE_0218_0224
        # any other body is refused
        live = d.su(f"select pg_get_functiondef('{SIGS['creative_price']}'::regprocedure)")[0][0]
        d.su(live.replace("begin\n", "begin\n  -- edited by hand\n", 1))
        with pytest.raises(Exception) as cm:
            d.su(m)
        assert "0218 found credits_per_unit_now() (0224) but a creative_price() that is not 0208's plus 0224's line" in str(cm.value)
    finally:
        sec_db.drop_database(admin, name)


# ── fix batch: the seed before routing, blank white space, the sync order ──────────────────────────────────────────

def test_a_routed_quote_with_a_seed_says_seed_not_supported_not_no_model_available(db):
    _sell_real_rows(db, ["ideogram-3"])
    o = db.new_org(image=False)
    for mode in ("auto", "cheap", "fast", "quality"):
        got = _err(lambda: db.one("authenticated", o.owner, "select public.quote_creative_route(%s::uuid, 't2i', %s, %s::jsonb)",
                                  [o.org, mode, json.dumps({"prompt": "a lighthouse", "seed": 3})]))
        assert got == ("NS400", "seed_not_supported", "Seeds are not supported yet; remove seed"), (mode, got)


@pytest.mark.parametrize("blank", ["   ", "\t\n", "\u3000", "\u00a0\u2028 \u0085"])
def test_a_negative_prompt_of_only_white_space_is_no_negative_prompt_as_in_the_worker(db, blank):
    assert blank.strip() == ""
    _sell_real_rows(db, ["ideogram-3"])
    o = db.new_org(image=False)
    assert _quote(db, o, "t2i", "ideogram-3", {"prompt": "x", "negative_prompt": blank}) is None
    assert _quote(db, o, "t2i", "ideogram-3", {"prompt": "x", "negative_prompt": blank + "blur"})[1] == "negative_prompt_not_supported"


def test_the_file_refuses_a_registry_synced_from_a_ref_without_0218(lab):
    from test_sec_api_creative import Db

    admin = sec_db.admin_dsn()
    name = f"ns_prompt_limits_sync_{uuid.uuid4().hex[:8]}"
    base = sec_db.create_database(admin, name)
    try:
        sec_db.apply_files(base, [f for f in sec_db.build_sequence() if f.name not in (sec_db.MIGRATION_0218.name, sec_db.MIGRATION_0228.name)])
        d = Db(base)
        d.su("insert into public.model_registry (id, display_name, provider, adapter, capabilities, spec, credit_unit) values "
             "('lab-old', 'old', 'lab', 'image.lab', array['t2i'], '{\"output\": \"image\"}'::jsonb, 'model_lab_old_image')")
        with pytest.raises(Exception) as cm:
            d.su(sec_db.MIGRATION_0218.read_text(encoding="utf-8"))
        assert "0218: run Probe models --sync from a ref that contains 0218 (merge first, then sync from main), then apply" in str(cm.value)
        assert _md5s(d) == BEFORE, "nothing applied"
        d.su("update public.model_registry set spec = spec || '{\"takes_negative_prompt\": false}'::jsonb")
        d.su(sec_db.MIGRATION_0218.read_text(encoding="utf-8"))
        assert _md5s(d) == AFTER
    finally:
        sec_db.drop_database(admin, name)

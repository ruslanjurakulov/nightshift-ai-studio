"""The real music entries, synced into a real database after 0228: present, and dark.

MUSIC left ``REGISTRY_ONLY_CAPABILITIES`` once 0228 was confirmed live, so ``tools/probe_models.py --sync`` now sends
google-lyria-3.5 and sonilo-music. This lab syncs exactly what the code sends (``model_registry.sync_rows`` over the whole file)
and checks that nothing can sell them.

What would break, and which test says so:
  the sync fails for every model (a row outside the capability check), or a music row is missing   test_the_whole_file_syncs_*
  a synced music row arrives on sale, or a re-sync puts it there                                  test_a_synced_music_row_is_hidden_*
  a member or an API key is offered a music model                                                  test_no_caller_is_offered_music
  a quote is given for one                                                                         test_a_quote_on_a_music_model_is_refused
  a passing probe (the owner's named probe) is enough to put one on sale                           test_a_passing_probe_does_not_light_it
  Lyria syncs without Google's allow-list (0230 would refuse it everywhere, or not be asked)        test_lyria_carries_googles_allow_list
  the owner lifts the terms gate in the app (0227), probes it and sets ga: anything but the price  test_lit_by_the_owner_but_unpriced_*
  stands between a member's own quote_creative_job call and a sale

The terms gate is NOT a hard barrier: since 0227 the owner clears it with one in-app action (owner_accept_model_terms), and a
named probe verifies the row. After that the credit price is the last thing the database enforces (and, for Lyria, 0142's
countries CHECK and the models_audio:premium entitlement). The vocal-activity check, Sonilo's written answer on its terms and the
owner's legal sign-off are process preconditions no code enforces: no credit price may be written before them.

Runs in its own scratch databases (they commit).
"""
import json
import os
import sys
import uuid
from pathlib import Path

import psycopg
import pytest

import sec_db

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

from modules import model_registry as reg  # noqa: E402

ORG = "aaaaaaaa-0000-0000-0000-00000000da12"
U_A = str(uuid.UUID(int=0xDA12))
U_OP = str(uuid.UUID(int=0xDA13))      # the platform owner (app_members), who may accept a model's terms (0227)
MUSIC_IDS = ("google-lyria-3.5", "sonilo-music")


def claims(role, uid=None):
    c = {"role": role}
    if uid:
        c["sub"] = uid
    return json.dumps(c)


class Db:
    def __init__(self, dsn):
        self.dsn = dsn

    def su(self, q, p=None):
        with psycopg.connect(self.dsn, autocommit=True) as c:
            cur = c.execute(q, p)
            return cur.fetchall() if cur.description else None

    def act(self, role, uid, q, p=None):
        with psycopg.connect(self.dsn, autocommit=False) as c:
            try:
                c.execute("select set_config('request.jwt.claims', %s, true)", [claims(role, uid)])
                c.execute(f"set local role {role}")
                cur = c.execute(q, p)
                rows = cur.fetchall() if cur.description else None
                c.commit()
                return rows
            except psycopg.Error:
                c.rollback()
                raise


def sync(d):
    rows = reg.sync_rows(list(reg.load().values()))
    return d.su("select public.sync_model_registry(%s::jsonb)", [json.dumps(rows)])[0][0], rows


def _lab(prefix):
    admin = sec_db.admin_dsn()
    if not admin:
        if os.environ.get("NIGHTSHIFT_SECURITY_REQUIRED"):
            pytest.fail(f"{sec_db.DSN_ENV} is not set", pytrace=False)
        pytest.skip(f"{sec_db.DSN_ENV} is not set — the security lab needs a scratch Postgres")
    name = f"{prefix}_{uuid.uuid4().hex[:8]}"
    d = Db(sec_db.build(admin, name))
    d.su("insert into auth.users (id, email) values (%s,'a@x.io'), (%s,'op@x.io')", [U_A, U_OP])
    d.su("insert into public.organizations (id, name, slug) values (%s,'M','org-music-dark')", [ORG])
    d.su("insert into public.org_members (org_id, user_id, email, role) values (%s,%s,'a@x.io','owner')", [ORG, U_A])
    d.su("insert into public.app_members (user_id, email, role) values (%s,'op@x.io','owner')", [U_OP])
    d.su("select public.grant_credits(%s, 1000, 'test')", [ORG])
    sync(d)
    try:
        yield d
    finally:
        if not os.environ.get("NIGHTSHIFT_SECURITY_KEEP"):
            sec_db.drop_database(admin, name)


@pytest.fixture(scope="module")
def db():
    yield from _lab("ns_music_dark")


@pytest.fixture(scope="module")
def lit():
    """A database of its own: these tests take the rows as far towards a sale as the owner's own tools can, short of a price."""
    yield from _lab("ns_music_lit")


def refusal(fn):
    """(sqlstate, the refusal's word, its detail): a test asserts which refusal, so it cannot pass on any error at all."""
    with pytest.raises(psycopg.Error) as e:
        fn()
    return e.value.sqlstate, str(e.value).splitlines()[0], e.value.diag.message_detail or ""


def row(d, mid):
    (r,) = d.su("select availability, verified_at, spec ->> 'terms_gate', credit_unit, capabilities from public.model_registry "
                "where id = %s", [mid])
    return r


def test_the_whole_file_syncs_with_both_music_rows_and_without_the_video_one(db):
    n, rows = sync(db)
    assert n == len(rows)
    ids = {r["id"] for r in rows}
    assert set(MUSIC_IDS) <= ids
    got = {r[0] for r in db.su("select id from public.model_registry where 'music' = any (capabilities)")}
    assert got == set(MUSIC_IDS)
    for mid in ("sonilo-video-music", "kling-4.0-omni-edit", "seedance-2.5-edit"):
        assert mid not in ids
        assert db.su("select count(*) from public.model_registry where id = %s", [mid])[0][0] == 0


def test_a_synced_music_row_is_hidden_unverified_gated_and_unpriced_and_a_resync_keeps_it_so(db):
    for _ in range(2):
        for mid in MUSIC_IDS:
            availability, verified_at, gate, unit, caps = row(db, mid)
            assert (availability, verified_at, gate, caps) == ("hidden", None, "terms_review_required", ["music"]), mid
            assert db.su("select count(*) from public.credit_prices where unit = %s", [unit])[0][0] == 0, mid
        sync(db)


def _no_music_offered(d):
    # This lab builds every migration (sec_db.build), so 0250 is live: sellable_models knows music (listing and routing do), and
    # lists it on the web only (BR-S6-06). Quoting never went through sellable_models; it is creative_price's, which 0228 owns.
    (live,), = d.su("select md5(regexp_replace(regexp_replace(prosrc, '[-][-][^' || chr(10) || chr(13) || ']*', '', 'g'), "
                    "'[[:space:]]+', ' ', 'g')) from pg_proc where oid = 'public.sellable_models(text, text)'::regprocedure")
    assert live == sec_db.SELLABLE_MODELS_0250, live
    for role, uid in (("authenticated", U_A), ("service_role", None)):
        for surface in ("web", "api", "mcp"):
            got = d.act(role, uid, "select id from public.sellable_models(null, %s)", [surface])
            assert not {r[0] for r in got} & set(MUSIC_IDS), (role, surface)
            # Nothing sellable is music here (hidden, gated, or unpriced): an empty list, not a refusal.
            assert d.act(role, uid, "select id from public.sellable_models('music', %s)", [surface]) == [], (role, surface)


def test_no_caller_is_offered_music(db):
    _no_music_offered(db)
    # anon may not ask at all (0035's grants), which is a refusal, not an empty list.
    state, _, _ = refusal(lambda: db.act("anon", None, "select id from public.sellable_models('music')"))
    assert state == "42501"


def test_a_quote_on_a_music_model_is_refused(db):
    # Refused as not sellable (hidden and gated), before any question of duration or price is asked.
    for mid in MUSIC_IDS:
        for params in ({"prompt": "a calm solo piano piece", "duration_s": 30}, {"prompt": "a calm solo piano piece"}):
            with pytest.raises(psycopg.Error) as e:
                db.act("authenticated", U_A, "select public.quote_creative_job(%s,'music',%s,%s::jsonb)",
                       [ORG, mid, json.dumps(params)])
            assert "model_not_sellable" in str(e.value), (mid, params, str(e.value))


def test_a_passing_probe_does_not_light_it(db):
    # What the owner's named probe records. It verifies the row; while the terms gate is set (and, for Lyria, its country list),
    # beta and ga are still refused. The owner can lift the gate in the app (0227): test_lit_by_the_owner_but_unpriced_* below.
    # Lyria breaks two CHECKs (its blocked_countries, 0142, and the terms gate) and Postgres names whichever it checks first.
    held = {"sonilo-music": {"model_registry_terms_before_sale"},
            "google-lyria-3.5": {"model_registry_terms_before_sale", "model_registry_countries_before_sale"}}
    for mid, constraints in held.items():
        e = reg.load()[mid]
        db.su("select public.record_model_probe(%s, %s, %s, 'music', true, null, null, 10, 100, 'security-lab')",
              [e.id, e.adapter, e.vendor_model])
        availability, verified_at, *_ = row(db, e.id)
        assert availability == "hidden" and verified_at is not None
        for stage in ("beta", "ga"):
            with pytest.raises(psycopg.errors.CheckViolation) as ex:
                db.su("update public.model_registry set availability = %s where id = %s", [stage, e.id])
            assert ex.value.diag.constraint_name in constraints, (mid, ex.value.diag.constraint_name)
        # A workspace owner is not a platform admin: RLS shows no row to update, so nothing changes (and nothing raises).
        assert db.act("authenticated", U_A,
                      "update public.model_registry set availability = 'beta' where id = %s returning id", [e.id]) == []
        assert row(db, e.id)[0] == "hidden"


def test_lyria_carries_googles_allow_list(db):
    (allowed, blocked), = db.su("select spec -> 'available_countries', spec -> 'blocked_countries' from public.model_registry "
                                "where id = 'google-lyria-3.5'")
    assert isinstance(allowed, list) and "UZ" in allowed and "RU" not in allowed
    assert "RU" in blocked


def _light(d, mid):
    """Everything the owner's own tools can do short of a price: accept the terms in the app (0227's real function, as the
    platform owner), record a passing probe (what a named probe writes), open the plan gate and set ga. For Lyria, 0142's countries
    CHECK is taken away too, so the test reaches the one barrier it is about."""
    e = reg.load()[mid]
    (out,), = d.act("authenticated", U_OP, "select public.owner_accept_model_terms(%s, %s, %s)", [mid, e.terms_gate, mid])
    assert out["model_id"] == mid and out["gate"] == e.terms_gate
    d.su("select public.record_model_probe(%s, %s, %s, 'music', true, null, null, 10, 100, 'security-lab')",
         [e.id, e.adapter, e.vendor_model])
    d.su("update public.model_registry set spec = spec - 'blocked_countries' where id = %s", [mid])
    d.su("update public.model_registry set availability = 'ga', entitlement = 'any' where id = %s", [mid])
    (r,) = d.su("select availability, verified_at is not null, spec ->> 'terms_gate', spec ? 'blocked_countries' "
                "from public.model_registry where id = %s", [mid])
    assert r == ("ga", True, None, False), (mid, r)


def test_lit_by_the_owner_but_unpriced_no_music_model_is_offered_or_quoted(lit):
    for mid in MUSIC_IDS:
        _light(lit, mid)
    _no_music_offered(lit)
    quote = "select public.quote_creative_job(%s,'music',%s,%s::jsonb)"
    song, timed = {"prompt": "a calm solo piano piece"}, {"prompt": "a calm solo piano piece", "duration_s": 30}
    # Lyria is billed per song: no duration is its quote, and a duration is a length it has no field for.
    assert refusal(lambda: lit.act("authenticated", U_A, quote, [ORG, "google-lyria-3.5", json.dumps(song)]))[:2] == \
        ("NS400", "unpriced")
    assert refusal(lambda: lit.act("authenticated", U_A, quote, [ORG, "google-lyria-3.5", json.dumps(timed)]))[:2] == \
        ("NS400", "invalid_params")
    for params in (song, timed):       # Sonilo: the missing price is answered first, with or without a length
        assert refusal(lambda p=params: lit.act("authenticated", U_A, quote, [ORG, "sonilo-music", json.dumps(p)]))[:2] == \
            ("NS400", "unpriced"), params


def test_lit_by_the_owner_but_unpriced_the_price_is_the_last_hard_barrier(lit):
    # The control that makes the test above mean something: with a credit price row, the same member's quote goes through.
    # So no price may be written before the probe, the vocal-activity check (Lyria), Sonilo's written answer and the legal
    # sign-off: nothing in the database waits for those.
    for mid in MUSIC_IDS:
        if row(lit, mid)[0] != "ga":
            _light(lit, mid)
    unit = reg.load()["sonilo-music"].credit_unit
    lit.su("insert into public.credit_prices (unit, credits_per_unit, margin) values (%s, 1, 0), ('job_minimum', 1, 0) "
           "on conflict (unit) do update set credits_per_unit = excluded.credits_per_unit", [unit])
    try:
        got = lit.act("authenticated", U_A, "select public.quote_creative_job(%s,'music','sonilo-music',%s::jsonb)",
                      [ORG, json.dumps({"prompt": "a calm solo piano piece", "duration_s": 30})])
        assert got and got[0][0], got
    finally:
        lit.su("delete from public.credit_prices where unit = %s", [unit])

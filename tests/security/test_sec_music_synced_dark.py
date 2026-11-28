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

Runs in its own scratch database (it commits).
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


@pytest.fixture(scope="module")
def db():
    admin = sec_db.admin_dsn()
    if not admin:
        if os.environ.get("NIGHTSHIFT_SECURITY_REQUIRED"):
            pytest.fail(f"{sec_db.DSN_ENV} is not set", pytrace=False)
        pytest.skip(f"{sec_db.DSN_ENV} is not set — the security lab needs a scratch Postgres")
    name = f"ns_music_dark_{uuid.uuid4().hex[:8]}"
    d = Db(sec_db.build(admin, name))
    d.su("insert into auth.users (id, email) values (%s,'a@x.io')", [U_A])
    d.su("insert into public.organizations (id, name, slug) values (%s,'M','org-music-dark')", [ORG])
    d.su("insert into public.org_members (org_id, user_id, email, role) values (%s,%s,'a@x.io','owner')", [ORG, U_A])
    d.su("select public.grant_credits(%s, 1000, 'test')", [ORG])
    sync(d)
    try:
        yield d
    finally:
        if not os.environ.get("NIGHTSHIFT_SECURITY_KEEP"):
            sec_db.drop_database(admin, name)


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


def test_no_caller_is_offered_music(db):
    asked = 0
    for role, uid in (("authenticated", U_A), ("anon", None), ("service_role", None)):
        for cap in ("music", None):
            try:
                got = db.act(role, uid, "select id from public.sellable_models(%s)", [cap])
            except psycopg.Error:
                continue        # a role that may not call it is offered nothing either
            asked += 1
            assert not {r[0] for r in got} & set(MUSIC_IDS), (role, cap)
    assert asked, "no role could read sellable_models: the check above proved nothing"


def test_a_quote_on_a_music_model_is_refused(db):
    # Refused as not sellable (hidden and gated), before any question of duration or price is asked.
    for mid in MUSIC_IDS:
        for params in ({"prompt": "a calm solo piano piece", "duration_s": 30}, {"prompt": "a calm solo piano piece"}):
            with pytest.raises(psycopg.Error) as e:
                db.act("authenticated", U_A, "select public.quote_creative_job(%s,'music',%s,%s::jsonb)",
                       [ORG, mid, json.dumps(params)])
            assert "model_not_sellable" in str(e.value), (mid, params, str(e.value))


def test_a_passing_probe_does_not_light_it(db):
    # What the owner's named probe records. It verifies the row; the terms gate still refuses beta and ga.
    e = reg.load()["google-lyria-3.5"]
    db.su("select public.record_model_probe(%s, %s, %s, 'music', true, null, null, 10, 100, 'security-lab')",
          [e.id, e.adapter, e.vendor_model])
    availability, verified_at, *_ = row(db, e.id)
    assert availability == "hidden" and verified_at is not None
    for stage in ("beta", "ga"):
        with pytest.raises(psycopg.errors.CheckViolation):
            db.su("update public.model_registry set availability = %s where id = %s", [stage, e.id])
    try:        # a workspace owner is not a platform admin: refused, or no row is visible to update
        db.act("authenticated", U_A, "update public.model_registry set availability = 'beta' where id = %s", [e.id])
    except psycopg.Error:
        pass
    assert row(db, e.id)[0] == "hidden"


def test_lyria_carries_googles_allow_list(db):
    (allowed, blocked), = db.su("select spec -> 'available_countries', spec -> 'blocked_countries' from public.model_registry "
                                "where id = 'google-lyria-3.5'")
    assert isinstance(allowed, list) and "UZ" in allowed and "RU" not in allowed
    assert "RU" in blocked

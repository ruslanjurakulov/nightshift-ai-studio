"""0178 pricing attacks against disposable Postgres; no external providers."""
import hashlib
import json
import uuid
from contextlib import contextmanager
from pathlib import Path

import pytest

from sec_db import ANON, SERVICE, acting as _acting


@contextmanager
def acting(conn, who):
    with _acting(conn, who, commit=True) as s:
        try:
            yield s
        finally:
            conn.execute("reset role")
            conn.execute("select set_config('request.jwt.claims', '', true)")
            conn.execute("select set_config('request.jwt.claim.role', '', true)")


@pytest.fixture
def world(conn, sc):
    with conn.transaction(force_rollback=True):
        conn.execute("update public.channels set status = 'ACTIVE', agent_config = agent_config || %s::jsonb where channel_id = %s",
                     [json.dumps({"thumbnail_mode": "concept", "target_duration_seconds": 60}), sc.alice.channel])
        conn.execute("delete from public.api_prices where unit = 'concept_thumbnail_image'")
        conn.execute("update public.api_prices set cents = 120 where unit = 'video_minute'")
        conn.execute("insert into public.api_prices(unit,cents) values ('concept_thumbnail_image', 2.125)")
        yield conn, sc.alice


def create(conn, who, *, key=None, channel=None):
    key = key or uuid.uuid4().hex
    with acting(conn, ANON) as s:
        out = s.run("select public.api_create_video(%s,%s,%s::jsonb,%s,%s,null)",
                    [who.api_key_hash, channel or who.channel, '{"duration":60}', key, hashlib.sha256(b"fixture").hexdigest()])
    assert out.ok, out
    return out.rows[0][0]


def claim(conn, ref, job):
    with acting(conn, SERVICE) as s:
        out = s.run("select public.api_hold_start_priced(%s,%s)", [ref, job])
    assert out.ok, out
    return out.rows[0][0]


def hold(conn, job):
    return conn.execute("select ref,amount_cents,thumbnail_mode from public.api_holds where render_job_id=%s", [job]).fetchone()


def test_api_reserves_separate_cents_once_and_settles_only_api_balance(world):
    conn, a = world
    credits_before = conn.execute("select balance,reserved from public.credit_accounts where org_id=%s", [a.org]).fetchone()
    idem = uuid.uuid4().hex
    res = create(conn, a, key=idem)
    assert res['ok'], res
    job = res['data']['job_id']
    ref, amount, mode = hold(conn, job)
    assert (amount, mode) == (129, 'concept')
    assert claim(conn, ref, job) == {'amount_cents': 129, 'thumbnail_mode': 'concept'}
    replay = create(conn, a, key=idem)
    assert replay['data']['job_id'] == job
    conn.execute("update public.render_jobs set status='succeeded' where id=%s", [job])
    conn.execute("update public.render_jobs set status='succeeded' where id=%s", [job])
    assert conn.execute("select status,captured_cents from public.api_holds where ref=%s", [ref]).fetchone() == ('captured',129)
    assert conn.execute("select balance,reserved from public.credit_accounts where org_id=%s", [a.org]).fetchone() == credits_before


@pytest.mark.parametrize('rate', [None, 'NaN'])
def test_missing_or_nonfinite_api_addon_never_holds_or_queues(world, rate):
    conn, a = world
    conn.execute("delete from public.api_prices where unit='concept_thumbnail_image'")
    if rate is not None:
        conn.execute("insert into public.api_prices(unit,cents) values ('concept_thumbnail_image',%s)", [rate])
    before = conn.execute("select count(*) from public.render_jobs where channel_id=%s", [a.channel]).fetchone()
    res = create(conn, a)
    assert not res['ok'] and res['error']['code'] == 'pricing_unavailable', res
    assert conn.execute("select count(*) from public.render_jobs where channel_id=%s", [a.channel]).fetchone() == before


def test_explicit_zero_image_price_is_not_missing(world):
    conn, a = world
    conn.execute("update public.api_prices set cents=0 where unit='concept_thumbnail_image'")
    res = create(conn, a)
    assert res['ok'], res
    assert hold(conn,res['data']['job_id'])[1] == 120


@pytest.mark.parametrize('mutation', ['old_terms', 'underfunded', 'rate_increased', 'mode_changed'])
def test_stale_api_hold_is_refused_before_start_and_failure_releases_it(world, mutation):
    conn, a = world
    res = create(conn,a)
    assert res['ok'], res
    job = res['data']['job_id']
    ref, _, _ = hold(conn, job)
    if mutation == 'old_terms':
        conn.execute("update public.api_holds set thumbnail_mode=null where ref=%s", [ref])
    elif mutation == 'underfunded':
        conn.execute("update public.api_holds set amount_cents=120 where ref=%s", [ref])
    elif mutation == 'rate_increased':
        conn.execute("update public.api_prices set cents=10 where unit='concept_thumbnail_image'")
    else:
        conn.execute("update public.channels set agent_config=agent_config || '{\"thumbnail_mode\":\"frame\"}'::jsonb where channel_id=%s", [a.channel])
    assert claim(conn,ref,job) is None
    assert conn.execute("select started_at is null from public.api_holds where ref=%s", [ref]).fetchone()[0]
    conn.execute("update public.render_jobs set status='failed' where id=%s", [job])
    assert conn.execute("select status from public.api_holds where ref=%s", [ref]).fetchone()[0] == 'released'


def test_frame_to_concept_change_cannot_reuse_old_api_price(world):
    conn,a=world
    conn.execute("update public.channels set agent_config=agent_config || '{\"thumbnail_mode\":\"frame\"}'::jsonb where channel_id=%s", [a.channel])
    res=create(conn,a); assert res['ok'],res
    job=res['data']['job_id']; ref,amount,mode=hold(conn,job)
    assert (amount,mode)==(120,'frame')
    conn.execute("update public.channels set agent_config=agent_config || '{\"thumbnail_mode\":\"concept\"}'::jsonb where channel_id=%s", [a.channel])
    assert claim(conn,ref,job) is None


def test_foreign_channel_and_wrong_job_never_claim(world,sc):
    conn,a=world
    denied=create(conn,a,channel=sc.bob.channel)
    assert not denied['ok'] and denied['status']==404
    res=create(conn,a); assert res['ok'],res
    job=res['data']['job_id']; ref,_,_=hold(conn,job)
    assert claim(conn,ref,job+100000) is None
    for actor in (ANON,a.actor,sc.bob.actor):
        with acting(conn,actor) as s:
            out=s.run("select public.api_hold_start_priced(%s,%s)",[ref,job])
        assert not out.ok and out.sqlstate=='42501'


@pytest.mark.parametrize('rate', [None, '0', 'NaN'])
def test_unpriced_base_blocks_site_and_api_before_money_moves(world,rate):
    conn,a=world
    conn.execute("delete from public.credit_prices where unit='video_minute'")
    conn.execute("delete from public.api_prices where unit='video_minute'")
    if rate is not None:
        conn.execute("insert into public.credit_prices(unit,credits_per_unit) values ('video_minute',%s)",[rate])
        conn.execute("insert into public.api_prices(unit,cents) values ('video_minute',%s)",[rate])
    assert conn.execute("select public.series_episode_price(60,%s)",[a.channel]).fetchone()[0] is None
    denied=create(conn,a)
    assert not denied['ok'] and denied['error']['code']=='pricing_unavailable',denied



def test_direct_credit_job_cannot_use_a_base_only_hold(world):
    conn,a=world
    conn.execute("insert into public.credit_prices(unit,credits_per_unit,margin) values ('video_minute',30,0),('image_generations',2,0) on conflict(unit) do update set credits_per_unit=excluded.credits_per_unit,margin=excluded.margin")
    conn.execute("select public.release_credits(job_id) from public.credit_reservations where org_id=%s and status='open'", [a.org])
    ref='rj-direct-'+uuid.uuid4().hex
    with acting(conn,a.actor) as s:
        assert s.run("select public.reserve_credits(%s,%s,30)",[a.org,ref]).ok
        out=s.run("insert into public.render_jobs(channel_id,kind,params,requested_by,credit_ref) values(%s,'daily','{\"duration\":60}',%s,%s)",[a.channel,a.actor.uid,ref])
    assert not out.ok and out.sqlstate=='22023',out


@pytest.mark.parametrize('char', list('\t\n\v\f\r\x1c\x1d\x1e\x1f \x85\xa0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000')+['\ufeff','\u200b','\u180e'])
def test_sql_normalization_matches_python_without_dropping_bom(world,char):
    conn,_=world
    raw=char+'CoNcEpT'+char
    got=conn.execute("select public.run_thumbnail_mode(%s::jsonb)",[json.dumps({'thumbnail_mode':raw})]).fetchone()[0]
    assert got==('concept' if raw.strip().lower()=='concept' else 'frame')


def test_0178_replays_and_explicit_rollback_reapplies_without_financial_writes(world):
    conn,a=world
    root=Path(__file__).resolve().parents[2]
    migration=(root/'supabase/migrations/0178_api_concept_thumbnail_holds.sql').read_text()
    before=conn.execute("select count(*) from public.api_ledger where org_id=%s",[a.org]).fetchone()
    conn.execute(migration)
    rollback=(root/'docs/sql/rollback_0178_api_concept_thumbnail_holds.sql').read_text()
    conn.execute('\n'.join(line for line in rollback.splitlines() if line.strip() not in ('begin;','commit;')))
    conn.execute(migration)
    assert conn.execute("select count(*) from public.api_ledger where org_id=%s",[a.org]).fetchone()==before
    res=create(conn,a); assert res['ok'],res
    assert hold(conn,res['data']['job_id'])[1]==129


@pytest.mark.parametrize('started', [False, True])
def test_api_claim_expires_24_hour_holds_instead_of_reviving_them(world,started):
    conn,a=world
    res=create(conn,a); assert res['ok'],res
    job=res['data']['job_id']; ref,_,_=hold(conn,job)
    if started:
        conn.execute("update public.api_holds set started_at=now()-interval '25 hours' where ref=%s",[ref])
    else:
        conn.execute("update public.api_holds set created_at=now()-interval '25 hours' where ref=%s",[ref])
    assert claim(conn,ref,job) is None
    assert conn.execute("select status from public.api_holds where ref=%s",[ref]).fetchone()[0]=='released'


@pytest.mark.parametrize('started', [False, True])
def test_site_claim_respects_three_hour_unstarted_and_24_hour_started_expiry(world,started):
    conn,a=world
    ref='rj-seed-'+a.key
    if started:
        conn.execute("update public.credit_reservations set started_at=now()-interval '25 hours' where job_id=%s",[ref])
    else:
        conn.execute("update public.credit_reservations set created_at=now()-interval '4 hours' where job_id=%s",[ref])
    with acting(conn,SERVICE) as s:
        out=s.run("select public.start_credit_reservation(%s,%s)",[ref,a.org])
    assert out.ok and out.rows[0][0] is None,out
    assert conn.execute("select status from public.credit_reservations where job_id=%s",[ref]).fetchone()[0]=='released'


def test_claim_expiry_collects_pending_api_refund_once(conn):
    from sec_api_refund_lab import customer,topup,run,refund,call,ok,balanced
    from sec_db import as_superuser
    with as_superuser(conn,commit=False) as s:
        c=customer(s); ext=topup(s,c,5000)
        job,ref,_=run(s,c,2500)
        rid,out=refund(s,ext,3000,reason='chargeback')
        assert (out['taken_cents'],out['on_hold_cents'])==(0,3000)
        s.rows("update public.api_holds set created_at=now()-interval '25 hours' where ref=%s returning 1",[ref])
        for _ in range(2):
            assert ok(call(s,SERVICE,"select public.api_hold_start_priced(%s,%s)",[ref,job])) is None
        assert s.value("select collected from public.api_refund_recoveries where refund_id=%s",[rid])==3000
        assert balanced(s,c.org)==2000


def test_site_claim_expiry_collects_pending_purchase_refund_once(conn):
    from test_sec_refund_hold_recovery import _buyer,_hold,_refund,_call,_ok,_balanced
    from sec_db import as_superuser
    with as_superuser(conn,commit=False) as s:
        buyer,org,ext=_buyer(s)
        ref=_hold(s,buyer,org,400)
        rid,out=_refund(s,ext)
        assert (out['taken'],out['on_hold'])==(700,300)
        s.rows("update public.credit_reservations set created_at=now()-interval '4 hours' where job_id=%s returning 1",[ref])
        for _ in range(2):
            assert _ok(_call(s,SERVICE,"select public.start_credit_reservation(%s,%s)",[ref,org])) is None
        assert s.value("select collected from public.credit_refund_recoveries where refund_id=%s",[rid])==300
        assert _balanced(s,org)==100

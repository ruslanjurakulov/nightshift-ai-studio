"""Migration 0224, in a real database: a credit price scheduled to change at an exact moment (owner decision D7).

Google doubles gemini-3.6-flash's rates at 2027-01-01T00:00:00Z, and the owner's rule is that our price rises at that moment, never a
day late. 0224 adds credit_price_schedule (append-only, no API role may touch it), credits_per_unit_now() (the newest row in force,
else the price list, else null) and one line in creative_price that quotes at it. These tests play the owner, a member and every API
role.

What would break, and which test says so:
  a quote ignores a row in force, or honours one not yet in force                    test_a_row_in_force_is_quoted_and_a_future_one_is_not
  the rise does not happen at its moment (before: old price; after: new; the hold)   test_the_price_changes_at_effective_at_and_the_hold_follows
  the margin is dropped or doubled by a dated rate                                    test_the_margin_still_applies_to_a_dated_rate
  a mistaken row cannot be corrected                                                  test_a_later_row_at_the_same_moment_corrects_an_earlier_one
  any API role reads, writes or asks the schedule                                     test_no_api_role_can_reach_the_schedule
  a row is rewritten, deleted or truncated                                            test_the_schedule_is_append_only
  a row that would change nothing (no list row, not a model unit, 0) is accepted     test_a_row_that_would_change_nothing_is_refused
  an unknown price reads as a number                                                  test_nothing_priced_is_null_never_zero
  the stamp can be typed                                                              test_who_and_when_are_the_databases
  the SQL the owner is given for D7 does not schedule double the live rate at 00:00Z  test_the_owners_d7_sql_schedules_*
  the rollback or a replay changes what it should not                                 test_rollback_and_replay

Runs in its own scratch database (it commits).
"""
import json
import os
import time
import uuid

import psycopg
import pytest

import sec_db

ORG = "aaaaaaaa-0000-0000-0000-000000000224"
U_A = str(uuid.UUID(int=0x224A))
T2I = {"prompt": "a lighthouse at dusk"}
CP = "public.creative_price(uuid,text,text,jsonb)"


def unit_of(mid):
    return "model_" + "".join(c if c.isalnum() else "_" for c in mid.lower()) + "_image"


# id -> (credits_per_unit, margin) on the price list. One model per test: the schedule is append-only, so no test can clean up.
MODELS = {"img-now": (3, 0), "img-past": (3, 0), "img-clock": (3, 0), "img-margin": (2, 1.5), "img-fix": (3, 0),
          "img-rb": (3, 0), "img-none": None}


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


@pytest.fixture(scope="module")
def db():
    admin = sec_db.admin_dsn()
    if not admin:
        if os.environ.get("NIGHTSHIFT_SECURITY_REQUIRED"):
            pytest.fail(f"{sec_db.DSN_ENV} is not set", pytrace=False)
        pytest.skip(f"{sec_db.DSN_ENV} is not set — the security lab needs a scratch Postgres")
    name = f"ns_price_{uuid.uuid4().hex[:8]}"
    d = Db(sec_db.build(admin, name))
    d.su("insert into auth.users (id, email) values (%s,'a@x.io')", [U_A])
    d.su("insert into public.organizations (id, name, slug) values (%s,'P','org-price-0224')", [ORG])
    d.su("insert into public.org_members (org_id, user_id, email, role) values (%s,%s,'a@x.io','owner')", [ORG, U_A])
    d.su("select public.grant_credits(%s, 1000, 'test')", [ORG])
    rows = [{"id": m, "display_name": m, "provider": "acme", "adapter": "image.acme", "capabilities": ["t2i"],
             "credit_unit": unit_of(m), "entitlement": "any", "spec": {"vendor_model": "acme-" + m, "output": "image"}}
            for m in MODELS]
    d.su("select public.sync_model_registry(%s::jsonb)", [json.dumps(rows)])
    for m in MODELS:
        d.su("select public.record_model_probe(%s, 'image.acme', %s, 't2i', true, null, null, 10, 100, 'security-lab')", [m, "acme-" + m])
        d.su("update public.model_registry set availability='beta' where id=%s", [m])
    prices = [f"('{unit_of(m)}', {r[0]}, {r[1]})" for m, r in MODELS.items() if r is not None]
    d.su(f"insert into public.credit_prices (unit, credits_per_unit, margin) values {', '.join(prices)}, ('job_minimum', 1, 0) "
         "on conflict (unit) do update set credits_per_unit = excluded.credits_per_unit, margin = excluded.margin")
    try:
        yield d
    finally:
        if not os.environ.get("NIGHTSHIFT_SECURITY_KEEP"):
            sec_db.drop_database(admin, name)


def err(fn):
    with pytest.raises(psycopg.Error) as e:
        fn()
    return e.value.sqlstate, str(e.value).splitlines()[0]


def quote(db, model):
    return db.act("authenticated", U_A, "select public.quote_creative_job(%s,'t2i',%s,%s::jsonb)", [ORG, model, json.dumps(T2I)])[0][0]


def schedule(db, model, credits, at_sql, reason="lab"):
    db.su(f"insert into public.credit_price_schedule (unit, credits_per_unit, effective_at, reason) values (%s, %s, {at_sql}, %s)",
          [unit_of(model), credits, reason])


_n = [0]


def create(db, model):
    _n[0] += 1
    out = db.act("authenticated", U_A, "select public.create_creative_job(%s,'t2i',%s,%s::jsonb,'exact',%s,1000)",
                 [ORG, model, json.dumps(T2I), f"dated-{_n[0]}"])[0][0]
    svc = lambda q, p=None: db.act("service_role", None, q, p)  # noqa: E731
    while svc("select id from public.claim_creative_job('drain')"):
        pass
    for (jid,) in db.su("select id::text from public.creative_jobs where worker_id='drain' and status='running'"):
        svc("select public.finish_creative_job(%s,'drain',false,null,null,'test_drain','drained')", [jid])
    return out


def test_with_no_row_the_quote_is_the_price_lists(db):
    q = quote(db, "img-now")
    assert (float(q["credits"]), float(q["credits_per_unit"]), q["unit"]) == (3.0, 3.0, unit_of("img-now"))


def test_a_row_in_force_is_quoted_and_a_future_one_is_not(db):
    schedule(db, "img-past", 5, "now() - interval '1 hour'")
    schedule(db, "img-past", 9, "now() + interval '1 day'")
    q = quote(db, "img-past")
    assert (float(q["credits"]), float(q["credits_per_unit"])) == (5.0, 5.0)
    # The price list itself is untouched: the schedule is read beside it, never written into it.
    assert db.su("select credits_per_unit::float from public.credit_prices where unit = %s", [unit_of("img-past")]) == [(3.0,)]


def test_the_price_changes_at_effective_at_and_the_hold_follows(db):
    schedule(db, "img-clock", 7, "clock_timestamp() + interval '2 seconds'")
    before = create(db, "img-clock")
    assert float(quote(db, "img-clock")["credits"]) == 3.0
    time.sleep(2.5)
    after = create(db, "img-clock")
    assert float(quote(db, "img-clock")["credits"]) == 7.0
    held = dict(db.su("select id::text, quoted_credits::float from public.creative_jobs where id in (%s, %s)",
                      [before["job"]["id"], after["job"]["id"]]))
    # A job quoted before the moment keeps its hold; one after it is held at the new price.
    assert (held[before["job"]["id"]], held[after["job"]["id"]]) == (3.0, 7.0)


def test_the_margin_still_applies_to_a_dated_rate(db):
    assert float(quote(db, "img-margin")["credits"]) == 5.0          # 2 x (1 + 1.5)
    schedule(db, "img-margin", 4, "now() - interval '1 minute'")
    q = quote(db, "img-margin")
    assert (float(q["credits"]), float(q["credits_per_unit"])) == (10.0, 10.0)   # 4 x (1 + 1.5)


def test_a_later_row_at_the_same_moment_corrects_an_earlier_one(db):
    at = db.su("select (now() - interval '1 minute')::text")[0][0]
    schedule(db, "img-fix", 80, f"'{at}'::timestamptz", reason="typo: meant 8")
    schedule(db, "img-fix", 8, f"'{at}'::timestamptz", reason="correction of the row above")
    assert float(quote(db, "img-fix")["credits"]) == 8.0


@pytest.mark.parametrize("role,uid", [("anon", None), ("authenticated", U_A), ("service_role", None)])
def test_no_api_role_can_reach_the_schedule(db, role, uid):
    u = unit_of("img-now")
    for q in ("select * from public.credit_price_schedule",
              f"insert into public.credit_price_schedule (unit, credits_per_unit, effective_at, reason) values ('{u}', 1, now(), 'x')",
              "update public.credit_price_schedule set credits_per_unit = 1",
              "delete from public.credit_price_schedule",
              "truncate public.credit_price_schedule",
              f"select public.credits_per_unit_now('{u}')",
              f"select public.creative_price('{ORG}', 't2i', 'img-now', '{{}}'::jsonb)"):
        assert err(lambda: db.act(role, uid, q))[0] == "42501", (role, q)


def test_the_schedule_is_append_only(db):
    schedule(db, "img-now", 3, "now() + interval '30 days'")
    for q in ("update public.credit_price_schedule set credits_per_unit = 1",
              "update public.credit_price_schedule set effective_at = now()",
              "delete from public.credit_price_schedule",
              "truncate public.credit_price_schedule"):
        state, msg = err(lambda: db.su(q))
        assert state == "42501" and "append-only" in msg, (q, msg)
    assert db.su("select count(*) from public.credit_price_schedule where unit = %s", [unit_of("img-now")]) == [(1,)]


def test_a_row_that_would_change_nothing_is_refused(db):
    for unit, credits, why in ((unit_of("img-none"), 5, "has no credit_prices row"),     # a model with no list price: not opened by a date
                               ("job_minimum", 2, "is not a model's credit unit"),        # read by its own line, not through the schedule
                               ("model_nobody_image", 5, "has no credit_prices row")):
        state, msg = err(lambda: db.su("insert into public.credit_price_schedule (unit, credits_per_unit, effective_at, reason) "
                                       "values (%s, %s, now(), 'x')", [unit, credits]))
        assert state == "23514" and why in msg, (unit, msg)
    for credits in (0, -1):
        assert err(lambda: schedule(db, "img-now", credits, "now()"))[0] == "23514"
    assert err(lambda: schedule(db, "img-now", 1, "now()", reason="  "))[0] == "23514"


def test_nothing_priced_is_null_never_zero(db):
    assert db.su("select public.credits_per_unit_now('model_img_none_image'), public.credits_per_unit_now(null)") == [(None, None)]
    state, msg = err(lambda: quote(db, "img-none"))
    assert state == "NS400" and "unpriced" in msg


def test_who_and_when_are_the_databases(db):
    db.su("insert into public.credit_price_schedule (unit, credits_per_unit, effective_at, reason, created_by, created_at) "
          "values (%s, 3, now() + interval '40 days', 'stamp', 'someone-else', '2000-01-01')", [unit_of("img-now")])
    who, recent = db.su("select created_by, created_at > now() - interval '1 minute' from public.credit_price_schedule "
                        "where reason = 'stamp'")[0]
    assert (who, recent) == ("postgres", True)


def test_the_owners_d7_sql_schedules_double_the_live_rate_at_2027_01_01_utc(db):
    # The exact SQL docs/MIGRATIONS.md gives the owner, run against a gemini-3.6-flash row shaped like the live one (0.4 at margin 2.0,
    # docs/sql/prices_corrections_2026_10_01.sql). Before the moment the quote is unchanged; the row says double from 2027-01-01 UTC.
    doc = (sec_db.REPO / "docs" / "MIGRATIONS.md").read_text(encoding="utf-8")
    sql_block = doc.split("### D7: gemini-3.6-flash doubles")[1].split("```sql")[1].split("```")[0]
    unit = "model_gemini_3_6_flash_request"
    with psycopg.connect(db.dsn, autocommit=False) as c:
        c.execute("select public.sync_model_registry(%s::jsonb)", [json.dumps([{
            "id": "gemini-3.6-flash", "display_name": "Gemini 3.6 Flash", "provider": "google", "adapter": "image.gemini_describe",
            "capabilities": ["describe"], "credit_unit": unit, "entitlement": None, "spec": {"output": "text"}}])])
        c.execute("insert into public.credit_prices (unit, credits_per_unit, margin) values (%s, 0.4, 2.0)", [unit])
        c.execute(sql_block)
        row = c.execute("select credits_per_unit::text, effective_at = '2027-01-01T00:00:00Z'::timestamptz, reason like 'D7:%%' "
                        "from public.credit_price_schedule where unit = %s", [unit]).fetchall()
        assert row == [("0.80000000", True, True)]
        assert c.execute("select public.credits_per_unit_now(%s)::text", [unit]).fetchone()[0] == "0.40000000"
        c.rollback()


def test_rollback_and_replay(db):
    mig = sec_db.MIGRATION_0224.read_text(encoding="utf-8")
    md5 = f"select md5(regexp_replace((select prosrc from pg_proc where oid = '{CP}'::regprocedure), '\\s+', ' ', 'g'))"
    with psycopg.connect(db.dsn, autocommit=False) as c:
        assert c.execute(md5).fetchone()[0] == sec_db.CREATIVE_PRICE_0224
        c.execute(mig)                                                   # a replay changes nothing
        assert c.execute(md5).fetchone()[0] == sec_db.CREATIVE_PRICE_0224
        c.execute(f"insert into public.credit_price_schedule (unit, credits_per_unit, effective_at, reason) "
                  f"values ('{unit_of('img-rb')}', 6, now() - interval '1 minute', 'rb')")
        c.execute(sec_db.rollback_0224_body())
        assert c.execute(md5).fetchone()[0] == sec_db.CREATIVE_PRICE_0208
        assert c.execute("select to_regprocedure('public.credits_per_unit_now(text)') is null").fetchone()[0]
        # The owner's rows stay (and stay append-only); they change no quote without the reader.
        assert c.execute("select count(*) from public.credit_price_schedule where reason = 'rb'").fetchone()[0] == 1
        c.execute(sec_db.rollback_0224_body())                           # twice: harmless
        c.execute(sec_db.rollback_0208_body())                           # the lab's chain: 0208's after 0224's, from any point
        assert c.execute(md5).fetchone()[0] == sec_db.CREATIVE_PRICE_0159
        c.execute(sec_db.MIGRATION_0208.read_text(encoding="utf-8"))
        sec_db.put_back_0224(c)
        assert c.execute(md5).fetchone()[0] == sec_db.CREATIVE_PRICE_0224
        c.rollback()
    # Out of the transaction, the live chain is unchanged and the rolled-back row never existed.
    assert db.su("select count(*) from public.credit_price_schedule where reason = 'rb'") == [(0,)]
    assert float(quote(db, "img-rb")["credits"]) == 3.0

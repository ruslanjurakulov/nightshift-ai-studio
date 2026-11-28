"""Breach, migration 0224 (dated credit prices): attacks on credit_price_schedule, credits_per_unit_now, the list-price guard and the
rollback, in a scratch database of the security lab only.

A test here that FAILS is an open hole and stays failing (never skipped) until 0224 is fixed:

  a platform admin's ordinary "delete price" on a scheduled unit can never be undone:  test_breach_0224_a_deleted_list_row_of_a_scheduled_unit_can_be_put_back
    the list guard refuses the list row back (any rate, even the same one), the        test_breach_0224_a_direct_api_delete_of_a_scheduled_list_row_can_be_put_back
    schedule guard refuses the remedy the error names (no list row), the Credits page's
    restore is refused too: the model is unsellable until the table owner disables a
    trigger by DDL. The direct PostgREST DELETE (no confirm, no owner_guard) does it too.
  a positive dated rate small enough to round to 0 credits makes the model free        test_breach_0224_a_positive_dated_rate_never_quotes_zero_credits
    (job_minimum is skipped for a 0 price): a 0-credit, unheld job is queued for a
    paying organization. The "> 0, never free" check does not hold.
  NaN passes "credits_per_unit > 0", and the customer's quote reads "NaN" credits      test_breach_0224_a_nan_dated_rate_is_refused
  re-applying 0224 after its rollback revives a stale dated row and lowers a quote     test_breach_0224_reapplying_after_the_rollback_changes_no_quote
    below the list rate the owner set in between ("It changes NO quote by itself").

Status at 44d40fa73: the five above pass (closed). Still OPEN (fails):
  a tiny dated row written while 0224 was rolled back (the tenth guard needs the     test_breach_0224_a_tiny_dated_row_written_while_0224_was_off_never_quotes_zero
    reader) and still pending at re-apply quotes 0 credits at its moment.

Attempts that are refused today (kept as regressions): a delete+insert in one statement (data-modifying CTE), MERGE, an upsert, and
an exact-mode create confirmed at the old price after the rise.

Runs in its own scratch database (it commits).
"""
import json
import os
import uuid

import psycopg
import pytest

import sec_db

ORG = "bbbbbbbb-0000-0000-0000-000000000224"
U_ADMIN = str(uuid.UUID(int=0xB224))
T2I = {"prompt": "a lighthouse at dusk"}


def unit_of(mid):
    return "model_" + "".join(c if c.isalnum() else "_" for c in mid.lower()) + "_image"


# One model per test: the schedule is append-only, so no test can clean up after itself.
MODELS = ["br-del", "br-api", "br-tiny", "br-nan", "br-rb", "br-cte", "br-old", "br-low", "br-char", "br-off"]


def claims(role, uid=None, email=None):
    c = {"role": role, "aal": "aal1"}
    if uid:
        c["sub"] = uid
    if email:
        c["email"] = email
    return json.dumps(c)


class Db:
    def __init__(self, dsn):
        self.dsn = dsn

    def su(self, q, p=None):
        with psycopg.connect(self.dsn, autocommit=True) as c:
            cur = c.execute(q, p)
            return cur.fetchall() if cur.description else None

    def act(self, role, uid, q, p=None, email=None):
        with psycopg.connect(self.dsn, autocommit=False) as c:
            try:
                c.execute("select set_config('request.jwt.claims', %s, true)", [claims(role, uid, email)])
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
    name = f"ns_breach224_{uuid.uuid4().hex[:8]}"
    d = Db(sec_db.build(admin, name))
    d.su("insert into auth.users (id, email) values (%s,'admin@x.io')", [U_ADMIN])
    d.su("insert into public.organizations (id, name, slug) values (%s,'B','org-breach-0224')", [ORG])
    d.su("insert into public.org_members (org_id, user_id, email, role) values (%s,%s,'admin@x.io','owner')", [ORG, U_ADMIN])
    # The same person is the platform's owner: the Credits page's price functions are theirs.
    d.su("insert into public.app_members (user_id, email, role) values (%s,'admin@x.io','owner')", [U_ADMIN])
    d.su("select public.grant_credits(%s, 1000, 'test')", [ORG])
    rows = [{"id": m, "display_name": m, "provider": "acme", "adapter": "image.acme", "capabilities": ["t2i"],
             "credit_unit": unit_of(m), "entitlement": "any", "spec": {"vendor_model": "acme-" + m, "output": "image"}}
            for m in MODELS]
    d.su("select public.sync_model_registry(%s::jsonb)", [json.dumps(rows)])
    for m in MODELS:
        d.su("select public.record_model_probe(%s, 'image.acme', %s, 't2i', true, null, null, 10, 100, 'security-lab')", [m, "acme-" + m])
        d.su("update public.model_registry set availability='beta' where id=%s", [m])
    prices = ", ".join(f"('{unit_of(m)}', 3, 0)" for m in MODELS)
    d.su(f"insert into public.credit_prices (unit, credits_per_unit, margin) values {prices}, ('job_minimum', 1, 0) "
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


def admin_call(db, q, p=None):
    return db.act("authenticated", U_ADMIN, q, p, email="admin@x.io")[0][0]


def quote(db, model):
    return db.act("authenticated", U_ADMIN, "select public.quote_creative_job(%s,'t2i',%s,%s::jsonb)",
                  [ORG, model, json.dumps(T2I)])[0][0]


def schedule(db, model, credits, at_sql, reason="lab"):
    db.su(f"insert into public.credit_price_schedule (unit, credits_per_unit, effective_at, reason) values (%s, %s, {at_sql}, %s)",
          [unit_of(model), credits, reason])


def _can_relist(db, unit):
    """Every way back the product and the owner have: the Credits page's restore and set, then the remedy the guard's error names
    (a dated row), then a plain insert in the SQL editor. True as soon as one of them puts a list row back."""
    hist = db.su("select max(id) from public.credit_price_history where unit = %s and action = 'delete'", [unit])[0][0]
    tries = []
    if hist is not None:
        tries.append(lambda: admin_call(db, "select public.owner_restore_credit_price(%s, 'undo the delete', true)", [hist]))
    tries += [
        lambda: admin_call(db, "select public.owner_set_credit_price(%s, 3, 0, null, 'put it back', true)", [unit]),
        lambda: db.su("insert into public.credit_price_schedule (unit, credits_per_unit, effective_at, reason) "
                      "values (%s, 3, now(), 'the remedy the error names')", [unit]),
        lambda: db.su("insert into public.credit_prices (unit, credits_per_unit, margin) values (%s, 3, 0)", [unit]),
    ]
    outcomes = []
    for t in tries:
        try:
            outcomes.append(("ok", t()))
        except psycopg.Error as e:
            outcomes.append((e.sqlstate, str(e).splitlines()[0]))
        if db.su("select count(*) from public.credit_prices where unit = %s", [unit])[0][0] == 1:
            return True, outcomes
    return False, outcomes


# ── open holes (each fails until 0224 is fixed) ─────────────────────────────

def test_breach_0224_a_deleted_list_row_of_a_scheduled_unit_can_be_put_back(db):
    # A platform admin removes the price of a model whose rise is scheduled (a mistake, or "take it off sale for now"). The Credits
    # page asks for confirmation and then deletes: credit_prices_dated_guard has no DELETE branch. From then on the list guard refuses
    # the row back (a new list row for a scheduled unit), the schedule guard refuses the dated row the error tells the owner to add
    # (it needs a list row), and owner_restore_credit_price is refused as well: the model is unsellable for good, and the error names
    # a remedy that cannot be carried out (CLAUDE.md #6). Either the delete must be refused with the remedy, or the way back must work.
    unit = unit_of("br-del")
    schedule(db, "br-del", 6, "now() + interval '10 days'")
    out = admin_call(db, "select public.owner_delete_credit_price(%s, 'off sale for now', true)", [unit])
    if not out.get("ok"):
        return                                                        # the delete itself was refused: no stuck state
    ok, outcomes = _can_relist(db, unit)
    assert ok, f"{unit}: list row deleted with a dated row pending, and no way puts it back: {outcomes}"


def test_breach_0224_a_direct_api_delete_of_a_scheduled_list_row_can_be_put_back(db):
    # The same state through PostgREST: authenticated holds DELETE on credit_prices and the delete policy is is_platform_admin(), so
    # `DELETE /rest/v1/credit_prices?unit=eq.<unit>` reaches it with no confirmation and no owner_guard (no aal2 check, no rate limit).
    unit = unit_of("br-api")
    schedule(db, "br-api", 6, "now() - interval '1 minute'")       # in force: the dated rate is what customers are charged
    db.act("authenticated", U_ADMIN, "delete from public.credit_prices where unit = %s", [unit], email="admin@x.io")
    if db.su("select count(*) from public.credit_prices where unit = %s", [unit])[0][0] == 1:
        return                                                        # the delete was refused: no stuck state
    assert err(lambda: quote(db, "br-api"))[0] == "NS400"           # unsellable now
    ok, outcomes = _can_relist(db, unit)
    assert ok, f"{unit}: list row deleted under a dated row in force, and no way puts it back: {outcomes}"


def test_breach_0224_a_positive_dated_rate_never_quotes_zero_credits(db):
    # The schedule refuses 0 because "a 0 would read as free from then on". A positive rate below half a millionth (a slipped decimal
    # point: 0.0000004 for 0.4) rounds (round(..., 6), then up to the cent) to 0 credits, and creative_price applies job_minimum only
    # to a price > 0: the quote is 0 and create_creative_job queues an unheld 0-credit job for a paying organization. Every customer
    # generates free at the vendor's cost from effective_at on, with nothing refusing it.
    # Since 44d40fa73 the schedule refuses a rate below a tenth of the one in force (23514, "check the decimal point").
    state, msg = "accepted", None
    try:
        schedule(db, "br-tiny", 0.0000004, "now() - interval '1 second'", reason="typo for 0.4")
    except psycopg.Error as e:
        state, msg = e.sqlstate, str(e).splitlines()[0]
    if state != "accepted":
        assert state == "23514" and "decimal point" in msg, msg
    q = quote(db, "br-tiny")
    assert float(q["credits"]) > 0, f"a dated rate > 0 quoted {q['credits']} credits: free generations for every customer"
    # Just above the tenth (0.3000001 of 3): accepted, and still never 0.
    schedule(db, "br-tiny", 0.3000001, "now() - interval '1 second'", reason="a deep cut, just inside the guard")
    assert float(quote(db, "br-tiny")["credits"]) > 0


def test_breach_0224_a_nan_dated_rate_is_refused(db):
    # numeric NaN sorts above every number, so `credits_per_unit > 0` accepts it (Infinity is refused by numeric(18,8), NaN is not).
    # The quote a customer sees then reads credits "NaN" (CLAUDE.md #5: never render an unknown as a number); the hold refuses it only
    # by accident (reserve_credits: "amount must be a positive number"). owner_price_write refuses NaN for the list; the schedule must.
    state, msg = "accepted", None
    try:
        schedule(db, "br-nan", "NaN", "now() - interval '1 second'", reason="nan")
    except psycopg.Error as e:
        state, msg = e.sqlstate, str(e).splitlines()[0]
    if state == "accepted":
        q = quote(db, "br-nan")
        pytest.fail(f"credit_price_schedule accepted NaN; a customer's quote now reads credits={q['credits']!r}")
    assert state == "23514", msg


def test_breach_0224_reapplying_after_the_rollback_changes_no_quote(db):
    # 0224's header: "It changes NO quote by itself". After the rollback (which keeps the schedule's rows, docs/MIGRATIONS.md) the
    # owner sets the list to the rate in force, as told, and later to a newer one (the vendor rose again). Re-applying 0224 then
    # quotes the stale dated row again, under the list: below the cost the owner priced for (D7: "never sell below cost").
    unit = unit_of("br-rb")
    with psycopg.connect(db.dsn, autocommit=False) as c:
        c.execute("insert into public.credit_price_schedule (unit, credits_per_unit, effective_at, reason) "
                  "values (%s, 6, now() - interval '1 day', 'the first rise')", [unit])
        c.execute(sec_db.rollback_0224_body())
        c.execute("update public.credit_prices set credits_per_unit = 6 where unit = %s", [unit])   # the doc's step after a rollback
        c.execute("update public.credit_prices set credits_per_unit = 10 where unit = %s", [unit])  # the vendor rises again
        c.execute("select set_config('request.jwt.claims', %s, true)", [claims("authenticated", U_ADMIN)])
        c.execute("set local role authenticated")
        before = float(c.execute("select public.quote_creative_job(%s,'t2i','br-rb',%s::jsonb)",
                                 [ORG, json.dumps(T2I)]).fetchone()[0]["credits"])
        c.execute("reset role")
        c.execute(sec_db.MIGRATION_0224.read_text(encoding="utf-8"))
        c.execute("set local role authenticated")
        after = float(c.execute("select public.quote_creative_job(%s,'t2i','br-rb',%s::jsonb)",
                                [ORG, json.dumps(T2I)]).fetchone()[0]["credits"])
        c.rollback()
    assert (before, after) == (10.0, 10.0), f"re-applying 0224 moved the quote from {before} to {after} (a stale dated row)"


# ── refused today (regressions) ─────────────────────────────────────────────

@pytest.mark.parametrize("q", [
    "with d as (delete from public.credit_prices where unit = %(u)s returning unit) "
    "insert into public.credit_prices (unit, credits_per_unit, margin) select unit, 0.5, 0 from d",
    "with d as (delete from public.credit_prices where unit = %(u)s returning unit) "
    "insert into public.credit_prices (unit, credits_per_unit, margin) select unit, 0.5, 0 from d on conflict (unit) do nothing",
    "merge into public.credit_prices t using (select %(u)s::text u, 0.5::numeric r) s on t.unit = s.u "
    "when matched then update set credits_per_unit = s.r",
    "insert into public.credit_prices (unit, credits_per_unit, margin) values (%(u)s, 0.5, 0) "
    "on conflict (unit) do update set credits_per_unit = excluded.credits_per_unit",
    "update public.credit_prices set unit = 'model_br_cte_image_x' where unit = %(u)s",
])
def test_breach_0224_a_list_rate_cannot_be_moved_under_a_dated_row_in_one_statement(db, q):
    unit = unit_of("br-cte")
    if not db.su("select count(*) from public.credit_price_schedule where unit = %s", [unit])[0][0]:
        schedule(db, "br-cte", 6, "now() + interval '10 days'")
    state, msg = err(lambda: db.su(q, {"u": unit}))
    assert state == "NS428" and "dated_price_scheduled" in msg, msg
    assert db.su("select credits_per_unit::float from public.credit_prices where unit = %s", [unit]) == [(3.0,)]


def test_breach_0224_a_create_confirmed_at_the_old_price_is_refused_after_the_rise(db):
    # The browser's quote said 3; the rise is in force by the time the person presses Create (or a client replays its old confirmed
    # figure). exact mode with max_credits = the old price must be refused, never held at 3.
    q0 = quote(db, "br-old")
    assert float(q0["credits"]) == 3.0
    schedule(db, "br-old", 7, "now() - interval '1 second'")
    state, msg = err(lambda: db.act("authenticated", U_ADMIN,
                                    "select public.create_creative_job(%s,'t2i','br-old',%s::jsonb,'exact','breach-old-1',3)",
                                    [ORG, json.dumps(T2I)]))
    assert state == "NS409" and "price_changed" in msg, msg


def test_breach_0224_a_deleted_list_row_comes_back_only_at_its_own_rate(db):
    # The way back 44d40fa73 opens (the newest credit_price_history row must be this unit's delete, at the same rate) must not be a way
    # down: put back at a lower rate by the Credits page, by an older history row's restore, or by a plain insert, it is refused.
    unit = unit_of("br-low")
    admin_call(db, "select public.owner_set_credit_price(%s, 1, 0, null, 'an old, lower rate', true)", [unit])
    admin_call(db, "select public.owner_set_credit_price(%s, 3, 0, null, 'back to 3', true)", [unit])
    older = db.su("select max(id) from public.credit_price_history where unit = %s", [unit])[0][0]   # old = 1: its restore writes 1
    db.act("authenticated", U_ADMIN, "delete from public.credit_prices where unit = %s", [unit], email="admin@x.io")
    admin_call(db, "select public.owner_set_credit_price(%s, 3, 0, null, 'relist', true)", [unit])   # unscheduled: any rate
    schedule(db, "br-low", 6, "now() + interval '10 days'")
    db.act("authenticated", U_ADMIN, "delete from public.credit_prices where unit = %s", [unit], email="admin@x.io")
    for attempt in (
        lambda: admin_call(db, "select public.owner_set_credit_price(%s, 1, 0, null, 'lower', true)", [unit]),
        lambda: admin_call(db, "select public.owner_restore_credit_price(%s, 'older entry', true)", [older]),
        lambda: db.su("insert into public.credit_prices (unit, credits_per_unit, margin) values (%s, 2.99999999, 0)", [unit]),
    ):
        assert err(attempt)[0] == "NS428"
        assert db.su("select count(*) from public.credit_prices where unit = %s", [unit]) == [(0,)]
    db.su("insert into public.credit_prices (unit, credits_per_unit, margin) values (%s, 3, 0)", [unit])   # its own rate: back
    assert float(quote(db, "br-low")["credits"]) == 3.0


def test_breach_0224_the_history_the_way_back_reads_is_closed_to_every_api_role(db):
    # The way back trusts the newest credit_price_history row; a forged 'delete' row at a lower rate would open a way down.
    for role, uid in (("anon", None), ("authenticated", U_ADMIN), ("service_role", None)):
        for q in ("insert into public.credit_price_history (unit, action, old_credits_per_unit) values ('model_br_low_image', 'delete', 0.01)",
                  "update public.credit_price_history set old_credits_per_unit = 0.01",
                  "delete from public.credit_price_history"):
            assert err(lambda: db.act(role, uid, q, email="admin@x.io"))[0] == "42501", (role, q)


def test_breach_0224_the_tenth_guard_holds_for_the_smallest_real_unit(db):
    # The cheapest real list rate is a per-character voice (0.004, docs/sql/prices_2026_10_01.sql); quantities are whole (characters,
    # ceil'd seconds). A dated rate just inside the tenth, for one character, still quotes the job minimum, never 0.
    unit = unit_of("br-char")
    db.su("update public.credit_prices set credits_per_unit = 0.004 where unit = %s", [unit])
    schedule(db, "br-char", 0.00040001, "now() - interval '1 second'", reason="deepest cut the guard allows")
    assert err(lambda: schedule(db, "br-char", 0.00003999, "now() - interval '1 second'"))[0] == "23514"
    q = db.act("authenticated", U_ADMIN, "select public.quote_creative_job(%s,'t2i','br-char','{\"prompt\":\"x\"}'::jsonb)", [ORG])[0][0]
    assert float(q["credits"]) > 0


def test_breach_0224_a_tiny_dated_row_written_while_0224_was_off_never_quotes_zero(db):
    # OPEN after 44d40fa73. The tenth guard is "asked only while the reader exists": with 0224 rolled back (table and triggers kept),
    # a slipped decimal point (0.0000004 for 0.4) on a pending row is accepted, and re-applying 0224 checks only rows already in force.
    # At its moment the row prices the model at 0 credits: free generations for every customer, nothing refusing it.
    with psycopg.connect(db.dsn, autocommit=False) as c:
        c.execute(sec_db.rollback_0224_body())
        c.execute("insert into public.credit_price_schedule (unit, credits_per_unit, effective_at, reason) "
                  "values (%s, 0.0000004, clock_timestamp() + interval '1 second', 'typo while 0224 was off')", [unit_of("br-off")])
        c.execute(sec_db.MIGRATION_0224.read_text(encoding="utf-8"))
        c.commit()
    import time
    time.sleep(1.5)
    q = quote(db, "br-off")
    assert float(q["credits"]) > 0, f"a dated row kept across the rollback quoted {q['credits']} credits once in force"

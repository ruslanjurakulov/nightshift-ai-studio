"""The adult attestation (0192), attacked in a real database.

Some vendors' terms (the Gemini API's among them) require their users to be 18 or older. A model whose registry entry says
"requires_adult": true reaches model_registry.spec through the sync, and the database then refuses it (NS400
adult_attestation_required) to anyone without an adult attestation, at the quote, in the router and at the job, before anything
is held. A person who said they are under 18 is refused EVERY model (NS400 adult_only_service). The browser never decides.

What would break, and which test says so:
  (a) a requires_adult model is quoted or started without an attestation        test_no_attestation_*
      ... or the refusal comes after the ceiling, the balance or a hold           test_the_refusal_comes_before_any_hold
  (b) someone else writes or reads my answer, or anon gets anything              test_another_person_*, test_anon_*
  (c) the answer can be edited or erased                                         test_the_record_cannot_be_updated_deleted_or_truncated
  (d) a second call flips minor -> adult or adult -> minor                       test_the_first_answer_stands_*
  (e) an adult is refused                                                        test_an_adult_passes_*
  (f) a model without the flag is refused to someone who never answered         test_a_model_without_the_flag_is_unaffected
  a minor gets something                                                         test_a_minor_gets_nothing_*
  the router picks an adult-only model for someone who may not use it            test_the_route_*
  the model disappears from the list (we never pretend it does not exist)        test_the_model_stays_listed_and_marked
  a flag of an odd shape reads as "not required"                                 test_a_flag_of_another_shape_fails_closed
  the API answers without the remedy                                             test_the_api_names_the_remedy
  a deleted account takes the record with it, or is blocked by it               test_deleting_the_account_keeps_the_record
  the rollback drops the record, or a replay changes anything                    test_replay_and_rollback_keep_the_record

Runs in its own scratch database (it commits), with models installed through sync_model_registry and a real probe row, as
production does.
"""
import json
import os
import uuid

import psycopg
import pytest

import sec_db

ORG_A = "aaaaaaaa-0000-0000-0000-0000000001a9"
ORG_B = "bbbbbbbb-0000-0000-0000-0000000001b9"
ORG_BROKE = "cccccccc-0000-0000-0000-0000000001c9"
U_ADULT = str(uuid.UUID(int=0x1A9))   # confirmed 18+
U_NONE = str(uuid.UUID(int=0x1AA))    # never answered (a Google signup before 0192)
U_MINOR = str(uuid.UUID(int=0x1AB))   # said under 18
U_B = str(uuid.UUID(int=0x1B9))       # another organization's adult

# (id, capabilities, extra spec, credit unit, credits per unit)
MODELS = [
    # The vendor's terms are 18+. The cheapest and best picture model, so a route would pick it first if it were allowed to.
    ("img-adult", ["t2i"], {"requires_adult": True, "quality_tier": 5, "speed_tier": 5}, "model_img_adult_image", 1),
    # The control: no flag.
    ("img-free", ["t2i"], {"quality_tier": 3, "speed_tier": 3}, "model_img_free_image", 2),
    # The only text-to-video model, and it is for adults only: a route has nothing else to pick.
    ("vid-adult", ["t2v"], {"requires_adult": True, "durations_s": list(range(1, 61))}, "model_vid_adult_second", 2),
    # A flag of the wrong shape (a string): reads as required.
    ("img-odd", ["t2i"], {"requires_adult": "false"}, "model_img_odd_image", 3),
]
PRICES = ", ".join(f"('{u}', {c}, 0)" for _m, _c, _s, u, c in MODELS) + ", ('job_minimum', 1, 0)"
T2I = {"prompt": "a lighthouse at dusk"}
T2V = {"prompt": "a lighthouse at dusk", "duration_s": 4}


#: The words the app asks today: command-center/lib/age.ts AGE_TERMS_VERSION, the one version record_adult_attestation accepts.
TERMS = "2026-11-20"
#: Accounts whose session token says they signed in with Google (Supabase writes app_metadata.provider; the user cannot edit it).
GOOGLE = set()


def claims(role, uid=None):
    c = {"role": role}
    if uid:
        c["sub"] = uid
        if uid in GOOGLE:
            c["app_metadata"] = {"provider": "google", "providers": ["google"]}
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
    name = f"ns_adult_{uuid.uuid4().hex[:8]}"
    d = Db(sec_db.build(admin, name))
    d.su("insert into auth.users (id, email) values (%s,'ad@x.io'),(%s,'no@x.io'),(%s,'mi@x.io'),(%s,'b@x.io')",
         [U_ADULT, U_NONE, U_MINOR, U_B])
    d.su("insert into public.organizations (id, name, slug) values (%s,'A','org-adult-a'),(%s,'B','org-adult-b'),"
         "(%s,'C','org-adult-c')", [ORG_A, ORG_B, ORG_BROKE])
    d.su("insert into public.org_members (org_id, user_id, email, role) values "
         "(%s,%s,'ad@x.io','owner'),(%s,%s,'no@x.io','editor'),(%s,%s,'mi@x.io','editor'),(%s,%s,'b@x.io','owner'),"
         "(%s,%s,'no@x.io','owner'),(%s,%s,'ad@x.io','editor')",
         [ORG_A, U_ADULT, ORG_A, U_NONE, ORG_A, U_MINOR, ORG_B, U_B, ORG_BROKE, U_NONE, ORG_BROKE, U_ADULT])
    d.su("select public.grant_credits(%s, 100, 'test')", [ORG_A])
    d.su("select public.grant_credits(%s, 100, 'test')", [ORG_B])

    def kind(m):
        return "image" if m.startswith("img-") else "video"

    rows = [{"id": m, "display_name": m, "provider": "acme", "adapter": f"{kind(m)}.acme", "capabilities": caps,
             "credit_unit": unit, "entitlement": "any",
             "spec": {"vendor_model": "acme-" + m, "output": kind(m), **extra}}
            for m, caps, extra, unit, _c in MODELS]
    d.su("select public.sync_model_registry(%s::jsonb)", [json.dumps(rows)])
    for m, caps, _x, _u, _c in MODELS:
        d.su("select public.record_model_probe(%s, %s, %s, %s, true, null, null, 10, 100, 'security-lab')",
             [m, f"{kind(m)}.acme", "acme-" + m, caps[-1]])
        d.su("update public.model_registry set availability='beta' where id=%s", [m])
    d.su(f"insert into public.credit_prices (unit, credits_per_unit, margin) values {PRICES} "
         "on conflict (unit) do update set credits_per_unit = excluded.credits_per_unit, margin = 0")
    # The answers, each in the person's own session, as the app writes them.
    GOOGLE.add(U_B)
    d.act("authenticated", U_ADULT, "select public.record_adult_attestation(true, %s, 'email_signup')", [TERMS])
    d.act("authenticated", U_MINOR, "select public.record_adult_attestation(false, %s, 'welcome')", [TERMS])
    d.act("authenticated", U_B, "select public.record_adult_attestation(true, %s, 'google')", [TERMS])
    try:
        yield d
    finally:
        if not os.environ.get("NIGHTSHIFT_SECURITY_KEEP"):
            sec_db.drop_database(admin, name)


def err(fn):
    with pytest.raises(psycopg.Error) as e:
        fn()
    return e.value.sqlstate, str(e.value).splitlines()[0], (e.value.diag.message_detail or "")


def record(db, uid, adult, version=TERMS, method="create"):
    return db.act("authenticated", uid, "select public.record_adult_attestation(%s, %s, %s)", [adult, version, method])[0][0]


def mine(db, uid):
    return db.act("authenticated", uid, "select public.my_adult_attestation()")[0][0]


def quote(db, uid, org, model, params=T2I, cap="t2i"):
    return db.act("authenticated", uid, "select public.quote_creative_job(%s,%s,%s,%s::jsonb)",
                  [org, cap, model, json.dumps(params)])[0][0]


def route(db, uid, org, mode, params=T2I, cap="t2i"):
    return db.act("authenticated", uid, "select public.quote_creative_route(%s,%s,%s,%s::jsonb)",
                  [org, cap, mode, json.dumps(params)])[0][0]


def create(db, uid, org, model, params=T2I, cap="t2i", mode="exact", maxc=1000, idem=None):
    return db.act("authenticated", uid, "select public.create_creative_job(%s,%s,%s,%s::jsonb,%s,%s,%s)",
                  [org, cap, model, json.dumps(params), mode, idem, maxc])[0][0]


def footprint(db, org):
    """Everything a job start could leave behind: job rows, holds, the account, the ledger."""
    return (db.su("select count(*) from public.creative_jobs where org_id=%s", [org])[0][0],
            db.su("select count(*), coalesce(sum(amount),0)::float from public.credit_reservations where org_id=%s", [org])[0],
            (db.su("select balance::float, reserved::float from public.credit_accounts where org_id=%s", [org]) or [None])[0],
            db.su("select count(*) from public.credit_transactions where org_id=%s", [org])[0][0])


def row(db, uid):
    return db.su("select adult, terms_version, method from public.adult_attestations where user_id=%s", [uid])


def drain(db):
    def svc(q, p=None):
        return db.act("service_role", None, q, p)
    while svc("select id from public.claim_creative_job('drain')"):
        pass
    for (jid,) in db.su("select id::text from public.creative_jobs where worker_id='drain'"):
        svc("select public.finish_creative_job(%s,'drain',false,null,null,'test_drain','drained')", [jid])


# ── (a) no attestation: refused at the quote and the job, before anything is held ─────────────────────────────────────────────

def test_no_attestation_no_quote(db):
    assert mine(db, U_NONE) == {"state": "none"}
    st, word, detail = err(lambda: quote(db, U_NONE, ORG_A, "img-adult"))
    assert (st, word) == ("NS400", "adult_attestation_required"), (st, word)
    assert "model=img-adult" in detail and "18 or older" in detail


def test_no_attestation_no_job(db):
    before = footprint(db, ORG_A)
    st, word, _ = err(lambda: create(db, U_NONE, ORG_A, "img-adult"))
    assert (st, word) == ("NS400", "adult_attestation_required")
    assert footprint(db, ORG_A) == before


def test_the_refusal_comes_before_any_hold(db):
    # A confirmed price of 0 would be price_changed: the attestation is asked first.
    before = footprint(db, ORG_A)
    st, word, _ = err(lambda: create(db, U_NONE, ORG_A, "img-adult", maxc=0))
    assert (st, word) == ("NS400", "adult_attestation_required")
    assert footprint(db, ORG_A) == before
    # An organization with no credits at all would be NS402: the attestation is still asked first, and nothing moves.
    broke = footprint(db, ORG_BROKE)
    st, word, _ = err(lambda: create(db, U_NONE, ORG_BROKE, "img-adult"))
    assert (st, word) == ("NS400", "adult_attestation_required")
    # With the attestation (the adult, in the same organization), the balance is what refuses.
    st, _w, _d = err(lambda: create(db, U_ADULT, ORG_BROKE, "img-adult"))
    assert st == "NS402", "with the attestation, the balance is what refuses"
    assert footprint(db, ORG_BROKE) == broke


# ── a minor gets nothing ─────────────────────────────────────────────────────────────────────────────────────────────────────

def test_a_minor_gets_nothing_at_the_quote(db):
    assert mine(db, U_MINOR) == {"state": "minor"}
    for model in ("img-free", "img-adult"):
        st, word, _ = err(lambda: quote(db, U_MINOR, ORG_A, model))
        assert (st, word) == ("NS400", "adult_only_service"), model


def test_a_minor_gets_nothing_from_the_router(db):
    for mode in ("auto", "cheap", "fast", "quality"):
        st, word, _ = err(lambda: route(db, U_MINOR, ORG_A, mode))
        assert (st, word) == ("NS400", "adult_only_service"), mode


def test_a_minor_gets_nothing_at_the_job(db):
    before = footprint(db, ORG_A)
    for model in ("img-free", "img-adult"):
        st, word, _ = err(lambda: create(db, U_MINOR, ORG_A, model))
        assert (st, word) == ("NS400", "adult_only_service"), model
    st, word, _ = err(lambda: create(db, U_MINOR, ORG_A, "img-free", mode="cheap", maxc=2))
    assert (st, word) == ("NS400", "adult_only_service")
    assert footprint(db, ORG_A) == before


# ── (e) an adult passes, (f) a model without the flag is unaffected ──────────────────────────────────────────────────────────

def test_an_adult_passes_the_quote_and_the_job(db):
    q = quote(db, U_ADULT, ORG_A, "img-adult")
    assert q["model"] == "img-adult" and float(q["credits"]) > 0
    j = create(db, U_ADULT, ORG_A, "img-adult")["job"]
    assert j["status"] == "queued"
    drain(db)


def test_a_model_without_the_flag_is_unaffected(db):
    assert quote(db, U_NONE, ORG_A, "img-free")["model"] == "img-free"
    assert create(db, U_NONE, ORG_A, "img-free")["job"]["status"] == "queued"
    drain(db)


# ── the router ───────────────────────────────────────────────────────────────────────────────────────────────────────────────

def test_the_route_leaves_the_adult_model_out_for_someone_without_an_attestation(db):
    # img-adult is cheaper and better: an adult is routed to it, someone who never answered to the other model.
    for mode in ("cheap", "quality", "fast", "auto"):
        assert route(db, U_ADULT, ORG_A, mode)["routed_model"] == "img-adult", mode
        r = route(db, U_NONE, ORG_A, mode)
        assert r["routed_model"] == "img-free", (mode, r)
        assert r["route_reason"] == "only_option", "the adult model is not even a candidate"


def test_the_routed_job_and_its_failover_list_never_name_the_adult_model(db):
    out = create(db, U_NONE, ORG_A, "img-free", mode="cheap", maxc=2)["job"]
    cands = db.su("select candidates from public.creative_job_routes where job_id=%s", [out["id"]])[0][0]
    assert [c["model"] for c in cands] == ["img-free"]
    # A routed press that names the adult model (a stale quote, or a hand-made call) is refused: the router picks another.
    st, word, _ = err(lambda: create(db, U_NONE, ORG_A, "img-adult", mode="cheap", maxc=1))
    assert (st, word) == ("NS409", "route_changed")
    drain(db)


def test_the_route_with_nothing_else_left_names_the_remedy(db):
    st, word, _ = err(lambda: route(db, U_NONE, ORG_A, "auto", params=T2V, cap="t2v"))
    assert (st, word) == ("NS400", "adult_attestation_required")
    assert route(db, U_ADULT, ORG_A, "auto", params=T2V, cap="t2v")["routed_model"] == "vid-adult"


# ── the list ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────

def test_the_model_stays_listed_and_marked(db):
    for uid in (U_NONE, U_ADULT, U_MINOR):
        listed = {r[0]: r[1] for r in db.act("authenticated", uid, "select id, spec from public.sellable_models('t2i', 'web')")}
        assert listed["img-adult"]["requires_adult"] is True
        assert listed["img-odd"]["requires_adult"] is True, "an odd flag is shown as what the gate enforces"
        assert "requires_adult" not in listed["img-free"]


def test_a_flag_of_another_shape_fails_closed(db):
    st, word, _ = err(lambda: quote(db, U_NONE, ORG_A, "img-odd"))
    assert (st, word) == ("NS400", "adult_attestation_required")
    assert quote(db, U_ADULT, ORG_A, "img-odd")["model"] == "img-odd"


# ── (b) whose answer it is ───────────────────────────────────────────────────────────────────────────────────────────────────

def test_another_person_cannot_read_my_answer(db):
    seen = db.act("authenticated", U_B, "select user_id::text from public.adult_attestations")
    assert seen == [(U_B,)], "only my own row"
    # A colleague in my organization does not see it either: it is a person's answer, not the organization's.
    seen = db.act("authenticated", U_NONE, "select user_id::text from public.adult_attestations")
    assert seen == []
    assert mine(db, U_B) == {"state": "adult"} and mine(db, U_NONE) == {"state": "none"}


def test_another_person_cannot_write_my_answer(db):
    for role, uid in (("authenticated", U_B), ("authenticated", U_NONE), ("service_role", None)):
        st, _w, _d = err(lambda: db.act(role, uid,
                                         "insert into public.adult_attestations (user_id, adult, terms_version, method) "
                                         "values (%s, true, '2026-11-20', 'create')", [U_NONE]))
        assert st == "42501", (role, st)
    # record_adult_attestation has no "who" argument: it writes for the session only.
    out = record(db, U_B, False)
    assert out == {**out, "state": "adult", "recorded": False}
    assert row(db, U_NONE) == []


def test_anon_gets_nothing(db):
    for q in ("select count(*) from public.adult_attestations",
              "select public.my_adult_attestation()",
              "select public.record_adult_attestation(true, '2026-11-20', 'create')"):
        st, _w, _d = err(lambda: db.act("anon", None, q))
        assert st == "42501", (q, st)
    for fn in ("public.adult_attestation_gate(uuid, text)", "public.adult_attestation_missing(uuid, text)",
               "public.adult_attestation_state(uuid)", "public.model_requires_adult(jsonb)"):
        for role in ("anon", "authenticated", "service_role"):
            assert db.su("select has_function_privilege(%s, %s, 'EXECUTE')", [role, fn])[0][0] is False, (role, fn)


def test_without_a_session_the_calls_say_so(db):
    for q in ("select public.record_adult_attestation(true, '2026-11-20', 'create')", "select public.my_adult_attestation()"):
        st, word, _ = err(lambda: db.act("authenticated", None, q))
        assert (st, word) == ("NS401", "not_signed_in"), q


def test_malformed_input_is_refused_and_writes_nothing(db):
    uid = str(uuid.uuid4())
    db.su("insert into auth.users (id, email) values (%s, 'bad@x.io')", [uid])
    for adult, version, method in ((None, TERMS, "create"), (True, "Adult V1", "create"), (True, "", "create"),
                                   (True, "a" * 41, "create"), (True, None, "create"), (True, TERMS, "sms"),
                                   (True, TERMS, None), (True, TERMS, "Create")):
        st, word, _ = err(lambda: record(db, uid, adult, version, method))
        assert (st, word) == ("NS400", "invalid_params"), (adult, version, method)
    assert row(db, uid) == []


# ── (c) append-only, (d) the first answer stands ─────────────────────────────────────────────────────────────────────────────

def test_the_record_cannot_be_updated_deleted_or_truncated(db):
    for role, uid in (("authenticated", U_MINOR), ("service_role", None)):
        for q in ("update public.adult_attestations set adult = true where user_id=%s",
                  "delete from public.adult_attestations where user_id=%s"):
            st, _w, _d = err(lambda: db.act(role, uid, q, [U_MINOR]))
            assert st == "42501", (role, q, st)
    # Not even the owner of the database: the trigger refuses.
    for q in ("update public.adult_attestations set adult = true where user_id=%s",
              "delete from public.adult_attestations where user_id=%s"):
        st, word, _ = err(lambda: db.su(q, [U_MINOR]))
        assert (st, word) == ("42501", "adult_attestations is append-only")
    st, word, _ = err(lambda: db.su("truncate public.adult_attestations"))
    assert (st, word) == ("42501", "adult_attestations is append-only")
    assert row(db, U_MINOR) == [(False, TERMS, "welcome")]


def test_the_first_answer_stands_a_minor_cannot_become_an_adult(db):
    out = record(db, U_MINOR, True, TERMS, "create")
    assert out["state"] == "minor" and out["recorded"] is False and out["created_at"]
    assert row(db, U_MINOR) == [(False, TERMS, "welcome")]
    assert mine(db, U_MINOR) == {"state": "minor"}


def test_the_first_answer_stands_an_adult_cannot_become_a_minor(db):
    out = record(db, U_ADULT, False, TERMS, "create")
    assert out["state"] == "adult" and out["recorded"] is False
    assert row(db, U_ADULT) == [(True, TERMS, "email_signup")]


def test_a_first_answer_is_recorded_once_and_opens_the_model(db):
    uid = str(uuid.uuid4())
    db.su("insert into auth.users (id, email) values (%s, 'new@x.io')", [uid])
    db.su("insert into public.org_members (org_id, user_id, email, role) values (%s,%s,'new@x.io','editor')", [ORG_A, uid])
    st, word, _ = err(lambda: quote(db, uid, ORG_A, "img-adult"))
    assert word == "adult_attestation_required"
    GOOGLE.add(uid)
    first = record(db, uid, True, TERMS, "google")
    assert first["state"] == "adult" and first["recorded"] is True
    again = record(db, uid, True, TERMS, "google")
    assert again == {**first, "recorded": False}
    assert quote(db, uid, ORG_A, "img-adult")["model"] == "img-adult"


# ── the API's answer ─────────────────────────────────────────────────────────────────────────────────────────────────────────

def test_the_api_names_the_remedy(db):
    out = db.su("select public.api_creative_refusal('NS400', 'adult_attestation_required', 'model=img-adult')")[0][0]
    assert out["status"] == 428 and out["error"]["code"] == "adult_attestation_required"
    assert "Confirm you are 18 or older in the app" in out["error"]["message"]
    assert "Nothing was held or charged" in out["error"]["message"]
    out = db.su("select public.api_creative_refusal('NS400', 'adult_only_service', 'x')")[0][0]
    assert out["status"] == 403 and out["error"]["code"] == "adult_only_service"


# ── a deleted account, replay and rollback ───────────────────────────────────────────────────────────────────────────────────

def test_deleting_the_account_keeps_the_record(db):
    uid = str(uuid.uuid4())
    db.su("insert into auth.users (id, email) values (%s, 'gone@x.io')", [uid])
    record(db, uid, True, TERMS, "email_signup")
    db.su("delete from auth.users where id=%s", [uid])   # not blocked, and nothing cascades
    assert row(db, uid) == [(True, TERMS, "email_signup")]


def _md5(db, sig):
    return db.su("select md5(regexp_replace(prosrc, '\\s+', ' ', 'g')) from pg_proc where oid = %s::regprocedure", [sig])[0][0]


GATED = ("public.quote_creative_job(uuid,text,text,jsonb)", "public.route_model(text,jsonb,text,uuid,text)",
         "public.sellable_models(text,text)", "public.create_creative_job(uuid,text,text,jsonb,text,text,numeric)",
         "public.api_creative_refusal(text,text,text)", "public.creative_platform_reserve(uuid,text,numeric)",
         "public.quote_film(uuid,integer)", "public.start_film(uuid,text,text)",
         "public.api_create_video(text,text,jsonb,text,text,text)")
#: The bodies the rollback puts back (0036's, 0171's, 0187's, 0147's), by GATED index.
EARLIER = {5: "4a61076948e0dd8992d37de2a9016607", 6: "8839e2cb264663acf98c6f49aaaf89a5", 7: "5468183a8f24a48f708efcbbf9d2d22c",
           8: "cba47be1a674f5cea3b5d7443bc31bab"}


def gate_triggers(db):
    return db.su("select tgrelid::regclass::text, tgname from pg_trigger where tgname like 'adult_attestation_%%gate' order by 1")


def test_replay_and_rollback_keep_the_record(db):
    # 0196 sits on three of 0192's bodies and 0198 on two others (quote_film, start_film), and 0192's drift guard refuses them all:
    # both off first, so this compares 0192 alone, and both back on at the end.
    with psycopg.connect(db.dsn, autocommit=True) as c:
        sec_db.take_off_0198(c)
        sec_db.take_off_0196(c)
    before = {s: _md5(db, s) for s in GATED}
    rows = db.su("select count(*) from public.adult_attestations")[0][0]
    db.su(sec_db.MIGRATION_0192.read_text(encoding="utf-8"))
    assert {s: _md5(db, s) for s in GATED} == before
    with psycopg.connect(db.dsn, autocommit=True) as c:
        sec_db.take_off_0192(c)
    try:
        assert _md5(db, GATED[0]) == "8494b320cece395444edec700a2f1696", "0036's quote is back"
        assert _md5(db, GATED[3]) == "88107b00b0a8c143606ed17f5898c98d", "0174's job start is back"
        assert db.su("select count(*) from public.adult_attestations")[0][0] == rows
        assert db.su("select to_regprocedure('public.record_adult_attestation(boolean, text, text)')")[0][0] is None
        for i, h in EARLIER.items():
            assert _md5(db, GATED[i]) == h, GATED[i]
        assert gate_triggers(db) == [], "the hold gate goes with the rollback"
    finally:
        with psycopg.connect(db.dsn, autocommit=True) as c:
            sec_db.put_back_0192(c)   # puts 0196 and 0198 back too
            sec_db.take_off_0198(c)
            sec_db.take_off_0196(c)
    # 0192 alone is exactly what it was before the round trip.
    assert {s: _md5(db, s) for s in GATED} == before
    with psycopg.connect(db.dsn, autocommit=True) as c:
        sec_db.put_back_0196(c)
        sec_db.put_back_0198(c)
    # Both layers are back on top of 0192: 0198's quote and start ask the organization's switch too, and every other gated body is
    # 0192's or 0196's own (0196 replaces route_model and api_create_video).
    film = ("public.quote_film(uuid,integer)", "public.start_film(uuid,text,text)")
    # put_back_0198 puts 0215 back on it too: its start_film (a replay answers without the worker's id) is the live one.
    assert [_md5(db, s) for s in film] == ["99d01240ed2df7fb002f674df8891608",
                                           ("73ee48d683feae07fbb76039b35e0990" if sec_db.MIGRATION_0215.exists()
                                            else "7971355d754165affaf3e08904b4b078")]
    assert sec_db.has_0196(psycopg.connect(db.dsn, autocommit=True)) and sec_db.has_0198(psycopg.connect(db.dsn, autocommit=True))
    assert gate_triggers(db) == [("credit_reservations", "adult_attestation_hold_gate"),
                                 ("download_requests", "adult_attestation_download_gate"),
                                 ("render_jobs", "adult_attestation_run_gate")]
    # The kept rows count again at once.
    assert mine(db, U_MINOR) == {"state": "minor"}


def test_0174_and_0125_refuse_to_replay_over_0192(db):
    """0192 is protected from the two files under it that pin their bodies: re-running either would be refused, not silently
    undo the gate (0036 and 0075 do not protect it: the header says undo 0192 first)."""
    st, msg, _ = err(lambda: db.su(sec_db.MIGRATION_0174.read_text(encoding="utf-8")))
    assert "0174 found public.create_creative_job" in msg
    st, msg, _ = err(lambda: db.su(sec_db.MIGRATION_0125.read_text(encoding="utf-8")))
    assert "0125 found a sellable_models()" in msg
    # The Film Studio's money pins its bodies too: it does not replay over the film gate.
    st, msg, _ = err(lambda: db.su(sec_db.MIGRATION_0171.read_text(encoding="utf-8")))
    # 0198 replaces 0171 bodies too (film_fail_locked comes first in 0171's own list), so the refusal may name one of those.
    assert msg.startswith("0171 found public.") and "with a body that is not this file's" in msg, msg


# ── F4: the session, not the caller, decides the method; only the current words are recorded ─────────────────────────────────

def test_an_old_or_invented_terms_version_is_refused_with_the_remedy(db):
    uid = str(uuid.uuid4())
    db.su("insert into auth.users (id, email) values (%s, 'old@x.io')", [uid])
    for version in ("adult.v1", "v0", "2026-11-19", "2099-01-01"):
        st, word, detail = err(lambda: record(db, uid, True, version, "welcome"))
        assert (st, word) == ("NS400", "invalid_params") and "reload the app" in detail, (version, detail)
    assert row(db, uid) == []


def test_google_is_recorded_only_for_a_google_session_and_always_for_one(db):
    email, goog = str(uuid.uuid4()), str(uuid.uuid4())
    db.su("insert into auth.users (id, email) values (%s, 'em@x.io'), (%s, 'go@x.io')", [email, goog])
    st, word, detail = err(lambda: record(db, email, True, TERMS, "google"))
    assert (st, word) == ("NS400", "invalid_params") and "signed in with Google" in detail
    assert row(db, email) == []
    assert record(db, email, True, TERMS, "welcome")["recorded"] is True
    assert row(db, email) == [(True, TERMS, "welcome")]
    GOOGLE.add(goog)
    # A Google sign-in is recorded as google whichever page asked (the route sends google, a direct call may not).
    assert record(db, goog, False, TERMS, "create")["recorded"] is True
    assert row(db, goog) == [(False, TERMS, "google")]


# ── F3: the hold gate and the creative helper refuse a minor; settling a hold that exists never is ────────────────────────────

def _minor_admin(db, org):
    uid = str(uuid.uuid4())
    db.su("insert into auth.users (id, email) values (%s, %s)", [uid, f"{uid[:6]}@minor.io"])
    db.su("insert into public.org_members (org_id, user_id, email, role) values (%s, %s, %s, 'admin')", [org, uid, f"{uid[:6]}@minor.io"])
    return uid


def test_a_minor_takes_no_hold_through_reserve_credits(db):
    uid = _minor_admin(db, ORG_A)
    record(db, uid, False)
    before = footprint(db, ORG_A)
    st, word, _ = err(lambda: db.act("authenticated", uid, "select public.reserve_credits(%s, 'rj-minor-direct', 5)", [ORG_A]))
    assert (st, word) == ("NS400", "adult_only_service")
    assert footprint(db, ORG_A) == before


def test_a_minor_takes_no_hold_through_the_creative_helper_though_it_clears_the_session(db):
    uid = _minor_admin(db, ORG_A)
    record(db, uid, False)
    before = footprint(db, ORG_A)
    with psycopg.connect(db.dsn, autocommit=False) as c:
        c.execute("select set_config('request.jwt.claims', %s, true)", [claims("authenticated", uid)])
        with pytest.raises(psycopg.Error) as e:
            c.execute("select public.creative_platform_reserve(%s, 'cj:minor-helper', 5)", [ORG_A])
        assert e.value.sqlstate == "NS400" and str(e.value).startswith("adult_only_service")
        c.rollback()
    assert footprint(db, ORG_A) == before
    # An adult's session, and a worker's (no session), still hold through it.
    for who in (U_ADULT, None):
        with psycopg.connect(db.dsn, autocommit=False) as c:
            c.execute("select set_config('request.jwt.claims', %s, true)", [claims("authenticated", who) if who else ""])
            out = c.execute("select public.creative_platform_reserve(%s, %s, 5)", [ORG_A, f"cj:ok-{uuid.uuid4().hex[:8]}"]).fetchone()[0]
            assert out["reserved"] == 5, (who, out)
            c.rollback()


def test_a_hold_taken_before_the_answer_still_settles_after_it(db):
    """The worker capturing or releasing an existing hold must never be blocked: a person who held while unanswered and then said
    they are under 18 is refused new work, not the settlement of the old."""
    svc = lambda q, p=None: db.act("service_role", None, q, p)
    for settle in ("capture", "release"):
        # One organization each: a hold is one of the plan's parallel runs, and the lab's plan allows one.
        org = str(uuid.uuid4())
        db.su("insert into public.organizations (id, name, slug) values (%s, %s, %s)", [org, settle, f"org-settle-{settle}"])
        db.su("select public.grant_credits(%s, 100, 'test')", [org])
        uid = _minor_admin(db, org)
        ref = f"rj-before-answer-{settle}"
        assert db.act("authenticated", uid, "select public.reserve_credits(%s, %s, 5)", [org, ref])[0][0]["reserved"] == 5
        record(db, uid, False)
        if settle == "capture":
            svc("select public.start_credit_reservation(%s, %s)", [ref, org])
            svc("select public.capture_credits(%s, 3)", [ref])
        else:
            svc("select public.release_credits(%s)", [ref])
        want = "captured" if settle == "capture" else "released"
        assert db.su("select status from public.credit_reservations where job_id = %s", [ref])[0][0] == want, settle
        # ... and the minor still takes no new one there.
        st, word, _ = err(lambda: db.act("authenticated", uid, "select public.reserve_credits(%s, 'rj-after-answer', 5)", [org]))
        assert word == "adult_only_service", settle

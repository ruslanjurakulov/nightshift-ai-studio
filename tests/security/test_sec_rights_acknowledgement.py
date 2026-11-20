"""Rights acknowledgement (0174), attacked in a real database.

A model whose provider (or the law) makes the person confirm their rights to an input — Runway's photo consent, a voice clone,
copyrighted material — names the kinds it requires (model_registry.requires_acknowledgement, spec.requires_acknowledgement).
create_creative_job then refuses a job (NS400 acknowledgement_required) unless THIS person acknowledged THIS input, in THIS
organization, at the CURRENT text version, and it refuses before anything is priced or held. The browser never decides.

What would break, and which test says so:
  * a job of a requiring model starts without an acknowledgement          test_no_acknowledgement_no_job
  * an acknowledgement does not open the job                              test_an_acknowledgement_opens_exactly_that_input
  * a colleague's acknowledgement stands in for mine                      test_another_persons_acknowledgement_does_not_count
  * another organization reads, writes or uses an acknowledgement         test_another_org_*
  * words the person never read count                                    test_an_old_text_version_does_not_count
  * the refusal comes after a hold (or after the price / balance check)   test_the_refusal_comes_before_any_hold
  * a double press writes two rows, or a replayed job is refused          test_replay_*
  * the record can be edited or erased                                    test_the_record_cannot_be_updated_deleted_or_truncated
  * the file's list or the column's list alone is ignored                 test_either_list_requires_it
  * Runway's entries do not require likeness_photo                        test_runway_requires_likeness_photo_and_stays_unsold

Runs in its own scratch database (it commits), with models installed through sync_model_registry and a real probe row, as
production does.
"""
import json
import os
import uuid

import psycopg
import pytest

import sec_db

ORG_A = "aaaaaaaa-0000-0000-0000-0000000001a4"
ORG_B = "bbbbbbbb-0000-0000-0000-0000000001b4"
UA = str(uuid.UUID(int=0x1A4))     # Alice, org A
UA2 = str(uuid.UUID(int=0x1A5))    # Anna, Alice's colleague in org A
UB = str(uuid.UUID(int=0x1B4))     # Bob, org B
V1 = "likeness_photo.v1"

# (id, capabilities, extra spec, requires_acknowledgement column, credit unit, credits per unit)
MODELS = [
    # Requires likeness_photo in the registry file's list (spec) only.
    ("vid-ack", ["t2v", "i2v"], {"requires_acknowledgement": ["likeness_photo"], "end_frame": True}, None, "model_vid_ack_second", 2),
    # Requires it in the database column only.
    ("vid-col", ["i2v"], {}, ["likeness_photo"], "model_vid_col_second", 2),
    # Requires nothing: the control.
    ("vid-free", ["i2v"], {}, None, "model_vid_free_second", 2),
    # A picture model that requires nothing: a workflow's first step.
    ("img-free", ["t2i"], {}, None, "model_img_free_image", 1),
]
PRICES = ", ".join(f"('{u}', {c}, 0)" for _m, _c, _s, _col, u, c in MODELS) + ", ('job_minimum', 1, 0)"


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


def asset(d, org, kind="image", mime="image/png"):
    aid = str(uuid.uuid4())
    d.act("service_role", None,
          "select public.register_asset(%s, %s, %s, %s, 1000, %s, 'generated', p_width => 64, p_height => 64, "
          "p_provenance => '{\"job_id\": \"seed\"}'::jsonb)",
          [aid, org, kind, mime, uuid.uuid4().hex * 2])
    return aid


@pytest.fixture(scope="module")
def db():
    admin = sec_db.admin_dsn()
    if not admin:
        if os.environ.get("NIGHTSHIFT_SECURITY_REQUIRED"):
            pytest.fail(f"{sec_db.DSN_ENV} is not set", pytrace=False)
        pytest.skip(f"{sec_db.DSN_ENV} is not set — the security lab needs a scratch Postgres")
    name = f"ns_rights_ack_{uuid.uuid4().hex[:8]}"
    d = Db(sec_db.build(admin, name))
    d.su("insert into auth.users (id, email) values (%s,'a@x.io'),(%s,'a2@x.io'),(%s,'b@x.io')", [UA, UA2, UB])
    d.su("insert into public.organizations (id, name, slug) values (%s,'A','org-ack-a'),(%s,'B','org-ack-b')", [ORG_A, ORG_B])
    d.su("insert into public.org_members (org_id, user_id, email, role) values "
         "(%s,%s,'a@x.io','owner'),(%s,%s,'a2@x.io','editor'),(%s,%s,'b@x.io','owner')", [ORG_A, UA, ORG_A, UA2, ORG_B, UB])
    d.su("select public.grant_credits(%s, 100, 'test')", [ORG_A])
    d.su("select public.grant_credits(%s, 100, 'test')", [ORG_B])
    def kind(m):
        return "image" if m.startswith("img-") else "video"

    rows = [{"id": m, "display_name": m, "provider": "acme", "adapter": f"{kind(m)}.acme", "capabilities": caps,
             "credit_unit": unit, "entitlement": "any",
             "spec": {"vendor_model": "acme-" + m, "output": kind(m), "durations_s": list(range(1, 61)), **extra}}
            for m, caps, extra, _col, unit, _c in MODELS]
    d.su("select public.sync_model_registry(%s::jsonb)", [json.dumps(rows)])
    # sync_model_registry disables every model it is NOT given (0035): every later sync here sends the whole set (sync_all).
    d.rows = {r["id"]: r for r in rows}
    for m, caps, _x, col, _u, _c in MODELS:
        d.su("select public.record_model_probe(%s, %s, %s, %s, true, null, null, 10, 100, 'security-lab')",
             [m, f"{kind(m)}.acme", "acme-" + m, caps[-1]])
        d.su("update public.model_registry set availability='beta' where id=%s", [m])
        if col:
            d.su("update public.model_registry set requires_acknowledgement=%s where id=%s", [col, m])
    d.su(f"insert into public.credit_prices (unit, credits_per_unit, margin) values {PRICES} "
         "on conflict (unit) do update set credits_per_unit = excluded.credits_per_unit, margin = 0")
    try:
        yield d
    finally:
        if not os.environ.get("NIGHTSHIFT_SECURITY_KEEP"):
            sec_db.drop_database(admin, name)


def sync_all(db, **changed):
    """One sync of every model this module installed, with `changed` rows replaced or added (a partial sync would disable the rest)."""
    db.rows.update(changed)
    db.su("select public.sync_model_registry(%s::jsonb)", [json.dumps(list(db.rows.values()))])


def err(fn):
    with pytest.raises(psycopg.Error) as e:
        fn()
    return e.value.sqlstate, str(e.value).splitlines()[0], (e.value.diag.message_detail or "")


def ack(db, uid, subject, kind="likeness_photo", version=V1, locale="en"):
    return db.act("authenticated", uid, "select public.acknowledge_rights(%s, %s, %s, %s)", [kind, version, subject, locale])[0][0]


def create(db, uid, org, model, params, maxc=1000, idem=None, cap="i2v"):
    return db.act("authenticated", uid, "select public.create_creative_job(%s,%s,%s,%s::jsonb,'exact',%s,%s)",
                  [org, cap, model, json.dumps(params), idem, maxc])[0][0]


def status(db, uid, org, model, subjects):
    return db.act("authenticated", uid, "select public.rights_acknowledgement_status(%s,%s,%s::text[])",
                  [org, model, subjects])[0][0]


def footprint(db, org):
    """Everything a job start could leave behind: job rows, holds, the account, the ledger."""
    return (db.su("select count(*) from public.creative_jobs where org_id=%s", [org])[0][0],
            db.su("select count(*), coalesce(sum(amount),0)::float from public.credit_reservations where org_id=%s", [org])[0],
            # A new organization has no account row until something reserves or grants (None = none, and none was made).
            (db.su("select balance::float, reserved::float from public.credit_accounts where org_id=%s", [org]) or [None])[0],
            db.su("select count(*) from public.credit_transactions where org_id=%s", [org])[0][0])


def rows_for(db, subject):
    return db.su("select org_id::text, user_id::text, kind, text_version from public.rights_acknowledgements "
                 "where subject_asset_id=%s order by id", [subject])


def drain(db):
    def svc(q, p=None):
        return db.act("service_role", None, q, p)
    while svc("select id from public.claim_creative_job('drain')"):
        pass
    for (jid,) in db.su("select id::text from public.creative_jobs where worker_id='drain'"):
        svc("select public.finish_creative_job(%s,'drain',false,null,null,'test_drain','drained')", [jid])


I2V = {"duration_s": 4}


# ── the refusal ─────────────────────────────────────────────────────────────

def test_no_acknowledgement_no_job(db):
    pic = asset(db, ORG_A)
    before = footprint(db, ORG_A)
    st, word, detail = err(lambda: create(db, UA, ORG_A, "vid-ack", {**I2V, "source_asset_id": pic}))
    assert (st, word) == ("NS400", "acknowledgement_required"), (st, word)
    assert detail == f"kind=likeness_photo version={V1} subject={pic}"
    assert footprint(db, ORG_A) == before
    # A model that requires nothing is not asked (the control: the refusal is the requirement's, not the input's).
    j = create(db, UA, ORG_A, "vid-free", {**I2V, "source_asset_id": pic})["job"]
    assert j["status"] == "queued"
    drain(db)


def test_a_model_that_requires_it_is_not_asked_without_an_input(db):
    # The kind is about an input: text to video carries none, so there is nothing to acknowledge.
    j = create(db, UA, ORG_A, "vid-ack", {**I2V, "prompt": "a lighthouse at dusk"}, cap="t2v")["job"]
    assert j["status"] == "queued"
    drain(db)


def test_an_acknowledgement_opens_exactly_that_input(db):
    pic, other = asset(db, ORG_A), asset(db, ORG_A)
    out = ack(db, UA, pic)
    assert out["replay"] is False and out["acknowledgement"]["kind"] == "likeness_photo"
    assert out["acknowledgement"]["text_version"] == V1 and out["acknowledgement"]["subject"] == pic
    j = create(db, UA, ORG_A, "vid-ack", {**I2V, "source_asset_id": pic})["job"]
    assert j["status"] == "queued"
    # Never remembered across subjects: another picture is asked again.
    st, word, detail = err(lambda: create(db, UA, ORG_A, "vid-ack", {**I2V, "source_asset_id": other}))
    assert (st, word) == ("NS400", "acknowledgement_required") and detail.endswith(f"subject={other}")
    drain(db)


def test_the_end_frame_is_an_input_too(db):
    first, last = asset(db, ORG_A), asset(db, ORG_A)
    ack(db, UA, first)
    st, word, detail = err(lambda: create(db, UA, ORG_A, "vid-ack", {**I2V, "source_asset_id": first, "end_asset_id": last}))
    assert (st, word) == ("NS400", "acknowledgement_required") and detail.endswith(f"subject={last}")
    ack(db, UA, last)
    assert create(db, UA, ORG_A, "vid-ack", {**I2V, "source_asset_id": first, "end_asset_id": last})["job"]["status"] == "queued"
    drain(db)


def test_another_persons_acknowledgement_does_not_count(db):
    pic = asset(db, ORG_A)
    ack(db, UA2, pic)  # Anna took responsibility, Alice did not.
    st, word, _ = err(lambda: create(db, UA, ORG_A, "vid-ack", {**I2V, "source_asset_id": pic}))
    assert (st, word) == ("NS400", "acknowledgement_required")
    assert [r[1] for r in rows_for(db, pic)] == [UA2]
    # Anna's own job goes.
    assert create(db, UA2, ORG_A, "vid-ack", {**I2V, "source_asset_id": pic})["job"]["status"] == "queued"
    drain(db)


def test_the_acknowledgement_records_who_from_the_session_not_from_the_caller(db):
    pic = asset(db, ORG_A)
    ack(db, UA2, pic)
    assert rows_for(db, pic) == [(ORG_A, UA2, "likeness_photo", V1)]
    sha = db.su("select sha256 from public.media_assets where id=%s", [pic])[0][0]
    assert db.su("select subject_sha256 from public.rights_acknowledgements where subject_asset_id=%s", [pic])[0][0] == sha


# ── another organization ────────────────────────────────────────────────────

def test_another_org_cannot_acknowledge_my_file(db):
    pic = asset(db, ORG_A)
    st, word, detail = err(lambda: ack(db, UB, pic))
    st2, word2, detail2 = err(lambda: ack(db, UB, str(uuid.uuid4())))
    # Exactly the answer for an id that does not exist: nothing is confirmed.
    assert (st, word, detail) == (st2, word2, detail2) == ("NS400", "source_unavailable", detail)
    assert rows_for(db, pic) == []


def test_another_org_cannot_read_my_acknowledgements(db):
    pic = asset(db, ORG_A)
    ack(db, UA, pic)
    mine = db.act("authenticated", UA, "select count(*) from public.rights_acknowledgements where subject_asset_id=%s", [pic])[0][0]
    theirs = db.act("authenticated", UB, "select count(*) from public.rights_acknowledgements where subject_asset_id=%s", [pic])[0][0]
    assert (mine, theirs) == (1, 0)
    # Nor ask the status of my organization.
    st, _w, _d = err(lambda: status(db, UB, ORG_A, "vid-ack", [pic]))
    assert st == "42501"


@pytest.mark.parametrize("role,uid", [("authenticated", UB), ("authenticated", UA), ("service_role", None), ("anon", None)])
def test_another_org_or_any_role_cannot_insert_directly(db, role, uid):
    pic = asset(db, ORG_A)
    st, _w, _d = err(lambda: db.act(role, uid,
        "insert into public.rights_acknowledgements (org_id, user_id, kind, text_version, subject_asset_id, subject_sha256) "
        "values (%s, %s, 'likeness_photo', %s, %s, %s)", [ORG_A, UA, V1, pic, "0" * 64]))
    assert st == "42501", (role, st)
    assert rows_for(db, pic) == []


def test_another_orgs_acknowledgement_does_not_open_a_job_in_mine(db):
    # Bob acknowledges his own picture. Alice cannot use it: it is not her organization's, and the price (which comes first,
    # so a model refused anyway never asks) says so exactly as for a missing file.
    pic_b = asset(db, ORG_B)
    ack(db, UB, pic_b)
    st, word, _ = err(lambda: create(db, UA, ORG_A, "vid-ack", {**I2V, "source_asset_id": pic_b}))
    assert (st, word) == ("NS400", "source_unavailable")


# ── the text version ────────────────────────────────────────────────────────

def test_an_old_text_version_does_not_count(db):
    pic = asset(db, ORG_A)
    ack(db, UA, pic)
    assert create(db, UA, ORG_A, "vid-ack", {**I2V, "source_asset_id": pic})["job"]["status"] == "queued"
    drain(db)
    db.su("update public.rights_acknowledgement_kinds set text_version='likeness_photo.v2' where kind='likeness_photo'")
    try:
        st, word, detail = err(lambda: create(db, UA, ORG_A, "vid-ack", {**I2V, "source_asset_id": pic}))
        assert (st, word) == ("NS400", "acknowledgement_required")
        assert detail == f"kind=likeness_photo version=likeness_photo.v2 subject={pic}"
        # The old words cannot be acknowledged any more: the app must show the new ones.
        st, word, detail = err(lambda: ack(db, UA, pic, version=V1))
        assert (st, word, detail) == ("NS409", "acknowledgement_version_changed", "current=likeness_photo.v2")
        ack(db, UA, pic, version="likeness_photo.v2")
        assert create(db, UA, ORG_A, "vid-ack", {**I2V, "source_asset_id": pic})["job"]["status"] == "queued"
        # Both rows stay: the record of what was read when.
        assert [r[3] for r in rows_for(db, pic)] == [V1, "likeness_photo.v2"]
    finally:
        db.su("update public.rights_acknowledgement_kinds set text_version=%s where kind='likeness_photo'", [V1])
        drain(db)


def test_an_unknown_kind_or_version_is_refused(db):
    pic = asset(db, ORG_A)
    assert err(lambda: ack(db, UA, pic, kind="face_swap"))[:2] == ("NS400", "invalid_params")
    assert err(lambda: ack(db, UA, pic, version="likeness_photo.v0"))[:2] == ("NS409", "acknowledgement_version_changed")
    assert err(lambda: ack(db, UA, pic, version=None))[:2] == ("NS409", "acknowledgement_version_changed")
    assert err(lambda: ack(db, UA, "not-a-uuid"))[:2] == ("NS400", "source_unavailable")
    assert err(lambda: ack(db, UA, pic, locale="de"))[:2] == ("NS400", "invalid_params")
    assert err(lambda: ack(db, UA, pic, locale=None))[:2] == ("NS400", "invalid_params")
    assert rows_for(db, pic) == []


# ── before any hold ─────────────────────────────────────────────────────────

def test_the_refusal_comes_before_any_hold(db):
    pic = asset(db, ORG_A)
    before = footprint(db, ORG_A)
    # A confirmed price of 0 would be price_changed: the acknowledgement is asked right after the price, before its ceiling.
    st, word, _ = err(lambda: create(db, UA, ORG_A, "vid-ack", {**I2V, "source_asset_id": pic}, maxc=0))
    assert (st, word) == ("NS400", "acknowledgement_required")
    # An organization with no credits at all would be NS402: the acknowledgement is still asked first, and nothing moves.
    broke = "cccccccc-0000-0000-0000-0000000001c4"
    db.su("insert into public.organizations (id, name, slug) values (%s,'C','org-ack-c') on conflict do nothing", [broke])
    db.su("insert into public.org_members (org_id, user_id, email, role) values (%s,%s,'a@x.io','owner') on conflict do nothing",
          [broke, UA])
    pic_c = asset(db, broke)
    before_c = footprint(db, broke)
    st, word, _ = err(lambda: create(db, UA, broke, "vid-ack", {**I2V, "source_asset_id": pic_c}))
    assert (st, word) == ("NS400", "acknowledgement_required")
    ack(db, UA, pic_c)
    st, _w, _d = err(lambda: create(db, UA, broke, "vid-ack", {**I2V, "source_asset_id": pic_c}))
    assert st == "NS402", "with the acknowledgement, the balance is what refuses"
    assert footprint(db, broke) == before_c
    assert footprint(db, ORG_A) == before


# ── replay ──────────────────────────────────────────────────────────────────

def test_replay_of_an_acknowledgement_is_one_row(db):
    pic = asset(db, ORG_A)
    first = ack(db, UA, pic)
    again = ack(db, UA, pic)
    assert (first["replay"], again["replay"]) == (False, True)
    assert again["acknowledgement"] == first["acknowledgement"]
    assert len(rows_for(db, pic)) == 1


def test_replay_of_a_job_already_started_is_answered_even_after_the_words_change(db):
    pic = asset(db, ORG_A)
    ack(db, UA, pic)
    first = create(db, UA, ORG_A, "vid-ack", {**I2V, "source_asset_id": pic}, idem="ack-replay-1")
    db.su("update public.rights_acknowledgement_kinds set text_version='likeness_photo.v2' where kind='likeness_photo'")
    try:
        again = create(db, UA, ORG_A, "vid-ack", {**I2V, "source_asset_id": pic}, idem="ack-replay-1")
        assert again["replay"] is True and again["job"]["id"] == first["job"]["id"]
        # A new press is a new job, and it is asked again.
        st, word, _ = err(lambda: create(db, UA, ORG_A, "vid-ack", {**I2V, "source_asset_id": pic}, idem="ack-replay-2"))
        assert (st, word) == ("NS400", "acknowledgement_required")
    finally:
        db.su("update public.rights_acknowledgement_kinds set text_version=%s where kind='likeness_photo'", [V1])
        drain(db)


# ── append-only ─────────────────────────────────────────────────────────────

def test_the_record_cannot_be_updated_deleted_or_truncated(db):
    pic = asset(db, ORG_A)
    ack(db, UA, pic)
    for role, uid in (("authenticated", UA), ("service_role", None)):
        for q in ("update public.rights_acknowledgements set text_version='likeness_photo.v9' where subject_asset_id=%s",
                  "delete from public.rights_acknowledgements where subject_asset_id=%s"):
            st, _w, _d = err(lambda: db.act(role, uid, q, [pic]))
            assert st == "42501", (role, q, st)
    # Not even the owner of the database: the trigger refuses.
    st, word, _ = err(lambda: db.su("update public.rights_acknowledgements set user_id=%s where subject_asset_id=%s", [UB, pic]))
    assert (st, word) == ("42501", "rights_acknowledgements is append-only")
    st, word, _ = err(lambda: db.su("delete from public.rights_acknowledgements where subject_asset_id=%s", [pic]))
    assert (st, word) == ("42501", "rights_acknowledgements is append-only")
    st, word, _ = err(lambda: db.su("truncate public.rights_acknowledgements"))
    assert (st, word) == ("42501", "rights_acknowledgements is append-only")
    assert rows_for(db, pic) == [(ORG_A, UA, "likeness_photo", V1)]


def test_nobody_but_a_migration_changes_the_kinds(db):
    for role, uid in (("authenticated", UA), ("service_role", None)):
        st, _w, _d = err(lambda: db.act(role, uid, "update public.rights_acknowledgement_kinds set text_version='likeness_photo.v9'"))
        assert st == "42501"
    assert db.act("authenticated", UB, "select count(*) from public.rights_acknowledgement_kinds")[0][0] == 3


# ── which models require it ─────────────────────────────────────────────────

def test_either_list_requires_it(db):
    for model in ("vid-ack", "vid-col"):
        drain(db)  # the plan runs one job at a time
        pic = asset(db, ORG_A)
        st, word, _ = err(lambda: create(db, UA, ORG_A, model, {**I2V, "source_asset_id": pic}))
        assert (st, word) == ("NS400", "acknowledgement_required"), model
        s = status(db, UA, ORG_A, model, [pic])
        assert s == {"required": [{"kind": "likeness_photo", "text_version": V1}],
                     "missing": [{"kind": "likeness_photo", "text_version": V1, "subject": pic}]}
        ack(db, UA, pic)
        assert status(db, UA, ORG_A, model, [pic])["missing"] == []
        assert create(db, UA, ORG_A, model, {**I2V, "source_asset_id": pic})["job"]["status"] == "queued"
    assert status(db, UA, ORG_A, "vid-free", [str(uuid.uuid4())]) == {"required": [], "missing": []}
    drain(db)


def test_a_kind_outside_the_list_fails_closed(db):
    # A typo in the file (synced into spec) can never be acknowledged: the model refuses every input instead of asking nothing.
    db.su("update public.model_registry set spec = spec || '{\"requires_acknowledgement\": [\"likeness_foto\"]}' where id='vid-free'")
    try:
        pic = asset(db, ORG_A)
        st, word, detail = err(lambda: create(db, UA, ORG_A, "vid-free", {**I2V, "source_asset_id": pic}))
        assert (st, word) == ("NS400", "acknowledgement_required") and "kind=likeness_foto version=none" in detail
    finally:
        db.su("update public.model_registry set spec = spec - 'requires_acknowledgement' where id='vid-free'")


def test_the_column_refuses_an_unknown_kind(db):
    st, _w, _d = err(lambda: db.su("update public.model_registry set requires_acknowledgement='{face_swap}' where id='vid-free'"))
    assert st == "23514"


def test_runway_requires_likeness_photo_and_stays_unsold(db):
    # The real registry file's two Runway entries, synced as production syncs them.
    reg = json.loads((sec_db.REPO / "schemas" / "model_registry.json").read_text(encoding="utf-8"))
    for mid in ("runway-gen4.5", "runway-gen4-turbo"):
        m = next(e for e in reg["models"] if e["id"] == mid)
        assert m["requires_acknowledgement"] == ["likeness_photo"]
        row = {"id": mid, "display_name": m["display_name"], "provider": m["provider"], "adapter": m["adapter"],
               "capabilities": m["capabilities"], "credit_unit": m["credit_unit"], "entitlement": m["entitlement"],
               "spec": {k: v for k, v in m.items() if k not in ("id", "display_name", "provider", "adapter", "capabilities",
                                                               "credit_unit", "entitlement")}}
        sync_all(db, **{mid: row})
        assert db.su("select public.rights_acknowledgement_required(%s)", [mid])[0][0] == ["likeness_photo"]
        assert db.su("select availability from public.model_registry where id=%s", [mid])[0][0] == "hidden"


# ── the language read (M4) ──────────────────────────────────────────────────

def test_the_record_keeps_the_language_the_words_were_read_in(db):
    pic = asset(db, ORG_A)
    out = ack(db, UA, pic, locale="uz")
    assert out["acknowledgement"]["locale"] == "uz"
    assert db.su("select locale from public.rights_acknowledgements where subject_asset_id=%s", [pic]) == [("uz",)]
    # A replay in another language answers the first row: the words were already read once.
    again = ack(db, UA, pic, locale="ru")
    assert again["replay"] is True and again["acknowledgement"]["locale"] == "uz"


# ── the hourly cap (M3) ─────────────────────────────────────────────────────

def test_a_person_cannot_flood_the_undeletable_record(db):
    who = str(uuid.UUID(int=0x1A9))
    db.su("insert into auth.users (id, email) values (%s, 'flood@x.io') on conflict do nothing", [who])
    db.su("insert into public.org_members (org_id, user_id, email, role) values (%s, %s, 'flood@x.io', 'editor') "
          "on conflict do nothing", [ORG_A, who])
    pics = [asset(db, ORG_A) for _ in range(61)]
    for p in pics[:60]:
        assert ack(db, who, p)["replay"] is False
    st, word, detail = err(lambda: ack(db, who, pics[60]))
    assert (st, word, detail) == ("NS429", "acknowledgement_limit", "limit=60 window=1h")
    assert rows_for(db, pics[60]) == []
    # A replay is not a new row and is still answered.
    assert ack(db, who, pics[0])["replay"] is True
    # Another person is not held by this one's count.
    assert ack(db, UA, pics[60])["replay"] is False


# ── the requirement only grows (M2) ─────────────────────────────────────────

def test_the_service_key_cannot_remove_a_requirement(db):
    st, word, _ = err(lambda: db.act("service_role", None,
                                     "update public.model_registry set requires_acknowledgement='{}' where id='vid-col'"))
    assert (st, word) == ("42501", "requires_acknowledgement only grows")
    assert db.su("select requires_acknowledgement from public.model_registry where id='vid-col'")[0][0] == ["likeness_photo"]
    # Adding is allowed to the service key (it only narrows what is sold).
    db.act("service_role", None, "update public.model_registry set requires_acknowledgement='{likeness_photo,third_party_content}' "
                                 "where id='vid-col'")
    assert db.su("select requires_acknowledgement from public.model_registry where id='vid-col'")[0][0] == ["likeness_photo", "third_party_content"]
    # The table's owner (a migration) may remove it.
    db.su("update public.model_registry set requires_acknowledgement='{likeness_photo}' where id='vid-col'")


def test_a_sync_that_drops_the_spec_list_keeps_the_column(db):
    assert db.su("select requires_acknowledgement from public.model_registry where id='vid-ack'")[0][0] == ["likeness_photo"]
    row = dict(db.rows["vid-ack"])
    row["spec"] = {k: v for k, v in row["spec"].items() if k != "requires_acknowledgement"}
    db.rows["vid-ack"] = row
    db.act("service_role", None, "select public.sync_model_registry(%s::jsonb)", [json.dumps(list(db.rows.values()))])
    assert db.su("select spec ? 'requires_acknowledgement', requires_acknowledgement from public.model_registry where id='vid-ack'")[0] \
        == (False, ["likeness_photo"])
    pic = asset(db, ORG_A)
    st, word, _ = err(lambda: create(db, UA, ORG_A, "vid-ack", {**I2V, "source_asset_id": pic}))
    assert (st, word) == ("NS400", "acknowledgement_required")


def test_a_spec_of_the_wrong_shape_fails_closed(db):
    # L3: a number, an object or a boolean is not "nothing required": it is a kind nobody can acknowledge.
    for bad in ("7", '{"kind": "likeness_photo"}', "true", '[3]'):
        db.su("update public.model_registry set spec = jsonb_set(spec, '{requires_acknowledgement}', %s::jsonb) where id='vid-free'", [bad])
        try:
            assert "invalid_requires_acknowledgement" in db.su("select public.rights_acknowledgement_required('vid-free')")[0][0], bad
            pic = asset(db, ORG_A)
            st, word, _ = err(lambda: create(db, UA, ORG_A, "vid-free", {**I2V, "source_asset_id": pic}))
            assert (st, word) == ("NS400", "acknowledgement_required"), bad
        finally:
            db.su("update public.model_registry set spec = spec - 'requires_acknowledgement' where id='vid-free'")
    assert db.su("select public.rights_acknowledgement_required('vid-free')")[0][0] == []


# ── workflows (M5) ──────────────────────────────────────────────────────────

def _workflow(db, model, steps=None):
    # A workflow has 2 to 6 steps (0073): a free picture first, then the step under test.
    steps = steps or [{"capability": "t2i", "model": "img-free", "params": {"prompt": "a lighthouse"}},
                      {"capability": "i2v", "model": model, "params": {"source_asset_id": {"$input": "pic"}, "duration_s": 4}}]
    return db.act("authenticated", UA, "select public.save_workflow(%s::uuid, null, %s, %s::jsonb, %s::jsonb)",
                  [ORG_A, f"wf-{model}-{uuid.uuid4().hex[:6]}", json.dumps([{"name": "pic", "kind": "asset"}]), json.dumps(steps)])[0][0]


def test_a_workflow_step_that_needs_an_acknowledgement_is_refused_before_any_hold(db):
    drain(db)
    pic = asset(db, ORG_A)
    ack(db, UA, pic)  # even acknowledged: a later step may run in another member's session
    wf = _workflow(db, "vid-ack")
    q = db.act("authenticated", UA, "select public.quote_workflow(%s, %s::jsonb)", [wf["id"], json.dumps({"pic": pic})])[0][0]
    assert q["priced"] is False and q["steps"][1]["reason"] == "acknowledgement_required" and q["steps"][0]["priced"] is True
    before = footprint(db, ORG_A)
    st, word, detail = err(lambda: db.act("authenticated", UA,
        "select public.start_workflow_run(%s::uuid, %s::uuid, %s::integer, %s::jsonb, %s::numeric)",
        [str(uuid.uuid4()), wf["id"], wf["version"], json.dumps({"pic": pic}), 9]))
    assert (st, word) == ("NS400", "acknowledgement_required") and detail.startswith("step(s) 2 ")
    assert footprint(db, ORG_A) == before
    assert db.su("select count(*) from public.workflow_runs where workflow_id=%s", [wf["id"]])[0][0] == 0


def test_a_chained_step_is_refused_too_and_a_free_model_is_not(db):
    drain(db)
    asset(db, ORG_A)  # the quote's stand-in for the chained input
    chained = [{"capability": "t2i", "model": "img-free", "params": {"prompt": "a lighthouse"}},
               {"capability": "i2v", "model": "vid-ack", "params": {"source_asset_id": {"$step": 0}, "duration_s": 4}}]
    wf = db.act("authenticated", UA, "select public.save_workflow(%s::uuid, null, %s, '[]'::jsonb, %s::jsonb)",
                [ORG_A, "wf-chained", json.dumps(chained)])[0][0]
    q = db.act("authenticated", UA, "select public.quote_workflow(%s, '{}'::jsonb)", [wf["id"]])[0][0]
    assert q["steps"][1]["reason"] == "acknowledgement_required"
    free = _workflow(db, "vid-free")
    pic = asset(db, ORG_A)
    q = db.act("authenticated", UA, "select public.quote_workflow(%s, %s::jsonb)", [free["id"], json.dumps({"pic": pic})])[0][0]
    assert q["priced"] is True, q


# ── the public API's answer (L1) ────────────────────────────────────────────

def test_the_api_names_the_remedy(db):
    out = db.su("select public.api_creative_refusal('NS400', 'acknowledgement_required', 'kind=likeness_photo version=likeness_photo.v1 subject=x')")[0][0]
    assert out["status"] == 428 and out["error"]["code"] == "acknowledgement_required"
    assert "in the Studio" in out["error"]["message"] and "Nothing was held or charged" in out["error"]["message"]


# ── replay and rollback (M1) ────────────────────────────────────────────────

def _gate_md5(db):
    return db.su("select md5(regexp_replace(prosrc, '\\s+', ' ', 'g')) from pg_proc "
                 "where oid='public.create_creative_job(uuid,text,text,jsonb,text,text,numeric)'::regprocedure")[0][0]


def test_replaying_0174_changes_nothing_and_rollback_keeps_the_record(db):
    gate = _gate_md5(db)
    rows = db.su("select count(*) from public.rights_acknowledgements")[0][0]
    with psycopg.connect(db.dsn, autocommit=True) as c:
        sec_db.take_off_0179(c)  # 0179 replaces 0174's rights_acknowledgement_missing, which 0174's guard refuses
        c.execute((sec_db.MIGRATIONS / "0174_rights_acknowledgement.sql").read_text(encoding="utf-8"))
        sec_db.put_back_0179(c)
    assert _gate_md5(db) == gate
    with psycopg.connect(db.dsn, autocommit=True) as c:
        sec_db.take_off_0174(c)
    try:
        assert _gate_md5(db) == "4c74918fd9d938c8fe4f5a3d26a09d84"
        assert db.su("select count(*) from public.rights_acknowledgements")[0][0] == rows
        assert db.su("select requires_acknowledgement from public.model_registry where id='vid-col'")[0][0] == ["likeness_photo"]
    finally:
        with psycopg.connect(db.dsn, autocommit=True) as c:
            sec_db.put_back_0174(c)
    assert _gate_md5(db) == gate


def test_a_replay_of_0075_silently_removes_the_gate_which_is_why_the_doc_says_undo_first():
    """M1, measured on a scratch database: 0075's guard is a position() check that 0174's body passes, so re-running 0075 over
    0174 puts the old body back without a word. This pins the hazard the header and docs/MIGRATIONS.md describe; a later guard
    that closes it shows up here, and the docs change with it."""
    admin = sec_db.admin_dsn()
    if not admin:
        pytest.skip(f"{sec_db.DSN_ENV} is not set")
    name = f"ns_rights_ack_replay_{uuid.uuid4().hex[:8]}"
    d = Db(sec_db.build(admin, name))
    try:
        gate = _gate_md5(d)
        assert gate != "4c74918fd9d938c8fe4f5a3d26a09d84"
        d.su((sec_db.MIGRATIONS / "0075_model_router.sql").read_text(encoding="utf-8"))
        assert _gate_md5(d) == "4c74918fd9d938c8fe4f5a3d26a09d84", "0075 replayed over 0174 and kept the gate: update the docs"
        # And 0174 then refuses to go back on by itself: 0075 also put its own api_creative_refusal over 0124's. Re-running an
        # older file over newer ones is not a supported operation; the Verify query is how it is noticed.
        st, msg, _ = err(lambda: d.su((sec_db.MIGRATIONS / "0174_rights_acknowledgement.sql").read_text(encoding="utf-8")))
        # Which body it names first depends on what sits on 0174 (0179 replaces its workflow_quote_steps): a refusal either way.
        assert msg.startswith("0174 found public.") and "with a body that is neither" in msg, msg
    finally:
        if not os.environ.get("NIGHTSHIFT_SECURITY_KEEP"):
            sec_db.drop_database(admin, name)

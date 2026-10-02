"""Workflow apps (0073), attacked in a real database.

A workflow is a saved list of creative steps; "Run now" prices ALL of them as one
total, takes that total as max_credits, and creates each step as an ordinary
creative job (0036) only when the step before it has finished. The money rules
under attack here:

  * one total from the real per-step quotes; an unpriced step makes it unpriced
    and the run is refused, never started at 0
  * the confirmed total must be the total as priced now (price_changed)
  * a replayed run id answers the first run: nothing is held twice
  * a step that fails stops the run; later steps were never created, so they
    never held anything, and the failed step's credits come back
  * another organization's workflow, run, file or run id reads like one that does
    not exist; a member who may only look cannot save, run, advance or cancel

Runs in its own scratch database (it commits): a real 0035 registry installed
through sync_model_registry and real probe rows, as production does, with one
model for each capability a workflow chains.
"""
import json
import os
import threading
import uuid
from decimal import Decimal

import psycopg
import pytest

import sec_db


def uid(n: int) -> str:
    return str(uuid.UUID(int=0x7300 + n))


UADMIN = uid(99)

# (id, capabilities, adapter, credit unit, credits per unit)
MODELS = [
    ("img-a", ["t2i"], "image.acme", "model_img_a_image", 4),
    ("img-edit", ["t2i", "edit"], "image.acme", "model_img_edit_image", 3),
    ("vid-i2v", ["t2v", "i2v"], "video.acme", "model_vid_i2v_second", 2),
    ("tts-a", ["tts"], "audio.acme", "model_tts_a_character", 0.1),
    ("img-unpriced", ["t2i"], "image.acme", "model_no_such_price", 0),
]
PRICES = ", ".join(f"('{u}', {c}, 0)" for m, _caps, _a, u, c in MODELS if m != "img-unpriced") + ", ('job_minimum', 1, 0)"

STEP_IMG = {"capability": "t2i", "model": "img-a", "params": {"prompt": {"$input": "idea"}}}
STEP_ANIMATE = {"capability": "i2v", "model": "vid-i2v",
                "params": {"source_asset_id": {"$step": 0}, "duration_s": 5}}
STEP_VOICE = {"capability": "tts", "model": "tts-a", "params": {"prompt": {"$input": "line"}}}
INPUTS = [{"name": "idea", "kind": "text"}, {"name": "line", "kind": "text"}]
VALUES = {"idea": "a lighthouse at dusk", "line": "Welcome to the show"}  # 19 characters -> 1.9 credits
FLOW = [STEP_IMG, STEP_ANIMATE, STEP_VOICE]  # 4 + 10 + 1.9 = 15.9
TOTAL = 15.9


def claims(role, user=None):
    c = {"role": role}
    if user:
        c["sub"] = user
    return json.dumps(c)


class Db:
    def __init__(self, dsn):
        self.dsn = dsn
        self.n = 100

    def su(self, q, p=None):
        with psycopg.connect(self.dsn, autocommit=True) as c:
            cur = c.execute(q, p)
            return cur.fetchall() if cur.description else None

    def act(self, role, user, q, p=None):
        with psycopg.connect(self.dsn, autocommit=False) as c:
            try:
                c.execute("select set_config('request.jwt.claims', %s, true)", [claims(role, user)])
                c.execute(f"set local role {role}")
                cur = c.execute(q, p)
                rows = cur.fetchall() if cur.description else None
                c.commit()
                return rows
            except psycopg.Error:
                c.rollback()
                raise

    def one(self, role, user, q, p=None):
        rows = self.act(role, user, q, p)
        return rows[0][0]

    def new_org(self, credits=100, with_image=True):
        """An organization with an owner, an editor, a viewer, credits and a library picture."""
        self.n += 1
        n = self.n
        org = str(uuid.UUID(int=0x7300A000 + n))
        owner, editor, viewer = uid(n * 3), uid(n * 3 + 1), uid(n * 3 + 2)
        for u, role in ((owner, "owner"), (editor, "editor"), (viewer, "viewer")):
            self.su("insert into auth.users (id, email) values (%s, %s)", [u, f"{role}{n}@x.io"])
        self.su("insert into public.organizations (id, name, slug) values (%s, %s, %s)", [org, f"Org{n}", f"org-wf-{n}"])
        for u, role in ((owner, "owner"), (editor, "editor"), (viewer, "viewer")):
            self.su("insert into public.org_members (org_id, user_id, email, role) values (%s, %s, %s, %s)",
                    [org, u, f"{role}{n}@x.io", role])
        if credits:
            self.su("select public.grant_credits(%s, %s, 'test')", [org, credits])
        o = Org(org, owner, editor, viewer)
        o.image = self.asset(org) if with_image else None
        return o

    def asset(self, org, kind="image", mime="image/png", job=None):
        return str(self.su(
            "select public.register_asset(gen_random_uuid(), %s, %s, %s, 1000, %s, 'generated', "
            "p_width => 64, p_height => 64, p_provenance => %s::jsonb) ->> 'id'",
            [org, kind, mime, uuid.uuid4().hex * 2, json.dumps({"job_id": job or "x"})])[0][0])

    # ── the three calls under test ──────────────────────────────────────────
    def save(self, who, org, name, inputs, steps, workflow=None):
        return self.one("authenticated", who,
                        "select public.save_workflow(%s::uuid, %s::uuid, %s, %s::jsonb, %s::jsonb)",
                        [org, workflow, name, json.dumps(inputs), json.dumps(steps)])

    def quote(self, who, workflow, values):
        return self.one("authenticated", who, "select public.quote_workflow(%s, %s::jsonb)",
                        [workflow, json.dumps(values)])

    def start(self, who, run, workflow, version, values, maxc):
        return self.one("authenticated", who, "select public.start_workflow_run(%s::uuid, %s::uuid, %s::integer, %s::jsonb, %s::numeric)",
                        [run, workflow, version, json.dumps(values), maxc])

    def advance(self, who, run):
        return self.one("authenticated", who, "select public.advance_workflow_run(%s)", [run])

    def cancel(self, who, run):
        return self.one("authenticated", who, "select public.cancel_workflow_run(%s)", [run])

    # ── ground truth ────────────────────────────────────────────────────────
    def acct(self, org):
        return self.su("select balance, reserved from public.credit_accounts where org_id = %s", [org])[0]

    def holds(self, org):
        return self.su("select count(*), coalesce(sum(amount), 0) from public.credit_reservations "
                       "where org_id = %s and status = 'open'", [org])[0]

    def jobs(self, org):
        return self.su("select count(*) from public.creative_jobs where org_id = %s and idempotency_key like 'wf:%%'",
                       [org])[0][0]

    def steps(self, run):
        return self.su("select step_index, status, job_id::text, quoted_credits, charged_credits, error_code "
                       "from public.workflow_run_steps where run_id = %s order by step_index", [run])

    def worker(self, job, ok=True, charge=None, make_asset=True, code="provider_error"):
        """The creative worker: claim, submit, process, attach the output, finish."""
        w = "wf-worker"
        while True:
            got = self.act("service_role", None, "select id::text, org_id::text, credit_ref from public.claim_creative_job(%s)", [w])
            assert got, "the job is not in the queue"
            jid, org, ref = got[0]
            if jid == job:
                break
            self.act("service_role", None, "select public.finish_creative_job(%s, %s, false, null, null, 'drained', 'drained')", [jid, w])
        if ref:
            self.act("service_role", None, "select public.start_credit_reservation(%s, %s)", [ref, org])
        sv = lambda q, p: self.act("service_role", None, q, p)
        assert sv("select public.advance_creative_job(%s, %s, 'submitting')", [job, w])[0][0]
        if not ok:
            return sv("select public.finish_creative_job(%s, %s, false, null, null, %s, 'the provider refused')",
                      [job, w, code])[0][0]
        assert sv("select public.advance_creative_job(%s, %s, 'submitted', %s)", [job, w, f"task-{job}"])[0][0]
        assert sv("select public.advance_creative_job(%s, %s, 'processing')", [job, w])[0][0]
        if make_asset:
            a = self.asset(org, job=job)
            assert sv("select public.attach_creative_job_assets(%s, %s, %s::uuid[])", [job, w, [a]])[0][0]
        return sv("select public.finish_creative_job(%s::uuid, %s, true, %s::numeric, '{}'::jsonb)", [job, w, charge])[0][0]


class Org:
    def __init__(self, org, owner, editor, viewer):
        self.org, self.owner, self.editor, self.viewer = org, owner, editor, viewer
        self.image = None


@pytest.fixture(scope="module")
def db():
    admin = sec_db.admin_dsn()
    if not admin:
        if os.environ.get("NIGHTSHIFT_SECURITY_REQUIRED"):
            pytest.fail(f"{sec_db.DSN_ENV} is not set", pytrace=False)
        pytest.skip(f"{sec_db.DSN_ENV} is not set — the security lab needs a scratch Postgres")
    name = f"ns_workflows_{uuid.uuid4().hex[:8]}"
    d = Db(sec_db.build(admin, name))
    rows = [{"id": m, "display_name": m, "provider": "acme", "adapter": a, "capabilities": caps,
             "credit_unit": unit, "entitlement": "any",
             "spec": {"vendor_model": "acme-" + m,
                      "output": a.split(".")[0] if a.split(".")[0] != "audio" else "audio"}}
            for m, caps, a, unit, _c in MODELS]
    d.su("select public.sync_model_registry(%s::jsonb)", [json.dumps(rows)])
    for m, caps, a, _u, _c in MODELS:
        d.su("select public.record_model_probe(%s, %s, %s, %s, true, null, null, 10, 100, 'security-lab')",
             [m, a, "acme-" + m, caps[-1]])
        d.su("update public.model_registry set availability='beta' where id=%s", [m])
    d.su(f"insert into public.credit_prices (unit, credits_per_unit, margin) values {PRICES} "
         "on conflict (unit) do update set credits_per_unit = excluded.credits_per_unit, margin = 0")
    d.su("insert into auth.users (id, email) values (%s, 'admin@x.io')", [UADMIN])
    try:
        yield d
    finally:
        if not os.environ.get("NIGHTSHIFT_SECURITY_KEEP"):
            sec_db.drop_database(admin, name)


def err(fn):
    with pytest.raises(psycopg.Error) as e:
        fn()
    return e.value.sqlstate, str(e.value).splitlines()[0]


def flow(db, o, steps=None, inputs=None, name="Promo"):
    return db.save(o.editor, o.org, name, INPUTS if inputs is None else inputs, steps or FLOW)


def start_ok(db, o, wf=None, run=None, values=None, maxc=TOTAL):
    wf = wf or flow(db, o)
    run = run or str(uuid.uuid4())
    out = db.start(o.editor, run, wf["id"], wf["version"], values or VALUES, maxc)
    return wf, run, out


# ── saving ──────────────────────────────────────────────────────────────────

def test_a_workflow_is_two_to_six_steps_built_from_creative_capabilities(db):
    o = db.new_org()
    assert flow(db, o)["version"] == 1
    one = lambda: db.save(o.editor, o.org, "Short", INPUTS, [STEP_IMG])
    assert err(one)[0] == "NS400"
    seven = lambda: db.save(o.editor, o.org, "Long", INPUTS, [STEP_IMG] * 7)
    assert err(seven)[0] == "NS400"
    nonsense = lambda: db.save(o.editor, o.org, "Bad", INPUTS, [STEP_IMG, {**STEP_IMG, "capability": "publish"}])
    assert err(nonsense)[0] == "NS400"
    # An unknown parameter is refused, not dropped (a typo must never become a default).
    typo = lambda: db.save(o.editor, o.org, "Bad", INPUTS, [STEP_IMG, {**STEP_IMG, "params": {"prompt": "x", "pubish": True}}])
    assert err(typo)[0] == "NS400"
    assert db.su("select count(*) from public.workflows where org_id = %s", [o.org])[0][0] == 1


@pytest.mark.parametrize("name,steps,inputs,word", [
    ("forward reference", [{**STEP_ANIMATE, "params": {"source_asset_id": {"$step": 1}, "duration_s": 5}}, STEP_IMG],
     INPUTS, "EARLIER"),
    ("self reference", [STEP_IMG, {**STEP_ANIMATE, "params": {"source_asset_id": {"$step": 1}, "duration_s": 5}}],
     INPUTS, "EARLIER"),
    ("from a step that makes no picture", [STEP_VOICE, STEP_ANIMATE], INPUTS, "does not make a picture"),
    ("into a tool priced by the file's own length",
     [STEP_IMG, {"capability": "video_upscale", "model": "x", "params": {"source_asset_id": {"$step": 0}, "target_resolution": "2k"}}],
     INPUTS, "cannot start from another step"),
    ("undeclared input", [STEP_IMG, STEP_VOICE], [{"name": "idea", "kind": "text"}], "not declared"),
    ("asset input as text", [STEP_IMG, STEP_VOICE], [{"name": "idea", "kind": "asset"}, {"name": "line", "kind": "text"}], "text input"),
    ("binding a setting", [STEP_IMG, {**STEP_IMG, "params": {"prompt": "x", "seed": {"$input": "idea"}}}], INPUTS, "cannot come from an input"),
    ("two bindings in one", [STEP_IMG, {**STEP_IMG, "params": {"prompt": {"$input": "idea", "$step": 0}}}], INPUTS, "one input or one step"),
])
def test_a_definition_that_could_not_run_is_refused_when_saved(db, name, steps, inputs, word):
    o = db.new_org()
    sqlstate, message = err(lambda: db.save(o.editor, o.org, "Bad", inputs, steps))
    assert sqlstate == "NS400" and message.startswith("invalid_params"), (name, sqlstate, message)
    # The reason is in the diagnostics detail, not the first line of the message.
    with pytest.raises(psycopg.Error) as e:
        db.save(o.editor, o.org, "Bad", inputs, steps)
    assert word in (e.value.diag.message_detail or ""), (name, e.value.diag.message_detail)


# ── pricing: one total from the real per-step quotes ────────────────────────

def test_the_total_is_the_sum_of_the_same_quotes_the_studio_gives(db):
    o = db.new_org()
    wf = flow(db, o)
    q = db.quote(o.editor, wf["id"], VALUES)
    assert q["priced"] is True and q["total"] == TOTAL and [s["credits"] for s in q["steps"]] == [4, 10, 1.9]
    # The step quotes are creative_price's: what /api/creative/quote answers for the same step.
    studio = lambda cap, model, params: db.one(
        "authenticated", o.editor, "select public.quote_creative_job(%s, %s, %s, %s::jsonb)",
        [o.org, cap, model, json.dumps(params)])["credits"]
    assert studio("t2i", "img-a", {"prompt": VALUES["idea"]}) == q["steps"][0]["credits"]
    assert studio("i2v", "vid-i2v", {"source_asset_id": o.image, "duration_s": 5}) == q["steps"][1]["credits"]
    assert studio("tts", "tts-a", {"prompt": VALUES["line"]}) == q["steps"][2]["credits"]
    # Any member may ask the price; asking holds nothing.
    assert db.quote(o.viewer, wf["id"], VALUES)["total"] == TOTAL
    assert db.holds(o.org) == (0, 0)


def test_an_unpriced_step_makes_the_total_unpriced_and_run_is_refused_never_zero(db):
    o = db.new_org()
    wf = flow(db, o, [STEP_IMG, {**STEP_IMG, "model": "img-unpriced", "params": {"prompt": "x"}}])
    q = db.quote(o.editor, wf["id"], VALUES)
    assert q["priced"] is False and q["total"] is None and q["unpriced_steps"] == [1]
    assert q["steps"][0]["credits"] == 4 and q["steps"][1]["credits"] is None
    before = db.acct(o.org)
    for confirmed in (0, 4, 8, 1000):
        sqlstate, message = err(lambda: db.start(o.editor, str(uuid.uuid4()), wf["id"], wf["version"], VALUES, confirmed))
        assert (sqlstate, message.split(":")[-1].strip()) == ("NS400", "unpriced"), (confirmed, message)
    assert db.acct(o.org) == before and db.jobs(o.org) == 0
    assert db.su("select count(*) from public.workflow_runs where org_id = %s", [o.org])[0][0] == 0


def test_a_chained_step_with_no_picture_in_the_library_to_price_it_against_is_unpriced(db):
    o = db.new_org(with_image=False)
    wf = flow(db, o)
    q = db.quote(o.editor, wf["id"], VALUES)
    assert q["priced"] is False and q["total"] is None
    assert q["steps"][1]["reason"] == "source_unavailable" and q["steps"][1]["chained"] is True
    assert err(lambda: db.start(o.editor, str(uuid.uuid4()), wf["id"], wf["version"], VALUES, TOTAL))[0] == "NS400"


def test_not_enough_credits_for_the_whole_total_refuses_before_anything_is_held(db):
    o = db.new_org(credits=15)  # the total is 15.9
    wf = flow(db, o)
    sqlstate, message = err(lambda: db.start(o.editor, str(uuid.uuid4()), wf["id"], wf["version"], VALUES, TOTAL))
    assert sqlstate == "NS402"
    assert db.holds(o.org) == (0, 0) and db.jobs(o.org) == 0


# ── the confirmation ────────────────────────────────────────────────────────

def test_max_credits_must_be_the_total_priced_now_in_either_direction(db):
    o = db.new_org()
    wf = flow(db, o)
    for confirmed, want in ((15.89, "NS409"), (0, "NS409"), (15.91, "NS409"), (160, "NS409"), (None, "NS400"), (-1, "NS400")):
        sqlstate, message = err(lambda: db.start(o.editor, str(uuid.uuid4()), wf["id"], wf["version"], VALUES, confirmed))
        assert sqlstate == want, (confirmed, sqlstate, message)
    assert db.holds(o.org) == (0, 0) and db.jobs(o.org) == 0
    assert db.su("select count(*) from public.workflow_runs where org_id = %s", [o.org])[0][0] == 0


def test_a_workflow_edited_after_the_quote_cannot_be_run_under_the_old_price(db):
    o = db.new_org()
    wf = flow(db, o)
    wf2 = db.save(o.editor, o.org, "Promo", INPUTS, [STEP_IMG, STEP_VOICE], workflow=wf["id"])
    assert wf2["version"] == 2
    sqlstate, message = err(lambda: db.start(o.editor, str(uuid.uuid4()), wf["id"], 1, VALUES, TOTAL))
    assert (sqlstate, message.split(":")[-1].strip()) == ("NS409", "workflow_changed")
    assert db.jobs(o.org) == 0


# ── running: each step is held only when it starts ──────────────────────────

def test_only_the_first_step_is_created_and_held_at_start(db):
    o = db.new_org()
    wf, run, out = start_ok(db, o)
    assert out["replay"] is False and out["run"]["status"] == "running" and out["run"]["max_credits"] == TOTAL
    steps = db.steps(run)
    assert [s[1] for s in steps] == ["running", "pending", "pending"]
    assert steps[1][2] is None and steps[2][2] is None
    # One hold, for step 1's quote: the other steps hold nothing.
    assert db.holds(o.org) == (1, 4) and db.jobs(o.org) == 1
    key = db.su("select idempotency_key, quoted_credits, requested_by::text from public.creative_jobs where id = %s", [steps[0][2]])[0]
    assert key == (f"wf:{run}:0", 4, o.editor)


def test_a_replayed_run_id_answers_the_first_run_and_holds_nothing_twice(db):
    o = db.new_org()
    wf, run, first = start_ok(db, o)
    held = (db.holds(o.org), db.acct(o.org), db.jobs(o.org))
    again = db.start(o.editor, run, wf["id"], wf["version"], VALUES, TOTAL)
    assert again["replay"] is True and again["steps"][0]["job_id"] == first["steps"][0]["job_id"]
    assert (db.holds(o.org), db.acct(o.org), db.jobs(o.org)) == held
    # The same id for a different request is a conflict, not a second run.
    other_inputs = {**VALUES, "idea": "something else"}
    assert err(lambda: db.start(o.editor, run, wf["id"], wf["version"], other_inputs, TOTAL))[0] == "NS409"
    assert (db.holds(o.org), db.jobs(o.org)) == (held[0], held[2])


def test_a_run_id_of_another_organization_is_a_conflict_that_reveals_nothing(db):
    a, b = db.new_org(), db.new_org()
    wf_a, run_a, _ = start_ok(db, a)
    wf_b = flow(db, b)
    taken = err(lambda: db.start(b.editor, run_a, wf_b["id"], wf_b["version"], VALUES, TOTAL))
    # The same answer as for one's own earlier run with other inputs: it says nothing of whose it is.
    wf_b2, run_b, _ = start_ok(db, b)
    mine = err(lambda: db.start(b.editor, run_b, wf_b2["id"], wf_b2["version"], {**VALUES, "idea": "x"}, TOTAL))
    assert taken == mine and taken[0] == "NS409"
    # Alice's run is untouched, and Bob made nothing from it.
    assert db.su("select org_id::text, workflow_id::text from public.workflow_runs where id = %s", [run_a]) == [(a.org, wf_a["id"])]


def test_two_simultaneous_presses_make_one_run(db):
    o = db.new_org()
    wf = flow(db, o)
    run = str(uuid.uuid4())
    outs, errs = [], []

    def press():
        try:
            outs.append(db.start(o.editor, run, wf["id"], wf["version"], VALUES, TOTAL))
        except psycopg.Error as e:  # pragma: no cover - would be a bug
            errs.append(str(e))

    ts = [threading.Thread(target=press) for _ in range(2)]
    [t.start() for t in ts]
    [t.join() for t in ts]
    assert not errs and len(outs) == 2
    assert sorted(x["replay"] for x in outs) == [False, True]
    assert db.jobs(o.org) == 1 and db.holds(o.org) == (1, 4)


def test_the_whole_run_goes_through_and_never_charges_more_than_confirmed(db):
    o = db.new_org()
    wf, run, out = start_ok(db, o)
    start_balance = db.acct(o.org)
    # step 1 completes (charged less than its hold); advancing starts step 2 with the picture step 1 made
    s0 = db.steps(run)[0][2]
    done = db.worker(s0, charge=3)
    assert done["status"] == "completed" and done["charged_credits"] == 3
    out = db.advance(o.editor, run)
    assert [s["status"] for s in out["steps"]] == ["completed", "running", "pending"]
    made = db.su("select result_asset_ids[1]::text from public.creative_jobs where id = %s", [s0])[0][0]
    s1 = out["steps"][1]["job_id"]
    assert db.su("select params ->> 'source_asset_id' from public.creative_jobs where id = %s", [s1])[0][0] == made
    assert db.su("select idempotency_key from public.creative_jobs where id = %s", [s1])[0][0] == f"wf:{run}:1"
    assert db.holds(o.org) == (1, 10)
    db.worker(s1, charge=10)
    out = db.advance(o.editor, run)
    s2 = out["steps"][2]["job_id"]
    assert out["steps"][2]["status"] == "running" and db.holds(o.org) == (1, Decimal('1.9'))
    db.worker(s2, charge=1.9)
    out = db.advance(o.editor, run)
    assert out["run"]["status"] == "completed" and out["run"]["charged_credits"] == 14.9
    assert out["run"]["charged_credits"] <= out["run"]["max_credits"] == TOTAL
    assert all(s["charged_credits"] <= s["quoted_credits"] for s in out["steps"])
    assert db.acct(o.org) == (start_balance[0] - Decimal('14.9'), 0) and db.holds(o.org) == (0, 0)
    # A page that keeps polling changes nothing.
    assert db.advance(o.editor, run)["run"]["charged_credits"] == 14.9 and db.jobs(o.org) == 3


def test_a_failed_step_stops_the_run_later_steps_were_never_held_and_its_credits_return(db):
    o = db.new_org()
    wf, run, out = start_ok(db, o)
    start_balance = db.acct(o.org)
    db.worker(db.steps(run)[0][2], charge=4)
    out = db.advance(o.editor, run)
    s1 = out["steps"][1]["job_id"]
    assert db.holds(o.org) == (1, 10)
    failed = db.worker(s1, ok=False)
    assert failed["status"] == "failed"
    out = db.advance(o.editor, run)
    assert out["run"]["status"] == "failed" and out["run"]["error_code"] == "step_failed"
    assert [s["status"] for s in out["steps"]] == ["completed", "failed", "skipped"]
    assert out["steps"][1]["error_code"] == "provider_error" and out["steps"][1]["charged_credits"] == 0
    # The third step has no job and never held a thing.
    assert out["steps"][2]["job_id"] is None and db.jobs(o.org) == 2
    # Only step 1 was paid for; the failed step's hold went back.
    assert db.acct(o.org) == (start_balance[0] - 4, 0) and db.holds(o.org) == (0, 0)
    assert out["run"]["charged_credits"] == 4
    # Polling a failed run starts nothing, and pressing Run now again with the same id replays it.
    db.advance(o.editor, run)
    again = db.start(o.editor, run, wf["id"], wf["version"], VALUES, TOTAL)
    assert again["replay"] is True and again["run"]["status"] == "failed"
    assert db.jobs(o.org) == 2 and db.holds(o.org) == (0, 0)


def test_a_price_that_moved_since_the_confirmation_fails_that_step_not_the_total(db):
    o = db.new_org()
    wf, run, out = start_ok(db, o)
    db.worker(db.steps(run)[0][2], charge=4)
    db.su("update public.credit_prices set credits_per_unit = 3 where unit = 'model_vid_i2v_second'")
    try:
        out = db.advance(o.editor, run)
    finally:
        db.su("update public.credit_prices set credits_per_unit = 2 where unit = 'model_vid_i2v_second'")
    assert out["run"]["status"] == "failed"
    assert [s["status"] for s in out["steps"]] == ["completed", "failed", "skipped"]
    assert out["steps"][1]["error_code"] == "price_changed" and out["steps"][1]["job_id"] is None
    assert db.holds(o.org) == (0, 0) and db.jobs(o.org) == 1


def test_a_confirmation_does_not_outlive_a_day(db):
    o = db.new_org()
    wf, run, out = start_ok(db, o)
    db.worker(db.steps(run)[0][2], charge=4)
    db.su("update public.workflow_runs set created_at = now() - interval '25 hours' where id = %s", [run])
    out = db.advance(o.editor, run)
    assert out["steps"][1]["error_code"] == "confirmation_expired" and out["run"]["status"] == "failed"
    assert db.holds(o.org) == (0, 0) and db.jobs(o.org) == 1


def test_a_step_that_makes_no_file_cannot_feed_the_next_one(db):
    o = db.new_org()
    wf, run, out = start_ok(db, o)
    db.worker(db.steps(run)[0][2], charge=4, make_asset=False)
    out = db.advance(o.editor, run)
    assert out["steps"][1]["error_code"] == "missing_output" and out["run"]["status"] == "failed"
    assert db.holds(o.org) == (0, 0) and db.jobs(o.org) == 1


def test_cancelling_stops_the_run_and_releases_the_step_not_yet_with_the_provider(db):
    o = db.new_org()
    start_balance = db.acct(o.org)
    wf, run, out = start_ok(db, o)
    out = db.cancel(o.editor, run)
    assert out["run"]["status"] == "cancelled"
    assert [s["status"] for s in out["steps"]] == ["cancelled", "skipped", "skipped"]
    assert db.acct(o.org) == start_balance and db.holds(o.org) == (0, 0)
    assert db.cancel(o.editor, run)["run"]["status"] == "cancelled"  # again: nothing changes


def test_a_step_that_could_not_start_for_credits_waits_without_holding_the_rest(db):
    # BR-L-011: a balance short for the next step is not a refusal of a run already paid for
    # in part. The step stays pending (the reason on record), nothing is held for it or for the
    # steps after it, and the run carries on once credits are back (test_sec_workflows_wait.py).
    o = db.new_org(credits=17)
    wf, run, out = start_ok(db, o)
    db.worker(db.steps(run)[0][2], charge=4)
    # Another spend drains the account between steps.
    db.su("select public.reserve_credits(%s, 'drain-1', 12)", [o.org])
    out = db.advance(o.editor, run)
    assert out["steps"][1]["error_code"] == "insufficient_credits" and out["steps"][1]["status"] == "pending"
    assert out["run"]["status"] == "running" and out["run"]["charged_credits"] == 4
    assert out["steps"][1]["job_id"] is None and out["steps"][2]["job_id"] is None and db.jobs(o.org) == 1
    assert db.holds(o.org) == (1, 12)  # only the other spend's own hold


# ── other organizations ─────────────────────────────────────────────────────

def test_another_organization_reads_and_changes_nothing_of_a_workflow_or_run(db):
    a, b = db.new_org(), db.new_org()
    wf, run, out = start_ok(db, a)
    for q, p in (("select count(*) from public.workflows where id = %s", [wf["id"]]),
                 ("select count(*) from public.workflow_runs where id = %s", [run]),
                 ("select count(*) from public.workflow_run_steps where run_id = %s", [run])):
        assert db.one("authenticated", b.owner, q, p) == 0
        assert db.one("authenticated", a.owner, q, p) > 0
    # Everything by id reads as missing, never as forbidden.
    calls = [
        lambda: db.quote(b.owner, wf["id"], VALUES),
        lambda: db.start(b.owner, str(uuid.uuid4()), wf["id"], 1, VALUES, TOTAL),
        lambda: db.advance(b.owner, run),
        lambda: db.cancel(b.owner, run),
        lambda: db.save(b.owner, b.org, "Mine", INPUTS, FLOW, workflow=wf["id"]),
        lambda: db.one("authenticated", b.owner, "select public.delete_workflow(%s)", [wf["id"]]),
    ]
    made_up = [
        lambda: db.quote(b.owner, str(uuid.uuid4()), VALUES),
        lambda: db.start(b.owner, str(uuid.uuid4()), str(uuid.uuid4()), 1, VALUES, TOTAL),
        lambda: db.advance(b.owner, str(uuid.uuid4())),
        lambda: db.cancel(b.owner, str(uuid.uuid4())),
        lambda: db.save(b.owner, b.org, "Mine", INPUTS, FLOW, workflow=str(uuid.uuid4())),
        lambda: db.one("authenticated", b.owner, "select public.delete_workflow(%s)", [str(uuid.uuid4())]),
    ]
    for real, fake in zip(calls, made_up):
        assert err(real) == err(fake) and err(real)[0] == "P0002"
    # Saving into someone else's organization.
    assert err(lambda: db.save(b.owner, a.org, "Mine", INPUTS, FLOW))[0] == "42501"
    assert db.su("select status, version from public.workflow_runs, public.workflows where workflow_runs.id = %s "
                 "and workflows.id = %s", [run, wf["id"]]) == [("running", 1)]


def test_another_organizations_picture_prices_like_one_that_does_not_exist(db):
    a, b = db.new_org(), db.new_org()
    edit = {"capability": "edit", "model": "img-edit", "params": {"source_asset_id": {"$input": "photo"}, "prompt": "brighter"}}
    inputs = [{"name": "photo", "kind": "asset"}]
    wf = db.save(b.editor, b.org, "Edit", inputs, [edit, {**edit, "params": {"source_asset_id": {"$step": 0}, "prompt": "more"}}])
    ok = db.quote(b.editor, wf["id"], {"photo": b.image})
    assert ok["priced"] is True and ok["total"] == 6
    theirs = db.quote(b.editor, wf["id"], {"photo": a.image})
    nothing = db.quote(b.editor, wf["id"], {"photo": str(uuid.uuid4())})
    assert theirs == nothing and theirs["priced"] is False and theirs["total"] is None
    for photo in (a.image, str(uuid.uuid4())):
        failed = err(lambda: db.start(b.editor, str(uuid.uuid4()), wf["id"], wf["version"], {"photo": photo}, 6))
        assert failed[0] == "NS400"
    assert db.holds(b.org) == (0, 0) and db.jobs(b.org) == 0
    # A literal file of another organization in a step's own params is the same.
    lit = db.save(b.editor, b.org, "Literal", [], [{**edit, "params": {"source_asset_id": a.image, "prompt": "x"}},
                                                    {"capability": "tts", "model": "tts-a", "params": {"prompt": "hello"}}])
    assert db.quote(b.editor, lit["id"], {})["priced"] is False


# ── members who may only look ───────────────────────────────────────────────

def test_a_viewer_reads_and_prices_but_cannot_save_run_advance_or_cancel(db):
    o = db.new_org()
    wf, run, out = start_ok(db, o)
    assert db.one("authenticated", o.viewer, "select count(*) from public.workflows where id = %s", [wf["id"]]) == 1
    assert db.one("authenticated", o.viewer, "select count(*) from public.workflow_run_steps where run_id = %s", [run]) == 3
    assert db.quote(o.viewer, wf["id"], VALUES)["total"] == TOTAL
    before = (db.acct(o.org), db.holds(o.org), db.jobs(o.org), db.steps(run))
    calls = [
        lambda: db.save(o.viewer, o.org, "Mine", INPUTS, FLOW),
        lambda: db.save(o.viewer, o.org, "Renamed", INPUTS, FLOW, workflow=wf["id"]),
        lambda: db.one("authenticated", o.viewer, "select public.delete_workflow(%s)", [wf["id"]]),
        lambda: db.start(o.viewer, str(uuid.uuid4()), wf["id"], 1, VALUES, TOTAL),
        lambda: db.advance(o.viewer, run),
        lambda: db.cancel(o.viewer, run),
    ]
    for call in calls:
        assert err(call)[0] == "42501"
    assert (db.acct(o.org), db.holds(o.org), db.jobs(o.org), db.steps(run)) == before
    assert db.su("select name, archived_at is null from public.workflows where id = %s", [wf["id"]]) == [("Promo", True)]


def test_anon_can_call_nothing(db):
    o = db.new_org()
    wf, run, out = start_ok(db, o)
    for q, p in (("select public.quote_workflow(%s, '{}'::jsonb)", [wf["id"]]),
                 ("select public.start_workflow_run(%s::uuid, %s::uuid, 1, '{}'::jsonb, 1)", [str(uuid.uuid4()), wf["id"]]),
                 ("select public.advance_workflow_run(%s)", [run]),
                 ("select public.cancel_workflow_run(%s)", [run]),
                 ("select public.save_workflow(%s::uuid, null, 'x', '[]'::jsonb, '[]'::jsonb)", [o.org]),
                 ("select public.delete_workflow(%s)", [wf["id"]])):
        assert err(lambda: db.act("anon", None, q, p))[0] == "42501", q
    assert err(lambda: db.act("anon", None, "select count(*) from public.workflows"))[0] == "42501"


# ── forged step ownership ───────────────────────────────────────────────────

def test_no_api_role_writes_a_workflow_table_directly(db):
    o = db.new_org()
    wf, run, out = start_ok(db, o)
    job = db.steps(run)[0][2]
    writes = [
        "update public.workflow_run_steps set job_id = %s where run_id = %s and step_index = 1",
        "update public.workflow_run_steps set status = 'completed', charged_credits = 0 where run_id = %s",
        "update public.workflow_runs set max_credits = 1000 where id = %s",
        "update public.workflows set steps = '[]'::jsonb where id = %s",
        "delete from public.workflow_run_steps where run_id = %s",
        "delete from public.workflow_runs where id = %s",
    ]
    args = {0: [job, run], 1: [run], 2: [run], 3: [wf["id"]], 4: [run], 5: [run]}
    for role, user in (("authenticated", o.owner), ("service_role", None), ("anon", None)):
        for i, q in enumerate(writes):
            assert err(lambda: db.act(role, user, q, args[i]))[0] == "42501", (role, q)
        assert err(lambda: db.act(role, user, "insert into public.workflows (org_id, name, steps) values (%s, 'x', '[]'::jsonb)", [o.org]))[0] == "42501"
        assert err(lambda: db.act(role, user, "insert into public.workflow_run_steps (run_id, step_index, org_id, capability, model, params, quoted_credits, job_id) "
                                  "values (%s, 5, %s, 't2i', 'img-a', '{}'::jsonb, 0, %s)", [run, o.org, job]))[0] == "42501"
    assert [s[1] for s in db.steps(run)] == ["running", "pending", "pending"]


def test_a_step_cannot_belong_to_another_organization_or_borrow_another_steps_job(db):
    a, b = db.new_org(), db.new_org()
    wf, run, out = start_ok(db, a)
    job = db.steps(run)[0][2]
    # Even the database owner cannot attach a step of A's run to B's organization ...
    assert err(lambda: db.su("insert into public.workflow_run_steps (run_id, step_index, org_id, capability, model, params, quoted_credits) "
                             "values (%s, 4, %s, 't2i', 'img-a', '{}'::jsonb, 0)", [run, b.org]))[0] == "23503"
    # ... a run cannot name another organization's workflow ...
    wf_b = flow(db, b)
    assert err(lambda: db.su("insert into public.workflow_runs (id, org_id, workflow_id, workflow_name, workflow_version, max_credits, request_hash) "
                             "values (gen_random_uuid(), %s, %s, 'x', 1, 0, 'h')", [a.org, wf_b["id"]]))[0] == "23503"
    # ... and one creative job can pay for one step only.
    assert err(lambda: db.su("update public.workflow_run_steps set status = 'running', job_id = %s where run_id = %s and step_index = 1",
                             [job, run]))[0] == "23505"
    assert db.jobs(b.org) == 0


def test_a_member_cannot_make_a_step_start_from_a_file_it_did_not_make(db):
    # A binding names an earlier STEP's output, never a job or asset id of the caller's choosing.
    o = db.new_org()
    forged = {**STEP_ANIMATE, "params": {"source_asset_id": {"$step": 0, "$asset": o.image}, "duration_s": 5}}
    assert err(lambda: db.save(o.editor, o.org, "Forged", INPUTS, [STEP_IMG, forged]))[0] == "NS400"
    forged = {**STEP_ANIMATE, "params": {"source_asset_id": {"$job": str(uuid.uuid4())}, "duration_s": 5}}
    assert err(lambda: db.save(o.editor, o.org, "Forged", INPUTS, [STEP_IMG, forged]))[0] == "NS400"


# ── LENS-2 (BR-L-005, BR-L-006): a step's key, the lock order, the confirmer ──

I2V_PRICE = "update public.credit_prices set credits_per_unit = %s where unit = 'model_vid_i2v_second'"


def test_a_later_step_never_adopts_a_job_made_beforehand_under_its_key(db):
    # BR-L-005: run ids and step params are readable by every member, and a key
    # replay answers before the price check. A job planted under 'wf:<run>:1'
    # (here while the price was higher) must not become step 2.
    o = db.new_org()
    wf, run, out = start_ok(db, o)
    s0 = db.steps(run)[0][2]
    db.worker(s0, charge=4)
    made = db.su("select result_asset_ids[1]::text from public.creative_jobs where id = %s", [s0])[0][0]
    db.su(I2V_PRICE, [3])
    try:
        planted = db.one("authenticated", o.owner,
                         "select public.create_creative_job(%s, 'i2v', 'vid-i2v', %s::jsonb, 'exact', %s, 15)",
                         [o.org, json.dumps({"source_asset_id": made, "duration_s": 5}), f"wf:{run}:1"])
    finally:
        db.su(I2V_PRICE, [2])
    pj = planted["job"]["id"]
    assert planted["replay"] is False
    assert db.su("select quoted_credits from public.creative_jobs where id = %s", [pj])[0][0] == 15
    out = db.advance(o.editor, run)
    assert out["steps"][1]["job_id"] is None
    assert out["steps"][1]["status"] == "failed" and out["steps"][1]["error_code"] == "idempotency_conflict"
    assert [s["status"] for s in out["steps"]] == ["completed", "failed", "skipped"]
    assert out["run"]["status"] == "failed" and out["run"]["charged_credits"] == 4
    # The planted job is its maker's own: finished at its own price it never reaches the run,
    # and the run can still be read, advanced and cancelled (no CHECK jam).
    db.worker(pj, charge=15)
    assert db.advance(o.editor, run)["run"]["charged_credits"] == 4
    assert db.cancel(o.editor, run)["run"]["status"] == "failed"
    assert db.su("select count(*) from public.workflow_run_steps where job_id = %s", [pj])[0][0] == 0


def test_run_now_refuses_a_first_step_whose_key_was_taken_beforehand(db):
    # The same for step 1: Run now raises the refusal and stores no run (nothing held by the run).
    o = db.new_org()
    wf = flow(db, o)
    run = str(uuid.uuid4())
    db.one("authenticated", o.owner,
           "select public.create_creative_job(%s, 't2i', 'img-a', %s::jsonb, 'exact', %s, 4)",
           [o.org, json.dumps({"prompt": VALUES["idea"]}), f"wf:{run}:0"])
    assert err(lambda: db.start(o.editor, run, wf["id"], wf["version"], VALUES, TOTAL)) == (
        "NS409", "idempotency_conflict")
    assert db.su("select count(*) from public.workflow_runs where id = %s", [run])[0][0] == 0
    assert db.holds(o.org) == (1, 4)  # only the planted job's own hold


def _wait_for_lock_wait(db, fn_name, timeout=10.0):
    import time
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        n = db.su("select count(*) from pg_stat_activity where wait_event_type = 'Lock' and query like %s",
                  [f"%{fn_name}%"])[0][0]
        if n:
            return True
        time.sleep(0.05)
    return False


def _account_is_locked(db, org):
    with psycopg.connect(db.dsn, autocommit=False) as c:
        try:
            c.execute("select 1 from public.credit_accounts where org_id = %s for update nowait", [org])
            return False
        except psycopg.errors.LockNotAvailable:
            return True
        finally:
            c.rollback()


@pytest.mark.parametrize("call", ["advance", "cancel"])
def test_advance_and_cancel_take_the_account_before_the_run_as_run_now_does(db, call):
    # BR-L-005 (lock order): Run now's replay takes the account, then the run. If advance or
    # cancel took the run first and the account second, the two could deadlock. Hold the run
    # row from outside: the call must already hold the account while it waits for the run.
    o = db.new_org()
    wf, run, out = start_ok(db, o)
    db.worker(db.steps(run)[0][2], charge=4)
    holder = psycopg.connect(db.dsn, autocommit=False)
    holder.execute("select 1 from public.workflow_runs where id = %s for update", [run])
    result, errors = [], []

    def go():
        try:
            result.append(getattr(db, call)(o.editor, run))
        except psycopg.Error as e:  # pragma: no cover - would be a bug
            errors.append(e)

    t = threading.Thread(target=go)
    t.start()
    try:
        assert _wait_for_lock_wait(db, f"{call}_workflow_run"), "the call never waited for the run row"
        assert _account_is_locked(db, o.org), "the call waits for the run without holding the account"
    finally:
        holder.rollback()
        holder.close()
        t.join(timeout=30)
    assert not errors and len(result) == 1


def test_run_now_replayed_while_the_page_advances_never_fails_the_run(db):
    # The race itself (best effort: many rounds of a re-sent Run now against the page's advance).
    for _ in range(8):
        o = db.new_org()  # one run per organization: the plan's parallel-run limit is not under test
        wf, run, _ = start_ok(db, o)
        db.worker(db.steps(run)[0][2], charge=4)
        errors = []
        barrier = threading.Barrier(2)

        def replay():
            barrier.wait()
            try:
                db.start(o.editor, run, wf["id"], wf["version"], VALUES, TOTAL)
            except psycopg.Error as e:
                errors.append(e)

        def advance():
            barrier.wait()
            try:
                db.advance(o.editor, run)
            except psycopg.Error as e:
                errors.append(e)

        ts = [threading.Thread(target=replay), threading.Thread(target=advance)]
        [t.start() for t in ts]
        [t.join(timeout=30) for t in ts]
        assert not errors, [e.sqlstate for e in errors]
        steps = db.steps(run)
        assert [s[1] for s in steps] == ["completed", "running", "pending"], steps
        assert db.su("select status from public.workflow_runs where id = %s", [run])[0][0] == "running"


def test_a_transient_error_leaves_the_step_waiting_instead_of_failing_a_paid_run(db):
    # BR-L-005 (handler): a deadlock victim or serialization failure (SQLSTATE class 40) while a
    # step starts is raised, so nothing is committed and the next poll tries again. It must not
    # turn into a failed step and a failed run after earlier steps were already charged.
    o = db.new_org()
    wf, run, out = start_ok(db, o)
    db.worker(db.steps(run)[0][2], charge=4)
    db.su("create or replace function public.lab_transient() returns trigger language plpgsql as $$ "
          "begin raise exception 'lab: could not serialize access' using errcode = '40001'; end $$")
    db.su("create trigger lab_transient before insert on public.creative_jobs "
          "for each row execute function public.lab_transient()")
    try:
        assert err(lambda: db.advance(o.editor, run))[0] == "40001"
    finally:
        db.su("drop trigger lab_transient on public.creative_jobs")
        db.su("drop function public.lab_transient()")
    # The whole poll was rolled back (step 1's settling included): nothing failed, nothing new held.
    assert [s[1] for s in db.steps(run)] == ["running", "pending", "pending"]
    assert db.su("select status from public.workflow_runs where id = %s", [run])[0][0] == "running"
    assert db.holds(o.org) == (0, 0) and db.jobs(o.org) == 1
    out = db.advance(o.editor, run)
    assert [s["status"] for s in out["steps"]] == ["completed", "running", "pending"]
    assert db.holds(o.org) == (1, 10)


@pytest.mark.parametrize("change", ["demoted", "removed"])
def test_a_later_step_does_not_start_once_its_confirmer_may_no_longer_spend(db, change):
    # BR-L-006: the confirmation belongs to the member who pressed Run now. Once they may no
    # longer run things in this organization, a page someone else opens starts nothing more.
    o = db.new_org()
    wf, run, out = start_ok(db, o)  # confirmed by o.editor
    db.worker(db.steps(run)[0][2], charge=4)
    if change == "demoted":
        db.su("update public.org_members set role = 'viewer' where org_id = %s and user_id = %s", [o.org, o.editor])
    else:
        db.su("delete from public.org_members where org_id = %s and user_id = %s", [o.org, o.editor])
    out = db.advance(o.owner, run)
    assert out["steps"][1]["job_id"] is None
    assert out["steps"][1]["status"] == "failed" and out["steps"][1]["error_code"] == "confirmation_revoked"
    assert out["run"]["status"] == "failed" and out["run"]["charged_credits"] == 4
    assert db.holds(o.org) == (0, 0) and db.jobs(o.org) == 1


def test_a_confirmer_who_may_still_spend_lets_another_member_carry_the_run_on(db):
    o = db.new_org()
    wf, run, out = start_ok(db, o)
    db.worker(db.steps(run)[0][2], charge=4)
    # Promoted, not demoted: still allowed.
    db.su("update public.org_members set role = 'admin' where org_id = %s and user_id = %s", [o.org, o.editor])
    out = db.advance(o.owner, run)
    assert [s["status"] for s in out["steps"]] == ["completed", "running", "pending"]
    assert db.holds(o.org) == (1, 10)


def test_a_confirmer_in_another_organization_only_does_not_count(db):
    # Membership elsewhere is not membership here: the check reads the run's own organization.
    a, b = db.new_org(), db.new_org()
    wf, run, out = start_ok(db, a)
    db.worker(db.steps(run)[0][2], charge=4)
    db.su("delete from public.org_members where org_id = %s and user_id = %s", [a.org, a.editor])
    db.su("insert into public.org_members (org_id, user_id, email, role) values (%s, %s, 'x@x.io', 'owner')",
          [b.org, a.editor])
    out = db.advance(a.owner, run)
    assert out["steps"][1]["error_code"] == "confirmation_revoked" and db.jobs(a.org) == 1

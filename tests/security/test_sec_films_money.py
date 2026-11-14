"""Film Studio P2 (migration 0171), attacked in a real database: the price of a film, its one credit hold, and the settle path.

A film is quoted line by line from the backend's own rates (creative_price for every key frame and clip shot, the voice model's rate for
the narration, film_assembly_minute for the assembly), started at that exact quote with one hold of the total, and settled once by the
worker's service calls. What would break without each guard (each test names the guard it pins):

  * who: a viewer neither quotes nor starts; an editor quotes but only an admin starts (0020's rule for a paid run); another
    organization's film reads exactly like a missing one; the browser calls nothing of the worker's, the worker nothing of the browser's;
  * the quote: every line from the backend's rates (no client number), an unpriced model or setting refused by name and never priced 0,
    no Seedance model, a scene longer than the model can shoot, a key-frame model that cannot take every reference, captions excluded
    and said so;
  * the pin: an edited film invalidates its quote (film_changed), a rate that moved does too (price_changed), a forged quote id is
    refused;
  * the start: insufficient credits fail early (NS402) with nothing held or created; one key makes one start, replayed; concurrent
    starts make one hold; the cap and the one-film-at-a-time limit; the hold equals the confirmed total;
  * the settle: a clip is charged by its measured seconds, never above its line; the capture never exceeds the hold; a failure is
    charged 0 and released; moderation is charged only where the vendor bills it; a cancel releases every take that never began;
    an expired hold or a missing worker settles the segment instead of leaving a film "running"; a worker without the lease is refused;
  * the migration: a replay changes nothing, the drift guard refuses a body or a constraint that is not its own, and the rollback
    refuses while a segment is live, takes everything out with its override, and 0171 applies again after it.

Runs in its own scratch database (it commits), with a registry installed through sync_model_registry and real probe rows.
"""

from __future__ import annotations

import json
import os
import threading
import uuid
from decimal import Decimal

import psycopg
import pytest

import sec_db

MIGRATION = sec_db.MIGRATIONS / "0171_films_money.sql"
ROLLBACK = sec_db.REPO / "docs" / "sql" / "rollback_0171_films_money.sql"

# (id, provider, adapter, capabilities, credit unit, credits per unit, spec). Every one is made sellable.
MODELS = [
    ("img-key", "acme", "image.acme", ["t2i", "edit"], "model_img_key_image", 3,
     {"aspect_ratios": ["16:9", "9:16", "1:1"], "inputs": {"image_refs_max": 4}}),
    ("img-norefs", "acme", "image.acme", ["t2i"], "model_img_norefs_image", 3,
     {"aspect_ratios": ["16:9", "9:16", "1:1"], "inputs": {"image_refs_max": 0}}),
    ("vid-clip", "acme", "video.acme", ["t2v", "i2v"], "model_vid_clip_second", 2, {"durations_s": [5, 10], "end_frame": True}),
    ("vid-short", "acme", "video.acme", ["i2v"], "model_vid_short_second", 2, {"durations_s": [5]}),
    ("vid-runway", "runway", "video.runway", ["i2v"], "model_vid_runway_second", 2, {"durations_s": [5, 10]}),
    ("vid-hh", "alibaba", "video.happyhorse", ["i2v"], "model_vid_hh_second", 2, {"durations_s": [5, 10]}),
    # Sellable as far as the registry is concerned: 0166's film_check_model must still refuse it at the quote.
    ("seedance-lab", "acme", "video.acme", ["i2v"], "model_seedance_lab_second", 2, {"durations_s": [5, 10]}),
    ("tts-a", "acme", "audio.acme", ["tts"], "model_tts_a_character", Decimal("0.01"), {}),
]
ASSEMBLY_RATE = 5
JOB_MINIMUM = 1
VOICE = {"source": "creative_tts", "model": "tts-a", "voice_id": "voice_lab_1"}
SETTINGS = {"title": "The lighthouse", "language": "en", "target_seconds": 120, "keyframe_model": "img-key",
            "clip_model": "vid-clip", "voice": VOICE, "captions_mode": "none"}
SCENES = [{"title": "Open", "narration": "It begins.", "visual_prompt": "a lighthouse at dusk", "planned_seconds": 10},
          {"title": "Close", "narration": "It ends.", "planned_seconds": 8, "first_frame": "previous"}]
# key frame 3 (one image) + scene 1 clip 10 s x 2 + scene 2 clip 8 s rounded up to 10 s x 2 + narration 18 characters x 0.01 = 0.18,
# raised to the job minimum of 1 + assembly 18 s = 1 minute x 5.
TOTAL = Decimal("49.00")
LIVE = ("queued", "running", "draining")


def claims(role, user=None):
    c = {"role": role}
    if user:
        c["sub"] = user
    return json.dumps(c)


class Org:
    def __init__(self, org, owner, admin, editor, viewer):
        self.org, self.owner, self.admin, self.editor, self.viewer = org, owner, admin, editor, viewer
        self.image = ""


class Db:
    def __init__(self, dsn):
        self.dsn = dsn
        self.n = 0
        self.keys = 0

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
        return self.act(role, user, q, p)[0][0]

    def asset(self, org, kind="image", mime="image/png"):
        return str(self.su(
            "select public.register_asset(gen_random_uuid(), %s, %s, %s, 1000, %s, 'generated', "
            "p_width => 64, p_height => 64, p_provenance => '{}'::jsonb) ->> 'id'",
            [org, kind, mime, uuid.uuid4().hex * 2])[0][0])

    def new_org(self, credits=100, image=True):
        self.n += 1
        n = self.n
        org = str(uuid.UUID(int=0x170A0000 + n))
        people = [str(uuid.UUID(int=0x170000 + n * 4 + i)) for i in range(4)]
        roles = ("owner", "admin", "editor", "viewer")
        for u, role in zip(people, roles):
            self.su("insert into auth.users (id, email) values (%s, %s)", [u, f"{role}{n}@money.lab"])
        self.su("insert into public.organizations (id, name, slug) values (%s, %s, %s)", [org, f"Money{n}", f"org-money-{n}"])
        for u, role in zip(people, roles):
            self.su("insert into public.org_members (org_id, user_id, email, role) values (%s, %s, %s, %s)",
                    [org, u, f"{role}{n}@money.lab", role])
        if credits:
            self.su("select public.grant_credits(%s, %s, 'test')", [org, credits])
        o = Org(org, *people)
        if image:
            o.image = self.asset(org)
        return o

    def key(self) -> str:
        self.keys += 1
        return f"money-key-{self.keys:06d}"

    # ── a film ready to quote ──────────────────────────────────────────────
    def film(self, o, settings=None, scenes=None):
        f = self.one("authenticated", o.editor, "select public.create_film_draft(%s::uuid, null, 'topic', %s, %s::jsonb, %s)",
                     [o.org, "A lighthouse keeper's last night", json.dumps(SETTINGS if settings is None else settings), self.key()])
        fid = f["film"]["id"]
        self.save(o.editor, fid, 1, {"scenes": SCENES if scenes is None else scenes})
        return fid

    def save(self, who, film, version, patch):
        return self.one("authenticated", who, "select public.save_film(%s::uuid, %s::integer, %s::jsonb)",
                        [film, version, json.dumps(patch)])

    def version(self, film):
        return self.su("select version from public.films where id = %s", [film])[0][0]

    # ── the calls under test ────────────────────────────────────────────────
    def quote(self, who, film, version=None):
        return self.one("authenticated", who, "select public.quote_film(%s::uuid, %s::integer)",
                        [film, self.version(film) if version is None else version])

    def start(self, who, film, quote_id, key=None):
        return self.one("authenticated", who, "select public.start_film(%s::uuid, %s, %s)", [film, quote_id, key or self.key()])

    def svc(self, q, p=None):
        return self.one("service_role", None, q, p)

    def quoted_start(self, o, film):
        return self.start(o.admin, film, self.quote(o.editor, film)["quote_id"])

    # ── ground truth ────────────────────────────────────────────────────────
    def account(self, org):
        r = self.su("select balance, reserved from public.credit_accounts where org_id = %s", [org])
        return (r[0][0], r[0][1]) if r else (Decimal(0), Decimal(0))

    def holds(self, org):
        return self.su("select job_id, amount, status, captured from public.credit_reservations where org_id = %s order by created_at",
                       [org])

    def ledger(self, org, kind):
        return [r[0] for r in self.su("select amount from public.credit_transactions where org_id = %s and kind = %s order by id",
                                      [org, kind])]

    def takes(self, segment):
        return self.su("select t.id, t.kind, t.scene_id, t.shot_index, t.status, t.confirmed_credits, t.charged_credits, "
                       "t.charge_basis, t.quantity from public.film_takes t left join public.film_scenes s on s.id = t.scene_id "
                       "where t.segment_id = %s order by s.position nulls last, t.shot_index", [segment])

    def film_row(self, film):
        return self.su("select status, pause_reason from public.films where id = %s", [film])[0]

    def segment(self, segment):
        return self.su("select status, captured_credits, settle_reason, credit_ref, confirmed_credits from public.film_segments "
                       "where id = %s", [segment])[0]

    def events(self, film):
        return [r[0] for r in self.su("select event from public.film_events where film_id = %s order by id", [film])]

    def spend_rate(self, user, bucket, used):
        self.su("insert into public.web_rate_counters (user_id, bucket, window_start, count) "
                "values (%s, %s, to_timestamp(floor(extract(epoch from now()) / 3600) * 3600), %s) "
                "on conflict (user_id, bucket, window_start) do update set count = excluded.count",
                [user, f"db.film.{bucket}@3600", used])

    # ── the worker ──────────────────────────────────────────────────────────
    def claim(self, worker="w-1"):
        return self.svc("select public.film_claim_segment(%s)", [worker])

    def begin(self, take, worker="w-1"):
        return self.svc("select public.film_begin_take(%s, %s)", [take, worker])

    def succeed(self, take, seconds, asset, worker="w-1"):
        return self.svc("select public.film_take_succeeded(%s::uuid, %s, %s::numeric, %s::uuid)", [take, worker, seconds, asset])

    def fail(self, take, failure, worker="w-1", code="vendor_refused"):
        return self.svc("select public.film_take_failed(%s, %s, %s, %s, 'refused by the vendor')", [take, worker, failure, code])

    def settle(self, segment, reason, worker="w-1"):
        return self.svc("select public.film_settle_segment(%s, %s, %s)", [segment, worker, reason])

    def cancel(self, segment, reason="cancelled"):
        return self.svc("select public.film_cancel_segment(%s, %s)", [segment, reason])

    def finish_all(self, o, segment, worker="w-1", seconds=None):
        """Every planned take of the segment made, each clip at `seconds` (its own planned length by default)."""
        out = {}
        for tid, kind, _sid, _shot, status, *_rest, qty in self.takes(segment):
            if status != "planned":
                continue
            self.begin(tid, worker)
            kind_ = {"keyframe": ("image", "image/png"), "narration": ("audio", "audio/mpeg")}.get(kind, ("video", "video/mp4"))
            asset = self.asset(o.org, *kind_)
            out[tid] = self.succeed(tid, (seconds or qty) if kind in ("clip", "extend") else None, asset, worker)
        return out


@pytest.fixture(scope="module")
def db():
    admin = sec_db.admin_dsn()
    if not admin:
        if os.environ.get("NIGHTSHIFT_SECURITY_REQUIRED"):
            pytest.fail(f"{sec_db.DSN_ENV} is not set", pytrace=False)
        pytest.skip(f"{sec_db.DSN_ENV} is not set — the security lab needs a scratch Postgres")
    name = f"ns_film_money_{uuid.uuid4().hex[:8]}"
    d = Db(sec_db.build(admin, name))
    rows = [{"id": m, "display_name": m, "provider": prov, "adapter": a, "capabilities": caps, "credit_unit": unit,
             "entitlement": "any", "spec": {"vendor_model": "acme-" + m, "output": a.split(".")[0], **spec}}
            for m, prov, a, caps, unit, _rate, spec in MODELS]
    d.su("select public.sync_model_registry(%s::jsonb)", [json.dumps(rows)])
    for m, _prov, a, caps, unit, rate, _spec in MODELS:
        d.su("insert into public.credit_prices (unit, credits_per_unit, margin) values (%s, %s, 0) "
             "on conflict (unit) do update set credits_per_unit = excluded.credits_per_unit, margin = 0", [unit, rate])
        d.su("select public.record_model_probe(%s, %s, %s, %s, true, null, null, 10, 100, 'security-lab')",
             [m, a, "acme-" + m, caps[-1]])
        d.su("update public.model_registry set availability = 'beta' where id = %s", [m])
    d.su("insert into public.credit_prices (unit, credits_per_unit, margin) values ('film_assembly_minute', %s, 0), "
         "('job_minimum', %s, 0) on conflict (unit) do update set credits_per_unit = excluded.credits_per_unit",
         [ASSEMBLY_RATE, JOB_MINIMUM])
    sellable = {r[0] for r in d.su("select id from public.sellable_models(null, 'web')")}
    assert sellable >= {m[0] for m in MODELS}, sellable
    try:
        yield d
    finally:
        if not os.environ.get("NIGHTSHIFT_SECURITY_KEEP"):
            sec_db.drop_database(admin, name)


@pytest.fixture(autouse=True)
def no_live_segment(db):
    """Every test starts with no live segment in the module's database: film_claim_segment takes the oldest across organizations,
    so one test's queued film must never be claimed by the next. What is in flight is failed (charged 0), then cancelled."""
    db.su("update public.film_takes set status = 'failed', charged_credits = 0, charge_basis = 'lab_reset', finished_at = now() "
          "where status = 'running' and segment_id is not null")
    db.su("update public.film_segments set assembly_status = 'failed', assembly_charged_credits = 0 where assembly_status = 'running'")
    for (sid,) in db.su("select id from public.film_segments where status in ('queued', 'running', 'draining')"):
        db.svc("select public.film_cancel_segment(%s, 'cancelled')", [sid])
    yield


@pytest.fixture
def a(db):
    return db.new_org()


@pytest.fixture
def b(db):
    return db.new_org()


def err(fn):
    with pytest.raises(psycopg.Error) as e:
        fn()
    return e.value.sqlstate, str(e.value).splitlines()[0], (e.value.diag.message_detail or "")


def reasons(q):
    return {r["reason"] for r in q["refusals"]}


# ── who may quote and start ─────────────────────────────────────────────────

def test_a_viewer_can_neither_quote_nor_start(db, a):
    fid = db.film(a)
    qid = db.quote(a.editor, fid)["quote_id"]
    assert err(lambda: db.quote(a.viewer, fid))[:2] == ("42501", "forbidden")
    assert err(lambda: db.start(a.viewer, fid, qid))[:2] == ("42501", "forbidden")
    assert db.holds(a.org) == [] and db.film_row(fid)[0] == "draft"


def test_an_editor_quotes_but_only_an_admin_or_owner_starts(db, a):
    fid = db.film(a)
    q = db.quote(a.editor, fid)
    assert q["may_start"] is False and q["startable"] is False
    assert err(lambda: db.start(a.editor, fid, q["quote_id"]))[:2] == ("42501", "forbidden")
    assert db.quote(a.admin, fid)["startable"] is True
    seg = db.start(a.owner, fid, q["quote_id"])
    assert seg["status"] == "queued"


def test_another_organizations_film_reads_as_not_found(db, a, b):
    fid = db.film(a)
    qid = db.quote(a.editor, fid)["quote_id"]
    missing = str(uuid.uuid4())
    for who in (b.owner, b.admin, b.editor, b.viewer):
        assert err(lambda: db.quote(who, fid, 2)) == err(lambda: db.quote(who, missing, 2)) == ("P0002", "not_found", "")
        assert err(lambda: db.start(who, fid, qid)) == err(lambda: db.start(who, missing, qid)) == ("P0002", "not_found", "")
    seg = db.start(a.admin, fid, qid)
    for t in ("film_segments", "org_film_settings"):
        assert db.one("authenticated", b.owner, f"select count(*) from public.{t} where org_id = %s", [a.org]) == 0, t
    assert db.one("authenticated", a.viewer, "select count(*) from public.film_segments where id = %s", [seg["id"]]) == 1
    assert db.one("authenticated", b.owner, "select count(*) from public.film_takes where segment_id = %s", [seg["id"]]) == 0


def test_a_call_without_a_signed_in_user_is_refused(db, a):
    fid = db.film(a)
    for q, p in (("select public.quote_film(%s::uuid, 2)", [fid]), ("select public.start_film(%s::uuid, %s, 'nobody-key-01')",
                                                                      [fid, "fq-2-" + "0" * 32])):
        with pytest.raises(psycopg.Error) as e:
            db.act("authenticated", None, q, p)
        assert e.value.sqlstate == "42501", q


@pytest.mark.parametrize("role", ["anon", "service_role"])
def test_the_anon_key_and_the_service_role_call_neither_browser_function(db, a, role):
    fid = db.film(a)
    for q, p in (("select public.quote_film(%s::uuid, 2)", [fid]),
                 ("select public.start_film(%s::uuid, %s, 'service-key-01')", [fid, "fq-2-" + "0" * 32])):
        with pytest.raises(psycopg.Error) as e:
            db.act(role, None, q, p)
        assert e.value.sqlstate == "42501" and "permission denied" in str(e.value), q


WORKER_CALLS = [
    ("select public.film_claim_segment('w-x')", []),
    ("select public.film_heartbeat_segment(%s::uuid, 'w-x')", ["seg"]),
    ("select public.film_begin_take(%s::uuid, 'w-x')", ["seg"]),
    ("select public.film_take_succeeded(%s::uuid, 'w-x', 5, %s::uuid)", ["seg", "seg"]),
    ("select public.film_take_failed(%s::uuid, 'w-x', 'provider_error', 'x')", ["seg"]),
    ("select public.film_begin_assembly(%s::uuid, 'w-x')", ["seg"]),
    ("select public.film_record_assembly(%s::uuid, 'w-x', true, 60)", ["seg"]),
    ("select public.film_settle_segment(%s::uuid, 'w-x', 'cancelled')", ["seg"]),
    ("select public.film_cancel_segment(%s::uuid, 'cancelled')", ["seg"]),
    ("select public.film_expire_segments()", []),
    ("select public.film_price(f) from public.films f limit 1", []),
    ("select public.film_settle_locked(%s::uuid, %s::uuid, 'cancelled')", ["seg", "seg"]),
]


@pytest.mark.parametrize("role", ["authenticated", "anon"])
def test_no_browser_reaches_the_workers_state_machine(db, a, role):
    fid = db.film(a)
    seg = db.quoted_start(a, fid)["id"]
    for q, p in WORKER_CALLS:
        with pytest.raises(psycopg.Error) as e:
            db.act(role, a.owner if role == "authenticated" else None, q, [seg for _ in p])
        assert e.value.sqlstate == "42501" and "permission denied" in str(e.value), q
    assert db.segment(seg)[0] == "queued"


@pytest.mark.parametrize("role", ["authenticated", "anon", "service_role"])
def test_no_api_role_writes_a_segment_a_setting_a_take_or_a_film_creative_job(db, a, role):
    fid = db.film(a)
    seg = db.quoted_start(a, fid)["id"]
    take = db.takes(seg)[0][0]
    who = a.owner if role == "authenticated" else None
    attacks = [
        f"update public.film_segments set captured_credits = 0, status = 'released', settled_at = now() where id = '{seg}'",
        f"delete from public.film_segments where id = '{seg}'",
        f"insert into public.org_film_settings (org_id, max_active_films) values ('{a.org}', 10)",
        f"update public.film_takes set charged_credits = 0, charge_basis = 'x', status = 'failed' where id = '{take}'",
        "insert into public.creative_jobs (org_id, capability, requested_model, payer, film_take_id) "
        f"values ('{a.org}', 'i2v', 'vid-clip', 'film', '{take}')",
    ]
    for q in attacks:
        with pytest.raises(psycopg.Error) as e:
            db.act(role, who, q)
        assert e.value.sqlstate == "42501", q
    assert db.segment(seg)[0] == "queued"


def test_a_film_creative_job_names_its_take_and_holds_nothing_of_its_own(db, a):
    """Even the database owner cannot write payer 'film' without a take, or with a hold of its own: the segment is the only hold."""
    fid = db.film(a)
    take = db.takes(db.quoted_start(a, fid)["id"])[0][0]
    base = "insert into public.creative_jobs (org_id, capability, requested_model, payer, film_take_id, credit_ref) values (%s, 'i2v', 'vid-clip', %s, %s, %s)"
    for payer, t, ref in (("film", None, None), ("film", take, "cj:steal-1"), ("credits", take, None)):
        with pytest.raises(psycopg.Error) as e:
            db.su(base, [a.org, payer, t, ref])
        assert e.value.sqlstate == "23514", (payer, t, ref)
    with psycopg.connect(db.dsn, autocommit=False) as c:
        c.execute(base, [a.org, "film", take, None])  # the one shape it may take (P3's worker writes it); not kept
        c.rollback()


# ── the quote ───────────────────────────────────────────────────────────────

def test_the_quote_prices_every_line_from_the_backends_own_rates(db, a):
    fid = db.film(a)
    q = db.quote(a.editor, fid)
    assert q["priced"] is True and Decimal(str(q["total"])) == TOTAL, q
    lines = [(ln["line"], ln["shot_index"], Decimal(str(ln["credits"]))) for ln in q["lines"]]
    assert lines == [("keyframe", 0, 3), ("clip", 1, 20), ("clip", 1, 20), ("narration", 0, 1), ("assembly", None, 5)], lines
    clip2 = q["lines"][2]
    assert (clip2["duration_s"], clip2["quantity"], clip2["unit"]) == (10, 10, "model_vid_clip_second")
    assert Decimal(str(q["lines"][3]["quantity"])) == 18 and q["lines"][3]["minimum"] == 1
    assert [Decimal(str(s["credits"])) for s in q["scenes"]] == [23, 20]
    assert q["quote_id"].startswith(f"fq-{db.version(fid)}-") and q["refusals"] == [] and q["excluded"] == []
    assert Decimal(str(q["available"])) == 100 and q["blocked_by"] == []
    assert db.holds(a.org) == []


def test_a_seedance_model_is_refused_at_the_quote_even_when_it_is_already_saved(db, a):
    fid = db.film(a)
    db.su("update public.films set clip_model = 'seedance-lab' where id = %s", [fid])
    q = db.quote(a.editor, fid)
    assert q["priced"] is False and q["total"] is None and q["quote_id"] is None
    assert reasons(q) == {"model_not_offered"} and all(ln["credits"] is None for ln in q["lines"] if ln["line"] == "clip")
    db.su("update public.films set clip_model = 'vid-clip' where id = %s", [fid])
    db.su("update public.film_scenes set clip_model = 'seedance-lab' where film_id = %s and position = 1", [fid])
    assert reasons(db.quote(a.editor, fid)) == {"model_not_offered"}


def test_an_unpriced_model_or_setting_is_refused_never_priced_zero(db, a):
    fid = db.film(a)
    try:
        db.su("delete from public.credit_prices where unit = 'film_assembly_minute'")
        q = db.quote(a.editor, fid)
        asm = [ln for ln in q["lines"] if ln["line"] == "assembly"][0]
        assert (asm["priced"], asm["credits"], asm["reason"]) == (False, None, "unpriced")
        assert q["total"] is None and q["quote_id"] is None and q["priced"] is False
    finally:
        db.su("insert into public.credit_prices (unit, credits_per_unit, margin) values ('film_assembly_minute', %s, 0) "
              "on conflict (unit) do nothing", [ASSEMBLY_RATE])
    # A setting the model has no price for (a resolution variant it does not list) is refused by creative_price, named.
    db.su("update public.film_scenes set clip_params = '{\"resolution\": \"1080p\"}' where film_id = %s and position = 0", [fid])
    q = db.quote(a.editor, fid)
    bad = [ln for ln in q["lines"] if not ln["priced"]]
    assert len(bad) == 1 and bad[0]["credits"] is None and bad[0]["reason"] == "invalid_params" and q["total"] is None
    db.su("update public.film_scenes set clip_params = '{}' where film_id = %s", [fid])
    # A model whose price row is gone is not on sale: refused, never 0.
    try:
        db.su("update public.credit_prices set unit = 'model_vid_clip_second_off' where unit = 'model_vid_clip_second'")
        q = db.quote(a.editor, fid)
        assert q["total"] is None and {ln["reason"] for ln in q["lines"] if ln["line"] == "clip"} <= {"model_not_available", "unpriced"}
        assert all(ln["credits"] is None for ln in q["lines"] if ln["line"] == "clip")
    finally:
        db.su("update public.credit_prices set unit = 'model_vid_clip_second' where unit = 'model_vid_clip_second_off'")
    # And a start against an unpriced film is refused with the line's own word, holding nothing.
    qid = db.quote(a.editor, fid)["quote_id"]
    try:
        db.su("delete from public.credit_prices where unit = 'film_assembly_minute'")
        assert err(lambda: db.start(a.admin, fid, qid))[:2] == ("NS400", "unpriced")
    finally:
        db.su("insert into public.credit_prices (unit, credits_per_unit, margin) values ('film_assembly_minute', %s, 0) "
              "on conflict (unit) do nothing", [ASSEMBLY_RATE])
    assert db.holds(a.org) == []


def test_a_clip_with_no_picture_to_price_against_is_unpriced_not_zero(db):
    o = db.new_org(image=False)
    fid = db.film(o)
    q = db.quote(o.editor, fid)
    assert q["total"] is None and {ln["reason"] for ln in q["lines"] if ln["line"] == "clip"} == {"source_unavailable"}


def test_a_scene_longer_than_the_model_can_shoot_is_refused_by_name(db, a):
    fid = db.film(a, settings={**SETTINGS, "clip_model": "vid-short"})
    q = db.quote(a.editor, fid)
    assert reasons(q) == {"scene_too_long_for_model"} and "more shots" in q["refusals"][0]["detail"]
    db.save(a.editor, fid, db.version(fid), {"scenes": [{**SCENES[0], "shot_count": 2}, {**SCENES[1], "shot_count": 2}]})
    q = db.quote(a.editor, fid)
    assert q["priced"] is True
    assert [(ln["line"], ln["shot_index"], ln["duration_s"]) for ln in q["lines"] if ln["line"] in ("clip", "extend")] == \
        [("clip", 1, 5), ("extend", 2, 5), ("clip", 1, 5), ("extend", 2, 5)]


def test_a_key_frame_model_that_cannot_take_every_reference_is_refused_never_handed_fewer(db, a):
    fid = db.film(a, settings={**SETTINGS, "keyframe_model": "img-norefs"})
    assert db.quote(a.editor, fid)["priced"] is True
    db.save(a.editor, fid, db.version(fid), {"refs": [{"kind": "style", "asset_id": a.image}]})
    q = db.quote(a.editor, fid)
    assert reasons(q) == {"refs_not_supported"} and q["total"] is None


def test_captions_are_excluded_from_the_price_and_the_quote_says_so(db, a):
    fid = db.film(a, settings={**SETTINGS, "captions_mode": "sidecar"})
    q = db.quote(a.editor, fid)
    assert q["priced"] is True and Decimal(str(q["total"])) == TOTAL
    assert [(e["line"], e["reason"]) for e in q["excluded"]] == [("captions", "priced_after_narration")]
    assert not [ln for ln in q["lines"] if ln["line"] == "captions"]


def test_a_film_with_narration_and_no_voice_is_not_priced(db, a):
    fid = db.film(a, settings={k: v for k, v in SETTINGS.items() if k != "voice"})
    assert reasons(db.quote(a.editor, fid)) == {"voice_not_set"}


# ── the pin ─────────────────────────────────────────────────────────────────

def test_an_edited_film_invalidates_its_quote(db, a):
    fid = db.film(a)
    qid = db.quote(a.editor, fid)["quote_id"]
    db.save(a.editor, fid, db.version(fid), {"title": "A new title"})
    code, word, detail = err(lambda: db.start(a.admin, fid, qid))
    assert (code, word) == ("NS409", "film_changed") and "quote it again" in detail
    assert err(lambda: db.quote(a.editor, fid, db.version(fid) - 1))[:2] == ("NS409", "film_changed")
    assert db.holds(a.org) == [] and db.film_row(fid)[0] == "draft"
    assert db.start(a.admin, fid, db.quote(a.editor, fid)["quote_id"])["status"] == "queued"


def test_a_stale_quote_is_refused_when_a_rate_moves_and_a_forged_one_always(db, a):
    fid = db.film(a)
    qid = db.quote(a.editor, fid)["quote_id"]
    try:
        db.su("update public.credit_prices set credits_per_unit = 3 where unit = 'model_vid_clip_second'")
        code, word, detail = err(lambda: db.start(a.admin, fid, qid))
        assert (code, word) == ("NS409", "price_changed") and "69" in detail, detail
    finally:
        db.su("update public.credit_prices set credits_per_unit = 2 where unit = 'model_vid_clip_second'")
    forged = qid[:-32] + "0" * 32
    assert err(lambda: db.start(a.admin, fid, forged))[:2] == ("NS409", "price_changed")
    assert err(lambda: db.start(a.admin, fid, "49 credits please"))[:2] == ("NS400", "invalid_params")
    assert db.holds(a.org) == []
    assert db.start(a.admin, fid, qid)["confirmed_credits"] == TOTAL


# ── the start ───────────────────────────────────────────────────────────────

def test_insufficient_credits_fail_early_with_nothing_held_or_created(db):
    o = db.new_org(credits=40)
    fid = db.film(o)
    q = db.quote(o.editor, fid)
    assert [r["reason"] for r in q["blocked_by"]] == ["insufficient_credits"] and q["startable"] is False
    before = db.account(o.org)
    code, word, detail = err(lambda: db.start(o.admin, fid, q["quote_id"]))
    assert (code, word) == ("NS402", "insufficient credits") and "available=40" in detail and "needed=49" in detail, detail
    assert db.account(o.org) == before and db.holds(o.org) == []
    assert db.su("select count(*) from public.film_segments where film_id = %s", [fid])[0][0] == 0
    assert db.su("select count(*) from public.film_takes where film_id = %s", [fid])[0][0] == 0
    assert db.film_row(fid)[0] == "draft" and "started" not in db.events(fid)


def test_start_holds_the_confirmed_total_once_and_plans_every_take(db, a):
    fid = db.film(a)
    seg = db.quoted_start(a, fid)
    assert seg["status"] == "queued" and seg["confirmed_credits"] == TOTAL and seg["replayed"] is False
    assert db.holds(a.org) == [(seg["credit_ref"], TOTAL, "open", None)]
    assert seg["credit_ref"] == "fm-" + seg["id"].replace("-", "")
    assert db.account(a.org) == (Decimal(100), TOTAL)
    takes = db.takes(seg["id"])
    assert [(t[1], t[3], t[4]) for t in takes] == [("keyframe", 0, "planned"), ("clip", 1, "planned"), ("clip", 1, "planned"),
                                                    ("narration", 0, "planned")]
    assert sum(t[5] for t in takes) + Decimal(str(seg["assembly"]["confirmed_credits"])) == TOTAL
    assert db.film_row(fid)[0] == "queued" and db.events(fid)[-1] == "started"
    # A queued film is no longer a draft: it cannot be edited, quoted again or started a second time.
    assert err(lambda: db.save(a.editor, fid, db.version(fid), {"title": "x"}))[:2] == ("NS409", "film_not_editable")
    assert err(lambda: db.quote(a.editor, fid))[:2] == ("NS409", "film_not_editable")


def test_a_double_start_with_one_key_makes_one_start_and_a_reused_key_is_a_conflict(db, a):
    fid, other = db.film(a), db.film(a)
    qid, key = db.quote(a.editor, fid)["quote_id"], db.key()
    first = db.start(a.admin, fid, qid, key)
    again = db.start(a.owner, fid, qid, key)
    assert again["id"] == first["id"] and again["replayed"] is True
    assert len(db.holds(a.org)) == 1 and db.events(fid).count("started") == 1
    code, word, _ = err(lambda: db.start(a.admin, other, db.quote(a.editor, other)["quote_id"], key))
    assert (code, word) == ("NS409", "idempotency_conflict")
    assert err(lambda: db.start(a.admin, fid, qid))[:2] == ("NS409", "film_not_startable")
    for bad in ("short", "has space in it", "x" * 129):
        assert err(lambda: db.start(a.admin, fid, qid, bad))[:2] == ("NS400", "invalid_idempotency_key")


@pytest.mark.parametrize("same_key", [True, False])
def test_concurrent_starts_make_one_hold(db, same_key):
    o = db.new_org(credits=1000)
    fid = db.film(o)
    qid = db.quote(o.editor, fid)["quote_id"]
    keys = [db.key()] * 4 if same_key else [db.key() for _ in range(4)]
    ok, refused, gate = [], [], threading.Barrier(4)

    def go(k):
        gate.wait()
        try:
            ok.append(db.start(o.admin, fid, qid, k)["id"])
        except psycopg.Error as e:
            refused.append((e.sqlstate, str(e).splitlines()[0]))

    threads = [threading.Thread(target=go, args=(k,)) for k in keys]
    [t.start() for t in threads]
    [t.join() for t in threads]
    assert len(set(ok)) == 1, (ok, refused)
    assert len(ok) == (4 if same_key else 1) and refused == ([] if same_key else [("NS409", "film_not_startable")] * 3)
    assert len(db.holds(o.org)) == 1 and db.account(o.org)[1] == TOTAL
    assert db.su("select count(*) from public.film_segments where film_id = %s", [fid])[0][0] == 1


def test_two_films_at_once_are_refused_by_the_default_limit_and_the_cap_refuses_a_dear_film(db):
    o = db.new_org(credits=1000)
    f1, f2 = db.film(o), db.film(o)
    q2 = db.quote(o.editor, f2)["quote_id"]
    db.quoted_start(o, f1)
    assert [r["reason"] for r in db.quote(o.editor, f2)["blocked_by"]] == ["limit_reached", "run_slots_full"]
    assert err(lambda: db.start(o.admin, f2, q2))[:2] == ("NS400", "limit_reached")
    db.su("insert into public.org_film_settings (org_id, max_credits_per_film, max_active_films) values (%s, 48, 2)", [o.org])
    assert err(lambda: db.start(o.admin, f2, q2))[:2] == ("NS400", "cap_exceeded")
    db.su("update public.org_film_settings set max_credits_per_film = 49 where org_id = %s", [o.org])
    # The plan's one parallel run (0034) is the film already running: reserve_credits refuses the second hold.
    code, word, _ = err(lambda: db.start(o.admin, f2, q2))
    assert (code, word) == ("NS429", "parallel run limit reached")
    assert len(db.holds(o.org)) == 1


def test_start_is_rate_limited_in_the_database(db, a):
    fid = db.film(a)
    qid = db.quote(a.editor, fid)["quote_id"]
    db.spend_rate(a.admin, "start", 10)
    assert err(lambda: db.start(a.admin, fid, qid))[:2] == ("NS429", "rate_limited")
    db.spend_rate(a.editor, "quote", 120)
    assert err(lambda: db.quote(a.editor, fid))[:2] == ("NS429", "rate_limited")
    assert db.holds(a.org) == []


# ── the settle ──────────────────────────────────────────────────────────────

def test_a_whole_film_settles_once_at_what_it_charged_and_the_film_is_ready(db, a):
    fid = db.film(a)
    seg = db.quoted_start(a, fid)
    claimed = db.claim()
    assert claimed["id"] == seg["id"] and claimed["status"] == "running" and len(claimed["takes_list"]) == 4
    assert db.holds(a.org)[0][2] == "open" and db.film_row(fid)[0] == "running"
    db.finish_all(a, seg["id"])
    assert err(lambda: db.settle(seg["id"], "completed"))[:2] == ("NS409", "not_complete")  # the assembly has not run
    db.svc("select public.film_begin_assembly(%s, 'w-1')", [seg["id"]])
    db.svc("select public.film_record_assembly(%s, 'w-1', true, 18.4)", [seg["id"]])
    out = db.settle(seg["id"], "completed")
    assert out["settled"] is True and out["status"] == "settled" and out["captured_credits"] == TOTAL
    assert db.ledger(a.org, "capture") == [-TOTAL] and db.account(a.org) == (Decimal(100) - TOTAL, 0)
    assert db.film_row(fid) == ("ready", None)
    again = db.settle(seg["id"], "completed")
    assert again["captured_credits"] == TOTAL and db.ledger(a.org, "capture") == [-TOTAL]


def test_a_clip_is_charged_by_its_measured_seconds_and_never_above_its_line(db, a):
    fid = db.film(a)
    seg = db.quoted_start(a, fid)
    db.claim()
    takes = db.takes(seg["id"])
    clips = [t[0] for t in takes if t[1] == "clip"]
    for tid in clips:
        db.begin(tid)
    short = db.succeed(clips[0], 7.5, db.asset(a.org, "video", "video/mp4"))
    long_ = db.succeed(clips[1], 14, db.asset(a.org, "video", "video/mp4"))
    assert (short["charged_credits"], short["charge_basis"]) == (15, "output_seconds")
    assert (long_["charged_credits"], long_["confirmed_credits"]) == (20, 20)
    # Even the database owner cannot record a charge above the line.
    with pytest.raises(psycopg.Error) as e:
        db.su("update public.film_takes set charged_credits = 21 where id = %s", [clips[1]])
    assert e.value.sqlstate == "23514"
    # A clip result without its measured seconds is refused: a default is never a measurement.
    other = [t[0] for t in takes if t[1] == "keyframe"][0]
    db.begin(other)
    db.succeed(other, None, db.asset(a.org))
    assert db.takes(seg["id"])[0][6] == 3
    out = db.cancel(seg["id"])
    assert out["captured_credits"] == Decimal(38) and db.ledger(a.org, "capture") == [Decimal(-38)]
    assert db.holds(a.org)[0][1:] == (TOTAL, "captured", Decimal(38))


def test_a_clip_result_without_measured_seconds_or_of_the_wrong_kind_is_refused(db, a):
    fid = db.film(a)
    seg = db.quoted_start(a, fid)
    db.claim()
    clip = [t[0] for t in db.takes(seg["id"]) if t[1] == "clip"][0]
    db.begin(clip)
    video = db.asset(a.org, "video", "video/mp4")
    code, word, detail = err(lambda: db.succeed(clip, None, video))
    assert (code, word) == ("NS400", "invalid_params") and "output_seconds" in detail
    assert err(lambda: db.succeed(clip, 10, a.image))[:2] == ("NS400", "invalid_params")
    other = db.new_org().org
    assert err(lambda: db.succeed(clip, 10, db.asset(other, "video", "video/mp4")))[:2] == ("NS400", "invalid_params")


def test_a_failure_is_charged_nothing_and_its_share_is_released(db, a):
    fid = db.film(a)
    seg = db.quoted_start(a, fid)
    db.claim()
    takes = db.takes(seg["id"])
    kf, clip = takes[0][0], takes[1][0]
    db.begin(kf)
    db.succeed(kf, None, db.asset(a.org))
    db.begin(clip)
    failed = db.fail(clip, "provider_error")
    assert (failed["status"], failed["charged_credits"], failed["charge_basis"]) == ("failed", 0, "failed_not_charged")
    assert db.fail(clip, "provider_error")["charged_credits"] == 0  # a retried call answers as it is
    out = db.settle(seg["id"], "take_failed")
    assert out["status"] == "settled" and out["captured_credits"] == 3
    assert db.ledger(a.org, "capture") == [Decimal(-3)] and db.ledger(a.org, "release")[-1] == TOTAL - 3
    assert db.account(a.org) == (Decimal(97), 0)
    assert db.film_row(fid) == ("paused", "take_failed")
    assert {t[4] for t in db.takes(seg["id"])[2:]} == {"skipped"}


@pytest.mark.parametrize("model,charged,basis", [
    ("vid-runway", 20, "moderated_vendor_billed"),
    ("vid-hh", 0, "moderated_vendor_not_billed"),
    ("vid-clip", 0, "moderated_vendor_billing_unknown"),
])
def test_moderation_is_charged_only_where_the_vendor_bills_it(db, a, model, charged, basis):
    fid = db.film(a, settings={**SETTINGS, "clip_model": model})
    seg = db.quoted_start(a, fid)
    db.claim()
    clip = [t[0] for t in db.takes(seg["id"]) if t[1] == "clip"][0]
    planned = [t[0] for t in db.takes(seg["id"]) if t[1] == "keyframe"][0]
    # A take that never reached the vendor cannot have been moderated.
    assert err(lambda: db.fail(planned, "moderated"))[:2] == ("NS409", "take_not_running")
    db.begin(clip)
    out = db.fail(clip, "moderated", code="policy")
    assert (out["charged_credits"], out["charge_basis"]) == (charged, basis)
    settled = db.settle(seg["id"], "moderated")
    assert settled["captured_credits"] == charged and settled["status"] == ("settled" if charged else "released")
    assert db.ledger(a.org, "capture") == ([Decimal(-charged)] if charged else [])


def test_cancel_releases_every_hold_that_never_started(db, a):
    fid = db.film(a)
    seg = db.quoted_start(a, fid)
    out = db.cancel(seg["id"])
    assert (out["status"], out["captured_credits"], out["settled"]) == ("released", 0, True)
    assert db.holds(a.org)[0][2] == "released" and db.account(a.org) == (Decimal(100), 0)
    assert db.ledger(a.org, "capture") == [] and db.film_row(fid) == ("cancelled", None)
    assert {(t[4], t[6], t[7]) for t in db.takes(seg["id"])} == {("skipped", 0, "cancelled_before_start")}
    assert db.claim() is None  # nothing left to claim
    assert db.cancel(seg["id"])["status"] == "released"  # idempotent


def test_cancel_waits_for_a_take_in_flight_then_releases_the_rest(db, a):
    fid = db.film(a)
    seg = db.quoted_start(a, fid)
    db.claim()
    clip = [t[0] for t in db.takes(seg["id"]) if t[1] == "clip"][0]
    db.begin(clip)
    out = db.cancel(seg["id"])
    assert (out["status"], out["settled"]) == ("draining", False) and db.film_row(fid)[0] == "draining"
    # Nothing new begins once the segment drains.
    kf = [t[0] for t in db.takes(seg["id"]) if t[1] == "keyframe"][0]
    assert db.takes(seg["id"])[0][4] == "skipped"
    assert err(lambda: db.begin(kf))[:2] == ("NS409", "not_running")
    assert db.holds(a.org)[0][2] == "open"
    db.succeed(clip, 10, db.asset(a.org, "video", "video/mp4"))
    out = db.settle(seg["id"], "cancelled")
    assert (out["status"], out["captured_credits"]) == ("settled", 20)
    assert db.account(a.org) == (Decimal(80), 0) and db.film_row(fid) == ("cancelled", None)


def test_a_worker_without_the_lease_is_refused(db, a):
    fid = db.film(a)
    seg = db.quoted_start(a, fid)
    db.claim("w-1")
    take = db.takes(seg["id"])[0][0]
    assert err(lambda: db.begin(take, "w-2"))[:2] == ("NS409", "lease_lost")
    assert err(lambda: db.settle(seg["id"], "cancelled", "w-2"))[:2] == ("NS409", "lease_lost")
    assert db.svc("select public.film_heartbeat_segment(%s, 'w-2')", [seg["id"]]) is False
    assert db.svc("select public.film_heartbeat_segment(%s, 'w-1')", [seg["id"]]) is True
    # A lease that stopped beating is taken over, and the old worker is then refused.
    db.su("update public.film_segments set heartbeat_at = now() - interval '11 minutes' where id = %s", [seg["id"]])
    assert db.claim("w-2")["worker_id"] == "w-2"
    assert err(lambda: db.begin(take, "w-1"))[:2] == ("NS409", "lease_lost")


def test_a_hold_that_expired_before_the_claim_settles_the_segment_and_pauses_the_film(db, a):
    fid = db.film(a)
    seg = db.quoted_start(a, fid)
    db.su("select public.release_credits(%s)", [seg["credit_ref"]])  # 0020's 3-hour expiry, as it would run
    assert db.claim() is None
    assert db.segment(seg["id"])[:3] == ("released", 0, "hold_expired")
    assert db.film_row(fid) == ("paused", "hold_expired") and db.ledger(a.org, "capture") == []


def test_a_film_nobody_claimed_or_past_its_deadline_is_settled_by_the_sweep(db, a, b):
    late = db.film(b)
    s_late = db.quoted_start(b, late)
    assert db.claim()["id"] == s_late["id"]
    db.su("update public.film_segments set deadline_at = now() - interval '1 minute' where id = %s", [s_late["id"]])
    lone = db.film(a)
    s_lone = db.quoted_start(a, lone)
    db.su("update public.film_segments set created_at = now() - interval '4 hours' where id = %s", [s_lone["id"]])
    assert db.svc("select public.film_expire_segments()") == 2
    assert db.segment(s_lone["id"])[:3] == ("released", 0, "worker_unavailable")
    assert db.segment(s_late["id"])[:3] == ("released", 0, "deadline")
    assert db.film_row(lone) == ("paused", "worker_unavailable") and db.film_row(late) == ("paused", "deadline")
    assert db.account(a.org)[1] == 0 and db.account(b.org)[1] == 0
    assert db.svc("select public.film_expire_segments()") == 0


def test_settled_money_is_what_the_ledger_moved_even_when_the_hold_expired_mid_film(db, a):
    """If 0020 expired a hold under a half-made film, the record says what was captured (0), never what was owed."""
    fid = db.film(a)
    seg = db.quoted_start(a, fid)
    db.claim()
    kf = db.takes(seg["id"])[0][0]
    db.begin(kf)
    db.succeed(kf, None, db.asset(a.org))
    db.su("select public.release_credits(%s)", [seg["credit_ref"]])
    out = db.settle(seg["id"], "hold_expired")
    assert (out["status"], out["captured_credits"], out["charged_credits"]) == ("released", 0, 3)
    detail = db.su("select detail from public.film_events where film_id = %s and event = 'segment_settled'", [fid])[0][0]
    assert detail["not_captured"] == 3


# ── the migration ───────────────────────────────────────────────────────────

SNAPSHOT = """
select jsonb_build_object(
  'constraints', (select jsonb_agg(conname || ' ' || pg_get_constraintdef(oid) order by conname) from pg_constraint
                   where conrelid = any(array['public.film_segments','public.org_film_settings','public.film_takes','public.films',
                                              'public.creative_jobs']::regclass[])),
  'indexes', (select jsonb_agg(indexdef order by indexname) from pg_indexes where schemaname = 'public'
               and (tablename like 'film%' or tablename in ('org_film_settings', 'creative_jobs'))),
  'policies', (select jsonb_agg(policyname || ' ' || qual order by policyname) from pg_policies
                where tablename in ('film_segments', 'org_film_settings')),
  'functions', (select jsonb_agg(p.oid::regprocedure::text || ' ' || md5(p.prosrc) || ' ' || coalesce(array_to_string(p.proacl, ','), '')
                                 order by p.oid::regprocedure::text)
                  from pg_proc p where p.pronamespace = 'public'::regnamespace
                   and (p.proname like 'film\\_%' or p.proname in ('quote_film', 'start_film'))),
  'columns', (select jsonb_agg(table_name || '.' || column_name || ' ' || data_type order by table_name, column_name)
                from information_schema.columns where table_schema = 'public'
                 and table_name in ('film_segments', 'org_film_settings', 'film_takes', 'creative_jobs')),
  'column_grants', (select jsonb_agg(grantee || ' ' || table_name || '.' || column_name || ' ' || privilege_type
                                     order by grantee, table_name, column_name, privilege_type)
                      from information_schema.column_privileges where table_schema = 'public'
                       and table_name in ('film_segments', 'org_film_settings', 'film_takes')),
  'rows', (select jsonb_build_array((select count(*) from public.film_segments), (select count(*) from public.film_takes),
                                    (select md5(string_agg(to_jsonb(s)::text, ',' order by id)) from public.film_segments s))))
"""


def test_reapplying_the_migration_changes_nothing(db, a):
    fid = db.film(a)
    db.quoted_start(a, fid)
    before = db.su(SNAPSHOT)[0][0]
    db.su(MIGRATION.read_text(encoding="utf-8"))
    db.su(MIGRATION.read_text(encoding="utf-8"))
    assert db.su(SNAPSHOT)[0][0] == before


def test_the_drift_guard_refuses_a_body_or_a_constraint_that_is_not_its_own(db):
    text = MIGRATION.read_text(encoding="utf-8")
    with psycopg.connect(db.dsn, autocommit=False) as c:
        c.execute("create or replace function public.film_moderation_billing(p_model text) returns text "
                  "language sql stable security definer set search_path = public, pg_temp as $$ select 'billed' $$")
        with pytest.raises(psycopg.Error) as e:
            c.execute(text)
        assert "film_moderation_billing(text) with a body that is not this file's" in str(e.value)
        c.rollback()
        c.execute("alter table public.creative_jobs drop constraint creative_jobs_payer_check")
        c.execute("alter table public.creative_jobs add constraint creative_jobs_payer_check check (payer is not null)")
        with pytest.raises(psycopg.Error) as e:
            c.execute(text)
        assert "creative_jobs_payer_check that is not 0036's or this file's" in str(e.value)
        c.rollback()
        c.execute("alter table public.film_segments rename column assembly_confirmed_credits to asm_credits")
        with pytest.raises(psycopg.Error) as e:
            c.execute(text)
        assert "public.film_segments that is not this file's" in str(e.value)
        c.rollback()
    assert db.su("select public.film_moderation_billing('vid-hh')")[0][0] == "not_billed"


def _rollback(override: bool) -> str:
    return sec_db.rollback_0171_body(override=override)


def test_the_rollback_refuses_while_a_segment_lives_then_takes_everything_out_and_0171_applies_again(db, a):
    fid = db.film(a)
    seg = db.quoted_start(a, fid)
    with psycopg.connect(db.dsn, autocommit=False) as c:
        with pytest.raises(psycopg.Error) as e:
            c.execute(_rollback(override=True))
        assert "film segments are live" in str(e.value)
        c.rollback()
    db.cancel(seg["id"])
    with psycopg.connect(db.dsn, autocommit=False) as c:
        with pytest.raises(psycopg.Error) as e:
            c.execute(_rollback(override=False))
        assert "film segments exist and their record would be deleted" in str(e.value)
        c.rollback()
        c.execute(_rollback(override=True))
        assert c.execute("select to_regclass('public.film_segments'), to_regprocedure('public.start_film(uuid, text, text)')").fetchone() \
            == (None, None)
        assert "'queued'" not in c.execute("select pg_get_constraintdef(oid) from pg_constraint where conname = 'films_status_check'").fetchone()[0]
        assert c.execute("select count(*) from information_schema.columns where table_name = 'creative_jobs' "
                         "and column_name = 'film_take_id'").fetchone()[0] == 0
        # The credit ledger keeps every movement of the film's hold.
        assert c.execute("select count(*) from public.credit_transactions where job_id = %s", [seg["credit_ref"]]).fetchone()[0] == 2
        c.execute(MIGRATION.read_text(encoding="utf-8"))
        assert c.execute("select has_function_privilege('authenticated', 'public.start_film(uuid, text, text)', 'execute')").fetchone()[0]
        c.rollback()  # the lab keeps its segments: the whole round trip is undone
    assert db.segment(seg["id"])[0] == "released"

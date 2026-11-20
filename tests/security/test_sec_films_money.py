"""Film Studio P2 (migration 0171), attacked in a real database: the price of a film, its one credit hold, and the settle path.

A film is quoted line by line from the backend's own rates (creative_price for every key frame and clip shot, the voice model's rate for
the narration, film_assembly_minute for the assembly and its captions), started at that exact stored quote with one hold of the total,
and settled once by the worker's service calls. What would break without each guard (each test names the guard it pins):

  * who: a viewer neither quotes nor starts; an editor quotes but only an admin starts (0020's rule for a paid run); another
    organization's film reads exactly like a missing one; the browser calls nothing of the worker's, the worker nothing of the browser's;
    the switch is a platform owner's, and while it is off nothing starts;
  * the quote: every line from the backend's rates (no client number), an unpriced model or setting refused by name and never priced 0,
    no Seedance model, a scene longer than the model can shoot, a key-frame model that cannot take every reference picture (a character
    counts as all of its pictures), the narration's minimum per provider call, captions inside the assembly line, the run slot it uses,
    the credits a start could really hold (0094's extra credits);
  * the pin: an edited film invalidates its quote (film_changed), a quote that was never stored or has expired is refused before any
    pricing, a rate that moved is refused (price_changed); refused starts are counted by the rate limit;
  * the start: insufficient credits fail early (NS402) with nothing held or created; one key makes one start; concurrent starts make
    one hold; the cap and the one-film-at-a-time limit; the hold equals the confirmed total; each take carries what was priced;
  * the settle: a clip is charged its full line only when its file measures at least 90% of the confirmed seconds; one automatic retry,
    charged once; a failure is charged 0; moderation is charged only where the vendor bills it; a narration that voiced part of its
    text is charged pro rata; a cancel releases every take that never began; a film that never ran goes back to draft; a hold that is
    gone or that a refund waits on starts nothing new; a lost worker never blocks the claim and its takes end as worker_lost; the sweep
    settles a segment past its deadline and grace while its hold is open;
  * the migration: a replay changes nothing, the drift guard refuses a body or a constraint that is not its own, and the rollback
    refuses while a segment is live, takes everything out with its override, and 0171 applies again after it.

Runs in its own scratch database (it commits), with a registry installed through sync_model_registry and real probe rows. The fixture
that clears live segments between tests uses only the service's own cancel: nothing a test asserts is set by hand behind the code.
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
# raised to the job minimum of 1 (one provider call) + assembly 18 s = 1 minute x 5.
TOTAL = Decimal("49.00")
LIVE = ("queued", "running", "draining")
VIDEO_SECONDS = 10  # what a lab clip measures unless a test says otherwise
_UNSET = object()


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

    def asset(self, org, kind="image", mime="image/png", duration=_UNSET, provenance=None):
        """A library file as the worker registers one; a video measures VIDEO_SECONDS unless given (None: not measured)."""
        if duration is _UNSET:
            duration = VIDEO_SECONDS if kind == "video" else None
        return str(self.su(
            "select public.register_asset(gen_random_uuid(), %s, %s, %s, 1000, %s, 'generated', "
            "p_width => 64, p_height => 64, p_duration_s => %s::numeric, p_provenance => %s::jsonb) ->> 'id'",
            [org, kind, mime, uuid.uuid4().hex * 2, duration, json.dumps(provenance or {})])[0][0])

    def live(self, asset):
        return self.su("select deleted_at is null from public.media_assets where id = %s", [asset])[0][0]

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
        out = self.start(o.admin, film, self.quote(o.editor, film)["quote_id"])
        assert out.get("ok") is True, out
        return out

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
                       "t.charge_basis, t.quantity, t.attempt from public.film_takes t "
                       "left join public.film_scenes s on s.id = t.scene_id "
                       "where t.segment_id = %s order by s.position nulls last, t.shot_index, t.attempt", [segment])

    def film_row(self, film):
        return self.su("select status, pause_reason from public.films where id = %s", [film])[0]

    def segment(self, segment):
        return self.su("select status, captured_credits, settle_reason, credit_ref, confirmed_credits, attempts from public.film_segments "
                       "where id = %s", [segment])[0]

    def events(self, film):
        return [r[0] for r in self.su("select event from public.film_events where film_id = %s order by id", [film])]

    def rate_used(self, user, bucket):
        return self.su("select coalesce(sum(count), 0) from public.web_rate_counters where user_id = %s and bucket = %s",
                       [user, f"db.film.{bucket}@3600"])[0][0]

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

    def succeed(self, take, seconds, asset, worker="w-1", task="lab-task-1"):
        return self.svc("select public.film_take_succeeded(%s::uuid, %s, %s::numeric, %s::uuid, null, %s)",
                        [take, worker, seconds, asset, task])

    def fail(self, take, failure, worker="w-1", code="vendor_refused", units=None):
        return self.svc("select public.film_take_failed(%s, %s, %s, %s, 'refused by the vendor', %s::numeric)",
                        [take, worker, failure, code, units])

    def settle(self, segment, reason, worker="w-1"):
        return self.svc("select public.film_settle_segment(%s, %s, %s)", [segment, worker, reason])

    def cancel(self, segment, reason="cancelled"):
        return self.svc("select public.film_cancel_segment(%s, %s)", [segment, reason])

    def output(self, org, take, kind="video", mime="video/mp4", duration=_UNSET):
        """A file the worker registers as a take's output, as P3's contract says: provenance names the take."""
        return self.asset(org, kind, mime, duration=duration, provenance={"film_take_id": str(take)})

    def make(self, o, take, kind, worker="w-1", seconds=None):
        """Begin a take and give it a result of its kind (a video measures VIDEO_SECONDS)."""
        self.begin(take, worker)
        kind_ = {"keyframe": ("image", "image/png"), "narration": ("audio", "audio/mpeg")}.get(kind, ("video", "video/mp4"))
        return self.succeed(take, seconds, self.output(o.org, take, *kind_), worker)

    def finish_all(self, o, segment, worker="w-1"):
        """Every planned take of the segment made."""
        return {t[0]: self.make(o, t[0], t[1], worker) for t in self.takes(segment) if t[4] == "planned"}


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
    # The switch, turned on the way the owner does it from the SQL editor (P3 turns it on in production).
    assert d.su("select public.set_film_studio_enabled(true)")[0][0]["ok"] is True
    try:
        yield d
    finally:
        if not os.environ.get("NIGHTSHIFT_SECURITY_KEEP"):
            sec_db.drop_database(admin, name)


@pytest.fixture(autouse=True)
def no_live_segment(db):
    """film_claim_segment takes the oldest claimable segment across organizations, so one test's queued film must never be claimed by
    the next: every live segment is cancelled through the service's own cancel (a take in flight keeps its segment draining, which no
    claim takes while its heartbeat is fresh). Nothing is written behind the code's back."""
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


def refused(out):
    """A refusal start_film answers after it is counted: (reason, code)."""
    assert out.get("ok") is False, out
    return out["reason"], out["code"]


def reasons(q):
    return {r["reason"] for r in q["refusals"]}


# ── who may quote and start, and the switch ─────────────────────────────────

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
    assert db.start(a.owner, fid, q["quote_id"])["status"] == "queued"


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
def test_the_anon_key_and_the_service_role_call_no_browser_function(db, a, role):
    fid = db.film(a)
    for q, p in (("select public.quote_film(%s::uuid, 2)", [fid]),
                 ("select public.start_film(%s::uuid, %s, 'service-key-01')", [fid, "fq-2-" + "0" * 32]),
                 ("select public.set_film_studio_enabled(false)", [])):
        with pytest.raises(psycopg.Error) as e:
            db.act(role, None, q, p)
        assert e.value.sqlstate == "42501" and "permission denied" in str(e.value), q


def test_while_the_switch_is_off_nothing_starts_and_only_a_platform_admin_or_the_sql_editor_turns_it(db, a):
    """Item 9: film_studio_enabled, default off, set only through owner_guard (or the SQL editor), audited."""
    fid = db.film(a)
    qid = db.quote(a.editor, fid)["quote_id"]
    try:
        assert db.su("select public.set_film_studio_enabled(false)")[0][0] == {"ok": True, "enabled": False, "changed": True}
        q = db.quote(a.editor, fid)
        assert q["film_studio_enabled"] is False and {"reason": "film_studio_disabled"} in q["blocked_by"] and not q["startable"]
        assert err(lambda: db.start(a.admin, fid, qid))[:2] == ("NS409", "film_studio_disabled")
        assert db.holds(a.org) == [] and db.rate_used(a.admin, "start") == 0
        # An owner of a customer organization is not a platform admin: refused before anything is read.
        assert err(lambda: db.one("authenticated", a.owner, "select public.set_film_studio_enabled(true)"))[:2] == \
            ("42501", "only a platform owner or admin may do this")
        assert db.su("select film_studio_enabled from public.film_studio_settings")[0][0] is False
    finally:
        db.su("select public.set_film_studio_enabled(true)")
    kinds = db.su("select detail ->> 'to', detail ->> 'via' from public.security_events where kind = 'film_studio.enabled' order by id")
    assert kinds[-2:] == [("false", "sql_editor"), ("true", "sql_editor")], kinds
    assert db.start(a.admin, fid, qid)["ok"] is True


WORKER_CALLS = [
    ("select public.film_claim_segment('w-x')", []),
    ("select public.film_heartbeat_segment(%s::uuid, 'w-x')", ["seg"]),
    ("select public.film_begin_take(%s::uuid, 'w-x')", ["seg"]),
    ("select public.film_take_succeeded(%s::uuid, 'w-x', 5, %s::uuid)", ["seg", "seg"]),
    ("select public.film_take_failed(%s::uuid, 'w-x', 'provider_error', 'x')", ["seg"]),
    ("select public.film_begin_assembly(%s::uuid, 'w-x')", ["seg"]),
    ("select public.film_record_assembly(%s::uuid, 'w-x', true, %s::uuid)", ["seg", "seg"]),
    ("select public.film_settle_segment(%s::uuid, 'w-x', 'cancelled')", ["seg"]),
    ("select public.film_cancel_segment(%s::uuid, 'cancelled')", ["seg"]),
    ("select public.film_expire_segments()", []),
    ("select public.film_price(f) from public.films f limit 1", []),
    ("select public.film_settle_locked(%s::uuid, %s::uuid, 'cancelled')", ["seg", "seg"]),
    ("select public.film_lose_inflight_locked(%s::uuid)", ["seg"]),
    ("select public.film_discard_assets(%s::uuid, %s::uuid, null, array[%s::uuid])", ["seg", "seg", "seg"]),
    ("select public.film_record_skip(%s::uuid, %s::uuid, %s::uuid, 'claim', 'P0001', 'x')", ["seg", "seg", "seg"]),
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
def test_no_api_role_writes_a_segment_a_setting_a_quote_the_switch_a_take_or_a_film_creative_job(db, a, role):
    fid = db.film(a)
    seg = db.quoted_start(a, fid)["id"]
    take = db.takes(seg)[0][0]
    who = a.owner if role == "authenticated" else None
    attacks = [
        f"update public.film_segments set captured_credits = 0, status = 'released', settled_at = now() where id = '{seg}'",
        f"delete from public.film_segments where id = '{seg}'",
        f"insert into public.org_film_settings (org_id, max_active_films) values ('{a.org}', 10)",
        f"insert into public.film_quotes (film_id, org_id, version, quote_id, total, expires_at) values ('{fid}', '{a.org}', 2, "
        f"'fq-2-{'0' * 32}', 0, now() + interval '1 day')",
        "update public.film_studio_settings set film_studio_enabled = true",
        f"update public.film_takes set charged_credits = 0, charge_basis = 'x', status = 'failed' where id = '{take}'",
        "insert into public.creative_jobs (org_id, capability, requested_model, payer, film_take_id) "
        f"values ('{a.org}', 'i2v', 'vid-clip', 'film', '{take}')",
    ]
    for q in attacks:
        with pytest.raises(psycopg.Error) as e:
            db.act(role, who, q)
        assert e.value.sqlstate == "42501", q
    for t in ("film_quotes", "film_studio_settings"):
        if role == "service_role" and t == "film_quotes":
            continue  # the trusted backend reads the stored quotes; it writes none of them (above)
        with pytest.raises(psycopg.Error) as e:
            db.act(role, who, f"select count(*) from public.{t}")
        assert e.value.sqlstate == "42501", t
    with pytest.raises(psycopg.Error):
        db.act("authenticated", a.owner, "select provider_task_id from public.film_takes")
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
    assert q["quote_id"].startswith(f"fq-{db.version(fid)}-") and q["refusals"] == [] and "excluded" not in q
    assert Decimal(str(q["available"])) == 100 and q["blocked_by"] == []
    assert q["quote_expires_at"] is not None
    assert db.holds(a.org) == []


def test_the_quote_says_the_film_takes_a_run_slot_and_for_how_long(db, a):
    """Item 4: 0034 is unchanged; the person is told before Start that the film's hold is one of the plan's parallel runs."""
    q = db.quote(a.editor, db.film(a))
    assert q["run_slot"] == {"uses_run_slot": True, "slots": {"exempt": False, "limit": 1, "active": 0}, "max_hours": 25}, q["run_slot"]


def test_captions_are_part_of_the_assembly_line_and_priced_with_it(db, a):
    """Item 4: our own pipeline makes captions from the narration; no separate line, no separate hold, no 'excluded' path."""
    fid = db.film(a, settings={**SETTINGS, "captions_mode": "sidecar"})
    q = db.quote(a.editor, fid)
    asm = [ln for ln in q["lines"] if ln["line"] == "assembly"][0]
    assert q["priced"] is True and Decimal(str(q["total"])) == TOTAL and asm["includes"] == ["captions"] and "excluded" not in q
    assert not [ln for ln in q["lines"] if ln["line"] == "captions"]


def test_the_available_credits_follow_extra_credits_off(db):
    """Item 12: with 0094's extra credits off, credits bought as a top-up pack are not what a start could hold."""
    o = db.new_org(credits=0)
    db.svc("select public.add_purchased_credits(%s, 100, %s, 'lab pack')", [o.org, f"pay_{uuid.uuid4().hex[:12]}"])
    fid = db.film(o)
    assert Decimal(str(db.quote(o.editor, fid)["available"])) == 100
    db.su("update public.credit_accounts set use_extra_credits = false where org_id = %s", [o.org])
    q = db.quote(o.editor, fid)
    assert Decimal(str(q["available"])) == 0 and q["startable"] is False
    assert [r["reason"] for r in q["blocked_by"]] == ["insufficient_credits"]
    assert refused(db.start(o.admin, fid, q["quote_id"])) == ("insufficient_credits", "NS402")


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
    db.su("update public.film_scenes set clip_params = '{\"resolution\": \"1080p\"}' where film_id = %s and position = 0", [fid])
    q = db.quote(a.editor, fid)
    bad = [ln for ln in q["lines"] if not ln["priced"]]
    assert len(bad) == 1 and bad[0]["credits"] is None and bad[0]["reason"] == "invalid_params" and q["total"] is None
    db.su("update public.film_scenes set clip_params = '{}' where film_id = %s", [fid])
    try:
        db.su("update public.credit_prices set unit = 'model_vid_clip_second_off' where unit = 'model_vid_clip_second'")
        q = db.quote(a.editor, fid)
        assert q["total"] is None and {ln["reason"] for ln in q["lines"] if ln["line"] == "clip"} <= {"model_not_available", "unpriced"}
        assert all(ln["credits"] is None for ln in q["lines"] if ln["line"] == "clip")
    finally:
        db.su("update public.credit_prices set unit = 'model_vid_clip_second' where unit = 'model_vid_clip_second_off'")
    # A start against a film that became unpriced after its quote is refused with the line's own word, counted, holding nothing.
    qid = db.quote(a.editor, fid)["quote_id"]
    try:
        db.su("delete from public.credit_prices where unit = 'film_assembly_minute'")
        assert refused(db.start(a.admin, fid, qid)) == ("unpriced", "NS400")
    finally:
        db.su("insert into public.credit_prices (unit, credits_per_unit, margin) values ('film_assembly_minute', %s, 0) "
              "on conflict (unit) do nothing", [ASSEMBLY_RATE])
    assert db.holds(a.org) == [] and db.rate_used(a.admin, "start") == 1


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


def test_a_character_counts_as_all_of_its_pictures_against_the_reference_limit(db, a):
    """Breach (1): a 0047 character reaches the key-frame model as every picture it has. img-key takes 4: a character of 5 pictures
    is refused by name, never cut to 4."""
    ch = str(db.su("insert into public.characters (org_id, name) values (%s, %s) returning id", [a.org, f"hero_{uuid.uuid4().hex[:8]}"])[0][0])
    for i in range(5):
        db.su("insert into public.character_references (character_id, org_id, asset_id, position) values (%s, %s, %s, %s)",
              [ch, a.org, db.asset(a.org), i])
    fid = db.film(a)
    db.save(a.editor, fid, db.version(fid), {"refs": [{"kind": "character", "character_id": ch}]})
    q = db.quote(a.editor, fid)
    assert reasons(q) == {"refs_not_supported"} and "has 5" in q["refusals"][0]["detail"]
    db.su("delete from public.character_references where character_id = %s and position = 4", [ch])
    assert db.quote(a.editor, fid)["priced"] is True


def test_the_narration_is_never_less_than_the_minimum_once_per_provider_call(db, a):
    """Breach (4): one tts call carries at most 4,000 characters, and the Studio charges each call its minimum."""
    text = "a" * 2000
    fid = db.film(a, scenes=[{"narration": text, "visual_prompt": "x", "planned_seconds": 10} for _ in range(3)])
    try:
        db.su("update public.credit_prices set credits_per_unit = 100 where unit = 'job_minimum'")
        narr = [ln for ln in db.quote(a.editor, fid)["lines"] if ln["line"] == "narration"][0]
        # 6,000 characters x 0.01 = 60, but two calls at a minimum of 100 each: 200.
        assert (narr["quantity"], Decimal(str(narr["credits"]))) == (6000, 200), narr
    finally:
        db.su("update public.credit_prices set credits_per_unit = %s where unit = 'job_minimum'", [JOB_MINIMUM])


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
    q = db.quote(a.editor, fid)
    assert db.su("select count(*) from public.film_quotes where film_id = %s and version <> %s", [fid, db.version(fid)])[0][0] == 0
    assert db.start(a.admin, fid, q["quote_id"])["status"] == "queued"


def test_a_quote_that_was_never_stored_or_has_expired_is_refused_before_any_pricing(db, a):
    """Item 8 / Breach option 2: start_film compares with the stored quote first; a forged or expired id never reaches film_price."""
    fid = db.film(a)
    qid = db.quote(a.editor, fid)["quote_id"]
    forged = qid[:-32] + "0" * 32
    assert refused(db.start(a.admin, fid, forged)) == ("price_changed", "NS409")
    db.su("update public.film_quotes set expires_at = now() - interval '1 second', created_at = now() - interval '1 hour' "
          "where film_id = %s", [fid])
    assert refused(db.start(a.admin, fid, qid)) == ("quote_expired", "NS409")
    assert db.rate_used(a.admin, "start") == 2 and db.holds(a.org) == []
    # A new quote replaces the expired one.
    assert db.start(a.admin, fid, db.quote(a.editor, fid)["quote_id"])["ok"] is True


def test_a_stale_quote_is_refused_when_a_rate_moves(db, a):
    fid = db.film(a)
    qid = db.quote(a.editor, fid)["quote_id"]
    try:
        db.su("update public.credit_prices set credits_per_unit = 3 where unit = 'model_vid_clip_second'")
        out = db.start(a.admin, fid, qid)
        assert refused(out) == ("price_changed", "NS409") and "69" in out["detail"], out
    finally:
        db.su("update public.credit_prices set credits_per_unit = 2 where unit = 'model_vid_clip_second'")
    assert err(lambda: db.start(a.admin, fid, "49 credits please"))[:2] == ("NS400", "invalid_params")
    assert db.holds(a.org) == []
    assert db.start(a.admin, fid, qid)["confirmed_credits"] == TOTAL


def test_refused_starts_count_against_the_hourly_limit(db, a):
    """Item 8 / BR-0171-01: a refusal after the rate step is answered, not raised, so the counter commits with it."""
    fid = db.film(a)
    qid = db.quote(a.editor, fid)["quote_id"]
    forged = qid[:-32] + "f" * 32
    for _ in range(10):
        assert refused(db.start(a.admin, fid, forged)) == ("price_changed", "NS409")
    assert db.rate_used(a.admin, "start") == 10
    assert err(lambda: db.start(a.admin, fid, qid))[:2] == ("NS429", "rate_limited")
    assert db.holds(a.org) == [] and db.film_row(fid)[0] == "draft"


# ── the start ───────────────────────────────────────────────────────────────

def test_insufficient_credits_fail_early_with_nothing_held_or_created(db):
    o = db.new_org(credits=40)
    fid = db.film(o)
    q = db.quote(o.editor, fid)
    assert [r["reason"] for r in q["blocked_by"]] == ["insufficient_credits"] and q["startable"] is False
    before = db.account(o.org)
    out = db.start(o.admin, fid, q["quote_id"])
    assert refused(out) == ("insufficient_credits", "NS402") and "available=40" in out["detail"] and "needed=49" in out["detail"], out
    assert db.account(o.org) == before and db.holds(o.org) == []
    assert db.su("select count(*) from public.film_segments where film_id = %s", [fid])[0][0] == 0
    assert db.su("select count(*) from public.film_takes where film_id = %s", [fid])[0][0] == 0
    assert db.film_row(fid)[0] == "draft" and "started" not in db.events(fid) and db.rate_used(o.admin, "start") == 1


def test_start_holds_the_confirmed_total_once_and_plans_every_take_with_what_was_priced(db, a):
    fid = db.film(a)
    q = db.quote(a.editor, fid)
    seg = db.start(a.admin, fid, q["quote_id"])
    assert seg["ok"] is True and seg["status"] == "queued" and seg["confirmed_credits"] == TOTAL and seg["replayed"] is False
    assert db.holds(a.org) == [(seg["credit_ref"], TOTAL, "open", None)]
    assert seg["credit_ref"] == "fm-" + seg["id"].replace("-", "")
    assert db.account(a.org) == (Decimal(100), TOTAL)
    takes = db.takes(seg["id"])
    assert [(t[1], t[3], t[4]) for t in takes] == [("keyframe", 0, "planned"), ("clip", 1, "planned"), ("clip", 1, "planned"),
                                                    ("narration", 0, "planned")]
    assert sum(t[5] for t in takes) + Decimal(str(seg["assembly"]["confirmed_credits"])) == TOTAL
    # Item 13: each take carries exactly the params its line was priced with.
    params = [r[0] for r in db.su("select t.params from public.film_takes t left join public.film_scenes s on s.id = t.scene_id "
                                  "where t.segment_id = %s order by s.position nulls last, t.shot_index", [seg["id"]])]
    assert params == [ln["params"] for ln in q["lines"] if ln["line"] != "assembly"], params
    assert params[0] == {"aspect_ratio": "16:9"} and params[1] == {"duration_s": 10} and params[3] == {"voice_id": "voice_lab_1"}
    assert db.film_row(fid)[0] == "queued" and db.events(fid)[-1] == "started"
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
    ok, refusals, gate = [], [], threading.Barrier(4)

    def go(k):
        gate.wait()
        try:
            ok.append(db.start(o.admin, fid, qid, k)["id"])
        except psycopg.Error as e:
            refusals.append((e.sqlstate, str(e).splitlines()[0]))

    threads = [threading.Thread(target=go, args=(k,)) for k in keys]
    [t.start() for t in threads]
    [t.join() for t in threads]
    assert len(set(ok)) == 1, (ok, refusals)
    assert len(ok) == (4 if same_key else 1) and refusals == ([] if same_key else [("NS409", "film_not_startable")] * 3)
    assert len(db.holds(o.org)) == 1 and db.account(o.org)[1] == TOTAL
    assert db.su("select count(*) from public.film_segments where film_id = %s", [fid])[0][0] == 1


def test_two_films_at_once_are_refused_by_the_default_limit_and_the_cap_refuses_a_dear_film(db):
    o = db.new_org(credits=1000)
    f1, f2 = db.film(o), db.film(o)
    q2 = db.quote(o.editor, f2)["quote_id"]
    db.quoted_start(o, f1)
    assert [r["reason"] for r in db.quote(o.editor, f2)["blocked_by"]] == ["limit_reached", "run_slots_full"]
    assert refused(db.start(o.admin, f2, q2)) == ("limit_reached", "NS400")
    db.su("insert into public.org_film_settings (org_id, max_credits_per_film, max_active_films) values (%s, 48, 2)", [o.org])
    assert refused(db.start(o.admin, f2, q2)) == ("cap_exceeded", "NS400")
    db.su("update public.org_film_settings set max_credits_per_film = 49 where org_id = %s", [o.org])
    # The plan's one parallel run (0034) is the film already running: reserve_credits refuses the second hold.
    out = db.start(o.admin, f2, q2)
    assert refused(out) == ("run_slots_full", "NS429") and "limit=1" in out["detail"]
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
    # L2: charged by the length recorded on the registered file (18.4 s: one minute), never by a number handed to the call.
    db.svc("select public.film_record_assembly(%s, 'w-1', true, %s::uuid)",
           [seg["id"], db.asset(a.org, "video", "video/mp4", duration=18.4)])
    out = db.settle(seg["id"], "completed")
    assert out["settled"] is True and out["status"] == "settled" and out["captured_credits"] == TOTAL
    assert db.ledger(a.org, "capture") == [-TOTAL] and db.account(a.org) == (Decimal(100) - TOTAL, 0)
    assert db.film_row(fid) == ("ready", None)
    again = db.settle(seg["id"], "completed")
    assert again["captured_credits"] == TOTAL and db.ledger(a.org, "capture") == [-TOTAL]


def test_a_clip_is_charged_its_full_line_only_when_its_file_measures_ninety_percent(db, a):
    """Item 7: the file's own measured length decides, never the worker's number; at least 90% of the confirmed seconds is the full
    line (as the Studio charges a job); less is a failure at 0, and the one retry is planned."""
    fid = db.film(a)
    seg = db.quoted_start(a, fid)
    db.claim()
    clips = [t[0] for t in db.takes(seg["id"]) if t[1] == "clip"]
    for tid in clips:
        db.begin(tid)
    short = db.succeed(clips[0], 10, db.asset(a.org, "video", "video/mp4", duration=8.9))  # 89%: the worker's 10 is not believed
    assert short["accepted"] is False and (short["status"], short["charged_credits"], short["error_code"]) == \
        ("superseded", 0, "output_too_short") and short["retry_take_id"]
    enough = db.succeed(clips[1], None, db.asset(a.org, "video", "video/mp4", duration=9))
    assert enough["accepted"] is True and (enough["charged_credits"], enough["charge_basis"], enough["output_seconds"]) == \
        (20, "full_line", 9)
    # The retry is a planned take at the same line, charged once, on success.
    retry = short["retry_take_id"]
    assert db.su("select attempt, status, confirmed_credits from public.film_takes where id = %s", [retry])[0] == (2, "planned", 20)
    db.begin(retry)
    assert db.succeed(retry, None, db.asset(a.org, "video", "video/mp4", duration=14))["charged_credits"] == 20
    with pytest.raises(psycopg.Error) as e:
        db.su("update public.film_takes set charged_credits = 21 where id = %s", [retry])
    assert e.value.sqlstate == "23514"
    out = db.cancel(seg["id"])
    assert out["captured_credits"] == Decimal(40) and db.ledger(a.org, "capture") == [Decimal(-40)]


def test_a_clip_result_that_cannot_be_measured_or_believed_is_never_charged(db, a):
    """Item 7 and Breach (3): no measured length is a failure; a worker's hostile number, a missing provider task id, a file of the
    wrong kind or of another organization are refused by name (never a raw 23514)."""
    fid = db.film(a)
    seg = db.quoted_start(a, fid)
    db.claim()
    clip = [t[0] for t in db.takes(seg["id"]) if t[1] == "clip"][0]
    db.begin(clip)
    video = db.asset(a.org, "video", "video/mp4")
    for s in (0.004, 0, -1, 601, "NaN", "Infinity"):
        assert err(lambda: db.succeed(clip, s, video))[:2] == ("NS400", "invalid_params"), s
    assert err(lambda: db.succeed(clip, 10, video, task=None))[:2] == ("NS400", "invalid_params")
    assert err(lambda: db.succeed(clip, 10, a.image))[:2] == ("NS400", "invalid_params")
    assert err(lambda: db.succeed(clip, 10, db.asset(db.new_org().org, "video", "video/mp4")))[:2] == ("NS400", "invalid_params")
    out = db.succeed(clip, 10, db.asset(a.org, "video", "video/mp4", duration=None))
    assert out["accepted"] is False and (out["error_code"], out["charged_credits"]) == ("output_length_unknown", 0)
    tiny = db.asset(a.org, "video", "video/mp4", duration=0.004)
    retry = out["retry_take_id"]
    db.begin(retry)
    out = db.succeed(retry, None, tiny)
    assert out["accepted"] is False and (out["status"], out["error_code"], out["charged_credits"]) == ("failed", "output_too_short", 0)


def test_a_failure_is_retried_once_within_its_line_and_charged_nothing(db, a):
    """Item 6: one automatic retry, charged once only on success; the failed try costs the customer 0. A second failure is final."""
    fid = db.film(a)
    seg = db.quoted_start(a, fid)
    db.claim()
    takes = db.takes(seg["id"])
    kf, clip = takes[0][0], takes[1][0]
    db.make(a, kf, "keyframe")
    db.begin(clip)
    first = db.fail(clip, "provider_error")
    assert (first["status"], first["charged_credits"], first["charge_basis"]) == ("superseded", 0, "retried_not_charged")
    retry = first["retry_take_id"]
    assert db.fail(clip, "provider_error")["status"] == "superseded"  # a retried call answers as it is
    db.begin(retry)
    final = db.fail(retry, "provider_error")
    assert (final["status"], final["charged_credits"], final["charge_basis"]) == ("failed", 0, "failed_not_charged")
    assert "retry_take_id" not in final and db.events(fid).count("take_retried") == 1
    out = db.settle(seg["id"], "take_failed")
    assert out["status"] == "settled" and out["captured_credits"] == 3
    assert db.ledger(a.org, "capture") == [Decimal(-3)] and db.ledger(a.org, "release")[-1] == TOTAL - 3
    assert db.account(a.org) == (Decimal(97), 0)
    assert db.film_row(fid) == ("paused", "take_failed")


@pytest.mark.parametrize("model,basis", [
    ("vid-runway", "moderated_vendor_billed"),
    ("vid-hh", "moderated_vendor_not_billed"),
    ("vid-clip", "moderated_vendor_billing_unknown"),
])
def test_a_moderated_take_delivers_nothing_and_is_charged_nothing_whatever_the_vendor_billed(db, a, model, basis):
    """L1 (owner policy: match the Studio): a moderated task with no result costs the customer 0, even on Runway, which bills the
    platform for it; the basis records what the platform absorbed."""
    fid = db.film(a, settings={**SETTINGS, "clip_model": model})
    seg = db.quoted_start(a, fid)
    db.claim()
    clip = [t[0] for t in db.takes(seg["id"]) if t[1] == "clip"][0]
    planned = [t[0] for t in db.takes(seg["id"]) if t[1] == "keyframe"][0]
    assert err(lambda: db.fail(planned, "moderated"))[:2] == ("NS409", "take_not_running")
    db.make(a, planned, "keyframe")
    db.begin(clip)
    first = db.fail(clip, "moderated", code="policy")
    assert (first["charged_credits"], first["charge_basis"]) == (0, "retried_not_charged")
    db.begin(first["retry_take_id"])
    out = db.fail(first["retry_take_id"], "moderated", code="policy")
    assert (out["status"], out["charged_credits"], out["charge_basis"]) == ("failed", 0, basis)
    settled = db.settle(seg["id"], "moderated")
    assert settled["captured_credits"] == 3 and settled["status"] == "settled"


def test_a_narration_that_voiced_part_of_its_text_delivers_nothing_and_is_charged_nothing(db, a):
    """L1: a narration with a hole in it is thrown away, so it is charged 0 (partial_not_delivered); the voiced count is recorded."""
    fid = db.film(a, scenes=[{"narration": "n" * 2000, "visual_prompt": "x", "planned_seconds": 10}])
    seg = db.quoted_start(a, fid)
    db.claim()
    narr = [t for t in db.takes(seg["id"]) if t[1] == "narration"][0]
    assert narr[5] == 20
    db.begin(narr[0])
    retry = db.fail(narr[0], "provider_error", units=1000)["retry_take_id"]
    db.begin(retry)
    out = db.fail(retry, "provider_error", units=1500)
    assert (out["status"], out["charged_credits"], out["charge_basis"]) == ("failed", 0, "partial_not_delivered")
    detail = db.su("select detail from public.film_events where film_id = %s and event = 'take_failed'", [fid])[0][0]
    assert detail["units_done"] == 1500 and detail["charged"] == 0
    assert err(lambda: db.fail(db.takes(seg["id"])[0][0], "provider_error", units=5))[:2] == ("NS400", "invalid_params")


def test_cancel_before_anything_ran_releases_every_hold_and_the_film_goes_back_to_draft(db, a):
    """Item 3: nothing was charged and nothing made, so the film is a draft again, editable and startable, its takes kept at 0."""
    fid = db.film(a)
    seg = db.quoted_start(a, fid)
    planned_ids = [str(t[0]) for t in db.takes(seg["id"])]
    out = db.cancel(seg["id"])
    assert (out["status"], out["captured_credits"], out["settled"]) == ("released", 0, True)
    assert db.holds(a.org)[0][2] == "released" and db.account(a.org) == (Decimal(100), 0)
    assert db.ledger(a.org, "capture") == [] and db.film_row(fid) == ("draft", None)
    assert db.takes(seg["id"]) == []  # M2: never begun, all at 0: removed; the events keep the record
    detail = db.su("select detail from public.film_events where film_id = %s and event = 'segment_settled'", [fid])[0][0]
    assert (detail["back_to_draft"], detail["takes_removed"]) == (True, 4)
    assert sorted(detail["removed_take_ids"]) == sorted(planned_ids)
    assert db.claim() is None
    assert db.cancel(seg["id"])["status"] == "released"
    db.save(a.editor, fid, db.version(fid), {"title": "The lighthouse, again"})
    second = db.quoted_start(a, fid)
    assert second["n"] == 2 and db.holds(a.org)[-1][2] == "open"
    assert {t[4] for t in db.takes(second["id"])} == {"planned"}


def test_after_a_film_goes_back_to_draft_a_scene_can_be_deleted_again(db, a):
    """M2: start, cancel, draft, then a save that drops a scene succeeds (0166 refuses to delete a scene that has takes)."""
    fid = db.film(a)
    seg = db.quoted_start(a, fid)
    db.cancel(seg["id"])
    assert db.film_row(fid)[0] == "draft"
    first = db.su("select id from public.film_scenes where film_id = %s order by position limit 1", [fid])[0][0]
    out = db.save(a.editor, fid, db.version(fid), {"scenes": [{"id": str(first)}]})
    assert [sc["id"] for sc in out["scenes"]] == [str(first)]
    assert db.quoted_start(a, fid)["ok"] is True


def test_a_rejected_clip_is_not_kept_in_the_library(db, a):
    """M1: a result is kept only when accepted. A file too short is soft-deleted with the rejection, in the same transaction."""
    fid = db.film(a)
    seg = db.quoted_start(a, fid)
    db.claim()
    clip = [t[0] for t in db.takes(seg["id"]) if t[1] == "clip"][0]
    db.begin(clip)
    short = db.output(a.org, clip, duration=3)
    frame = db.output(a.org, clip, "image", "image/png")
    out = db.svc("select public.film_take_succeeded(%s::uuid, 'w-1', null, %s::uuid, %s::uuid, 'lab-task-1')", [clip, short, frame])
    assert out["accepted"] is False
    gone = db.su("select id::text, deleted_at is not null from public.media_assets where id in (%s, %s)", [short, frame])
    assert dict(gone) == {short: True, frame: True}
    assert db.one("authenticated", a.viewer, "select count(*) from public.media_assets where id = %s and deleted_at is null", [short]) == 0


def test_the_files_a_lost_take_registered_are_not_kept_in_the_library(db, a):
    """M1: a take whose worker was lost after its creative job registered a file: the file is soft-deleted with the worker_lost."""
    fid = db.film(a)
    seg = db.quoted_start(a, fid)
    db.claim()
    clip = [t[0] for t in db.takes(seg["id"]) if t[1] == "clip"][0]
    db.begin(clip)
    made = db.asset(a.org, "video", "video/mp4")
    job = db.su("insert into public.creative_jobs (org_id, capability, requested_model, payer, film_take_id, result_asset_ids) "
                "values (%s, 'i2v', 'vid-clip', 'film', %s, array[%s::uuid]) returning id", [a.org, clip, made])[0][0]
    try:
        db.su("update public.film_segments set deadline_at = now() - interval '3 hours' where id = %s", [seg["id"]])
        assert db.svc("select public.film_expire_segments()") == 1
        assert db.su("select status, charge_basis from public.film_takes where id = %s", [clip])[0] == ("failed", "worker_lost_not_charged")
        assert db.su("select deleted_at is not null from public.media_assets where id = %s", [made])[0][0] is True
    finally:
        db.su("delete from public.creative_jobs where id = %s", [job])  # P3 writes these; the lab keeps none (the rollback test)


def test_a_rejected_result_handed_in_again_answers_as_its_rejection(db, a):
    """L5: a retried film_take_succeeded for a take already rejected replays that rejection and its retry, never take_not_running."""
    fid = db.film(a)
    seg = db.quoted_start(a, fid)
    db.claim()
    clip = [t[0] for t in db.takes(seg["id"]) if t[1] == "clip"][0]
    db.begin(clip)
    short = db.asset(a.org, "video", "video/mp4", duration=2)
    first = db.succeed(clip, None, short)
    again = db.succeed(clip, None, short)
    assert first["accepted"] is again["accepted"] is False and again["replayed"] is True
    assert again["retry_take_id"] == first["retry_take_id"]
    assert len([t for t in db.takes(seg["id"]) if t[1] == "clip"]) == 3  # two clip slots, one retry: nothing new
    assert err(lambda: db.succeed(clip, None, db.asset(a.org, "video", "video/mp4")))[:2] == ("NS409", "take_not_running")


def test_the_assembly_is_charged_by_its_registered_file_never_by_a_number_and_never_above_its_line(db, a):
    """L2: the assembly's result is a registered video of the organization; its recorded length decides, capped at the line."""
    fid = db.film(a)
    seg = db.quoted_start(a, fid)
    db.claim()
    db.finish_all(a, seg["id"])
    db.svc("select public.film_begin_assembly(%s, 'w-1')", [seg["id"]])
    unmeasured = db.asset(a.org, "video", "video/mp4", duration=None)
    for asset in (unmeasured, a.image, db.asset(db.new_org().org, "video", "video/mp4"), None):
        assert err(lambda: db.svc("select public.film_record_assembly(%s, 'w-1', true, %s::uuid)", [seg["id"], asset]))[:2] == \
            ("NS400", "invalid_params"), asset
    # M-a: a take's own result is not an assembly, nor a file that existed before the segment was claimed.
    clip_result = db.su("select result_asset_id::text from public.film_takes where segment_id = %s and kind = 'clip' limit 1",
                        [seg["id"]])[0][0]
    early = db.su("select id::text from public.media_assets where org_id = %s and kind = 'video' and deleted_at is null "
                  "order by created_at limit 1", [a.org])[0][0]
    db.su("update public.media_assets set created_at = created_at - interval '1 day' where id = %s", [early])
    for asset in (clip_result, early):
        assert err(lambda: db.svc("select public.film_record_assembly(%s, 'w-1', true, %s::uuid)", [seg["id"], asset]))[:2] == \
            ("NS400", "invalid_params"), asset
    long_ = db.asset(a.org, "video", "video/mp4", duration=125)  # three minutes recorded; the line was confirmed for one
    out = db.svc("select public.film_record_assembly(%s, 'w-1', true, %s::uuid)", [seg["id"], long_])
    assert out["assembly"]["charged_credits"] == 5 and out["assembly"]["asset_id"] == long_ and out["assembly"]["output_seconds"] == 125
    # The same call again answers as it is; another file, or another outcome, is a conflict.
    assert db.svc("select public.film_record_assembly(%s, 'w-1', true, %s::uuid)", [seg["id"], long_])["assembly"]["asset_id"] == long_
    other = db.asset(a.org, "video", "video/mp4", duration=50)
    assert err(lambda: db.svc("select public.film_record_assembly(%s, 'w-1', true, %s::uuid)", [seg["id"], other]))[:2] == \
        ("NS409", "idempotency_conflict")
    assert err(lambda: db.svc("select public.film_record_assembly(%s, 'w-1', false, null)", [seg["id"]]))[:2] == \
        ("NS409", "idempotency_conflict")
    assert db.live(long_) and db.live(clip_result)


def test_a_charged_key_frame_handed_in_as_a_rejected_clips_last_frame_is_never_discarded(db, a):
    """H1, Lens's first reproduction: film_discard_assets removes only files made for the rejected take, never another take's."""
    fid = db.film(a)
    seg = db.quoted_start(a, fid)
    db.claim()
    kf, clip = db.takes(seg["id"])[0][0], db.takes(seg["id"])[1][0]
    made = db.make(a, kf, "keyframe")
    key_frame = made["result_asset_id"]
    db.begin(clip)
    short = db.output(a.org, clip, duration=2)
    out = db.svc("select public.film_take_succeeded(%s::uuid, 'w-1', null, %s::uuid, %s::uuid, 'lab-task-1')", [clip, short, key_frame])
    assert out["accepted"] is False
    assert db.live(key_frame) is True and db.live(short) is False
    assert db.su("select charged_credits from public.film_takes where id = %s", [kf])[0][0] == 3


def test_a_paid_file_handed_in_as_a_rejected_clips_last_frame_is_never_discarded(db, a):
    """Round 4, Lens's first reproduction: a generated image registered after the clip began (here a Studio job's result the customer
    paid for) but named by no film table is not the take's output: its own record does not say so, and handing it in does not."""
    fid = db.film(a)
    seg = db.quoted_start(a, fid)
    db.claim()
    clip = db.takes(seg["id"])[1][0]
    db.begin(clip)
    paid = db.asset(a.org)  # registered after the begin, no provenance
    job = db.su("insert into public.creative_jobs (org_id, capability, requested_model, status, result_asset_ids) "
                "values (%s, 't2i', 'img-key', 'completed', array[%s::uuid]) returning id", [a.org, paid])[0][0]
    other = db.asset(a.org)  # registered after the begin, no provenance, no job: still not the take's
    try:
        for frame in (paid, other):
            short = db.output(a.org, clip, duration=2)
            out = db.svc("select public.film_take_succeeded(%s::uuid, 'w-1', null, %s::uuid, %s::uuid, 'lab-task-1')",
                         [clip, short, frame])
            assert out["accepted"] is False and db.live(short) is False and db.live(frame) is True, frame
            if out.get("retry_take_id"):
                clip = out["retry_take_id"]
                db.begin(clip)
    finally:
        db.su("delete from public.creative_jobs where id = %s", [job])


def test_a_generated_video_handed_to_a_failed_assembly_is_kept_unless_its_provenance_names_the_segment(db, a):
    """Round 4, Lens's second reproduction: a generated video registered after the claim, with no provenance, survives a failed
    assembly that names it; the segment's own file (provenance film_segment_id) is the one that goes."""
    fid = db.film(a)
    seg = db.quoted_start(a, fid)
    db.claim()
    db.finish_all(a, seg["id"])
    db.svc("select public.film_begin_assembly(%s, 'w-1')", [seg["id"]])
    someone_elses = db.asset(a.org, "video", "video/mp4")
    db.svc("select public.film_record_assembly(%s, 'w-1', false, %s::uuid)", [seg["id"], someone_elses])
    assert db.live(someone_elses) is True
    db.settle(seg["id"], "assembly_failed")  # one project at a time: the first one ends before the second starts
    fid2 = db.film(a)
    seg2 = db.quoted_start(a, fid2)
    db.claim()
    db.finish_all(a, seg2["id"])
    db.svc("select public.film_begin_assembly(%s, 'w-1')", [seg2["id"]])
    own = db.asset(a.org, "video", "video/mp4", provenance={"film_segment_id": seg2["id"]})
    db.svc("select public.film_record_assembly(%s, 'w-1', false, %s::uuid)", [seg2["id"], own])
    assert db.live(own) is False


def test_a_failed_assembly_never_discards_a_library_file(db, a):
    """H1, Lens's second reproduction: a failed assembly handed the organization's library image (the pricing stand-in) is refused,
    and a video that was in the library before the segment was claimed survives a failure that names it."""
    before = db.asset(a.org, "video", "video/mp4")
    fid = db.film(a)
    seg = db.quoted_start(a, fid)
    db.claim()
    db.finish_all(a, seg["id"])
    db.svc("select public.film_begin_assembly(%s, 'w-1')", [seg["id"]])
    assert err(lambda: db.svc("select public.film_record_assembly(%s, 'w-1', false, %s::uuid)", [seg["id"], a.image]))[:2] == \
        ("NS400", "invalid_params")
    db.su("update public.media_assets set created_at = created_at - interval '1 day' where id = %s", [before])
    out = db.svc("select public.film_record_assembly(%s, 'w-1', false, %s::uuid)", [seg["id"], before])
    assert out["assembly"]["status"] == "failed" and out["assembly"]["charged_credits"] == 0
    assert db.live(a.image) is True and db.live(before) is True
    q = db.quote(a.editor, db.film(a))
    assert q["priced"] is True  # the stand-in is still there to price a clip against


def test_a_lost_takes_file_named_by_its_provenance_is_not_kept(db, a):
    """M-b: a take file registered with provenance film_take_id (P3's contract) goes with a worker_lost, even with no job row; a file of
    the same provenance registered before the take began is not the take's output and stays."""
    fid = db.film(a)
    seg = db.quoted_start(a, fid)
    db.claim()
    clip = db.takes(seg["id"])[1][0]
    stale = db.asset(a.org, "video", "video/mp4", provenance={"film_take_id": str(clip)})
    db.su("update public.media_assets set created_at = created_at - interval '1 hour' where id = %s", [stale])
    db.begin(clip)
    made = db.asset(a.org, "video", "video/mp4", provenance={"film_take_id": str(clip)})
    db.su("update public.film_segments set deadline_at = now() - interval '3 hours' where id = %s", [seg["id"]])
    assert db.svc("select public.film_expire_segments()") == 1
    assert db.live(made) is False and db.live(stale) is True


def test_a_refused_hold_is_answered_and_recorded(db, a):
    """L6 + N3: reserve_credits' own 22023 (here forced by a lab trigger) is answered as hold_refused and leaves a film_events row."""
    fid = db.film(a)
    qid = db.quote(a.editor, fid)["quote_id"]
    db.su(f"""create or replace function lab_refuse_hold() returns trigger language plpgsql as $$
              begin if new.org_id = '{a.org}' then raise exception 'lab: no hold' using errcode = '22023'; end if; return new; end $$""")
    db.su("create trigger lab_refuse_hold before insert on public.credit_reservations for each row execute function lab_refuse_hold()")
    try:
        out = db.start(a.admin, fid, qid)
        assert refused(out) == ("hold_refused", "22023")
    finally:
        db.su("drop trigger lab_refuse_hold on public.credit_reservations")
        db.su("drop function lab_refuse_hold()")
    ev = db.su("select detail ->> 'reason', detail ->> 'code', actor_role from public.film_events where film_id = %s and event = 'start_refused'",
               [fid])
    assert ev == [("hold_refused", "22023", "admin")], ev
    assert db.holds(a.org) == [] and db.film_row(fid)[0] == "draft"


def test_cancel_waits_for_a_take_in_flight_then_releases_the_rest(db, a):
    fid = db.film(a)
    seg = db.quoted_start(a, fid)
    db.claim()
    clip = [t[0] for t in db.takes(seg["id"]) if t[1] == "clip"][0]
    db.begin(clip)
    out = db.cancel(seg["id"])
    assert (out["status"], out["settled"]) == ("draining", False) and db.film_row(fid)[0] == "draining"
    kf = [t[0] for t in db.takes(seg["id"]) if t[1] == "keyframe"][0]
    assert db.takes(seg["id"])[0][4] == "skipped"
    assert err(lambda: db.begin(kf))[:2] == ("NS409", "not_running")
    assert db.holds(a.org)[0][2] == "open"
    db.succeed(clip, None, db.asset(a.org, "video", "video/mp4"))
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
    db.su("update public.film_segments set heartbeat_at = now() - interval '11 minutes' where id = %s", [seg["id"]])
    assert db.claim("w-2")["worker_id"] == "w-2"
    assert err(lambda: db.begin(take, "w-1"))[:2] == ("NS409", "lease_lost")


def test_eleven_stale_reclaims_never_block_another_organizations_claim(db, a, b):
    """HIGH 1: a segment whose worker keeps dying uses its leases, then its take in flight ends as worker_lost and it settles; the
    attempts never pass the cap (the check that made the eleventh claim raise for everyone), and b's film is still claimed."""
    fid = db.film(a)
    seg = db.quoted_start(a, fid)
    assert db.claim()["id"] == seg["id"]
    kf = db.takes(seg["id"])[0][0]
    db.make(a, kf, "keyframe")
    clip = db.takes(seg["id"])[1][0]
    db.begin(clip)
    for _ in range(11):
        db.su("update public.film_segments set heartbeat_at = now() - interval '11 minutes' where id = %s and status <> 'settled' "
              "and status <> 'released'", [seg["id"]])
        db.claim()
        assert db.segment(seg["id"])[5] <= 3
    assert db.segment(seg["id"])[:3] == ("settled", 3, "worker_lost")
    lost = db.su("select status, charged_credits, charge_basis from public.film_takes where id = %s", [clip])[0]
    assert lost == ("failed", 0, "worker_lost_not_charged")
    assert db.film_row(fid) == ("paused", "worker_lost")
    other = db.quoted_start(b, db.film(b))
    assert db.claim()["id"] == other["id"]


def test_a_segment_that_raises_is_skipped_and_the_claim_goes_on(db, a, b):
    """HIGH 1, the isolation: one bad row (here a trigger the operator put on it) never takes the claim down for another film."""
    bad = db.quoted_start(a, db.film(a))
    good = db.quoted_start(b, db.film(b))
    db.su(f"""create or replace function pg_temp_lab_boom() returns trigger language plpgsql as $$
              begin if new.id = '{bad["id"]}' then raise exception 'lab: this row is broken'; end if; return new; end $$""")
    db.su("create trigger lab_boom before update on public.film_segments for each row execute function pg_temp_lab_boom()")
    try:
        assert db.claim()["id"] == good["id"]
        assert db.segment(bad["id"])[0] == "queued"
        # L4: a film_events row survives the rolled-back subtransaction, once an hour a segment and call.
        db.claim()
        skipped = db.su("select detail ->> 'segment_id', detail ->> 'call', detail ->> 'sqlstate', actor_role from public.film_events "
                        "where event = 'segment_skipped' and film_id = (select film_id from public.film_segments where id = %s)",
                        [bad["id"]])
        assert skipped == [(bad["id"], "claim", "P0001", "service")], skipped
    finally:
        db.su("drop trigger lab_boom on public.film_segments")
        db.su("drop function pg_temp_lab_boom()")


def test_a_hold_that_expired_before_the_claim_settles_the_segment_and_the_film_is_a_draft_again(db, a):
    fid = db.film(a)
    seg = db.quoted_start(a, fid)
    db.su("select public.release_credits(%s)", [seg["credit_ref"]])  # 0020's 3-hour expiry, as it would run
    assert db.claim() is None
    assert db.segment(seg["id"])[:3] == ("released", 0, "hold_expired")
    assert db.film_row(fid) == ("draft", "hold_expired") and db.ledger(a.org, "capture") == []


def test_no_take_begins_once_the_hold_is_gone_and_the_segment_settles_with_what_it_has(db, a):
    """Item 5: the hold is no longer open (0020 released it) under a running film."""
    fid = db.film(a)
    seg = db.quoted_start(a, fid)
    db.claim()
    kf, clip = db.takes(seg["id"])[0][0], db.takes(seg["id"])[1][0]
    db.make(a, kf, "keyframe")
    db.su("select public.release_credits(%s)", [seg["credit_ref"]])
    out = db.begin(clip)
    assert (out["began"], out["reason"], out["status"]) == (False, "hold_lost", "skipped")
    assert db.segment(seg["id"])[:3] == ("released", 0, "hold_lost")
    assert db.film_row(fid) == ("paused", "hold_lost")


def test_no_take_begins_while_a_refund_waits_to_collect_from_the_hold(db, a):
    """Item 5: an open credit_refund_recoveries row (0167) that lists the segment's hold stops new spending."""
    fid = db.film(a)
    seg = db.quoted_start(a, fid)
    db.claim()
    kf = db.takes(seg["id"])[0][0]
    rid = f"rf_{uuid.uuid4().hex[:12]}"
    db.su("insert into public.credit_refunds (refund_id, purchase_external_id, org_id, requested, taken, shortfall) "
          "values (%s, 'pay_lab', %s, 10, 0, 10)", [rid, a.org])
    db.su("insert into public.credit_refund_recoveries (refund_id, purchase_external_id, org_id, holds, owed) "
          "values (%s, 'pay_lab', %s, %s, 10)", [rid, a.org, [seg["credit_ref"]]])
    out = db.begin(kf)
    assert (out["began"], out["reason"]) == (False, "refund_pending")
    assert db.segment(seg["id"])[:3] == ("released", 0, "refund_pending")
    assert db.film_row(fid) == ("draft", "refund_pending")


def test_the_sweep_ends_a_take_in_flight_past_the_deadline_and_grace_and_settles_while_the_hold_is_open(db, a):
    """MEDIUM 2: past the deadline nothing new begins; past the deadline plus the grace (2 h, before 0020's 24 h expiry) the take in
    flight fails as worker_lost and the segment settles at what was made, with its hold still open until the capture."""
    fid = db.film(a)
    seg = db.quoted_start(a, fid)
    db.claim()
    kf, clip = db.takes(seg["id"])[0][0], db.takes(seg["id"])[1][0]
    db.make(a, kf, "keyframe")
    db.begin(clip)
    db.su("update public.film_segments set deadline_at = now() - interval '1 hour' where id = %s", [seg["id"]])
    assert db.svc("select public.film_expire_segments()") == 1
    assert db.segment(seg["id"])[0] == "draining" and db.holds(a.org)[0][2] == "open"
    assert db.svc("select public.film_expire_segments()") == 0  # draining with a take in flight: wait, and write nothing
    db.su("update public.film_segments set deadline_at = now() - interval '2 hours 1 minute' where id = %s", [seg["id"]])
    assert db.svc("select public.film_expire_segments()") == 1
    assert db.segment(seg["id"])[:3] == ("settled", 3, "deadline")
    assert db.su("select status, charge_basis from public.film_takes where id = %s", [clip])[0] == ("failed", "worker_lost_not_charged")
    assert db.holds(a.org)[0][1:] == (TOTAL, "captured", Decimal(3)) and db.film_row(fid) == ("paused", "deadline")


def test_a_film_nobody_claimed_is_settled_by_the_sweep_and_is_a_draft_again(db, a):
    lone = db.film(a)
    s_lone = db.quoted_start(a, lone)
    db.su("update public.film_segments set created_at = now() - interval '4 hours' where id = %s", [s_lone["id"]])
    assert db.svc("select public.film_expire_segments()") == 1
    assert db.segment(s_lone["id"])[:3] == ("released", 0, "worker_unavailable")
    assert db.film_row(lone) == ("draft", "worker_unavailable") and db.account(a.org)[1] == 0
    assert db.svc("select public.film_expire_segments()") == 0


def test_settled_money_is_what_the_ledger_moved_even_when_the_hold_expired_mid_film(db, a):
    fid = db.film(a)
    seg = db.quoted_start(a, fid)
    db.claim()
    db.make(a, db.takes(seg["id"])[0][0], "keyframe")
    db.su("select public.release_credits(%s)", [seg["credit_ref"]])
    out = db.settle(seg["id"], "hold_expired")
    assert (out["status"], out["captured_credits"], out["charged_credits"]) == ("released", 0, 3)
    detail = db.su("select detail from public.film_events where film_id = %s and event = 'segment_settled'", [fid])[0][0]
    assert detail["not_captured"] == 3 and db.film_row(fid) == ("paused", "hold_expired")


# ── the migration ───────────────────────────────────────────────────────────

SNAPSHOT = """
select jsonb_build_object(
  'constraints', (select jsonb_agg(conname || ' ' || pg_get_constraintdef(oid) order by conname) from pg_constraint
                   where conrelid = any(array['public.film_segments','public.org_film_settings','public.film_takes','public.films',
                                              'public.creative_jobs','public.film_quotes','public.film_studio_settings']::regclass[])),
  'indexes', (select jsonb_agg(indexdef order by indexname) from pg_indexes where schemaname = 'public'
               and (tablename like 'film%' or tablename in ('org_film_settings', 'creative_jobs'))),
  'policies', (select jsonb_agg(policyname || ' ' || qual order by policyname) from pg_policies
                where tablename in ('film_segments', 'org_film_settings')),
  'functions', (select jsonb_agg(p.oid::regprocedure::text || ' ' || md5(p.prosrc) || ' ' || coalesce(array_to_string(p.proacl, ','), '')
                                 order by p.oid::regprocedure::text)
                  from pg_proc p where p.pronamespace = 'public'::regnamespace
                   and (p.proname like 'film\\_%' or p.proname in ('quote_film', 'start_film', 'set_film_studio_enabled'))),
  'columns', (select jsonb_agg(table_name || '.' || column_name || ' ' || data_type order by table_name, column_name)
                from information_schema.columns where table_schema = 'public'
                 and table_name in ('film_segments', 'org_film_settings', 'film_takes', 'creative_jobs', 'film_quotes',
                                    'film_studio_settings')),
  'column_grants', (select jsonb_agg(grantee || ' ' || table_name || '.' || column_name || ' ' || privilege_type
                                     order by grantee, table_name, column_name, privilege_type)
                      from information_schema.column_privileges where table_schema = 'public'
                       and table_name in ('film_segments', 'org_film_settings', 'film_takes')),
  'rows', (select jsonb_build_array((select count(*) from public.film_segments), (select count(*) from public.film_takes),
                                    (select count(*) from public.film_quotes),
                                    (select film_studio_enabled from public.film_studio_settings),
                                    (select md5(string_agg(to_jsonb(s)::text, ',' order by id)) from public.film_segments s))))
"""


def test_reapplying_the_migration_changes_nothing(db, a):
    fid = db.film(a)
    db.quoted_start(a, fid)
    with psycopg.connect(db.dsn, autocommit=False) as c:
        # 0179 replaces start_film (0171's drift guard refuses its body): compared on 0171 alone, inside one transaction.
        sec_db.take_off_0179(c)
        before = c.execute(SNAPSHOT).fetchone()[0]
        c.execute(MIGRATION.read_text(encoding="utf-8"))
        c.execute(MIGRATION.read_text(encoding="utf-8"))
        assert c.execute(SNAPSHOT).fetchone()[0] == before
        c.rollback()


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
        # Item 10: a superset that still names every earlier word is refused too (the exact set of quoted words is compared).
        c.execute("alter table public.creative_jobs drop constraint creative_jobs_payer_check")
        c.execute("alter table public.creative_jobs add constraint creative_jobs_payer_check "
                  "check (payer in ('credits', 'api_balance', 'film', 'free'))")
        with pytest.raises(psycopg.Error) as e:
            c.execute(text)
        assert "creative_jobs_payer_check that is not 0036's or this file's" in str(e.value)
        c.rollback()
        c.execute("alter table public.films drop constraint films_status_check")
        c.execute("alter table public.films add constraint films_status_check check (status in ('draft', 'planning', 'planned', "
                  "'queued', 'running', 'draining', 'paused', 'assembling', 'ready', 'failed', 'cancelled', 'archived', 'bogus') "
                  "and (pause_reason is null or pause_reason ~ '^[a-z][a-z0-9_]{0,63}$') "
                  "and (pause_detail is null or public.film_text_ok(pause_detail, 1, 500, false)) "
                  "and ((status = 'archived') = (archived_at is not null)))")
        with pytest.raises(psycopg.Error) as e:
            c.execute(text)
        assert "films_status_check that is not 0166's or this file's" in str(e.value)
        c.rollback()
        c.execute("alter table public.film_segments rename column assembly_confirmed_credits to asm_credits")
        with pytest.raises(psycopg.Error) as e:
            c.execute(text)
        assert "public.film_segments that is not this file's" in str(e.value)
        c.rollback()
    assert db.su("select public.film_moderation_billing('vid-hh')")[0][0] == "not_billed"


def test_the_rollback_refuses_while_a_segment_lives_then_takes_everything_out_and_0171_applies_again(db, a):
    fid = db.film(a)
    seg = db.quoted_start(a, fid)
    with psycopg.connect(db.dsn, autocommit=False) as c:
        sec_db.take_off_0179(c)  # 0179 sits on 0171's start_film; 0171's rollback refuses any other body
        with pytest.raises(psycopg.Error) as e:
            c.execute(sec_db.rollback_0171_body(override=True))
        assert "film segments are live" in str(e.value)
        c.rollback()
    db.cancel(seg["id"])
    with psycopg.connect(db.dsn, autocommit=False) as c:
        sec_db.take_off_0179(c)
        with pytest.raises(psycopg.Error) as e:
            c.execute(sec_db.rollback_0171_body(override=False))
        assert "film segments exist and their record would be deleted" in str(e.value)
        c.rollback()
        sec_db.take_off_0179(c)
        c.execute(sec_db.rollback_0171_body(override=True))
        assert c.execute("select to_regclass('public.film_segments'), to_regclass('public.film_quotes'), "
                         "to_regclass('public.film_studio_settings'), to_regprocedure('public.start_film(uuid, text, text)')").fetchone() \
            == (None, None, None, None)
        assert "'queued'" not in c.execute("select pg_get_constraintdef(oid) from pg_constraint where conname = 'films_status_check'").fetchone()[0]
        assert c.execute("select count(*) from information_schema.columns where table_name = 'creative_jobs' "
                         "and column_name = 'film_take_id'").fetchone()[0] == 0
        assert c.execute("select count(*) from public.credit_transactions where job_id = %s", [seg["credit_ref"]]).fetchone()[0] == 2
        c.execute(MIGRATION.read_text(encoding="utf-8"))
        assert c.execute("select has_function_privilege('authenticated', 'public.start_film(uuid, text, text)', 'execute')").fetchone()[0]
        assert c.execute("select public.film_studio_on()").fetchone()[0] is False  # the switch comes back OFF
        c.rollback()  # the lab keeps its segments: the whole round trip is undone
    assert db.segment(seg["id"])[0] == "released"


def test_the_rollback_refuses_a_body_that_is_not_its_own(db):
    """Item 14: every function body is pinned, not only the browser's."""
    with psycopg.connect(db.dsn, autocommit=False) as c:
        c.execute("create or replace function public.film_stand_in(p_org uuid) returns uuid "
                  "language sql stable security definer set search_path = public, pg_temp as $$ select null::uuid $$")
        with pytest.raises(psycopg.Error) as e:
            c.execute(sec_db.rollback_0171_body(override=True))
        assert "film_stand_in(uuid) is missing or is not 0171's body" in str(e.value)
        c.rollback()

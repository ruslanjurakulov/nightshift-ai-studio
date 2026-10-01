"""Auto-captions (0072), attacked in a real database.

captions name their input recording by a media asset id, like 0050's voice
tools, and their result is DATA in a new table, public.caption_tracks. The
database alone decides whether the recording may be used (an audio or video
file of the SAME organization, live, a type the provider takes, at most 30
minutes, of a measured length) and what it costs (the recording's seconds at
the model's credit price — set by the platform admin; until then nothing can
be quoted or held). Bob (org B) tries to caption Alice's recording every way
the API lets him: the answer must be exactly the answer for an id that does
not exist, and nothing may be held.

The new table is the point of the second half. A transcript of one
organization must never be readable by another's member, by anon, or by the
owner's own members before the job that paid for it has completed; nobody
writes it directly (the service key included — it bypasses RLS, not
privileges); only the worker holding the job stores it, in the JOB's
organization, and only well-formed words in time order; only an editor of the
organization may hide it, and another organization's track reads exactly like
a made-up one.

0072 is built on 0055 / 0052 / 0050: the same functions are replaced, so the
lab also proves that applying 0072 keeps describe, the voice tools and the
video upscale quoting exactly as they did.

Runs in its own scratch database (it commits), like the 0046, 0050 and 0055 labs.
"""
import json
import os
import uuid

import psycopg
import pytest

import sec_db
from test_sec_creative_media_inputs import Db, err, footprint, svc

ORG_A = "aaaaaaaa-0000-0000-0000-0000000000e9"
ORG_B = "bbbbbbbb-0000-0000-0000-0000000000e9"
UA = str(uuid.UUID(int=0xE9A))   # viewer of A
UE = str(uuid.UUID(int=0xE9E))   # editor of A
UB = str(uuid.UUID(int=0xE9B))   # owner of B
UV = str(uuid.UUID(int=0xE9C))   # viewer of B
UNIT = "model_scribe_second"

MODELS = [
    ("scribe", "captions", UNIT, {"languages": ["uz", "ru", "en"]}),
    ("scribe-narrow", "captions", "model_scribe_narrow_second", {"languages": ["uz"]}),
    ("scribe-unpriced", "captions", "model_scribe_unpriced_second", {"languages": ["uz", "ru", "en"]}),
]
WORDS = [{"t": "Salom", "s": 0.1, "e": 0.5}, {"t": "dunyo", "s": 0.6, "e": 1.1}]


@pytest.fixture(scope="module")
def db():
    admin = sec_db.admin_dsn()
    if not admin:
        if os.environ.get("NIGHTSHIFT_SECURITY_REQUIRED"):
            pytest.fail(f"{sec_db.DSN_ENV} is not set", pytrace=False)
        pytest.skip(f"{sec_db.DSN_ENV} is not set — the security lab needs a scratch Postgres")
    name = f"ns_captions_{uuid.uuid4().hex[:8]}"
    d = Db(sec_db.build(admin, name))
    d.su("insert into auth.users (id, email) values (%s,'a9@x.io'),(%s,'e9@x.io'),(%s,'b9@x.io'),(%s,'v9@x.io')",
         [UA, UE, UB, UV])
    d.su("insert into public.organizations (id, name, slug) values (%s,'A9','org-a9'),(%s,'B9','org-b9')",
         [ORG_A, ORG_B])
    d.su("insert into public.org_members (org_id, user_id, email, role) values "
         "(%s,%s,'a9@x.io','viewer'),(%s,%s,'e9@x.io','editor'),(%s,%s,'b9@x.io','owner'),(%s,%s,'v9@x.io','viewer')",
         [ORG_A, UA, ORG_A, UE, ORG_B, UB, ORG_B, UV])
    d.su("select public.grant_credits(%s, 100, 'test')", [ORG_A])
    d.su("select public.grant_credits(%s, 100, 'test')", [ORG_B])
    rows = [{"id": m, "display_name": m, "provider": "acme", "adapter": "audio.acme_scribe", "capabilities": [cap],
             "credit_unit": unit, "entitlement": None,
             "spec": {"vendor_model": "acme-" + m, "output": "text", **extra}}
            for m, cap, unit, extra in MODELS]
    # The earlier tools, to prove 0072 did not take them away.
    rows += [
        {"id": "seer", "display_name": "seer", "provider": "acme", "adapter": "image.acme_describe",
         "capabilities": ["describe"], "credit_unit": "model_seer_request", "entitlement": None,
         "spec": {"vendor_model": "acme-seer", "output": "text"}},
        {"id": "dubber", "display_name": "dubber", "provider": "acme", "adapter": "audio.acme_dub",
         "capabilities": ["dub"], "credit_unit": "model_dubber_second", "entitlement": "any",
         "spec": {"vendor_model": "acme-dubber", "output": "audio", "languages": ["ru"]}},
        {"id": "vup", "display_name": "vup", "provider": "acme", "adapter": "video.acme_up",
         "capabilities": ["video_upscale"], "credit_unit": "model_vup_second", "entitlement": "any",
         "spec": {"vendor_model": "acme-vup", "output": "video", "upscale_targets": ["4k"],
                  "limits": {"max_source_seconds": 30}}},
    ]
    d.su("select public.sync_model_registry(%s::jsonb)", [json.dumps(rows)])
    for r in rows:
        if r["id"] in ("scribe-unpriced",):
            pass
        d.su("select public.record_model_probe(%s, %s, %s, %s, true, null, null, 10, 100, 'security-lab')",
             [r["id"], r["adapter"], "acme-" + r["id"], r["capabilities"][0]])
        d.su("update public.model_registry set availability='beta' where id=%s", [r["id"]])
    # Only "scribe" and "scribe-narrow" have a price: the other is what a
    # model looks like before the admin has set one on the Credits page.
    d.su("insert into public.credit_prices (unit, credits_per_unit, margin) values "
         f"('{UNIT}', 0.1, 0), ('model_scribe_narrow_second', 0.1, 0), ('model_seer_request', 0.5, 0), "
         "('model_dubber_second', 1, 0), ('model_vup_second', 1, 0), ('job_minimum', 1, 0) "
         "on conflict (unit) do update set credits_per_unit = excluded.credits_per_unit, margin = 0")
    d.assets = {
        "a_mp3": rec(d, ORG_A, "audio", "audio/mpeg", dur=61.2),
        "a_mp4": rec(d, ORG_A, "video", "video/mp4", dur=30),
        "a_aac": rec(d, ORG_A, "audio", "audio/aac", dur=10),
        "a_exe": rec(d, ORG_A, "audio", "application/x-msdownload", dur=10),
        "a_png": rec(d, ORG_A, "image", "image/png", dur=None),
        "a_long": rec(d, ORG_A, "audio", "audio/mpeg", dur=1801),
        "a_max": rec(d, ORG_A, "audio", "audio/mpeg", dur=1800),
        "a_unknown_len": rec(d, ORG_A, "audio", "audio/mpeg", dur=None),
        "a_huge": rec(d, ORG_A, "audio", "audio/mpeg", dur=60, nbytes=513 * 1024 * 1024),
        "a_deleted": rec(d, ORG_A, "audio", "audio/mpeg", dur=10),
        "b_mp3": rec(d, ORG_B, "audio", "audio/mpeg", dur=20),
    }
    d.act("authenticated", UE, "select public.soft_delete_asset(%s)", [d.assets["a_deleted"]])
    try:
        yield d
    finally:
        if not os.environ.get("NIGHTSHIFT_SECURITY_KEEP"):
            sec_db.drop_database(admin, name)


def rec(d, org, kind, mime, *, dur, nbytes=1000):
    aid = str(uuid.uuid4())
    d.act("service_role", None,
          "select public.register_asset(%s, %s, %s, %s, %s, %s, 'generated', "
          "p_duration_s => %s::numeric, p_provenance => '{\"job_id\":\"seed\"}'::jsonb)",
          [aid, org, kind, mime, nbytes, uuid.uuid4().hex * 2, dur])
    return aid


def quote(db, uid, org, params, model="scribe", cap="captions"):
    return db.act("authenticated", uid, "select public.quote_creative_job(%s,%s,%s,%s::jsonb)",
                  [org, cap, model, json.dumps(params)])[0][0]


def create(db, uid, org, params, maxc=1000, key=None, model="scribe"):
    return db.act("authenticated", uid,
                  "select public.create_creative_job(%s,'captions',%s,%s::jsonb,'exact',%s::text,%s::numeric)",
                  [org, model, json.dumps(params), key, maxc])[0][0]


def drain(db):
    """End every unfinished job, whoever holds it: a test's own job must never
    leave a hold that blocks the next (the plan allows one parallel run)."""
    while svc(db, "select id from public.claim_creative_job('drain')"):
        pass
    for jid, worker in db.su("select id::text, worker_id from public.creative_jobs "
                             "where status in ('running','provider_pending','processing')"):
        svc(db, "select public.finish_creative_job(%s,%s,false,null,null,'test_drain','drained')", [jid, worker])


def src(aid, **extra):
    return {"source_asset_id": aid, **extra}


def start(db, jid, worker="w1"):
    """Claim the job and walk it to 'processing' like the worker does."""
    assert svc(db, "select id::text from public.claim_creative_job(%s)", [worker])[0][0] == jid
    svc(db, "select public.advance_creative_job(%s,%s,'submitting')", [jid, worker])
    svc(db, "select public.advance_creative_job(%s,%s,'submitted','sync:abc')", [jid, worker])
    svc(db, "select public.advance_creative_job(%s,%s,'processing')", [jid, worker])


def store(db, jid, words=WORDS, worker="w1", language="uz", duration=95):
    return str(svc(db, "select public.store_caption_track(%s,%s,%s,%s,%s::jsonb)",
               [jid, worker, language, duration, json.dumps(words)])[0][0])


def finish(db, jid, track, worker="w1"):
    return svc(db, "select public.finish_creative_job(%s,%s,true,null,%s::jsonb)",
               [jid, worker, json.dumps({"track_id": track, "language": "uz", "words": 2, "storage": "table"})])[0][0]


def tracks(db, role, uid, org=None):
    q = "select id::text from public.caption_tracks" + (" where org_id=%s" if org else "")
    return [r[0] for r in db.act(role, uid, q, [org] if org else None)]


# ── the price: the recording's seconds, the admin's price, never a guess ────

def test_captions_are_priced_by_the_recordings_seconds_as_the_database_measured_them(db):
    q = quote(db, UA, ORG_A, src(db.assets["a_mp3"], language="uz"))
    # 61.2 s rounds up to 62 s x 0.1 credits.
    assert (q["quantity"], q["unit"], float(q["credits"])) == (62, UNIT, 6.2)
    video = quote(db, UA, ORG_A, src(db.assets["a_mp4"]))
    assert (video["quantity"], float(video["credits"])) == (30, 3.0)


def test_the_longest_recording_is_30_minutes(db):
    assert quote(db, UA, ORG_A, src(db.assets["a_max"]))["quantity"] == 1800
    st, word, detail = err(lambda: quote(db, UA, ORG_A, src(db.assets["a_long"])))
    assert (st, word) == ("NS400", "source_unavailable") and "30 minutes" in detail


def test_until_the_admin_sets_a_price_the_quote_says_so_and_nothing_is_held(db):
    drain(db)
    before = footprint(db, ORG_A)
    st, word, _ = err(lambda: quote(db, UA, ORG_A, src(db.assets["a_mp3"]), model="scribe-unpriced"))
    assert (st, word) == ("NS400", "unpriced")
    st, word, _ = err(lambda: create(db, UA, ORG_A, src(db.assets["a_mp3"]), model="scribe-unpriced"))
    assert (st, word) == ("NS400", "unpriced")
    assert footprint(db, ORG_A) == before


def test_a_language_the_model_was_not_proven_for_is_not_sold_and_none_is_allowed(db):
    drain(db)
    before = footprint(db, ORG_A)
    st, word, detail = err(lambda: quote(db, UA, ORG_A, src(db.assets["a_mp3"], language="ru"), model="scribe-narrow"))
    assert (st, word) == ("NS400", "invalid_params") and "does not transcribe ru" in detail
    st, word, _ = err(lambda: create(db, UA, ORG_A, src(db.assets["a_mp3"], language="en"), model="scribe-narrow"))
    assert (st, word) == ("NS400", "invalid_params")
    assert footprint(db, ORG_A) == before
    # Named and listed, or not named at all (the provider detects it).
    assert quote(db, UA, ORG_A, src(db.assets["a_mp3"], language="uz"), model="scribe-narrow")["quantity"] == 62
    assert quote(db, UA, ORG_A, src(db.assets["a_mp3"]), model="scribe-narrow")["quantity"] == 62


def test_one_key_per_press_holds_once_and_the_confirmed_price_is_the_ceiling(db):
    drain(db)
    st, word, _ = err(lambda: create(db, UA, ORG_A, src(db.assets["a_mp3"]), maxc=5))
    assert (st, word) == ("NS409", "price_changed")
    key = "editor:" + uuid.uuid4().hex
    first = create(db, UA, ORG_A, src(db.assets["a_mp3"]), key=key)
    again = create(db, UA, ORG_A, src(db.assets["a_mp3"]), key=key)
    assert again["replay"] is True and again["job"]["id"] == first["job"]["id"]
    assert db.su("select count(*), sum(amount)::float from public.credit_reservations where job_id=%s",
                 ["cj:" + first["job"]["id"]]) == [(1, 6.2)]
    drain(db)


# ── the recording must be the organization's own ────────────────────────────

@pytest.mark.parametrize("call", ["quote", "create"])
def test_another_orgs_recording_reads_exactly_like_a_made_up_one(db, call):
    drain(db)
    fn = quote if call == "quote" else create
    before = footprint(db, ORG_B)
    st, word, detail = err(lambda: fn(db, UB, ORG_B, src(db.assets["a_mp3"])))
    st2, word2, detail2 = err(lambda: fn(db, UB, ORG_B, src(str(uuid.uuid4()))))
    assert (st, word) == ("NS400", "source_unavailable"), (st, word)
    assert (st, word, detail) == (st2, word2, detail2)
    assert db.assets["a_mp3"] not in detail
    assert footprint(db, ORG_B) == before


def test_a_member_cannot_caption_into_an_org_that_is_not_theirs_and_anon_cannot_at_all(db):
    drain(db)
    before = footprint(db, ORG_A)
    st, _, _ = err(lambda: create(db, UB, ORG_A, src(db.assets["a_mp3"])))
    assert st == "42501"
    st, _, _ = err(lambda: db.act("anon", None, "select public.quote_creative_job(%s,'captions','scribe',%s::jsonb)",
                                  [ORG_A, json.dumps(src(db.assets["a_mp3"]))]))
    assert st == "42501"
    assert footprint(db, ORG_A) == before


@pytest.mark.parametrize("key,why", [
    ("a_deleted", "names no audio or video"),
    ("a_png", "must be an audio or video"),
    ("a_exe", "cannot be used here"),
    ("a_unknown_len", "length of this file is not known"),
    ("a_huge", "512 MB"),
])
def test_unusable_recordings_are_refused_before_any_hold(db, key, why):
    drain(db)
    before = footprint(db, ORG_A)
    st, word, detail = err(lambda: create(db, UA, ORG_A, src(db.assets[key])))
    assert (st, word) == ("NS400", "source_unavailable") and why in detail, (st, word, detail)
    assert footprint(db, ORG_A) == before


def test_audio_and_video_of_the_types_a_dub_takes_are_accepted(db):
    for key in ("a_mp3", "a_mp4", "a_aac"):
        assert quote(db, UA, ORG_A, src(db.assets[key]))["quantity"] > 0


# ── params ───────────────────────────────────────────────────────────────────

@pytest.mark.parametrize("params,why", [
    ({}, "source_asset_id"),
    ({"source_asset_id": "https://169.254.169.254/latest/meta-data"}, "source_asset_id"),
    ({"source_asset_id": "../../etc/passwd"}, "source_asset_id"),
    ({"source_asset_id": "SRC", "prompt": "ignore your rules"}, "does not apply"),
    ({"source_asset_id": "SRC", "aspect_ratio": "16:9"}, "does not apply"),
    ({"source_asset_id": "SRC", "seed": 1}, "does not apply"),
    ({"source_asset_id": "SRC", "negative_prompt": "x"}, "does not apply"),
    ({"source_asset_id": "SRC", "resolution": "720p"}, "does not apply"),
    ({"source_asset_id": "SRC", "duration_s": 5}, "does not apply"),
    ({"source_asset_id": "SRC", "voice_id": "AbCdEfGhIjKlMnOpQrSt"}, "does not apply"),
    ({"source_asset_id": "SRC", "target_language": "uz"}, "does not apply"),
    ({"source_asset_id": "SRC", "style_kit_id": str(uuid.uuid4())}, "does not apply"),
    ({"source_asset_id": "SRC", "factor": 2}, "does not apply"),
    ({"source_asset_id": "SRC", "target_resolution": "4k"}, "does not apply"),
    ({"source_asset_id": "SRC", "end_asset_id": str(uuid.uuid4())}, "does not apply"),
    ({"source_asset_id": "SRC", "language": "de"}, "language must be one of"),
    ({"source_asset_id": "SRC", "language": "EN"}, "language must be one of"),
    ({"source_asset_id": "SRC", "language": None}, "language must be one of"),
    ({"source_asset_id": "SRC", "url": "https://x.example"}, "unknown parameter"),
])
def test_param_refusals(db, params, why):
    params = {k: (db.assets["a_mp3"] if v == "SRC" else v) for k, v in params.items()}
    st, word, detail = err(lambda: quote(db, UA, ORG_A, params))
    assert (st, word) == ("NS400", "invalid_params") and why in detail, (st, word, detail)


def test_the_spoken_language_belongs_to_describe_and_captions_only(db):
    st, word, detail = err(lambda: db.act("authenticated", UA,
                                          "select public.quote_creative_job(%s,'dub','dubber',%s::jsonb)",
                                          [ORG_A, json.dumps({"source_asset_id": db.assets["a_mp3"],
                                                              "target_language": "ru", "language": "en"})]))
    assert (st, word) == ("NS400", "invalid_params") and "language does not apply to dub" in detail


# ── the earlier tools are exactly as they were ──────────────────────────────

def test_describe_dub_and_video_upscale_still_quote_as_before(db):
    d = db.act("authenticated", UA, "select public.quote_creative_job(%s,'dub','dubber',%s::jsonb)",
               [ORG_A, json.dumps({"source_asset_id": db.assets["a_mp3"], "target_language": "ru"})])[0][0]
    assert (d["quantity"], float(d["credits"])) == (62, 62.0)
    st, word, _ = err(lambda: db.act("authenticated", UA, "select public.quote_creative_job(%s,'dub','dubber',%s::jsonb)",
                                     [ORG_A, json.dumps({"source_asset_id": db.assets["a_mp3"], "target_language": "uz"})]))
    assert (st, word) == ("NS400", "invalid_params")
    v = db.act("authenticated", UA, "select public.quote_creative_job(%s,'video_upscale','vup',%s::jsonb)",
               [ORG_A, json.dumps({"source_asset_id": db.assets["a_mp4"], "target_resolution": "4k"})])[0][0]
    assert (v["quantity"], float(v["credits"])) == (30, 30.0)
    st, word, _ = err(lambda: db.act("authenticated", UA, "select public.quote_creative_job(%s,'describe','seer',%s::jsonb)",
                                     [ORG_A, json.dumps({"source_asset_id": db.assets["a_mp3"], "language": "uz"})]))
    # An audio file is not a picture: describe's own picture check still decides.
    assert (st, word) == ("NS400", "source_unavailable")


# ── the track: money first, then data, visible only once paid ───────────────

def test_a_finished_job_has_a_track_its_org_reads_and_no_other_org_does(db):
    drain(db)
    j = create(db, UA, ORG_A, src(db.assets["a_mp3"], language="uz"))["job"]
    start(db, j["id"])
    tid = store(db, j["id"])
    # Stored but not yet paid for: nobody sees a transcript of an unsettled job.
    assert tracks(db, "authenticated", UA) == []
    assert tracks(db, "authenticated", UE) == []
    done = finish(db, j["id"], tid)
    assert done["status"] == "completed" and done["result"]["track_id"] == tid
    assert done["result_asset_ids"] == []
    # The organization's members read it — the viewer who asked, the editor too.
    assert tracks(db, "authenticated", UA) == [tid]
    assert tracks(db, "authenticated", UE) == [tid]
    # Another organization's members (owner and viewer), and anon, read nothing of it.
    assert tracks(db, "authenticated", UB) == []
    assert tracks(db, "authenticated", UV) == []
    st, _, _ = err(lambda: tracks(db, "anon", None))
    assert st == "42501"
    # What was stored is the job's organization and recording, not anything the worker named.
    org, asset, lang, n, dur = db.su(
        "select org_id::text, asset_id::text, language, word_count, duration_s::float "
        "from public.caption_tracks where id=%s", [tid])[0]
    assert (org, asset, lang, n, dur) == (ORG_A, db.assets["a_mp3"], "uz", 2, 95.0)
    # The hold was captured at most the quote: the customer paid the quoted 6.2.
    assert float(done["charged_credits"]) <= float(done["quoted_credits"]) == 6.2


def test_a_job_that_fails_after_storing_never_shows_its_transcript(db):
    drain(db)
    j = create(db, UA, ORG_A, src(db.assets["a_mp3"]))["job"]
    start(db, j["id"])
    tid = store(db, j["id"])
    svc(db, "select public.finish_creative_job(%s,'w1',false,null,null,'bad_response','could not settle')", [j["id"]])
    assert db.su("select status from public.creative_jobs where id=%s", [j["id"]]) == [("failed",)]
    assert tid not in tracks(db, "authenticated", UA)
    assert tid not in tracks(db, "authenticated", UE)
    # And the hold is back: nothing was charged for the failed job.
    assert db.su("select count(*) from public.credit_reservations where job_id=%s and status='captured'",
                 ["cj:" + j["id"]]) == [(0,)]


def test_a_captions_job_cannot_finish_with_a_result_that_names_no_track(db):
    drain(db)
    j = create(db, UA, ORG_A, src(db.assets["a_mp3"]))["job"]
    start(db, j["id"])
    for bad in ({"text": "hello"}, {"track_id": "not-a-uuid"}, {"track_id": 5}, {}):
        st, _, _ = err(lambda: svc(db, "select public.finish_creative_job(%s,'w1',true,null,%s::jsonb)",
                                   [j["id"], json.dumps(bad)]))
        assert st == "23514", bad
    assert db.su("select status from public.creative_jobs where id=%s", [j["id"]]) == [("processing",)]
    drain(db)


def test_a_captions_job_never_has_library_assets(db):
    st, _, _ = err(lambda: db.su(
        "update public.creative_jobs set result_asset_ids = array[gen_random_uuid()] where id = "
        "(select id from public.creative_jobs where capability='captions' limit 1)"))
    assert st == "23514"


# ── store_caption_track: only the holding worker, only good words ───────────

def test_only_the_worker_holding_a_captions_job_may_store_its_track(db):
    drain(db)
    j = create(db, UA, ORG_A, src(db.assets["a_mp3"]))["job"]
    # Queued: not held by anyone yet.
    st, _, _ = err(lambda: store(db, j["id"]))
    assert st == "55000"
    start(db, j["id"])
    st, _, _ = err(lambda: store(db, j["id"], worker="w2"))
    assert st == "55000"
    # Not a captions job: a describe-shaped job of the same org is refused.
    other = db.su("select id::text from public.creative_jobs where capability <> 'captions' limit 1")
    if other:
        st, _, _ = err(lambda: store(db, other[0][0]))
        assert st in ("55000", "P0002")
    st, _, _ = err(lambda: store(db, str(uuid.uuid4())))
    assert st == "55000"
    drain(db)


def test_nobody_but_the_service_role_can_store_a_track(db):
    drain(db)
    j = create(db, UA, ORG_A, src(db.assets["a_mp3"]))["job"]
    start(db, j["id"])
    args = [j["id"], "w1", "uz", 95, json.dumps(WORDS)]
    for role, uid in (("authenticated", UA), ("authenticated", UE), ("authenticated", UB), ("anon", None)):
        st, _, _ = err(lambda: db.act(role, uid, "select public.store_caption_track(%s,%s,%s,%s,%s::jsonb)", args))
        assert st == "42501", role
    drain(db)


@pytest.mark.parametrize("words,why", [
    ([], "1 to 20000"),
    ("x", "JSON array"),
    ([{"t": "a", "s": 0, "e": 0}], "malformed"),
    ([{"t": "a", "s": 1, "e": 0.5}], "malformed"),
    ([{"t": "a", "s": -1, "e": 0.5}], "malformed"),
    ([{"t": "", "s": 0, "e": 1}], "malformed"),
    ([{"t": "x" * 81, "s": 0, "e": 1}], "malformed"),
    ([{"t": "a\u0000b", "s": 0, "e": 1}], "malformed"),
    ([{"t": "a\x07b", "s": 0, "e": 1}], "malformed"),
    ([{"t": 5, "s": 0, "e": 1}], "malformed"),
    ([{"t": "a", "s": "0", "e": 1}], "malformed"),
    ([{"t": "a", "s": 0, "e": None}], "malformed"),
    ([{"t": "a", "s": 0, "e": 99999}], "malformed"),
    ([{"s": 0, "e": 1}], "malformed"),
    (["a", 3, None], "malformed"),
    ([{"t": "a", "s": 0, "e": 2}, {"t": "b", "s": 1, "e": 3}], "time order"),
])
def test_malformed_words_are_refused_with_a_clean_error(db, words, why):
    drain(db)
    j = create(db, UA, ORG_A, src(db.assets["a_mp3"]))["job"]
    start(db, j["id"])
    st, _, _ = err(lambda: svc(db, "select public.store_caption_track(%s,'w1','uz',95,%s::jsonb)",
                               [j["id"], json.dumps(words)]))
    # 22P05: a NUL never even becomes jsonb; everything else is the function's own 22023.
    assert st in ("22023", "22P05"), (words, st)
    assert db.su("select count(*) from public.caption_tracks where job_id=%s", [j["id"]]) == [(0,)]
    drain(db)


def test_the_language_and_duration_are_checked(db):
    drain(db)
    j = create(db, UA, ORG_A, src(db.assets["a_mp3"]))["job"]
    start(db, j["id"])
    for lang, dur in (("UZ", 95), ("uzbek", 95), ("", 95), ("u", 95), ("uz", 0), ("uz", -1), ("uz", 99999)):
        st, _, _ = err(lambda: store(db, j["id"], language=lang, duration=dur))
        assert st == "22023", (lang, dur)
    drain(db)


def test_storing_twice_answers_the_same_track(db):
    drain(db)
    j = create(db, UA, ORG_A, src(db.assets["a_mp3"]))["job"]
    start(db, j["id"])
    first = store(db, j["id"])
    second = store(db, j["id"], words=WORDS + [{"t": "!", "s": 1.2, "e": 1.3}])
    assert first == second
    assert db.su("select count(*), max(word_count) from public.caption_tracks where job_id=%s", [j["id"]]) == [(1, 3)]
    drain(db)


# ── nobody writes the table directly ────────────────────────────────────────

@pytest.mark.parametrize("role,uid", [("authenticated", UA), ("authenticated", UE), ("authenticated", UB),
                                       ("service_role", None), ("anon", None)])
def test_no_direct_writes_for_anyone(db, role, uid):
    for q in ("insert into public.caption_tracks (org_id, job_id, language, duration_s, word_count, words) "
              "values (%s, gen_random_uuid(), 'uz', 1, 1, '[{\"t\":\"a\",\"s\":0,\"e\":1}]')",
              "update public.caption_tracks set language = 'ru' where org_id = %s",
              "delete from public.caption_tracks where org_id = %s"):
        st, _, _ = err(lambda: db.act(role, uid, q, [ORG_A]))
        assert st == "42501", (role, q)


def test_rls_is_on_and_anon_has_no_grant(db):
    assert db.su("select relrowsecurity from pg_class where oid = 'public.caption_tracks'::regclass") == [(True,)]
    assert db.su("select has_table_privilege('anon', 'public.caption_tracks', 'SELECT'), "
                 "has_table_privilege('authenticated', 'public.caption_tracks', 'SELECT'), "
                 "has_table_privilege('authenticated', 'public.caption_tracks', 'INSERT')") == [(False, True, False)]


# ── hiding a track ───────────────────────────────────────────────────────────

def test_only_an_editor_of_the_org_may_hide_a_track_and_others_read_not_found(db):
    drain(db)
    j = create(db, UA, ORG_A, src(db.assets["a_mp3"]))["job"]
    start(db, j["id"])
    tid = store(db, j["id"])
    finish(db, j["id"], tid)
    # A viewer reads it but may not hide it; another org's owner, anon and a made-up id all read alike.
    gone = []
    for role, uid, target in (("authenticated", UA, tid), ("authenticated", UB, tid), ("authenticated", UB, str(uuid.uuid4()))):
        st, word, _ = err(lambda: db.act(role, uid, "select public.delete_caption_track(%s)", [target]))
        gone.append((st, word))
    assert gone == [("P0002", "not_found")] * 3
    st, _, _ = err(lambda: db.act("anon", None, "select public.delete_caption_track(%s)", [tid]))
    assert st == "42501"
    st, _, _ = err(lambda: svc(db, "select public.delete_caption_track(%s)", [tid]))
    assert st in ("42501", "P0002")
    assert tid in tracks(db, "authenticated", UA)
    assert db.act("authenticated", UE, "select public.delete_caption_track(%s)", [tid])[0][0] is True
    assert tid not in tracks(db, "authenticated", UA)
    # Hiding it twice reads as missing, like anything already gone.
    st, word, _ = err(lambda: db.act("authenticated", UE, "select public.delete_caption_track(%s)", [tid]))
    assert (st, word) == ("P0002", "not_found")


def test_a_track_follows_its_job_and_organization_when_they_go(db):
    # Deleting the recording keeps the transcript (the asset reference is optional)…
    drain(db)
    a = rec(db, ORG_A, "audio", "audio/mpeg", dur=15)
    j = create(db, UA, ORG_A, src(a))["job"]
    start(db, j["id"])
    tid = store(db, j["id"])
    finish(db, j["id"], tid)
    db.su("delete from public.media_assets where id=%s", [a])
    assert db.su("select asset_id from public.caption_tracks where id=%s", [tid]) == [(None,)]
    assert tid in tracks(db, "authenticated", UA)

"""Voice to video (0171) attacked in a real database.

A person's own narration (one AUDIO file of the organization's library) and a look in; a video drawn by our own engine out. The
database alone decides whether the recording may be used (the SAME organization's, live, audio, a type the engine reads, of a
measured length of at most 600 s, at most 200 MB), what the settings may be (a look of the closed list, one the model lists;
nothing else), and what it costs: the recording's own measured seconds at the model's price per second, against the model's stated
longest recording. Bob (org B) tries to use Alice's recording every way the API lets him; the answer must be exactly the answer for
an id that does not exist, and nothing may be held. Every earlier capability must be answered exactly as before 0171 (a corpus is
judged by 0171's bodies and by the earlier ones, side by side). The file itself: a replay changes nothing, a body edited by hand is
refused, and the rollback puts every earlier body and both CHECKs back byte for byte.

Runs in its own scratch databases (it commits), like the 0100 lab.
"""
import hashlib
import json
import os
import re
import uuid

import psycopg
import pytest

import sec_db
from test_sec_creative_media_inputs import Db, err, footprint, svc
from test_sec_video_tools import create, drain, media, quote

ORG_A = "aaaaaaaa-0000-0000-0000-000000000170"
ORG_B = "bbbbbbbb-0000-0000-0000-000000000170"
UA = str(uuid.UUID(int=0x170A))
UB = str(uuid.UUID(int=0x170B))
LOOKS = ["dusk", "midnight", "golden", "neon", "paper"]
H = lambda name: hashlib.sha256(f"voice-video-{name}".encode()).hexdigest()

# (id, extra spec, credit unit)
MODELS = [
    ("vx", {"explainer_looks": LOOKS, "limits": {"max_source_seconds": 600}, "aspect_ratios": [], "durations_s": []},
     "model_vx_second"),
    ("vx-two", {"explainer_looks": ["dusk", "paper"], "limits": {"max_source_seconds": 30}}, "model_vx_two_second"),
    ("vx-nolooks", {"limits": {"max_source_seconds": 600}}, "model_vx_nolooks_second"),
    ("vx-nolimit", {"explainer_looks": LOOKS}, "model_vx_nolimit_second"),
    ("vx-unpriced", {"explainer_looks": LOOKS, "limits": {"max_source_seconds": 600}}, "model_vx_unpriced_second"),
    ("vx-hidden", {"explainer_looks": LOOKS, "limits": {"max_source_seconds": 600}}, "model_vx_hidden_second"),
    ("vx-webonly", {"explainer_looks": LOOKS, "limits": {"max_source_seconds": 600}, "api_exposure": "web_only"},
     "model_vx_webonly_second"),
]
PRICES = [("model_vx_second", 0.5), ("model_vx_two_second", 0.5), ("model_vx_nolooks_second", 0.5),
          ("model_vx_nolimit_second", 0.5), ("model_vx_hidden_second", 0.5), ("model_vx_webonly_second", 0.5),
          ("job_minimum", 1)]


def _rows():
    return [{"id": m, "display_name": m, "provider": "nightshift", "adapter": "video.voice_explainer",
             "capabilities": ["voice_explainer"], "credit_unit": unit, "entitlement": "any",
             "spec": {"vendor_model": "voice-explainer-rules-1", "output": "video", **extra}}
            for m, extra, unit in MODELS]


@pytest.fixture(scope="module")
def db():
    admin = sec_db.admin_dsn()
    if not admin:
        if os.environ.get("NIGHTSHIFT_SECURITY_REQUIRED"):
            pytest.fail(f"{sec_db.DSN_ENV} is not set", pytrace=False)
        pytest.skip(f"{sec_db.DSN_ENV} is not set — the security lab needs a scratch Postgres")
    name = f"ns_voice_video_{uuid.uuid4().hex[:8]}"
    d = Db(sec_db.build(admin, name))
    d.admin, d.name = admin, name
    d.su("insert into auth.users (id, email) values (%s,'a170@x.io'),(%s,'b170@x.io')", [UA, UB])
    d.su("insert into public.organizations (id, name, slug) values (%s,'A170','org-a170'),(%s,'B170','org-b170')", [ORG_A, ORG_B])
    d.su("insert into public.org_members (org_id, user_id, email, role) values "
         "(%s,%s,'a170@x.io','owner'),(%s,%s,'b170@x.io','owner')", [ORG_A, UA, ORG_B, UB])
    d.su("select public.grant_credits(%s, 1000, 'test')", [ORG_A])
    d.su("select public.grant_credits(%s, 1000, 'test')", [ORG_B])
    d.su("update public.plan_entitlements set value = '1000' where key = 'concurrency'")
    d.rows = _rows()
    d.su("select public.sync_model_registry(%s::jsonb)", [json.dumps(d.rows)])
    for m, _x, _u in MODELS:
        if m == "vx-hidden":
            continue  # never probed, never listed: the owner has not said yes
        d.su("select public.record_model_probe(%s, 'video.voice_explainer', 'voice-explainer-rules-1', 'voice_explainer', true, "
             "null, null, 10, 100, 'security-lab')", [m])
        d.su("update public.model_registry set availability='beta' where id=%s", [m])
    d.su("insert into public.credit_prices (unit, credits_per_unit, margin) values "
         + ", ".join(f"('{u}', {c}, 0)" for u, c in PRICES)
         + " on conflict (unit) do update set credits_per_unit = excluded.credits_per_unit, margin = 0")
    d.assets = {
        "a_mp3": media(d, ORG_A, "audio", "audio/mpeg", 12.2),
        "a_m4a": media(d, ORG_A, "audio", "audio/mp4", 30),
        "a_wav": media(d, ORG_A, "audio", "audio/wav", 31),
        "a_ten": media(d, ORG_A, "audio", "audio/mpeg", 600),
        "a_long": media(d, ORG_A, "audio", "audio/mpeg", 600.4),
        "a_nolen": media(d, ORG_A, "audio", "audio/mpeg", None),
        "a_big": media(d, ORG_A, "audio", "audio/wav", 10, size=200 * 1024 * 1024 + 1),
        "a_edge": media(d, ORG_A, "audio", "audio/wav", 10, size=200 * 1024 * 1024),
        "a_mp4": media(d, ORG_A, "video", "video/mp4", 10),
        "a_png": media(d, ORG_A, "image", "image/png", None),
        "a_deleted": media(d, ORG_A, "audio", "audio/mpeg", 5),
        "b_mp3": media(d, ORG_B, "audio", "audio/mpeg", 8),
    }
    d.act("authenticated", UA, "select public.soft_delete_asset(%s)", [d.assets["a_deleted"]])
    # An API key for each organization (the MCP Studio tools' door, 0162 / 0171).
    d.su("insert into public.api_settings (org_id, activated_at, activated_by, terms_version) values "
         "(%s, now(), %s, 'v1'), (%s, now(), %s, 'v1')", [ORG_A, UA, ORG_B, UB])
    d.su("insert into public.api_accounts (org_id, balance_cents, paid_total_cents) values (%s, 0, 100000), (%s, 0, 100000)",
         [ORG_A, ORG_B])
    for k, (org, uid) in {"a": (ORG_A, UA), "b": (ORG_B, UB)}.items():
        d.su("insert into public.api_keys (org_id, name, key_hash, created_by, scopes) values (%s, %s, %s, %s, %s)",
             [org, k, H(k), uid, ["creative:quote", "creative:create", "creative:read"]])
    try:
        yield d
    finally:
        if not os.environ.get("NIGHTSHIFT_SECURITY_KEEP"):
            sec_db.drop_database(admin, name)


def vv(src, look="dusk", **more):
    return {"source_asset_id": src, "look": look, **more}


# ── the price: the recording's measured seconds at the model's rate ──────────────────────────────────────────────────

def test_the_quantity_is_the_recordings_measured_seconds_never_the_clients(db):
    q = quote(db, UA, ORG_A, "voice_explainer", "vx", vv(db.assets["a_mp3"]))
    # 12.2 s -> 13 s x 0.5 credits.
    assert (q["quantity"], q["unit"], q["credits"], q["capability"]) == (13, "model_vx_second", 6.5, "voice_explainer")
    assert "margin" not in q
    assert quote(db, UA, ORG_A, "voice_explainer", "vx", vv(db.assets["a_m4a"], "neon"))["credits"] == 15
    # Ten minutes exactly is taken (the engine's limit), and the floor applies to a short one.
    assert quote(db, UA, ORG_A, "voice_explainer", "vx", vv(db.assets["a_ten"]))["quantity"] == 600


@pytest.mark.parametrize("extra", [{"duration_s": 1}, {"duration_s": 30}])
def test_a_length_sent_by_the_client_is_refused_not_priced(db, extra):
    st, word, detail = err(lambda: quote(db, UA, ORG_A, "voice_explainer", "vx", vv(db.assets["a_mp3"], **extra)))
    assert (st, word) == ("NS400", "invalid_params") and "duration_s does not apply" in detail


def test_a_created_job_keeps_the_databases_quantity_and_holds_exactly_the_quote(db):
    drain(db)
    j = create(db, UA, ORG_A, "voice_explainer", "vx", vv(db.assets["a_mp3"], "golden"))["job"]
    row = db.su("select quantity::float, quoted_credits::float, credit_unit, params from public.creative_jobs where id=%s", [j["id"]])[0]
    assert row[:3] == (13.0, 6.5, "model_vx_second")
    assert row[3] == {"source_asset_id": db.assets["a_mp3"], "look": "golden"}
    assert db.su("select amount::float from public.credit_reservations where job_id=%s", ["cj:" + j["id"]]) == [(6.5,)]
    drain(db)


def test_the_confirmed_price_is_still_the_ceiling(db):
    st, word, _ = err(lambda: create(db, UA, ORG_A, "voice_explainer", "vx", vv(db.assets["a_mp3"]), maxc=6))
    assert (st, word) == ("NS409", "price_changed")


def test_a_model_without_a_price_row_is_unpriced_never_free(db):
    drain(db)
    before = footprint(db, ORG_A)
    for fn in (quote, create):
        st, word, _ = err(lambda: fn(db, UA, ORG_A, "voice_explainer", "vx-unpriced", vv(db.assets["a_mp3"])))
        assert (st, word) == ("NS400", "unpriced")
    assert footprint(db, ORG_A) == before


def test_a_model_that_was_never_probed_is_not_sold_at_any_price(db):
    drain(db)
    before = footprint(db, ORG_A)
    for fn in (quote, create):
        st, word, _ = err(lambda: fn(db, UA, ORG_A, "voice_explainer", "vx-hidden", vv(db.assets["a_mp3"])))
        assert (st, word) == ("NS400", "model_not_sellable")
    assert footprint(db, ORG_A) == before


def test_a_voice_video_model_is_not_sold_anything_else(db):
    st, word, _ = err(lambda: quote(db, UA, ORG_A, "dub", "vx", {"source_asset_id": db.assets["a_mp3"], "target_language": "uz"}))
    assert (st, word) == ("NS400", "model_not_sellable")


# ── the model's own lists ──────────────────────────────────────────────────────────────────────────────────────────

@pytest.mark.parametrize("look", LOOKS)
def test_every_look_the_model_lists_is_priced_the_same(db, look):
    assert quote(db, UA, ORG_A, "voice_explainer", "vx", vv(db.assets["a_mp3"], look))["credits"] == 6.5


@pytest.mark.parametrize("look", ["midnight", "golden", "neon"])
def test_a_look_of_the_closed_list_the_model_was_not_proven_for_is_refused(db, look):
    drain(db)
    before = footprint(db, ORG_A)
    st, word, detail = err(lambda: create(db, UA, ORG_A, "voice_explainer", "vx-two", vv(db.assets["a_mp3"], look)))
    assert (st, word) == ("NS400", "invalid_params") and f"does not draw the {look} look" in detail
    assert footprint(db, ORG_A) == before


def test_a_model_without_a_list_of_looks_is_not_sold_any(db):
    st, word, detail = err(lambda: quote(db, UA, ORG_A, "voice_explainer", "vx-nolooks", vv(db.assets["a_mp3"])))
    assert (st, word) == ("NS400", "invalid_params") and "does not draw the dusk look" in detail


def test_longer_than_the_model_takes_is_refused_before_any_hold(db):
    drain(db)
    before = footprint(db, ORG_A)
    assert quote(db, UA, ORG_A, "voice_explainer", "vx-two", vv(db.assets["a_m4a"]))["quantity"] == 30
    st, word, detail = err(lambda: create(db, UA, ORG_A, "voice_explainer", "vx-two", vv(db.assets["a_wav"])))
    assert (st, word) == ("NS400", "source_unavailable") and "up to 30 seconds" in detail
    assert footprint(db, ORG_A) == before


def test_a_model_that_states_no_longest_recording_is_not_sold_a_length(db):
    st, word, detail = err(lambda: quote(db, UA, ORG_A, "voice_explainer", "vx-nolimit", vv(db.assets["a_mp3"])))
    assert (st, word) == ("NS400", "model_not_sellable") and "longest recording" in detail


def test_changing_the_looks_needs_a_new_probe_and_nothing_else_does(db):
    rows = [dict(r, spec={**r["spec"], "explainer_looks": ["dusk"]}) if r["id"] == "vx-nolimit" else r for r in db.rows]
    db.su("select public.sync_model_registry(%s::jsonb)", [json.dumps(rows)])
    assert db.su("select availability, verified_at is null from public.model_registry where id='vx-nolimit'") == [("hidden", True)]
    assert db.su("select availability from public.model_registry where id='vx'") == [("beta",)]
    # A different engine build (a model planner, say) is a new claim too: the proof was for the rules engine.
    rows = [dict(r, spec={**r["spec"], "vendor_model": "voice-explainer-model-1"}) if r["id"] == "vx-two" else r for r in rows]
    db.su("select public.sync_model_registry(%s::jsonb)", [json.dumps(rows)])
    assert db.su("select availability, verified_at is null from public.model_registry where id='vx-two'") == [("hidden", True)]
    db.su("select public.sync_model_registry(%s::jsonb)", [json.dumps(db.rows)])
    for m in ("vx-nolimit", "vx-two"):
        db.su("select public.record_model_probe(%s, 'video.voice_explainer', 'voice-explainer-rules-1', 'voice_explainer', true, "
              "null, null, 10, 100, 'security-lab')", [m])
        db.su("update public.model_registry set availability='beta' where id=%s", [m])


# ── the settings: a recording and a look, nothing else ─────────────────────────────────────────────────────────────

@pytest.mark.parametrize("params,why", [
    ({"source_asset_id": "SRC"}, "look (one of dusk, midnight, golden, neon, paper) is required"),
    ({"source_asset_id": "SRC", "look": "sepia"}, "look (one of dusk, midnight, golden, neon, paper) is required"),
    ({"source_asset_id": "SRC", "look": "warm"}, "look (one of dusk, midnight, golden, neon, paper) is required"),
    ({"source_asset_id": "SRC", "look": "DUSK"}, "look (one of"),
    ({"source_asset_id": "SRC", "look": 1}, "look (one of"),
    ({"source_asset_id": "SRC", "look": None}, "look (one of"),
    ({"source_asset_id": "SRC", "look": ["dusk"]}, "look (one of"),
    ({"look": "dusk"}, "source_asset_id (the id of an audio recording in the media library) is required for voice_explainer"),
    ({"source_asset_id": "https://evil.example/a.mp3", "look": "dusk"}, "source_asset_id (the id of an audio recording"),
    ({"source_asset_id": "../../etc/passwd", "look": "dusk"}, "source_asset_id (the id of an audio recording"),
    ({"source_asset_id": "SRC", "look": "dusk", "prompt": "make it pop"}, "prompt does not apply to voice_explainer"),
    ({"source_asset_id": "SRC", "look": "dusk", "negative_prompt": "x"}, "negative_prompt does not apply"),
    ({"source_asset_id": "SRC", "look": "dusk", "aspect_ratio": "16:9"}, "aspect_ratio does not apply"),
    ({"source_asset_id": "SRC", "look": "dusk", "resolution": "1080p"}, "resolution does not apply"),
    ({"source_asset_id": "SRC", "look": "dusk", "seed": 1}, "seed does not apply"),
    ({"source_asset_id": "SRC", "look": "dusk", "voice_id": "A" * 20}, "voice_id does not apply"),
    ({"source_asset_id": "SRC", "look": "dusk", "language": "uz"}, "language does not apply"),
    ({"source_asset_id": "SRC", "look": "dusk", "target_language": "uz"}, "target_language does not apply"),
    ({"source_asset_id": "SRC", "look": "dusk", "style_kit_id": str(uuid.uuid4())}, "style_kit_id does not apply"),
    ({"source_asset_id": "SRC", "look": "dusk", "audio": True}, "audio does not apply"),
    ({"source_asset_id": "SRC", "look": "dusk", "quality": "high"}, "quality does not apply"),
    ({"source_asset_id": "SRC", "look": "dusk", "factor": 2}, "factor does not apply"),
    ({"source_asset_id": "SRC", "look": "dusk", "target_resolution": "4k"}, "target_resolution does not apply"),
    ({"source_asset_id": "SRC", "look": "dusk", "end_asset_id": str(uuid.uuid4())}, "end_asset_id does not apply"),
    ({"source_asset_id": "SRC", "look": "dusk", "regions": []}, "regions does not apply"),
    ({"source_asset_id": "SRC", "look": "dusk", "music": "bed.mp3"}, "unknown parameter music"),
    ({"source_asset_id": "SRC", "look": "dusk", "planner": "model"}, "unknown parameter planner"),
])
def test_param_refusals(db, params, why):
    params = {k: db.assets["a_mp3"] if v == "SRC" else v for k, v in params.items()}
    drain(db)
    before = footprint(db, ORG_A)
    for fn in (quote, create):
        st, word, detail = err(lambda: fn(db, UA, ORG_A, "voice_explainer", "vx", params))
        assert (st, word) == ("NS400", "invalid_params") and why in detail, (st, word, detail)
    assert footprint(db, ORG_A) == before


def test_a_look_is_still_refused_on_every_tool_but_relight_and_the_voice_video(db):
    for cap, params in (("t2i", {"prompt": "x"}), ("upscale", {"source_asset_id": db.assets["a_png"], "factor": 2}),
                        ("dub", {"source_asset_id": db.assets["a_mp3"], "target_language": "uz"}),
                        ("video_remove_bg", {"source_asset_id": db.assets["a_mp4"]})):
        out = db.su("select public.creative_params_problem(%s, %s::jsonb)", [cap, json.dumps({**params, "look": "dusk"})])[0][0]
        assert out == f"look does not apply to {cap}", (cap, out)
    # relight keeps its own list: a voice video's look is not a light.
    out = db.su("select public.creative_params_problem('relight', %s::jsonb)", [json.dumps({"source_asset_id": db.assets["a_png"], "look": "dusk"})])[0][0]
    assert out == "look must be one of soft, warm, cool, golden_hour, dramatic, studio"


# ── the recording must be the organization's own, and audio ────────────────────────────────────────────────────────

@pytest.mark.parametrize("call", ["quote", "create"])
def test_another_orgs_recording_reads_like_one_that_does_not_exist(db, call):
    drain(db)
    fn = quote if call == "quote" else create
    before = footprint(db, ORG_B)
    st, word, detail = err(lambda: fn(db, UB, ORG_B, "voice_explainer", "vx", vv(db.assets["a_mp3"])))
    st2, word2, detail2 = err(lambda: fn(db, UB, ORG_B, "voice_explainer", "vx", vv(str(uuid.uuid4()))))
    assert (st, word) == ("NS400", "source_unavailable"), (st, word)
    assert (st, word, detail) == (st2, word2, detail2)
    assert db.assets["a_mp3"] not in detail
    assert footprint(db, ORG_B) == before


def test_alice_cannot_use_bobs_recording_and_a_stranger_cannot_spend_in_her_org(db):
    drain(db)
    before = footprint(db, ORG_A)
    st, word, _ = err(lambda: create(db, UA, ORG_A, "voice_explainer", "vx", vv(db.assets["b_mp3"])))
    assert (st, word) == ("NS400", "source_unavailable")
    assert footprint(db, ORG_A) == before
    st, _, _ = err(lambda: create(db, UB, ORG_A, "voice_explainer", "vx", vv(db.assets["a_mp3"])))
    assert st == "42501"


@pytest.mark.parametrize("key,why", [
    ("a_deleted", "no recording in this organization"),
    ("a_mp4", "starts from an audio recording"),
    ("a_png", "starts from an audio recording"),
    ("a_nolen", "not known"),
    ("a_long", "up to 10 minutes"),
    ("a_big", "larger than 200 MB"),
])
def test_unusable_recordings_are_refused_before_any_hold(db, key, why):
    drain(db)
    before = footprint(db, ORG_A)
    st, word, detail = err(lambda: create(db, UA, ORG_A, "voice_explainer", "vx", vv(db.assets[key])))
    assert (st, word) == ("NS400", "source_unavailable") and why in detail, (st, word, detail)
    assert footprint(db, ORG_A) == before


def test_a_recording_of_exactly_200_mb_is_fine(db):
    assert quote(db, UA, ORG_A, "voice_explainer", "vx", vv(db.assets["a_edge"]))["quantity"] == 10


def test_an_audio_type_the_engine_does_not_read_is_refused(db):
    aid = media(db, ORG_A, "audio", "audio/mpeg", 5)
    # No upload path makes such a row today (media_mime_kind, 0044); the source check must hold anyway, as the second line.
    try:
        db.su("update public.media_assets set mime = 'audio/x-aiff' where id = %s", [aid])
    except psycopg.Error:
        pytest.skip("the table itself refuses the type")
    st, word, detail = err(lambda: quote(db, UA, ORG_A, "voice_explainer", "vx", vv(aid)))
    assert (st, word) == ("NS400", "source_unavailable") and "MP3, M4A, WAV" in detail


# ── what is listed, and to whom ────────────────────────────────────────────────────────────────────────────────────

def test_sellable_models_lists_the_looks_and_never_the_engine_or_the_margin(db):
    rows = db.act("authenticated", UA, "select id, spec, margin, credits_per_unit::float from public.sellable_models('voice_explainer', 'web')")
    by = {r[0]: r for r in rows}
    assert set(by) == {"vx", "vx-two", "vx-nolooks", "vx-nolimit", "vx-webonly"}  # not the unpriced one, not the hidden one
    assert by["vx"][1]["explainer_looks"] == LOOKS and by["vx-two"][1]["explainer_looks"] == ["dusk", "paper"]
    assert "explainer_looks" not in by["vx-nolooks"][1]
    assert by["vx"][1]["limits"]["max_source_seconds"] == 600
    assert by["vx"][2] is None and by["vx"][3] == 0.5
    assert "vendor_model" not in by["vx"][1] and "pricing" not in by["vx"][1]


def test_the_api_lists_the_model_to_a_key_and_never_a_web_only_one(db):
    res = db.act("anon", None, "select public.api_creative_models(%s,'voice_explainer',null)", [H("a")])[0][0]
    assert res["ok"], res
    got = [m["id"] for m in res["data"]["models"]]
    assert "vx" in got and "vx-webonly" not in got and "vx-hidden" not in got, got
    vx = next(m for m in res["data"]["models"] if m["id"] == "vx")
    assert vx["spec"]["explainer_looks"] == LOOKS and "api_exposure" not in vx["spec"]
    # The whole list (no capability) carries it too: the API's capability list names voice_explainer.
    res = db.act("anon", None, "select public.api_creative_models(%s,null,null)", [H("a")])[0][0]
    assert "vx" in [m["id"] for m in res["data"]["models"]]
    # And the API's own quote prices it like the web's.
    q = db.act("anon", None, "select public.api_creative_quote(%s,'voice_explainer','vx',%s::jsonb,null)",
               [H("a"), json.dumps(vv(db.assets["a_mp3"]))])[0][0]
    assert q["ok"] and q["data"]["quote"]["credits"] == 6.5, q
    # Another organization's key cannot quote Alice's recording either.
    q = db.act("anon", None, "select public.api_creative_quote(%s,'voice_explainer','vx',%s::jsonb,null)",
               [H("b"), json.dumps(vv(db.assets["a_mp3"]))])[0][0]
    assert q["ok"] is False and q["error"]["code"] == "source_unavailable", q


def test_nothing_is_sold_until_a_model_is_probed_priced_and_open(db):
    db.su("update public.model_registry set availability='hidden' where capabilities @> array['voice_explainer']")
    try:
        assert db.act("authenticated", UA, "select id from public.sellable_models('voice_explainer', 'web')") == []
        st, word, _ = err(lambda: quote(db, UA, ORG_A, "voice_explainer", "vx", vv(db.assets["a_mp3"])))
        assert (st, word) == ("NS400", "model_not_sellable")
    finally:
        db.su("update public.model_registry set availability='beta' where id <> 'vx-hidden' and capabilities @> array['voice_explainer']")


def test_an_unknown_capability_is_still_refused_by_sellable_models(db):
    with pytest.raises(psycopg.Error) as e:
        db.act("authenticated", UA, "select * from public.sellable_models('voice_clone', 'web')")
    assert e.value.sqlstate == "22023"


def test_the_registry_accepts_the_capability_alone_or_with_others_and_nothing_new(db):
    db.su("update public.model_registry set capabilities = array['voice_explainer','dub'] where id='vx-hidden'")
    with pytest.raises(psycopg.Error) as e:
        db.su("update public.model_registry set capabilities = array['voice_explainer','voice_clone'] where id='vx-hidden'")
    assert e.value.sqlstate == "23514"
    db.su("update public.model_registry set capabilities = array['voice_explainer'] where id='vx-hidden'")
    with pytest.raises(psycopg.Error) as e:
        db.su("select public.record_model_probe('vx', 'video.voice_explainer', 'voice-explainer-rules-1', 'voice_clone', true, "
              "null, null, 10, 1, 'x')")
    assert e.value.sqlstate in ("23514", "22023")


# ── the worker's side ──────────────────────────────────────────────────────────────────────────────────────────────

def test_the_worker_reads_the_recording_of_its_own_running_job_only(db):
    drain(db)
    j = create(db, UA, ORG_A, "voice_explainer", "vx", vv(db.assets["a_m4a"], "paper"))["job"]
    assert svc(db, "select id::text from public.claim_creative_job('w1')")[0][0] == j["id"]
    out = svc(db, "select public.creative_job_source(%s, 'w1')", [j["id"]])[0][0]
    assert out["ok"] is True and out["asset_id"] == db.assets["a_m4a"]
    assert (out["kind"], out["mime"], float(out["duration_s"])) == ("audio", "audio/mp4", 30.0)
    assert svc(db, "select public.creative_job_source(%s, 'w2')", [j["id"]])[0][0]["ok"] is False
    svc(db, "select public.finish_creative_job(%s,'w1',false,null,null,'test','x')", [j["id"]])


def test_a_recording_deleted_after_create_fails_and_releases_in_full(db):
    drain(db)
    rec = media(db, ORG_A, "audio", "audio/mpeg", 5)
    before = footprint(db, ORG_A)
    j = create(db, UA, ORG_A, "voice_explainer", "vx", vv(rec))["job"]
    svc(db, "select public.claim_creative_job('w1')")
    db.act("authenticated", UA, "select public.soft_delete_asset(%s)", [rec])
    out = svc(db, "select public.creative_job_source(%s, 'w1')", [j["id"]])[0][0]
    assert out["ok"] is False and "no recording in this organization" in out["problem"]
    done = svc(db, "select public.finish_creative_job(%s,'w1',false,null,null,'source_unavailable',%s)", [j["id"], out["problem"]])[0][0]
    assert done["status"] == "failed" and done["charged_credits"] == 0
    assert footprint(db, ORG_A)[2] == before[2]
    assert db.su("select status from public.credit_reservations where job_id=%s", ["cj:" + j["id"]]) == [("released",)]


@pytest.mark.parametrize("code", ["bad_request", "bad_response", "unavailable", "not_configured", "output_lost"])
def test_a_render_that_fails_after_submit_releases_the_whole_hold(db, code):
    drain(db)
    before = footprint(db, ORG_A)
    j = create(db, UA, ORG_A, "voice_explainer", "vx", vv(db.assets["a_mp3"]))["job"]
    svc(db, "select public.claim_creative_job('w1')")
    svc(db, "select public.advance_creative_job(%s,'w1','submitting')", [j["id"]])
    svc(db, "select public.advance_creative_job(%s,'w1','submitted','sync:00000000000000000000000000000170')", [j["id"]])
    done = svc(db, "select public.finish_creative_job(%s,'w1',false,null,null,%s,'failed')", [j["id"], code])[0][0]
    assert done["status"] == "failed" and done["charged_credits"] == 0
    assert footprint(db, ORG_A)[2] == before[2]


# ── nobody reaches the internals through the API ───────────────────────────────────────────────────────────────────

@pytest.mark.parametrize("role,uid", [("anon", None), ("authenticated", UA), ("authenticated", UB)])
@pytest.mark.parametrize("query", [
    "select public.creative_params_problem('voice_explainer', jsonb_build_object('source_asset_id', %(asset)s::text, 'look', 'dusk'))",
    "select public.creative_source_problem(%(org)s, 'voice_explainer', jsonb_build_object('source_asset_id', %(asset)s::text))",
    "select public.creative_capability_supported('voice_explainer')",
    "select public.creative_price(%(org)s, 'voice_explainer', 'vx', jsonb_build_object('source_asset_id', %(asset)s::text, 'look', 'dusk'))",
    "select public.creative_source_seconds(%(org)s, jsonb_build_object('source_asset_id', %(asset)s::text))",
])
def test_no_browser_reaches_the_internals(db, role, uid, query):
    with pytest.raises(psycopg.Error) as e:
        db.act(role, uid, query, {"asset": db.assets["a_mp3"], "org": ORG_A})
    assert e.value.sqlstate == "42501"


def test_anon_cannot_quote_or_list(db):
    with pytest.raises(psycopg.Error) as e:
        db.act("anon", None, "select public.quote_creative_job(%s,'voice_explainer','vx',%s::jsonb)", [ORG_A, json.dumps(vv(db.assets["a_mp3"]))])
    assert e.value.sqlstate == "42501"
    with pytest.raises(psycopg.Error) as e:
        db.act("anon", None, "select * from public.sellable_models('voice_explainer', 'web')")
    assert e.value.sqlstate == "42501"


# ── every earlier tool is answered exactly as before 0171 ──────────────────────────────────────────────────────────

def _function(path, name, rename):
    m = re.search(r"(?ms)^create or replace function public\.%s\(.*?^\$\$;\n" % name, path.read_text(encoding="utf-8"))
    return m.group(0).replace(f"public.{name}(", f"public.{rename}(", 1)


CAPS_BEFORE = ["t2i", "t2v", "i2v", "tts", "sfx", "music", "edit", "upscale", "remove_bg", "voice_change", "dub", "video_upscale",
               "describe", "captions", "expand", "relight", "erase", "video_edit", "video_reframe", "video_remove_bg", "bogus", ""]


def test_every_other_capability_gets_the_same_params_and_source_answers_as_before(db):
    db.su(_function(sec_db.MIGRATIONS / "0156_named_resolution_params.sql", "creative_params_problem", "zz_old_params_0171"))
    db.su(_function(sec_db.MIGRATIONS / "0100_video_ai_ops.sql", "creative_source_problem", "zz_old_source_0171"))
    try:
        src = db.assets["a_mp3"]
        keys = {"prompt": ["x", "", 4], "aspect_ratio": ["16:9", "bad"], "resolution": ["720p", "768p", "9p"], "duration_s": [4, 0],
                "voice_id": ["abc", "A" * 20], "seed": [1], "source_asset_id": [src, "x"], "factor": [2, 3], "look": ["warm", "dusk", "x"],
                "target_language": ["uz"], "target_resolution": ["4k"], "language": ["en"], "quality": ["low"], "audio": [True],
                "style_kit_id": [str(uuid.uuid4())], "end_asset_id": [src], "foo": [1]}
        corpus = [{}]
        for k, vals in keys.items():
            for v in vals:
                corpus += [{k: v}, {"prompt": "x", "source_asset_id": src, k: v},
                           {"prompt": "x", "source_asset_id": src, "duration_s": 5, "aspect_ratio": "16:9", k: v}]
        diffs = []
        for cap in CAPS_BEFORE:
            for p in corpus:
                a = db.su("select public.creative_params_problem(%s, %s::jsonb), public.zz_old_params_0171(%s, %s::jsonb)",
                          [cap, json.dumps(p), cap, json.dumps(p)])[0]
                if a[0] != a[1]:
                    diffs.append((cap, p, a))
        assert not diffs, diffs[:5]
        assert db.su("select public.creative_params_problem('relight', %s::jsonb)", [json.dumps({"source_asset_id": src, "look": "warm"})]) == [(None,)]
        for cap in CAPS_BEFORE:
            for key in db.assets:
                p = json.dumps({"source_asset_id": db.assets[key], "end_asset_id": db.assets["a_png"]})
                for org in (ORG_A, ORG_B):
                    a = db.su("select public.creative_source_problem(%s, %s, %s::jsonb), public.zz_old_source_0171(%s, %s, %s::jsonb)",
                              [org, cap, p, org, cap, p])[0]
                    assert a[0] == a[1], (cap, key, org, a)
    finally:
        db.su("drop function public.zz_old_params_0171(text, jsonb)")
        db.su("drop function public.zz_old_source_0171(uuid, text, jsonb)")


def test_sellable_models_answers_every_other_capability_as_before(db):
    db.su(_function(sec_db.MIGRATIONS / "0125_model_shutdown.sql", "sellable_models", "zz_old_sellable_0171"))
    try:
        for cap in [None, *(c for c in CAPS_BEFORE[:-2] if c != "music")]:  # music is no database capability (sellable_models 22023)
            for surface in ("web", "api", "mcp"):
                new = db.su("select id, spec from public.sellable_models(%s, %s) order by id", [cap, surface])
                old = db.su("select id, spec from public.zz_old_sellable_0171(%s, %s) order by id", [cap, surface])
                # The only difference: the voice video models' own rows (listed with no capability named) carry their looks.
                strip = lambda rows: [(i, {k: v for k, v in s.items() if k != "explainer_looks"}) for i, s in rows]
                assert strip(new) == strip(old), (cap, surface)
                assert all("explainer_looks" not in s for i, s in new if not i.startswith("vx")), (cap, surface)
    finally:
        db.su("drop function public.zz_old_sellable_0171(text, text)")


# ── the file itself: order, drift guards, replay, rollback ─────────────────────────────────────────────────────────

FUNCS = {
    "model_registry_guard": "public.model_registry_guard()",
    "sellable_models": "public.sellable_models(text, text)",
    "creative_capability_supported": "public.creative_capability_supported(text)",
    "creative_params_problem": "public.creative_params_problem(text, jsonb)",
    "creative_source_problem": "public.creative_source_problem(uuid, text, jsonb)",
    "creative_price": "public.creative_price(uuid, text, text, jsonb)",
    "api_creative_models": "public.api_creative_models(text, text, text)",
}


def _state(d):
    fns = {n: d.su("select md5(prosrc), coalesce(proacl::text, '') from pg_proc where oid = %s::regprocedure", [s])[0] for n, s in FUNCS.items()}
    cons = {r[0]: r[1] for r in d.su("select conname, pg_get_constraintdef(oid) from pg_constraint where conname in "
                                       "('model_registry_capabilities_check', 'model_probe_runs_capability_check')")}
    return fns, cons


def _scratch(admin, files, tag):
    name = f"ns_vv_{tag}_{uuid.uuid4().hex[:8]}"
    dsn = sec_db.create_database(admin, name)
    sec_db.apply_files(dsn, files)
    return name, Db(dsn)


def test_it_refuses_to_apply_on_a_body_it_was_not_written_on(db):
    # Without 0159 (0156's creative_price is live) the guard names the function and the fix, and nothing changes.
    name, d = _scratch(db.admin, [f for f in sec_db.build_sequence() if f.name not in sec_db.ON_0156], "order")
    try:
        before = _state(d)
        with pytest.raises(psycopg.Error) as e:
            d.su(sec_db.MIGRATION_0171.read_text(encoding="utf-8"))
        assert "0171 found a creative_price() that is neither 0171's body nor the one it replaces" in str(e.value)
        assert _state(d) == before
    finally:
        sec_db.drop_database(db.admin, name)


def test_a_replay_changes_nothing_and_a_body_edited_by_hand_is_refused(db):
    name, d = _scratch(db.admin, sec_db.build_sequence(), "guard")
    try:
        before = _state(d)
        d.su(sec_db.MIGRATION_0171.read_text(encoding="utf-8"))
        assert _state(d) == before
        for fn, sig in (("creative_source_problem", FUNCS["creative_source_problem"]), ("api_creative_models", FUNCS["api_creative_models"])):
            body = d.su(f"select pg_get_functiondef('{sig}'::regprocedure)")[0][0]
            d.su(body.replace("begin\n", "begin\n  -- edited by hand\n", 1))
            with pytest.raises(psycopg.Error) as e:
                d.su(sec_db.MIGRATION_0171.read_text(encoding="utf-8"))
            assert f"0171 found a {fn}() that is neither 0171's body" in str(e.value), str(e.value)
            d.su(body)
        # A CHECK widened by hand is refused too (it would be narrowed back without a word).
        d.su("alter table public.model_probe_runs drop constraint model_probe_runs_capability_check")
        d.su("alter table public.model_probe_runs add constraint model_probe_runs_capability_check check (capability is not null)")
        with pytest.raises(psycopg.Error) as e:
            d.su(sec_db.MIGRATION_0171.read_text(encoding="utf-8"))
        assert "0171 found a model_probe_runs_capability_check" in str(e.value)
    finally:
        sec_db.drop_database(db.admin, name)


def test_the_rollback_puts_everything_back_byte_for_byte_refuses_while_a_model_lists_it_and_the_file_applies_again(db):
    name, d = _scratch(db.admin, [f for f in sec_db.build_sequence() if f.name != sec_db.MIGRATION_0171.name], "roll")
    try:
        pre = _state(d)
        d.su(sec_db.MIGRATION_0171.read_text(encoding="utf-8"))
        after = _state(d)
        assert after != pre
        rb = sec_db.ROLLBACK_0171.read_text(encoding="utf-8")
        d.su("select public.sync_model_registry(%s::jsonb)", [json.dumps(_rows()[:1])])
        with pytest.raises(psycopg.Error) as e:
            d.su(rb)
        assert "rollback 0171 found a model row or a probe run for voice_explainer" in str(e.value)
        assert _state(d) == after
        d.su("delete from public.model_registry where id = 'vx'")
        d.su(rb)
        assert _state(d) == pre, "byte for byte, grants included"
        assert d.su("select public.creative_capability_supported('voice_explainer')") == [(False,)]
        d.su(sec_db.MIGRATION_0171.read_text(encoding="utf-8"))   # and again on the rolled-back database
        assert _state(d) == after
        # The rollback refuses a body that is neither 0171's nor the earlier one.
        body = d.su(f"select pg_get_functiondef('{FUNCS['creative_price']}'::regprocedure)")[0][0]
        d.su(body.replace("begin\n", "begin\n  -- edited by hand\n", 1))
        with pytest.raises(psycopg.Error) as e:
            d.su(rb)
        assert "rollback 0171 found a creative_price() that is neither 0171's body nor the one 0171 replaced" in str(e.value)
    finally:
        sec_db.drop_database(db.admin, name)


def test_the_lab_takes_0171_off_with_the_chain_and_puts_it_back(db):
    name, d = _scratch(db.admin, sec_db.build_sequence(), "chain")
    try:
        with psycopg.connect(d.dsn, autocommit=True) as c:
            s = type("S", (), {"conn": c})()
            before = _state(d)
            assert sec_db.has_0171(c) and not sec_db.has_0159(c)
            sec_db.take_off_0156(s)          # 0171 first, then 0159, then 0156
            assert not sec_db.has_0171(c) and sec_db.has_0155(c)
            sec_db.put_back_0156(s)
            assert sec_db.has_0171(c)
            assert _state(d) == before
    finally:
        sec_db.drop_database(db.admin, name)

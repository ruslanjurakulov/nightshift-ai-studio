"""Breach's attacks on migration 0235 (Film Studio's operator-preview models), beyond what test_sec_film_operator_preview_0235.py pins.

Each test is an attempt by someone who is not the operator (a customer's member, a member of the operator's organization who is not a
platform admin, a platform admin acting with only support access, the anon key, the operator calling the internals directly) to get a
hidden preview model saved into a film, quoted, priced, held or started, or to widen the operator's preview beyond the credits-exempt
organization. Every one is refused today; each test names the guard that would break.

  * the internals: the four-argument overloads are not callable by any API role, the operator's own JWT and a forged p_org included;
  * the id: case, white space and a trailing newline around a preview id are refused as an invalid id, never matched to the row;
  * the organization: a customer naming the exempt organization creates nothing there; a platform admin with only support access to a
    customer (0043, no seat) is refused the preview there; in the exempt organization the preview reaches exactly the platform admins
    start_film already lets spend there, seat or not (Breach 0235-I1, informational: the header's "member of" is vacuous); a per-scene key-frame or clip override smuggled in scene JSON is checked
    in the film's organization like the film-level setting;
  * the operator's film edited by a non-admin member: an unchanged voice model is not re-checked on save (by design), but that member
    can neither quote the preview line nor start the film, and cannot add a preview scene override to it;
  * the mark: any spec.operator_preview other than the JSON true (1, "TRUE", [true], {"v": true}, null) is refused by the database
    check and by the worker's operator_preview_runnable alike;
  * the price: a customer's film whose voice is a preview (written behind the code's back) gets no preview line, no vendor-cost rate,
    credits null and total null, never 0.
"""

from __future__ import annotations

import sys

import psycopg
import pytest

import sec_db
from test_sec_films_money import SCENES, SETTINGS, a, b, db, err, no_live_segment, one_hour  # noqa: F401
from test_sec_film_operator_preview_0235 import (  # noqa: F401
    EXEMPT, PREVIEW, PREVIEW_VOICE, _row, draft, fake_quote_id, narration, operator_film, preview_settings, problem, pv, with_voice)

sys.path.insert(0, str(sec_db.REPO))
from modules import creative_worker as cw  # noqa: E402

IMG_PV = "img-pv"
VID_PV = "vid-pv"
#: spec.operator_preview values that are not the JSON true: each must be refused, by the database and by the worker.
NOT_TRUE = [("one", 1), ("upper", "TRUE"), ("list", [True]), ("object", {"v": True}), ("null", None)]


@pytest.fixture(scope="module")
def more(db, pv):
    """Key-frame and clip previews (the module's rows are all TTS), and one hidden TTS row per not-true mark."""
    _row(db, IMG_PV, caps=("t2i", "edit"), adapter="image.acme", output="image",
         pricing={"unit": "image", "provider_usd_per_unit": 0.01}, aspect_ratios=["16:9", "9:16", "1:1"], inputs={"image_refs_max": 4})
    _row(db, VID_PV, caps=("i2v",), adapter="video.acme", output="video",
         pricing={"unit": "second", "provider_usd_per_unit": 0.01}, durations_s=[5, 10])
    for name, mark in NOT_TRUE:
        _row(db, f"tts-mark-{name}", operator_preview=mark)
    sellable = {r[0] for r in db.su("select id from public.sellable_models(null, 'web')")}
    assert not sellable & {IMG_PV, VID_PV, *(f"tts-mark-{n}" for n, _ in NOT_TRUE)}
    # The operator's own check passes the two new rows: the attacks below are refused for who asks, not because the rows are broken.
    assert problem(db, pv.operator, IMG_PV, EXEMPT, caps=("t2i", "edit")) is None
    assert problem(db, pv.operator, VID_PV, EXEMPT, caps=("i2v",)) is None
    return pv


def _code(fn):
    code, word, detail = err(fn)
    return code, word, detail


# ── the internals ─────────────────────────────────────────────────────────────

@pytest.mark.parametrize("fn", ["film_check_model", "film_model_problem"])
@pytest.mark.parametrize("role", ["anon", "authenticated"])
def test_nobody_calls_the_four_argument_check_directly_not_even_the_operator_with_a_forged_org(db, pv, fn, role):
    """PostgREST's rpc with named arguments, p_org the exempt organization, the operator's own claims: no EXECUTE, so the internal
    check is never an oracle over the hidden registry nor a way to get a 'passes' answer outside a Film function."""
    who = pv.operator if role == "authenticated" else None
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        db.act(role, who, f"select public.{fn}(p_model => %s, p_caps => array['tts'], p_field => 'voice.model', p_org => %s::uuid)",
               [PREVIEW, EXEMPT])


# ── the id ────────────────────────────────────────────────────────────────────

@pytest.mark.parametrize("variant", ["TTS-PREVIEW", "Tts-preview", " tts-preview", "tts-preview ", "tts-preview\n", "tts-preview\t"])
def test_a_case_or_white_space_variant_of_a_preview_id_is_an_invalid_id_for_the_operator_and_a_customer(db, pv, a, variant):
    for who, org in ((pv.operator, EXEMPT), (a.editor, a.org)):
        code, word, _ = _code(lambda: draft(db, who, org, preview_settings({**PREVIEW_VOICE, "model": variant})))
        assert (code, word) == ("NS400", "invalid_params"), (who, variant, word)
        assert problem(db, who, variant, org)["reason"] == "invalid_params", (who, variant)


# ── the organization ──────────────────────────────────────────────────────────

def test_a_customer_naming_the_exempt_organization_creates_no_draft_there(db, pv, a):
    before = db.su("select count(*) from public.films where org_id = %s", [EXEMPT])[0][0]
    code, _, _ = _code(lambda: draft(db, a.owner, EXEMPT, preview_settings()))
    assert code in ("P0002", "42501"), code
    assert db.su("select count(*) from public.films where org_id = %s", [EXEMPT])[0][0] == before


def test_a_platform_admin_with_only_support_access_to_a_customer_is_refused_the_preview_there(db, pv, b):
    """0043 makes every platform admin an admin of every organization (no seat needed): is_org_member, which 0139's rule asks, is
    therefore true for staff in b. The preview must still be refused, because b is not credits-exempt."""
    assert not db.su("select exists (select 1 from public.org_members where org_id = %s and user_id = %s)", [b.org, pv.staff])[0][0]
    got = problem(db, pv.staff, PREVIEW, b.org)
    assert got is not None and got["reason"] == "model_not_available", got
    fid = db.film(b)
    with_voice(db, fid, PREVIEW)
    n = narration(db.quote(pv.staff, fid))
    assert n["priced"] is False and n["reason"] == "model_not_available", n


def test_the_preview_reaches_exactly_the_platform_admins_start_film_already_lets_spend_in_the_exempt_organization(db, pv, one_hour):
    """Breach 0235-I1 (informational). 0139's rule asks is_org_member(org), and 0043 makes every platform owner or admin a member of
    every organization, so the "member" half is vacuous: a platform admin with NO org_members seat in the exempt organization gets the
    preview through save, quote and start. That is the same population start_film and is_org_spender (0215/0226) already let spend
    the platform's own credits there, so nothing widens past them; the 0235 header's "the credits-exempt organization they are a
    member of" overstates the rule. If the owner ever wants a seat required, this test is the one that must flip, together with
    start_film's exempt branch."""
    assert not db.su("select exists (select 1 from public.org_members where org_id = %s and user_id = %s)", [EXEMPT, pv.staff])[0][0]
    assert problem(db, pv.staff, PREVIEW, EXEMPT) is None
    f = draft(db, pv.staff, EXEMPT, preview_settings())
    fid = f["film"]["id"]
    db.save(pv.staff, fid, 1, {"scenes": SCENES})
    q = db.quote(pv.staff, fid)
    assert q["priced"] is True and narration(q).get("preview") is True
    out = db.start(pv.staff, fid, q["quote_id"])
    assert out.get("ok") is True and out["exempt"] is True and out["credit_ref"] is None, out
    assert db.holds(EXEMPT) == []
    db.svc("select public.film_cancel_segment(%s, 'cancelled')", [out["id"]])


@pytest.mark.parametrize("field,model", [("keyframe_model", IMG_PV), ("clip_model", VID_PV)])
def test_a_preview_smuggled_into_a_scene_override_is_refused_for_a_customer_and_for_a_non_admin_member(db, more, a, one_hour,
                                                                                                        field, model):
    scenes = [{**SCENES[0], field: model}, SCENES[1]]
    # A customer's new draft, the override in the scene JSON.
    fid = db.film(a, scenes=[])
    code, word, detail = _code(lambda: db.save(a.editor, fid, db.version(fid), {"scenes": scenes}))
    assert (code, word) == ("NS400", "model_not_available") and model in detail, (code, word, detail)
    # Dana administers the operator's organization but is no platform admin: the same override on the operator's own film.
    ofid = operator_film(db, more)
    code, word, _ = _code(lambda: db.save(more.dana, ofid, db.version(ofid), {"scenes": scenes}))
    assert (code, word) == ("NS400", "model_not_available"), (code, word)
    # Written behind the code's back on the customer's film: the quote refuses the line and the start refuses before any hold.
    db.save(a.editor, fid, db.version(fid), {"scenes": SCENES})
    sid = db.su("select id from public.film_scenes where film_id = %s order by position limit 1", [fid])[0][0]
    db.su(f"update public.film_scenes set {field} = %s where id = %s", [model, sid])
    q = db.quote(a.editor, fid)
    assert q["priced"] is False and q["total"] is None and q["quote_id"] is None
    bad = [ln for ln in q["lines"] if ln.get("model") == model]
    assert bad and all(ln["priced"] is False and ln["reason"] == "model_not_available" and ln["credits"] is None
                       and "preview" not in ln for ln in bad), bad
    code, word, _ = _code(lambda: db.start(a.admin, fid, fake_quote_id(db, fid)))
    assert (code, word) == ("NS400", "model_not_available")
    assert db.holds(a.org) == []


# ── the operator's film, edited by a member who is not a platform admin ──────

def test_a_non_admin_member_who_edits_the_operators_preview_film_can_neither_quote_nor_start_it(db, pv, one_hour):
    """film_apply_settings asks the check only when the model changes, so Dana may change the voice_id of the operator's preview voice
    (the model the operator chose stays). That save is the only thing she gets: the preview line is refused in her quote, and the
    start is the platform's (start_film: only a platform admin starts in the exempt organization)."""
    fid = operator_film(db, pv)
    out = db.save(pv.dana, fid, db.version(fid), {"voice": {**PREVIEW_VOICE, "voice_id": "voice_lab_2"}})
    assert out["film"]["voice"]["model"] == PREVIEW
    n = narration(db.quote(pv.dana, fid))
    assert n["priced"] is False and n["reason"] == "model_not_available" and "preview" not in n, n
    q = db.quote(pv.operator, fid)
    assert q["priced"] is True
    code, word, _ = _code(lambda: db.start(pv.dana, fid, q["quote_id"]))
    assert (code, word) == ("42501", "forbidden")
    assert db.su("select count(*) from public.film_segments where film_id = %s", [fid])[0][0] == 0


# ── the mark ──────────────────────────────────────────────────────────────────

@pytest.mark.parametrize("name,mark", NOT_TRUE)
def test_a_mark_other_than_the_json_true_is_refused_by_the_database_and_by_the_worker(db, more, name, mark):
    mid = f"tts-mark-{name}"
    assert problem(db, more.operator, mid, EXEMPT)["reason"] == "model_not_available", mark
    row = db.su("select to_jsonb(m) from public.model_registry m where id = %s", [mid])[0][0]
    assert cw.operator_preview_runnable(row, "tts") is False, mark


# ── the price ─────────────────────────────────────────────────────────────────

def test_a_customers_preview_voice_is_never_priced_at_the_vendors_cost_or_at_zero(db, pv, a):
    fid = db.film(a)
    with_voice(db, fid, PREVIEW)
    for who in (a.editor, a.admin, a.owner):
        q = db.quote(who, fid)
        n = narration(q)
        assert "preview" not in n and "credits_per_unit" not in n and n["credits"] is None, n
        assert q["priced"] is False and q["total"] is None and q["quote_id"] is None, q
    assert db.su("select count(*) from public.film_quotes where film_id = %s and total is not null", [fid])[0][0] == 0

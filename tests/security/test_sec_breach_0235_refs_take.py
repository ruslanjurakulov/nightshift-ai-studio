"""Breach on 0235's refs path: a film the quote prices and start_film holds, whose key frame is then refused at its take because of
the key-frame model's capability or the reference pictures the take really carries. Same class as S1 (priced, held, refused at
submit); each test below is a path 0235's hunk does not close. A test that fails names a hole that is still open; it stays failing
(never skipped) until the product code closes it.

Ledger (Breach, against 23ee434fb, local lab only):

  B1 (medium) An edit-only key-frame model. film_check_model asks sellable_models for ANY of t2i/edit, so an edit-only model (the live
     registry has one: krea-3-regional, capabilities ['edit']) is accepted as the film's keyframe_model (film_apply_settings) and as a
     scene's override (film_save_scenes). film_price then prices it on 'edit' against the stand-in picture, start_film holds, and
     film_take_job (0198) answers bad_request "this key-frame model edits a picture..." at the first take.
  B2 (medium) Film references plus the film's style kit. film_price counts film_refs only. The worker adds the style kit's pictures
     (and @characters' pictures) up to image_refs_max - inputs, THEN prepends the film refs (film_orchestrator._inputs), and
     RegistryAdapter.submit refuses len(refs) > image_refs_max as bad_request. A 3-reference model with one film reference and any
     style kit (a kit has 3-12 pictures) is priced, held and refused at every key frame.
  B3 (medium) A style kit (or a mentioned @character) with no description on a key-frame model that takes no reference on t2i (GPT
     Image, Flux, ...): no film_refs, so 0235's check never asks; the worker refuses it (creative_worker._style "has no description
     and this model cannot use its pictures") after the hold.
  B4 (low) A character's picture deleted from the library: film_price's reference_missing asks only that the character exists, the
     take asks every picture is live and answers input_missing.
  B5 (low) A character given more pictures after Start (save_character is not locked by a running film): film_take_job checks only
     <= 16, so the take carries more references than the model's image_refs_max and the adapter refuses it at submit. (0239 fails
     it by name in the worker, before any call; the test asks the worker.)
  B6 (low, latent) image_refs_max above 16 (the schema allows 30): film_price prices 17..30 references, film_take_job refuses > 16 as
     input_missing. No live model states more than 16 today.

Tried and held (pinned here as passing tests): ref_capabilities as the string "t2i", ["T2I"], [" t2i"], [["t2i"]], null, an object
and [] are all refused (jsonb ? matches only a top-level string element exactly); a per-scene keyframe_model override to a GPT-like
model under a Gemini-like film default is refused; a scene-only reference is counted for its own scene.

Runs in the money lab's own scratch database (test_sec_films_money's fixtures, imported as they are).
"""

from __future__ import annotations

import dataclasses
import json
from pathlib import Path

import psycopg
import pytest

from modules import creative_adapters as ca
from modules import creative_worker as cw
from modules import film_orchestrator as fo
from modules import model_registry as mr

from test_sec_films_money import SCENES, SETTINGS, Db, a, db, no_live_segment  # noqa: F401

# (id, capabilities, ref_capabilities, image_refs_max)
LAB_MODELS = [
    ("img-editonly", ["edit"], ["edit"], 4),          # krea-3-regional's shape
    ("img-gptk", ["t2i", "edit"], ["edit"], 16),     # GPT Image's shape
    ("img-gemk", ["t2i", "edit"], ["t2i", "edit"], 14),
    ("img-lite", ["t2i", "edit"], ["t2i", "edit"], 3),  # gemini-3.1-flash-lite-image's shape
    ("img-wide", ["t2i", "edit"], ["t2i", "edit"], 30),  # the schema's maximum
]
MALFORMED = {"img-bad-str": "t2i", "img-bad-upper": ["T2I"], "img-bad-space": [" t2i"], "img-bad-nested": [["t2i"]],
             "img-bad-null": None, "img-bad-obj": {"t2i": True}, "img-bad-empty": []}


def _add_model(db, mid, caps, refs_spec, n, stated=True):
    inputs = {"image_refs_max": n, **({"ref_capabilities": refs_spec} if stated else {})}
    spec = {"vendor_model": "acme-" + mid, "output": "image", "aspect_ratios": ["16:9", "9:16", "1:1"], "inputs": inputs}
    unit = f"model_{mid.replace('-', '_')}_image"
    db.su("insert into public.model_registry (id, display_name, provider, adapter, capabilities, spec, credit_unit, entitlement) "
          "values (%s, %s, 'acme', 'image.acme', %s, %s::jsonb, %s, 'any')", [mid, mid, caps, json.dumps(spec), unit])
    db.su("insert into public.credit_prices (unit, credits_per_unit, margin) values (%s, 3, 0) "
          "on conflict (unit) do update set credits_per_unit = 3, margin = 0", [unit])
    db.su("select public.record_model_probe(%s, 'image.acme', %s, %s, true, null, null, 10, 100, 'security-lab')",
          [mid, "acme-" + mid, caps[-1]])
    db.su("update public.model_registry set availability = 'beta' where id = %s", [mid])


@pytest.fixture(scope="module")
def models(db):
    for mid, caps, refs, n in LAB_MODELS:
        _add_model(db, mid, caps, refs, n)
    for mid, refs in MALFORMED.items():
        _add_model(db, mid, ["t2i", "edit"], refs, 8)
    on_sale = {r[0] for r in db.su("select id from public.sellable_models(null, 'web')")}
    want = {m[0] for m in LAB_MODELS} | set(MALFORMED)
    assert on_sale >= want, want - on_sale
    return want


# ── helpers: quote, start, claim, and the database's own take job ────────────

def keyframes(q):
    return [ln for ln in q["lines"] if ln["line"] == "keyframe"]


def start_and_take_first_keyframe(db, o, fid):
    """Quote -> start (one hold) -> claim -> begin the first key-frame take -> film_take_job. Returns (quote, start, take_job)."""
    q = db.quote(o.editor, fid)
    if not q["priced"]:
        return q, None, None
    out = db.start(o.admin, fid, q["quote_id"])
    assert out.get("ok") is True, out
    assert any(h[2] == "open" for h in db.holds(o.org)), "start_film held nothing"
    db.claim()
    take = db.su("select t.id from public.film_takes t join public.film_scenes s on s.id = t.scene_id "
                 "join public.film_segments g on g.id = t.segment_id "
                 "where g.film_id = %s and t.kind = 'keyframe' order by s.position, t.attempt limit 1", [fid])[0][0]
    db.begin(take)
    tj = db.svc("select public.film_take_job(%s, 'w-1')", [take])
    return q, out, tj


def refs_of(tj):
    return [i for i in (tj.get("inputs") or []) if i.get("role") == "reference"]


def model_max(db, mid):
    return db.su("select (spec -> 'inputs' ->> 'image_refs_max')::int from public.model_registry where id = %s", [mid])[0][0]


def assert_never_held_then_refused(db, o, fid, why):
    """The rule 0235 states: a film is refused at the quote, or its take is not refused for this reason after the hold."""
    q, out, tj = start_and_take_first_keyframe(db, o, fid)
    if out is None:
        return q  # refused before anything was held: safe
    assert tj.get("ok") is True, f"HOLE ({why}): priced {q['total']}, held at start, then the key-frame take answered {tj}"
    return q, out, tj


def characters(db, o, name, n, description=""):
    assets = [db.asset(o.org) for _ in range(n)]
    cid = db.one("authenticated", o.editor, "select public.save_character(%s::uuid, null, %s, 'character', %s, %s::uuid[])",
                 [o.org, name, description, assets])
    return str(cid), assets


def style_kit(db, o, n=3, description=""):
    assets = [db.asset(o.org) for _ in range(n)]
    kid = db.one("authenticated", o.editor, "select public.save_style_kit(%s::uuid, null, 'Lab kit', %s, %s::uuid[])",
                 [o.org, description, assets])
    return str(kid), assets


# ── B1: an edit-only key-frame model ─────────────────────────────────────────

def film_unless_refused_at_save(db, o, **kw):
    """db.film, or None when the save itself refuses the key-frame model by name (0239: "cannot be chosen" is the safe answer)."""
    try:
        return db.film(o, **kw)
    except psycopg.Error as e:
        assert e.diag.message_primary == "model_not_available", e
        assert "a key frame is made from words; choose a key-frame model that makes a picture from words" in (e.diag.message_detail or ""), e
        return None


def test_an_edit_only_key_frame_model_cannot_be_chosen_or_is_refused_at_the_quote_never_held_then_refused(db, models, a):
    """B1 via film_apply_settings (the film's keyframe_model). Same shape as live krea-3-regional (capabilities ['edit'])."""
    fid = film_unless_refused_at_save(db, a, settings={**SETTINGS, "keyframe_model": "img-editonly"})
    if fid is None:
        return
    assert_never_held_then_refused(db, a, fid, "edit-only key-frame model, film default")


def test_a_scene_override_to_an_edit_only_key_frame_model_is_never_held_then_refused(db, models, a):
    """B1 via film_save_scenes (a scene's own keyframe_model); the film's default makes words."""
    scenes = [{**SCENES[0], "keyframe_model": "img-editonly"}, SCENES[1]]
    fid = film_unless_refused_at_save(db, a, settings={**SETTINGS, "keyframe_model": "img-gemk"}, scenes=scenes)
    if fid is None:
        return
    assert_never_held_then_refused(db, a, fid, "edit-only key-frame model, scene override")


# ── B2 / B3: what the worker adds beside film_refs (style kit, @characters) ──

class _StubAdapter:
    """Only the class attributes RegistryAdapter.submit asks before any call; submit itself is never reached in a refusal."""

    def __init__(self, ref_caps):
        self.capabilities = ("t2i", "edit")
        self.reference_capabilities = tuple(ref_caps)
        self.calls_sent = 0

    def problems(self, req, entry):
        return []

    def submit(self, req, vendor_model):
        # Reached only once RegistryAdapter.submit's own guards passed (0239: the take is sent). A ProviderTask's shape, no vendor.
        return type("LabTask", (), {"task_id": "lab-task", "outputs": ()})()


class _Queue:
    def __init__(self, db):
        self.db = db

    def job_style(self, job_id, worker_id):
        return self.db.svc("select public.creative_job_style(%s::uuid, %s)", [job_id, worker_id])


class _Media:
    def copy_input(self, item, dest, name):
        dest.mkdir(parents=True, exist_ok=True)
        p = Path(dest) / f"{name}.png"
        p.write_bytes(b"\x89PNG\r\n\x1a\n" + b"\0" * 64)
        return p


def worker_submit(db, o, tj, model, like, ref_caps, tmp_path, monkeypatch):
    """The real film worker's input step (FilmOrchestrator._inputs, which calls CreativeWorker._style against the real
    creative_job_style) and the real RegistryAdapter.submit guard, for the job film_take_job wrote. Only the file copies and the
    vendor are stubbed. Returns None when the take would be sent, or the refusal text."""
    def fake_copy(root, asset, mime, variants, dest, name):
        dest.mkdir(parents=True, exist_ok=True)
        p = Path(dest) / f"{name}.png"
        p.write_bytes(b"\x89PNG\r\n\x1a\n" + b"\0" * 64)
        return p
    monkeypatch.setattr(cw.ml, "copy_source", fake_copy)
    entry = dataclasses.replace(mr.get(like), id=model)
    adapter = ca.RegistryAdapter(entry, _StubAdapter(ref_caps), sync_store={})
    orch = object.__new__(fo.FilmOrchestrator)
    orch.media = _Media()
    orch.db = type("D", (), {"creative": _Queue(db)})()
    orch.resolve_adapter = lambda _m: adapter
    orch.worker_id = "w-1"
    orch.media_root = tmp_path / "media"
    req = cw.GenerationRequest(job_id=str(tj["job_id"]), org_id=o.org, capability=tj["capability"], model=model, params=tj["params"])
    try:
        req = orch._inputs(req, tj, adapter, tmp_path / "work")
    except fo._TakeFailed as e:
        return f"_inputs: {e}"
    try:
        adapter.submit(req)
    except ca.CreativeAdapterError as e:
        return f"submit: {e}"
    return None


def test_film_references_plus_the_style_kits_pictures_never_exceed_the_model_after_the_hold(db, models, a, tmp_path, monkeypatch):
    """B2: one film reference + a 3-picture style kit on a 3-reference model. film_price: 1 <= 3, t2i listed -> priced."""
    kit, _ = style_kit(db, a, 3, description="")
    fid = db.film(a, settings={**SETTINGS, "keyframe_model": "img-lite", "style_kit_id": kit})
    db.save(a.editor, fid, db.version(fid), {"refs": [{"kind": "style", "asset_id": a.image}]})
    q, out, tj = start_and_take_first_keyframe(db, a, fid)
    if out is None:
        return
    assert tj.get("ok") is True, tj
    refused = worker_submit(db, a, tj, "img-lite", "gemini-3.1-flash-lite-image", ("t2i", "edit"), tmp_path, monkeypatch)
    assert refused is None, f"HOLE (B2): priced {q['total']}, held, then the key frame was refused: {refused}"


@pytest.mark.parametrize("via", ["style_kit", "mention"])
def test_a_style_kit_or_character_with_no_description_on_a_no_t2i_reference_model_is_never_held_then_refused(
        db, models, a, tmp_path, monkeypatch, via):
    """B3: no film_refs (0235's check never asks), a GPT-Image-like key frame, a kit / @character whose only content is pictures."""
    settings = {**SETTINGS, "keyframe_model": "img-gptk"}
    scenes = [dict(s) for s in SCENES]
    if via == "style_kit":
        settings["style_kit_id"] = style_kit(db, a, 3, description="")[0]
    else:
        characters(db, a, "hero", 2, description="")
        scenes[0]["visual_prompt"] = "@hero at the lighthouse door"
    fid = db.film(a, settings=settings, scenes=scenes)
    q, out, tj = start_and_take_first_keyframe(db, a, fid)
    if out is None:
        return
    assert tj.get("ok") is True, tj
    refused = worker_submit(db, a, tj, "img-gptk", "openai-gpt-image-2", ("edit",), tmp_path, monkeypatch)
    assert refused is None, f"HOLE (B3, {via}): priced {q['total']}, held, then the key frame was refused: {refused}"


# ── B4 / B5 / B6: the character pictures the take really carries ─────────────

def test_a_character_whose_picture_was_deleted_is_refused_at_the_quote_not_at_the_take(db, models, a):
    """B4: soft_delete_asset is any member's; film_price's reference_missing asks only that the character exists."""
    cid, assets = characters(db, a, "keeper", 2)
    assert db.one("authenticated", a.editor, "select public.soft_delete_asset(%s::uuid)", [assets[1]]) is True
    fid = db.film(a, settings={**SETTINGS, "keyframe_model": "img-gemk"})
    db.save(a.editor, fid, db.version(fid), {"refs": [{"kind": "character", "character_id": cid}]})
    assert_never_held_then_refused(db, a, fid, "a character picture deleted before the quote")


def test_a_character_given_more_pictures_after_start_never_reaches_the_take_above_the_models_limit(db, models, a, tmp_path, monkeypatch):
    """B5: priced with 1 picture on a 3-reference model; the character then gets 8 (save_character is not locked by a running film).
    0239 closes it in the worker (film_take_job belongs to a later file): the take is failed by name in FilmOrchestrator._inputs,
    before the style is read or the adapter is called."""
    cid, _ = characters(db, a, "skipper", 1)
    fid = db.film(a, settings={**SETTINGS, "keyframe_model": "img-lite"})
    db.save(a.editor, fid, db.version(fid), {"refs": [{"kind": "character", "character_id": cid}]})
    q = db.quote(a.editor, fid)
    assert q["priced"] is True, q["refusals"]
    assert db.start(a.admin, fid, q["quote_id"]).get("ok") is True
    more = [db.asset(a.org) for _ in range(8)]
    db.one("authenticated", a.editor, "select public.save_character(%s::uuid, %s::uuid, 'skipper', 'character', '', %s::uuid[])",
           [a.org, cid, more])
    db.claim()
    take = db.su("select t.id from public.film_takes t join public.film_segments g on g.id = t.segment_id "
                 "where g.film_id = %s and t.kind = 'keyframe' order by t.attempt limit 1", [fid])[0][0]
    db.begin(take)
    tj = db.svc("select public.film_take_job(%s, 'w-1')", [take])
    n = len(refs_of(tj)) if tj.get("ok") else 0
    if n <= model_max(db, "img-lite"):
        return  # the take itself does not carry more than the model takes
    refused = worker_submit(db, a, tj, "img-lite", "gemini-3.1-flash-lite-image", ("t2i", "edit"), tmp_path, monkeypatch)
    assert refused is not None and refused.startswith("_inputs: ") and "remove some pictures" in refused, (
        f"HOLE (B5): held at {q['total']}, the take carries {n} references to a model that takes {model_max(db, 'img-lite')}, "
        f"and the worker answered {refused!r} (sent, or refused only by the adapter at submit)")


def test_a_model_that_takes_more_than_sixteen_references_is_not_priced_for_what_the_take_refuses(db, models, a):
    """B6 (latent): 3 characters x 8 pictures = 24 <= 30 is priced; film_take_job refuses > 16 as input_missing."""
    refs = [{"kind": "character", "character_id": characters(db, a, f"crew_{i}", 8)[0]} for i in range(3)]
    fid = db.film(a, settings={**SETTINGS, "keyframe_model": "img-wide"})
    db.save(a.editor, fid, db.version(fid), {"refs": refs})
    assert_never_held_then_refused(db, a, fid, "more than 16 references on a model that states 30")


# ── what held (pins) ─────────────────────────────────────────────────────────

@pytest.mark.parametrize("model", sorted(MALFORMED))
def test_a_malformed_ref_capabilities_is_refused_with_a_reference(db, models, a, model):
    fid = db.film(a, settings={**SETTINGS, "keyframe_model": model})
    db.save(a.editor, fid, db.version(fid), {"refs": [{"kind": "style", "asset_id": a.image}]})
    q = db.quote(a.editor, fid)
    assert q["quote_id"] is None and {ln["reason"] for ln in keyframes(q)} == {"refs_not_supported"}, keyframes(q)


def test_a_scene_override_to_a_gpt_like_model_under_a_gemini_like_default_is_refused_with_a_reference(db, models, a):
    scenes = [{**SCENES[0], "keyframe_model": "img-gptk", "refs": [{"kind": "style", "asset_id": a.image}]}, SCENES[1]]
    fid = db.film(a, settings={**SETTINGS, "keyframe_model": "img-gemk"}, scenes=scenes)
    q = db.quote(a.editor, fid)
    kf = keyframes(q)
    assert q["quote_id"] is None and kf[0]["model"] == "img-gptk" and kf[0]["reason"] == "refs_not_supported", kf

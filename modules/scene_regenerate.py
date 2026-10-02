"""Regenerate ONE scene of a run with the source it was made with (migration 0076).

    python main.py --channel <id> --topic <run slug> --regenerate-scene s003

The priced "Regenerate scene" press (``request_scene_regenerate``) froze what
this run must do into the ``scene_regenerations`` row; the queue worker hands
those terms over in the environment (``SCENE_REGEN_*``, never argv) after it
has claimed the hold. This module carries them out:

1. **Preflight — before anything is spent.** The run must exist on this
   machine with its Video IR, narration, subtitles, script and the footage of
   every OTHER scene (``scene_repair.preflight``, the same rules). The scene
   on disk must still be the one that was priced: its generated clips name the
   provider and model the press recorded. For a generated scene, that
   provider must be configured here with THAT model. Anything else is
   :class:`RegenUnavailable` with the remedy: the run stops, nothing is
   charged (the worker releases the hold), and no stock footage is used in
   its place — CLAUDE.md rule 4. Stock is used only when the scene was stock,
   or when the person chose stock explicitly on the press.
2. **New footage for that scene only.** Generated clips are submitted to the
   same provider through the provider task ledger (``provider_tasks``), keyed
   by this regeneration, so a re-queued job polls the clip it already paid
   for instead of paying again. Stock clips are searched as a repair searches
   them (``scene_repair.fetch_replacements``), excluding every clip the run
   already has. An optional prompt edit replaces the clip prompt (generated)
   or leads the search terms (stock).
3. **The previous take is kept, and the cut changes last.** The previous
   ``project.json`` and ``final_video.mp4`` are copied under
   ``regenerations/<id>/``; the old scene's asset files are never deleted
   (only the masters of takes older than the last :data:`KEEP_TAKES` are).
   The new cut and IR are rendered beside the run under temp names; then the
   approval is voided, then the result naming the new files' hashes is
   written, and only then are the two files renamed into place. The worker
   charges only when the files on disk match that result
   (:func:`settle_outcome`) and otherwise puts the previous take back, so a
   failure always leaves the run as it was.
4. **Hold for review.** Like a repair, it never uploads, publishes or changes
   privacy; it voids the approval of the previous cut
   (``scene_repair.invalidate_approvals`` + the checkpoint's repair time) and
   records the held row. The publish gate is not evaluated here.

Every outcome writes ``regenerations/<id>/result.json`` (ids, codes and
counts only — no paths outside the run, no prompt, no key) for the worker to
settle with. Exit codes: 0 done, 2 bad request, 3 unavailable (nothing
spent), 4 failed.
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import re
import shutil
import time
from dataclasses import dataclass, field, replace
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable, Dict, List, Mapping, Optional, Sequence, Tuple

from modules import scene_repair, video_ir

logger = logging.getLogger(__name__)

EXIT_OK = 0
EXIT_BAD_REQUEST = 2
EXIT_UNAVAILABLE = 3
EXIT_FAILED = 4

ENV_ID = "SCENE_REGEN_ID"
ENV_SOURCE = "SCENE_REGEN_SOURCE"
ENV_PROVIDER = "SCENE_REGEN_PROVIDER"
ENV_MODEL = "SCENE_REGEN_MODEL"
ENV_PROMPT = "SCENE_REGEN_PROMPT"
ENV_EXPLICIT_STOCK = "SCENE_REGEN_EXPLICIT_STOCK"
#: What was priced (BR-L-025): the scene's asset ids and its clip counts, as
#: the database read them. The scene on disk must be exactly this.
ENV_PREVIOUS_ASSETS = "SCENE_REGEN_PREVIOUS_ASSETS"
ENV_GENERATED_CLIPS = "SCENE_REGEN_GENERATED_CLIPS"
ENV_STOCK_ASSETS = "SCENE_REGEN_STOCK_ASSETS"
ENV_KEYS = (ENV_ID, ENV_SOURCE, ENV_PROVIDER, ENV_MODEL, ENV_PROMPT, ENV_EXPLICIT_STOCK,
            ENV_PREVIOUS_ASSETS, ENV_GENERATED_CLIPS, ENV_STOCK_ASSETS)

REGEN_DIRNAME = "regenerations"
RESULT_FILENAME = "result.json"
PREVIOUS_PROJECT = "previous_project.json"
PREVIOUS_VIDEO = "previous_final_video.mp4"
#: How many takes per run keep their full previous master (BR-L-027). Older
#: takes keep their result and previous Video IR (asset ids), not the master.
KEEP_TAKES = 5
#: Free space a regeneration needs beyond two copies of the cut (the kept
#: previous master and the new render) before anything is spent.
MIN_FREE_MARGIN_BYTES = 256 * 1024 * 1024

SOURCE_GENERATED = "generated"
SOURCE_STOCK = "stock"
#: The providers migration 0076 accepts (its CHECK and scene_regen_plan).
PROVIDERS = ("minimax", "higgsfield", "kling", "veo", "seedance", "wan")
MAX_PROMPT_CHARS = 1000
MAX_GENERATED_CLIPS = 8

_UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
_MODEL_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$")
_CODE_RE = re.compile(r"^[a-z][a-z0-9_]{0,47}$")
_ASSET_ID_RE = re.compile(r"^[A-Za-z0-9_.:-]{1,64}$")
_CONTROL_RE = re.compile(r"[\x00-\x1f\x7f]")


class RegenRequestError(ValueError):
    """The request handed over is malformed (exit 2). Nothing was spent."""


class RegenUnavailable(RuntimeError):
    """This regeneration cannot run here as priced (exit 3). Raised before
    anything is spent; ``code`` is the machine reason the app shows."""

    def __init__(self, code: str, detail: str):
        self.code = code if _CODE_RE.match(code or "") else "unavailable"
        super().__init__(detail)


class RegenFailed(RuntimeError):
    """It started and could not finish (exit 4). The run is as it was."""

    def __init__(self, code: str, detail: str):
        self.code = code if _CODE_RE.match(code or "") else "failed"
        super().__init__(detail)


# ── the request ─────────────────────────────────────────────────────────────

@dataclass(frozen=True)
class RegenRequest:
    regen_id: str
    scene_id: str
    source_kind: str
    provider: Optional[str] = None
    model: Optional[str] = None
    prompt: Optional[str] = None
    explicit_stock: bool = False
    previous_asset_ids: Tuple[str, ...] = ()
    generated_clips: int = 0
    stock_assets: int = 0

    @staticmethod
    def from_env(scene_id: str, env: Mapping[str, str]) -> "RegenRequest":
        """Strict: the worker writes these from the database row, but a
        malformed value is refused rather than guessed at."""
        rid = str(env.get(ENV_ID) or "").strip().lower()
        if not _UUID_RE.match(rid):
            raise RegenRequestError(f"{ENV_ID} must be the regeneration's id")
        kind = str(env.get(ENV_SOURCE) or "").strip()
        if kind not in (SOURCE_GENERATED, SOURCE_STOCK):
            raise RegenRequestError(f"{ENV_SOURCE} must be '{SOURCE_GENERATED}' or '{SOURCE_STOCK}'")
        provider = str(env.get(ENV_PROVIDER) or "").strip() or None
        model = str(env.get(ENV_MODEL) or "").strip() or None
        if kind == SOURCE_GENERATED:
            if provider not in PROVIDERS:
                raise RegenRequestError(f"{ENV_PROVIDER} must be one of {', '.join(PROVIDERS)}")
            if not model or not _MODEL_RE.match(model):
                raise RegenRequestError(f"{ENV_MODEL} is not a model id")
        elif provider or model:
            raise RegenRequestError("a stock regeneration names no generator")
        prompt = str(env.get(ENV_PROMPT) or "").strip() or None
        if prompt is not None and (len(prompt) > MAX_PROMPT_CHARS or _CONTROL_RE.search(prompt)):
            raise RegenRequestError(f"{ENV_PROMPT} is longer than {MAX_PROMPT_CHARS} characters "
                                    "or has control characters")
        explicit = str(env.get(ENV_EXPLICIT_STOCK) or "").strip().lower() == "true"
        if explicit and kind != SOURCE_STOCK:
            raise RegenRequestError("an explicit stock choice is a stock regeneration")
        raw_ids = str(env.get(ENV_PREVIOUS_ASSETS) or "").strip()
        ids = tuple(raw_ids.split(",")) if raw_ids else ()
        if not ids or len(ids) > MAX_GENERATED_CLIPS or len(set(ids)) != len(ids) \
                or not all(_ASSET_ID_RE.match(i) for i in ids):
            raise RegenRequestError(f"{ENV_PREVIOUS_ASSETS} must list the priced scene's asset ids")
        counts = []
        for key in (ENV_GENERATED_CLIPS, ENV_STOCK_ASSETS):
            raw = str(env.get(key) or "").strip()
            if not re.fullmatch(r"[0-9]", raw):
                raise RegenRequestError(f"{key} must be the priced clip count")
            counts.append(int(raw))
        gen, stock = counts
        if gen + stock > len(ids) or (kind == SOURCE_GENERATED and gen == 0):
            raise RegenRequestError("the priced clip counts do not fit the priced scene")
        return RegenRequest(regen_id=rid, scene_id=scene_id, source_kind=kind, provider=provider,
                            model=model, prompt=prompt, explicit_stock=explicit,
                            previous_asset_ids=ids, generated_clips=gen, stock_assets=stock)


def parse_scene(raw: Optional[str]) -> str:
    """Exactly one scene, by the repair parser's strict rules."""
    try:
        ids = scene_repair.parse_repair_scenes(raw)
    except scene_repair.RepairRequestError as e:
        raise RegenRequestError(str(e)) from None
    if len(ids) != 1:
        raise RegenRequestError("--regenerate-scene names exactly one scene")
    return ids[0]


# ── the scene as priced ─────────────────────────────────────────────────────

def scene_assets(project, scene_id: str) -> List:
    scene = project.scene(scene_id)
    return [project.asset(aid) for aid in scene.asset_ids]


_CHANGED = "open the video again for a new price (nothing was charged)"


def verify_same_scene(project, req: RegenRequest) -> None:
    """The scene on disk is EXACTLY the one that was priced (BR-L-025): the
    same asset ids in the same order, the same number of generated and stock
    clips, and every generated clip from the priced provider and model. The
    database's record of a run is best-effort and can lag the disk (a resume,
    a CLI repair, an outage), so "close enough" is not checked here — any
    difference is ``scene_changed``: nothing runs, the hold is released.

    A scene priced as stock must have no generated clip on disk unless the
    person chose stock explicitly; otherwise a generated scene would be
    replaced by stock without anyone choosing it (CLAUDE.md rule 4)."""
    scene = project.scene(req.scene_id)
    ids = tuple(scene.asset_ids)
    if ids != tuple(req.previous_asset_ids):
        raise RegenUnavailable("scene_changed",
                               f"scene {req.scene_id} on this machine is not the scene that was priced; {_CHANGED}")
    assets = scene_assets(project, req.scene_id)
    if not assets or any(a is None for a in assets):
        raise RegenUnavailable("scene_changed", f"scene {req.scene_id} has no footage recorded on this machine")
    if len(assets) > MAX_GENERATED_CLIPS:
        raise RegenUnavailable("too_many_assets", f"scene {req.scene_id} has more than {MAX_GENERATED_CLIPS} clips")
    generated = [a for a in assets if a.source == video_ir.SOURCE_GENERATED]
    stock = [a for a in assets if a.source == video_ir.SOURCE_STOCK]
    if req.explicit_stock:
        # The person chose stock for the whole scene; the ids above are the
        # scene that choice was priced for.
        return
    if len(generated) != req.generated_clips or len(stock) != req.stock_assets \
            or len(generated) + len(stock) != len(assets):
        raise RegenUnavailable(
            "scene_changed",
            f"scene {req.scene_id} on this machine has {len(generated)} generated and {len(stock)} stock "
            f"clip(s), but {req.generated_clips} and {req.stock_assets} were priced; {_CHANGED}")
    if req.source_kind == SOURCE_GENERATED:
        for a in generated:
            if (a.provider or "").strip().lower() != req.provider or (a.model or "") != req.model:
                raise RegenUnavailable(
                    "scene_changed",
                    f"scene {req.scene_id} on this machine was not made with the generator that was priced; "
                    f"{_CHANGED}")


def configured_model(client) -> str:
    """The model a provider client will actually call: the generic clients
    carry it on their config, MiniMax on the client."""
    cfg = getattr(client, "cfg", None)
    model = getattr(cfg, "model", None) if cfg is not None else None
    if model is None:
        model = getattr(client, "model", None)
    return str(model or "")


def open_generator(req: RegenRequest, *, get_client: Optional[Callable] = None):
    """The provider client for this scene: the SAME provider, configured with
    the SAME model. No key, another model, or a configuration that cannot
    produce a clip is RegenUnavailable with the remedy. Makes no network call."""
    from modules import minimax_broll, video_providers

    if get_client is None:
        get_client = video_providers.get_client
    client = get_client(req.provider)
    if client is None:
        raise RegenUnavailable(
            "provider_unavailable",
            f"the generator this scene was made with ({req.provider}) has no API key on this worker. "
            "Fix: set its key on the worker, then press Regenerate again (nothing was charged).")
    have = configured_model(client)
    if have != req.model:
        raise RegenUnavailable(
            "model_changed",
            f"this scene was made with {req.provider} model {req.model!r}, but this worker is "
            f"configured for {have or 'no model'!r}. Fix: configure {req.model!r} again, or choose "
            "stock footage explicitly for this scene (nothing was charged).")
    check = getattr(client, "preflight", None)
    if callable(check):
        try:
            check()
        except minimax_broll.VideoModelUnavailable as e:
            raise RegenUnavailable("provider_unavailable", str(e)) from None
    return client


# ── new footage ─────────────────────────────────────────────────────────────

@dataclass
class NewClip:
    path: Path
    source: str
    provider: Optional[str]
    model: Optional[str] = None
    prompt: Optional[str] = None
    task_id: Optional[str] = None


def _clip_hash(base: str, regen_id: str, n: int) -> str:
    # The provider ledger keys a task by provider + scene + prompt hash. A
    # regeneration must never be handed the ORIGINAL clip of the same prompt
    # (that is the take being replaced), and a re-queued attempt of THIS
    # regeneration must find its own submitted task: salt with the id.
    return hashlib.sha256(f"{base}|{regen_id}|{n}".encode("utf-8")).hexdigest()[:16]


def generate_clips(plan, req: RegenRequest, client, *, out_dir: Path, ledger=None) -> List[NewClip]:
    """One new clip per generated clip the scene had, from the same provider
    and model. Raises RegenFailed (provider refused mid-way / clip lost) or
    RegenUnavailable (refused before any task was accepted)."""
    from modules import minimax_broll, provider_tasks

    project = plan.project
    scene = project.scene(req.scene_id)
    old = [a for a in scene_assets(project, req.scene_id) if a.source == video_ir.SOURCE_GENERATED]
    if ledger is None:
        ledger = provider_tasks.TaskLedger.open(plan.slug, root=plan.run_dir.parent)
    share = (scene.duration_s or 0) / max(1, len(scene.asset_ids))
    seconds = minimax_broll.clamp_duration(share if share > 0 else 5, req.model)
    vertical = (project.height or 0) > (project.width or 0)
    section = scene_repair._section(plan, scene.index)
    keywords = scene_repair.scene_keywords(plan, scene)
    out: List[NewClip] = []
    submitted_any = False
    for n, previous in enumerate(old):
        prompt = req.prompt or previous.prompt or minimax_broll.build_prompt(
            str(plan.script.get("topic") or plan.topic or ""), keywords)
        spec = minimax_broll.GenerationSpec(
            prompt=prompt, duration_seconds=seconds, section_index=scene.index,
            keyword=(keywords[0] if keywords else str(section.get("name") or "")),
            aspect_ratio="9:16" if vertical else "")
        phash = _clip_hash(provider_tasks.prompt_hash(req.provider, req.model, spec), req.regen_id, n)
        dest = out_dir / f"{req.scene_id}_take_{n}.mp4"
        task = ledger.find(req.provider, req.scene_id, phash)
        on_disk = task.clip_on_disk() if task is not None else None
        if on_disk is not None:
            out.append(NewClip(on_disk, SOURCE_GENERATED, req.provider, req.model, prompt, task.task_id))
            continue
        if task is None or task.status != provider_tasks.STATUS_SUBMITTED:
            try:
                task_id = client.submit(spec)
            except minimax_broll.VideoModelUnavailable as e:
                if submitted_any:
                    raise RegenFailed("provider_failed", str(e)) from None
                raise RegenUnavailable("provider_unavailable", str(e)) from None
            if not task_id:
                raise RegenUnavailable("provider_unavailable",
                                       f"{req.provider} accepted no task (is its key set on this worker?)")
            submitted_any = True
            task = ledger.record_submitted(provider=req.provider, model=req.model, task_id=task_id,
                                           section_index=scene.index, phash=phash)
        outcome = client.resume(task.task_id, dest)
        ledger.record_outcome(task, outcome)
        if outcome.state == provider_tasks.OUTCOME_SUCCEEDED and outcome.path is not None:
            out.append(NewClip(Path(outcome.path), SOURCE_GENERATED, req.provider, req.model, prompt, task.task_id))
            logger.info("Regeneration %s: new clip %d for %s from the same generator", req.regen_id, n,
                        req.scene_id)
            continue
        if outcome.state == provider_tasks.OUTCOME_FAILED:
            raise RegenFailed("provider_failed", f"the generator reported the clip failed: {outcome.reason}"[:400])
        raise RegenFailed("provider_pending",
                          "the generator did not return the clip in time; the previous take was kept")
    return out


def fetch_stock(plan, req: RegenRequest, fetcher) -> Tuple[List[NewClip], int]:
    """New stock footage for the scene (the repair search, the prompt edit
    leading the terms). Returns the clips and the searches made."""
    script = plan.script
    if req.prompt:
        sections = list(script.get("sections") or [])
        idx = plan.project.scene(req.scene_id).index
        if 0 <= idx < len(sections) and isinstance(sections[idx], Mapping):
            section = dict(sections[idx])
            section["keywords"] = [req.prompt[:80]] + list(section.get("keywords") or [])
            sections[idx] = section
            script = dict(script, sections=sections)
    one = replace(plan, scene_ids=(req.scene_id,), script=script)
    before = int(getattr(fetcher, "searches_made", 0) or 0)
    try:
        found = scene_repair.fetch_replacements(one, fetcher)
    except scene_repair.RepairFailed as e:
        raise RegenFailed("no_footage_found", str(e)) from None
    searches = int(getattr(fetcher, "searches_made", 0) or 0) - before
    return [NewClip(Path(p), SOURCE_STOCK, "pexels") for p in found.get(req.scene_id, [])], max(0, searches)


def apply_clips(project, scene_id: str, clips: Sequence[NewClip], provenance: Optional[Mapping] = None):
    """The project with ``scene_id`` pointing at the new clips, each recorded
    with its real source, provider and model; every other scene untouched and
    the old assets still listed (the previous take is kept)."""
    assets = list(project.assets)
    known = {a.id for a in assets}
    ids: List[str] = []
    for c in clips:
        aid = video_ir.asset_id(str(c.path))
        ids.append(aid)
        if aid in known:
            continue
        kind = video_ir.ASSET_VIDEO if c.path.suffix.lower() in (".mp4", ".mov", ".webm", ".mkv", ".avi") \
            else video_ir.ASSET_IMAGE
        ref = video_ir.AssetRef(id=aid, kind=kind, path=str(c.path), source=c.source, provider=c.provider,
                                model=c.model, prompt=c.prompt, task_id=c.task_id)
        if c.source == SOURCE_STOCK:
            ref = video_ir._with_provenance(ref, (provenance or {}).get(str(c.path)))
        digest = video_ir.file_sha256(c.path)
        if digest is not None:
            ref = replace(ref, sha256=digest)
        assets.append(ref)
        known.add(aid)
    scenes = tuple(replace(s, asset_ids=tuple(dict.fromkeys(ids))) if s.id == scene_id else s
                   for s in project.scenes)
    return replace(project, scenes=scenes, assets=tuple(assets))


# ── the regeneration ────────────────────────────────────────────────────────

def regen_dir(run_dir: Path, regen_id: str) -> Path:
    return Path(run_dir) / REGEN_DIRNAME / regen_id


def _keep(src: Path, dest: Path) -> Optional[str]:
    """Keep a copy of the previous take. A real copy, never a hard link: a
    writer that rewrites the file in place (video_ir.save does) would change a
    linked "previous" take along with the current one."""
    if not src.is_file():
        return None
    if not dest.exists():
        shutil.copy2(src, dest)
    return dest.name


def write_result(out_dir: Path, body: Mapping, *, strict: bool = False) -> None:
    """Atomically. ``strict`` raises an OSError instead of logging it — the
    success result is written BEFORE the cut changes, and a cut must never
    change without a result saying so."""
    try:
        out_dir.mkdir(parents=True, exist_ok=True)
        tmp = out_dir / (RESULT_FILENAME + ".tmp")
        tmp.write_text(json.dumps(dict(body), indent=2), encoding="utf-8")
        os.replace(tmp, out_dir / RESULT_FILENAME)
    except OSError as e:
        if strict:
            raise
        logger.warning("Regeneration: could not write its result (%s)", e)


def temp_paths(run_dir: Path, regen_id: str) -> Tuple[Path, Path]:
    """Where the new cut and Video IR are written before the swap: beside the
    run's own files (same filesystem, so the swap is a rename; same folder,
    so the scene render cache is the run's)."""
    return (Path(run_dir) / f".regen-{regen_id}.{scene_repair.FINAL_VIDEO}",
            Path(run_dir) / f".regen-{regen_id}.{video_ir.PROJECT_FILENAME}")


def _discard(*paths: Path) -> None:
    for p in paths:
        try:
            Path(p).unlink()
        except OSError:
            pass


def _replace_from(src: Path, dest: Path) -> None:
    """``dest`` becomes a copy of ``src``, atomically (copy then rename)."""
    tmp = dest.with_name(dest.name + ".restore")
    shutil.copy2(src, tmp)
    os.replace(tmp, dest)


def restore_previous_take(run_dir: Path, regen_id: str) -> List[str]:
    """Put the previous take back wherever the cut or Video IR differ from it
    (a swap that did not finish, or a run that died after it). Returns what
    was restored. Never raises; the leftover temp files are removed."""
    run_dir = Path(run_dir)
    kept = regen_dir(run_dir, regen_id)
    restored = []
    for name, target in ((PREVIOUS_PROJECT, run_dir / video_ir.PROJECT_FILENAME),
                         (PREVIOUS_VIDEO, run_dir / scene_repair.FINAL_VIDEO)):
        prev = kept / name
        try:
            if prev.is_file() and not prev.is_symlink() and \
                    video_ir.file_sha256(prev) != video_ir.file_sha256(target):
                _replace_from(prev, target)
                restored.append(target.name)
        except OSError as e:
            logger.error("Regeneration %s: could not restore %s (%s)", regen_id, target.name, e)
    _discard(*temp_paths(run_dir, regen_id))
    if restored:
        logger.warning("Regeneration %s: the previous take was put back (%s)", regen_id, ", ".join(restored))
    return restored


def commit_matches(run_dir: Path, result: Mapping) -> bool:
    """Is the cut on disk exactly the one this result says it made?"""
    run_dir = Path(run_dir)
    want_video, want_ir = result.get("new_video_sha256"), result.get("new_project_sha256")
    if not (isinstance(want_video, str) and isinstance(want_ir, str) and want_video and want_ir):
        return False
    return (video_ir.file_sha256(run_dir / scene_repair.FINAL_VIDEO) == want_video
            and video_ir.file_sha256(run_dir / video_ir.PROJECT_FILENAME) == want_ir)


def settle_outcome(output_dir: Path, slug: str, regen_id: str, *, exited_ok: bool) -> dict:
    """The queue worker's verdict on a finished regeneration run (BR-L-026).

    Success needs all three: the run exited 0, its own result says ok, and the
    cut and Video IR on disk are byte for byte the ones that result names.
    Anything else is a failure, and the previous take is put back first — so a
    failure (released, nothing charged) always means the scene is unchanged,
    whatever point the run died at. Returns ``{ok, code, error, result}``."""
    result = read_result(output_dir, slug, regen_id) or {}
    run_dir = Path(output_dir) / slug
    if exited_ok and result.get("ok") is True and run_dir.is_dir() and commit_matches(run_dir, result):
        _discard(*temp_paths(run_dir, regen_id))
        return {"ok": True, "code": None, "error": None, "result": result}
    if run_dir.is_dir() and re.match(r"^[a-z0-9][a-z0-9-]{0,63}$", slug or "") and _UUID_RE.match(regen_id or ""):
        restore_previous_take(run_dir, regen_id)
    if result.get("ok") is True:
        code = "not_confirmed"
    else:
        code = str(result.get("error_code") or ("not_confirmed" if exited_ok else "failed"))
    return {"ok": False, "code": code if _CODE_RE.match(code) else "failed",
            "error": result.get("error") if result.get("ok") is not True else None, "result": result}


def check_disk(run_dir: Path, *, free_fn: Optional[Callable[[Path], int]] = None) -> None:
    """Room for the kept previous master and the new render, before anything
    is spent (BR-L-027). One worker disk serves every tenant."""
    run_dir = Path(run_dir)
    if free_fn is None:
        free_fn = lambda p: shutil.disk_usage(p).free  # noqa: E731
    try:
        cut = (run_dir / scene_repair.FINAL_VIDEO).stat().st_size
    except OSError:
        cut = 0
    margin = MIN_FREE_MARGIN_BYTES
    raw = os.environ.get("CHRONOS_REGEN_MIN_FREE_MB", "").strip()
    if raw.isdigit():
        margin = int(raw) * 1024 * 1024
    need = 2 * cut + margin
    if free_fn(run_dir) < need:
        raise RegenUnavailable("disk_full", f"the worker has less than {need // (1024 * 1024)} MB free for this "
                                            "regeneration. Free space on the worker, then press Regenerate again "
                                            "(nothing was charged).")


def prune_takes(run_dir: Path, *, keep: int = KEEP_TAKES, project=None) -> List[str]:
    """Bound what regenerations keep on disk (BR-L-027), for every org: the
    newest ``keep`` takes keep their full previous master; older ones keep
    their result and previous Video IR (the asset ids) but not the master,
    and a failed one's own clips are removed. A file the current Video IR
    uses is never removed. Returns the removed paths (relative). Never raises."""
    run_dir = Path(run_dir)
    root = run_dir / REGEN_DIRNAME
    removed: List[str] = []
    try:
        dirs = [d for d in root.iterdir() if d.is_dir() and not d.is_symlink() and _UUID_RE.match(d.name)]
    except OSError:
        return removed
    in_use = set()
    if project is not None:
        for a in project.assets:
            try:
                in_use.add(Path(a.path).resolve())
            except (OSError, TypeError, ValueError):
                pass

    def stamp(d: Path) -> float:
        try:
            return (d / RESULT_FILENAME).stat().st_mtime
        except OSError:
            return d.stat().st_mtime

    for d in sorted(dirs, key=stamp, reverse=True)[keep:]:
        body = read_result(run_dir.parent, run_dir.name, d.name) or {}
        victims = [d / PREVIOUS_VIDEO]
        if body.get("ok") is not True:
            victims += [p for p in d.glob("*.mp4") if p.name != PREVIOUS_VIDEO]
        for p in victims:
            try:
                if p.is_file() and not p.is_symlink() and p.resolve() not in in_use:
                    p.unlink()
                    removed.append(str(p.relative_to(run_dir)))
            except OSError as e:
                logger.warning("Regeneration: could not prune %s (%s)", p.name, e)
    if removed:
        logger.info("Regeneration: pruned %d file(s) of takes older than the last %d", len(removed), keep)
    return removed


@dataclass
class RegenResult:
    regen_id: str
    scene_id: str
    video_path: Path
    source_kind: str
    explicit_stock: bool
    previous_asset_ids: List[str]
    new_asset_ids: List[str]
    previous_take: Dict[str, Optional[str]] = field(default_factory=dict)
    qc: Optional[dict] = None
    approvals: Optional[dict] = None
    regenerated_at: str = ""
    new_video_sha256: Optional[str] = None
    new_project_sha256: Optional[str] = None

    def to_metadata(self) -> dict:
        """Ids, codes and counts only — no paths outside the run, no prompt."""
        return {"version": 1, "ok": True, "regeneration_id": self.regen_id, "scene_id": self.scene_id,
                "source_kind": self.source_kind, "explicit_stock": self.explicit_stock,
                "previous_asset_ids": self.previous_asset_ids, "new_asset_ids": self.new_asset_ids,
                "previous_take": self.previous_take, "qc": self.qc, "approvals": self.approvals,
                "gate": "not_evaluated", "published": False, "regenerated_at": self.regenerated_at,
                "new_video_sha256": self.new_video_sha256, "new_project_sha256": self.new_project_sha256}


def regenerate(plan, req: RegenRequest, *, client=None, fetcher=None, ledger=None,
               render_fn: Optional[Callable] = None, qc_fn: Optional[Callable] = None,
               sync=None, root: Optional[Path] = None) -> RegenResult:
    """Carry out a regeneration the preflight approved. Raises RegenFailed /
    RegenUnavailable; on any raise the run's cut and Video IR are unchanged."""
    from modules import run_checkpoint

    project = plan.project
    out_dir = regen_dir(plan.run_dir, req.regen_id)
    out_dir.mkdir(parents=True, exist_ok=True)
    previous_ids = list(project.scene(req.scene_id).asset_ids)

    clips: List[NewClip] = []
    searches = 0
    if req.source_kind == SOURCE_GENERATED:
        if client is None:
            client = open_generator(req)
        clips += generate_clips(plan, req, client, out_dir=out_dir, ledger=ledger)
    has_stock = any(a is not None and a.source == video_ir.SOURCE_STOCK
                    for a in scene_assets(project, req.scene_id))
    if req.source_kind == SOURCE_STOCK or has_stock:
        if fetcher is None:
            from modules.media_fetcher import MediaFetcher

            fetcher = MediaFetcher(plan.slug)
        stock, searches = fetch_stock(plan, req, fetcher)
        clips += stock
    if not clips:
        raise RegenFailed("no_footage_found", f"no new footage for scene {req.scene_id}")

    updated = apply_clips(project, req.scene_id, clips, getattr(fetcher, "provenance", None))
    problems = updated.validate()
    if problems:
        raise RegenFailed("invalid_project", "the regenerated Video IR is invalid: " + "; ".join(problems[:3]))

    # The previous take, kept before anything changes on disk.
    video_path = plan.run_dir / scene_repair.FINAL_VIDEO
    ir_path = plan.run_dir / video_ir.PROJECT_FILENAME
    previous_take = {"project": _keep(ir_path, out_dir / PREVIOUS_PROJECT),
                     "video": _keep(video_path, out_dir / PREVIOUS_VIDEO)}

    # From here a two-person approval of the previous cut is void
    # (scene_repair.repaired_at); if that cannot be recorded, nothing renders.
    if run_checkpoint.record_stage(plan.slug, scene_repair.STAGE_REPAIR, root=root) is None:
        raise RegenFailed("checkpoint_unwritable",
                          "could not record the regeneration on the run checkpoint; nothing was re-rendered")
    cut_intervals = {i: scene_repair._cut_interval(s) for i, s in enumerate(plan.script.get("sections") or [])
                     if isinstance(s, Mapping)}
    # BR-L-026: the new cut and IR are written beside the run's, under temp
    # names. The run's own files change only in the swap at the very end,
    # after the approval is void and the result that names them is written.
    tmp_video, tmp_ir = temp_paths(plan.run_dir, req.regen_id)
    _discard(tmp_video, tmp_ir)
    try:
        return _render_and_commit(plan, req, updated, clips, searches, previous_ids, previous_take,
                                  video_path, ir_path, tmp_video, tmp_ir, out_dir, cut_intervals,
                                  render_fn=render_fn, qc_fn=qc_fn, sync=sync, root=root)
    except BaseException:
        _discard(tmp_video, tmp_ir)
        raise


def _render_and_commit(plan, req, updated, clips, searches, previous_ids, previous_take, video_path, ir_path,
                       tmp_video, tmp_ir, out_dir, cut_intervals, *, render_fn, qc_fn, sync, root):
    from modules import run_checkpoint, scene_render

    started = time.monotonic()
    try:
        rendered = (render_fn or scene_render.render_project)(updated, tmp_video, cut_intervals=cut_intervals)
    except Exception as e:
        raise RegenFailed("render_failed", f"scene render failed ({type(e).__name__}: {e})"[:400])
    render_seconds = time.monotonic() - started
    if req.scene_id not in list(rendered.cache_misses) or not tmp_video.is_file():
        raise RegenFailed("render_failed", f"scene {req.scene_id} was not re-rendered")

    qc_meta = None
    try:
        if qc_fn is None:
            from modules import video_qc

            qc_fn = video_qc.run
        report = qc_fn(tmp_video, audio_path=updated.audio.path,
                       timeline=scene_repair.timeline_from_project(updated))
        to_meta = getattr(report, "to_metadata", None)
        qc_meta = to_meta() if callable(to_meta) else None
    except Exception as e:   # unmeasured is not passed — and it is said
        logger.warning("Regeneration: QC did not run (%s: %s)", type(e).__name__, e)
        qc_meta = {"not_run": type(e).__name__}

    video_ir.save(updated, tmp_ir)

    # 1. Void the approval of the previous cut BEFORE the cut changes. If
    #    Supabase holds rows for this run and they could not be reset, the
    #    swap does not happen: an approved state never meets a new cut.
    approvals = scene_repair.invalidate_approvals(plan.channel_id, plan.slug, (req.scene_id,), sync=sync)
    if approvals.get("error") or (approvals.get("video_rows") and not approvals.get("videos_reset")):
        raise RegenFailed("approval_not_voided",
                          "the approval of the previous cut could not be voided, so the new cut was not put in "
                          "place; the previous take is unchanged")

    # 2. The result that names the new cut, written before the swap. The
    #    worker charges only if the files on disk are exactly these.
    at = datetime.now(timezone.utc).isoformat()
    result = RegenResult(
        regen_id=req.regen_id, scene_id=req.scene_id, video_path=video_path, source_kind=req.source_kind,
        explicit_stock=req.explicit_stock, previous_asset_ids=previous_ids,
        new_asset_ids=list(updated.scene(req.scene_id).asset_ids), previous_take=previous_take,
        qc=qc_meta, approvals=approvals, regenerated_at=at,
        new_video_sha256=video_ir.file_sha256(tmp_video), new_project_sha256=video_ir.file_sha256(tmp_ir))
    try:
        write_result(out_dir, result.to_metadata(), strict=True)
    except OSError as e:
        raise RegenFailed("result_unwritable", f"could not write the regeneration's result ({e}); "
                                               "the new cut was not put in place")

    # 3. The swap: the IR, then the cut. If it does not finish, the previous
    #    take goes back (and the worker would do the same).
    try:
        os.replace(tmp_ir, ir_path)
        os.replace(tmp_video, video_path)
    except OSError as e:
        restore_previous_take(plan.run_dir, req.regen_id)
        raise RegenFailed("swap_failed", f"the new cut could not be put in place ({e}); the previous take was "
                                         "kept")

    run_checkpoint.record_stage(plan.slug, scene_repair.STAGE_REPAIR, root=root,
                                artifacts={"video": str(video_path), "report": str(out_dir / RESULT_FILENAME)})
    prune_takes(plan.run_dir, project=updated)
    _record_costs(plan, searches, render_seconds,
                  sum(1 for c in clips if c.source == SOURCE_GENERATED))
    return result


def _record_costs(plan, searches: int, render_seconds: float, clips: int) -> None:
    scene_repair._record_costs(plan, searches, render_seconds)
    if not clips:
        return
    try:
        from modules.cost_ledger import CostLedger, VIDEO_GEN_CLIPS
        from modules.state_store import StateStore

        costs = CostLedger(channel_id=plan.channel_id)
        costs.slug = plan.slug
        costs.add(VIDEO_GEN_CLIPS, clips, stage="regenerate_media")
        with StateStore() as store:
            costs.flush(store)
    except Exception as e:
        logger.warning("Could not record regeneration costs (%s: %s)", type(e).__name__, e)


def _check_tools(req: RegenRequest, plan) -> None:
    from modules import render_backend

    exe = render_backend.resolve_ffmpeg()
    if not (Path(exe).is_file() or shutil.which(exe)):
        raise RegenUnavailable("tools_missing", "ffmpeg is not installed on this worker")
    needs_stock = req.source_kind == SOURCE_STOCK or any(
        a is not None and a.source == video_ir.SOURCE_STOCK for a in scene_assets(plan.project, req.scene_id))
    if needs_stock:
        import config

        if not getattr(config, "PEXELS_API_KEY", ""):
            raise RegenUnavailable("stock_unavailable",
                                   "PEXELS_API_KEY is not set on this worker, so no stock footage can be "
                                   "searched. Add it, then press Regenerate again (nothing was charged).")


# ── entry point ─────────────────────────────────────────────────────────────

def cli(*, channel: Optional[str], raw_scene: Optional[str], topic: Optional[str],
        env: Optional[Mapping[str, str]] = None, root: Optional[Path] = None, **inject) -> int:
    """``main.py --regenerate-scene``. Returns an exit code; never raises."""
    from modules import event_log as events

    env = os.environ if env is None else env
    channel_id = str(channel or "default")
    check_tools = inject.pop("check_tools", True)
    out_dir: Optional[Path] = None
    req: Optional[RegenRequest] = None

    def fail(code: str, detail: str, exit_code: int) -> int:
        if out_dir is not None:
            write_result(out_dir, {"version": 1, "ok": False, "regeneration_id": req.regen_id if req else None,
                                   "scene_id": req.scene_id if req else None, "error_code": code,
                                   "error": detail[:500], "published": False})
        return exit_code

    try:
        scene_id = parse_scene(raw_scene)
        req = RegenRequest.from_env(scene_id, env)
        if not topic:
            raise RegenRequestError("--regenerate-scene needs --topic (the run's slug)")
        try:
            plan = scene_repair.preflight(channel_id, (scene_id,), topic=topic, root=root, check_tools=False)
        except scene_repair.RepairUnavailable as e:
            raise RegenUnavailable("run_unavailable", str(e)) from None
        except scene_repair.RepairRequestError as e:
            raise RegenUnavailable("scene_changed", str(e)) from None
        out_dir = regen_dir(plan.run_dir, req.regen_id)
        verify_same_scene(plan.project, req)
        check_disk(plan.run_dir, free_fn=inject.pop("disk_free", None))
        if check_tools:
            _check_tools(req, plan)
        if req.source_kind == SOURCE_GENERATED and inject.get("client") is None:
            inject["client"] = open_generator(req, get_client=inject.pop("get_client", None))
        inject.pop("get_client", None)
    except RegenRequestError as e:
        logger.error("Regeneration refused: %s", e)
        print(f"\n⛔ Regeneration refused: {e}")
        return EXIT_BAD_REQUEST
    except RegenUnavailable as e:
        logger.error("Cannot regenerate (nothing was spent): %s", e)
        print(f"\n⛔ Cannot regenerate (nothing was spent): {e}")
        events.emit(events.REPAIR_FAILED, agent="scene_regenerate", status=events.STATUS_FAILED,
                    channel_id=channel_id, metadata={"stage": "preflight", "code": e.code,
                                                     "regeneration_id": req.regen_id if req else None})
        return fail(e.code, str(e), EXIT_UNAVAILABLE)
    except Exception as e:
        logger.error("Regeneration preflight errored (%s: %s)", type(e).__name__, e)
        print(f"\n⛔ Regeneration preflight errored ({type(e).__name__}); nothing was spent.")
        return fail("preflight_error", type(e).__name__, EXIT_UNAVAILABLE)

    events.emit(events.REPAIR_STARTED, agent="scene_regenerate", status=events.STATUS_RUNNING,
                channel_id=channel_id, metadata={"slug": plan.slug, "scene_ids": [req.scene_id],
                                                 "regeneration_id": req.regen_id,
                                                 "source_kind": req.source_kind,
                                                 "explicit_stock": req.explicit_stock})
    try:
        result = regenerate(plan, req, root=root, **inject)
    except (RegenFailed, RegenUnavailable) as e:
        logger.error("Regeneration failed (%s): %s", e.code, e)
        print(f"\n⛔ Regeneration failed — the previous take was kept: {e}")
        events.emit(events.REPAIR_FAILED, agent="scene_regenerate", status=events.STATUS_FAILED,
                    channel_id=channel_id, metadata={"stage": "regenerate", "slug": plan.slug,
                                                     "code": e.code, "regeneration_id": req.regen_id})
        _prune_after_failure(plan)
        return fail(e.code, str(e), EXIT_UNAVAILABLE if isinstance(e, RegenUnavailable) else EXIT_FAILED)
    except Exception as e:
        _prune_after_failure(plan)
        reason = f"{type(e).__name__}: {e}"[:400]
        logger.error("Regeneration failed: %s", reason)
        events.emit(events.REPAIR_FAILED, agent="scene_regenerate", status=events.STATUS_FAILED,
                    channel_id=channel_id, metadata={"stage": "regenerate", "slug": plan.slug,
                                                     "code": "failed", "regeneration_id": req.regen_id})
        return fail("failed", reason, EXIT_FAILED)

    meta = result.to_metadata()
    events.emit(events.REPAIR_COMPLETED, agent="scene_regenerate", status=events.STATUS_COMPLETED,
                channel_id=channel_id, metadata=meta)
    events.emit(events.PUBLISH_HELD, agent="scene_regenerate", status=events.STATUS_COMPLETED,
                channel_id=channel_id, metadata={"reason": "repaired_awaiting_review", "slug": plan.slug,
                                                 "scene_ids": [req.scene_id]})
    scene_repair._record_repaired_row(plan, scene_repair.RepairResult(
        slug=plan.slug, video_path=result.video_path, scene_ids=(req.scene_id,),
        repaired_at=result.regenerated_at))
    print(f"\n⏸ Regenerated {req.scene_id} — the new cut is held for review (previous approval "
          f"invalidated, previous take kept, nothing uploaded): {result.video_path}")
    return EXIT_OK


def _prune_after_failure(plan) -> None:
    """Failed takes count toward the bound too (BR-L-027). This one is the
    newest, so it keeps its master for the worker's restore."""
    try:
        prune_takes(plan.run_dir, project=video_ir.load(plan.run_dir / video_ir.PROJECT_FILENAME))
    except Exception as e:  # never in the way of reporting the failure
        logger.warning("Regeneration: could not prune old takes (%s)", type(e).__name__)


def read_result(output_dir: Path, slug: str, regen_id: str) -> Optional[dict]:
    """The worker's read of ``result.json`` — only from inside the run's own
    directory, by validated slug and id. None when absent or unreadable."""
    if not re.match(r"^[a-z0-9][a-z0-9-]{0,63}$", slug or "") or not _UUID_RE.match(regen_id or ""):
        return None
    path = Path(output_dir) / slug / REGEN_DIRNAME / regen_id / RESULT_FILENAME
    try:
        if path.is_symlink() or not path.is_file() or path.stat().st_size > 65536:
            return None
        body = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return body if isinstance(body, dict) else None

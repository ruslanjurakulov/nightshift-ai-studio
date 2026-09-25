"""Targeted scene repair (roadmap Y8 / PR 2.3).

QC (``video_qc``) and the critic (``video_critic``) point at *scenes*: a black
run inside ``s003``, a text/visual mismatch in ``s017``. Until now the only fix
was a whole new video — a new script, new narration, new footage, a new render.
This module repairs just the named scenes of an existing run:

    python main.py --channel <id> --repair-scenes "3,17"      # or "s003,s017"

1. **Find the run.** The channel's newest unfinished run (``--topic`` picks one
   by topic), through its checkpoint. A published run cleared its checkpoint and
   cannot be repaired — nothing here goes looking elsewhere for one.
2. **Preflight — before any network call.** The run's Video IR
   (``project.json``), its narration audio, its subtitles, its saved script,
   and every asset of every scene that is NOT being repaired must be on disk;
   every scene must have measured times; ffmpeg and a Pexels key must exist.
   Anything missing is a :class:`RepairUnavailable` that names the remedy, and
   the run stops having spent nothing.
3. **Re-fetch footage only for the named scenes.** Stock (Pexels) search with
   the scene's own script keywords, excluding every clip the run already has,
   so the replacement is new footage. The other scenes keep their assets,
   byte for byte (their IR entries are untouched).
4. **Re-render through the scene cache** (``scene_render.render_project``).
   A repaired scene's assets changed, so its cache key changed and it renders;
   a kept scene is a cache hit when its scene file is still on disk, and is
   re-rendered from its unchanged assets when it is not. Then reassemble.
5. **Measure** the new cut (``video_qc``) — free, local.
6. **Hold it for review.** A repair run never uploads, publishes or changes a
   video's privacy. It invalidates the approvals the previous cut had
   (:func:`invalidate_approvals`): an ``approved`` review state on this run's
   ``videos`` rows goes back to ``pending``, unconsumed ``approve`` intents are
   consumed as superseded, and the repair time is recorded on the checkpoint
   so ``publish_approval.has_approved`` ignores any two-person approval decided
   before it (``repaired_at``). The publish gate is not evaluated here: the
   repaired cut is published by nothing in this run, and whatever publishes it
   later runs the gate itself. Nothing is claimed as "passed".

What a repair spends: Pexels searches (a free, rate-limited API — counted on
the cost ledger like every other search) and local CPU. No script, voice,
generated-media or vision call is made. A scene that originally used AI
b-roll gets *stock* replacement footage; that is recorded per scene in the
report (``previous_sources``) and the cut goes to a human anyway.

Nothing here raises into the pipeline: :func:`cli` catches everything and
returns an exit code (0 repaired and held, 2 bad request, 3 cannot repair this
run, 4 the repair itself failed), so the workflow fails visibly and clearly.
"""

from __future__ import annotations

import json
import logging
import math
import re
import sys
import time
from dataclasses import dataclass, field, replace
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable, Dict, Iterable, List, Mapping, Optional, Sequence, Tuple

from modules import video_ir

logger = logging.getLogger(__name__)

#: At most this many scenes per repair. A repair is a targeted fix; asking for
#: more than a handful is a new video, and the cap bounds what one dispatch can
#: search, download and render.
MAX_REPAIR_SCENES = 5
#: The raw input is refused beyond this length, before it is even split.
MAX_INPUT_CHARS = 120
#: Replacement footage per scene: enough to fill it at its cut interval, capped.
MAX_ASSETS_PER_SCENE = 4
#: Search terms tried per repaired scene (each is one Pexels API search per kind).
MAX_KEYWORDS_PER_SCENE = 3

#: Checkpoint stage a repair records (``{"at": iso, "artifacts": {...}}``).
STAGE_REPAIR = "repair"
REPORT_FILENAME = "repair.json"
FINAL_VIDEO = "final_video.mp4"

EXIT_OK = 0
EXIT_BAD_REQUEST = 2
EXIT_UNAVAILABLE = 3
EXIT_FAILED = 4

# One token: a scene index ("3", "17") or a scene id ("s003"). Nothing else —
# no ranges, no spaces inside a token, no signs, no path characters.
_INDEX_RE = re.compile(r"^\d{1,4}$")
_ID_RE = re.compile(r"^s\d{3,4}$")
_SLUG_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,63}$")
# YouTube video ids, for the PostgREST in.() filter we build from them.
_VIDEO_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")

REPAIR_KIT_HINT = (
    "This runner does not have the run's media. On GitHub-hosted runners a run's "
    "footage and narration do not survive the job unless the repo VARIABLE "
    "CHRONOS_REPAIR_KIT is set to true BEFORE the run that made the video (it keeps "
    "the newest unfinished run's media for 7 days). Otherwise repair on the machine "
    "that made the video, or start a new video."
)


class RepairRequestError(ValueError):
    """The ``repair_scenes`` input is malformed or names scenes that do not exist."""


class RepairUnavailable(RuntimeError):
    """This run cannot be repaired here. Raised before anything is spent."""


class RepairFailed(RuntimeError):
    """The repair started and could not finish (no footage found, render failed)."""


# ── input ───────────────────────────────────────────────────────────────────

def parse_repair_scenes(raw: Optional[str], *, max_count: int = MAX_REPAIR_SCENES) -> Tuple[str, ...]:
    """``"3,17"`` / ``"s003, s017"`` → ``("s003", "s017")``.

    Digits are Video IR scene indexes — the same number as the id (``3`` is
    ``s003``, the fourth scene; the Storyboard shows each scene's id). Strict:
    only digits or ``sNNN`` ids separated by commas, no empty token, no
    duplicates after normalising, at most ``max_count``. Empty input → ``()``.
    Raises :class:`RepairRequestError` with the reason."""
    if raw is None:
        return ()
    text = str(raw).strip()
    if not text:
        return ()
    if len(text) > MAX_INPUT_CHARS:
        raise RepairRequestError(f"repair_scenes is longer than {MAX_INPUT_CHARS} characters")
    out: List[str] = []
    for token in text.split(","):
        t = token.strip().lower()
        if not t:
            raise RepairRequestError("repair_scenes has an empty entry (e.g. '3,,17' or a trailing comma)")
        if _INDEX_RE.match(t):
            sid = video_ir.scene_id(int(t))
        elif _ID_RE.match(t):
            sid = video_ir.scene_id(int(t[1:]))
        else:
            raise RepairRequestError(
                "repair_scenes accepts only scene indexes or ids separated by commas, "
                "e.g. '3,17' or 's003,s017'")
        if sid not in out:
            out.append(sid)
    if len(out) > max_count:
        raise RepairRequestError(
            f"repair_scenes names {len(out)} scenes; at most {max_count} can be repaired at once "
            "— more than that is a new video")
    return tuple(out)


# ── locating the run ────────────────────────────────────────────────────────

def _slugify(text: str) -> str:
    # main.slugify, repeated so this module never imports main.
    return re.sub(r"[^a-z0-9]+", "-", str(text).lower()).strip("-")[:50]


def _root(root: Optional[Path]) -> Path:
    if root is not None:
        return Path(root)
    from config import OUTPUT_DIR

    return Path(OUTPUT_DIR)


def find_run(channel_id: str, *, topic: Optional[str] = None, root: Optional[Path] = None):
    """The checkpoint of the run to repair: by topic when given, else this
    channel's most recently updated unfinished run. Raises RepairUnavailable."""
    from modules import run_checkpoint

    base = _root(root)
    if topic:
        slug = _slugify(topic)
        cp = run_checkpoint.load(slug, base) if _SLUG_RE.match(slug or "") else None
        if cp is None:
            raise RepairUnavailable(
                f"no saved run for topic {topic!r} on this runner (no checkpoint). A run that "
                "published cleared its checkpoint and cannot be repaired. " + REPAIR_KIT_HINT)
        candidates = [cp]
    else:
        candidates = []
        try:
            children = sorted(base.iterdir()) if base.is_dir() else []
        except OSError:
            children = []
        for child in children:
            if not child.is_dir() or child.is_symlink() or not _SLUG_RE.match(child.name):
                continue
            cp = run_checkpoint.load(child.name, base)
            if cp is not None and not cp.completed and (cp.channel_id or "") == str(channel_id):
                candidates.append(cp)
        if not candidates:
            raise RepairUnavailable(
                f"channel {channel_id!r} has no unfinished run on this runner to repair. "
                "A run that published cleared its checkpoint and cannot be repaired. " + REPAIR_KIT_HINT)
        candidates.sort(key=lambda c: c.updated_at or "", reverse=True)
    cp = candidates[0]
    if cp.completed:
        raise RepairUnavailable(f"run {cp.slug!r} is marked complete; it cannot be repaired")
    if cp.channel_id and cp.channel_id != str(channel_id):
        raise RepairUnavailable(
            f"run {cp.slug!r} belongs to channel {cp.channel_id!r}, not {channel_id!r}")
    return cp


# ── preflight (no network, no spend) ────────────────────────────────────────

def _relocate(path: Optional[str], slug: str, run_dir: Path) -> Optional[str]:
    """An IR path, re-based onto ``run_dir`` when it is not on disk as written
    but its part after ``/<slug>/`` is — a restored repair kit on a runner whose
    workspace path differs. Unchanged otherwise."""
    if not path:
        return path
    p = Path(path)
    if p.exists():
        return path
    parts = p.parts
    if slug in parts:
        i = len(parts) - 1 - parts[::-1].index(slug)
        rest = parts[i + 1:]
        if rest and ".." not in rest:
            candidate = run_dir.joinpath(*rest)
            if candidate.exists():
                return str(candidate)
    return path


def relocate_project(project, run_dir: Path):
    slug = project.slug
    assets = tuple(replace(a, path=_relocate(a.path, slug, run_dir)) for a in project.assets)
    audio = replace(project.audio, path=_relocate(project.audio.path, slug, run_dir))
    return replace(project, assets=assets, audio=audio,
                   subtitles_path=_relocate(project.subtitles_path, slug, run_dir))


@dataclass
class RepairPlan:
    """Everything a repair needs, established before anything is spent."""
    channel_id: str
    slug: str
    topic: str
    run_dir: Path
    project: object            # video_ir.VideoProject, paths relocated
    script: dict               # the saved script.json
    scene_ids: Tuple[str, ...]
    kept_scene_ids: Tuple[str, ...]


def _file(path: Optional[str]) -> bool:
    try:
        return bool(path) and Path(path).is_file()
    except (OSError, ValueError):
        return False


def preflight(channel_id: str, scene_ids: Sequence[str], *, topic: Optional[str] = None,
              root: Optional[Path] = None, check_tools: bool = True) -> RepairPlan:
    """Establish that this run can be repaired, touching only the local disk.
    Raises RepairUnavailable (the run cannot be repaired here) or
    RepairRequestError (a named scene does not exist)."""
    from modules import run_checkpoint

    if not scene_ids:
        raise RepairRequestError("no scenes named to repair")
    base = _root(root)
    cp = find_run(channel_id, topic=topic, root=base)
    run_dir = base / cp.slug

    ir_path = cp.artifact(run_checkpoint.STAGE_PROJECT, "project_json") or str(run_dir / video_ir.PROJECT_FILENAME)
    ir_path = _relocate(ir_path, cp.slug, run_dir)
    if not _file(ir_path):
        raise RepairUnavailable(
            f"run {cp.slug!r} has no Video IR (project.json) on this runner. " + REPAIR_KIT_HINT)
    project = video_ir.load(Path(ir_path))
    if project is None:
        raise RepairUnavailable(f"run {cp.slug!r}: project.json is unreadable")
    problems = project.validate()
    if problems:
        raise RepairUnavailable(f"run {cp.slug!r}: project.json is not a valid Video IR "
                                f"({'; '.join(problems[:3])})")
    if project.channel_id and project.channel_id != str(channel_id):
        raise RepairUnavailable(f"run {cp.slug!r}: its Video IR belongs to channel "
                                f"{project.channel_id!r}, not {channel_id!r}")
    project = relocate_project(project, run_dir)

    known = {s.id for s in project.scenes}
    unknown = [s for s in scene_ids if s not in known]
    if unknown:
        ids = sorted(known)
        span = f"{ids[0]}..{ids[-1]}" if ids else "none"
        raise RepairRequestError(
            f"run {cp.slug!r} has no scene {', '.join(unknown)} (its scenes are {span})")

    if not _file(project.audio.path):
        raise RepairUnavailable(f"run {cp.slug!r}: the narration audio is not on this runner. "
                                + REPAIR_KIT_HINT)
    if project.subtitles_path and not _file(project.subtitles_path):
        # Rendering without them would ship a cut with no captions — a quiet
        # quality drop the reviewer did not ask for.
        raise RepairUnavailable(f"run {cp.slug!r}: its subtitles are not on this runner. "
                                + REPAIR_KIT_HINT)

    missing_scenes = []
    for scene in project.scenes:
        if scene.id in scene_ids:
            continue
        for aid in scene.asset_ids:
            a = project.asset(aid)
            if a is None or not _file(a.path):
                missing_scenes.append(scene.id)
                break
    if missing_scenes:
        # A kept scene whose footage is gone would silently change on
        # re-render (scene_render drops a missing asset). "Keep" means keep.
        shown = ", ".join(missing_scenes[:8]) + ("…" if len(missing_scenes) > 8 else "")
        raise RepairUnavailable(
            f"run {cp.slug!r}: footage of {len(missing_scenes)} scene(s) that are not being "
            f"repaired is not on this runner ({shown}). " + REPAIR_KIT_HINT)

    from modules import scene_render

    try:
        scene_render.scene_windows(project)
    except scene_render.SceneRenderError as e:
        raise RepairUnavailable(f"run {cp.slug!r} cannot be rendered scene by scene: {e}")

    script_path = cp.artifact(run_checkpoint.STAGE_SCRIPT, "script_json") or str(run_dir / "script.json")
    script_path = _relocate(script_path, cp.slug, run_dir)
    try:
        script = json.loads(Path(script_path).read_text(encoding="utf-8"))
        if not isinstance(script, dict):
            raise ValueError("not an object")
    except Exception:
        raise RepairUnavailable(f"run {cp.slug!r}: its saved script.json is missing or unreadable")

    if check_tools:
        import shutil

        from modules import render_backend

        exe = render_backend.resolve_ffmpeg()
        if not (Path(exe).is_file() or shutil.which(exe)):
            raise RepairUnavailable("ffmpeg is not installed on this runner")
        import config

        if not getattr(config, "PEXELS_API_KEY", ""):
            raise RepairUnavailable("PEXELS_API_KEY is not set, so no replacement footage can be "
                                    "searched. Add the secret, then dispatch the repair again.")

    kept = tuple(s.id for s in project.scenes if s.id not in scene_ids)
    return RepairPlan(channel_id=str(channel_id), slug=cp.slug, topic=cp.topic or "",
                      run_dir=run_dir, project=project, script=script,
                      scene_ids=tuple(scene_ids), kept_scene_ids=kept)


# ── replacement footage ─────────────────────────────────────────────────────

def _section(plan: RepairPlan, index: int) -> Mapping:
    sections = plan.script.get("sections") or []
    if 0 <= index < len(sections) and isinstance(sections[index], Mapping):
        return sections[index]
    return {}


def _cut_interval(section: Mapping) -> float:
    try:
        cut = float(section.get("cut_interval") or 0)
    except (TypeError, ValueError):
        cut = 0.0
    return cut if cut > 0 else 5.0


def scene_keywords(plan: RepairPlan, scene) -> List[str]:
    """The scene's own b-roll search terms from the saved script; its name
    and the topic's longer words only when the script has none."""
    section = _section(plan, scene.index)
    kws = [str(k).strip() for k in (section.get("keywords") or []) if str(k).strip()]
    if not kws:
        topic_words = [w for w in (plan.script.get("topic") or plan.topic or "").lower().split()
                       if len(w) > 3][:2]
        kws = [" ".join(topic_words)] if topic_words else []
        if scene.name:
            kws.append(scene.name)
    return list(dict.fromkeys(k for k in kws if k))[:MAX_KEYWORDS_PER_SCENE]


def assets_needed(scene, section: Mapping) -> int:
    dur = scene.duration_s
    if dur is None or dur <= 0:
        return 1
    return max(1, min(MAX_ASSETS_PER_SCENE, int(math.ceil(dur / _cut_interval(section) - 1e-9))))


def used_media_ids(project, fetcher=None) -> set:
    """Every Pexels id the run already has — in the IR and on disk — so no
    replacement is a clip the video already shows."""
    ids = set()
    for a in project.assets:
        if a.path:
            stem = Path(a.path).stem
            if stem.isdigit():
                ids.add(stem)
    for d in (getattr(fetcher, "video_dir", None), getattr(fetcher, "image_dir", None)):
        try:
            for f in Path(d).iterdir() if d else ():
                if f.stem.isdigit():
                    ids.add(f.stem)
        except OSError:
            pass
    return ids


def fetch_replacements(plan: RepairPlan, fetcher) -> Dict[str, List[Path]]:
    """``{scene id: [new asset paths]}`` for every repaired scene. Stock only.
    Raises RepairFailed when a scene gets no new footage at all — a repaired
    scene with nothing in it would be a black placeholder, never a fix."""
    exclude = used_media_ids(plan.project, fetcher)
    out: Dict[str, List[Path]] = {}
    for sid in plan.scene_ids:
        scene = plan.project.scene(sid)
        section = _section(plan, scene.index)
        need = assets_needed(scene, section)
        keywords = scene_keywords(plan, scene)
        if not keywords:
            raise RepairFailed(f"scene {sid} has no search keywords to find new footage with")
        found = list(fetcher.fetch_videos(keywords, count=need, exclude_ids=exclude))
        exclude.update(Path(p).stem for p in found)
        stype = str(section.get("type") or scene.type or "story")
        if len(found) < need and stype == "story":
            # Stills only for story scenes — the hook stays on motion footage,
            # as in both renderers.
            imgs = list(fetcher.fetch_images(keywords, count=need - len(found), exclude_ids=exclude))
            exclude.update(Path(p).stem for p in imgs)
            found += imgs
        if not found:
            raise RepairFailed(f"no new footage found for scene {sid} (searched: {', '.join(keywords)})")
        out[sid] = [Path(p) for p in found]
        logger.info("Repair: scene %s gets %d new asset(s) from %s", sid, len(found), keywords)
    return out


def apply_replacements(project, replacements: Mapping[str, Sequence[Path]],
                       provenance: Optional[Mapping] = None):
    """The project with each repaired scene pointing at its new assets (with
    their provenance and sha256) and every other scene untouched."""
    assets = list(project.assets)
    known = {a.id for a in assets}
    for paths in replacements.values():
        for p in paths:
            aid = video_ir.asset_id(str(p))
            if aid in known:
                continue
            kind = video_ir.ASSET_VIDEO if p.suffix.lower() in (".mp4", ".mov", ".webm", ".mkv", ".avi") \
                else video_ir.ASSET_IMAGE
            ref = video_ir.AssetRef(id=aid, kind=kind, path=str(p), source=video_ir.SOURCE_STOCK,
                                    provider="pexels")
            ref = video_ir._with_provenance(ref, (provenance or {}).get(str(p)))
            digest = video_ir.file_sha256(p)
            if digest is not None:
                ref = replace(ref, sha256=digest)
            assets.append(ref)
            known.add(aid)
    scenes = tuple(
        replace(s, asset_ids=tuple(video_ir.asset_id(str(p)) for p in replacements[s.id]))
        if s.id in replacements else s
        for s in project.scenes)
    return replace(project, scenes=scenes, assets=tuple(assets))


def timeline_from_project(project) -> List[dict]:
    """The audio mixer's timeline shape (``start_ms``/``end_ms`` per scene),
    rebuilt from the IR's measured times, for video_qc's scene mapping."""
    out = []
    for s in sorted(project.scenes, key=lambda s: s.index):
        if s.start_s is None or s.end_s is None:
            continue
        out.append({"name": s.name, "start_ms": int(round(s.start_s * 1000)),
                    "end_ms": int(round(s.end_s * 1000))})
    return out


# ── approvals ───────────────────────────────────────────────────────────────

def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def repaired_at(slug: str, root: Optional[Path] = None) -> Optional[str]:
    """When this run was last repaired (ISO), or None. Never raises. Read by
    main.py so a two-person approval decided before a repair no longer counts."""
    try:
        from modules import run_checkpoint

        cp = run_checkpoint.load(slug, root) if slug else None
        entry = (cp.stages.get(STAGE_REPAIR) if cp is not None else None) or {}
        at = entry.get("at")
        return str(at) if at else None
    except Exception:
        return None


def invalidate_approvals(channel_id: str, slug: str, scene_ids: Iterable[str], *,
                         sync=None) -> dict:
    """Void what approved the previous cut, in Supabase. Best-effort, never raises.

    * ``videos`` rows of this run (channel + slug) that were ``approved`` go
      back to ``pending`` — the approved cut is not the cut that now exists;
    * unconsumed ``approve`` intents on those videos are consumed with the
      outcome ``superseded_by_repair`` (the bot, holding the service key, is the
      only writer of ``consumed_at``; nobody edits an intent's request);
    * unconsumed ``regenerate_scene`` intents for the repaired scenes are
      consumed with the outcome ``repaired``.

    Two-person approvals (``publish_approvals``) are not rewritten — a decision
    is never falsified; ``publish_approval.has_approved`` ignores any decided
    before :func:`repaired_at` instead."""
    result = {"videos_reset": False, "approve_intents_consumed": False,
              "scene_intents_consumed": False, "video_rows": 0}
    try:
        client = sync
        if client is None:
            from modules.supabase_sync import SupabaseSync

            client = SupabaseSync()
        if not getattr(client, "enabled", False):
            result["skipped"] = "supabase_not_configured"
            return result
        rows = client.select("videos", {"channel_id": f"eq.{channel_id}", "slug": f"eq.{slug}",
                                        "select": "video_id,review_state"}) or []
        vids = [str(r.get("video_id")) for r in rows
                if isinstance(r, dict) and _VIDEO_ID_RE.match(str(r.get("video_id") or ""))]
        result["video_rows"] = len(vids)
        if not vids:
            return result
        result["videos_reset"] = client.update(
            "videos",
            {"channel_id": f"eq.{channel_id}", "slug": f"eq.{slug}", "review_state": "eq.approved"},
            {"review_state": "pending"})
        now = _now_iso()
        in_videos = "in.(" + ",".join(vids) + ")"
        result["approve_intents_consumed"] = client.update(
            "review_intents",
            {"video_id": in_videos, "action": "eq.approve", "consumed_at": "is.null"},
            {"consumed_at": now, "outcome": "superseded_by_repair"})
        sids = [s for s in scene_ids if _ID_RE.match(str(s))]
        if sids:
            result["scene_intents_consumed"] = client.update(
                "review_intents",
                {"video_id": in_videos, "action": "eq.regenerate_scene",
                 "scene_id": "in.(" + ",".join(sids) + ")", "consumed_at": "is.null"},
                {"consumed_at": now, "outcome": "repaired"})
    except Exception as e:
        logger.warning("Could not invalidate approvals for %s (%s: %s)", slug, type(e).__name__, e)
        result["error"] = type(e).__name__
    return result


# ── the repair ──────────────────────────────────────────────────────────────

@dataclass
class RepairResult:
    slug: str
    video_path: Path
    scene_ids: Tuple[str, ...]
    rendered: List[str] = field(default_factory=list)
    cache_hits: List[str] = field(default_factory=list)
    new_assets: Dict[str, List[str]] = field(default_factory=dict)
    previous_sources: Dict[str, List[str]] = field(default_factory=dict)
    searches: int = 0
    qc: Optional[dict] = None
    approvals: Optional[dict] = None
    repaired_at: str = ""

    def to_metadata(self) -> dict:
        """Ids and counts only — no paths, nothing from the script."""
        return {"slug": self.slug, "scene_ids": list(self.scene_ids),
                "rendered_scene_ids": list(self.rendered), "cache_hits": len(self.cache_hits),
                "new_asset_ids": self.new_assets, "previous_sources": self.previous_sources,
                "pexels_searches": self.searches, "qc": self.qc,
                "approvals": self.approvals, "gate": "not_evaluated",
                "published": False}


def repair(plan: RepairPlan, *, fetcher=None, render_fn: Optional[Callable] = None,
           qc_fn: Optional[Callable] = None, sync=None, root: Optional[Path] = None) -> RepairResult:
    """Carry out a repair the preflight approved. Raises RepairFailed.

    ``fetcher`` defaults to a ``MediaFetcher`` for the run; ``render_fn`` to
    ``scene_render.render_project``; ``qc_fn`` to ``video_qc.run``; ``sync`` to
    a SupabaseSync — all injectable for tests."""
    from modules import run_checkpoint, scene_render

    project = plan.project
    if fetcher is None:
        from modules.media_fetcher import MediaFetcher

        fetcher = MediaFetcher(plan.slug)
    searches_before = int(getattr(fetcher, "searches_made", 0) or 0)
    try:
        replacements = fetch_replacements(plan, fetcher)
    finally:
        searches = int(getattr(fetcher, "searches_made", 0) or 0) - searches_before
    previous_sources = {}
    for sid in plan.scene_ids:
        srcs = []
        for aid in project.scene(sid).asset_ids:
            a = project.asset(aid)
            srcs.append((a.source or "unknown") if a is not None else "unknown")
        previous_sources[sid] = sorted(set(srcs))
    repaired = apply_replacements(project, replacements, getattr(fetcher, "provenance", None))
    problems = repaired.validate()
    if problems:
        raise RepairFailed("the repaired Video IR is invalid: " + "; ".join(problems[:3]))

    # Record the repair on the checkpoint BEFORE the cut changes: from this
    # moment any two-person approval of the previous cut is void
    # (repaired_at). If the record cannot be written, stop — a repair whose
    # invalidation did not land must not produce a cut.
    if run_checkpoint.record_stage(plan.slug, STAGE_REPAIR, root=root) is None:
        raise RepairFailed("could not record the repair on the run checkpoint, so the previous "
                           "approval could not be invalidated; nothing was re-rendered")

    video_path = plan.run_dir / FINAL_VIDEO
    cut_intervals = {i: _cut_interval(s) for i, s in enumerate(plan.script.get("sections") or [])
                     if isinstance(s, Mapping)}
    started = time.monotonic()
    try:
        rendered = (render_fn or scene_render.render_project)(repaired, video_path,
                                                              cut_intervals=cut_intervals)
    except Exception as e:
        # The previous final_video.mp4 is untouched: assembly writes atomically.
        raise RepairFailed(f"scene render failed ({type(e).__name__}: {e})"[:500])
    render_seconds = time.monotonic() - started
    not_rendered = [s for s in plan.scene_ids if s not in list(rendered.cache_misses)]
    if not_rendered:
        # Cannot happen when the assets changed; if it did, the "repair" would
        # be the old pixels under a new label.
        raise RepairFailed(f"repaired scene(s) {not_rendered} were not re-rendered")

    # Only now, with a new cut on disk, does the IR change on disk.
    ir_path = plan.run_dir / video_ir.PROJECT_FILENAME
    video_ir.save(repaired, ir_path)

    qc_meta = None
    try:
        if qc_fn is None:
            from modules import video_qc

            qc_fn = video_qc.run
        report = qc_fn(video_path, audio_path=repaired.audio.path,
                       timeline=timeline_from_project(repaired))
        to_meta = getattr(report, "to_metadata", None)
        qc_meta = to_meta() if callable(to_meta) else None
    except Exception as e:   # unmeasured is not passed — and it is said
        logger.warning("Repair: QC did not run (%s: %s)", type(e).__name__, e)
        qc_meta = {"not_run": type(e).__name__}

    at = _now_iso()
    result = RepairResult(
        slug=plan.slug, video_path=video_path, scene_ids=plan.scene_ids,
        rendered=list(rendered.cache_misses), cache_hits=list(rendered.cache_hits),
        new_assets={sid: [video_ir.asset_id(str(p)) for p in ps] for sid, ps in replacements.items()},
        previous_sources=previous_sources, searches=max(0, searches), qc=qc_meta, repaired_at=at)

    result.approvals = invalidate_approvals(plan.channel_id, plan.slug, plan.scene_ids, sync=sync)
    report_path = plan.run_dir / REPORT_FILENAME
    artifacts = {"video": str(video_path)}
    try:
        report_path.write_text(json.dumps({"version": 1, "repaired_at": at,
                                           **result.to_metadata()}, indent=2), encoding="utf-8")
        artifacts["report"] = str(report_path)
    except OSError as e:
        logger.warning("Could not write %s (%s)", report_path, e)
    # Re-recorded with its files; the time only moves later (never loosens).
    run_checkpoint.record_stage(plan.slug, STAGE_REPAIR, root=root, artifacts=artifacts)
    _record_costs(plan, searches, render_seconds)
    return result


def _record_costs(plan: RepairPlan, searches: int, render_seconds: float) -> None:
    try:
        from modules.cost_ledger import CostLedger, PEXELS_REQUESTS, RENDER_SECONDS
        from modules.state_store import StateStore

        costs = CostLedger(channel_id=plan.channel_id)
        costs.slug = plan.slug
        costs.add(PEXELS_REQUESTS, searches, stage="repair_media")
        costs.add(RENDER_SECONDS, render_seconds, stage="repair_render")
        with StateStore() as store:
            costs.flush(store)
    except Exception as e:
        logger.warning("Could not record repair costs (%s: %s)", type(e).__name__, e)


# ── entry point ─────────────────────────────────────────────────────────────

def cli(*, channel: Optional[str], raw_scenes: Optional[str], topic: Optional[str] = None,
        root: Optional[Path] = None, **inject) -> int:
    """``main.py --repair-scenes``. Returns an exit code; never raises."""
    from modules import event_log as events

    channel_id = str(channel or "default")
    try:
        scene_ids = parse_repair_scenes(raw_scenes)
        if not scene_ids:
            raise RepairRequestError("no scenes named to repair")
        plan = preflight(channel_id, scene_ids, topic=topic, root=root,
                         check_tools=inject.pop("check_tools", True))
    except RepairRequestError as e:
        logger.error("Repair request refused: %s", e)
        print(f"\n⛔ Repair request refused: {e}")
        return EXIT_BAD_REQUEST
    except RepairUnavailable as e:
        logger.error("Cannot repair: %s", e)
        print(f"\n⛔ Cannot repair (nothing was spent): {e}")
        events.emit(events.REPAIR_FAILED, agent="scene_repair", status=events.STATUS_FAILED,
                    channel_id=channel_id, metadata={"stage": "preflight", "reason": str(e)[:500]})
        return EXIT_UNAVAILABLE
    except Exception as e:
        logger.error("Repair preflight errored (%s: %s)", type(e).__name__, e)
        print(f"\n⛔ Repair preflight errored ({type(e).__name__}); nothing was spent.")
        return EXIT_UNAVAILABLE

    logger.info("Repairing run %r, scene(s) %s; keeping %d scene(s)",
                plan.slug, ", ".join(plan.scene_ids), len(plan.kept_scene_ids))
    events.emit(events.REPAIR_STARTED, agent="scene_repair", status=events.STATUS_RUNNING,
                channel_id=channel_id,
                metadata={"slug": plan.slug, "scene_ids": list(plan.scene_ids)})
    try:
        result = repair(plan, root=root, **inject)
    except Exception as e:
        reason = f"{type(e).__name__}: {e}"[:500]
        logger.error("Repair failed: %s", reason)
        print(f"\n⛔ Repair failed: {reason}")
        events.emit(events.REPAIR_FAILED, agent="scene_repair", status=events.STATUS_FAILED,
                    channel_id=channel_id,
                    metadata={"stage": "repair", "slug": plan.slug,
                              "scene_ids": list(plan.scene_ids), "reason": reason})
        return EXIT_FAILED

    meta = result.to_metadata()
    events.emit(events.REPAIR_COMPLETED, agent="scene_repair", status=events.STATUS_COMPLETED,
                channel_id=channel_id, metadata=meta)
    events.emit(events.PUBLISH_HELD, agent="scene_repair", status=events.STATUS_COMPLETED,
                channel_id=channel_id,
                metadata={"reason": "repaired_awaiting_review", "slug": plan.slug,
                          "scene_ids": list(plan.scene_ids)})
    qc_blocks = (result.qc or {}).get("blocks") if isinstance(result.qc, dict) else None
    logger.info("Repair done: %s re-rendered, %d kept scene(s) from cache; QC blocks: %s. "
                "Held for review — nothing was uploaded.",
                result.rendered, len(result.cache_hits), qc_blocks if qc_blocks is not None else "unknown")
    print(f"\n⏸ Repaired {', '.join(plan.scene_ids)} — the new cut is held for review "
          f"(previous approval invalidated, nothing uploaded): {result.video_path}")
    return EXIT_OK


def _validate_main(argv: Sequence[str]) -> int:
    """``python -m modules.scene_repair validate`` — the workflow's early check,
    reading REPAIR_SCENES / REPAIR_CHANNEL / REPAIR_RESUME from the environment
    (never from argv, so no input is ever re-parsed by a shell). Stdlib only."""
    import os

    raw = os.environ.get("REPAIR_SCENES", "")
    try:
        ids = parse_repair_scenes(raw)
    except RepairRequestError as e:
        print(f"::error::{e}")
        return EXIT_BAD_REQUEST
    if not ids:
        print("No repair requested.")
        return EXIT_OK
    if not os.environ.get("REPAIR_CHANNEL", "").strip():
        print("::error::repair_scenes needs the 'channel' input: a repair targets one channel's run.")
        return EXIT_BAD_REQUEST
    if os.environ.get("REPAIR_RESUME", "").strip().lower() == "true":
        print("::error::repair_scenes and resume are mutually exclusive: a repair already reuses the "
              "saved run. Untick resume.")
        return EXIT_BAD_REQUEST
    print(f"Repair requested for scene(s): {', '.join(ids)}")
    return EXIT_OK


if __name__ == "__main__":
    if len(sys.argv) >= 2 and sys.argv[1] == "validate":
        sys.exit(_validate_main(sys.argv[2:]))
    print("usage: python -m modules.scene_repair validate   (repairs run through main.py --repair-scenes)")
    sys.exit(EXIT_BAD_REQUEST)

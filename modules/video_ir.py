"""Video IR v1 — the one canonical description of a video project.

Roadmap Y1 / PR 1.1. Every stage of the pipeline already produces a piece of
the video — the script's sections, the REAL audio timeline, Director Mode's
shot plan, the channel's Elements, the fetched/generated b-roll — but until
now they only met inside the compositor call. This module assembles them into
one serialisable ``VideoProject`` (written to ``output/<slug>/project.json``)
that later stages (scene-level render, QC, critic, repair, retention mapping)
read instead of re-deriving.

The contract (field names are fixed — other modules code against them; the
JSON Schema twin lives in ``schemas/video_ir.schema.json``)::

    VideoProject { version:1, slug, channel_id, title, width, height, fps,
      audio {path, duration_s}, subtitles_path,
      scenes[] { id, index, name, type, narration, start_s, end_s,
                 shot {recipe, camera, lighting, mood},
                 element_ids[], asset_ids[], claim_ids[] },
      assets[] { id, kind, path, source, provider, url, license, author, model,
                 prompt, task_id, cost_usd, sha256,
                 rights {status: "ok"|"unknown"|"blocked"} } }

Rules this module keeps:

* **Audio is the master clock.** A scene's ``start_s``/``end_s`` come from the
  audio mixer's measured timeline (``start_ms``/``end_ms`` per section), never
  from the script's ``duration_hint``. A section with no timeline entry gets
  ``null`` times, not a guess.
* **null ≠ 0, and nothing is invented.** Unknown provenance (URL, licence,
  author, prompt, cost, hash) stays ``null``; ``rights.status`` is
  ``"unknown"`` until something actually establishes it (PR 1.2 / 4.2).
* **Never raises into the pipeline.** :func:`write_for_run` is best-effort: any
  failure is logged and returns ``None``; the run is unaffected.

Ids: a scene is ``f"s{section_index:03d}"`` (shared with provider_tasks,
video_qc and video_critic). An asset is ``"a_" + sha1(path)[:12]`` — stable
for the same file across runs. An element is ``el_<kind>_<slugified name>``.
"""

from __future__ import annotations

import hashlib
import json
import logging
import math
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterable, List, Mapping, Optional, Sequence

logger = logging.getLogger(__name__)

VERSION = 1
PROJECT_FILENAME = "project.json"
SCHEMA_PATH = Path(__file__).resolve().parent.parent / "schemas" / "video_ir.schema.json"

RIGHTS_OK = "ok"
RIGHTS_UNKNOWN = "unknown"
RIGHTS_BLOCKED = "blocked"
RIGHTS_STATUSES = (RIGHTS_OK, RIGHTS_UNKNOWN, RIGHTS_BLOCKED)

ASSET_VIDEO = "video"
ASSET_IMAGE = "image"
ASSET_AUDIO = "audio"
ASSET_KINDS = (ASSET_VIDEO, ASSET_IMAGE, ASSET_AUDIO)

SOURCE_STOCK = "stock"
SOURCE_GENERATED = "generated"

_VIDEO_SUFFIXES = (".mp4", ".mov", ".avi", ".webm", ".mkv")
_SCENE_ID_RE = re.compile(r"^s\d{3,}$")


def scene_id(section_index: int) -> str:
    """The Video IR scene id for a script section index (``s000``, ``s001``…)."""
    return f"s{int(section_index):03d}"


def asset_id(path) -> str:
    """A stable asset id for a file path."""
    return "a_" + hashlib.sha1(str(path).encode("utf-8")).hexdigest()[:12]


def element_id(kind: str, name: str) -> str:
    """A stable element id from an Elements-library entry's kind and name."""
    slug = re.sub(r"[^a-z0-9]+", "-", str(name or "").lower()).strip("-") or "unnamed"
    return f"el_{str(kind or 'element').lower()}_{slug}"


# ── dataclasses ─────────────────────────────────────────────────────────────

def _opt_str(v) -> Optional[str]:
    if v is None:
        return None
    s = str(v)
    return s if s != "" else None


def _opt_num(v) -> Optional[float]:
    if v is None or isinstance(v, bool):
        return None
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return f if math.isfinite(f) else None


def _str_tuple(v) -> tuple:
    return tuple(str(x) for x in (v or ()) if x is not None and str(x) != "")


@dataclass(frozen=True)
class AudioRef:
    path: Optional[str] = None
    duration_s: Optional[float] = None

    def to_dict(self) -> dict:
        return {"path": self.path, "duration_s": self.duration_s}

    @staticmethod
    def from_dict(d: Optional[Mapping]) -> "AudioRef":
        d = d or {}
        return AudioRef(path=_opt_str(d.get("path")), duration_s=_opt_num(d.get("duration_s")))


@dataclass(frozen=True)
class Shot:
    recipe: Optional[str] = None
    camera: Optional[str] = None
    lighting: Optional[str] = None
    mood: Optional[str] = None

    def to_dict(self) -> dict:
        return {"recipe": self.recipe, "camera": self.camera,
                "lighting": self.lighting, "mood": self.mood}

    @staticmethod
    def from_dict(d: Optional[Mapping]) -> "Shot":
        d = d or {}
        return Shot(recipe=_opt_str(d.get("recipe")), camera=_opt_str(d.get("camera")),
                    lighting=_opt_str(d.get("lighting")), mood=_opt_str(d.get("mood")))


@dataclass(frozen=True)
class Scene:
    id: str
    index: int
    name: str = ""
    type: str = "story"
    narration: str = ""
    start_s: Optional[float] = None
    end_s: Optional[float] = None
    shot: Shot = field(default_factory=Shot)
    element_ids: tuple = ()
    asset_ids: tuple = ()
    claim_ids: tuple = ()

    @property
    def duration_s(self) -> Optional[float]:
        if self.start_s is None or self.end_s is None:
            return None
        return round(self.end_s - self.start_s, 3)

    def to_dict(self) -> dict:
        return {
            "id": self.id, "index": self.index, "name": self.name, "type": self.type,
            "narration": self.narration, "start_s": self.start_s, "end_s": self.end_s,
            "shot": self.shot.to_dict(),
            "element_ids": list(self.element_ids),
            "asset_ids": list(self.asset_ids),
            "claim_ids": list(self.claim_ids),
        }

    @staticmethod
    def from_dict(d: Mapping) -> "Scene":
        index = int(d.get("index") or 0)
        return Scene(
            id=str(d.get("id") or scene_id(index)), index=index,
            name=str(d.get("name") or ""), type=str(d.get("type") or "story"),
            narration=str(d.get("narration") or ""),
            start_s=_opt_num(d.get("start_s")), end_s=_opt_num(d.get("end_s")),
            shot=Shot.from_dict(d.get("shot")),
            element_ids=_str_tuple(d.get("element_ids")),
            asset_ids=_str_tuple(d.get("asset_ids")),
            claim_ids=_str_tuple(d.get("claim_ids")),
        )


@dataclass(frozen=True)
class Rights:
    status: str = RIGHTS_UNKNOWN

    def to_dict(self) -> dict:
        return {"status": self.status}

    @staticmethod
    def from_dict(d: Optional[Mapping]) -> "Rights":
        status = str((d or {}).get("status") or RIGHTS_UNKNOWN)
        return Rights(status=status)


@dataclass(frozen=True)
class AssetRef:
    id: str
    kind: str
    path: Optional[str] = None
    source: Optional[str] = None
    provider: Optional[str] = None
    url: Optional[str] = None
    license: Optional[str] = None
    author: Optional[str] = None
    model: Optional[str] = None
    prompt: Optional[str] = None
    task_id: Optional[str] = None
    cost_usd: Optional[float] = None
    sha256: Optional[str] = None
    rights: Rights = field(default_factory=Rights)

    _STR_FIELDS = ("path", "source", "provider", "url", "license", "author",
                   "model", "prompt", "task_id", "sha256")

    def to_dict(self) -> dict:
        out = {"id": self.id, "kind": self.kind}
        for f in self._STR_FIELDS:
            out[f] = getattr(self, f)
        out["cost_usd"] = self.cost_usd
        out["rights"] = self.rights.to_dict()
        # Schema order: id, kind, path, source, provider, url, license, author,
        # model, prompt, task_id, cost_usd, sha256, rights.
        order = ("id", "kind", "path", "source", "provider", "url", "license", "author",
                 "model", "prompt", "task_id", "cost_usd", "sha256", "rights")
        return {k: out[k] for k in order}

    @staticmethod
    def from_dict(d: Mapping) -> "AssetRef":
        kw = {f: _opt_str(d.get(f)) for f in AssetRef._STR_FIELDS}
        return AssetRef(
            id=str(d.get("id") or ""), kind=str(d.get("kind") or ""),
            cost_usd=_opt_num(d.get("cost_usd")), rights=Rights.from_dict(d.get("rights")),
            **kw,
        )


@dataclass(frozen=True)
class VideoProject:
    slug: str
    channel_id: Optional[str] = None
    title: str = ""
    width: int = 1920
    height: int = 1080
    fps: int = 30
    audio: AudioRef = field(default_factory=AudioRef)
    subtitles_path: Optional[str] = None
    scenes: tuple = ()
    assets: tuple = ()
    version: int = VERSION

    def to_dict(self) -> dict:
        return {
            "version": self.version, "slug": self.slug, "channel_id": self.channel_id,
            "title": self.title, "width": self.width, "height": self.height, "fps": self.fps,
            "audio": self.audio.to_dict(), "subtitles_path": self.subtitles_path,
            "scenes": [s.to_dict() for s in self.scenes],
            "assets": [a.to_dict() for a in self.assets],
        }

    def to_json(self) -> str:
        return json.dumps(self.to_dict(), indent=2, ensure_ascii=False)

    @staticmethod
    def from_dict(d: Mapping) -> "VideoProject":
        return VideoProject(
            version=int(d.get("version") or VERSION),
            slug=str(d.get("slug") or ""),
            channel_id=_opt_str(d.get("channel_id")),
            title=str(d.get("title") or ""),
            width=int(d.get("width") or 0), height=int(d.get("height") or 0),
            fps=int(d.get("fps") or 0),
            audio=AudioRef.from_dict(d.get("audio")),
            subtitles_path=_opt_str(d.get("subtitles_path")),
            scenes=tuple(Scene.from_dict(s) for s in (d.get("scenes") or [])),
            assets=tuple(AssetRef.from_dict(a) for a in (d.get("assets") or [])),
        )

    def validate(self) -> List[str]:
        return validate(self.to_dict())

    def scene(self, sid: str) -> Optional[Scene]:
        return next((s for s in self.scenes if s.id == sid), None)

    def asset(self, aid: str) -> Optional[AssetRef]:
        return next((a for a in self.assets if a.id == aid), None)


# ── validation (hand-written twin of schemas/video_ir.schema.json) ─────────

_PROJECT_KEYS = ("version", "slug", "channel_id", "title", "width", "height", "fps",
                 "audio", "subtitles_path", "scenes", "assets")
_SCENE_KEYS = ("id", "index", "name", "type", "narration", "start_s", "end_s", "shot",
               "element_ids", "asset_ids", "claim_ids")
_SHOT_KEYS = ("recipe", "camera", "lighting", "mood")
_AUDIO_KEYS = ("path", "duration_s")
_ASSET_KEYS = ("id", "kind", "path", "source", "provider", "url", "license", "author",
               "model", "prompt", "task_id", "cost_usd", "sha256", "rights")


def _is_num(v) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)


def _is_int(v) -> bool:
    return isinstance(v, int) and not isinstance(v, bool)


def _keys(obj, keys, where, problems) -> bool:
    if not isinstance(obj, dict):
        problems.append(f"{where} must be an object")
        return False
    for k in keys:
        if k not in obj:
            problems.append(f"{where}.{k} is missing")
    for k in obj:
        if k not in keys:
            problems.append(f"{where}.{k} is not a known field")
    return True


def _nullable(obj, key, pred, kind, where, problems):
    v = obj.get(key)
    if v is not None and not pred(v):
        problems.append(f"{where}.{key} must be {kind} or null")


def _str_list(obj, key, where, problems):
    v = obj.get(key)
    if not isinstance(v, list) or not all(isinstance(x, str) and x for x in v):
        problems.append(f"{where}.{key} must be a list of non-empty strings")


def validate(data: Any) -> List[str]:
    """Problems that make ``data`` (a project dict) not a valid Video IR v1, as
    human-readable strings. Empty list = valid. Pure; touches no disk."""
    problems: List[str] = []
    if not _keys(data, _PROJECT_KEYS, "project", problems):
        return problems
    if data.get("version") != VERSION:
        problems.append(f"project.version must be {VERSION}")
    if not isinstance(data.get("slug"), str) or not data.get("slug"):
        problems.append("project.slug must be a non-empty string")
    _nullable(data, "channel_id", lambda v: isinstance(v, str), "a string", "project", problems)
    if not isinstance(data.get("title"), str):
        problems.append("project.title must be a string")
    for k in ("width", "height", "fps"):
        if not _is_int(data.get(k)) or data.get(k) <= 0:
            problems.append(f"project.{k} must be a positive integer")
    audio = data.get("audio")
    if _keys(audio, _AUDIO_KEYS, "project.audio", problems):
        _nullable(audio, "path", lambda v: isinstance(v, str), "a string", "project.audio", problems)
        _nullable(audio, "duration_s", lambda v: _is_num(v) and v >= 0, "a non-negative number",
                  "project.audio", problems)
    _nullable(data, "subtitles_path", lambda v: isinstance(v, str), "a string", "project", problems)

    asset_ids = set()
    assets = data.get("assets")
    if not isinstance(assets, list):
        problems.append("project.assets must be a list")
        assets = []
    for i, a in enumerate(assets):
        where = f"assets[{i}]"
        if not _keys(a, _ASSET_KEYS, where, problems):
            continue
        aid = a.get("id")
        if not isinstance(aid, str) or not aid:
            problems.append(f"{where}.id must be a non-empty string")
        elif aid in asset_ids:
            problems.append(f"{where}.id {aid!r} is duplicated")
        else:
            asset_ids.add(aid)
        if a.get("kind") not in ASSET_KINDS:
            problems.append(f"{where}.kind must be one of {list(ASSET_KINDS)}")
        for k in ("path", "source", "provider", "url", "license", "author", "model",
                  "prompt", "task_id", "sha256"):
            _nullable(a, k, lambda v: isinstance(v, str), "a string", where, problems)
        _nullable(a, "cost_usd", lambda v: _is_num(v) and v >= 0, "a non-negative number",
                  where, problems)
        rights = a.get("rights")
        if _keys(rights, ("status",), f"{where}.rights", problems):
            if rights.get("status") not in RIGHTS_STATUSES:
                problems.append(f"{where}.rights.status must be one of {list(RIGHTS_STATUSES)}")

    scenes = data.get("scenes")
    if not isinstance(scenes, list):
        problems.append("project.scenes must be a list")
        scenes = []
    seen = set()
    for i, s in enumerate(scenes):
        where = f"scenes[{i}]"
        if not _keys(s, _SCENE_KEYS, where, problems):
            continue
        sid, idx = s.get("id"), s.get("index")
        if not _is_int(idx) or idx < 0:
            problems.append(f"{where}.index must be a non-negative integer")
        if not isinstance(sid, str) or not _SCENE_ID_RE.match(sid):
            problems.append(f"{where}.id must look like 's000'")
        elif _is_int(idx) and sid != scene_id(idx):
            problems.append(f"{where}.id {sid!r} does not match index {idx}")
        if sid in seen:
            problems.append(f"{where}.id {sid!r} is duplicated")
        seen.add(sid)
        for k in ("name", "type", "narration"):
            if not isinstance(s.get(k), str):
                problems.append(f"{where}.{k} must be a string")
        for k in ("start_s", "end_s"):
            _nullable(s, k, lambda v: _is_num(v) and v >= 0, "a non-negative number", where, problems)
        st, en = s.get("start_s"), s.get("end_s")
        if _is_num(st) and _is_num(en) and en < st:
            problems.append(f"{where}.end_s is before start_s")
        shot = s.get("shot")
        if _keys(shot, _SHOT_KEYS, f"{where}.shot", problems):
            for k in _SHOT_KEYS:
                _nullable(shot, k, lambda v: isinstance(v, str), "a string", f"{where}.shot", problems)
        for k in ("element_ids", "asset_ids", "claim_ids"):
            _str_list(s, k, where, problems)
        for aid in s.get("asset_ids") or []:
            if isinstance(aid, str) and aid not in asset_ids:
                problems.append(f"{where}.asset_ids references unknown asset {aid!r}")
    return problems


# ── builder ─────────────────────────────────────────────────────────────────

def _g(obj, *names, default=None):
    """Attribute-or-key access, first present name wins."""
    for n in names:
        if isinstance(obj, Mapping):
            if n in obj and obj[n] is not None:
                return obj[n]
        else:
            v = getattr(obj, n, None)
            if v is not None:
                return v
    return default


def _clean_narration(section) -> str:
    fn = getattr(section, "clean_narration", None)
    if callable(fn):
        try:
            return fn()
        except Exception:
            pass
    return str(_g(section, "narration", default="") or "")


def _kind_for(path: Path) -> str:
    return ASSET_VIDEO if path.suffix.lower() in _VIDEO_SUFFIXES else ASSET_IMAGE


def _planned_placement(section, sec_dur: Optional[float], videos: List[Path],
                       images: List[Path], clip_terms: Optional[Mapping]) -> List[Path]:
    """The clips a section draws its cuts from, in the order both renderers
    take them: videos ranked by relevance to the section's keywords
    (modules/broll_match.py) when both signals exist, stills after them (story
    sections only — the hook stays on motion). One entry per cut until the pool
    wraps, de-duplicated. The MoviePy compositor shuffles stills (and videos
    when it has no keyword signal), so for those this is the planned order, not
    a promise about which still lands where."""
    from modules import broll_match

    if sec_dur is None or sec_dur <= 0:
        return []
    ordered = list(videos)
    keywords = list(_g(section, "keywords", default=[]) or [])
    if keywords and clip_terms:
        cands = [{"path": str(p), "keyword": clip_terms.get(str(p), "")} for p in ordered]
        ordered = [Path(c["path"]) for c in broll_match.rank_clips(cands, keywords)]
    stype = str(_g(section, "section_type", "type", default="story") or "story")
    pool = ordered + (list(images) if stype == "story" else [])
    if not pool:
        return []
    try:
        cut = float(_g(section, "cut_interval", default=5.0) or 5.0)
    except (TypeError, ValueError):
        cut = 5.0
    cuts = max(1, int(math.ceil(sec_dur / (cut if cut > 0 else 5.0) - 1e-9)))
    return list(dict.fromkeys(pool[: min(cuts, len(pool))]))


def build_project(
    *,
    slug: str,
    script,
    timeline: Sequence[Mapping],
    channel_id: Optional[str] = None,
    title: Optional[str] = None,
    width: int = 1920,
    height: int = 1080,
    fps: int = 30,
    audio_path=None,
    audio_duration_s: Optional[float] = None,
    subtitles_path=None,
    shot_plans: Optional[Iterable] = None,
    elements: Optional[Iterable] = None,
    video_paths: Optional[Iterable] = None,
    image_paths: Optional[Iterable] = None,
    clip_terms: Optional[Mapping] = None,
    generated_videos: Optional[Mapping] = None,
    generated_task_ids: Optional[Mapping] = None,
    video_provider: Optional[str] = None,
    video_model: Optional[str] = None,
    generated_images: Optional[Iterable] = None,
    image_provider: Optional[str] = None,
    image_model: Optional[str] = None,
    stock_provider: Optional[str] = "pexels",
) -> VideoProject:
    """Assemble a VideoProject from what the pipeline already has. Pure.

    * ``timeline`` — ``AudioMixer.build``'s section timeline (one entry per
      section, in order, with ``start_ms``/``end_ms``): the master clock.
    * ``shot_plans`` — ``director.plan_video`` output (``section_index``,
      ``recipe``, ``camera_move``, ``lighting``, ``mood``).
    * ``elements`` — the channel's ``elements.Element`` list; each scene gets
      the ids of the elements its narration names.
    * ``video_paths``/``image_paths`` — the b-roll pool; ``clip_terms`` is
      ``MediaFetcher.video_terms`` (path → search keyword).
    * ``generated_videos`` — ``{section_index: path}`` of AI b-roll, with
      ``generated_task_ids`` ``{section_index: task_id}``; ``generated_images``
      the AI stills. Everything else in the pool is stock (``stock_provider``:
      MediaFetcher only searches Pexels).
    """
    sections = list(getattr(script, "sections", None) or [])
    timeline = list(timeline or [])

    # Scene times from the measured audio.
    times: List[tuple] = []
    for i in range(len(sections)):
        start = end = None
        if i < len(timeline):
            try:
                start = round(float(timeline[i]["start_ms"]) / 1000.0, 3)
                end = round(float(timeline[i]["end_ms"]) / 1000.0, 3)
            except (KeyError, TypeError, ValueError):
                start = end = None
        times.append((start, end))

    if audio_duration_s is None and timeline:
        try:
            audio_duration_s = round(float(timeline[-1]["end_ms"]) / 1000.0, 3)
        except (KeyError, TypeError, ValueError):
            audio_duration_s = None

    # Assets: generated clips first (they are the most specific), then stock.
    gen_videos = {int(k): Path(v) for k, v in (generated_videos or {}).items() if v}
    gen_video_set = {str(p) for p in gen_videos.values()}
    task_by_path = {str(gen_videos[k]): str(v) for k, v in (generated_task_ids or {}).items()
                    if k in gen_videos and v}
    gen_image_set = {str(Path(p)) for p in (generated_images or [])}
    videos = [Path(p) for p in (video_paths or [])]
    images = [Path(p) for p in (image_paths or [])]

    assets: dict = {}

    def add_asset(path: Path) -> None:
        key = str(path)
        if key in assets:
            return
        kind = _kind_for(path)
        if key in gen_video_set:
            ref = AssetRef(id=asset_id(key), kind=kind, path=key, source=SOURCE_GENERATED,
                           provider=_opt_str(video_provider), model=_opt_str(video_model),
                           task_id=task_by_path.get(key))
        elif key in gen_image_set:
            ref = AssetRef(id=asset_id(key), kind=kind, path=key, source=SOURCE_GENERATED,
                           provider=_opt_str(image_provider), model=_opt_str(image_model))
        else:
            ref = AssetRef(id=asset_id(key), kind=kind, path=key, source=SOURCE_STOCK,
                           provider=_opt_str(stock_provider))
        assets[key] = ref

    for p in list(gen_videos.values()) + videos + images:
        add_asset(p)

    plans = {}
    for p in shot_plans or []:
        idx = _g(p, "section_index")
        if idx is not None:
            plans[int(idx)] = p

    elements = list(elements or [])
    try:
        from modules import elements as elements_mod
    except Exception:  # pragma: no cover - module is part of the repo
        elements_mod = None

    scenes = []
    for i, section in enumerate(sections):
        start, end = times[i]
        dur = (end - start) if (start is not None and end is not None) else None
        plan = plans.get(i)
        shot = Shot(
            recipe=_opt_str(_g(plan, "recipe")) if plan is not None else None,
            camera=_opt_str(_g(plan, "camera_move", "camera")) if plan is not None else None,
            lighting=_opt_str(_g(plan, "lighting")) if plan is not None else None,
            mood=_opt_str(_g(plan, "mood")) if plan is not None else None,
        )
        el_ids: tuple = ()
        if elements and elements_mod is not None:
            matched = elements_mod.detect(str(_g(section, "narration", default="") or ""), elements)
            el_ids = tuple(dict.fromkeys(element_id(e.kind, e.name) for e in matched))
        placed = _planned_placement(section, dur, videos, images, clip_terms)
        gen = gen_videos.get(i)
        if gen is not None and gen not in placed:
            placed = [gen] + placed  # generated for THIS scene — always tied to it
        scenes.append(Scene(
            id=scene_id(i), index=i,
            name=str(_g(section, "name", default="") or ""),
            type=str(_g(section, "section_type", "type", default="story") or "story"),
            narration=_clean_narration(section),
            start_s=start, end_s=end, shot=shot,
            element_ids=el_ids,
            asset_ids=tuple(asset_id(str(p)) for p in placed),
            # Claim ↔ scene linking is PR 4.1; unknown stays empty.
            claim_ids=(),
        ))

    return VideoProject(
        slug=str(slug), channel_id=_opt_str(channel_id),
        title=str(title if title is not None else (getattr(script, "title", "") or "")),
        width=int(width), height=int(height), fps=int(fps),
        audio=AudioRef(path=_opt_str(audio_path), duration_s=_opt_num(audio_duration_s)),
        subtitles_path=_opt_str(subtitles_path),
        scenes=tuple(scenes), assets=tuple(assets.values()),
    )


# ── persistence ─────────────────────────────────────────────────────────────

def project_path(slug: str, root: Optional[Path] = None) -> Path:
    if root is None:
        from config import OUTPUT_DIR

        root = OUTPUT_DIR
    return Path(root) / slug / PROJECT_FILENAME


def save(project: VideoProject, path: Path) -> Path:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(project.to_json(), encoding="utf-8")
    return path


def load(path: Path) -> Optional[VideoProject]:
    """Read a project.json, or None when missing/unreadable. Never raises."""
    try:
        return VideoProject.from_dict(json.loads(Path(path).read_text(encoding="utf-8")))
    except Exception as e:
        logger.warning("Could not read Video IR %s (%s: %s)", path, type(e).__name__, e)
        return None


def _safe(fn, default=None):
    try:
        return fn()
    except Exception:
        return default


def write_for_run(
    *,
    slug: str,
    script,
    timeline,
    channel_id: Optional[str] = None,
    audio_path=None,
    subtitles_path=None,
    shot_plans=None,
    elements=None,
    video_paths=None,
    image_paths=None,
    clip_terms=None,
    broll=None,
    generated_images=None,
    width: int = 1920,
    height: int = 1080,
    fps: int = 30,
    root: Optional[Path] = None,
) -> Optional[VideoProject]:
    """The pipeline hook: build the project from this run's pieces, write
    ``output/<slug>/project.json`` and record it on the run checkpoint.

    Best-effort — returns the project, or None if anything failed; the failure
    is logged and the run continues exactly as before. Validation problems are
    logged as warnings, never fatal (the IR is advisory until a stage reads it).
    """
    try:
        video_provider = video_model = image_provider = image_model = None
        by_section = task_ids = None
        if broll is not None and getattr(broll, "generated", 0):
            by_section = dict(getattr(broll, "by_section", None) or {})
            task_ids = dict(getattr(broll, "task_ids", None) or {})
            video_model = _opt_str(getattr(broll, "model", None))
            from modules import video_providers

            video_provider = _safe(video_providers.active_provider)
        if generated_images:
            from modules import image_providers

            image_provider = _safe(image_providers.active_provider)
            image_model = _safe(image_providers.active_model)

        project = build_project(
            slug=slug, script=script, timeline=timeline, channel_id=channel_id,
            width=width, height=height, fps=fps,
            audio_path=audio_path, subtitles_path=subtitles_path,
            shot_plans=shot_plans, elements=elements,
            video_paths=video_paths, image_paths=image_paths, clip_terms=clip_terms,
            generated_videos=by_section, generated_task_ids=task_ids,
            video_provider=video_provider, video_model=video_model,
            generated_images=generated_images, image_provider=image_provider,
            image_model=image_model,
        )
        problems = project.validate()
        if problems:
            logger.warning("Video IR has %d problem(s): %s", len(problems), "; ".join(problems[:5]))
        path = save(project, project_path(slug, root))
        logger.info("Video IR written: %s (%d scene(s), %d asset(s))",
                    path, len(project.scenes), len(project.assets))
        try:
            from modules import run_checkpoint

            run_checkpoint.record_stage(slug, run_checkpoint.STAGE_PROJECT,
                                        artifacts={"project_json": str(path)}, root=root)
        except Exception as e:
            logger.warning("Could not checkpoint the Video IR (%s: %s)", type(e).__name__, e)
        return project
    except Exception as e:
        logger.warning("Could not build the Video IR (%s: %s) — the run is unaffected",
                       type(e).__name__, e)
        return None


# ── storyboard bridge ───────────────────────────────────────────────────────

def annotate_scenes(scenes: Optional[list], manifest: Optional[Mapping]) -> Optional[list]:
    """The Storyboard's ``videos.scenes`` list (``Script.scene_plan()``) with each
    entry's REAL ``start_s``/``end_s`` and its IR ``id`` added from the manifest,
    matched by position. Entries without a matching IR scene are returned as
    they were. Never raises; returns the input unchanged on any problem."""
    if not scenes or not manifest:
        return scenes
    try:
        ir = list(manifest.get("scenes") or [])
        out = []
        for i, entry in enumerate(scenes):
            e = dict(entry)
            if i < len(ir) and isinstance(ir[i], Mapping):
                e["id"] = ir[i].get("id")
                e["start_s"] = ir[i].get("start_s")
                e["end_s"] = ir[i].get("end_s")
            out.append(e)
        return out
    except Exception as e:
        logger.warning("Could not annotate scenes with IR timings (%s: %s)", type(e).__name__, e)
        return scenes

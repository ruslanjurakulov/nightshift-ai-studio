"""One pipeline run request → the exact ``main.py`` argv and env the workflow uses.

``.github/workflows/daily_video.yml`` turns its ``workflow_dispatch`` inputs into
a ``python main.py …`` command line (in bash) and a handful of derived env vars
(in the step's ``env:`` block). The queue worker (``tools/queue_worker.py``) has
to run *the same* command for a ``render_jobs`` row, or a video made on the VPS
would quietly differ from one made on Actions — a different privacy, a
provider switched on that was off, a repair that uploads.

This module is that mapping, written once. The workflow keeps its bash (it is
the default path and is not touched), and ``tests/test_queue_worker.py`` reads
the workflow file and fails if a flag or a derivation appears there that is
not mirrored here, so the two cannot drift silently.

Rules carried over verbatim from the workflow:

* privacy is ``params.privacy`` or ``private`` — never anything more open by
  default, and the publish gate / auto-publish / approvals inside main.py decide
  the rest exactly as on Actions;
* ``SCRIPT_LANGUAGE`` is ``English`` (the workflow pins it; ``--language``
  overrides per run);
* a per-run video provider also turns video generation on for that run; a
  per-run image provider other than ``pexels`` turns image generation on; with
  neither, the operator's own env (the repo-variable equivalent) applies;
* repair and resume are mutually exclusive, and a repair needs scenes.

Stdlib only, no side effects: the worker imports it before anything heavy.
"""

from __future__ import annotations

import re
from typing import Dict, List, Mapping, Optional, Tuple

#: Every workflow_dispatch input except ``channel`` (a column on the job).
ALLOWED_PARAMS = (
    "topic", "niche", "privacy", "duration", "language", "visual_style",
    "video_provider", "image_provider", "tts_model", "voice_id", "resume", "repair_scenes",
)
#: The workflow's choice lists (daily_video.yml `options:`).
PRIVACY_CHOICES = ("private", "unlisted", "public")
VIDEO_PROVIDERS = ("minimax", "higgsfield", "kling", "veo", "seedance", "wan")
IMAGE_PROVIDERS = ("pexels", "leonardo", "gpt-image", "nano-banana", "flux", "ideogram", "fal")
TTS_MODELS = ("eleven_v3", "eleven_multilingual_v2", "eleven_flash_v2_5", "eleven_turbo_v2_5")
KINDS = ("daily", "repair")
#: Keys a job may carry that are NOT pipeline inputs (never passed to main.py
#: or its env): the Create page's "Making this for:" account (migration 0029).
HINT_PARAMS = ("publish_hint",)
_HINT_RE = re.compile(r"(youtube|instagram|tiktok):[A-Za-z0-9._-]{1,128}")

_MAX_LEN = {"topic": 300, "niche": 120, "language": 40, "visual_style": 300, "repair_scenes": 120}
_VOICE_RE = re.compile(r"[A-Za-z0-9]{20}")
_CHANNEL_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,63}$")


class InvalidRunRequest(ValueError):
    """The job asks for something the workflow would not accept. Raised before
    anything is spent; the message names the offending input, never a value."""


def validate(channel_id: str, kind: str, params: Optional[Mapping]) -> Dict:
    """Check a job and return its params normalised (strings stripped, empty
    values dropped). Mirrors ``render_job_params_valid`` in migration 0017 and
    the workflow's own repair validation."""
    if not isinstance(channel_id, str) or not _CHANNEL_RE.match(channel_id):
        raise InvalidRunRequest("channel_id is not a valid channel id")
    if kind not in KINDS:
        raise InvalidRunRequest(f"kind must be one of {', '.join(KINDS)}")
    if params is None:
        params = {}
    if not isinstance(params, Mapping):
        raise InvalidRunRequest("params must be an object")
    unknown = sorted(k for k in params if k not in ALLOWED_PARAMS and k not in HINT_PARAMS)
    if unknown:
        raise InvalidRunRequest(f"unknown param(s): {', '.join(unknown)}")

    out: Dict = {}
    for key in ("topic", "niche", "language", "visual_style", "repair_scenes"):
        if key not in params or params[key] is None:
            continue
        value = params[key]
        if not isinstance(value, str):
            raise InvalidRunRequest(f"{key} must be a string")
        value = value.strip()
        if len(value) > _MAX_LEN[key]:
            raise InvalidRunRequest(f"{key} is longer than {_MAX_LEN[key]} characters")
        if value:
            out[key] = value

    if params.get("duration") is not None:
        d = params["duration"]
        if isinstance(d, bool) or not isinstance(d, (int, float)) or d != int(d) or not 30 <= d <= 3600:
            raise InvalidRunRequest("duration must be a whole number of seconds between 30 and 3600")
        out["duration"] = int(d)

    for key, choices in (("privacy", PRIVACY_CHOICES), ("video_provider", VIDEO_PROVIDERS),
                         ("image_provider", IMAGE_PROVIDERS), ("tts_model", TTS_MODELS)):
        value = params.get(key)
        if value is None or value == "":
            continue
        if not isinstance(value, str) or value not in choices:
            raise InvalidRunRequest(f"{key} must be one of {', '.join(choices)}")
        out[key] = value

    voice = params.get("voice_id")
    if voice not in (None, ""):
        if not isinstance(voice, str) or not _VOICE_RE.fullmatch(voice):
            raise InvalidRunRequest("voice_id must be an ElevenLabs voice id (20 letters and digits)")
        out["voice_id"] = voice

    hint = params.get("publish_hint")
    if hint not in (None, ""):
        if not isinstance(hint, str) or not _HINT_RE.fullmatch(hint):
            raise InvalidRunRequest("publish_hint must be <platform>:<account id>")
        out["publish_hint"] = hint

    if params.get("resume") is not None:
        if not isinstance(params["resume"], bool):
            raise InvalidRunRequest("resume must be true or false")
        if params["resume"]:
            out["resume"] = True

    if "repair_scenes" in out:
        # The same strict parser main.py and the workflow's resolve job use.
        from modules.scene_repair import RepairRequestError, parse_repair_scenes
        try:
            parse_repair_scenes(out["repair_scenes"])
        except RepairRequestError as e:
            raise InvalidRunRequest(str(e)) from None
        if out.get("resume"):
            raise InvalidRunRequest("repair_scenes and resume are mutually exclusive")
    if (kind == "repair") != ("repair_scenes" in out):
        raise InvalidRunRequest("a 'repair' job needs repair_scenes, and only a 'repair' job may have them")
    return out


def build_main_args(channel_id: str, params: Mapping) -> List[str]:
    """``main.py`` argv for validated params, in the workflow's order."""
    args = ["--channel", channel_id, "--privacy", params.get("privacy") or "private"]
    if params.get("topic"):
        args += ["--topic", params["topic"]]
    if params.get("niche"):
        args += ["--niche", params["niche"]]
    if params.get("duration"):
        args += ["--duration", str(params["duration"])]
    if params.get("language"):
        args += ["--language", params["language"]]
    if params.get("visual_style"):
        args += ["--visual-style", params["visual_style"]]
    if params.get("resume") is True:
        args += ["--resume"]
    if params.get("repair_scenes"):
        args += ["--repair-scenes", params["repair_scenes"]]
    return args


def build_run_env(params: Mapping, base_env: Mapping[str, str]) -> Dict[str, str]:
    """The run step's derived env, applied over ``base_env`` (the worker's env
    file standing in for repo secrets and variables). Returns a new dict."""
    env: Dict[str, str] = dict(base_env)
    env["YOUTUBE_PRIVACY"] = params.get("privacy") or "private"
    env["SCRIPT_LANGUAGE"] = "English"

    video = params.get("video_provider") or ""
    if video:
        env["CHRONOS_VIDEO_PROVIDER"] = video
        env["CHRONOS_ENABLE_VIDEO_GEN"] = "true"
    image = params.get("image_provider") or ""
    if image:
        env["CHRONOS_IMAGE_PROVIDER"] = image
        if image != "pexels":
            env["CHRONOS_ENABLE_IMAGE_GEN"] = "true"
    tts_model = params.get("tts_model") or ""
    if tts_model:
        env["ELEVENLABS_MODEL_ID"] = tts_model
    voice_id = params.get("voice_id") or ""
    if voice_id:
        env["ELEVENLABS_RUN_VOICE_ID"] = voice_id
    return env


# ── scene regeneration v2 (migration 0076) ──────────────────────────────────
#: The terms of a priced scene regeneration, handed to main.py in its env —
#: never argv, so a prompt is never parsed as a flag. modules/scene_regenerate
#: validates them again (RegenRequest.from_env).
REGEN_ENV = ("SCENE_REGEN_ID", "SCENE_REGEN_SOURCE", "SCENE_REGEN_PROVIDER", "SCENE_REGEN_MODEL",
             "SCENE_REGEN_PROMPT", "SCENE_REGEN_EXPLICIT_STOCK", "SCENE_REGEN_PREVIOUS_ASSETS",
             "SCENE_REGEN_GENERATED_CLIPS", "SCENE_REGEN_STOCK_ASSETS")
_ASSET_ID_RE = re.compile(r"^[A-Za-z0-9_.:-]{1,64}$")
_UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
_SLUG_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,63}$")


def build_regenerate_args(channel_id: str, params: Mapping) -> List[str]:
    """``main.py`` argv for a regeneration's repair job: always private, the
    run named by its slug (params.topic), exactly one scene, never resume."""
    slug = str(params.get("topic") or "")
    scene = str(params.get("repair_scenes") or "")
    if not _SLUG_RE.match(slug):
        raise InvalidRunRequest("a scene regeneration names its run by slug (topic)")
    if not re.fullmatch(r"s\d{3,4}", scene):
        raise InvalidRunRequest("a scene regeneration names exactly one scene id")
    if params.get("resume"):
        raise InvalidRunRequest("a scene regeneration never resumes a run")
    return ["--channel", channel_id, "--privacy", "private", "--topic", slug, "--regenerate-scene", scene]


def build_regenerate_env(terms: Mapping, params: Mapping, base_env: Mapping[str, str]) -> Dict[str, str]:
    """The run env for a regeneration: the base run env (private, no provider
    switched on by a param) plus the frozen terms of the press. Refuses terms
    that do not belong to this job."""
    rid = str(terms.get("id") or "")
    if not _UUID_RE.match(rid):
        raise InvalidRunRequest("the scene regeneration has no valid id")
    if terms.get("scene_id") != params.get("repair_scenes") or terms.get("slug") != params.get("topic"):
        raise InvalidRunRequest("the scene regeneration's scene or run is not this job's")
    env = build_run_env({}, base_env)
    for key in REGEN_ENV:
        env.pop(key, None)
    env["SCENE_REGEN_ID"] = rid
    env["SCENE_REGEN_SOURCE"] = str(terms.get("source_kind") or "")
    if terms.get("provider"):
        env["SCENE_REGEN_PROVIDER"] = str(terms["provider"])
    if terms.get("model"):
        env["SCENE_REGEN_MODEL"] = str(terms["model"])
    if terms.get("prompt"):
        env["SCENE_REGEN_PROMPT"] = str(terms["prompt"])
    env["SCENE_REGEN_EXPLICIT_STOCK"] = "true" if terms.get("explicit_stock") is True else "false"
    # What was priced (BR-L-030): the run refuses a scene on disk that is not
    # exactly this, before anything is spent.
    ids = terms.get("previous_asset_ids")
    if not isinstance(ids, list) or not ids or len(ids) > 8 \
            or not all(isinstance(i, str) and _ASSET_ID_RE.match(i) for i in ids):
        raise InvalidRunRequest("the scene regeneration does not name the priced scene's assets")
    counts = {}
    for key in ("generated_clips", "stock_assets"):
        v = terms.get(key)
        if isinstance(v, bool) or not isinstance(v, int) or not 0 <= v <= 8:
            raise InvalidRunRequest("the scene regeneration's priced clip counts are missing")
        counts[key] = v
    env["SCENE_REGEN_PREVIOUS_ASSETS"] = ",".join(ids)
    env["SCENE_REGEN_GENERATED_CLIPS"] = str(counts["generated_clips"])
    env["SCENE_REGEN_STOCK_ASSETS"] = str(counts["stock_assets"])
    return env


def plan_run(channel_id: str, kind: str, params: Optional[Mapping],
             base_env: Mapping[str, str]) -> Tuple[List[str], Dict[str, str], Dict]:
    """validate + args + env in one call: ``(argv, env, normalised_params)``."""
    clean = validate(channel_id, kind, params)
    return build_main_args(channel_id, clean), build_run_env(clean, base_env), clean


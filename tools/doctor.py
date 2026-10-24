#!/usr/bin/env python3
"""Readiness check for the video pipeline - read-only, no paid call, no state change.

Run it where the worker runs, so it sees the environment the worker really has:

    docker compose --env-file /opt/nightshift/.env.web -f deploy/docker-compose.yml \\
        --profile worker exec worker python tools/doctor.py          # human report
    ... exec worker python tools/doctor.py --json                    # machine report
    ... exec worker python tools/doctor.py --offline                 # config + host only: never "ready"
    python tools/doctor.py --github                                  # repo-side view (needs a token)

Every line is PASS, WARN or FAIL (plus UNVERIFIED / SKIP for things that cannot
be proven for free) and every non-pass line ends with the exact next step.

What it does and does not do
* Requested vs effective configuration (CLAUDE.md #4): a switch that is on while
  the key it needs is empty would silently run on stock footage / a free voice;
  that is reported as a FAIL here instead of at the end of a paid run.
* Secrets: only "set" / "missing" and a shape verdict in words. Never a value,
  a prefix, a length or a response body. All output also passes a scrubber.
* Network: only GET requests, 10 s each, no retries, redirects never followed.
  One check per provider (ElevenLabs adds one GET per configured voice; the
  Supabase checks are a handful of ``limit=0`` reads), only on endpoints that are
  free: ElevenLabs subscription and voices, Leonardo /me, Pexels search, Gemini's
  ``GET models/{model}``, Supabase REST. The one POST is the YouTube OAuth token
  refresh (free, in memory, nothing is saved), made once for the default channel's
  token and once for each other scheduled operator channel's. Providers with no such endpoint
  are reported UNVERIFIED, never PASS; the one the config selects counts as WARN.
* A value read from a free-text variable (provider ids, model names) is echoed
  only if it is a known id; anything else is "an unrecognised value", so a key
  pasted into the wrong variable cannot leak through a message.
* Nothing is written: no file, no database row, no GitHub setting.

Exit code: 0 ready, 1 at least one FAIL, 2 warnings only, nothing checked, or
``--offline`` (config only: the network checks that make "ready" true were skipped).
``preflight_summary()`` is the cheap offline subset a run start can call.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import sys
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Dict, List, Mapping, NamedTuple, Optional, Sequence, Tuple

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from modules import pipeline_pause  # noqa: E402 - stdlib only; the scheduler's and the bot's reading of the pause

PASS, WARN, FAIL, UNVERIFIED, SKIP = "PASS", "WARN", "FAIL", "UNVERIFIED", "SKIP"
_TAGS = {PASS: "[PASS]", WARN: "[WARN]", FAIL: "[FAIL]", UNVERIFIED: "[ -- ]", SKIP: "[SKIP]"}

TIMEOUT = 10
_TRUE = ("1", "true", "yes", "on")
#: ~15 characters of narration per second (audit section d) -> per minute.
CHARS_PER_MINUTE = 15 * 60
MIN_FREE_GB = 5
YOUTUBE_TOKEN_URI = "https://oauth2.googleapis.com/token"  # fixed: never the URI inside a secret
#: How many scheduled channels' tokens the scheduled workflow hands the doctor (DOCTOR_CHANNEL_TOKEN_0..N-1, named
#: by the resolver job): Actions cannot enumerate secrets, so each is read by an explicit name. The workflow's
#: slot count and `--token-slots` are pinned to this number by a test; a channel beyond it is reported unchecked.
CHANNEL_TOKEN_SLOTS = 6
CHANNEL_TOKEN_ROWS_ENV = "DOCTOR_CHANNEL_TOKEN_ROWS"
_TOKEN_SECRET_NAME = re.compile(r"CHRONOS_YT_TOKEN_[A-Z0-9_]+")


@dataclass
class Check:
    group: str
    name: str
    status: str
    detail: str
    fix: str = ""


class Resp(NamedTuple):
    status: Optional[int]
    data: Any = None
    headers: Mapping = {}


class Http:
    """The only network primitive. Exceptions are swallowed into ``status=None``
    (a requests error quotes the URL); a body is parsed as JSON or dropped."""

    def __init__(self, timeout: float = TIMEOUT):
        self.timeout = timeout

    def _wrap(self, fn) -> Resp:
        try:
            r = fn()
        except Exception:
            return Resp(None)
        try:
            data = r.json()
        except ValueError:
            data = None
        return Resp(r.status_code, data, dict(r.headers or {}))

    def get(self, url: str, headers: Optional[dict] = None, params: Optional[dict] = None) -> Resp:
        import requests  # noqa: PLC0415 - keep --help import-light

        return self._wrap(lambda: requests.get(url, headers=headers or {}, params=params,
                                               timeout=self.timeout, allow_redirects=False))

    def post_form(self, url: str, data: dict) -> Resp:
        import requests  # noqa: PLC0415

        return self._wrap(lambda: requests.post(url, data=data, timeout=self.timeout,
                                                allow_redirects=False))

    def post_json(self, url: str, body: dict, headers: Optional[dict] = None) -> Resp:
        import requests  # noqa: PLC0415

        return self._wrap(lambda: requests.post(url, json=body, headers=headers or {}, timeout=self.timeout,
                                                allow_redirects=False))


@dataclass
class Ctx:
    env: Mapping[str, str]
    http: Any
    now: datetime
    root: Path = ROOT
    output_dir: Optional[Path] = None
    free_fn: Optional[Callable[[Path], int]] = None
    which: Callable[[str], Optional[str]] = shutil.which
    cache_home: Optional[Path] = None
    preflight_video: Optional[Callable[[], None]] = None
    youtube: bool = True
    #: The scheduled operator channels whose token the doctor proves: a callable returning
    #: ``[{"channel_id", "token_secret"}, ...]`` (tools/list_channels.token_rows). None = not asked.
    channel_rows: Optional[Callable[[], List[dict]]] = None

    def get(self, name: str) -> str:
        return str(self.env.get(name, "") or "").strip()

    def on(self, name: str) -> bool:
        return self.get(name).lower() in _TRUE

    def has(self, name: str) -> bool:
        return bool(self.get(name))


# -- the vocabulary: which switch / key belongs to which provider -------------

VIDEO_KEYS: Dict[str, Tuple[Tuple[str, ...], ...]] = {
    # provider -> alternatives; each alternative is the set of names that must ALL be set
    "minimax": (("MINIMAX_API_KEY",),),
    "kling": (("KLING_API_KEY",), ("KLING_ACCESS_KEY", "KLING_SECRET_KEY")),
    "veo": (("VEO_API_KEY",),),
    "seedance": (("SEEDANCE_API_KEY",),),
    "wan": (("WAN_API_KEY",),),
    "higgsfield": (("HIGGSFIELD_API_KEY",),),
}
IMAGE_KEYS = {
    "leonardo": "LEONARDO_API_KEY", "gpt-image": "OPENAI_API_KEY", "nano-banana": "GEMINI_API_KEY",
    "flux": "BFL_API_KEY", "ideogram": "IDEOGRAM_API_KEY", "fal": "FAL_KEY",
}
#: Keys whose shape is checked (presence is reported by their own group).
SHAPE_KEYS = (
    "GEMINI_API_KEY", "PEXELS_API_KEY", "ELEVENLABS_API_KEY", "SUPABASE_SERVICE_KEY",
    "MINIMAX_API_KEY", "KLING_API_KEY", "KLING_ACCESS_KEY", "KLING_SECRET_KEY", "VEO_API_KEY",
    "SEEDANCE_API_KEY", "WAN_API_KEY", "HIGGSFIELD_API_KEY", "HIGGSFIELD_API_KEY_ID",
    "HIGGSFIELD_API_KEY_SECRET", "LEONARDO_API_KEY", "OPENAI_API_KEY", "BFL_API_KEY",
    "IDEOGRAM_API_KEY", "FAL_KEY", "RUNWAYML_API_SECRET", "LUMA_AGENTS_API_KEY",
    "VIDIQ_ACCESS_TOKEN", "GOOGLE_OAUTH_CLIENT_ID", "GOOGLE_OAUTH_CLIENT_SECRET",
)
JSON_KEYS = ("YOUTUBE_CLIENT_SECRET_JSON", "YOUTUBE_TOKEN_JSON")
VOICE_ID = re.compile(r"[A-Za-z0-9]{20}")
SAFE_WORD = re.compile(r"[a-z_]{1,40}")

#: Providers with a key but no free authenticated endpoint in this repository.
UNVERIFIED_PROVIDERS = (
    ("MINIMAX_API_KEY", "minimax"), ("KLING_API_KEY", "kling"), ("KLING_ACCESS_KEY", "kling"),
    ("VEO_API_KEY", "veo"), ("SEEDANCE_API_KEY", "seedance"), ("WAN_API_KEY", "wan"),
    ("HIGGSFIELD_API_KEY", "higgsfield"), ("OPENAI_API_KEY", "openai"), ("BFL_API_KEY", "flux (bfl)"),
    ("IDEOGRAM_API_KEY", "ideogram"), ("FAL_KEY", "fal"), ("RUNWAYML_API_SECRET", "runway"),
    ("LUMA_AGENTS_API_KEY", "luma"), ("VIDIQ_ACCESS_TOKEN", "vidiq"),
)

#: (migration, table, columns that migration added or created)
MIGRATION_PROBES = (
    ("0016", "videos", "publish_state,held_at,hold_detail"),
    ("0017", "render_jobs", "id,status,heartbeat_at,attempts"),
    ("0020", "render_jobs", "credit_ref"),
    ("0020", "credit_prices", "unit,credits_per_unit,margin"),
    ("0020", "credit_reservations", "job_id,status"),
    ("0012", "provider_balances", "provider,remaining"),
    ("0045", "worker_status", "worker_id,state,updated_at"),
    ("0106", "video_costs", "row_key"),
)
REQUIRED_PRICES = ("video_minute", "job_minimum")
UNIT_PRICES = ("tts_characters", "video_gen_clips", "image_generations",
               "gemini_input_tokens", "gemini_output_tokens", "render_seconds")


def _fix_env(names: str) -> str:
    return (f"set {names} in GitHub (Settings > Secrets and variables > Actions; keys are Secrets, "
            "switches are Variables), then run Actions > 'Deploy web' so the worker gets it")


UNRECOGNISED = "an unrecognised value"
_MODEL_ID = re.compile(r"(?:MiniMax-[A-Za-z0-9.]{1,20}(?:-[A-Za-z0-9.]{1,12}){0,2}|gemini-[a-z0-9.]{1,20}(?:-[a-z0-9.]{1,12}){0,5})")
#: Free-text variables whose value is read by the checks. Their values are never
#: echoed unless they are a known id, and the scrubber removes them from all output.
FREE_TEXT_VARS = ("CHRONOS_VIDEO_PROVIDER", "CHRONOS_IMAGE_PROVIDER", "TTS_PROVIDER", "MINIMAX_H3_MODEL",
                  "GEMINI_MODEL", "GEMINI_MODEL_TOPIC", "GEMINI_MODEL_RESEARCH", "GEMINI_MODEL_SCRIPT",
                  "GEMINI_MODEL_FACTCHECK", "GEMINI_MODEL_GROUNDING", "GEMINI_MODEL_PACKAGING", "GEMINI_MODEL_OTHER",
                  "CHRONOS_IMAGE_MODEL", "ELEVENLABS_MODEL_ID", "WAN_WORKSPACE_ID",
                  "MINIMAX_V2_QUERY_PATH")


def known_id(value: str, allowed: Sequence[str] = ()) -> str:
    """``value`` if it is one of the known ids (or a model id of a known family),
    else a fixed phrase. A key pasted into the wrong variable therefore never
    reaches a message."""
    if value in allowed or (not allowed and _MODEL_ID.fullmatch(value)):
        return value
    return UNRECOGNISED


def _exc_summary(e: BaseException) -> str:
    """The class name and the pipeline's own 'Fix:' sentence, with every quoted
    string and long token-shaped run masked - never the whole message, which
    quotes the configured model id verbatim."""
    text = " ".join(str(e).split())
    fix = text.split("Fix:", 1)[1].strip() if "Fix:" in text else ""
    fix = re.sub(r"'[^']*'|\"[^\"]*\"", "<value>", fix)
    fix = re.sub(r"[A-Za-z0-9_\-.]{24,}", "<value>", fix)[:200]
    return type(e).__name__ + (f": {fix}" if fix else "")


def _load_json(raw: str):
    """(object, ok). Deeply nested input (RecursionError) is just 'not valid JSON'."""
    try:
        return json.loads(raw), True
    except (ValueError, RecursionError):
        return None, False


# -- layer 1: configuration, no network ---------------------------------------

def shape_problem(name: str, value: str) -> Optional[str]:
    """A verdict in words about how a value is written - never the value itself."""
    if not value:
        return None
    if re.search(r"[\r\n]", value):
        return "contains a line break"
    if re.search(r"\s", value):
        return "contains whitespace"
    if value[0] in "'\"" or value[-1] in "'\"":
        return "is wrapped in quotes"
    if "$" in value and name not in JSON_KEYS:
        return 'contains "$"'
    if value.lower().startswith("bearer "):
        return 'starts with "Bearer " (store the bare key)'
    return None


def check_shapes(ctx: Ctx) -> List[Check]:
    bad: List[str] = []
    for name in SHAPE_KEYS:
        problem = shape_problem(name, ctx.env.get(name, "") or "")
        if problem:
            bad.append(f"{name} {problem}")
    for name in JSON_KEYS:
        raw = ctx.env.get(name, "") or ""
        if raw.strip():
            parsed, ok = _load_json(raw)
            if not ok:
                bad.append(f"{name} is not valid JSON")
            elif not isinstance(parsed, dict):
                bad.append(f"{name} is not a JSON object")
    for name in ("ELEVENLABS_VOICE_ID", "ELEVENLABS_SECONDARY_VOICE_ID"):
        v = ctx.get(name)
        if v and not VOICE_ID.fullmatch(v) and not (name.endswith("SECONDARY_VOICE_ID") and v == "narrator"):
            bad.append(f"{name} is not a 20-character voice id" + (" or 'narrator'" if "SECONDARY" in name else ""))
    url = ctx.get("SUPABASE_URL")
    if url and not url.startswith("https://"):
        bad.append("SUPABASE_URL does not start with https://")
    if not bad:
        return [Check("config", "key shapes", PASS, "every key present is written cleanly")]
    return [Check("config", "key shapes", FAIL, "; ".join(bad),
                  "re-paste the value as one clean line (no quotes, spaces, '$' or 'Bearer '), "
                  "then Deploy web; the names above are the ones to fix")]


def _video_key_set(ctx: Ctx, provider: str) -> bool:
    alts = VIDEO_KEYS.get(provider, ())
    return any(all(ctx.has(n) for n in alt) for alt in alts)


def check_video(ctx: Ctx) -> List[Check]:
    g, n = "config", "video clips"
    chosen = ctx.get("CHRONOS_VIDEO_PROVIDER").lower()
    provider = chosen or "minimax"
    minimax = provider == "minimax"
    flag = ctx.on("CHRONOS_ENABLE_MINIMAX_BROLL") if minimax else ctx.on("CHRONOS_ENABLE_VIDEO_GEN")
    other_flag = ctx.on("CHRONOS_ENABLE_VIDEO_GEN") or ctx.on("CHRONOS_ENABLE_MINIMAX_BROLL")
    requested = flag or other_flag or bool(chosen)
    if not requested:
        return [Check(g, n, PASS, "AI video clips are off: runs use Pexels stock footage (as configured)")]
    if provider not in VIDEO_KEYS:
        return [Check(g, n, FAIL, f"CHRONOS_VIDEO_PROVIDER holds {UNRECOGNISED} (not a known provider): "
                                  "every run would silently use stock footage",
                      f"set CHRONOS_VIDEO_PROVIDER to one of {', '.join(sorted(VIDEO_KEYS))}, or clear it "
                      "and CHRONOS_ENABLE_VIDEO_GEN to use stock on purpose, then Deploy web")]
    if not flag:
        switch = "CHRONOS_ENABLE_MINIMAX_BROLL" if minimax else "CHRONOS_ENABLE_VIDEO_GEN"
        label = provider + ("" if chosen else " (the default, CHRONOS_VIDEO_PROVIDER is unset)")
        return [Check(g, n, FAIL, f"provider {label} is requested but {switch} is not on: "
                                  "runs would silently use stock footage",
                      f"set the variable {switch}=true (or clear the provider and the other switch to "
                      "use stock on purpose), then Deploy web")]
    if not _video_key_set(ctx, provider):
        names = " or ".join("+".join(a) for a in VIDEO_KEYS[provider])
        return [Check(g, n, FAIL, f"{provider} clips are switched on but its key is empty: "
                                  "runs would silently use stock footage",
                      _fix_env(names) + " (or switch the clips off)")]
    out: List[Check] = []
    if minimax:
        model = ctx.get("MINIMAX_H3_MODEL") or "MiniMax-H3"
        if model.startswith("MiniMax-H3") and not ctx.has("MINIMAX_V2_QUERY_PATH"):
            return [Check(g, n, FAIL, "MiniMax H3 needs MINIMAX_V2_QUERY_PATH, which is not set",
                          "set the variable MINIMAX_H3_MODEL=MiniMax-Hailuo-2.3 (uses the v1 API), then Deploy web")]
    if provider == "wan" and not ctx.has("WAN_WORKSPACE_ID"):
        out.append(Check(g, "wan workspace", WARN, "WAN_WORKSPACE_ID is not set (needed for per-workspace keys)",
                         "set the variable WAN_WORKSPACE_ID from the Model Studio console, then Deploy web"))
    hook = ctx.preflight_video
    if hook is not None:
        try:
            hook()
        except Exception as e:  # its message quotes configured values: summarise, never forward
            return out + [Check(g, n, FAIL, f"the pipeline's own preflight refuses {provider} ({_exc_summary(e)})",
                                "apply the Fix named above (the full message is in the run log), then Deploy web")]
    return out + [Check(g, n, PASS, f"{provider} clips: switch on and key set (max 2 clips per video)")]


def check_images(ctx: Ctx) -> List[Check]:
    g, n = "config", "ai stills"
    chosen = ctx.get("CHRONOS_IMAGE_PROVIDER").lower()
    flag = ctx.on("CHRONOS_ENABLE_IMAGE_GEN")
    if chosen in ("", "pexels") and not flag:
        return [Check(g, n, PASS, "AI stills are off: runs use Pexels photos (as configured)")]
    if chosen in ("", "pexels"):
        return [Check(g, n, WARN, "CHRONOS_ENABLE_IMAGE_GEN is on but no image provider is chosen: stock photos are used",
                      "set the variable CHRONOS_IMAGE_PROVIDER (" + ", ".join(sorted(IMAGE_KEYS)) + ") or switch it off")]
    key = IMAGE_KEYS.get(chosen)
    if key is None:
        return [Check(g, n, FAIL, f"CHRONOS_IMAGE_PROVIDER holds {UNRECOGNISED} (not a known provider): stock photos would be used",
                      "use one of " + ", ".join(sorted(IMAGE_KEYS)) + ", then Deploy web")]
    if not flag:
        return [Check(g, n, FAIL, f"{chosen} stills are requested but CHRONOS_ENABLE_IMAGE_GEN is not on: stock photos would be used",
                      "set the variable CHRONOS_ENABLE_IMAGE_GEN=true, then Deploy web")]
    if not ctx.has(key):
        return [Check(g, n, FAIL, f"{chosen} stills are switched on but {key} is empty: every still silently becomes stock",
                      _fix_env(key) + " (or switch the stills off)")]
    return [Check(g, n, PASS, f"{chosen} stills: switch on and {key} set (a failing generator still falls back to stock - watch the first run)")]


def check_tts(ctx: Ctx) -> List[Check]:
    g, n = "config", "narration voice"
    explicit = ctx.get("TTS_PROVIDER")
    key = ctx.has("ELEVENLABS_API_KEY")
    effective = explicit or ("elevenlabs" if key else "edge")
    if effective == "edge":
        if explicit:
            return [Check(g, n, PASS, "TTS_PROVIDER=edge: the free Edge voice, chosen on purpose")]
        return [Check(g, n, WARN, "ELEVENLABS_API_KEY is empty and TTS_PROVIDER is unset: runs narrate with the free Edge voice",
                      "to use ElevenLabs set the secret ELEVENLABS_API_KEY and the variable TTS_PROVIDER=elevenlabs, "
                      "then Deploy web; to use Edge on purpose set TTS_PROVIDER=edge")]
    if effective != "elevenlabs":
        return [Check(g, n, FAIL, f"TTS_PROVIDER holds {UNRECOGNISED} (not elevenlabs or edge)",
                      "set the variable TTS_PROVIDER to elevenlabs or edge, then Deploy web")]
    if not key:
        return [Check(g, n, FAIL, "TTS_PROVIDER=elevenlabs but ELEVENLABS_API_KEY is empty: the run would stop at the voice check",
                      _fix_env("ELEVENLABS_API_KEY"))]
    scope = " - deployment default (per-channel overrides not checked)"
    out = [Check(g, n, PASS if explicit else WARN,
                 "ElevenLabs narration" + scope + ("" if explicit else " (by key only: TTS_PROVIDER is unset, so an empty key would fall back to Edge)"),
                 "" if explicit else "set the variable TTS_PROVIDER=elevenlabs so a missing key can never become the Edge voice, then Deploy web")]
    if not ctx.has("ELEVENLABS_VOICE_ID"):
        out.append(Check(g, "narrator voice", WARN, "ELEVENLABS_VOICE_ID is not set: the built-in library voice is used, which some plans cannot use through the API" + scope,
                         "set the variable ELEVENLABS_VOICE_ID to a voice id from the account's own voice list, then Deploy web"))
    if not ctx.has("ELEVENLABS_SECONDARY_VOICE_ID"):
        out.append(Check(g, "secondary voice", FAIL, "ELEVENLABS_SECONDARY_VOICE_ID is not set (there is no built-in default): the run's voice check refuses to start" + scope,
                         "set the variable to a 20-character voice id from the account's voice list, or the word narrator (a channel's own choice in the Command Center also satisfies the run), then Deploy web"))
    return out


def check_required_keys(ctx: Ctx) -> List[Check]:
    out: List[Check] = []
    for name, why in (("GEMINI_API_KEY", "script, research and fact-check"),
                      ("PEXELS_API_KEY", "stock footage and photos (a dead key makes a black video)")):
        if ctx.has(name):
            out.append(Check("keys", name, PASS, "set"))
        else:
            out.append(Check("keys", name, FAIL, f"missing - needed for {why}", _fix_env(name)))
    return out


def check_pipeline_pause(ctx: Ctx) -> List[Check]:
    """REPORT whether the owner paused the scheduled pipeline (NIGHTSHIFT_PIPELINE_PAUSED). Never a FAIL: a pause is
    the owner's decision, and the scheduled doctor turns every FAIL into a readiness alert. It is a WARN because a
    paused pipeline is not "ready to make the next scheduled video", and the reader of a doctor report should see it.
    The reading is the scheduler's own (modules/pipeline_pause.py), silent here; the value is never echoed. Outside
    GitHub Actions an unset variable is UNVERIFIED, not PASS (see below); a pause that IS visible is reported anywhere."""
    g, n = "pipeline", "scheduled runs"
    state = pipeline_pause.pause_state(ctx.env)
    if state == "running":
        # The schedule reads the REPOSITORY variable. Only the scheduled doctor (GitHub Actions) is given it; a doctor
        # run on a laptop or in the worker container has its own environment, where "unset" proves nothing
        # (CLAUDE.md rule 5: a default is not a measurement).
        if str(ctx.env.get("GITHUB_ACTIONS", "")).lower() != "true":
            return [Check(g, n, UNVERIFIED, f"{pipeline_pause.PAUSE_ENV} is not set in THIS environment, which says nothing "
                          "about the repository variable the schedule reads",
                          "read the variable in GitHub (Settings > Secrets and variables > Actions > Variables) or the "
                          "scheduled doctor's job summary")]
        return [Check(g, n, PASS, f"not paused: scheduled runs go ahead ({pipeline_pause.PAUSE_ENV} is unset or off)")]
    what = ("holds an unrecognised value, which counts as paused (fail closed)" if state == "unrecognised"
            else "is on")
    return [Check(g, n, WARN, f"scheduled runs are paused: {pipeline_pause.PAUSE_ENV} {what}; manual and paid runs still work",
                  "set the repository variable " + pipeline_pause.PAUSE_ENV + " to false (or delete it) to resume the schedule; "
                  "then run Actions > 'Deploy web' so the operator bot's service sees it")]


def check_host(ctx: Ctx) -> List[Check]:
    out: List[Check] = []
    from modules import disk_guard  # noqa: PLC0415

    out_dir = ctx.output_dir
    if out_dir is None:
        try:
            from config import OUTPUT_DIR  # noqa: PLC0415
            out_dir = Path(OUTPUT_DIR)
        except Exception:
            out_dir = ctx.root / "output"
    free_fn = ctx.free_fn or disk_guard.free_bytes
    try:
        free = int(free_fn(out_dir))
    except OSError:
        out.append(Check("host", "free disk", UNVERIFIED, "could not read the free space of the output volume",
                         "run `df -h` on the server"))
    else:
        gb = free / disk_guard.GB
        if gb < MIN_FREE_GB:
            out.append(Check("host", "free disk", FAIL, f"{gb:.1f} GB free on the output volume, a run needs {MIN_FREE_GB} GB",
                             f"run `python -m modules.disk_guard --prune-days {disk_guard.DEFAULT_PRUNE_DAYS}` (dry run, add --apply to delete) "
                             "or `docker system prune`"))
        elif gb < 2 * MIN_FREE_GB:
            out.append(Check("host", "free disk", WARN, f"{gb:.1f} GB free on the output volume (limit {MIN_FREE_GB} GB)",
                             "prune old runs soon: `python -m modules.disk_guard --prune-days 30`"))
        else:
            out.append(Check("host", "free disk", PASS, f"{gb:.0f} GB free on the output volume"))
    for tool in ("ffmpeg", "ffprobe"):
        if ctx.which(tool):
            out.append(Check("host", tool, PASS, "found on PATH"))
        else:
            out.append(Check("host", tool, FAIL, "not on PATH: audio and video stages will fail",
                             "rebuild the worker image (`docker compose ... up -d --build worker`)"))
    base = ctx.cache_home or Path(ctx.get("XDG_CACHE_HOME") or Path(ctx.get("HOME") or "~").expanduser() / ".cache")
    if (Path(base) / "whisper" / "base.pt").is_file():
        out.append(Check("host", "whisper model", PASS, "base model is cached in the image"))
    else:
        out.append(Check("host", "whisper model", WARN, "base model is not cached: it downloads in the middle of the first run, after the script and voice are paid",
                         "rebuild the worker image (Dockerfile.worker preloads it), or run `python -c \"import whisper; whisper.load_model('base')\"` once"))
    return out


# -- layer 2: authenticated GETs ----------------------------------------------

def _http_words(resp: Resp) -> Tuple[str, str]:
    """(verdict word, remedy) for a provider answer, from the status alone."""
    s = resp.status
    if s is None:
        return "unreachable", "check the server's outbound network, then run the doctor again"
    if s in (401, 403):
        return "refused the key", "create a new key at the provider, update the GitHub secret, then Deploy web"
    if s == 402:
        return "reports no credit", "top up the provider account"
    if s == 404:
        return "does not know this endpoint or id", "check the id/endpoint settings against the provider docs"
    if s == 429:
        return "rate-limited the check", "wait a minute and run the doctor again"
    return f"answered HTTP {s}", "run the doctor again; if it persists check the provider's status page"


def check_elevenlabs(ctx: Ctx) -> List[Check]:
    if not ctx.has("ELEVENLABS_API_KEY"):
        return []
    from modules import provider_balance  # noqa: PLC0415

    hdr = {"xi-api-key": ctx.get("ELEVENLABS_API_KEY")}
    base = "https://api.elevenlabs.io/v1"
    sub = ctx.http.get(f"{base}/user/subscription", headers=hdr)
    out: List[Check] = []
    if sub.status != 200:
        word, remedy = _http_words(sub)
        return [Check("providers", "elevenlabs", FAIL, f"subscription check: ElevenLabs {word}", remedy)]
    snap = provider_balance.parse_elevenlabs(sub.data)
    status = ""
    if isinstance(sub.data, dict) and isinstance(sub.data.get("status"), str) and SAFE_WORD.fullmatch(sub.data["status"]):
        status = f", plan status {sub.data['status']}"
    if snap is None or snap.remaining is None:
        out.append(Check("providers", "elevenlabs", UNVERIFIED, "key accepted, but the characters left could not be read",
                         "open the ElevenLabs dashboard and read the credits there"))
    else:
        left = int(snap.remaining)
        minutes = left // CHARS_PER_MINUTE
        low = provider_balance.low_credit_threshold()
        detail = f"key accepted, {left} characters left (about {minutes} minutes of narration){status}"
        if left <= 0:
            out.append(Check("providers", "elevenlabs", FAIL, detail, "top up or upgrade the ElevenLabs plan"))
        elif left < low:
            out.append(Check("providers", "elevenlabs", WARN, detail + ", below the alert level",
                             "top up the ElevenLabs plan before the next long video"))
        else:
            out.append(Check("providers", "elevenlabs", PASS, detail))
    if ctx.get("TTS_PROVIDER") != "edge":
        for label, var in (("narrator voice", "ELEVENLABS_VOICE_ID"), ("secondary voice", "ELEVENLABS_SECONDARY_VOICE_ID")):
            vid = ctx.get(var)
            if not vid or vid == "narrator" or not VOICE_ID.fullmatch(vid):
                continue
            r = ctx.http.get(f"{base}/voices/{vid}", headers=hdr)
            if r.status == 200:
                out.append(Check("providers", label, PASS, "the account has this voice"))
            elif r.status == 404:
                out.append(Check("providers", label, FAIL, f"{var} is not a voice of this account",
                                 f"copy a voice id from the account's voice list into {var}, then Deploy web"))
            else:
                word, remedy = _http_words(r)
                out.append(Check("providers", label, FAIL, f"voice check: ElevenLabs {word}", remedy))
    return out


def check_pexels(ctx: Ctx) -> List[Check]:
    if not ctx.has("PEXELS_API_KEY"):
        return []
    r = ctx.http.get("https://api.pexels.com/v1/search", headers={"Authorization": ctx.get("PEXELS_API_KEY")},
                     params={"query": "test", "per_page": "1"})
    if r.status == 200:
        left = ""
        remaining = {k.lower(): v for k, v in (r.headers or {}).items()}.get("x-ratelimit-remaining")
        if remaining and str(remaining).isdigit():
            left = f", {remaining} requests left this window"
        return [Check("providers", "pexels", PASS, "key accepted" + left)]
    word, remedy = _http_words(r)
    if r.status in (401, 403):
        remedy = "create a new key at pexels.com/api, update the secret PEXELS_API_KEY, then Deploy web (a dead key makes a black video)"
    return [Check("providers", "pexels", WARN if r.status in (429, None) else FAIL, f"search check: Pexels {word}", remedy)]


def check_leonardo(ctx: Ctx) -> List[Check]:
    if not ctx.has("LEONARDO_API_KEY"):
        return []
    from modules import provider_balance  # noqa: PLC0415

    r = ctx.http.get("https://cloud.leonardo.ai/api/rest/v1/me",
                     headers={"Authorization": f"Bearer {ctx.get('LEONARDO_API_KEY')}", "accept": "application/json"})
    if r.status != 200:
        word, remedy = _http_words(r)
        return [Check("providers", "leonardo", FAIL, f"account check: Leonardo {word}", remedy)]
    snap = provider_balance.parse_leonardo(r.data)
    if snap is None or snap.remaining is None:
        return [Check("providers", "leonardo", UNVERIFIED, "key accepted, balance not readable", "read the balance in the Leonardo dashboard")]
    if snap.remaining <= 0:
        return [Check("providers", "leonardo", FAIL, "key accepted, 0 API tokens left", "top up the Leonardo API balance")]
    return [Check("providers", "leonardo", PASS, f"key accepted, {int(snap.remaining)} API tokens left")]


def _check_gemini_main(ctx: Ctx, model: str) -> List[Check]:
    if known_id(model) == UNRECOGNISED:
        return [Check("providers", "gemini", WARN, f"GEMINI_MODEL holds {UNRECOGNISED} (not a Gemini model id), so the key was not tested",
                      "set the variable GEMINI_MODEL to a current Gemini model id (or clear it), then Deploy web")]
    r = ctx.http.get(f"https://generativelanguage.googleapis.com/v1beta/models/{model}",
                     headers={"x-goog-api-key": ctx.get("GEMINI_API_KEY")})
    if r.status == 200:
        return [Check("providers", "gemini", PASS, f"key accepted and model {model} is visible (billing state is not readable by key)")]
    if r.status in (400, 401, 403):
        return [Check("providers", "gemini", FAIL, "Gemini refused the key", "create a new key in Google AI Studio, update GEMINI_API_KEY, then Deploy web")]
    if r.status == 404:
        return [Check("providers", "gemini", FAIL, f"Gemini has no model {model}", "set the variable GEMINI_MODEL to a current model id (or clear it), then Deploy web")]
    word, remedy = _http_words(r)
    return [Check("providers", "gemini", WARN, f"models check: Gemini {word}", remedy)]


#: The optional per-stage model variables (config.GEMINI_STAGE_MODELS). A typo in one is a 404 at the topic or the
#: script stage, i.e. after the run has started, so it is probed here with the same free models GET.
GEMINI_STAGE_VARS = tuple("GEMINI_MODEL_" + g for g in
                          ("TOPIC", "RESEARCH", "SCRIPT", "FACTCHECK", "GROUNDING", "PACKAGING", "OTHER"))
_PLAIN_MODEL_ID = re.compile(r"[a-z0-9][a-z0-9._-]{0,63}")


def _check_gemini_stage_models(ctx: Ctx, main_model: str) -> List[Check]:
    out: List[Check] = []
    seen = {main_model}
    for var in GEMINI_STAGE_VARS:
        value = (ctx.get(var) or "").strip()
        if not value or value in seen:
            continue
        name = "gemini " + var[len("GEMINI_MODEL_"):].lower()
        if not _PLAIN_MODEL_ID.fullmatch(value):
            out.append(Check("providers", name, WARN, f"{var} holds {UNRECOGNISED} (not a plain model id), so that stage uses GEMINI_MODEL",
                             f"set the variable {var} to a current Gemini model id (or clear it), then Deploy web"))
            continue
        seen.add(value)
        shown = value if known_id(value) != UNRECOGNISED else f"the model set in {var}"
        r = ctx.http.get(f"https://generativelanguage.googleapis.com/v1beta/models/{value}",
                         headers={"x-goog-api-key": ctx.get("GEMINI_API_KEY")})
        if r.status == 200:
            out.append(Check("providers", name, PASS, f"{shown} is visible ({var})"))
        elif r.status == 404:
            out.append(Check("providers", name, FAIL, f"Gemini has no model {shown} ({var})",
                             f"set the variable {var} to a current model id (or clear it), then Deploy web"))
        elif r.status not in (400, 401, 403):
            word, remedy = _http_words(r)
            out.append(Check("providers", name, WARN, f"models check for {var}: Gemini {word}", remedy))
    return out


def check_gemini(ctx: Ctx) -> List[Check]:
    if not ctx.has("GEMINI_API_KEY"):
        return []
    model = ctx.get("GEMINI_MODEL") or "gemini-3.6-flash"
    main = _check_gemini_main(ctx, model)
    # A refused key makes every probe say the same thing; the stage variables are only worth a request once it works.
    if main and main[0].status == FAIL:
        return main
    return main + _check_gemini_stage_models(ctx, model)


#: provider id -> label in UNVERIFIED_PROVIDERS, for the ones the config selects.
_VIDEO_LABEL = {"minimax": "minimax", "kling": "kling", "veo": "veo", "seedance": "seedance", "wan": "wan", "higgsfield": "higgsfield"}
_IMAGE_LABEL = {"gpt-image": "openai", "flux": "flux (bfl)", "ideogram": "ideogram", "fal": "fal"}


def _selected_labels(ctx: Ctx) -> List[str]:
    """Unverifiable providers the effective config actually uses (switch on, key set)."""
    out: List[str] = []
    video = ctx.get("CHRONOS_VIDEO_PROVIDER").lower() or "minimax"
    flag = ctx.on("CHRONOS_ENABLE_MINIMAX_BROLL") if video == "minimax" else ctx.on("CHRONOS_ENABLE_VIDEO_GEN")
    if video in _VIDEO_LABEL and flag and _video_key_set(ctx, video):
        out.append(_VIDEO_LABEL[video])
    image = ctx.get("CHRONOS_IMAGE_PROVIDER").lower()
    if image in _IMAGE_LABEL and ctx.on("CHRONOS_ENABLE_IMAGE_GEN") and ctx.has(IMAGE_KEYS[image]):
        out.append(_IMAGE_LABEL[image])
    return out


def check_unverified(ctx: Ctx) -> List[Check]:
    selected = _selected_labels(ctx)
    present, seen = [], set()
    for var, label in UNVERIFIED_PROVIDERS:
        if ctx.has(var) and label not in seen and label not in selected:
            seen.add(label)
            present.append(label)
    out: List[Check] = []
    if selected:
        out.append(Check("providers", "selected provider", WARN,
                         "the configuration uses " + ", ".join(selected) + ", whose key cannot be proven without a paid call",
                         "run the 30-second smoke run (docs/VIDEO_GO_LIVE.md, step 5) and check the provider's dashboard, "
                         "or `python tools/probe_models.py --model <id>` (paid, one model at a time)"))
    if present:
        out.append(Check("providers", "other providers", UNVERIFIED,
                         "key present, no free authenticated endpoint is used in this repository: " + ", ".join(present),
                         "these are proven only by a paid call: `python tools/probe_models.py --model <id>` (one model at a time), "
                         "or by the first small real run"))
    return out


# -- Supabase -----------------------------------------------------------------

def _sb_headers(ctx: Ctx) -> dict:
    key = ctx.get("SUPABASE_SERVICE_KEY")
    return {"apikey": key, "Authorization": f"Bearer {key}"}


def _sb_get(ctx: Ctx, table: str, params: dict) -> Resp:
    return ctx.http.get(f"{ctx.get('SUPABASE_URL').rstrip('/')}/rest/v1/{table}", headers=_sb_headers(ctx), params=params)


def _parse_ts(value) -> Optional[datetime]:
    if not isinstance(value, str) or not value:
        return None
    try:
        dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def check_supabase(ctx: Ctx) -> List[Check]:
    g = "supabase"
    missing = [n for n in ("SUPABASE_URL", "SUPABASE_SERVICE_KEY") if not ctx.has(n)]
    if missing:
        return [Check(g, "supabase", FAIL, "missing: " + ", ".join(missing) + " (the worker cannot start)", _fix_env(" and ".join(missing)))]
    out: List[Check] = []
    absent: List[str] = []
    reached = False
    for mig, table, cols in MIGRATION_PROBES:
        r = _sb_get(ctx, table, {"select": cols, "limit": "0"})
        if r.status is None:
            return [Check(g, "supabase", FAIL, "Supabase did not answer", "check SUPABASE_URL and the server's outbound network")]
        if r.status in (401, 403):
            return [Check(g, "supabase", FAIL, "Supabase refused the service key",
                          "copy the service_role key from Supabase > Project Settings > API into the secret SUPABASE_SERVICE_KEY, then Deploy web")]
        if r.status == 200:
            reached = True
        elif r.status in (400, 404):
            absent.append(f"{mig} ({table})")
        else:
            return [Check(g, "supabase", WARN, f"Supabase answered HTTP {r.status} to the {table} check", "run the doctor again")]
    if reached:
        out.append(Check(g, "supabase", PASS, "reachable, service key accepted"))
    if absent:
        out.append(Check(g, "migrations", FAIL, "not applied: " + ", ".join(absent),
                         "apply the named supabase/migrations/NNNN_*.sql files in order (docs/MIGRATIONS.md), then run the doctor again"))
    else:
        out.append(Check(g, "migrations", PASS, "tables and columns of 0012, 0016, 0017, 0020, 0045, 0106 exist (0041 is a trigger: not provable read-only)"))
    bucket = ctx.http.get(f"{ctx.get('SUPABASE_URL').rstrip('/')}/storage/v1/bucket/previews", headers=_sb_headers(ctx))
    if bucket.status == 200:
        out.append(Check(g, "storage bucket", PASS, "bucket 'previews' exists"))
    elif bucket.status in (400, 404):
        out.append(Check(g, "storage bucket", FAIL, "bucket 'previews' does not exist: no review copy can be saved",
                         "apply migration 0004_review.sql, which creates the private 'previews' bucket"))
    else:
        out.append(Check(g, "storage bucket", UNVERIFIED, "could not read the bucket", "check Supabase > Storage for a bucket named previews"))
    out.extend(check_prices(ctx))
    out.extend(check_liveness(ctx))
    return out


def check_prices(ctx: Ctx) -> List[Check]:
    from modules import credits  # noqa: PLC0415

    r = _sb_get(ctx, "credit_prices", {"select": "unit,credits_per_unit,margin"})
    if r.status != 200 or not isinstance(r.data, list):
        return [Check("credits", "credit prices", UNVERIFIED, "could not read credit_prices", "apply migration 0020 and run the doctor again")]
    have = credits.parse_prices(r.data)
    enforce = credits.enforcement_enabled(ctx.env)
    gap = [u for u in REQUIRED_PRICES if u not in have]
    units = [u for u in UNIT_PRICES if u not in have]
    out: List[Check] = []
    if gap:
        out.append(Check("credits", "credit prices", FAIL if enforce else WARN,
                         "missing price rows: " + ", ".join(gap) + (" (credits are enforced: every run is refused)" if enforce else ""),
                         "open the Command Center > Owner > Prices and set " + ", ".join(gap)))
    elif units:
        out.append(Check("credits", "credit prices", WARN, "video_minute and job_minimum are set; unit rows missing: " + ", ".join(units),
                         "set them in Owner > Prices (without a unit row that part of a run is unpriced)"))
    else:
        out.append(Check("credits", "credit prices", PASS, "video_minute, job_minimum and all unit rows are priced"))
    a = _sb_get(ctx, "api_prices", {"select": "unit,cents"})
    if a.status == 200 and isinstance(a.data, list):
        units_api = {str(x.get("unit")) for x in a.data if isinstance(x, dict) and x.get("cents") is not None}
        lack = [u for u in REQUIRED_PRICES if u not in units_api]
        if lack:
            out.append(Check("credits", "api prices", WARN, "api_prices missing: " + ", ".join(lack) + " (matters only if the public API is on)",
                             "set them in Owner > Prices (API)"))
        else:
            out.append(Check("credits", "api prices", PASS, "video_minute and job_minimum are priced"))
    return out


def check_liveness(ctx: Ctx) -> List[Check]:
    g = "worker"
    now = ctx.now
    r = _sb_get(ctx, "render_jobs", {"select": "id,status,heartbeat_at,started_at,created_at",
                                      "status": "in.(queued,running)", "order": "created_at.asc", "limit": "50"})
    if r.status != 200 or not isinstance(r.data, list):
        return [Check(g, "worker liveness", UNVERIFIED, "could not read render_jobs", "apply migration 0017 and run the doctor again")]
    running = [x for x in r.data if isinstance(x, dict) and x.get("status") == "running"]
    queued = [x for x in r.data if isinstance(x, dict) and x.get("status") == "queued"]
    out: List[Check] = []
    stale = []
    long_running = []
    for j in running:
        hb = _parse_ts(j.get("heartbeat_at"))
        if hb is None or (now - hb).total_seconds() > 120:
            stale.append(j)
        st = _parse_ts(j.get("started_at"))
        if st is not None and (now - st).total_seconds() > 55 * 60:
            long_running.append(j)
    if stale:
        out.append(Check(g, "worker liveness", FAIL, f"{len(stale)} running job(s) have no heartbeat for over 2 minutes: the worker is down or restarting",
                         "on the server: `docker compose ... --profile worker ps worker` then `docker compose ... logs --tail 50 worker`; "
                         "a stale job is re-queued automatically after 10 minutes"))
    elif running:
        out.append(Check(g, "worker liveness", PASS, f"{len(running)} job(s) running, heartbeat fresh"))
    if long_running and not stale:
        out.append(Check(g, "long job", WARN, f"{len(long_running)} job(s) have been running for over 55 minutes (a normal run is shorter; the heartbeat hides a hang)",
                         "look at `docker compose ... logs --tail 100 worker`; cancel the job from the Command Center if it is stuck"))
    if queued and not running:
        oldest = min((t for t in (_parse_ts(j.get("created_at")) for j in queued) if t), default=None)
        if oldest is not None and (now - oldest).total_seconds() > 600:
            out.append(Check(g, "queue", WARN, f"{len(queued)} job(s) queued, the oldest for over 10 minutes, and nothing is running: no worker is claiming",
                             "check `docker compose ... --profile worker ps worker` and that the GitHub variable NIGHTSHIFT_WORKER is on, then Deploy web"))
    if not running and not queued:
        out.append(Check(g, "worker liveness", UNVERIFIED, "no job in flight: an idle pipeline worker leaves no heartbeat to read",
                         "run `docker compose ... --profile worker ps worker` (State should be running); the smoke run proves it"))
    ws = _sb_get(ctx, "worker_status", {"select": "kind,state,updated_at", "order": "updated_at.desc", "limit": "20"})
    if ws.status == 200 and isinstance(ws.data, list):
        fresh = sorted({str(x.get("kind")) for x in ws.data if isinstance(x, dict)
                        and (t := _parse_ts(x.get("updated_at"))) is not None and (now - t).total_seconds() < 180
                        and SAFE_WORD.fullmatch(str(x.get("kind")))})
        out.append(Check(g, "side workers", PASS if fresh else UNVERIFIED,
                         ("reporting in the last 3 minutes: " + ", ".join(fresh)) if fresh else "no side worker (media/creative) reported recently",
                         "" if fresh else "only matters if you use the media library or the Creative Studio"))
    return out


# -- YouTube -------------------------------------------------------------------

def _client_pair(ctx: Ctx, token: dict) -> Tuple[str, str]:
    cid, secret = str(token.get("client_id") or ""), str(token.get("client_secret") or "")
    if not (cid and secret):
        doc, _ = _load_json(ctx.get("YOUTUBE_CLIENT_SECRET_JSON") or "{}")
        inner = (doc.get("installed") or doc.get("web") or {}) if isinstance(doc, dict) else {}
        if isinstance(inner, dict):
            cid, secret = cid or str(inner.get("client_id") or ""), secret or str(inner.get("client_secret") or "")
    if not (cid and secret):
        cid, secret = cid or ctx.get("GOOGLE_OAUTH_CLIENT_ID"), secret or ctx.get("GOOGLE_OAUTH_CLIENT_SECRET")
    return cid, secret


def _vault_token(ctx: Ctx, channel_id: str) -> Tuple[str, Optional[dict], str]:
    """The channel's Command Center connection, the way the run reads it (migration 0022 / 0115).

    ``(state, token document, why)``: ``none`` (no Supabase here, 0022 not applied, or no active connection - the
    GitHub secret applies), ``active`` (the document the run builds from it, refreshable with the Command Center's
    OAuth client), ``unusable`` (a connection exists but this environment cannot refresh it: ``why`` says what is
    missing) or ``unknown`` (the lookup itself failed: an unknown is not a no). Reads with the service key the
    doctor already has; the token goes into the in-memory document and nowhere else."""
    from modules import channel_tokens  # noqa: PLC0415

    if not (ctx.has("SUPABASE_URL") and ctx.has("SUPABASE_SERVICE_KEY")):
        return "none", None, ""
    post = getattr(ctx.http, "post_json", None)
    if post is None:
        return "none", None, ""
    r = post(f"{ctx.get('SUPABASE_URL').rstrip('/')}/rest/v1/rpc/read_channel_token",
             {"p_channel_id": channel_id}, _sb_headers(ctx))
    if r.status == 404:
        return "none", None, ""
    if r.status is None or r.status >= 300:
        return "unknown", None, "the Vault lookup did not answer" if r.status is None else f"the Vault lookup answered HTTP {r.status}"
    rows = r.data if isinstance(r.data, list) else ([r.data] if isinstance(r.data, dict) else [])
    row = rows[0] if rows and isinstance(rows[0], dict) else {}
    refresh = str(row.get("refresh_token") or "").strip()
    if not refresh:
        return "none", None, ""
    vault = channel_tokens.VaultToken(
        refresh_token=refresh, scopes=tuple(str(x) for x in (row.get("scopes") or []) if x),
        oauth_client_id=str(row.get("oauth_client_id") or ""), youtube_channel_id=str(row.get("youtube_channel_id") or ""))
    try:
        cid, csecret = channel_tokens.oauth_client_for(vault, dict(ctx.env))
    except channel_tokens.ChannelTokenError:
        return "unusable", None, ("this runner has no OAuth client that can refresh it: set GOOGLE_OAUTH_CLIENT_ID and "
                                  "GOOGLE_OAUTH_CLIENT_SECRET to the Command Center's values")
    return "active", json.loads(channel_tokens.build_token_json(vault, cid, csecret)), ""


def _refresh_check(ctx: Ctx, group: str, name: str, token: dict, cid: str, secret: str, *, fix: str, note: str) -> Check:
    """One free in-memory refresh of ``token``; ``fix`` is the next step for a refused token."""
    from modules.youtube_token_check import DEAD, LIVE, verdict_from_response  # noqa: PLC0415

    if not ctx.youtube:
        return Check(group, name, SKIP, "token refresh skipped (--no-youtube)")
    r = ctx.http.post_form(YOUTUBE_TOKEN_URI, {"client_id": cid, "client_secret": secret,
                                               "refresh_token": str(token["refresh_token"]), "grant_type": "refresh_token"})
    verdict = verdict_from_response(r.status, r.data)
    if verdict.status == LIVE:
        return Check(group, name, PASS, f"Google accepted the refresh token{note} (checked in memory, nothing saved)")
    if verdict.status == DEAD and verdict.reason == "invalid_grant":
        return Check(group, name, FAIL, f"Google says the refresh token{note} is expired or revoked (invalid_grant)", fix)
    if verdict.status == DEAD:
        return Check(group, name, FAIL, f"Google refused the OAuth client ({verdict.reason})",
                     "the client id/secret must be the pair that minted the token"
                     + ("; press Reconnect on the channel's card on the Channels page" if note else "; fix YOUTUBE_CLIENT_SECRET_JSON, then Deploy web"))
    if r.status is None:
        return Check(group, name, WARN, "could not reach Google", "run the doctor again")
    err = ""
    if isinstance(r.data, dict) and isinstance(r.data.get("error"), str) and SAFE_WORD.fullmatch(r.data["error"]):
        err = r.data["error"]
    return Check(group, name, WARN, f"token refresh answered HTTP {r.status}" + (f" ({err})" if err else ""), "run the doctor again")


_RECONNECT_FIX = ("press Reconnect on the channel's card on the Command Center's Channels page; "
                  "a Google OAuth app left in 'Testing' expires its tokens after 7 days - publish the consent screen")


def check_youtube(ctx: Ctx) -> List[Check]:
    """The operator's default channel's token: the Command Center connection when there is one (the token the run
    uses), else ``YOUTUBE_TOKEN_JSON`` exactly as before."""
    g, n = "youtube", "operator channel token"
    out: List[Check] = []
    state, doc, why = _vault_token(ctx, "default")
    if state == "active" and doc is not None:
        if not ctx.has("YOUTUBE_CHANNEL_ID"):
            out.append(Check(g, "channel id", WARN, "YOUTUBE_CHANNEL_ID is not set", _fix_env("YOUTUBE_CHANNEL_ID")))
        return out + [_refresh_check(ctx, g, n, doc, str(doc["client_id"]), str(doc["client_secret"]),
                                     fix=_RECONNECT_FIX, note=" (connected from the Command Center)")]
    if state == "unusable":
        return [Check(g, n, FAIL, f"the default channel is connected from the Command Center, but {why}",
                      "add GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET to the GitHub Actions secrets (the same values as the Command Center), "
                      "or disconnect the channel to use YOUTUBE_TOKEN_JSON")]
    if state == "unknown":
        out.append(Check(g, "operator channel connection", WARN, f"{why}, so the Command Center connection was not checked; "
                         "the check below is of YOUTUBE_TOKEN_JSON", "run the doctor again"))
    if not ctx.has("YOUTUBE_TOKEN_JSON"):
        return out + [Check(g, n, WARN, "no Command Center connection and YOUTUBE_TOKEN_JSON is not set: uploads for the operator channel will fail (customer channels use their own connection)",
                            "press Connect YouTube on the default channel's card on the Channels page, or " + _fix_env("YOUTUBE_TOKEN_JSON, YOUTUBE_CLIENT_SECRET_JSON and YOUTUBE_CHANNEL_ID"))]
    token, ok = _load_json(ctx.get("YOUTUBE_TOKEN_JSON"))
    if not ok:
        return out + [Check(g, n, FAIL, "YOUTUBE_TOKEN_JSON is not valid JSON", "press Connect YouTube on the Channels page, or re-paste the whole youtube_token.json into the secret, then Deploy web")]
    if not isinstance(token, dict) or not token.get("refresh_token"):
        return out + [Check(g, n, FAIL, "YOUTUBE_TOKEN_JSON has no refresh token", "press Connect YouTube on the Channels page, or run the YouTube authorisation again (tools/connect_channel.py) and update the secret")]
    cid, secret = _client_pair(ctx, token)
    if not (cid and secret):
        return out + [Check(g, n, FAIL, "no OAuth client id/secret to refresh the token with",
                            _fix_env("YOUTUBE_CLIENT_SECRET_JSON"))]
    if not ctx.has("YOUTUBE_CHANNEL_ID"):
        out.append(Check(g, "channel id", WARN, "YOUTUBE_CHANNEL_ID is not set", _fix_env("YOUTUBE_CHANNEL_ID")))
    return out + [_refresh_check(
        ctx, g, n, token, cid, secret, note="",
        fix="press Connect YouTube on the Channels page (no secret to touch), or authorise the channel again (tools/connect_channel.py), "
            "update the secret YOUTUBE_TOKEN_JSON, then Deploy web; "
            "a Google OAuth app left in 'Testing' expires its tokens after 7 days - publish the consent screen")]


def _channel_token_rows(ctx: Ctx) -> Tuple[Optional[List[Tuple[dict, str]]], Optional[Check]]:
    """(rows with the token each one holds, None) or (None, the warning that says they could not be listed).

    CI mode (the scheduled workflow, ``DOCTOR_CHANNEL_TOKEN_ROWS`` present): the resolver job listed the
    channels and the workflow handed over the first N secrets by position; the registry is not read here. Env
    mode (a worker or a person at a terminal): the registry hook lists them and each token is the environment
    variable of the same name."""
    g = "token"
    if CHANNEL_TOKEN_ROWS_ENV in ctx.env:
        raw = ctx.get(CHANNEL_TOKEN_ROWS_ENV)
        rows, ok = _load_json(raw) if raw else (None, False)
        if not ok or not isinstance(rows, list):
            return None, Check(g, "scheduled channels", WARN,
                               "the list of scheduled channels could not be read, so their tokens were not checked",
                               "open the doctor_scheduled run's 'resolve' job: the channel registry was unreadable")
        return [(r, ctx.get(f"DOCTOR_CHANNEL_TOKEN_{i}") if i < CHANNEL_TOKEN_SLOTS else None)
                for i, r in enumerate(rows) if isinstance(r, dict)], None
    if ctx.channel_rows is None:
        return [], None
    try:
        rows = list(ctx.channel_rows())
    except Exception as e:
        return None, Check(g, "scheduled channels", WARN,
                           f"the list of scheduled channels could not be read ({type(e).__name__}), so their tokens were not checked",
                           "run the doctor again once Supabase answers")
    return [(r, ctx.get(str(r.get("token_secret") or ""))) for r in rows if isinstance(r, dict)], None


def check_channel_tokens(ctx: Ctx) -> List[Check]:
    """Every scheduled operator channel's YouTube token, one free in-memory refresh each (nothing saved).

    The default channel is ``check_youtube``'s. Here: a channel whose secret is not set is a FAIL naming the
    channel (it would be scheduled, rendered and paid for, then fail at the upload); a refused refresh token is a
    FAIL; a Google that does not answer is a WARN (an unknown is not a no). Names are ``token/<channel id>`` so a
    public CI log and the alert row carry the channel id and a verdict, nothing the check found."""
    from modules.youtube_token_check import DEAD, LIVE, verdict_from_response  # noqa: PLC0415

    g = "token"
    rows, problem = _channel_token_rows(ctx)
    if problem is not None:
        return [problem]
    out: List[Check] = []
    for row, value in rows:
        cid, secret_name = str(row.get("channel_id") or ""), str(row.get("token_secret") or "")
        if not cid:
            continue
        # A channel connected from the Command Center (Vault) is read that way by the run, so that is the token to prove.
        state, doc, why = _vault_token(ctx, cid)
        if state == "active" and doc is not None:
            out.append(_refresh_check(ctx, g, cid, doc, str(doc["client_id"]), str(doc["client_secret"]),
                                      fix=_RECONNECT_FIX, note=" (connected from the Command Center)"))
            continue
        if state == "unusable":
            out.append(Check(g, cid, FAIL, f"this channel is connected from the Command Center, but {why}",
                             "add GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET to the GitHub Actions secrets (the same values as the Command Center)"))
            continue
        if state == "unknown":
            out.append(Check(g, f"{cid} connection", WARN, f"{why}, so the Command Center connection was not checked; the check of its secret follows",
                             "run the doctor again"))
        if not _TOKEN_SECRET_NAME.fullmatch(secret_name) or value is None:
            why = ("this channel is beyond the " + str(CHANNEL_TOKEN_SLOTS) + " tokens the workflow hands the doctor"
                   if value is None else "its token secret name is not a CHRONOS_YT_TOKEN_<REF> name")
            out.append(Check(g, cid, WARN, f"not checked: {why}",
                             "check this channel's token by hand with tools/doctor.py on the worker"
                             if value is None else "fix the channel's credential reference"))
            continue
        if not value:
            out.append(Check(g, cid, FAIL, "no token secret for this scheduled channel: its upload would fail after the render is paid for",
                             f"add the GitHub Actions secret {secret_name} (the channel's token JSON), or pause the channel"))
            continue
        token, ok = _load_json(value)
        if not ok or not isinstance(token, dict) or not str(token.get("refresh_token") or "").strip():
            out.append(Check(g, cid, FAIL, "its token secret is not a token document with a refresh token",
                             f"authorise the channel again (tools/connect_channel.py) and update the secret {secret_name}"))
            continue
        # The client pair comes from the token file alone, as the run reads it (youtube_token_check._read_token):
        # no YOUTUBE_CLIENT_SECRET_JSON / GOOGLE_OAUTH_* fallback, so the doctor cannot pass a file the run refuses.
        cid_, csecret = (str(token.get(k) or "").strip() for k in ("client_id", "client_secret"))
        if not (cid_ and csecret):
            out.append(Check(g, cid, FAIL, "its token has no OAuth client id/secret to refresh it with",
                             f"authorise the channel again (tools/connect_channel.py) and update the secret {secret_name}"))
            continue
        if not ctx.youtube:
            out.append(Check(g, cid, SKIP, "token refresh skipped (--no-youtube)"))
            continue
        r = ctx.http.post_form(YOUTUBE_TOKEN_URI, {"client_id": cid_, "client_secret": csecret,
                                                   "refresh_token": str(token["refresh_token"]), "grant_type": "refresh_token"})
        verdict = verdict_from_response(r.status, r.data)
        if verdict.status == LIVE:
            out.append(Check(g, cid, PASS, "Google accepted the refresh token (checked in memory, nothing saved)"))
        elif verdict.status == DEAD:
            out.append(Check(g, cid, FAIL, f"Google refused this channel's token ({verdict.reason})",
                             f"authorise the channel again (tools/connect_channel.py) and update the secret {secret_name}; "
                             "a Google OAuth app left in 'Testing' expires its tokens after 7 days"))
        else:
            out.append(Check(g, cid, WARN, "could not get an answer from Google" if r.status is None
                             else f"token refresh answered HTTP {r.status}", "run the doctor again"))
    return out


# -- GitHub (repo side) ---------------------------------------------------------

def _example_names(root: Path) -> List[str]:
    try:
        text = (root / "deploy" / ".env.worker.example").read_text(encoding="utf-8")
    except OSError:
        return []
    return re.findall(r"^([A-Z][A-Z0-9_]*)=", text, re.M)


def _kinds_from_workflow(root: Path) -> Dict[str, str]:
    try:
        text = (root / ".github" / "workflows" / "deploy_web.yml").read_text(encoding="utf-8")
    except OSError:
        return {}
    return {m.group(2): ("secret" if m.group(1) == "secrets" else "variable")
            for m in re.finditer(r"WORKERENV_\w+:\s*\$\{\{\s*(secrets|vars)\.(\w+)\s*\}\}", text)}


def _looks_secret(name: str) -> bool:
    return bool(re.search(r"(_KEY|_SECRET|_TOKEN|_JSON|^FAL_KEY)$", name))


GITHUB_REQUIRED = ("SUPABASE_URL", "SUPABASE_SERVICE_KEY", "GEMINI_API_KEY", "PEXELS_API_KEY")
#: Missing = a WARN, as in the local check: customer channels upload with their own connection.
GITHUB_YOUTUBE = ("YOUTUBE_CLIENT_SECRET_JSON", "YOUTUBE_TOKEN_JSON", "YOUTUBE_CHANNEL_ID")
GH_PAGE_SIZE, GH_MAX_PAGES = 100, 10


def _gh_names(ctx: Ctx, path: str, field: str, headers: dict) -> Tuple[Optional[Dict[str, Optional[datetime]]], Resp]:
    """{name: updated_at} from a GitHub listing, all pages (at most GH_MAX_PAGES)
    - names and timestamps only; a variable's value is in the answer and is
    dropped here, unread. None when any page could not be read."""
    out: Dict[str, Optional[datetime]] = {}
    r = Resp(None)
    for page in range(1, GH_MAX_PAGES + 1):
        r = ctx.http.get("https://api.github.com" + path, headers=headers,
                         params={"per_page": str(GH_PAGE_SIZE), "page": str(page)})
        if r.status != 200 or not isinstance(r.data, dict) or not isinstance(r.data.get(field), list):
            return None, r
        items = r.data[field]
        for item in items:
            if isinstance(item, dict) and isinstance(item.get("name"), str):
                out[item["name"]] = _parse_ts(item.get("updated_at"))
        if len(items) < GH_PAGE_SIZE:
            break
    return out, r


def github_checks(ctx: Ctx, repo: Optional[str] = None) -> List[Check]:
    g = "github"
    token = ctx.get("GITHUB_SECRETS_TOKEN") or ctx.get("GITHUB_TOKEN") or ctx.get("GH_TOKEN")
    repo = repo or ctx.get("GITHUB_SECRETS_REPO") or ctx.get("GITHUB_REPOSITORY")
    if not token:
        return [Check(g, "github", SKIP, "no GitHub token in the environment (GITHUB_SECRETS_TOKEN, GITHUB_TOKEN or GH_TOKEN)",
                      "export a fine-grained token with read-only 'Secrets' and 'Variables' access, or look at Settings > Secrets and variables > Actions by hand")]
    if not repo or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9-]{0,38}/(?!\.\.?$)[A-Za-z0-9_.-]{1,100}", repo):
        return [Check(g, "github", SKIP, "no repository named", "pass --repo owner/name (or set GITHUB_SECRETS_REPO)")]
    headers = {"Accept": "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "Authorization": f"Bearer {token}"}
    secrets, rs = _gh_names(ctx, f"/repos/{repo}/actions/secrets", "secrets", headers)
    variables, rv = _gh_names(ctx, f"/repos/{repo}/actions/variables", "variables", headers)
    if secrets is None and variables is None:
        word, remedy = _http_words(rs)
        return [Check(g, "github", FAIL, f"GitHub {word} when listing the repository's secrets and variables", remedy)]
    out: List[Check] = []
    if secrets is None or variables is None:
        return [Check(g, "listing", UNVERIFIED, "only one of the secrets / variables listings could be read (the token may lack 'Variables' or 'Secrets' access), so nothing can be concluded about missing names",
                      "give the token read-only access to both Secrets and Variables")]
    env_s, res = _gh_names(ctx, f"/repos/{repo}/environments/production/secrets", "secrets", headers)
    env_v, rev = _gh_names(ctx, f"/repos/{repo}/environments/production/variables", "variables", headers)
    if env_s is None or env_v is None:
        bad = [x for x in (res, rev) if x.status != 200]
        code = f"HTTP {bad[0].status}" if bad and bad[0].status else "no answer"
        out.append(Check(g, "production environment", UNVERIFIED,
                         f"the 'production' environment's own secrets/variables could not be read ({code}); only repository-level names were checked",
                         "give the token access to environments (read-only), or look at Settings > Environments > production by hand; "
                         "an environment-level value overrides a repository one"))
    all_secrets = {**(secrets or {}), **(env_s or {})}
    all_vars = {**(variables or {}), **(env_v or {})}
    kinds = _kinds_from_workflow(ctx.root)
    heuristic = not kinds
    expected = _example_names(ctx.root)
    for name in expected:
        kinds.setdefault(name, "secret" if _looks_secret(name) else "variable")
    if heuristic:
        out.append(Check(g, "classification", WARN, "deploy_web.yml was not found here: which names are secrets vs variables is guessed from the name",
                         "run the doctor from a repository checkout for the exact mapping"))
    missing_req = [n for n in GITHUB_REQUIRED if n not in all_secrets and n not in all_vars]
    if missing_req:
        out.append(Check(g, "required names", FAIL, "not set anywhere: " + ", ".join(missing_req),
                         "add them as GitHub Secrets (Settings > Secrets and variables > Actions)"))
    else:
        out.append(Check(g, "required names", PASS, "all required names exist: " + ", ".join(GITHUB_REQUIRED)))
    yt_missing = [n for n in GITHUB_YOUTUBE if n not in all_secrets and n not in all_vars]
    if yt_missing:
        out.append(Check(g, "youtube names", WARN, "not set: " + ", ".join(yt_missing) + " (operator-channel uploads will fail; customer channels use their own connection)",
                         "add them as GitHub Secrets if the operator channel should upload"))
    else:
        out.append(Check(g, "youtube names", PASS, "all exist: " + ", ".join(GITHUB_YOUTUBE)))
    wrong = sorted(n for n, k in kinds.items() if k == "secret" and n in all_vars and n not in all_secrets)
    if wrong:
        out.append(Check(g, "secret stored as variable", FAIL, "stored as a Variable but the deploy reads a Secret (the worker gets an empty value): " + ", ".join(wrong),
                         "recreate each as a Secret with the same name, then Deploy web"))
    wrong_v = sorted(n for n, k in kinds.items() if k == "variable" and n in all_secrets and n not in all_vars)
    if wrong_v:
        out.append(Check(g, "variable stored as secret", WARN, "stored as a Secret but the deploy reads a Variable (the worker gets an empty value): " + ", ".join(wrong_v),
                         "recreate each as a Variable with the same name, then Deploy web"))
    optional = [n for n in expected if n not in GITHUB_REQUIRED and n not in GITHUB_YOUTUBE]
    present = sorted(n for n in optional if n in all_secrets or n in all_vars)
    absent = sorted(n for n in optional if n not in all_secrets and n not in all_vars)
    out.append(Check(g, "optional names present", PASS, ", ".join(present) if present else "none"))
    out.append(Check(g, "optional names absent", UNVERIFIED if absent else PASS, (", ".join(absent) if absent else "none")
                     + ("  (values are never read, so 'on'/'off' switches cannot be confirmed here)" if absent else ""),
                     "only the ones you want to use need to be added" if absent else ""))
    runs = ctx.http.get(f"https://api.github.com/repos/{repo}/actions/workflows/deploy_web.yml/runs", headers=headers,
                        params={"status": "success", "per_page": "1"})
    last = None
    if runs.status == 200 and isinstance(runs.data, dict) and isinstance(runs.data.get("workflow_runs"), list) and runs.data["workflow_runs"]:
        first = runs.data["workflow_runs"][0]
        last = _parse_ts(first.get("updated_at") or first.get("created_at")) if isinstance(first, dict) else None
    if last is None:
        out.append(Check(g, "changed after deploy", UNVERIFIED, "no successful 'Deploy web' run could be read", "run Actions > Deploy web once"))
    else:
        newer = sorted(n for n, t in {**all_secrets, **all_vars}.items() if t is not None and t > last and (n in kinds))
        if newer:
            out.append(Check(g, "changed after deploy", WARN, "changed after the last successful Deploy web, so the worker may still hold the old value: " + ", ".join(newer),
                             "run Actions > 'Deploy web' > Run workflow"))
        else:
            out.append(Check(g, "changed after deploy", PASS, "nothing the worker reads changed since the last successful deploy"))
    return out


# -- assembling -------------------------------------------------------------------

_KNOWN_IDS = set(VIDEO_KEYS) | set(IMAGE_KEYS) | {"elevenlabs", "edge", "pexels"}


def _scrub(text: str, env: Mapping[str, str]) -> str:
    """The net under every message: secret-named values, free-text variables
    that are not a known id (a key pasted into the wrong variable), and
    token-shaped strings, replaced before anything is printed."""
    from modules.log_redaction import redact  # noqa: PLC0415

    for name, value in env.items():
        value = str(value or "")
        if len(value) < 8:
            continue
        secretish = re.search(r"KEY|SECRET|TOKEN|JSON|PASSWORD", str(name))
        freetext = name in FREE_TEXT_VARS and value not in _KNOWN_IDS and not _MODEL_ID.fullmatch(value)
        if secretish or freetext:
            text = text.replace(value, "<redacted>")
    text = re.sub(r"\b(?:sk|xi|pk|ghp|gho|github_pat|AIza|eyJ)[A-Za-z0-9_\-.]{16,}", "<redacted>", redact(text))
    return text


def run_checks(ctx: Ctx, *, offline: bool = False, github: bool = False, repo: Optional[str] = None) -> List[Check]:
    def guarded(fn, *a) -> List[Check]:
        try:
            return fn(*a)
        except Exception as e:  # incl. RecursionError: a bug in one check must not hide the others
            return [Check("doctor", getattr(fn, "__name__", "check"), WARN, f"this check crashed ({type(e).__name__})",
                          "report it; the other checks are unaffected")]

    if github:
        return guarded(github_checks, ctx, repo)
    checks: List[Check] = []
    for fn in (check_required_keys, check_shapes, check_video, check_images, check_tts, check_pipeline_pause, check_host):
        checks += guarded(fn, ctx)
    if offline:
        return checks
    for fn in (check_elevenlabs, check_pexels, check_leonardo, check_gemini, check_unverified,
               check_supabase, check_youtube, check_channel_tokens):
        checks += guarded(fn, ctx)
    return checks


def summarize(checks: Sequence[Check], offline: bool = False) -> Dict[str, Any]:
    """``offline``: the network checks that make "ready" true were skipped, so the
    answer is never ready (exit 2) even when every local check passes."""
    n = {s: sum(1 for c in checks if c.status == s) for s in (PASS, WARN, FAIL, UNVERIFIED, SKIP)}
    checked = n[PASS] + n[WARN] + n[FAIL]
    code = 1 if n[FAIL] else (2 if n[WARN] or not checked or offline else 0)
    return {"ready": code == 0, "exit_code": code, "counts": n, "checked": checked, "config_only": bool(offline)}


def to_json(checks: Sequence[Check], env: Mapping[str, str], offline: bool = False) -> str:
    doc = {**summarize(checks, offline), "checks": [asdict(c) for c in checks]}
    return _scrub(json.dumps(doc, indent=2), env)


def render(checks: Sequence[Check], env: Mapping[str, str], offline: bool = False) -> str:
    s = summarize(checks, offline)
    c = s["counts"]
    counts = f"{c[FAIL]} blocking, {c[WARN]} warning{'s' if c[WARN] != 1 else ''}"
    if not s["checked"]:
        head = "READY: UNKNOWN (nothing could be checked)"
    elif offline:
        head = f"CONFIG ONLY (network checks skipped; {counts}): not a readiness answer, run without --offline"
    elif s["ready"]:
        head = "READY: YES" + (f"  ({c[UNVERIFIED]} unverified)" if c[UNVERIFIED] or c[SKIP] else "")
    else:
        head = f"READY: NO ({counts})"
    width = max([len(x.name) for x in checks] + [8])
    lines = [head]
    for x in checks:
        lines.append(f"{_TAGS[x.status]} {x.name.ljust(width)}  {x.detail}")
        if x.status != PASS and x.fix:
            lines.append(f"{' ' * 7}{' ' * width}  next: {x.fix}")
    return _scrub("\n".join(lines), env)


def default_ctx(env: Optional[Mapping[str, str]] = None, **kw) -> Ctx:
    live = env is None
    env = os.environ if live else env

    def video_preflight() -> None:
        from modules import video_providers  # noqa: PLC0415
        video_providers.preflight()

    def channel_rows() -> List[dict]:
        from tools import list_channels  # noqa: PLC0415 - imports the registry; only a live run needs it

        return list_channels.token_rows()

    return Ctx(env=env, http=kw.pop("http", None) or Http(), now=kw.pop("now", None) or datetime.now(timezone.utc),
               preflight_video=kw.pop("preflight_video", video_preflight if live else None),
               channel_rows=kw.pop("channel_rows", channel_rows if live else None), **kw)


def preflight_summary(env: Optional[Mapping[str, str]] = None, **kw) -> Dict[str, Any]:
    """The cheap hook for a run start: offline checks only (configuration, key
    shapes, disk, ffmpeg), no network, never raises.

    ``{"ready": bool, "blocking": [line, ...], "warnings": [line, ...], "text": str}``
    where every line names the problem and its next step. main.py can fail the
    run before it pays for anything when ``ready`` is false."""
    try:
        ctx = default_ctx(env, http=kw.pop("http", None) or Http(), **kw)
        checks = run_checks(ctx, offline=True)
        scrub_env = ctx.env
    except Exception as e:
        return {"ready": True, "blocking": [], "warnings": [f"doctor preflight could not run ({type(e).__name__})"], "text": ""}
    fmt = lambda c: _scrub(f"{c.name}: {c.detail}" + (f" - next: {c.fix}" if c.fix else ""), scrub_env)  # noqa: E731
    blocking = [fmt(c) for c in checks if c.status == FAIL]
    return {"ready": not blocking, "blocking": blocking,
            "warnings": [fmt(c) for c in checks if c.status == WARN], "text": render(checks, scrub_env, offline=True)}


def main(argv: Optional[Sequence[str]] = None) -> int:
    ap = argparse.ArgumentParser(description="Read-only readiness check for the video pipeline (no paid call, no state change).")
    ap.add_argument("--json", action="store_true", help="machine-readable report")
    ap.add_argument("--offline", action="store_true", help="configuration, key shapes and host only; no network")
    ap.add_argument("--no-youtube", action="store_true", help="skip the YouTube token refresh (a free POST, nothing saved)")
    ap.add_argument("--github", action="store_true", help="repo-side view: secret/variable NAMES via the GitHub API (needs a token already in the environment)")
    ap.add_argument("--repo", default=None, help="owner/name for --github")
    args = ap.parse_args(argv)

    try:
        from dotenv import load_dotenv  # noqa: PLC0415
        load_dotenv(ROOT / ".env")
    except Exception:
        pass
    ctx = default_ctx(youtube=not args.no_youtube)
    checks = run_checks(ctx, offline=args.offline, github=args.github, repo=args.repo)
    offline = args.offline and not args.github
    print(to_json(checks, ctx.env, offline) if args.json else render(checks, ctx.env, offline))
    return summarize(checks, offline)["exit_code"]


if __name__ == "__main__":
    sys.exit(main())

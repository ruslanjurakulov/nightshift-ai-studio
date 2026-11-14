"""Voice to video as a creative job (migration 0170, docs/VOICE_EXPLAINER.md): our own engine, no vendor.

A person picks one of their library recordings (their own narration) and a look; the database prices the recording's
measured seconds and holds the credits; the creative worker copies the recording by id and hands it here. This adapter
runs the engine of modules/voice_explainer.py on THIS machine, exactly as tools/voice_to_video.py does with
``--planner rules``:

    transcribe (local Whisper)  ->  fit_words  ->  split_sentences  ->  plan_rules  ->  build_scenes
                                ->  sound_cues  ->  build_props  ->  render (Remotion, VoiceExplainer)

and hands back the mp4. Nothing leaves the machine and no paid model is called: the planner is the deterministic rules
planner. The model planner (one Gemini call) is a later slice: inside a paid job it would be a second provider whose
failure the person pays the hold for, so it is not offered until it is priced and probed on its own.

The contract with the creative bridge (modules/creative_adapters.py) is the synchronous one: the work happens inside
``submit`` and the finished file is the task's one output. The file is not read into memory (a ten-minute render is
hundreds of MB): :class:`FileOutput` names it, and :meth:`fetch` moves it into the job folder. A worker that restarts
between the two has lost it; the job fails ``output_lost`` and the hold is released (the bridge's rule for every
synchronous adapter).

No silent quality fallback (CLAUDE.md rule 4), and every refusal names its fix (rule 6):

* not ready on this machine (no ``npx``, ``npm ci`` not run in video-engine/, Whisper or its model missing, the sound
  effects missing, a browser override that is not a file) -> ``not_configured`` before anything runs; :meth:`configured`
  is that same check, so the probe and the worker agree on what "installed" means. Never key-based: there is no key.
* a recording longer than the engine holds, unreadable, or with no words in it -> ``bad_request`` (the person's fix);
* Remotion failing -> ``bad_response`` (the engine's fix; its log tail goes to the operator's log, never to the job
  row, because it names this machine's paths); out of time -> ``unavailable`` (a busy machine: retry later).

Every one of those is a failure the worker turns into a released hold. Nothing here ever renders "something else":
there is no second planner, no default look, no video without its narration.

ONE render at a time per process (``_RENDER_LOCK``): the creative worker runs several jobs on threads, and one render
already holds a headless Chrome, Node and ffmpeg; two would race for the container's memory (docs/VOICE_EXPLAINER.md,
"Capacity").
"""

from __future__ import annotations

import importlib.util
import logging
import os
import shutil
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, List, Mapping, Optional, Sequence

from modules import voice_explainer as ve
from modules.capabilities.base import (
    E_BAD_REQUEST,
    E_BAD_RESPONSE,
    E_NOT_CONFIGURED,
    E_NOT_FOUND,
    E_UNAVAILABLE,
    EXPLAINER_LOOKS,
    VOICE_EXPLAINER,
    AdapterError,
    CapabilityRequest,
    HttpAdapter,
    Output,
    PollResult,
    ProviderTask,
)

logger = logging.getLogger(__name__)

#: The one engine build this adapter runs: the rules planner over the VoiceExplainer composition. The registry's
#: vendor_model must name it; a registry that names another (a model planner, a new engine) is refused before
#: anything runs, so a probe of one is never read as a proof of the other.
RULES_ENGINE = "voice-explainer-rules-1"
#: The Whisper model the transcription loads (modules/subtitle_generator.WHISPER_MODEL), as a file name.
WHISPER_FILE = "base.pt"
#: Where the worker image keeps a copy of that model every user can read (Dockerfile.worker). The creative worker runs
#: as another user than the pipeline, with HOME on a tmpfs, so Whisper's default cache would be empty there and it
#: would download the model in the middle of a paid job.
SHARED_WHISPER_DIR = Path("/opt/whisper-cache/whisper")
SFX_DIR = Path(__file__).resolve().parents[2] / "assets" / "sfx"
#: The browser override the pipeline's renderer already reads (modules/remotion_renderer.py). Unset = Remotion's own
#: headless shell, which the image downloads at build time (`npx remotion browser ensure`).
BROWSER_ENV = "CHRONOS_REMOTION_BROWSER"
#: Seconds a render may take: a floor for the bundle and the browser's start, plus a multiple of the recording. The
#: measured rate is ~2.7 s of render per second of narration with one worker on 4 cores (docs/VOICE_EXPLAINER.md).
RENDER_TIMEOUT_FLOOR_S = 600
RENDER_TIMEOUT_PER_SECOND = 6

_RENDER_LOCK = threading.Lock()


@dataclass
class FileOutput(Output):
    """A finished file on this machine's disk, moved (never copied into memory) by :meth:`VoiceVideoAdapter.fetch`."""
    path: Optional[Path] = None


def default_whisper_dir() -> Path:
    """Whisper's own default download root (``whisper.load_model`` with no ``download_root``)."""
    cache = os.getenv("XDG_CACHE_HOME", os.path.join(os.path.expanduser("~"), ".cache"))
    return Path(cache) / "whisper"


def whisper_root(dirs: Sequence[Path]) -> Optional[Path]:
    """The first of ``dirs`` that holds the model. The same file wherever it is found: a place to look, not another model."""
    for d in dirs:
        if (Path(d) / WHISPER_FILE).is_file():
            return Path(d)
    return None


def whisper_transcribe(audio: Path, work_dir: Path, download_root: Path) -> list:
    """Whisper's words for ``audio`` (``[{word, start, end}]``), through the pipeline's own SubtitleGenerator, and its
    model released before the render starts (the render needs the memory)."""
    from modules.subtitle_generator import SubtitleGenerator  # noqa: PLC0415 — loads torch + whisper

    gen = SubtitleGenerator("voice-video", work_dir=work_dir, download_root=str(download_root))
    try:
        return gen.transcribe(audio)
    finally:
        gen.release_model()


class VoiceVideoAdapter(HttpAdapter):
    """``video.voice_explainer``: a narration in, a 1080x1920 explainer out, drawn here."""

    key = "video.voice_explainer"
    key_env = ()
    capabilities = (VOICE_EXPLAINER,)
    timeout = 60

    def __init__(self, *, env: Optional[Mapping[str, str]] = None, session=None,
                 engine_dir: Optional[Path] = None, sfx_dir: Optional[Path] = None,
                 whisper_dirs: Optional[Sequence[Path]] = None,
                 transcribe: Optional[Callable[[Path, Path, Path], list]] = None,
                 render: Optional[Callable[..., Path]] = None,
                 has_npx: Optional[Callable[[], bool]] = None,
                 whisper_installed: Optional[Callable[[], bool]] = None):
        super().__init__(env=env, session=session)
        self.engine_dir = Path(engine_dir) if engine_dir is not None else ve.ENGINE_DIR
        self.sfx_dir = Path(sfx_dir) if sfx_dir is not None else SFX_DIR
        self.whisper_dirs = tuple(whisper_dirs) if whisper_dirs is not None else (default_whisper_dir(), SHARED_WHISPER_DIR)
        self._transcribe = transcribe or whisper_transcribe
        self._render = render or ve.render
        self._has_npx = has_npx or (lambda: shutil.which("npx") is not None)
        self._whisper_installed = whisper_installed or (lambda: importlib.util.find_spec("whisper") is not None)

    # -- configuration: the engine, never a key ------------------------------------
    def api_key(self) -> str:
        return ""

    def auth_headers(self):
        return {}

    def browser(self) -> Optional[str]:
        raw = (self._env.get(BROWSER_ENV) or "").strip()
        return raw or None

    def missing(self) -> List[str]:
        """What this machine lacks to render, each with its fix. Cheap: no import of torch, no process started."""
        out: List[str] = []
        if not self._has_npx():
            out.append("npx is not on PATH: install Node 22 (the worker image does)")
        if not (self.engine_dir / "node_modules" / "remotion").is_dir():
            out.append(f"the Remotion engine is not installed: run `npm ci` in {self.engine_dir.name}/")
        browser = self.browser()
        if browser and not Path(browser).is_file():
            out.append(f"{BROWSER_ENV} does not point at a file: unset it to use Remotion's own browser")
        if not self._whisper_installed():
            out.append("Whisper is not installed: `pip install -r requirements.txt`")
        elif whisper_root(self.whisper_dirs) is None:
            out.append(f"the Whisper {WHISPER_FILE.split('.')[0]} model is not on this machine: the worker image bakes it in "
                       "(Dockerfile.worker)")
        try:
            ve.find_sfx(self.sfx_dir)
        except ve.ExplainerError:
            out.append("the sound effects (whoosh, deep_boom) are missing: run `python tools/generate_assets.py`")
        return out

    def configured(self) -> bool:
        return not self.missing()

    def require_key(self) -> None:
        missing = self.missing()
        if missing:
            raise AdapterError(E_NOT_CONFIGURED, "; ".join(missing), not_accepted=True)

    # -- the job ----------------------------------------------------------------------
    def submit(self, request: CapabilityRequest, vendor_model: str) -> ProviderTask:
        # Everything cheap first (rule 6): nothing below this block has run when one of these refuses.
        self.require_key()
        if vendor_model != RULES_ENGINE:
            raise AdapterError(E_NOT_FOUND, f"this worker runs {RULES_ENGINE}, not {vendor_model}: the registry entry is "
                                            "ahead of the code", not_accepted=True)
        if request.capability != VOICE_EXPLAINER:
            raise AdapterError(E_BAD_REQUEST, f"adapter {self.key} cannot do {request.capability}", not_accepted=True)
        if request.look not in EXPLAINER_LOOKS:
            raise AdapterError(E_BAD_REQUEST, f"look {request.look or '(none)'} is not one of {', '.join(EXPLAINER_LOOKS)}",
                               not_accepted=True)
        if len(request.input_media) != 1:
            raise AdapterError(E_BAD_REQUEST, "a voice video starts from exactly one recording", not_accepted=True)
        src = Path(request.input_media[0])
        if not src.is_file():
            raise AdapterError(E_BAD_REQUEST, "the recording was not copied to this worker", not_accepted=True)
        root = whisper_root(self.whisper_dirs)
        # The job's own folder (the recording's copy sits in it), on the same volume: never the tmpfs.
        work = src.parent / "voice-video"
        with _RENDER_LOCK:
            try:
                out = self._make(src, request.look, work, root)
            except BaseException:
                shutil.rmtree(work, ignore_errors=True)
                raise
        return ProviderTask(adapter=self.key, vendor_model=vendor_model, task_id=None,
                            outputs=[FileOutput(mime="video/mp4", path=out)])

    def _make(self, src: Path, look: str, work: Path, whisper_dir: Path) -> Path:
        work.mkdir(parents=True, exist_ok=True)
        try:
            duration = ve.audio_seconds(src)
        except ve.ExplainerError:
            raise AdapterError(E_BAD_REQUEST, "the recording could not be read as audio: upload it again as MP3, M4A or WAV",
                               not_accepted=True) from None
        if duration > ve.MAX_SECONDS:
            raise AdapterError(E_BAD_REQUEST, f"the recording is {duration:.0f} s; a voice video takes up to "
                                              f"{ve.MAX_SECONDS:.0f} s: trim it first", not_accepted=True)
        try:
            raw = self._transcribe(src, work, whisper_dir)
        except AdapterError:
            raise
        except Exception as e:  # the engine's own failure, named (never "no words")
            raise AdapterError(E_BAD_RESPONSE, f"the transcription failed ({type(e).__name__})", not_accepted=True) from None
        words = ve.normalize_words(raw if isinstance(raw, list) else [])
        if not words:
            raise AdapterError(E_BAD_REQUEST, "no words were heard in the recording: a voice video needs speech "
                                              "(is it a narration, and loud enough?)", not_accepted=True)
        try:
            words = ve.fit_words(words, duration)
            sentences = ve.split_sentences(words)
            plans = ve.plan_rules(sentences)
            scenes = ve.build_scenes(sentences, plans, duration)
            cues, files = ve.sound_cues(scenes, self.sfx_dir)
            narration = f"narration{src.suffix.lower() or '.audio'}"
            files[narration] = src
            props = ve.build_props(look=look, duration_s=duration, words=words, scenes=scenes, narration=narration,
                                   sfx=cues, captions=True)
        except ve.ExplainerError as e:
            raise AdapterError(E_BAD_REQUEST, f"the recording cannot be made into a video: {e}"[:500], not_accepted=True) from None
        out = work / "voice_video.mp4"
        timeout = RENDER_TIMEOUT_FLOOR_S + RENDER_TIMEOUT_PER_SECOND * duration
        logger.info("voice video: %d words, %d scenes, %.1f s, look %s: rendering", len(words), len(scenes), duration, look)
        try:
            self._render(props, out, files=files, engine_dir=self.engine_dir, browser=self.browser(), timeout_s=timeout,
                         tmp_dir=work / "tmp")
        except ve.RenderTimeout:
            raise AdapterError(E_UNAVAILABLE, f"the render took longer than {timeout:.0f} s and was stopped; nothing was "
                                              "charged: try again later", not_accepted=True) from None
        except ve.ExplainerError as e:
            # The tail names this machine's paths: the operator's log, never the job row.
            logger.warning("voice video: the render failed: %s", self.message(str(e)))
            raise AdapterError(E_BAD_RESPONSE, "the render failed on the worker; nothing was charged",
                               not_accepted=True) from None
        if not out.is_file() or out.stat().st_size == 0:
            raise AdapterError(E_BAD_RESPONSE, "the render produced no video; nothing was charged", not_accepted=True)
        shutil.rmtree(work / "tmp", ignore_errors=True)
        return out

    def fetch(self, result: PollResult, out_dir, stem: str = "output") -> List[Path]:
        """The rendered file moved into ``out_dir`` (same volume: a rename, never a copy through memory)."""
        out_dir = Path(out_dir)
        out_dir.mkdir(parents=True, exist_ok=True)
        paths: List[Path] = []
        for i, item in enumerate(result.outputs):
            if not isinstance(item, FileOutput) or item.path is None:
                return super().fetch(result, out_dir, stem)
            src = Path(item.path)
            if not src.is_file() or src.stat().st_size == 0:
                raise AdapterError(E_BAD_RESPONSE, "the rendered video is gone from the worker")
            dest = out_dir / f"{stem}_{i}.mp4"
            shutil.move(str(src), dest)
            shutil.rmtree(src.parent, ignore_errors=True)
            paths.append(dest)
        return paths


ADAPTERS = (VoiceVideoAdapter,)

"""Voice to video as a creative job (migration 0176, docs/VOICE_EXPLAINER.md): our own engine, no vendor.

A person picks one of their library recordings (their own narration) and a look; the database prices the recording's
measured seconds and holds the credits; the creative worker copies the recording by id and hands it here. This adapter
runs the engine of modules/voice_explainer.py on THIS machine, exactly as tools/voice_to_video.py does with
``--planner rules``:

    decode to WAV (ffmpeg)  ->  transcribe (local Whisper)  ->  fit_words  ->  split_sentences  ->  plan_rules
                            ->  build_scenes  ->  sound_cues  ->  build_props  ->  render (Remotion, VoiceExplainer)

and hands back the mp4. Nothing leaves the machine and no paid model is called: the planner is the deterministic rules
planner. The model planner (one Gemini call) is a later slice: inside a paid job it would be a second provider whose
failure the person pays the hold for, so it is not offered until it is priced and probed on its own.

The contract with the creative bridge (modules/creative_adapters.py) is the synchronous one: the work happens inside
``submit`` and the finished file is the task's one output. The file is not read into memory (a ten-minute render is
hundreds of MB): :class:`FileOutput` names it, and :meth:`fetch` moves it into the job folder. A worker that restarts
between the two has lost it; the job fails ``output_lost`` and the hold is released (the bridge's rule for every
synchronous adapter).

No silent quality fallback (CLAUDE.md rule 4), and every refusal names its fix (rule 6):

* not ready on this machine (no ``npx``, ``ffmpeg`` or ``ffprobe``, ``npm ci`` not run in video-engine/, Remotion's
  browser not downloaded or a browser override that is not a file, Whisper or its model missing, the sound effects
  missing, the Inter face not installed) -> ``not_configured`` before anything runs; :meth:`configured` is that same
  check, so the probe and the worker agree on what "installed" means. Never key-based: there is no key.
* a recording that does not decode, decodes to another length than the library measured (and the job was priced on),
  is longer than the engine holds, or has no words in it -> ``bad_request`` (the person's fix);
* Remotion failing -> ``bad_response`` (the engine's fix; its log tail goes to the operator's log, never to the job
  row, because it names this machine's paths); out of time, another render in this process, or the worker told to
  stop -> ``unavailable`` (retry later).

The recording is decoded to WAV in the job's own folder FIRST, and only that copy is measured, transcribed and rendered.
A browser recording (MediaRecorder's ``audio/webm;codecs=opus``) is written as a stream and carries no duration in its
header: read directly, ffprobe has no length for it and Remotion cannot seek in it. The decoded copy has both.

Every one of those is a failure the worker turns into a released hold. Nothing here ever renders "something else":
there is no second planner, no look chosen here (the job's look is the one the database checked; the Studio sends the
chip the person sees pressed), no video without its narration.

ONE render at a time per process. The creative worker takes its slot for this capability BEFORE the job is marked
'submitting' (modules/creative_worker.py SERIAL_CAPABILITIES), so a second voice video waits claimed but unsent, and
can still be cancelled, while vendor jobs keep the other threads. ``_RENDER_LOCK`` here is the last guard for any other
caller: it is never waited on; a second render in the same process is refused ``unavailable``, nothing charged.

On a stop (``base.SHUTDOWN``, set on SIGTERM) the render's process group is killed and the job fails ``unavailable`` at
once, its hold released, instead of rendering on until Docker kills the container after its grace period.
"""

from __future__ import annotations

import importlib.util
import logging
import os
import shutil
import signal
import subprocess
import sys
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
    SHUTDOWN,
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
#: measured rate is ~3.4 s of render per second of narration on 4 cores (docs/VOICE_EXPLAINER.md, "Capacity").
RENDER_TIMEOUT_FLOOR_S = 600
RENDER_TIMEOUT_PER_SECOND = 6
#: The decoded copy every later step reads (the render's public name too).
NARRATION_FILE = "narration.wav"
#: Seconds the decode may take: ten minutes of any codec decode in seconds on one core; more is a stuck machine.
DECODE_TIMEOUT_S = 300
#: How far the decoded length may be from the library's measurement before the file is not the one that was priced.
LENGTH_TOLERANCE_S = 1.0
#: How often a render checks whether the worker was told to stop, and how long it waits for the killed tree to go.
STOP_POLL_S = 0.5
KILL_WAIT_S = 30
#: The face the looks are set in (video-engine/src/explainer/looks.ts: Inter first). Chrome finds fonts through
#: fontconfig, so fontconfig's own answer is what decides whether the video is set in Inter or quietly in a fallback.
FONT_FAMILY = "Inter"

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


def whisper_importable() -> bool:
    """Whether ``import whisper`` would work, without importing torch.

    ``find_spec`` raises ValueError when ``sys.modules`` already holds a ``whisper`` with no ``__spec__`` (a module made at
    run time, as a test double is): that module IS what ``import whisper`` returns, so it counts as present."""
    try:
        return importlib.util.find_spec("whisper") is not None
    except (ValueError, ImportError):
        return sys.modules.get("whisper") is not None


def installed_family(name: str = FONT_FAMILY) -> Optional[str]:
    """The family fontconfig answers for ``name`` (``fc-match``), or None when fontconfig cannot be asked."""
    exe = shutil.which("fc-match")
    if exe is None:
        return None
    try:
        out = subprocess.run([exe, "-f", "%{family}", name], capture_output=True, text=True, timeout=10)
    except (OSError, subprocess.SubprocessError):
        return None
    return out.stdout.strip() if out.returncode == 0 else None


def decode_to_wav(src: Path, dst: Path) -> None:
    """The recording's first audio stream as a PCM WAV at ``dst`` (its own rate and channels). Raises AdapterError, named:
    no ffmpeg is the operator's fix, a file that does not decode is the person's."""
    cmd = ["ffmpeg", "-nostdin", "-v", "error", "-y", "-i", str(src), "-map", "0:a:0", "-vn", "-c:a", "pcm_s16le", str(dst)]
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=DECODE_TIMEOUT_S)
    except FileNotFoundError:
        raise AdapterError(E_NOT_CONFIGURED, "ffmpeg is not on PATH on this worker (the worker image installs it); nothing "
                                             "was charged", not_accepted=True) from None
    except subprocess.TimeoutExpired:
        raise AdapterError(E_UNAVAILABLE, f"decoding the recording took longer than {DECODE_TIMEOUT_S} s and was stopped; "
                                          "nothing was charged: try again later", not_accepted=True) from None
    except OSError as e:
        raise AdapterError(E_NOT_CONFIGURED, f"ffmpeg could not be started on this worker ({type(e).__name__}); nothing was "
                                             "charged", not_accepted=True) from None
    # A WAV header alone is 44 bytes: anything that small holds no sound.
    if proc.returncode != 0 or not dst.is_file() or dst.stat().st_size <= 44:
        # ffmpeg's words name this machine's paths: the operator's log, never the job row.
        tail = "\n".join((proc.stderr or "").strip().splitlines()[-4:])
        logger.warning("voice video: ffmpeg could not decode the recording (exit %s): %s", proc.returncode, tail)
        raise AdapterError(E_BAD_REQUEST, "the recording could not be decoded as sound (the file is damaged or holds no "
                                          "audio); nothing was charged: export it again as MP3, M4A or WAV and upload "
                                          "that", not_accepted=True)


def _kill_group(proc) -> None:
    """The whole tree of a render (npx, node, the headless Chrome): it was started in its own process group."""
    try:
        os.killpg(proc.pid, signal.SIGKILL)
    except (ProcessLookupError, PermissionError):
        pass


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
                 whisper_installed: Optional[Callable[[], bool]] = None,
                 which: Optional[Callable[[str], Optional[str]]] = None,
                 font_family: Optional[Callable[[], Optional[str]]] = None,
                 decode: Optional[Callable[[Path, Path], None]] = None,
                 stop: Optional[threading.Event] = None):
        super().__init__(env=env, session=session)
        self.engine_dir = Path(engine_dir) if engine_dir is not None else ve.ENGINE_DIR
        self.sfx_dir = Path(sfx_dir) if sfx_dir is not None else SFX_DIR
        self.whisper_dirs = tuple(whisper_dirs) if whisper_dirs is not None else (default_whisper_dir(), SHARED_WHISPER_DIR)
        self._transcribe = transcribe or whisper_transcribe
        self._render = render or ve.render
        self._which = which or shutil.which
        self._has_npx = has_npx or (lambda: self._which("npx") is not None)
        self._whisper_installed = whisper_installed or whisper_importable
        self._font_family = font_family or installed_family
        self._decode = decode or decode_to_wav
        self._stop = stop if stop is not None else SHUTDOWN

    # -- configuration: the engine, never a key ------------------------------------
    def api_key(self) -> str:
        return ""

    def auth_headers(self):
        return {}

    def browser(self) -> Optional[str]:
        raw = (self._env.get(BROWSER_ENV) or "").strip()
        return raw or None

    def missing(self) -> List[str]:
        """What this machine lacks to render, each with its fix. Cheap: no import of torch; one ``fc-match`` call.

        Every part the render needs is checked, so nothing falls back silently (CLAUDE.md rule 4): Chrome without the
        Inter face sets the words in another one, and a missing browser would make Remotion download one mid-job."""
        out: List[str] = []
        if not self._has_npx():
            out.append("npx is not on PATH: install Node 22 (the worker image does)")
        for tool in ("ffmpeg", "ffprobe"):
            if self._which(tool) is None:
                out.append(f"{tool} is not on PATH: install ffmpeg (the worker image does)")
        if not (self.engine_dir / "node_modules" / "remotion").is_dir():
            out.append(f"the Remotion engine is not installed: run `npm ci` in {self.engine_dir.name}/")
        browser = self.browser()
        if browser and not Path(browser).is_file():
            out.append(f"{BROWSER_ENV} does not point at a file: unset it to use Remotion's own browser")
        elif not browser and not (self.engine_dir / "node_modules" / ".remotion").is_dir():
            out.append(f"Remotion's headless browser is not downloaded: run `npx remotion browser ensure` in "
                       f"{self.engine_dir.name}/ (the worker image does), or point {BROWSER_ENV} at a Chrome")
        if not self._whisper_installed():
            out.append("Whisper is not installed: `pip install -r requirements.txt`")
        elif whisper_root(self.whisper_dirs) is None:
            out.append(f"the Whisper {WHISPER_FILE.split('.')[0]} model is not on this machine: the worker image bakes it in "
                       "(Dockerfile.worker)")
        try:
            ve.find_sfx(self.sfx_dir)
        except ve.ExplainerError:
            out.append("the sound effects (whoosh, deep_boom) are missing: run `python tools/generate_assets.py`")
        family = self._font_family()
        if family is None:
            out.append(f"fontconfig's fc-match is not installed, so the {FONT_FAMILY} face cannot be checked: install "
                       "fontconfig (the worker image does)")
        elif family.split(",")[0].strip().lower() != FONT_FAMILY.lower():
            out.append(f"the {FONT_FAMILY} font is not installed (fontconfig answers {family.split(',')[0].strip()[:40]!r}): "
                       "install fonts-inter (the worker image does), or the words would be set in a fallback face")
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
        # Never waited on: the worker's slot already serialises its own jobs (module doc), so a held lock is another
        # caller in this process, and waiting would hold this job in 'submitting' where it can no longer be cancelled.
        if not _RENDER_LOCK.acquire(blocking=False):
            raise AdapterError(E_UNAVAILABLE, "another voice video is rendering on this worker; nothing was charged: try "
                                              "again in a few minutes", not_accepted=True)
        try:
            out = self._make(src, request, work, root)
        except BaseException:
            shutil.rmtree(work, ignore_errors=True)
            raise
        finally:
            _RENDER_LOCK.release()
        return ProviderTask(adapter=self.key, vendor_model=vendor_model, task_id=None,
                            outputs=[FileOutput(mime="video/mp4", path=out)])

    def _check_stop(self, when: str) -> None:
        if self._stop.is_set():
            raise AdapterError(E_UNAVAILABLE, f"the worker was stopped {when}; nothing was charged: start it again",
                               not_accepted=True)

    def _make(self, src: Path, request: CapabilityRequest, work: Path, whisper_dir: Path) -> Path:
        look = str(request.look)
        work.mkdir(parents=True, exist_ok=True)
        self._check_stop("before this video was made")
        wav = work / NARRATION_FILE
        self._decode(src, wav)
        try:
            duration = ve.audio_seconds(wav)
        except ve.ExplainerError:
            # The decode just wrote this file: not measuring it is this machine's fault, not the recording's.
            raise AdapterError(E_BAD_RESPONSE, "the worker decoded the recording but could not measure it; nothing was "
                                               "charged", not_accepted=True) from None
        priced = request.source_seconds
        if priced is not None and abs(duration - float(priced)) > LENGTH_TOLERANCE_S:
            # The job was priced on the library's length: a file of another length is not the recording that was sold.
            raise AdapterError(E_BAD_REQUEST, f"the recording decodes to {duration:.1f} s but the library measured "
                                              f"{float(priced):.1f} s, the length it was priced on; nothing was charged: "
                                              "export it again as MP3, M4A or WAV and upload that", not_accepted=True)
        if duration > ve.MAX_SECONDS:
            raise AdapterError(E_BAD_REQUEST, f"the recording is {duration:.0f} s; a voice video takes up to "
                                              f"{ve.MAX_SECONDS:.0f} s: trim it first", not_accepted=True)
        try:
            raw = self._transcribe(wav, work, whisper_dir)
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
            files[NARRATION_FILE] = wav
            props = ve.build_props(look=look, duration_s=duration, words=words, scenes=scenes, narration=NARRATION_FILE,
                                   sfx=cues, captions=True)
        except ve.ExplainerError as e:
            raise AdapterError(E_BAD_REQUEST, f"the recording cannot be made into a video: {e}"[:500], not_accepted=True) from None
        out = work / "voice_video.mp4"
        timeout = RENDER_TIMEOUT_FLOOR_S + RENDER_TIMEOUT_PER_SECOND * duration
        self._check_stop("before this video was rendered")
        logger.info("voice video: %d words, %d scenes, %.1f s, look %s: rendering", len(words), len(scenes), duration, look)
        try:
            self._render_until_stopped(props, out, files=files, engine_dir=self.engine_dir, browser=self.browser(),
                                       timeout_s=timeout, tmp_dir=work / "tmp")
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
        wav.unlink(missing_ok=True)
        return out

    def _render_until_stopped(self, props: dict, out: Path, **kw) -> None:
        """The render, on a thread this one watches: when the worker is told to stop, the render's process group is
        killed and the job fails ``unavailable`` now (hold released), not after Docker's SIGKILL and the stale sweep."""
        procs: list = []
        box: dict = {}

        def spawned(proc) -> None:
            procs.append(proc)
            if self._stop.is_set():  # the stop came while the render was still copying its files
                _kill_group(proc)

        def run() -> None:
            try:
                self._render(props, out, on_spawn=spawned, **kw)
            except BaseException as e:  # handed to the watching thread, raised there
                box["error"] = e

        t = threading.Thread(target=run, name="voice-video-render", daemon=True)
        t.start()
        while True:
            t.join(STOP_POLL_S)
            if not t.is_alive() or self._stop.is_set():
                break
        if self._stop.is_set() and (t.is_alive() or "error" in box):
            # Killed here, or by `spawned` before this loop looked: either way the stop ended it, not the engine.
            for proc in list(procs):
                _kill_group(proc)
            t.join(KILL_WAIT_S)
            out.unlink(missing_ok=True)
            logger.warning("voice video: the worker was told to stop; the render was killed")
            raise AdapterError(E_UNAVAILABLE, "the worker was stopped while this video was rendering; nothing was "
                                              "charged: start it again", not_accepted=True)
        if "error" in box:
            raise box["error"]

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

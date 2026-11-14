"""Voice to video as a creative job (migration 0176, docs/VOICE_EXPLAINER.md): our own engine, one vendor call.

A person picks one of their library recordings (their own narration) and a look; the database prices the recording's
measured seconds and holds the credits; the creative worker copies the recording by id and hands it here. This adapter
runs the engine of modules/voice_explainer.py on THIS machine, exactly as tools/voice_to_video.py does with
``--planner rules``, except that the words come from ElevenLabs speech-to-text (Scribe) instead of local Whisper:

    decode to WAV (ffmpeg)  ->  a 16 kHz mono copy  ->  transcribe (ElevenLabs Scribe, one synchronous call)
        ->  clean the words (modules/captions)  ->  fit_words  ->  split_sentences  ->  plan_rules
        ->  build_scenes  ->  sound_cues  ->  build_props  ->  render (Remotion, VoiceExplainer)

and hands back the mp4. The transcription is the one paid vendor call (owner decision 2026-11-14: it takes Whisper's CPU
and memory off the render machine, and Uzbek is the weakest of Whisper ``base``'s languages; how much better Scribe reads
it on our recordings is measured by tools/stt_compare.py, not assumed here). It is the same endpoint, form and word
cleaning the captions job uses (modules/capabilities/audio.py ``scribe_form``, 0072), and only the 16 kHz mono copy is
sent (600 s is about 19 MB), named by the worker, never by the uploader. Which Scribe model is sent is pinned by the
registry's vendor model: ``voice-explainer-rules-2`` is this engine with ``scribe_v2``, so a change of either is a new
vendor model and clears the probe (model_registry_guard), never a quiet swap under a proof of the old one.

The planner is the deterministic rules planner. The model planner (one Gemini call) is a later slice: inside a paid job it
would be a second provider whose failure the person pays the hold for, so it is not offered until it is priced and probed
on its own.

The contract with the creative bridge (modules/creative_adapters.py) is the synchronous one: the work happens inside
``submit`` and the finished file is the task's one output. The file is not read into memory (a ten-minute render is
hundreds of MB): :class:`FileOutput` names it, and :meth:`fetch` moves it into the job folder. A worker that restarts
between the two has lost it; the job fails ``output_lost`` and the hold is released (the bridge's rule for every
synchronous adapter).

No silent quality fallback (CLAUDE.md rule 4), and every refusal names its fix (rule 6):

* not ready on this machine (no ``npx``, ``ffmpeg`` or ``ffprobe``, ``npm ci`` not run in video-engine/, Remotion's
  browser not downloaded or a browser override that is not a file, the sound effects missing, the Inter face not
  installed, no ``ELEVENLABS_API_KEY`` in the worker's env) -> ``not_configured`` before anything runs; :meth:`configured`
  is that same check, so the probe and the worker agree on what "ready" means;
* there is NO fallback to local Whisper (CLAUDE.md rule 4): ElevenLabs refusing or unreachable fails the job, the hold is
  released, and the error names the fix by the vendor's own word, not its HTTP status (rule 6): a rejected key is
  ``auth`` (set the key), an account out of credits is ``quota`` (top up ElevenLabs), rate or concurrency limits are
  ``rate_limited`` and a busy or unreachable service ``unavailable`` (both: try again later);
* a recording that does not decode, decodes to another length than the library measured (and the job was priced on),
  is longer than the engine holds, or has no words in it -> ``bad_request`` (the person's fix). "No words" is the
  adapter's own refusal of an empty transcript, never a vendor fault; words that come back without times are a vendor
  fault (``bad_response``) when none has them, and are left out (as captions do) when only some lack them;
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
once, its hold released, instead of rendering on until Docker kills the container after its grace period. The
transcription is watched the same way: it runs on a thread this one polls, so a stop (or its own time limit, which grows
with the recording) fails the job at once instead of holding the worker's 60 s grace on one HTTP request.

The key lives in the worker's env only (``ELEVENLABS_API_KEY``, the same name every ElevenLabs adapter reads); it is sent
in the ``xi-api-key`` header, scrubbed from every message, and no message here ever quotes the vendor's text.
"""

from __future__ import annotations

import logging
import math
import os
import shutil
import signal
import subprocess
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, List, Mapping, Optional

import requests

from modules import captions as caption_words
from modules import voice_explainer as ve
from modules.capabilities.audio import (
    SCRIBE_PATH,
    _ElevenLabs,
    elevenlabs_error_code,
    elevenlabs_error_word,
    scribe_form,
)
from modules.capabilities.base import (
    E_AUTH,
    E_BAD_REQUEST,
    E_BAD_RESPONSE,
    E_NOT_CONFIGURED,
    E_NOT_FOUND,
    E_POLICY,
    E_QUOTA,
    E_RATE_LIMITED,
    E_UNAVAILABLE,
    EXPLAINER_LOOKS,
    SHUTDOWN,
    VOICE_EXPLAINER,
    AdapterError,
    CapabilityRequest,
    Output,
    PollResult,
    ProviderTask,
    classify_http,
    refused_outright,
    scrub,
)

logger = logging.getLogger(__name__)

#: The one engine build this adapter runs: the rules planner over the VoiceExplainer composition, its words from
#: ElevenLabs Scribe (:data:`SCRIBE_MODEL`). The registry's vendor_model must name it; a registry that names another (a
#: model planner, a new engine, another transcription model) is refused before anything runs, so a probe of one is never
#: read as a proof of the other. ``voice-explainer-rules-1`` was the same engine with local Whisper ``base``.
RULES_ENGINE = "voice-explainer-rules-2"
#: The Scribe model this engine build sends, the one the captions job sends too (registry ``elevenlabs-scribe-v2``).
#: Changing it is a new :data:`RULES_ENGINE` (and so a new probe): the transcription decides every word on screen.
SCRIBE_MODEL = "scribe_v2"
#: The env name of the key, the one every ElevenLabs adapter reads (the deploy writes it to the worker's env file).
KEY_ENV = "ELEVENLABS_API_KEY"
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
#: The copy that is sent for transcription: 16 kHz mono 16-bit PCM, enough for speech and small (600 s is about 19 MB
#: instead of the 115 MB of a 48 kHz stereo narration). The narration itself is rendered at its own rate.
SPEECH_FILE = "speech.wav"
SPEECH_RATE = 16000
#: Seconds the transcription may take: a floor for the upload and the queue, plus a share of the recording, capped. Past
#: it the job fails ``unavailable`` (try again later) rather than hold the render slot on one request.
SCRIBE_TIMEOUT_FLOOR_S = 60
SCRIBE_TIMEOUT_PER_SECOND = 0.5
SCRIBE_TIMEOUT_MAX_S = 420
#: How far past that limit the watching thread gives up on its own, so the request's own (better-named) timeout comes first.
SCRIBE_GRACE_S = 5.0
#: Every non-2xx answer of the transcription is read here (its own word decides the code), never by the shared plumbing.
_EVERY_REFUSAL = tuple(range(300, 600))
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


def scribe_timeout(duration_s: float) -> float:
    """Seconds the transcription of a ``duration_s`` recording may take (:data:`SCRIBE_TIMEOUT_FLOOR_S` and after)."""
    return min(SCRIBE_TIMEOUT_MAX_S, SCRIBE_TIMEOUT_FLOOR_S + SCRIBE_TIMEOUT_PER_SECOND * max(0.0, float(duration_s)))


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


def decode_to_wav(src: Path, dst: Path, *, rate: Optional[int] = None, channels: Optional[int] = None) -> None:
    """The recording's first audio stream as a PCM WAV at ``dst``: its own rate and channels, or the ones named (the copy
    sent for transcription). Raises AdapterError, named: no ffmpeg is the operator's fix, a file that does not decode is
    the person's."""
    shape = (["-ar", str(int(rate))] if rate else []) + (["-ac", str(int(channels))] if channels else [])
    cmd = ["ffmpeg", "-nostdin", "-v", "error", "-y", "-i", str(src), "-map", "0:a:0", "-vn", *shape, "-c:a", "pcm_s16le",
           str(dst)]
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


def _seconds(v: Any) -> Optional[float]:
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        return None
    f = float(v)
    return f if math.isfinite(f) else None


#: What each of our codes asks a person to do about a failed transcription (CLAUDE.md rule 6).
_SCRIBE_FIX = {
    E_AUTH: f"ElevenLabs refused the key: set a valid {KEY_ENV} for the creative worker (the repository secret, then "
            "Deploy web)",
    E_QUOTA: "the ElevenLabs account is out of credits, or its plan does not include speech-to-text: top up ElevenLabs "
             "(or change the plan), then try again",
    E_RATE_LIMITED: "ElevenLabs is limiting requests on this account right now: try again in a few minutes",
    E_UNAVAILABLE: "ElevenLabs speech-to-text is busy or could not be reached: try again later",
    E_BAD_REQUEST: "ElevenLabs could not read the recording: export it again as MP3, M4A or WAV and upload that",
    E_NOT_FOUND: "ElevenLabs does not know this address or model: the worker's ELEVENLABS_BASE_URL or its engine build "
                 "is out of date",
    E_POLICY: "ElevenLabs refused to transcribe this recording",
}


def _scribe_failure(code: str, what: str) -> str:
    fix = _SCRIBE_FIX.get(code, "ElevenLabs answered with something this worker cannot read")
    return f"the transcription failed ({what}); nothing was charged: {fix}"


class VoiceVideoAdapter(_ElevenLabs):
    """``video.voice_explainer``: a narration in, a 1080x1920 explainer out, drawn here, its words heard by Scribe."""

    key = "video.voice_explainer"
    key_env = (KEY_ENV,)
    capabilities = (VOICE_EXPLAINER,)
    timeout = 60
    #: The request carries the key in a header that ``requests`` would forward to wherever a redirect points.
    follow_redirects = False

    def __init__(self, *, env: Optional[Mapping[str, str]] = None, session=None,
                 engine_dir: Optional[Path] = None, sfx_dir: Optional[Path] = None,
                 transcribe: Optional[Callable[[Path, float], list]] = None,
                 render: Optional[Callable[..., Path]] = None,
                 has_npx: Optional[Callable[[], bool]] = None,
                 which: Optional[Callable[[str], Optional[str]]] = None,
                 font_family: Optional[Callable[[], Optional[str]]] = None,
                 decode: Optional[Callable[..., None]] = None,
                 stop: Optional[threading.Event] = None):
        super().__init__(env=env, session=session)
        self.engine_dir = Path(engine_dir) if engine_dir is not None else ve.ENGINE_DIR
        self.sfx_dir = Path(sfx_dir) if sfx_dir is not None else SFX_DIR
        self._transcribe = transcribe or self.scribe
        self._render = render or ve.render
        self._which = which or shutil.which
        self._has_npx = has_npx or (lambda: self._which("npx") is not None)
        self._font_family = font_family or installed_family
        self._decode = decode or decode_to_wav
        self._stop = stop if stop is not None else SHUTDOWN

    # -- configuration: the engine on this machine and the transcription's key ------
    def browser(self) -> Optional[str]:
        raw = (self._env.get(BROWSER_ENV) or "").strip()
        return raw or None

    def missing(self) -> List[str]:
        """What this machine lacks to make a voice video, each with its fix. Cheap: no network; one ``fc-match`` call.

        Every part the job needs is checked, so nothing falls back silently (CLAUDE.md rule 4): Chrome without the Inter
        face sets the words in another one, a missing browser would make Remotion download one mid-job, and without the
        ElevenLabs key there is no transcription (local Whisper is never used instead). Only the key's NAME is ever said."""
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
        if not self.api_key():
            out.append(f"{KEY_ENV} is not set on this worker: the words are transcribed by ElevenLabs speech-to-text (add "
                       "the repository secret; the deploy writes it to the worker's env file)")
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
        # The job's own folder (the recording's copy sits in it), on the same volume: never the tmpfs.
        work = src.parent / "voice-video"
        # Never waited on: the worker's slot already serialises its own jobs (module doc), so a held lock is another
        # caller in this process, and waiting would hold this job in 'submitting' where it can no longer be cancelled.
        if not _RENDER_LOCK.acquire(blocking=False):
            raise AdapterError(E_UNAVAILABLE, "another voice video is rendering on this worker; nothing was charged: try "
                                              "again in a few minutes", not_accepted=True)
        try:
            out = self._make(src, request, work)
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

    def _make(self, src: Path, request: CapabilityRequest, work: Path) -> Path:
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
        speech = work / SPEECH_FILE
        try:
            self._decode(wav, speech, rate=SPEECH_RATE, channels=1)
        except AdapterError as e:
            if e.code != E_BAD_REQUEST:
                raise
            # The worker just wrote the narration it reads here: a copy that fails is this machine's fault, not the recording's.
            raise AdapterError(E_BAD_RESPONSE, "the worker could not prepare the recording for transcription; nothing was "
                                               "charged", not_accepted=True) from None
        self._check_stop("before the recording was transcribed")
        raw = self._transcribe_until_stopped(speech, duration)
        speech.unlink(missing_ok=True)
        words = self._words(raw)
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

    # -- the transcription --------------------------------------------------------------
    def scribe(self, speech: Path, timeout_s: float, *, model: str = SCRIBE_MODEL, language: Optional[str] = None) -> list:
        """The words ElevenLabs Scribe hears in ``speech`` (``[{t, s, e}]``, seconds), one synchronous call. The form is the
        captions job's (``scribe_form``); the job sends :data:`SCRIBE_MODEL` and no language (0176's params carry none, so
        the vendor detects it). ``model`` and ``language`` exist for the measurement (tools/stt_compare.py) only.

        Every refusal is read by the vendor's own word (``detail.code``), never by the HTTP status alone, and turned into
        our code with its fix; the message quotes the status and that word, never the vendor's text."""
        try:
            with open(speech, "rb") as fh:
                resp = self._call("POST", f"{self.base_url}{SCRIBE_PATH}", what="transcribe",
                                  files={"file": (SPEECH_FILE, fh, "audio/wav")}, data=scribe_form(model, language),
                                  timeout=timeout_s, raw=True, ok_statuses=_EVERY_REFUSAL)
        except AdapterError as e:
            # The request did not get an answer (``_call`` names only the exception's class): the vendor may still bill it.
            raise AdapterError(e.code, _scribe_failure(e.code, e.message.split(": ", 1)[-1][:60]), http_status=e.http_status,
                               not_accepted=e.not_accepted) from None
        status = getattr(resp, "status_code", 200)
        if status >= 300:
            text = scrub(getattr(resp, "text", "") or "", self.secrets())
            word = elevenlabs_error_word(text)
            code = elevenlabs_error_code(status, text) or classify_http(status, text)
            raise AdapterError(code, _scribe_failure(code, f"HTTP {status}" + (f", {word}" if word else "")),
                               http_status=status, not_accepted=refused_outright(status, code))
        try:
            body = resp.json()
        except ValueError:
            raise AdapterError(E_BAD_RESPONSE, _scribe_failure(E_BAD_RESPONSE, "the answer is not JSON")) from None
        try:
            _language, heard = caption_words.words_from_vendor(body)
        except caption_words.CaptionsError as e:
            raise AdapterError(E_BAD_RESPONSE, _scribe_failure(E_BAD_RESPONSE, e.message)) from None
        spoken = [w for w in heard if str(w.get("text") or "").strip()]
        timed = [w for w in spoken if _seconds(w.get("start")) is not None and _seconds(w.get("end")) is not None]
        if spoken and not timed:
            # Words with no times cannot be placed: that is the vendor's answer failing, never "no speech", never time 0.
            raise AdapterError(E_BAD_RESPONSE, _scribe_failure(E_BAD_RESPONSE, "the words came back without their times"))
        if len(timed) < len(spoken):
            # The captions job's rule: a word without its time is left out, not guessed. Counted for the operator.
            logger.warning("voice video: %d of %d words came back without their times and were left out",
                           len(spoken) - len(timed), len(spoken))
        return [{"t": w.get("text"), "s": w.get("start"), "e": w.get("end")} for w in timed]

    def _transcribe_until_stopped(self, speech: Path, duration: float) -> list:
        """The transcription, on a thread this one watches: a stop of the worker or the time limit fails the job now
        (``unavailable``, hold released) instead of waiting on the request. The abandoned request may still be answered,
        and billed to the platform; nothing reads that answer, and the person is not charged."""
        limit = scribe_timeout(duration)
        box: dict = {}

        def run() -> None:
            try:
                box["words"] = self._transcribe(speech, limit)
            except BaseException as e:  # handed to the watching thread, raised there
                box["error"] = e

        t = threading.Thread(target=run, name="voice-video-transcribe", daemon=True)
        t.start()
        deadline = time.monotonic() + limit + SCRIBE_GRACE_S
        while t.is_alive():
            t.join(STOP_POLL_S)
            if not t.is_alive():
                break
            if self._stop.is_set():
                logger.warning("voice video: the worker was told to stop; the transcription was abandoned")
                raise AdapterError(E_UNAVAILABLE, "the worker was stopped while the recording was being transcribed; nothing "
                                                  "was charged: start it again")
            if time.monotonic() > deadline:
                if isinstance(self.session, requests.Session):
                    # The abandoned request still holds this session; the next job of this adapter gets its own.
                    self.session = requests.Session()
                raise AdapterError(E_UNAVAILABLE, f"the transcription took longer than {limit:.0f} s and was given up; "
                                                  "nothing was charged: try again later")
        if "error" in box:
            e = box["error"]
            if isinstance(e, AdapterError):
                raise e
            # The transcription's own failure, named by its class (never "no words").
            raise AdapterError(E_BAD_RESPONSE, f"the transcription failed ({type(e).__name__}); nothing was charged")
        return box.get("words") or []

    def _words(self, raw) -> List[ve.Word]:
        """The words the scenes are made of, cleaned as the captions track is (control and bidi characters out, times
        forward, at most 20000 words). The track's end is NOT clamped here: fit_words decides whether it belongs to this
        recording. An empty track is this adapter's own refusal, never the vendor's."""
        try:
            cleaned = caption_words.clean_words(raw if isinstance(raw, list) else [])
        except caption_words.NoSpeech:
            raise AdapterError(E_BAD_REQUEST, "no words were heard in the recording: a voice video needs speech "
                                              "(is it a narration, and loud enough?); nothing was charged",
                               not_accepted=True) from None
        except caption_words.CaptionsError as e:
            raise AdapterError(E_BAD_REQUEST, f"{e.message}; nothing was charged", not_accepted=True) from None
        return ve.normalize_words(cleaned)

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

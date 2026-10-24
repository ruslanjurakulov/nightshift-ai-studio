"""Custom voice: the worker (migration 0117, docs/CUSTOM_VOICE.md). Off unless ``NIGHTSHIFT_VOICE_CLONING=on``.

``voice_clone_jobs`` is the queue; the 0117 functions ``claim_voice_job`` / ``finish_voice_clone`` / ``finish_voice_task`` are the only
way this module reads or writes it (the service key has no privilege on any voice table). Three kinds of job:

* ``clone``: capability, then bytes, then the read-aloud check, then the provider, then deletion of our copy. In this order and
  no other, because each step is cheaper and less irreversible than the next:

  1. **The account's plan is asked first**, before the sample is even fetched (``ensure_plan``: ``can_use_instant_voice_cloning``
     must be a real ``True``). On the documented FREE plan the subscription says ``False`` and every clone job ends, at once, in
     the closed state ``provider_not_enabled``: the profile is rejected with that reason, the sample is purged, nothing was
     spent and no create call was made. A subscription that says NOTHING, a bad key, an outage are the operator's faults, not
     the person's: those jobs are parked (below), not rejected.
  2. The object is fetched from the private bucket with the service key. A redirect is refused (the key must not follow one) and
     the read stops at the bucket's own size limit.
  3. **The bytes are sniffed**, never the declared type. The container must be a known audio one; then ONE decode produces a
     mono 16 kHz wav cut at ``MAX_DECODE_SECONDS`` of audio, by ffmpeg with an empty environment, only the ``file`` protocol,
     the demuxer the bytes named, and time / CPU / memory / file-size limits. Exactly one audio stream and no video. The length is
     measured on THAT wav, so a header that lies about its duration changes nothing, and more than ``MAX_SAMPLE_SECONDS`` is
     ``sample_too_long``. Whisper hears that wav and the provider receives that wav: never the upload.
  4. The phrase is read back with the local Whisper (injected: tests use a fake; a timeout applies) and compared by
     ``voice_profiles.check_transcript``. A wrong phrase is ``verification_failed`` and the provider is never called.
  5. The provider is asked for the voice labelled for THIS profile (full id and owner reference) FIRST and only created when
     there is none: a create that timed out may have made the voice, and a retry must adopt it and never make a second one. A
     voice with the profile's name but another label is a ``provider_conflict``: never adopted, never deleted. Then the id is
     recorded with ``finish_voice_clone``.
  6. Only after the database has accepted that answer is our copy deleted: the whole ``<user_id>/<profile_id>/`` prefix, listed
     and verified empty, unless the owner chose to keep the sample. Only the hash and metadata survive.

* ``delete_provider``: ``DELETE /v1/voices/{id}``; a 404 is "already gone" and counts as done (the adapter does that).
* ``purge_sample``: delete the whole prefix, confirm it is empty, answer ``finish_voice_task``. Idempotent: an empty prefix is done.
  It needs no provider key. For a REJECTED profile that never got a voice recorded it also removes voices labelled for that
  profile from the provider account (the orphan of a create whose answer was lost), because nothing else would.

Parking. The database allows three claims of a job and nothing a service key can call raises that or re-queues a failed job. A
failure that is the operator's or the provider's to fix (and a delete or purge that did not work) is therefore not answered: the
job stays ``running`` and ``claim_voice_job`` returns it after its 30-minute lease, which is the longest wait the existing
functions give (about 90 minutes over the three claims). Only the last claim answers, with the specific word, and a purge or
delete that ends that way is logged as ``voice OVERDUE``. A worker that dies is the same thing: the lease, and after three
losses ``worker_lost`` with its purge queued. Every path that ends a profile queues its purge, and the worker deletes the prefix
twice (right after the answer is recorded, then when that job runs).

Nothing here logs the key, the sample, the phrase or a voice id in full, and no response body is ever copied into an error: a
closed word and an HTTP status are. A redirect from Supabase or ElevenLabs is refused. EVERY Storage and ElevenLabs request shape
is "as the planner knew it, UNVERIFIED live"; nothing in this file has run against a real project or the real provider.
"""

from __future__ import annotations

import contextlib
import json
import logging
import os
import re
import shutil
import signal
import subprocess
import tempfile
import threading
import time
import wave
from contextlib import closing
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Mapping, Optional
from urllib.parse import quote

from modules import voice_profiles as vp

logger = logging.getLogger(__name__)

SWITCH_ENV = "NIGHTSHIFT_VOICE_CLONING"


def enabled(env: Optional[Mapping[str, str]] = None) -> bool:
    """The worker's own switch: OFF unless NIGHTSHIFT_VOICE_CLONING is on. Empty (a repository variable nobody set) is off."""
    env = os.environ if env is None else env
    return str(env.get(SWITCH_ENV, "off")).strip().lower() in ("on", "1", "true", "yes")


BUCKET = "voice-samples"
#: The bucket's own limit (0117), which is also what the provider adapter accepts.
MAX_SAMPLE_BYTES = vp.MAX_SAMPLE_BYTES
#: A read-aloud phrase and a little more; five minutes is far past what a clone needs and keeps Whisper's time bounded.
MAX_SAMPLE_SECONDS = 300.0
#: voice_clone_jobs.max_attempts (0117's default). The database owns the real number; this one decides when to answer and when to park.
MAX_ATTEMPTS = 3
#: The 2-hour upload window and the 30-minute lease are the database's (claim_voice_job); see docs/CUSTOM_VOICE.md.

_UUID = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")
_SAMPLE_NAME = re.compile(r"sample\.[a-z0-9]{1,8}")
KINDS = ("clone", "delete_provider", "purge_sample")


# ── the bytes ────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class Sniffed:
    mime: str
    ext: str


def sniff_audio(head: bytes) -> Optional[Sniffed]:
    """The container the first bytes say it is, or None. The declared type and the file name are never consulted.
    A video container (mp4, webm, ogg) passes here by design: its streams are read by the probe next."""
    h = bytes(head[:32])
    if len(h) < 12:
        return None
    if h[:4] == b"\x1a\x45\xdf\xa3":
        return Sniffed("audio/webm", "webm")
    if h[:4] == b"OggS":
        return Sniffed("audio/ogg", "ogg")
    if h[:4] == b"fLaC":
        return Sniffed("audio/flac", "flac")
    if h[:4] == b"RIFF" and h[8:12] == b"WAVE":
        return Sniffed("audio/wav", "wav")
    if h[4:8] == b"ftyp":
        return Sniffed("audio/mp4", "m4a")
    if h[:3] == b"ID3":
        return Sniffed("audio/mpeg", "mp3")
    if h[0] == 0xFF and (h[1] & 0xE0) == 0xE0:
        if (h[1] & 0xF6) == 0xF0:  # ADTS: layer bits 00
            return Sniffed("audio/aac", "aac")
        version, layer = (h[1] >> 3) & 3, (h[1] >> 1) & 3
        if version != 1 and layer != 0 and (h[2] >> 4) != 0xF and ((h[2] >> 2) & 3) != 3:
            return Sniffed("audio/mpeg", "mp3")
    return None


class AudioRefused(Exception):
    """The sample is refused for a reason that is the recording's own. ``code``: not_audio | unreadable_audio | sample_too_long."""

    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


class AudioToolError(RuntimeError):
    """ffmpeg / ffprobe could not be run at all: the machine's fault, not the recording's (the job is retried)."""


@dataclass(frozen=True)
class Normalised:
    """The ONE decoded copy every later step uses: mono, 16 kHz, 16-bit wav, at most MAX_DECODE_SECONDS long. The recording as
    uploaded is never given to Whisper or to the provider; its stated length is never believed."""
    path: Path
    seconds: float


#: The whole decode is cut at this many seconds of AUDIO whatever the file claims, so a header that says 5 s over 900 s of sound
#: costs one extra second, not the whole file. Anything that reaches it is over MAX_SAMPLE_SECONDS and refused.
MAX_DECODE_SECONDS = int(MAX_SAMPLE_SECONDS) + 1
DECODE_RATE = 16000
#: 16-bit mono at 16 kHz is 32,000 bytes a second: the capped output cannot exceed this (plus a header); the output size is limited to it.
MAX_WAV_BYTES = MAX_DECODE_SECONDS * DECODE_RATE * 2 + 4096
PROBE_TIMEOUT_S = 30
DECODE_TIMEOUT_S = 120
TRANSCRIBE_TIMEOUT_S = 180
#: ffmpeg is told which demuxer to use from the sniffed bytes, so it never auto-detects a playlist or script format.
_DEMUXER = {"webm": "matroska,webm", "ogg": "ogg", "flac": "flac", "wav": "wav", "m4a": "mov,mp4,m4a,3gp,3g2,mj2", "mp3": "mp3",
            "aac": "aac"}


def streams_from_ffprobe(doc: object) -> tuple:
    """``(audio, video)`` stream counts from ffprobe's JSON. A picture attached to an audio file (cover art) is not a video
    stream. The container's stated duration is deliberately not read: it is whatever the file says it is."""
    if not isinstance(doc, Mapping):
        raise AudioRefused("unreadable_audio")
    audio = video = 0
    for s in doc.get("streams") or []:
        if not isinstance(s, Mapping):
            continue
        kind = s.get("codec_type")
        attached = isinstance(s.get("disposition"), Mapping) and s["disposition"].get("attached_pic") == 1
        if kind == "audio":
            audio += 1
        elif kind == "video" and not attached:
            video += 1
    return audio, video


def _child_limits() -> None:
    """Run in the child between fork and exec: a hostile file gets bounded CPU, memory, output size and no core dump."""
    import resource  # noqa: PLC0415

    for which, value in ((resource.RLIMIT_CPU, 120), (resource.RLIMIT_AS, 3 << 30), (resource.RLIMIT_FSIZE, 2 * MAX_WAV_BYTES),
                         (resource.RLIMIT_CORE, 0)):
        try:
            resource.setrlimit(which, (value, value))
        except (ValueError, OSError):
            pass


def _tool_env(home: Path) -> dict:
    """What ffmpeg and ffprobe are given: nothing of this process's environment (no service key, no ElevenLabs key)."""
    return {"PATH": "/usr/local/bin:/usr/bin:/bin", "HOME": str(home), "LANG": "C", "LC_ALL": "C"}


def _run_tool(run, argv: list, home: Path, timeout: int):
    kw = dict(capture_output=True, text=True, timeout=timeout, check=False, env=_tool_env(home), cwd=str(home), stdin=subprocess.DEVNULL)
    if os.name == "posix":
        kw["preexec_fn"] = _child_limits
    try:
        return run(argv, **kw)
    except subprocess.TimeoutExpired as e:
        raise AudioRefused("unreadable_audio") from e   # a file that cannot be read in time is not one we can use
    except (OSError, subprocess.SubprocessError) as e:
        raise AudioToolError(f"{Path(argv[0]).name} could not run ({type(e).__name__})") from e


def ffmpeg_normalise(src: Path, sniffed: Sniffed, workdir: Path, *, run: Callable = subprocess.run,
                     which: Callable = shutil.which) -> Normalised:
    """Check the streams, then decode ONCE to a capped mono 16 kHz wav, and measure the length of THAT.

    * ffprobe counts streams: exactly one audio stream and no video (a second audio stream would let Whisper and the provider
      hear different things).
    * ffmpeg decodes only that first audio stream, cut at MAX_DECODE_SECONDS of audio, with the output size limited, under a
      time limit, CPU / memory / file-size rlimits, an empty environment, only the ``file`` protocol and the demuxer the bytes
      named. A header that lies about the length changes nothing: the length is read from the file ffmpeg wrote.
    """
    probe_bin, ffmpeg_bin = which("ffprobe"), which("ffmpeg")
    if not probe_bin or not ffmpeg_bin:
        raise AudioToolError("ffmpeg / ffprobe are not installed")
    fmt = _DEMUXER.get(sniffed.ext)
    if fmt is None:
        raise AudioRefused("not_audio")
    proc = _run_tool(run, [probe_bin, "-v", "error", "-protocol_whitelist", "file", "-f", fmt, "-print_format", "json",
                           "-show_streams", str(src)], workdir, PROBE_TIMEOUT_S)
    if proc.returncode != 0:
        raise AudioRefused("unreadable_audio")
    try:
        audio, video = streams_from_ffprobe(json.loads(proc.stdout or ""))
    except ValueError as e:
        raise AudioRefused("unreadable_audio") from e
    if video or audio != 1:
        raise AudioRefused("not_audio")
    out = workdir / "decoded.wav"
    dec = _run_tool(run, [ffmpeg_bin, "-nostdin", "-v", "error", "-protocol_whitelist", "file", "-f", fmt, "-i", str(src),
                          "-map", "0:a:0", "-vn", "-sn", "-dn", "-t", str(MAX_DECODE_SECONDS), "-ac", "1", "-ar", str(DECODE_RATE),
                          "-c:a", "pcm_s16le", "-fs", str(MAX_WAV_BYTES), "-y", str(out)], workdir, DECODE_TIMEOUT_S)
    if dec.returncode != 0:
        raise AudioRefused("unreadable_audio")
    return measure_wav(out)


def measure_wav(path: Path) -> Normalised:
    """The length of the decoded wav, from its own frames. Refuses anything that is not the mono 16 kHz 16-bit file we asked for."""
    try:
        size = path.stat().st_size
        if size > MAX_WAV_BYTES:
            raise AudioRefused("sample_too_long")
        with wave.open(str(path), "rb") as w:
            if (w.getnchannels(), w.getframerate(), w.getsampwidth(), w.getcomptype()) != (1, DECODE_RATE, 2, "NONE"):
                raise AudioRefused("unreadable_audio")
            frames = w.getnframes()
    except (OSError, EOFError, wave.Error) as e:
        raise AudioRefused("unreadable_audio") from e
    seconds = frames / DECODE_RATE
    if seconds <= 0:
        raise AudioRefused("unreadable_audio")
    if seconds > MAX_SAMPLE_SECONDS:
        raise AudioRefused("sample_too_long")
    return Normalised(path, seconds)


def sweep_stale_workdirs(root: Optional[str] = None, *, older_than_s: float = 3600.0, now: Callable[[], float] = time.time) -> int:
    """Remove ``nsvoice-*`` directories a killed worker (SIGKILL, the OOM killer) left behind. Only real directories of ours,
    only older than ``older_than_s`` (a second worker on the machine may be using a young one). Never raises."""
    base = Path(root or tempfile.gettempdir())
    removed = 0
    try:
        entries = list(base.glob("nsvoice-*"))
    except OSError:
        return 0
    for p in entries:
        try:
            st = p.lstat()
            if p.is_symlink() or not p.is_dir() or (hasattr(os, "getuid") and st.st_uid != os.getuid()) or now() - st.st_mtime < older_than_s:
                continue
            shutil.rmtree(p, ignore_errors=True)
            removed += 1
        except OSError:
            continue
    if removed:
        logger.info("voice: removed %d stale work director%s of a worker that was killed", removed, "y" if removed == 1 else "ies")
    return removed


class TranscribeTimeout(Exception):
    pass


@contextlib.contextmanager
def _deadline(seconds: float):
    """Raise ``TranscribeTimeout`` in this thread after ``seconds`` (SIGALRM; a no-op off the main thread or where it is missing)."""
    if not hasattr(signal, "SIGALRM") or threading.current_thread() is not threading.main_thread():
        yield
        return

    def fire(signum, frame):
        raise TranscribeTimeout()

    previous = signal.signal(signal.SIGALRM, fire)
    signal.setitimer(signal.ITIMER_REAL, seconds)
    try:
        yield
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        signal.signal(signal.SIGALRM, previous)


def whisper_transcriber() -> Callable[[Path], str]:
    """The pipeline's own local Whisper (``modules.subtitle_generator.WHISPER_MODEL``), loaded for one transcript and dropped.
    It is given the samples of OUR decoded wav (read here with the stdlib), not a path: Whisper's own loader would start ffmpeg
    with this process's environment. The phrase is English words, so the language is fixed."""
    def transcribe(path: Path) -> str:
        import numpy as np  # noqa: PLC0415
        import whisper  # noqa: PLC0415 — heavy, and only the clone job needs it

        from modules.subtitle_generator import WHISPER_MODEL  # noqa: PLC0415

        with wave.open(str(path), "rb") as w:
            audio = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).astype(np.float32) / 32768.0
        model = whisper.load_model(WHISPER_MODEL)
        try:
            result = model.transcribe(audio, language="en", fp16=False, verbose=None)
        finally:
            del model
        text = result.get("text") if isinstance(result, Mapping) else None
        return text if isinstance(text, str) else ""

    return transcribe



# ── Supabase: the queue functions and the private bucket (the service key) ──────────


def _guard_redirect(resp, what: str, error):
    status = getattr(resp, "status_code", None)
    if isinstance(status, int) and 300 <= status < 400:
        # The service key rides in headers; a redirect would hand it to a host nobody checked.
        raise error("redirect", f"{what} answered a redirect (HTTP {status}); not followed.")
    return resp


class StoreError(RuntimeError):
    """A queue call that did not work. The message is built here from a function name, a status or a closed word: it is the only
    kind of error whose text the worker ever logs."""


class VoiceStore:
    """The queue, over PostgREST function calls. The service key has no table privilege on it (0117)."""

    def __init__(self, url: str, service_key: str, *, session=None, timeout: float = 30.0):
        self.url = (url or "").rstrip("/")
        self._key = service_key or ""
        self._http = session
        self._timeout = timeout
        self._warned_404: set = set()

    def http(self):
        if self._http is None:
            import requests  # noqa: PLC0415

            self._http = requests.Session()
        return self._http

    def __repr__(self) -> str:
        return "VoiceStore(<key hidden>)"

    def _rpc(self, name: str, payload: dict):
        r = self.http().post(f"{self.url}/rest/v1/rpc/{name}", json=payload, allow_redirects=False,
                             headers={"apikey": self._key, "Authorization": f"Bearer {self._key}",
                                      "Content-Type": "application/json"},
                             timeout=self._timeout)
        _guard_redirect(r, name, lambda code, msg: StoreError(f"{name}: {code}"))
        if r.status_code == 404:
            if name not in self._warned_404:
                self._warned_404.add(name)
                logger.warning("voice: the database function %s answered 404 (migration 0117 not applied, or the API schema "
                               "cache is stale): nothing is carried out until it exists", name)
            return None
        if r.status_code >= 300:
            raise StoreError(f"{name}: HTTP {r.status_code}")   # the status only, never the body
        return r.json()

    def claim(self, worker_id: str) -> Optional[dict]:
        out = self._rpc("claim_voice_job", {"p_worker": worker_id})
        return out if isinstance(out, dict) and out.get("job_id") else None

    def finish_clone(self, job_id: str, worker_id: str, verification: str, provider: Optional[str], voice_id: Optional[str],
                     sample_sha256: Optional[str], error_code: Optional[str]) -> Optional[dict]:
        out = self._rpc("finish_voice_clone", {
            "p_job": job_id, "p_worker": worker_id, "p_verification": verification, "p_provider": provider,
            "p_voice_id": voice_id, "p_sample_sha256": sample_sha256, "p_error_code": error_code})
        return out if isinstance(out, dict) else None

    def finish_task(self, job_id: str, worker_id: str, ok: bool, error_code: Optional[str]) -> Optional[dict]:
        out = self._rpc("finish_voice_task", {"p_job": job_id, "p_worker": worker_id, "p_ok": bool(ok),
                                              "p_error_code": error_code})
        return out if isinstance(out, dict) else None


class StorageError(RuntimeError):
    """A Storage call that did not work. ``code``: redirect | network | too_large | missing | http | not_deleted | odd_listing."""

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


_OBJECT_NAME = re.compile(r"[^/\x00-\x1f\x7f]{1,255}")
_LIST_PAGE = 100
_MAX_LISTED = 500


class SampleStorage:
    """The ``voice-samples`` bucket through the Storage API with the service key. UNVERIFIED live."""

    def __init__(self, url: str, service_key: str, *, session=None, timeout: float = 60.0, max_bytes: int = MAX_SAMPLE_BYTES):
        self.url = (url or "").rstrip("/")
        self._key = service_key or ""
        self._http = session
        self._timeout = timeout
        self.max_bytes = max_bytes

    def http(self):
        if self._http is None:
            import requests  # noqa: PLC0415

            self._http = requests.Session()
        return self._http

    def __repr__(self) -> str:
        return "SampleStorage(<key hidden>)"

    def _send(self, method: str, path: str, what: str, **kw):
        headers = {"apikey": self._key, "Authorization": f"Bearer {self._key}"}
        if "json" in kw:
            headers["Content-Type"] = "application/json"
        try:
            resp = getattr(self.http(), method)(f"{self.url}/storage/v1{path}", headers=headers, timeout=self._timeout,
                                                allow_redirects=False, **kw)
        except Exception as e:  # the type name only
            raise StorageError("network", f"Storage {what} failed ({type(e).__name__}).") from e
        return _guard_redirect(resp, f"Storage {what}", StorageError)

    @staticmethod
    def _is_missing(resp) -> bool:
        status = getattr(resp, "status_code", None)
        if status == 404:
            return True
        if status == 400:  # Storage has answered a missing object as 400 with statusCode 404 in the JSON
            try:
                return str(resp.json().get("statusCode")) == "404"
            except Exception:
                return False
        return False

    def download(self, path: str) -> bytes:
        """The object's bytes; ``too_large`` as soon as it passes ``max_bytes`` (the rest is never read)."""
        if not re.fullmatch(rf"{_UUID.pattern}/{_UUID.pattern}/{_SAMPLE_NAME.pattern}", path or ""):
            raise StorageError("odd_listing", "The sample path is not <user>/<profile>/sample.<ext>; nothing was fetched.")
        resp = self._send("get", f"/object/{BUCKET}/{quote(path)}", "sample download", stream=True)
        with closing(resp):
            if self._is_missing(resp):
                raise StorageError("missing", "The sample object is not in the bucket.")
            if resp.status_code != 200:
                raise StorageError("http", f"Storage sample download failed (HTTP {resp.status_code}).")
            declared = getattr(resp, "headers", {}).get("Content-Length")
            try:
                if declared is not None and int(declared) > self.max_bytes:
                    raise StorageError("too_large", "The sample is over the size limit.")
            except ValueError:
                pass
            out = bytearray()
            try:
                for chunk in resp.iter_content(chunk_size=65536):
                    out += chunk
                    if len(out) > self.max_bytes:
                        raise StorageError("too_large", "The sample is over the size limit.")
            except StorageError:
                raise
            except Exception as e:
                raise StorageError("network", f"Storage sample download failed ({type(e).__name__}).") from e
        return bytes(out)

    def list_files(self, prefix: str, _depth: int = 0) -> list:
        """Every object under ``prefix`` (no trailing slash), as full paths, folders followed."""
        found: list = []
        offset = 0
        while True:
            resp = self._send("post", f"/object/list/{BUCKET}", "list",
                              json={"prefix": prefix, "limit": _LIST_PAGE, "offset": offset})
            if resp.status_code != 200:
                raise StorageError("http", f"Storage list failed (HTTP {resp.status_code}).")
            try:
                rows = resp.json()
            except Exception as e:
                raise StorageError("odd_listing", "Storage list answered something that is not JSON.") from e
            if not isinstance(rows, list):
                raise StorageError("odd_listing", "Storage list answered something that is not a list.")
            for row in rows:
                name = row.get("name") if isinstance(row, Mapping) else None
                if not isinstance(name, str) or not _OBJECT_NAME.fullmatch(name) or name in (".", ".."):
                    raise StorageError("odd_listing", "Storage list returned an object name that cannot be addressed safely.")
                if row.get("id") is None:  # a folder
                    if _depth >= 3:
                        raise StorageError("odd_listing", "Storage list is nested deeper than a sample prefix ever is.")
                    found += self.list_files(f"{prefix}/{name}", _depth + 1)
                else:
                    found.append(f"{prefix}/{name}")
                if len(found) > _MAX_LISTED:
                    raise StorageError("odd_listing", "Storage list returned far more objects than a sample prefix holds.")
            if len(rows) < _LIST_PAGE:
                return found
            offset += _LIST_PAGE

    def delete_prefix(self, user_id: str, profile_id: str) -> int:
        """Delete everything under ``<user_id>/<profile_id>/`` and confirm it is empty. Returns how many objects were there.
        Both ids must be UUIDs, so the prefix always has two non-empty segments and can never be a wider one."""
        if not _UUID.fullmatch(str(user_id)) or not _UUID.fullmatch(str(profile_id)):
            raise StorageError("odd_listing", "A sample prefix is <user uuid>/<profile uuid>; nothing was deleted.")
        prefix = f"{user_id}/{profile_id}"
        paths = self.list_files(prefix)
        if paths:
            resp = self._send("delete", f"/object/{BUCKET}", "delete", json={"prefixes": paths})
            if resp.status_code != 200:
                raise StorageError("http", f"Storage delete failed (HTTP {resp.status_code}).")
            if self.list_files(prefix):
                raise StorageError("not_deleted", "Objects are still under the sample prefix after the delete.")
        return len(paths)


# ── the worker ───────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class Outcome:
    kind: str
    #: cloned | rejected | parked | failed | deleted | purged | lost | unrecorded | invalid
    result: str
    code: Optional[str] = None
    attempts: int = 0


@dataclass(frozen=True)
class Job:
    job_id: str
    kind: str
    attempts: int
    user_id: str
    profile_id: str
    owner_ref: str
    keep_sample: bool
    sample_path: Optional[str]
    phrase: Optional[str]
    provider_voice_id: Optional[str]
    profile_status: str

    @property
    def prefix(self) -> str:
        return f"{self.user_id}/{self.profile_id}/"

    @classmethod
    def parse(cls, raw: Mapping) -> "Job":
        """A claim answer, checked. ValueError for anything the database would never send (a hostile or stale answer must not
        become a Storage path)."""
        def uuid(key):
            v = raw.get(key)
            if not isinstance(v, str) or not _UUID.fullmatch(v):
                raise ValueError(f"bad {key}")
            return v

        kind = raw.get("kind")
        if kind not in KINDS:
            raise ValueError("bad kind")
        attempts = raw.get("attempts")
        if not isinstance(attempts, int) or isinstance(attempts, bool) or attempts < 1:
            raise ValueError("bad attempts")
        job = cls(uuid("job_id"), kind, attempts, uuid("user_id"), uuid("profile_id"), str(raw.get("owner_ref") or ""),
                  raw.get("keep_sample") is True,
                  raw.get("sample_path") if isinstance(raw.get("sample_path"), str) else None,
                  raw.get("phrase") if isinstance(raw.get("phrase"), str) else None,
                  raw.get("provider_voice_id") if isinstance(raw.get("provider_voice_id"), str) else None,
                  str(raw.get("status") or ""))
        if raw.get("sample_prefix") != job.prefix:
            raise ValueError("the sample prefix is not <user>/<profile>/")
        if job.sample_path is not None and not (job.sample_path.startswith(job.prefix)
                                                and _SAMPLE_NAME.fullmatch(job.sample_path[len(job.prefix):])):
            raise ValueError("the sample path is not inside the prefix")
        return job


def _mask(value: str) -> str:
    """A job id for the log: enough to find the row, not enough to be anything else."""
    return f"{str(value)[:8]}…"


#: ProviderError.code -> (closed word reported to the database, may a later attempt succeed?). "May succeed" covers everything
#: that is the operator's or the provider's to fix (a key, the account, an outage): those jobs are parked, not rejected.
_PROVIDER_WORDS = {
    "plan_required": ("provider_not_enabled", True),   # the provider says so AFTER our probe said yes: not the documented state
    "auth": ("provider_auth", True),
    "rejected": ("provider_rejected", False),
    "redirect": ("provider_redirect", True),
    "quota": ("provider_unavailable", True),
    "transient": ("provider_unavailable", True),
    "network": ("provider_unavailable", True),
    "unexpected": ("provider_error", True),
    "not_found": ("provider_error", False),
}


def classify_provider_error(e: vp.ProviderError) -> tuple:
    """``(word, may_retry)``. ONLY a subscription that explicitly says instant cloning is not allowed (the documented free plan)
    is a verdict on the request; a missing flag, a bad key, a refused plan after a good probe, an outage are the operator's."""
    if isinstance(e, vp.PlanRequired):
        return ("provider_not_enabled", False) if e.state is False else ("provider_plan_unknown", True)
    word, retry = _PROVIDER_WORDS.get(e.code, ("provider_error", False))
    if e.code == "unexpected" and e.status is not None:
        retry = False  # an HTTP answer we do not know (a 400, a 402) will not change on the next try; "no usable id" will
    return word, retry


class VoiceWorker:
    """Claims and processes at most one job per ``run_once``. Everything it touches is injected.

    **Parking.** The database allows three claims of a job (``max_attempts``) and nothing a service key can call raises that or
    re-queues a failed job. A retry that is only worth trying later therefore does NOT answer the database: the job is left
    ``running`` and ``claim_voice_job`` gives it back after its 30-minute lease, which is the longest wait the existing functions
    offer (about 90 minutes over the three claims). The answer is given only on the last claim, with the specific word. A user's
    own fault (a bad recording, the wrong phrase, the documented free plan) is answered at once."""

    def __init__(self, store, storage, provider, *, worker_id: str, transcribe: Callable[[Path], str],
                 normalise: Callable[..., Normalised] = ffmpeg_normalise, env: Optional[Mapping[str, str]] = None,
                 sleep: Callable[[float], None] = time.sleep, tmp_root: Optional[str] = None,
                 transcribe_timeout: float = TRANSCRIBE_TIMEOUT_S):
        self.store = store
        self.storage = storage
        self.provider = provider   # None: no ElevenLabs key. Purging samples still works; anything that needs the provider is parked.
        self.worker_id = worker_id
        self.transcribe = transcribe
        self.normalise = normalise
        self.env = os.environ if env is None else env
        self._sleep = sleep
        self._tmp_root = tmp_root
        self._transcribe_timeout = transcribe_timeout
        self._warned = False

    # -- the loop's one step ---------------------------------------------------
    def run_once(self) -> Optional[Outcome]:
        """None when the switch is off or there was nothing to do. A claim is never made while the switch is off."""
        if not enabled(self.env):
            return None
        try:
            raw = self.store.claim(self.worker_id)
        except Exception as e:
            if not self._warned:
                logger.warning("voice queue unavailable (%s)", str(e) if isinstance(e, StoreError) else type(e).__name__)
                self._warned = True
            return None
        if not raw:
            return None
        try:
            job = Job.parse(raw)
        except ValueError as e:
            # Not a job this worker can act on, and a path it must not build. The lease runs out and the database decides.
            logger.error("voice: a claimed job was refused (%s); left to the lease", e)
            return Outcome("unknown", "invalid")
        try:
            handler = {"clone": self._clone, "delete_provider": self._delete_provider, "purge_sample": self._purge_sample}[job.kind]
            outcome = handler(job)
        except Exception as e:  # a bug or an unforeseen failure: never leave the job silent, never log its text
            logger.error("voice %s job %s failed unexpectedly (%s)", job.kind, _mask(job.job_id), type(e).__name__)
            outcome = self._unexpected(job)
        logger.info("voice %s job %s: %s%s", job.kind, _mask(job.job_id), outcome.result,
                    f" ({outcome.code})" if outcome.code else "")
        return outcome

    # -- recording an answer ---------------------------------------------------
    def _record(self, fn, *args) -> Optional[dict]:
        """Send an answer to the database, retrying a transport failure twice. None = it could not be recorded."""
        for i in range(3):
            try:
                return fn(*args)
            except Exception as e:
                logger.warning("voice: recording an answer failed (%s)", str(e) if isinstance(e, StoreError) else type(e).__name__)
                if i < 2:
                    self._sleep(1 + 2 * i)
        return None

    def _park(self, job: Job, word: str) -> Outcome:
        """Answer nothing; the lease returns the job to the queue (see the class docstring)."""
        logger.warning("voice %s job %s parked (%s), claim %d of %d: it is tried again when its lease runs out",
                       job.kind, _mask(job.job_id), word, job.attempts, MAX_ATTEMPTS)
        return Outcome(job.kind, "parked", word, job.attempts)

    def _unexpected(self, job: Job) -> Outcome:
        try:
            if job.kind == "clone":
                return self._end_clone(job, "worker_error", retry=True)
            return self._task_failed(job, "worker_error")
        except Exception as e:  # nothing here may raise: the lease is the last resort
            logger.error("voice job %s: could not even report the failure (%s)", _mask(job.job_id), type(e).__name__)
            return Outcome(job.kind, "unrecorded", "worker_error", job.attempts)

    @staticmethod
    def _outcome_of(job: Job, res: Optional[dict], code: Optional[str]) -> Outcome:
        if res is None:
            return Outcome(job.kind, "unrecorded", code, job.attempts)
        if res.get("ok") is not True:
            return Outcome(job.kind, "lost" if res.get("error") == "not_holder" else "unrecorded", code, job.attempts)
        if res.get("retry"):
            return Outcome(job.kind, "parked", code, job.attempts)
        if job.kind == "clone":
            return Outcome(job.kind, "rejected" if res.get("status") in ("rejected", "deleted") else "cloned", code, job.attempts)
        return Outcome(job.kind, "failed", code, job.attempts)

    # -- deleting our copy -----------------------------------------------------
    def _delete_our_copy(self, job: Job) -> bool:
        """Best effort and immediate; the purge_sample job the database queued confirms it. Never raises."""
        try:
            self.storage.delete_prefix(job.user_id, job.profile_id)
            return True
        except Exception as e:
            logger.warning("voice job %s: the sample could not be deleted now (%s); its purge job will retry",
                           _mask(job.job_id), getattr(e, "code", type(e).__name__))
            return False

    # -- clone -----------------------------------------------------------------
    def _end_clone(self, job: Job, word: str, *, retry: bool = False) -> Outcome:
        """End the attempt with a closed word. ``retry``: park it while claims remain, answer only on the last."""
        if retry and job.attempts < MAX_ATTEMPTS:
            return self._park(job, word)
        res = self._record(self.store.finish_clone, job.job_id, self.worker_id, "failed", None, None, None, word)
        out = self._outcome_of(job, res, word)
        if out.result == "rejected":
            self._delete_our_copy(job)
        return out

    def _provider_stop(self, job: Job, e: vp.ProviderError, *, maybe_created: bool = False) -> Outcome:
        word, retry = classify_provider_error(e)
        out = self._end_clone(job, word, retry=retry)
        # Only a profile the database has just rejected may lose a voice: a worker that lost its lease, or whose answer was not
        # recorded, must not delete what another worker may have adopted.
        if maybe_created and out.result == "rejected":
            self._remove_orphans(job)
        return out

    def _remove_orphans(self, job: Job) -> None:
        """Remove the voices labelled for THIS profile (full id and owner reference) from the provider account, so a rejected
        profile does not leave a clone of someone's voice there. A voice with the name but another label is never touched.
        Best effort; one that survives is found by its name (``ns-<owner_ref>-<profile8>``, docs/CUSTOM_VOICE.md)."""
        if self.provider is None:
            return
        try:
            for voice_id in self.provider.find_voices_for_profile(job.owner_ref, job.profile_id).owned:
                self.provider.delete_voice(voice_id)
        except Exception as e:
            logger.warning("voice job %s: a possibly created voice could not be removed (%s)", _mask(job.job_id),
                           getattr(e, "code", type(e).__name__))

    def _clone(self, job: Job) -> Outcome:
        if not vp.is_owner_ref(job.owner_ref) or not job.phrase:
            return self._end_clone(job, "bad_job")
        if self.provider is None:
            return self._end_clone(job, "provider_not_configured", retry=True)
        # 1. The account's capability, before the sample is fetched and long before any create call.
        try:
            self.provider.ensure_plan()
        except vp.ProviderError as e:
            return self._provider_stop(job, e)
        # 2. The bytes.
        if not job.sample_path:
            return self._end_clone(job, "sample_missing")
        try:
            data = self.storage.download(job.sample_path)
        except StorageError as e:
            if e.code == "too_large":
                return self._end_clone(job, "sample_too_large")
            if e.code == "missing":
                return self._end_clone(job, "sample_missing")
            return self._end_clone(job, "storage_error", retry=e.code in ("network", "http", "redirect"))
        if len(data) > MAX_SAMPLE_BYTES:
            return self._end_clone(job, "sample_too_large")
        sniffed = sniff_audio(data)
        if sniffed is None or sniffed.mime not in vp.SAMPLE_TYPES:
            return self._end_clone(job, "not_audio")
        sha = vp.sample_sha256(data)
        # 3. ONE capped decode; its measured length, its transcript and its bytes are what everything after uses. The only
        #    copies on this machine live in a private directory that is removed on every path out of this block.
        with tempfile.TemporaryDirectory(prefix="nsvoice-", dir=self._tmp_root) as tmp:
            workdir = Path(tmp)
            local = workdir / f"sample.{sniffed.ext}"
            local.write_bytes(data)
            try:
                norm = self.normalise(local, sniffed, workdir)
            except AudioRefused as e:
                return self._end_clone(job, e.code)
            except AudioToolError:
                return self._end_clone(job, "audio_tool_error", retry=True)
            try:
                with _deadline(self._transcribe_timeout):
                    transcript = self.transcribe(norm.path)
            except TranscribeTimeout:
                return self._end_clone(job, "transcribe_timeout", retry=True)
            except Exception as e:
                logger.warning("voice job %s: the transcript failed (%s)", _mask(job.job_id), type(e).__name__)
                return self._end_clone(job, "transcribe_failed", retry=True)
            wav = norm.path.read_bytes()
        check = vp.check_transcript(job.phrase, transcript)
        if not check.passed:
            res = self._record(self.store.finish_clone, job.job_id, self.worker_id, "failed", None, None, sha, None)
            out = self._outcome_of(job, res, "verification_failed")
            if out.result == "rejected":
                out = Outcome("clone", "rejected", "verification_failed", job.attempts)
                self._delete_our_copy(job)
            return out
        # 4. The provider: adopt a voice labelled for THIS profile if an earlier attempt made one, otherwise create it. The
        #    provider gets the normalised, capped wav, never the upload.
        try:
            found = self.provider.find_voices_for_profile(job.owner_ref, job.profile_id)
            if found.conflicting:
                # Our name on a voice that is not labelled as ours: not ours to adopt, delete or duplicate.
                return self._end_clone(job, "provider_conflict")
            if found.owned:
                voice_id = found.owned[0]
                for extra in found.owned[1:]:
                    self.provider.delete_voice(extra)
            else:
                voice_id = self.provider.create_voice(owner_ref=job.owner_ref, profile_id=job.profile_id, sample=wav,
                                                      content_type="audio/wav").voice_id
        except vp.ProviderError as e:
            return self._provider_stop(job, e, maybe_created=True)
        # 5. Record it; only an accepted answer lets go of the sample.
        res = self._record(self.store.finish_clone, job.job_id, self.worker_id, "passed", self.provider.provider, voice_id, sha, None)
        if res is None:
            return Outcome("clone", "unrecorded", None, job.attempts)  # the lease returns the job; the next attempt adopts the voice
        if res.get("ok") is not True:
            code = res.get("error") if isinstance(res.get("error"), str) else None
            if code == "voice_id_taken":
                # The service key cannot read other profiles, so the database's UNIQUE (provider, voice id) is the check that this
                # voice is not another profile's. It said so: nothing is deleted, and the case is for a person.
                logger.error("voice job %s: the database says this voice id belongs to another profile; nothing was changed",
                             _mask(job.job_id))
            return Outcome("clone", "lost" if code == "not_holder" else "unrecorded", code, job.attempts)
        if res.get("status") in ("rejected", "deleted") or res.get("sample_purge_queued") is True:
            self._delete_our_copy(job)
        return Outcome("clone", "cloned" if res.get("status") == "testing" else "rejected", None, job.attempts)

    # -- the two kinds of task -------------------------------------------------
    def _task_failed(self, job: Job, word: str) -> Outcome:
        """A delete or a purge that did not work. Parked while claims remain; on the last claim it is answered, and then it is
        over for the database: the overdue sample / voice is for a person (docs/CUSTOM_VOICE.md, 'the recurring check')."""
        if job.attempts < MAX_ATTEMPTS:
            return self._park(job, word)
        res = self._record(self.store.finish_task, job.job_id, self.worker_id, False, word)
        logger.error("voice OVERDUE: %s job %s failed for good after %d claims (%s); a sample or a provider voice may remain: "
                     "run the overdue check in docs/CUSTOM_VOICE.md", job.kind, _mask(job.job_id), job.attempts, word)
        return self._outcome_of(job, res, word)

    def _delete_provider(self, job: Job) -> Outcome:
        if not job.provider_voice_id:
            return self._task_failed(job, "no_voice_id")
        if self.provider is None:
            return self._task_failed(job, "provider_not_configured")
        try:
            gone = self.provider.delete_voice(job.provider_voice_id)  # a 404 is "already gone": True
        except vp.ProviderError as e:
            return self._task_failed(job, _PROVIDER_WORDS.get(e.code, ("provider_error", False))[0])
        if not gone:
            return self._task_failed(job, "provider_error")
        res = self._record(self.store.finish_task, job.job_id, self.worker_id, True, None)
        if res is None or res.get("ok") is not True:
            return self._outcome_of(job, res, None)
        return Outcome(job.kind, "deleted", None, job.attempts)

    def _purge_sample(self, job: Job) -> Outcome:
        try:
            self.storage.delete_prefix(job.user_id, job.profile_id)
        except StorageError as e:
            return self._task_failed(job, "storage_" + e.code)
        if job.provider_voice_id is None and job.profile_status == "rejected" and vp.is_owner_ref(job.owner_ref):
            # A REJECTED profile never got a voice recorded (its clone job has ended), so a voice labelled for it in the provider
            # account is an orphan: a create whose answer was lost in an attempt that then ended. Any other state may have a clone
            # in flight (the owner deleted it while it was being made), and its own delete_provider job handles that voice.
            self._remove_orphans(job)
        res = self._record(self.store.finish_task, job.job_id, self.worker_id, True, None)
        if res is None or res.get("ok") is not True:
            return self._outcome_of(job, res, None)
        return Outcome(job.kind, "purged", None, job.attempts)


__all__ = ["enabled", "VoiceWorker", "VoiceStore", "SampleStorage", "StorageError", "Outcome", "Job", "Normalised", "AudioRefused",
           "AudioToolError", "sniff_audio", "ffmpeg_normalise", "measure_wav", "sweep_stale_workdirs", "whisper_transcriber",
           "classify_provider_error", "SWITCH_ENV"]

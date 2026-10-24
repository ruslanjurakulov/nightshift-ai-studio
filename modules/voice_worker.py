"""Custom voice: the worker (migration 0117, docs/CUSTOM_VOICE.md). Off unless ``NIGHTSHIFT_VOICE_CLONING=on``.

``voice_clone_jobs`` is the queue; the 0117 functions ``claim_voice_job`` / ``finish_voice_clone`` / ``finish_voice_task`` are the only
way this module reads or writes it (the service key has no table privilege on it). Three kinds of job:

* ``clone``: capability, then bytes, then the read-aloud check, then the provider, then deletion of our copy. In this order and
  no other, because each step is cheaper and less irreversible than the next:

  1. **The account's plan is asked first**, before the sample is even fetched (``ensure_plan``: ``can_use_instant_voice_cloning``
     must be a real ``True``). The account is on the FREE plan today, so in production this is where every clone job ends, in
     the closed state ``provider_not_enabled``: the profile is rejected with that reason, the sample is purged, nothing was
     spent and no create call was ever made. The adapter refuses on its own as well; this is the same rule asked earlier.
  2. The object is fetched from the private bucket with the service key. A redirect is refused (the key must not follow one) and
     the read stops at the bucket's own size limit.
  3. **The bytes are sniffed**, never the declared type: the bucket's MIME allow-list checks what the client SAID. The container
     must be a known audio one, the probe must find an audio stream and no video stream, and the length is capped
     (``MAX_SAMPLE_SECONDS``). Anything else is ``not_audio`` / ``sample_too_large`` / ``sample_too_long`` before the sample is
     hashed into a record, transcribed or sent anywhere.
  4. The phrase is read back with the local Whisper (injected: tests use a fake) and compared by
     ``voice_profiles.check_transcript``. A wrong phrase is ``verification_failed`` and the provider is never called.
  5. The provider is asked for a voice by the name ``ns-<owner_ref>-<profile8>`` FIRST and only created when there is none: a
     create that timed out, or whose answer had no usable id, may have made the voice, and a retry (ours, or the lost-worker
     rule's) must adopt it and never make a second one. Then the id is recorded with ``finish_voice_clone``.
  6. Only after the database has accepted that answer is our copy deleted: the whole ``<user_id>/<profile_id>/`` prefix, listed
     and verified empty, unless the owner chose to keep the sample. Only the hash and metadata survive.

* ``delete_provider``: ``DELETE /v1/voices/{id}``; a 404 is "already gone" and counts as done (the adapter does that).
* ``purge_sample``: delete the whole prefix, confirm it is empty, answer ``finish_voice_task``. Idempotent: an empty prefix is done.
  For a profile that never got a voice recorded it also removes any voice of that profile's own name from the provider account
  (the orphan of a create whose answer was lost), because nothing else would.

Retry and loss. A provider failure that may pass (network, timeout, 5xx, 429) is reported as ``transient``; the database puts the job
back while ``attempts < max_attempts`` (3) and ends it after that, and the worker reports a meaningful word on the last attempt.
A worker that dies mid-job leaves it ``running``; ``claim_voice_job`` returns it to the queue after 30 minutes of silence and ends
it as ``worker_lost`` after three, rejecting the profile and queueing ``purge_sample``. The sample is therefore never left behind:
every path that ends a profile queues its purge, and this module deletes it twice (right away, then again when that job runs).

Nothing here logs the key, the sample, the phrase or a voice id in full, and no response body is ever copied into an error: a
closed word and an HTTP status are. A redirect from Supabase or ElevenLabs is refused. EVERY Storage and ElevenLabs request shape
is "as the planner knew it, UNVERIFIED live"; nothing in this file has run against a real project or the real provider.
"""

from __future__ import annotations

import json
import logging
import os
import re
import subprocess
import tempfile
import time
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
#: voice_clone_jobs.max_attempts (0117's default). The database owns the real number; this one only decides which word to send.
MAX_ATTEMPTS = 3
#: Seconds the loop waits after a job went back to the queue, by the attempt that just failed (the database requeues at once).
BACKOFF_SECONDS = (30, 120, 600)
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


@dataclass(frozen=True)
class AudioFacts:
    audio_streams: int
    video_streams: int
    duration_s: Optional[float]


class ProbeError(RuntimeError):
    """The probe could not read the file (the file is not decodable media). Carries no output of the tool."""


def facts_from_ffprobe(doc: object, decoded_seconds: Optional[float] = None) -> AudioFacts:
    """AudioFacts from ffprobe's JSON. A picture attached to an audio file (cover art) is not a video stream. The duration is
    the container's when it states one; a live recording (MediaRecorder's webm) states none, so the decoded length is used."""
    if not isinstance(doc, Mapping):
        raise ProbeError("ffprobe answered something that is not an object")
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
    duration: Optional[float] = None
    fmt = doc.get("format")
    raw = fmt.get("duration") if isinstance(fmt, Mapping) else None
    try:
        value = float(raw)
        if value > 0 and value != float("inf"):
            duration = value
    except (TypeError, ValueError):
        pass
    if duration is None and decoded_seconds is not None and decoded_seconds > 0:
        duration = decoded_seconds
    return AudioFacts(audio, video, duration)


def decoded_seconds_from_progress(text: str) -> Optional[float]:
    """The last ``out_time_us`` of ``ffmpeg -progress pipe:1`` output, in seconds."""
    found = re.findall(r"^out_time_us=(\d+)$", text or "", re.M)
    return int(found[-1]) / 1_000_000 if found else None


def ffmpeg_probe(path: Path, *, run: Callable = subprocess.run) -> AudioFacts:
    """The default probe: ffprobe for the streams, then (only when the container states no length) one decode pass for it.
    Fixed argument lists, no shell; ``path`` is a file this process just wrote in its own private directory."""
    p = str(path)
    try:
        proc = run(["ffprobe", "-v", "error", "-print_format", "json", "-show_streams", "-show_format", p],
                   capture_output=True, text=True, timeout=30, check=False)
    except (OSError, subprocess.SubprocessError) as e:
        raise ProbeError(f"ffprobe could not run ({type(e).__name__})") from e
    if proc.returncode != 0:
        raise ProbeError("ffprobe could not read the file")
    try:
        doc = json.loads(proc.stdout or "")
    except ValueError as e:
        raise ProbeError("ffprobe answered something that is not JSON") from e
    facts = facts_from_ffprobe(doc)
    if facts.duration_s is not None or facts.audio_streams == 0:
        return facts
    try:
        dec = run(["ffmpeg", "-v", "error", "-nostdin", "-nostats", "-progress", "pipe:1", "-i", p, "-vn", "-f", "null", "-"],
                  capture_output=True, text=True, timeout=120, check=False)
    except (OSError, subprocess.SubprocessError) as e:
        raise ProbeError(f"ffmpeg could not run ({type(e).__name__})") from e
    if dec.returncode != 0:
        raise ProbeError("ffmpeg could not decode the file")
    return facts_from_ffprobe(doc, decoded_seconds_from_progress(dec.stdout))


def whisper_transcriber() -> Callable[[Path], str]:
    """The pipeline's own local Whisper (``modules.subtitle_generator.WHISPER_MODEL``), loaded for one transcript and dropped.
    The phrase is made of English words, so the language is fixed: a Whisper that guesses the language of a six-word clip
    guesses wrong often enough to fail an honest speaker."""
    def transcribe(path: Path) -> str:
        import whisper  # noqa: PLC0415 — heavy, and only the clone job needs it

        from modules.subtitle_generator import WHISPER_MODEL  # noqa: PLC0415

        model = whisper.load_model(WHISPER_MODEL)
        try:
            result = model.transcribe(str(path), language="en", fp16=False, verbose=None)
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
        _guard_redirect(r, name, lambda code, msg: RuntimeError(f"{name}: {code}"))
        if r.status_code == 404:
            if name not in self._warned_404:
                self._warned_404.add(name)
                logger.warning("voice: the database function %s answered 404 (migration 0117 not applied, or the API schema "
                               "cache is stale): nothing is carried out until it exists", name)
            return None
        if r.status_code >= 300:
            raise RuntimeError(f"{name}: HTTP {r.status_code}")   # the status only, never the body
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
    #: cloned | rejected | retry | failed | deleted | purged | lost | unrecorded | invalid
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
                  raw.get("provider_voice_id") if isinstance(raw.get("provider_voice_id"), str) else None)
        if raw.get("sample_prefix") != job.prefix:
            raise ValueError("the sample prefix is not <user>/<profile>/")
        if job.sample_path is not None and not (job.sample_path.startswith(job.prefix)
                                                and _SAMPLE_NAME.fullmatch(job.sample_path[len(job.prefix):])):
            raise ValueError("the sample path is not inside the prefix")
        return job


def _mask(value: str) -> str:
    """A job id for the log: enough to find the row, not enough to be anything else."""
    return f"{str(value)[:8]}…"


#: ProviderError.code -> (closed word reported to the database, may a later attempt succeed?)
_PROVIDER_WORDS = {
    "plan_required": ("provider_not_enabled", False),
    "not_configured": ("provider_not_configured", False),
    "auth": ("provider_auth", False),
    "rejected": ("provider_rejected", False),
    "redirect": ("provider_redirect", False),
    "quota": ("provider_unavailable", True),
    "transient": ("provider_unavailable", True),
    "network": ("provider_unavailable", True),
    "unexpected": ("provider_error", True),
    "not_found": ("provider_error", False),
}


class VoiceWorker:
    """Claims and processes at most one job per ``run_once``. Everything it touches is injected."""

    def __init__(self, store, storage, provider, *, worker_id: str, transcribe: Callable[[Path], str],
                 probe: Callable[[Path], AudioFacts] = ffmpeg_probe, env: Optional[Mapping[str, str]] = None,
                 sleep: Callable[[float], None] = time.sleep, tmp_root: Optional[str] = None):
        self.store = store
        self.storage = storage
        self.provider = provider
        self.worker_id = worker_id
        self.transcribe = transcribe
        self.probe = probe
        self.env = os.environ if env is None else env
        self._sleep = sleep
        self._tmp_root = tmp_root
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
                logger.warning("voice queue unavailable (%s)", str(e) if isinstance(e, RuntimeError) else type(e).__name__)
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

    def retry_wait(self, outcome: Outcome) -> float:
        i = min(max(outcome.attempts, 1), len(BACKOFF_SECONDS)) - 1
        return float(BACKOFF_SECONDS[i]) if outcome.result == "retry" else 0.0

    # -- recording an answer ---------------------------------------------------
    def _record(self, fn, *args) -> Optional[dict]:
        """Send an answer to the database, retrying a transport failure twice. None = it could not be recorded."""
        for i in range(3):
            try:
                return fn(*args)
            except Exception as e:
                logger.warning("voice: recording an answer failed (%s)", str(e) if isinstance(e, RuntimeError) else type(e).__name__)
                if i < 2:
                    self._sleep(1 + 2 * i)
        return None

    def _word(self, job: Job, final: str) -> str:
        """``transient`` while the database will still requeue the job, the meaningful word on the last attempt."""
        return "transient" if job.attempts < MAX_ATTEMPTS else final

    def _unexpected(self, job: Job) -> Outcome:
        code = self._word(job, "worker_error")
        if job.kind == "clone":
            res = self._record(self.store.finish_clone, job.job_id, self.worker_id, "failed", None, None, None, code)
        else:
            res = self._record(self.store.finish_task, job.job_id, self.worker_id, False, code)
        return self._outcome_of(job, res, code)

    @staticmethod
    def _outcome_of(job: Job, res: Optional[dict], code: Optional[str]) -> Outcome:
        if res is None:
            return Outcome(job.kind, "unrecorded", code, job.attempts)
        if res.get("ok") is not True:
            return Outcome(job.kind, "lost" if res.get("error") == "not_holder" else "unrecorded", code, job.attempts)
        if res.get("retry"):
            return Outcome(job.kind, "retry", code, job.attempts)
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
    def _end_clone(self, job: Job, code: str, *, may_retry: bool = False, final: Optional[str] = None) -> Outcome:
        word = self._word(job, final or code) if may_retry else code
        res = self._record(self.store.finish_clone, job.job_id, self.worker_id, "failed", None, None, None, word)
        out = self._outcome_of(job, res, word)
        if out.result in ("rejected", "failed"):
            self._delete_our_copy(job)
        return out

    def _provider_stop(self, job: Job, e: vp.ProviderError, *, maybe_created: bool = False) -> Outcome:
        word, retryable = _PROVIDER_WORDS.get(e.code, ("provider_error", False))
        if e.code == "unexpected" and e.status is not None:
            retryable = False  # an HTTP answer we do not know (a 400, a 402) will not change on the next try; "no usable id" will
        out = self._end_clone(job, word, may_retry=retryable, final=word)
        if maybe_created and out.result != "retry":
            self._remove_orphans(job)
        return out

    def _remove_orphans(self, job: Job) -> None:
        """The attempt ended for good after a create that may have worked: remove a voice of OUR name, so a rejected profile
        does not leave a clone of someone's voice in the provider account. Best effort; a voice that survives this is found
        by its name (``ns-<owner_ref>-<profile8>``, docs/CUSTOM_VOICE.md)."""
        try:
            for voice_id in self.provider.find_voices_by_name(vp.provider_voice_name(job.owner_ref, job.profile_id)):
                self.provider.delete_voice(voice_id)
        except Exception as e:
            logger.warning("voice job %s: a possibly created voice could not be removed (%s)", _mask(job.job_id),
                           getattr(e, "code", type(e).__name__))

    def _clone(self, job: Job) -> Outcome:
        if not vp.is_owner_ref(job.owner_ref) or not job.phrase:
            return self._end_clone(job, "bad_job")
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
            return self._end_clone(job, "storage_error", may_retry=e.code in ("network", "http", "redirect"))
        if len(data) > MAX_SAMPLE_BYTES:
            return self._end_clone(job, "sample_too_large")
        sniffed = sniff_audio(data)
        if sniffed is None or sniffed.mime not in vp.SAMPLE_TYPES:
            return self._end_clone(job, "not_audio")
        sha = vp.sample_sha256(data)
        # 3. The streams, the length, and the phrase. The only copy on this machine lives in a private directory that is
        #    removed on every path out of this block.
        with tempfile.TemporaryDirectory(prefix="nsvoice-", dir=self._tmp_root) as tmp:
            local = Path(tmp) / f"sample.{sniffed.ext}"
            local.write_bytes(data)
            try:
                facts = self.probe(local)
            except ProbeError:
                return self._end_clone(job, "unreadable_audio")
            if facts.video_streams or not facts.audio_streams:
                return self._end_clone(job, "not_audio")
            if facts.duration_s is None or facts.duration_s <= 0:
                return self._end_clone(job, "unreadable_audio")
            if facts.duration_s > MAX_SAMPLE_SECONDS:
                return self._end_clone(job, "sample_too_long")
            try:
                transcript = self.transcribe(local)
            except Exception as e:
                logger.warning("voice job %s: the transcript failed (%s)", _mask(job.job_id), type(e).__name__)
                return self._end_clone(job, "transcribe_failed", may_retry=True)
        check = vp.check_transcript(job.phrase, transcript)
        if not check.passed:
            res = self._record(self.store.finish_clone, job.job_id, self.worker_id, "failed", None, None, sha, None)
            out = self._outcome_of(job, res, "verification_failed")
            if out.result in ("rejected", "failed"):
                out = Outcome("clone", "rejected", "verification_failed", job.attempts)
                self._delete_our_copy(job)
            return out
        # 4. The provider: adopt a voice of our name if an earlier attempt made one, otherwise create it.
        name = vp.provider_voice_name(job.owner_ref, job.profile_id)
        try:
            existing = self.provider.find_voices_by_name(name)
            if existing:
                voice_id = existing[0]
                for extra in existing[1:]:
                    self.provider.delete_voice(extra)
            else:
                voice_id = self.provider.create_voice(owner_ref=job.owner_ref, profile_id=job.profile_id, sample=data,
                                                      content_type=sniffed.mime).voice_id
        except vp.ProviderError as e:
            return self._provider_stop(job, e, maybe_created=True)
        # 5. Record it; only an accepted answer lets go of the sample.
        res = self._record(self.store.finish_clone, job.job_id, self.worker_id, "passed", self.provider.provider, voice_id, sha, None)
        if res is None:
            return Outcome("clone", "unrecorded", None, job.attempts)  # the lease returns the job; the next attempt adopts the voice
        if res.get("ok") is not True:
            code = res.get("error") if isinstance(res.get("error"), str) else None
            return Outcome("clone", "lost" if code == "not_holder" else "unrecorded", code, job.attempts)
        if res.get("status") in ("rejected", "deleted") or res.get("sample_purge_queued") is True:
            self._delete_our_copy(job)
        return Outcome("clone", "cloned" if res.get("status") == "testing" else "rejected", None, job.attempts)

    # -- delete at the provider ------------------------------------------------
    def _delete_provider(self, job: Job) -> Outcome:
        if not job.provider_voice_id:
            res = self._record(self.store.finish_task, job.job_id, self.worker_id, False, "no_voice_id")
            return self._outcome_of(job, res, "no_voice_id")
        try:
            gone = self.provider.delete_voice(job.provider_voice_id)  # a 404 is "already gone": True
        except vp.ProviderError as e:
            word = _PROVIDER_WORDS.get(e.code, ("provider_error", False))[0]
            res = self._record(self.store.finish_task, job.job_id, self.worker_id, False, word)
            return self._outcome_of(job, res, word)
        if not gone:
            res = self._record(self.store.finish_task, job.job_id, self.worker_id, False, "provider_error")
            return self._outcome_of(job, res, "provider_error")
        res = self._record(self.store.finish_task, job.job_id, self.worker_id, True, None)
        if res is None or res.get("ok") is not True:
            return self._outcome_of(job, res, None)
        return Outcome(job.kind, "deleted", None, job.attempts)

    # -- purge the sample ------------------------------------------------------
    def _purge_sample(self, job: Job) -> Outcome:
        try:
            self.storage.delete_prefix(job.user_id, job.profile_id)
        except StorageError as e:
            word = "storage_" + e.code
            res = self._record(self.store.finish_task, job.job_id, self.worker_id, False, word)
            return self._outcome_of(job, res, word)
        if job.provider_voice_id is None and vp.is_owner_ref(job.owner_ref):
            # No voice was ever recorded for this profile, so a voice of its name in the provider account is an orphan: a create
            # whose answer was lost, in an attempt that then died for good. Its sample is gone; so is the clone it made.
            self._remove_orphans(job)
        res = self._record(self.store.finish_task, job.job_id, self.worker_id, True, None)
        if res is None or res.get("ok") is not True:
            return self._outcome_of(job, res, None)
        return Outcome(job.kind, "purged", None, job.attempts)


__all__ = ["enabled", "VoiceWorker", "VoiceStore", "SampleStorage", "StorageError", "Outcome", "Job", "AudioFacts",
           "ProbeError", "sniff_audio", "ffmpeg_probe", "whisper_transcriber", "SWITCH_ENV"]

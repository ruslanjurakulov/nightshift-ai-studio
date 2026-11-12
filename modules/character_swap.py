"""Character Studio's worker side (migration 0135, docs/CHARACTER_STUDIO.md): claim a priced swap, refuse what the vendor would refuse
before anything is paid, submit it to the model the person chose, record the vendor's task BEFORE polling, store the result in the media
library (source 'generated': labelled AI-made), and finish or fail it so the hold is captured or released.

DARK. ``tools/character_swap_worker.py`` does nothing unless ``NIGHTSHIFT_CHARACTER_STUDIO=on``, and the database sells nothing until the
owner sets a price per model (``character_swap_models.credits_per_usd``, seeded NULL) after the vendor's written answer.

The rules this module keeps, each learned elsewhere in the repository:

* **No paid call on an input the vendor refuses.** The library's own record (length, size, bytes) and ffprobe's frame rate are checked
  against the registry entry's ``character_swap`` limits first (``input_problems``); a refusal fails the job with a closed code and the
  hold is released, nothing was sent.
* **One job, one paid task.** ``submit`` happens once per job; its task id is recorded with ``record_character_swap_task`` before the
  first poll. A worker that resumes a job (the claim says ``resume``) polls the recorded task and never submits. A submit whose answer
  was lost is UNCONFIRMED SPEND: the job fails (the person is not charged) and nobody retries it.
* **Inputs travel as signed links, never as files from a job row.** The vendor fetches the video and the pictures from the Command
  Center's own ``/api/media/file/<id>/original`` with the same HMAC the web app signs (``lib/server/media.ts``: ``nightshift-media-v1``),
  valid for at most an hour. Nothing on a job row is fetched or trusted as a path.
* **No key in a message.** Adapter errors are already scrubbed; this module stores only closed codes.
* **The prompt screen is the database's.** ``prompt_problem`` answers what 0135's ``character_swap_prompt_problem`` answers
  (tests/security/test_sec_character_swap.py runs both on one corpus); the worker asks again before it sends the words anywhere.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import logging
import re
import shutil
import subprocess
import time
import unicodedata
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Dict, List, Mapping, Optional, Sequence
from urllib.parse import urlencode

import requests

logger = logging.getLogger(__name__)

FLAG = "NIGHTSHIFT_CHARACTER_STUDIO"
#: The public https origin the vendors fetch the signed inputs from (the Command Center's host).
ORIGIN_ENV = "NIGHTSHIFT_CHARACTER_STUDIO_PUBLIC_ORIGIN"
#: The web app's signing key (lib/server/media.ts mediaUrlSecret): the same value on both hosts.
SECRET_ENV = "MEDIA_URL_SECRET"
MIN_SECRET_CHARS = 32
LINK_TTL_S = 3600
CAPABILITY = "video_character_swap"
MODELS = ("kling-4.0-omni-edit", "seedance-2.5-edit")

# ── the prompt screen (0135's character_swap_prompt_patterns, the same list in the same order) ───────────────────────────────
PROMPT_PATTERNS = (
    " real (person|people|human|humans) ", " public figures? ", " celebrit(y|ies) ", " famous ", " politicians? ", " presidents? ",
    " prime minister ", " senators? ", " actors? ", " actress(es)? ", " singers? ", " rappers? ", " footballers? ", " streamers? ",
    " youtubers? ", " influencers? ", " bloggers? ", " deep ?fakes? ", " face ?swaps? ", " look ?alikes? ", " likeness of ",
    " impersonat[a-z]* ", " pretend(ing)? to be ", " looks? (just )?like ", " (child|children|kids?|minors?|bab(y|ies)|toddlers?) ",
    " teen[a-z]* ", " school ?(girl|boy)s? ", "знаменит", "президент", "политик", "актер", "актёр", "актрис", "певец", "певиц",
    "дипфейк", "ребен", "ребён", " дет(и|ей|ям) ", " mashhur ", " prezident ", " siyosatchi ", " aktyor ", " aktrisa ", " xonanda ",
    " bolalar? ", " chaqaloq ",
)
_PATTERNS = tuple(re.compile(p, re.IGNORECASE) for p in PROMPT_PATTERNS)
_CONTROL = re.compile("[\u0001-\u0009\u000b-\u001f\u007f-\u009f]")
_INVISIBLE = re.compile("[\u00ad\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff\U000e0000-\U000e0fff]")
_NAMES_A_CHARACTER = re.compile(r"@image\s*[0-9]", re.IGNORECASE)
_OTHER = re.compile("[^a-z0-9а-яё]+", re.IGNORECASE)
PROMPT_MAX = 2000


def normalize(text: str) -> str:
    """0135's character_swap_norm: NFKC, lower case, every run of other characters one space, a space at both ends."""
    return " " + _OTHER.sub(" ", unicodedata.normalize("NFKC", text or "").lower()).strip(" ") + " "


def prompt_problem(text) -> Optional[str]:
    """None for words that may be sent, else 0135's closed word. KEYWORD-WEAK BY DESIGN (see the migration's header)."""
    if not isinstance(text, str) or len(text) > PROMPT_MAX or not text.strip(" \n"):
        return "prompt_length"
    if _CONTROL.search(text) or _INVISIBLE.search(text):
        return "prompt_characters"
    if not _NAMES_A_CHARACTER.search(text):
        return "prompt_needs_character"
    norm = normalize(text)
    if any(p.search(norm) for p in _PATTERNS):
        return "prompt_real_person"
    return None


# ── signed input links (lib/server/media.ts signMedia, the same payload and HMAC) ────────────────────────────────────────────
_UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
_ORIGIN = re.compile(r"^https://[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$")
_MIME = re.compile(r"^(video|image)/[a-z0-9.+-]{1,40}$")


def sign_media(secret: bytes, asset_id: str, variant: str, mime: str, exp: int) -> str:
    payload = f"nightshift-media-v1\n{asset_id}\n{variant}\n{mime}\n{exp}".encode()
    return base64.urlsafe_b64encode(hmac.new(secret, payload, hashlib.sha256).digest()).rstrip(b"=").decode("ascii")


def signed_link(origin: str, secret: bytes, asset_id: str, mime: str, *, now: Optional[float] = None, ttl_s: int = LINK_TTL_S) -> str:
    """An https link the vendor can fetch the asset's ORIGINAL from until ``now + ttl_s`` (at most an hour, the web app's ceiling)."""
    aid = str(asset_id).lower()
    if not _UUID.fullmatch(aid) or not _MIME.fullmatch(str(mime)) or not _ORIGIN.fullmatch(origin) or len(secret) < MIN_SECRET_CHARS:
        raise ValueError("not a signable asset")
    exp = int(now if now is not None else time.time()) + max(1, min(int(ttl_s), LINK_TTL_S))
    q = urlencode({"t": mime, "exp": str(exp), "sig": sign_media(secret, aid, "original", mime, exp)})
    return f"{origin}/api/media/file/{aid}/original?{q}"


# ── the vendor's input limits (the registry entry's ``character_swap`` block) ───────────────────────────────────────────────
@dataclass(frozen=True)
class Limits:
    seconds: Sequence[int]
    references_max: int
    max_bytes: int
    fps: Sequence[int]
    min_side: int
    max_side: int
    min_pixels: int
    max_pixels: int
    keeps_original_audio: bool

    @staticmethod
    def of(entry) -> "Limits":
        sw = entry.raw["character_swap"]
        return Limits(tuple(sw["input_seconds"]), int(sw["reference_images_max"]), int(sw["input_max_bytes"]), tuple(sw["input_fps"]),
                      int(sw["input_min_side_px"]), int(sw["input_max_side_px"]), int(sw["input_min_pixels"]),
                      int(sw["input_max_pixels"]), bool(sw["keeps_original_audio"]))


def input_problems(video: Mapping, n_refs: int, limits: Limits, fps: Optional[float]) -> List[str]:
    """Closed words for what the vendor would refuse in this video, read from the library's record and ffprobe. Empty = send it."""
    out: List[str] = []
    try:
        secs, w, h, nbytes = float(video["duration_s"]), int(video["width"]), int(video["height"]), int(video["bytes"])
    except (KeyError, TypeError, ValueError):
        return ["input_unmeasured"]
    if not limits.seconds[0] <= secs <= limits.seconds[1]:
        out.append("input_length")
    if nbytes > limits.max_bytes:
        out.append("input_bytes")
    if min(w, h) < limits.min_side or max(w, h) > limits.max_side or not limits.min_pixels <= w * h <= limits.max_pixels:
        out.append("input_size")
    if fps is None:
        out.append("input_unmeasured")
    elif not limits.fps[0] - 0.01 <= fps <= limits.fps[1] + 0.01:
        out.append("input_fps")
    if not 1 <= n_refs <= limits.references_max:
        out.append("references_count")
    return out


def probe(ffprobe: str, path: Path, *, timeout_s: float = 30) -> Dict:
    """ffprobe's streams of a local file (the frame rate and whether there is a sound track): never raises."""
    try:
        done = subprocess.run([ffprobe, "-v", "error", "-show_streams", "-of", "json", str(path)], capture_output=True, timeout=timeout_s,
                              check=False)
        data = json.loads(done.stdout or b"{}")
    except (OSError, subprocess.SubprocessError, ValueError):
        return {}
    streams = data.get("streams") if isinstance(data, dict) else None
    video = next((s for s in streams or [] if isinstance(s, dict) and s.get("codec_type") == "video"), None)
    fps = None
    if video:
        try:
            num, den = str(video.get("avg_frame_rate") or video.get("r_frame_rate") or "0/1").split("/")
            fps = float(num) / float(den) if float(den) else None
        except ValueError:
            fps = None
    return {"fps": fps, "audio": any(isinstance(s, dict) and s.get("codec_type") == "audio" for s in streams or [])}


def remux_command(ffmpeg: str, edited: Path, source: Path, dest: Path) -> List[str]:
    """The edited picture with the SOURCE clip's own sound (a model that does not keep it): no re-encode of either, and the shorter of
    the two decides the length (Seedance's output can be up to 0.4 s shorter than its input)."""
    return [ffmpeg, "-v", "error", "-y", "-i", str(edited), "-i", str(source), "-map", "0:v:0", "-map", "1:a:0", "-c", "copy", "-shortest",
            str(dest)]


# ── the database (0135's worker functions, the service key) ─────────────────────────────────────────────────────────────────
class StoreUnavailable(Exception):
    """The database is out of reach: nothing is decided, the job stays as it is for the next claim."""


class SwapStore:
    def __init__(self, url: str, service_key: str, *, session=None, timeout: float = 30.0):
        self.url = url.rstrip("/")
        self._key = service_key
        self.session = session or requests.Session()
        self.timeout = timeout

    def _rpc(self, name: str, payload: dict):
        try:
            r = self.session.post(f"{self.url}/rest/v1/rpc/{name}", json=payload, timeout=self.timeout,
                                  headers={"apikey": self._key, "Authorization": f"Bearer {self._key}", "Content-Type": "application/json"})
        except requests.RequestException as e:
            raise StoreUnavailable(type(e).__name__) from None
        if r.status_code >= 500:
            raise StoreUnavailable(f"HTTP {r.status_code}")
        if r.status_code >= 300:
            try:
                word = (r.json() or {}).get("message") or ""
            except ValueError:
                word = ""
            raise RuntimeError(f"{name}: HTTP {r.status_code} {str(word)[:120]}")
        try:
            return r.json()
        except ValueError:
            return None

    def claim(self, worker: str) -> Optional[dict]:
        return self._rpc("claim_character_swap", {"p_worker": worker})

    def record_task(self, job: str, worker: str, task_id: str) -> dict:
        return self._rpc("record_character_swap_task", {"p_job": job, "p_worker": worker, "p_task": task_id})

    def finish(self, job: str, worker: str, output: str) -> dict:
        return self._rpc("finish_character_swap", {"p_job": job, "p_worker": worker, "p_output": output})

    def fail(self, job: str, worker: str, code: str) -> dict:
        return self._rpc("fail_character_swap", {"p_job": job, "p_worker": worker, "p_code": code})


# ── the job ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────
@dataclass
class Library:
    """Where the inputs are on this worker's media volume, and how a result is stored (modules/media_library)."""
    store: object
    media_root: Path
    tools: object


@dataclass
class CharacterSwapWorker:
    store: SwapStore
    worker_id: str
    library: Library
    scratch: Path
    origin: str
    secret: bytes
    registry: Mapping = field(default_factory=dict)
    adapter_env: Optional[Mapping[str, str]] = None
    build_adapter: Optional[Callable] = None
    poll_every_s: float = 10.0
    poll_limit_s: float = 45 * 60
    heartbeat_every_s: float = 60.0
    sleep: Callable[[float], None] = time.sleep
    clock: Callable[[], float] = time.monotonic
    runner: Callable[..., subprocess.CompletedProcess] = subprocess.run

    def _entry(self, model: str):
        if not self.registry:
            from modules import model_registry  # noqa: PLC0415

            self.registry = model_registry.registry()
        return self.registry.get(model)

    def _adapter(self, entry):
        if self.build_adapter is not None:
            return self.build_adapter(entry.adapter)
        from modules.capabilities import build_adapter  # noqa: PLC0415

        return build_adapter(entry.adapter, env=self.adapter_env)

    def run_once(self) -> bool:
        """One job, if there is one. True when a job was taken (whatever its end), False when the queue was empty."""
        job = self.store.claim(self.worker_id)
        if not job:
            return False
        jid = str(job.get("job_id") or "")
        try:
            self._run(job)
        except StoreUnavailable:
            # Nothing is decided: a recorded task is resumed by the next claim, an unrecorded one is swept as worker_lost (released).
            logger.warning("character swap %s: the database went out of reach; the job is left for the next claim", jid)
        return True

    def _fail(self, jid: str, code: str) -> None:
        self.store.fail(jid, self.worker_id, code)

    def _run(self, job: Mapping) -> None:
        from modules.capabilities.base import FAILED, SUCCEEDED, AdapterError, ProviderTask  # noqa: PLC0415

        jid = str(job["job_id"])
        entry = self._entry(str(job.get("model") or ""))
        if entry is None or entry.id not in MODELS or CAPABILITY not in entry.capabilities:
            self._fail(jid, "model_unknown")
            return
        adapter = self._adapter(entry)
        vendor_model = entry.vendor_model_for(CAPABILITY)
        work = self.scratch / jid
        work.mkdir(parents=True, exist_ok=True)
        try:
            source = self._source(job, work)
            if job.get("resume") and job.get("provider_task_id"):
                task = ProviderTask(entry.adapter, vendor_model, str(job["provider_task_id"]))
            else:
                problem = self._refusal(job, entry, source)
                if problem:
                    self._fail(jid, problem)
                    return
                request = self._request(job)
                bad = adapter.problems(request, entry)
                if bad:
                    logger.warning("character swap %s: refused before the vendor call: %s", jid, "; ".join(bad)[:300])
                    self._fail(jid, "bad_request")
                    return
                try:
                    task = adapter.submit(request, vendor_model, external_id=jid)
                except AdapterError as e:
                    # A proven refusal cost nothing; anything else may have started a billable task we never heard of.
                    self._fail(jid, e.code if e.not_accepted else "submit_unconfirmed")
                    return
                # BEFORE the first poll: a crash from here on polls this task, it never pays for a second one.
                self.store.record_task(jid, self.worker_id, str(task.task_id))
            result = self._poll(adapter, task, jid)
            if result is None:
                return  # still at the vendor: the next claim resumes it
            if result.state == FAILED:
                code = result.error.code if result.error else "vendor_failed"
                self._fail(jid, "policy" if code == "policy" else "vendor_failed")
                return
            if result.state != SUCCEEDED:
                return
            try:
                files = adapter.fetch(result, work, stem="edited")
            except AdapterError:
                # The vendor finished (and may bill); the link lives a while: leave it for the next claim's resume.
                logger.warning("character swap %s: the result could not be downloaded yet; left for the next claim", jid)
                return
            final = self._with_source_sound(entry, files[0], source, work)
            if final is None:
                self._fail(jid, "audio_remux_failed")
                return
            out_id = self._store(job, entry, final, task)
            if out_id is None:
                self._fail(jid, "store_failed")
                return
            self.store.finish(jid, self.worker_id, out_id)
        finally:
            shutil.rmtree(work, ignore_errors=True)

    def _source(self, job: Mapping, work: Path) -> Optional[Path]:
        from modules import media_library  # noqa: PLC0415

        video = job.get("input") or {}
        try:
            return media_library.copy_source(self.library.media_root, video.get("id"), str(video.get("mime") or ""), (), work, name="source",
                                             media=True)
        except (media_library.SourceUnavailable, ValueError, OSError):
            return None

    def _refusal(self, job: Mapping, entry, source: Optional[Path]) -> Optional[str]:
        if prompt_problem(job.get("prompt")) is not None:
            return "prompt_refused"
        if source is None:
            return "input_unavailable"
        tools = self.library.tools
        info = probe(tools.ffprobe, source) if tools else {}
        problems = input_problems(job.get("input") or {}, len(job.get("references") or ()), Limits.of(entry), info.get("fps"))
        return problems[0] if problems else None

    def _request(self, job: Mapping):
        from modules.capabilities.base import CapabilityRequest  # noqa: PLC0415

        video = job["input"]
        refs = list(job.get("references") or [])
        media = (signed_link(self.origin, self.secret, video["id"], video["mime"]),)
        images = tuple(signed_link(self.origin, self.secret, r["id"], r["mime"]) for r in refs)
        return CapabilityRequest(capability=CAPABILITY, prompt=str(job["prompt"]), resolution=str(job["resolution"]), input_media=media,
                                 input_images=images, end_user=str(job.get("end_user") or "") or None)

    def _poll(self, adapter, task, jid: str):
        from modules.capabilities.base import AdapterError, PENDING  # noqa: PLC0415

        started = last_beat = self.clock()
        while True:
            try:
                result = adapter.poll(task)
            except AdapterError as e:
                if not e.retryable:
                    logger.warning("character swap %s: polling failed (%s); left for the next claim", jid, e.code)
                    return None
                result = None
            if result is not None and result.state != PENDING:
                return result
            if self.clock() - started > self.poll_limit_s:
                return None
            if self.clock() - last_beat >= self.heartbeat_every_s:
                self.store.record_task(jid, self.worker_id, str(task.task_id))   # the same id: a heartbeat
                last_beat = self.clock()
            self.sleep(self.poll_every_s)

    def _with_source_sound(self, entry, edited: Path, source: Optional[Path], work: Path) -> Optional[Path]:
        if Limits.of(entry).keeps_original_audio or source is None:
            return edited
        tools = self.library.tools
        if not tools:
            return None
        if not probe(tools.ffprobe, source).get("audio"):
            return edited
        dest = work / "with_sound.mp4"
        try:
            done = self.runner(remux_command(tools.ffmpeg, edited, source, dest), capture_output=True, timeout=300, check=False)
        except (OSError, subprocess.SubprocessError):
            return None
        return dest if done.returncode == 0 and dest.is_file() and dest.stat().st_size > 0 else None

    def _store(self, job: Mapping, entry, path: Path, task) -> Optional[str]:
        from modules import media_library  # noqa: PLC0415

        out_id = str(uuid.uuid4())
        provenance = {"origin": "character_swap", "job_id": str(job["job_id"]), "provider": entry.provider, "model": entry.id,
                      "vendor_model": entry.vendor_model_for(CAPABILITY), "resolution": str(job.get("resolution") or ""),
                      # docs/AI_DISCLOSURE.md: an altered real scene. The label travels with the file into every export.
                      "ai_label": "altered_or_synthetic", "ai_reasons": ["generated_video", "people_replaced"]}
        try:
            media_library.store_generated(path, asset_id=out_id, org_id=str(job["org_id"]), store=self.library.store,
                                          media_root=self.library.media_root, tools=self.library.tools, provenance=provenance,
                                          expect_kind="video", parent_asset_id=str((job.get("input") or {}).get("id") or "") or None,
                                          source="generated", project_id=job.get("project_id") or None)
        except (media_library.IngestReject, media_library.StoreUnavailable, OSError, ValueError):
            return None
        return out_id

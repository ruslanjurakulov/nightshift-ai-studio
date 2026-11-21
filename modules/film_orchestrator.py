"""Film Studio P3: the segment worker. Drives one film segment through migration 0171's state machine.

    film_claim_segment            the database hands this worker one segment (and its lease); the first claim starts the hold
    film_heartbeat_segment        on an interval well inside the lease (10 minutes stale), for the segment's WHOLE life: the takes,
                                  the assembly and the settle. There is no handoff: every service call checks the lease's worker id
    for each planned take, in this order:
        key frames                (they are what the clips start from, and a clip may END on the next scene's key frame)
        clips and extends         scene by scene, shot by shot: shot 1 from its first frame, shots 2-3 from the shot before's last frame
        narration                 one film-level take, last
      film_studio_on_for(org)     the platform's switch and the organization's (0198), asked again before every take: off = stop
      film_begin_take             marked running BEFORE the billable call
      film_take_job               the take's creative job (0198): payer 'film', no hold of its own, the inputs decided by the database
      the adapter                 the take's named model and nothing else (CLAUDE.md #4: no fallback model, ever)
      register_asset              every result file through the job (source 'generated', provenance film_take_id), attached to the job
      last frame                  every clip and extend: its last frame extracted (ffmpeg_limits) and registered as a picture
      film_take_succeeded         with the provider's task id; or film_take_failed with the closed code (FILM_ERROR_CODES)
    film_begin_assembly           when every take is completed and at least one clip exists
    modules.film_assembly         the assembly session's code (S11): assemble_segment(...) records the assembly itself
    film_settle_segment           exactly once: 'completed', or the reason it stopped

Money is 0171's, all of it. This module never computes a charge, never captures, never releases, never retries on its own: a failed take
gets 0171's ONE automatic retry (an attempt-2 take that film_take_failed plans), which this loop simply runs in its turn. Concurrency per
organization is 0171's claim. A worker that dies mid-take leaves a running take and a lease that lapses: the next claim resumes it (a
stored task id is polled, never submitted again) or, after the third lease, 0171 fails what is in flight as worker_lost and settles.

Never paying twice: a take's job that recorded 'submitting' but no task id (the worker died during the paid call) is failed as
worker_lost, never submitted again; a synchronous answer held only in memory (task id ``sync:``/``film-tts:``) cannot be fetched again
and fails as no_output. Both are charged 0 (0171), and 0171 plans the retry.

The narration is voiced one scene at a time and laid out on the film's clock (docs/FILM_STUDIO.md, P4a): each scene's words start
NARRATION_LEAD_S into the scene. The file's provenance carries the per-scene ``segments`` and the measured ``loudness_lufs`` /
``true_peak_db`` (null when not measured, never a default: CLAUDE.md #5), which the assembly reads.

Nothing here logs a key, a token, a prompt or a provider body: errors are logged by type and machine code, and stored text goes through
the scrubber the CLI provides.
"""

from __future__ import annotations

import importlib
import logging
import os
import re
import shutil
import threading
import time
import uuid
from dataclasses import dataclass, replace
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Dict, List, Mapping, Optional, Sequence, Tuple

from modules import creative_worker as cw

logger = logging.getLogger("film_worker")

#: The only words film_take_failed's error code may carry (the live view maps each to a customer line and a remedy:
#: docs/studio/NIGHTSHIFT_AI.md, "Film run status (P3)"). Every code this module emits is one of these.
FILM_ERROR_CODES = frozenset({
    "auth", "quota", "plan_required", "rate_limited", "bad_request", "voice_not_found", "moderated", "provider_error", "timeout",
    "too_short", "no_output", "worker_lost", "film_studio_off",
})

#: The adapter layer's codes (modules/capabilities/base.py, modules/creative_worker.py, modules/creative_adapters.py) onto the closed
#: list. Anything not named here is provider_error.
_CODE_MAP = {
    "auth": "auth", "not_configured": "auth", "adapter_missing": "auth", "capability_not_supported": "auth",
    "quota": "quota",
    "plan_required": "plan_required",
    "rate_limited": "rate_limited",
    "bad_request": "bad_request", "not_found": "bad_request", "vendor_tool_unsupported": "bad_request",
    "style_unavailable": "bad_request", "source_unavailable": "bad_request", "input_missing": "bad_request",
    "invalid_params": "bad_request",
    "voice_not_found": "voice_not_found", "voice_not_allowed": "voice_not_found",
    "policy": "moderated", "moderated": "moderated",
    "provider_timeout": "timeout", "timeout": "timeout",
    "bad_response": "no_output", "output_lost": "no_output", "no_output": "no_output",
    "too_short": "too_short", "output_too_short": "too_short",
    "worker_lost": "worker_lost", "submit_interrupted": "worker_lost",
}
#: ElevenLabs' own words for a voice that is not the account's (modules/capabilities/audio.py, _EL_VOICE).
_VOICE_VENDOR_CODES = frozenset({"voice_not_found", "invalid_voice_id"})

#: The assembly session's own switch (modules/film_assembly.py): only `on` begins an assembly.
ASSEMBLY_FLAG = "NIGHTSHIFT_FILM_ASSEMBLY"
#: The order takes run in: a clip needs its key frame (and may end on the next scene's), the narration comes last.
PHASE = {"keyframe": 0, "clip": 1, "extend": 1, "narration": 2}
#: What each take's file is.
OUTPUT_KIND = {"keyframe": "image", "clip": "video", "extend": "video", "narration": "audio"}
#: Each scene's narration starts this far into the scene (modules/film_timeline.NARRATION_LEAD_S), and ends at least this far before it.
NARRATION_LEAD_S = 0.25
NARRATION_TAIL_S = 0.25
#: Asset ids of a take's files come from its job id, so a retried store reuses the same rows.
ASSET_NS = uuid.UUID("5b0c1d1e-0198-4f11-9c3e-f11a5e6e0a01")
#: The segment's lease goes stale after 0171's 10 minutes; the heartbeat runs every minute, through the assembly too.
STALE_MINUTES = 10
DEFAULT_HEARTBEAT_SECONDS = 60.0
DEFAULT_POLL_SECONDS = 5.0
DEFAULT_MAX_POLL_SECONDS = 45 * 60
MAX_POLL_ERRORS = 10
MAX_ERROR_CHARS = 2000
_WORD = re.compile(r"^[a-z][a-z0-9_]{0,63}$")


def film_error_code(code: Optional[str], *, vendor_code: str = "", http_status: Optional[int] = None,
                    capability: Optional[str] = None) -> str:
    """An adapter's (or the worker's) failure as one of FILM_ERROR_CODES. The ElevenLabs adapter reports an unknown voice as a
    bad_request whose vendor code names the voice (or a 404 on the voice's own URL): that is voice_not_found, whose remedy is the
    person's (pick another voice), never ours."""
    c = str(code or "")
    if capability == "tts" and c == "bad_request" and (vendor_code in _VOICE_VENDOR_CODES or http_status == 404):
        return "voice_not_found"
    return _CODE_MAP.get(c, "provider_error")


def failure_kind(code: str) -> str:
    """film_take_failed's p_failure: 'moderated' for a moderation refusal (0171 records what the vendor bills for it), else
    'provider_error'."""
    return "moderated" if code == "moderated" else "provider_error"


def _vendor_code(adapter: Any) -> str:
    inner = getattr(adapter, "adapter", None)
    v = getattr(inner, "last_vendor_code", "") if inner is not None else ""
    return v if isinstance(v, str) else ""


def _parse_ts(v: Any) -> Optional[float]:
    if not isinstance(v, str) or not v:
        return None
    try:
        d = datetime.fromisoformat(v.replace("Z", "+00:00"))
    except ValueError:
        return None
    if d.tzinfo is None:
        d = d.replace(tzinfo=timezone.utc)
    return d.timestamp()


def _assembly_raised(exc: BaseException, mod: Any, name: str) -> bool:
    """One of modules.film_assembly's own exceptions (DbUnavailable, AssemblyDisabled), matched by the module's class when it is loaded
    and by its name otherwise, so this module imports whether or not the assembly is installed."""
    cls = getattr(mod, name, ()) if mod is not None else ()
    if isinstance(cls, type) and isinstance(exc, cls):
        return True
    return any(c.__name__ == name for c in type(exc).__mro__)


class FilmUnavailable(RuntimeError):
    """The database could not be reached. Never carries a key or a body."""


class FilmRefused(RuntimeError):
    """A service function refused (its machine word: lease_lost, not_running, take_not_running, not_complete, ...)."""

    def __init__(self, word: str, detail: str = ""):
        super().__init__(word)
        self.word = word
        self.detail = detail


class _TakeFailed(Exception):
    """The take ends now without a result; ``code`` is one of FILM_ERROR_CODES."""

    def __init__(self, code: str, message: str, units_done: Optional[int] = None):
        super().__init__(message)
        self.code = code if code in FILM_ERROR_CODES else "provider_error"
        self.message = message
        self.units_done = units_done


class _Stop(Exception):
    """This worker must stop driving the segment now (the lease is gone, or the process is stopping); nothing is settled."""

    def __init__(self, why: str):
        super().__init__(why)
        self.why = why


@dataclass(frozen=True)
class AssemblyOutcome:
    """What modules.film_assembly.assemble_segment answers (the assembly session's contract)."""
    ok: bool
    asset_id: Optional[str] = None
    reason: Optional[str] = None
    detail: Optional[str] = None
    #: Whether film_record_assembly took the outcome (S11). Read for the log only: the settle follows any returned outcome.
    recorded: Optional[bool] = None


@dataclass(frozen=True)
class DriveOutcome:
    segment_id: str
    #: settled (film_settle_segment answered settled) | draining (it answered not yet) | settled_by_db (0171 settled it itself:
    #: the hold was lost, a refund waits) | left (the lease is gone or the worker is stopping; nothing settled here)
    result: str
    reason: Optional[str] = None


# ── the lease ───────────────────────────────────────────────────────────────

class _Lease:
    """Keeps the segment's lease (and the running take's creative job) alive while this worker drives it. ``lost`` is set the moment
    the database says the segment is no longer this worker's."""

    def __init__(self, db, segment_id: str, worker_id: str, every: float):
        self.db = db
        self.segment_id = segment_id
        self.worker_id = worker_id
        self.every = every
        self.lost = threading.Event()
        self.job_id: Optional[str] = None
        self._stop = threading.Event()
        self._thread: Optional[threading.Thread] = None

    def __enter__(self):
        if self.every > 0:
            self._thread = threading.Thread(target=self._run, daemon=True, name="film-lease")
            self._thread.start()
        return self

    def beat(self) -> None:
        try:
            if self.db.heartbeat(self.segment_id, self.worker_id) is False:
                self.lost.set()
                return
            job = self.job_id
            if job:
                self.db.heartbeat_job(job, self.worker_id)
        except Exception as e:  # a missed beat is not a lost lease
            logger.warning("segment %s: heartbeat failed (%s)", self.segment_id, type(e).__name__)

    def _run(self):
        while not self._stop.wait(self.every):
            self.beat()
            if self.lost.is_set():
                return

    def __exit__(self, *exc):
        self._stop.set()
        if self._thread:
            self._thread.join(timeout=5)
        return False


# ── the media side (ffmpeg_limits, the library) ─────────────────────────────

class Media:
    """The files of a take: copied from the media volume by id, registered into the library, a clip's last frame extracted, the
    narration laid out on the film's clock and measured. Every ffmpeg runs under ffmpeg_limits."""

    def __init__(self, store, media_root: Path, tools):
        self.store = store
        self.media_root = Path(media_root)
        self.tools = tools

    def copy_input(self, item: Mapping[str, Any], dest: Path, name: str) -> Path:
        from modules import media_library as ml  # noqa: PLC0415

        return ml.copy_source(self.media_root, str(item["asset_id"]), str(item.get("mime") or ""), list(item.get("variants") or ()),
                              dest, name=name)

    def store_file(self, path: Path, *, asset_id: str, org_id: str, provenance: Mapping[str, Any], expect_kind: str,
                   parent_asset_id: Optional[str] = None) -> dict:
        from modules import media_library as ml  # noqa: PLC0415

        return ml.store_generated(path, asset_id=asset_id, org_id=org_id, store=self.store, media_root=self.media_root,
                                  tools=self.tools, provenance=provenance, expect_kind=expect_kind, parent_asset_id=parent_asset_id)

    def _ffmpeg(self, argv: Sequence[str], timeout_s: float):
        from modules import ffmpeg_limits  # noqa: PLC0415

        return ffmpeg_limits.run(argv, timeout_s=timeout_s)

    def last_frame(self, video: Path, out: Path) -> Path:
        """The clip's last decoded frame as a PNG: seek to the last second and keep overwriting one image."""
        from modules import ffmpeg_limits  # noqa: PLC0415

        out.unlink(missing_ok=True)
        argv = [self.tools.ffmpeg, "-hide_banner", "-loglevel", "error", "-nostdin", *ffmpeg_limits.decode_thread_options(),
                "-sseof", "-1", "-i", str(video), *ffmpeg_limits.thread_options(), "-an", "-update", "1", "-y", str(out)]
        res = self._ffmpeg(argv, 120)
        if not res.ok or not out.is_file() or out.stat().st_size == 0:
            raise RuntimeError("last frame not extracted")
        return out

    def duration(self, path: Path) -> Optional[float]:
        from modules import media_library as ml  # noqa: PLC0415

        with open(path, "rb") as f:
            sniffed = ml.sniff(f.read(4096))
        if not sniffed:
            return None
        info = ml.run_probe(self.tools.ffprobe, Path(path), sniffed)
        d = info.duration
        return float(d) if d and d > 0 else None

    def narration_mix(self, clips: Sequence[Tuple[Path, float]], out: Path) -> Path:
        """One audio file on the film's clock: each scene's clip delayed to its start, mixed without normalisation (amix would
        otherwise lower every clip by the number of inputs)."""
        from modules import ffmpeg_limits  # noqa: PLC0415

        argv: List[str] = [self.tools.ffmpeg, "-hide_banner", "-loglevel", "error", "-nostdin"]
        for path, _ in clips:
            argv += [*ffmpeg_limits.decode_thread_options(), "-i", str(path)]
        parts = [f"[{i}:a]adelay={int(round(start * 1000))}:all=1[a{i}]" for i, (_, start) in enumerate(clips)]
        graph = ";".join(parts) + ";" + "".join(f"[a{i}]" for i in range(len(clips))) + \
            f"amix=inputs={len(clips)}:normalize=0:duration=longest[out]"
        argv += [*ffmpeg_limits.thread_options(), "-filter_complex", graph, "-map", "[out]", "-c:a", "aac", "-b:a", "192k",
                 "-y", str(out)]
        res = self._ffmpeg(argv, 600)
        if not res.ok or not out.is_file() or out.stat().st_size == 0:
            raise RuntimeError("narration not mixed")
        return out

    def loudness(self, path: Path) -> Tuple[Optional[float], Optional[float]]:
        """(integrated LUFS, true peak dBTP) as ffmpeg's ebur128 measured them, or None for what it did not report."""
        from modules import ffmpeg_limits  # noqa: PLC0415

        argv = [self.tools.ffmpeg, "-hide_banner", "-nostdin", "-loglevel", "info", *ffmpeg_limits.decode_thread_options(),
                "-i", str(path), "-af", "ebur128=peak=true:framelog=verbose", "-f", "null", "-"]
        res = self._ffmpeg(argv, 300)
        if not res.ok:
            return None, None
        return parse_ebur128(res.tail)


def parse_ebur128(text: str) -> Tuple[Optional[float], Optional[float]]:
    """The Summary block of ffmpeg's ebur128 filter: ``I: -16.2 LUFS`` and, under True peak, ``Peak: -1.4 dBFS``."""
    summary = text[text.rfind("Summary:"):] if "Summary:" in text else ""
    if not summary:
        return None, None
    i = re.search(r"\bI:\s+(-?\d+(?:\.\d+)?)\s+LUFS", summary)
    p = re.search(r"True peak:\s+Peak:\s+(-?\d+(?:\.\d+)?)\s+dBFS", summary)
    lufs = float(i.group(1)) if i else None
    peak = float(p.group(1)) if p else None
    if lufs is not None and not -70 <= lufs <= 0:
        lufs = None
    return lufs, peak


# ── the driver ──────────────────────────────────────────────────────────────

class FilmOrchestrator:
    """Drives claimed segments. ``db`` is the service client (FilmRest, or a fake in tests); ``resolve_adapter`` is the creative
    worker's resolver (``model_id -> adapter | None``); ``media`` is :class:`Media` (or a fake)."""

    def __init__(self, db, resolve_adapter: cw.AdapterResolver, *, worker_id: str, media, out_dir: Path,
                 media_root: Optional[Path] = None, tools=None,
                 scrub: Callable[[str], str] = lambda s: s,
                 assemble: Optional[Callable[..., Any]] = None,
                 heartbeat_seconds: float = DEFAULT_HEARTBEAT_SECONDS,
                 poll_seconds: float = DEFAULT_POLL_SECONDS,
                 max_poll_seconds: float = DEFAULT_MAX_POLL_SECONDS,
                 stop: Optional[threading.Event] = None,
                 sleep: Callable[[float], None] = time.sleep,
                 clock: Callable[[], float] = time.monotonic,
                 now: Callable[[], float] = time.time,
                 env: Optional[Mapping[str, str]] = None):
        self.db = db
        self.resolve_adapter = resolve_adapter
        self.worker_id = worker_id
        self.media = media
        self.out_dir = Path(out_dir)
        self.media_root = media_root
        self.tools = tools
        self.scrub = scrub
        self._assemble = assemble
        self.heartbeat_seconds = heartbeat_seconds
        self.poll_seconds = poll_seconds
        self.max_poll_seconds = max_poll_seconds
        self.stop = stop or threading.Event()
        self.sleep = sleep
        self.clock = clock
        self.now = now
        self.env = os.environ if env is None else env
        self._lease: Optional[_Lease] = None

    # -- one claim -------------------------------------------------------------

    def run_once(self) -> Optional[DriveOutcome]:
        seg = self.db.claim(self.worker_id, STALE_MINUTES)
        if not seg:
            return None
        return self.drive(seg)

    def drive(self, seg: Mapping[str, Any]) -> DriveOutcome:
        sid = str(seg["id"])
        with _Lease(self.db, sid, self.worker_id, self.heartbeat_seconds) as lease:
            self._lease = lease
            try:
                return self._drive(seg, lease)
            except _Stop as s:
                logger.info("segment %s: stopped driving (%s); nothing settled here", sid, s.why)
                return DriveOutcome(sid, "left", s.why)
            except FilmRefused as r:
                if r.word == "lease_lost":
                    return DriveOutcome(sid, "left", "lease_lost")
                logger.warning("segment %s: refused (%s); left for the sweep", sid, r.word)
                return DriveOutcome(sid, "left", r.word)
            except FilmUnavailable as e:
                # Nothing can be recorded now: the lease lapses and the next claim resumes (a stored task id is polled).
                logger.warning("segment %s: %s; left for the next claim", sid, e)
                return DriveOutcome(sid, "left", "db_unavailable")
            finally:
                self._lease = None
                shutil.rmtree(self.out_dir / sid, ignore_errors=True)

    def _check(self, lease: _Lease) -> None:
        if lease.lost.is_set():
            raise _Stop("lease_lost")
        if self.stop.is_set():
            raise _Stop("stopping")

    def _drive(self, seg: Mapping[str, Any], lease: _Lease) -> DriveOutcome:
        sid, org, film = str(seg["id"]), str(seg["org_id"]), str(seg["film_id"])
        asm = (seg.get("assembly") or {}).get("status")
        if asm == "running":
            # A worker died during the assembly: it is run again, under this lease (S11's contract).
            return self._assembly(seg, sid)
        if asm in ("completed", "failed"):
            return self._settle(sid, "completed" if asm == "completed" else "assembly_failed")
        deadline = _parse_ts(seg.get("deadline_at"))
        scenes = {str(s["id"]): s for s in self.db.scenes(film)}
        stopped: Optional[str] = None
        attempted: set = set()
        while True:
            self._check(lease)
            takes = self.db.takes(sid)
            nxt = self._next_take(takes, scenes, attempted)
            if nxt is None:
                break
            take, ready = nxt
            if take["status"] == "planned":
                if deadline is not None and self.now() >= deadline:
                    stopped = "deadline"
                    break
                if seg.get("status") == "draining":
                    break
            if not self.db.studio_on_for(org):
                stopped = "film_studio_off"
                break
            attempted.add(str(take["id"]))
            if not ready:
                continue  # its input failed for good: it never begins, and the settle skips it at 0
            try:
                began = self.db.begin_take(str(take["id"]), self.worker_id)
            except FilmRefused as r:
                if r.word == "not_running":  # drained, or past its deadline: nothing new begins
                    stopped = stopped or "deadline"
                    break
                if r.word == "take_not_planned":
                    continue
                raise
            if began.get("began") is False:
                # 0171 settled the segment itself (the hold is gone, or a refund waits on it): nothing more to do here.
                return DriveOutcome(sid, "settled_by_db", str(began.get("reason") or ""))
            self._run_take(seg, take, lease)
        return self._finish(sid, stopped)

    def _next_take(self, takes: Sequence[Mapping[str, Any]], scenes: Mapping[str, Mapping[str, Any]],
                   attempted: set) -> Optional[Tuple[Mapping[str, Any], bool]]:
        """The next take to run (a running one first: a worker before this one left it), and whether its inputs are there."""
        def pos(t):
            sc = scenes.get(str(t.get("scene_id"))) if t.get("scene_id") else None
            return int(sc["position"]) if sc else 10 ** 6

        todo = [t for t in takes if t["status"] in ("planned", "running") and str(t["id"]) not in attempted]
        if not todo:
            return None
        todo.sort(key=lambda t: (0 if t["status"] == "running" else 1, PHASE.get(t["kind"], 9), pos(t), int(t["shot_index"]),
                                 int(t["attempt"])))
        t = todo[0]
        return t, t["status"] == "running" or self._inputs_ready(t, takes, scenes)

    @staticmethod
    def _slot(takes, kind_ok: Callable[[str], bool], scene_id: str, shot: Optional[int]) -> Optional[str]:
        """The status of the newest attempt of a slot of this segment, or None when there is none."""
        rows = [t for t in takes if kind_ok(t["kind"]) and str(t.get("scene_id")) == scene_id
                and (shot is None or int(t["shot_index"]) == shot)]
        if not rows:
            return None
        return max(rows, key=lambda t: int(t["attempt"]))["status"]

    def _inputs_ready(self, t, takes, scenes) -> bool:
        """Every take this one starts (or ends) from is completed. The order guarantees each was tried before; one that did not
        complete failed for good."""
        if t["kind"] in ("keyframe", "narration"):
            return True
        sc = scenes.get(str(t.get("scene_id")))
        if sc is None:
            return False
        need: List[Optional[str]] = []
        clipish = lambda k: k in ("clip", "extend")  # noqa: E731
        if t["kind"] == "extend":
            need.append(self._slot(takes, clipish, str(sc["id"]), int(t["shot_index"]) - 1))
        elif sc.get("first_frame") == "keyframe":
            need.append(self._slot(takes, lambda k: k == "keyframe", str(sc["id"]), None))
        elif sc.get("first_frame") == "previous":
            prev = max((s for s in scenes.values() if int(s["position"]) < int(sc["position"])),
                       key=lambda s: int(s["position"]), default=None)
            need.append(self._slot(takes, clipish, str(prev["id"]), int(prev.get("shot_count") or 1)) if prev else None)
        if (t.get("params") or {}).get("end_frame") and sc.get("last_frame") == "next_keyframe":
            nxt = min((s for s in scenes.values() if int(s["position"]) > int(sc["position"])),
                      key=lambda s: int(s["position"]), default=None)
            need.append(self._slot(takes, lambda k: k == "keyframe", str(nxt["id"]), None) if nxt else None)
        return all(n == "completed" for n in need)

    # -- the end of the takes ----------------------------------------------------

    def _finish(self, sid: str, stopped: Optional[str]) -> DriveOutcome:
        takes = self.db.takes(sid)
        live = [t for t in takes if t["status"] != "superseded"]
        clips = any(t["kind"] in ("clip", "extend") and t["status"] == "completed" for t in live)
        if stopped is None and live and clips and all(t["status"] == "completed" for t in live):
            installed = self._assemble is not None or self._assembly_module() is not None
            if installed and str(self.env.get(ASSEMBLY_FLAG, "") or "") != "on":
                # The assembly is installed but switched off: it is not begun, and the segment is left as it is (its takes are
                # made). 0171 settles it: the claim after its last lease, or the sweep at the deadline plus the grace.
                logger.warning("segment %s: every take is made, but %s is not 'on': the assembly is not begun", sid, ASSEMBLY_FLAG)
                return DriveOutcome(sid, "left", "assembly_switched_off")
            try:
                seg = self.db.begin_assembly(sid, self.worker_id)
            except FilmRefused as r:
                if r.word == "lease_lost":
                    raise
                logger.warning("segment %s: the assembly did not begin (%s)", sid, r.word)
                return self._settle(sid, "assembly_failed")
            if (seg.get("assembly") or {}).get("status") == "running":
                return self._assembly(seg, sid)
            return self._settle(sid, "assembly_failed")
        if stopped:
            return self._settle(sid, stopped)
        return self._settle(sid, "takes_failed" if any(t["status"] in ("failed", "planned", "skipped") for t in live)
                            else "incomplete")

    def _assembly(self, seg: Mapping[str, Any], sid: str) -> DriveOutcome:
        outcome = self._run_assembly(seg, sid)
        reason = "completed" if outcome.ok else (outcome.reason if isinstance(outcome.reason, str) and _WORD.match(outcome.reason)
                                                  else "assembly_failed")
        return self._settle(sid, reason)

    @staticmethod
    def _assembly_module():
        """modules.film_assembly, or None when it is not installed on this worker (another module it fails to import is an error)."""
        try:
            return importlib.import_module("modules.film_assembly")
        except ModuleNotFoundError as e:
            if e.name != "modules.film_assembly":
                raise
            return None

    def _run_assembly(self, seg: Mapping[str, Any], sid: str) -> AssemblyOutcome:
        assemble = self._assemble
        mod = None
        if assemble is None:
            mod = self._assembly_module()
            assemble = getattr(mod, "assemble_segment", None) if mod is not None else None
            if assemble is None:
                # The assembly session's module is not deployed here: say so in the record, never guess an assembly.
                logger.error("segment %s: assembly_unavailable (modules.film_assembly is not installed)", sid)
                self._record_assembly_failed(sid)
                return AssemblyOutcome(False, None, "assembly_unavailable", "the assembly is not installed on this worker")
        try:
            out = assemble(dict(seg), worker_id=self.worker_id, db=self.db, media_root=self.media_root, tools=self.tools)
        except Exception as e:
            if _assembly_raised(e, mod, "DbUnavailable"):
                # The database gave no decision: nothing was recorded and the assembly is still running. Nothing is settled here;
                # a later claim runs the assembly again (S11's contract).
                logger.warning("segment %s: the assembly could not reach the database; left for the next claim", sid)
                raise _Stop("assembly_db_unavailable") from None
            if _assembly_raised(e, mod, "AssemblyDisabled"):
                # Its own switch (NIGHTSHIFT_FILM_ASSEMBLY) is off: nothing recorded, nothing settled; 0171's expiry ends it.
                logger.warning("segment %s: the assembly is switched off (%s); left as it is", sid, ASSEMBLY_FLAG)
                raise _Stop("assembly_switched_off") from None
            # Its failure path is its own; one that raised otherwise may not have recorded, so the record says failed.
            logger.error("segment %s: the assembly raised %s", sid, type(e).__name__)
            self._record_assembly_failed(sid)
            return AssemblyOutcome(False, None, "assembly_failed", None)
        ok = bool(getattr(out, "ok", False))
        recorded = getattr(out, "recorded", None)
        if recorded is False:
            logger.warning("segment %s: the assembly says its outcome was not recorded", sid)
        return AssemblyOutcome(ok, getattr(out, "asset_id", None), getattr(out, "reason", None), getattr(out, "detail", None), recorded)

    def _record_assembly_failed(self, sid: str) -> None:
        try:
            self.db.record_assembly(sid, self.worker_id, False, None)
        except FilmRefused as r:
            # Already ended (the assembly recorded its own outcome): 0171 answers that as it is, or as a conflict.
            logger.warning("segment %s: the failed assembly was not recorded here (%s)", sid, r.word)

    def _settle(self, sid: str, reason: str) -> DriveOutcome:
        out = self.db.settle(sid, self.worker_id, reason)
        settled = isinstance(out, Mapping) and (out.get("settled") is True or out.get("status") in ("settled", "released"))
        logger.info("segment %s: settle %s -> %s", sid, reason, "settled" if settled else "draining")
        return DriveOutcome(sid, "settled" if settled else "draining", reason)

    # -- one take ----------------------------------------------------------------

    def _run_take(self, seg: Mapping[str, Any], take: Mapping[str, Any], lease: _Lease) -> str:
        tid = str(take["id"])
        try:
            tj = self.db.take_job(tid, self.worker_id)
        except FilmRefused as r:
            if r.word == "lease_lost":
                raise
            return self._fail(tid, None, film_error_code(r.word), f"the take's job could not be made ({r.word})")
        if tj.get("ok") is not True:
            reason = str(tj.get("reason") or "bad_request")
            return self._fail(tid, None, film_error_code(reason), str(tj.get("detail") or reason))
        job = str(tj["job_id"])
        lease.job_id = job
        try:
            return self._make(seg, take, tj, job, lease)
        except _TakeFailed as f:
            return self._fail(tid, job, f.code, f.message, f.units_done)
        finally:
            lease.job_id = None
            shutil.rmtree(self.out_dir / str(seg["id"]) / tid, ignore_errors=True)

    def _fail(self, take_id: str, job_id: Optional[str], code: str, message: str, units_done: Optional[int] = None) -> str:
        code = code if code in FILM_ERROR_CODES else "provider_error"
        text = self.scrub(message or code)[:MAX_ERROR_CHARS]
        out = self.db.take_failed(take_id, self.worker_id, failure_kind(code), code, text, units_done)
        if job_id:
            try:
                self.db.finish_job(job_id, self.worker_id, False, error_code=code, error=text)
            except Exception as e:  # the job is a record; the take's money is 0171's and is already settled above
                logger.warning("take %s: its job's failure was not recorded (%s)", take_id, type(e).__name__)
        return "retried" if isinstance(out, Mapping) and out.get("retry_take_id") else "failed"

    def _make(self, seg, take, tj: Mapping[str, Any], job: str, lease: _Lease) -> str:
        tid, kind = str(take["id"]), str(take["kind"])
        status, task = str(tj.get("job_status") or ""), tj.get("provider_task_id")
        if status in ("completed", "failed", "cancelled", "expired"):
            raise _TakeFailed("worker_lost", "the take's job ended while no worker held it")
        if tj.get("job_worker") != self.worker_id:
            # film_take_job hands a live job to the lease holder; one it could not (the creative queue took it back) is lost.
            raise _TakeFailed("worker_lost", "the take's job is no longer this worker's")
        model = str(take.get("model") or "")
        adapter = self.resolve_adapter(model)
        if adapter is None:
            raise _TakeFailed("auth", f"this worker has no adapter for {model}")
        work = self.out_dir / str(seg["id"]) / tid
        request = cw.GenerationRequest(job_id=job, org_id=str(seg["org_id"]), capability=str(tj["capability"]), model=model,
                                       params=dict(tj.get("params") or {}),
                                       quantity=float(take["quantity"]) if take.get("quantity") is not None else None)
        if task:
            if str(task).startswith(("sync:", "film-tts:")):
                raise _TakeFailed("no_output", "the worker stopped after the provider answered and before the result was stored")
            files = self._poll(adapter, str(task), request, work / "out", lease)
            return self._deliver(seg, take, tj, job, request, files, str(task), work, None, processing=status == "processing")
        if tj.get("submit_started"):
            # The paid call may have reached the vendor: it is never made again (0171 plans the retry, charged once).
            raise _TakeFailed("worker_lost", "the worker stopped during the provider call; it is never submitted twice")
        if kind == "narration":
            return self._narration(seg, take, tj, job, request, adapter, work, lease)
        request = self._inputs(request, tj, adapter, work)
        if not self.db.advance_job(job, self.worker_id, "submitting"):
            raise _TakeFailed("provider_error", "the take's job could not be sent (the model may be switched off)")
        try:
            task = adapter.submit(request)
        except Exception as e:
            raise _TakeFailed(film_error_code(cw.error_code_of(e), vendor_code=_vendor_code(adapter),
                                              http_status=getattr(e, "http_status", None), capability=request.capability),
                              cw.error_text_of(e)) from None
        if not task or not isinstance(task, str):
            raise _TakeFailed("no_output", "the provider accepted the take without a task id")
        if not self.db.advance_job(job, self.worker_id, "submitted", task, {"model": model}):
            raise _Stop("job_lost")
        files = self._poll(adapter, task, request, work / "out", lease)
        return self._deliver(seg, take, tj, job, request, files, task, work, None)

    def _inputs(self, request: cw.GenerationRequest, tj: Mapping[str, Any], adapter, work: Path) -> cw.GenerationRequest:
        """The take's pictures, as the database named them (film_take_job), copied by id; the style kit and @characters through the
        creative worker's own path (creative_job_style, which asks the rights acknowledgement again)."""
        first, end, refs = None, None, []
        try:
            for i, item in enumerate(tj.get("inputs") or []):
                role = item.get("role")
                if role == "first":
                    first = self.media.copy_input(item, work / "input", "source")
                elif role == "end":
                    end = self.media.copy_input(item, work / "input", "end")
                elif role == "reference":
                    refs.append(self.media.copy_input(item, work / "input", f"film_ref_{i}"))
        except Exception as e:
            raise _TakeFailed("bad_request", f"an input picture could not be read ({type(e).__name__})") from None
        if request.capability == "i2v" and first is None:
            raise _TakeFailed("bad_request", "the picture this shot starts from is not there")
        if request.params.get("end_asset_id") and end is None:
            raise _TakeFailed("bad_request", "the picture this shot must end on is not there")
        request = replace(request, input_files=(first,) if first else (), end_file=end)
        if cw.cs.wants_style(request.capability, request.params):
            helper = cw.CreativeWorker(self.db.creative, self.resolve_adapter, worker_id=self.worker_id, out_dir=work,
                                       media_root=self.media_root)
            try:
                request = helper._style(replace(request, job_id=request.job_id), adapter)
            except cw._Refused as r:
                raise _TakeFailed("bad_request", r.message) from None
        if refs:
            request = replace(request, reference_files=tuple(refs) + tuple(request.reference_files))
        return request

    def _poll(self, adapter, task: str, request: cw.GenerationRequest, out: Path, lease: _Lease) -> List[Path]:
        deadline = self.clock() + self.max_poll_seconds
        errors = 0
        while True:
            self._check(lease)
            try:
                res = adapter.poll(task, request, out)
                errors = 0
            except Exception as e:
                code = cw.error_code_of(e)
                errors += 1
                if code not in cw.RETRYABLE_POLL_CODES or errors >= MAX_POLL_ERRORS:
                    raise _TakeFailed(film_error_code(code, capability=request.capability), cw.error_text_of(e)) from None
                res = cw.ProviderPoll(cw.PENDING)
            if res.state == cw.SUCCEEDED:
                files = [Path(f) for f in res.files if Path(f).is_file() and Path(f).stat().st_size > 0]
                if not files:
                    raise _TakeFailed("no_output", "the provider reported success without an output file")
                if res.usage is not None:
                    try:
                        self.db.record_cost(request.job_id, res.usage)
                    except Exception as e:  # reporting only
                        logger.warning("job %s: provider cost not recorded (%s)", request.job_id, type(e).__name__)
                return files
            if res.state == cw.FAILED:
                raise _TakeFailed(film_error_code(res.error_code, capability=request.capability),
                                  res.error or "the provider failed the task")
            if self.clock() >= deadline:
                raise _TakeFailed("timeout", f"the provider did not finish within {int(self.max_poll_seconds)} s")
            self.sleep(self.poll_seconds)

    def _narration(self, seg, take, tj, job: str, request: cw.GenerationRequest, adapter, work: Path, lease: _Lease) -> str:
        """One scene at a time, on the film's clock (module doc). The whole narration or nothing: a scene that fails, or a voice that
        does not fit its scene, fails the take (0171: a narration that voiced part of its text is thrown away and charged 0)."""
        scenes = sorted(tj.get("narration") or [], key=lambda s: int(s["position"]))
        start, plan = 0.0, []
        for s in scenes:
            text = str(s.get("narration") or "")
            if text.strip():
                plan.append((s, text, start))
            start += float(s["planned_seconds"])
        if not plan:
            raise _TakeFailed("bad_request", "the film has no narration text")
        if not self.db.advance_job(job, self.worker_id, "submitting"):
            raise _TakeFailed("provider_error", "the narration's job could not be sent (the model may be switched off)")
        voiced, clips, segments, first_task = 0, [], [], None
        for n, (s, text, scene_start) in enumerate(plan):
            self._check(lease)
            req = replace(request, params={**request.params, "prompt": text})
            try:
                task = adapter.submit(req)
            except Exception as e:
                raise _TakeFailed(film_error_code(cw.error_code_of(e), vendor_code=_vendor_code(adapter),
                                                  http_status=getattr(e, "http_status", None), capability="tts"),
                                  cw.error_text_of(e), voiced or None) from None
            first_task = first_task or task
            files = self._poll(adapter, str(task), req, work / f"scene_{n}", lease)
            seconds = self.media.duration(files[0])
            if seconds is None:
                raise _TakeFailed("no_output", "a scene's narration could not be measured", voiced + len(text))
            if NARRATION_LEAD_S + seconds + NARRATION_TAIL_S > float(s["planned_seconds"]):
                raise _TakeFailed("bad_request", f"scene {int(s['position']) + 1} narrates {seconds:.1f} s in a "
                                                 f"{s['planned_seconds']} s scene: shorten its narration or lengthen the scene",
                                  voiced + len(text))
            voiced += len(text)
            at = round(scene_start + NARRATION_LEAD_S, 3)
            clips.append((files[0], at))
            segments.append({"scene_id": str(s["scene_id"]), "start_s": at, "end_s": round(at + seconds, 3)})
        task_id = f"film-tts:{len(plan)}:{first_task}"[:512]
        if not self.db.advance_job(job, self.worker_id, "submitted", task_id, {"model": request.model}):
            raise _Stop("job_lost")
        try:
            mixed = self.media.narration_mix(clips, work / "narration.m4a")
        except Exception as e:
            raise _TakeFailed("no_output", f"the narration could not be laid out ({type(e).__name__})", voiced) from None
        lufs, peak = self.media.loudness(mixed)
        extra = {"segments": segments, "loudness_lufs": lufs, "true_peak_db": peak}
        return self._deliver(seg, take, tj, job, request, [mixed], task_id, work, extra)

    def _deliver(self, seg, take, tj, job: str, request: cw.GenerationRequest, files: Sequence[Path], task: str, work: Path,
                 narration: Optional[Mapping[str, Any]], *, processing: bool = False) -> str:
        """Register the result (and a clip's last frame) through the job, then hand it to film_take_succeeded. ``processing``: a
        resumed job that was already storing (0036 moves it there once); the same asset ids make a second store the same rows."""
        tid, kind, org = str(take["id"]), str(take["kind"]), str(seg["org_id"])
        if not processing and not self.db.advance_job(job, self.worker_id, "processing"):
            raise _Stop("job_lost")
        provenance = narration_provenance(job, tid, narration) if kind == "narration" else {
            "job_id": job, "film_take_id": tid, "capability": request.capability, "model": request.model,
            "rights": "generated_for_org"}
        aid = str(uuid.uuid5(ASSET_NS, f"{job}:0"))
        try:
            self.media.store_file(files[0], asset_id=aid, org_id=org, provenance=provenance, expect_kind=OUTPUT_KIND[kind])
        except Exception as e:
            raise _TakeFailed("no_output", f"the result could not be stored ({type(e).__name__})") from None
        if not self.db.attach_job_assets(job, self.worker_id, [aid]):
            raise _Stop("job_lost")
        last = None
        if kind in ("clip", "extend"):
            last = str(uuid.uuid5(ASSET_NS, f"{job}:last_frame"))
            try:
                png = self.media.last_frame(files[0], work / "last_frame.png")
                self.media.store_file(png, asset_id=last, org_id=org, expect_kind="image", parent_asset_id=aid,
                                      provenance={"job_id": job, "film_take_id": tid, "role": "last_frame", "source_asset_id": aid})
            except Exception as e:
                # The next shot starts from this frame: without it the chain is broken, so the take fails (rule 4).
                raise _TakeFailed("no_output", f"the clip's last frame could not be extracted ({type(e).__name__})") from None
            if not self.db.attach_job_assets(job, self.worker_id, [aid, last]):
                raise _Stop("job_lost")
        # What this worker measured, for 0171's record only: 0171 charges by the length register_asset recorded, never by this.
        seconds = None
        if kind != "keyframe":
            try:
                seconds = self.media.duration(files[0])
            except Exception:  # noqa: BLE001 — a reported number is optional; the recorded one decides
                seconds = None
            seconds = round(float(seconds), 2) if seconds is not None and 0.01 <= float(seconds) <= 600 else None
        try:
            out = self.db.take_succeeded(tid, self.worker_id, seconds, aid, last, task)
        except FilmRefused as r:
            if r.word in ("lease_lost", "take_not_running"):
                raise
            # 0171 refused the result itself (not a live file of the right kind): the take delivered nothing.
            raise _TakeFailed("no_output", f"the result was refused ({r.word})") from None
        accepted = isinstance(out, Mapping) and out.get("accepted") is True
        if accepted:
            result = {"asset_ids": [aid] + ([last] if last else []), "storage": "library"}
            self.db.finish_job(job, self.worker_id, True, result=result)
            return "completed"
        self.db.finish_job(job, self.worker_id, False, error_code="too_short", error="the clip is shorter than it was confirmed for")
        return "retried" if isinstance(out, Mapping) and out.get("retry_take_id") else "failed"


def narration_provenance(job: str, take: str, narration: Optional[Mapping[str, Any]]) -> dict:
    """The narration file's provenance, the assembly's contract (S11): film_take_id, the per-scene segments in the file's time on the
    film's clock, and the measured loudness (null when not measured, never a default). No word timings: 0038 caps a provenance at
    16 KB and a film's words do not fit (the captions come from the assembly's own transcription). Plus the job id, which is not the
    contract's but 0046's: attach_creative_job_assets refuses a file whose provenance does not name the job that made it."""
    n = dict(narration or {})
    return {"job_id": job, "film_take_id": take, "segments": list(n.get("segments") or []),
            "loudness_lufs": n.get("loudness_lufs"), "true_peak_db": n.get("true_peak_db")}


# ── the database (PostgREST, service key) ───────────────────────────────────

class FilmRest:
    """0171's and 0198's service functions over Supabase REST with the service key, plus the reads the driver needs and the creative
    job calls (0036/0046) through the creative worker's own client."""

    def __init__(self, url: str, service_key: str, *, timeout: float = 30.0, session=None):
        import requests  # noqa: PLC0415

        self.url = url.rstrip("/")
        self._key = service_key
        self._timeout = timeout
        self._http = session or requests.Session()
        self._lock = threading.Lock()
        self.creative = cw.CreativeRest(url, service_key, timeout=timeout)

    def _headers(self) -> dict:
        return {"apikey": self._key, "Authorization": f"Bearer {self._key}", "Content-Type": "application/json"}

    def rpc(self, name: str, body: dict):
        try:
            with self._lock:
                r = self._http.post(f"{self.url}/rest/v1/rpc/{name}", json=body, timeout=self._timeout, headers=self._headers())
        except Exception as e:
            raise FilmUnavailable(f"{name}: {type(e).__name__}") from None
        if r.status_code == 404:
            raise FilmUnavailable(f"{name}: HTTP 404 (is its migration applied?)")
        if 400 <= r.status_code < 500:
            word, detail = "", ""
            try:
                j = r.json()
                word, detail = str(j.get("message") or ""), str(j.get("details") or "")[:300]
            except ValueError:
                pass
            if re.match(r"^[a-z][a-z0-9_]{0,63}$", word):
                raise FilmRefused(word, detail)
            raise FilmUnavailable(f"{name}: HTTP {r.status_code}")
        if r.status_code >= 300:
            raise FilmUnavailable(f"{name}: HTTP {r.status_code}")
        try:
            return r.json()
        except ValueError:
            return None

    def _select(self, table: str, params: dict) -> list:
        try:
            with self._lock:
                r = self._http.get(f"{self.url}/rest/v1/{table}", params=params, timeout=self._timeout, headers=self._headers())
        except Exception as e:
            raise FilmUnavailable(f"{table}: {type(e).__name__}") from None
        if r.status_code >= 300:
            raise FilmUnavailable(f"{table}: HTTP {r.status_code}")
        out = r.json()
        return out if isinstance(out, list) else []

    # 0171 / 0198
    def claim(self, worker_id: str, stale_minutes: int = STALE_MINUTES) -> Optional[dict]:
        out = self.rpc("film_claim_segment", {"p_worker": worker_id, "p_stale_after": f"{int(stale_minutes)} minutes"})
        return out if isinstance(out, dict) else None

    def heartbeat(self, segment: str, worker_id: str) -> bool:
        return bool(self.rpc("film_heartbeat_segment", {"p_segment": segment, "p_worker": worker_id}))

    def studio_on_for(self, org: str) -> bool:
        return self.rpc("film_studio_on_for", {"p_org": org}) is True

    def begin_take(self, take: str, worker_id: str) -> dict:
        return self.rpc("film_begin_take", {"p_take": take, "p_worker": worker_id}) or {}

    def take_job(self, take: str, worker_id: str) -> dict:
        return self.rpc("film_take_job", {"p_take": take, "p_worker": worker_id}) or {}

    def take_succeeded(self, take, worker_id, seconds, result, last_frame, task) -> dict:
        return self.rpc("film_take_succeeded", {"p_take": take, "p_worker": worker_id, "p_output_seconds": seconds,
                                                "p_result_asset": result, "p_last_frame_asset": last_frame,
                                                "p_provider_task_id": task}) or {}

    def take_failed(self, take, worker_id, failure, code, error=None, units_done=None) -> dict:
        return self.rpc("film_take_failed", {"p_take": take, "p_worker": worker_id, "p_failure": failure, "p_error_code": code,
                                             "p_error": error, "p_units_done": units_done}) or {}

    def begin_assembly(self, segment: str, worker_id: str) -> dict:
        return self.rpc("film_begin_assembly", {"p_segment": segment, "p_worker": worker_id}) or {}

    def record_assembly(self, segment: str, worker_id: str, ok: bool, result: Optional[str]) -> dict:
        return self.rpc("film_record_assembly", {"p_segment": segment, "p_worker": worker_id, "p_ok": ok,
                                                 "p_result_asset": result}) or {}

    def settle(self, segment: str, worker_id: str, reason: str) -> dict:
        return self.rpc("film_settle_segment", {"p_segment": segment, "p_worker": worker_id, "p_reason": reason}) or {}

    def expire(self) -> int:
        out = self.rpc("film_expire_segments", {})
        return int(out) if isinstance(out, int) else 0

    def takes(self, segment: str) -> list:
        return self._select("film_takes", {"segment_id": f"eq.{segment}",
                                           "select": "id,kind,scene_id,shot_index,attempt,status,model,params,quantity"})

    def scenes(self, film: str) -> list:
        return self._select("film_scenes", {"film_id": f"eq.{film}",
                                            "select": "id,position,first_frame,last_frame,shot_count,planned_seconds"})

    # the take's creative job (0036, 0046, 0037)
    def heartbeat_job(self, job: str, worker_id: str):
        return self.creative.heartbeat(job, worker_id)

    def advance_job(self, job, worker_id, step, task=None, route=None) -> bool:
        return self.creative.advance(job, worker_id, step, task, route)

    def attach_job_assets(self, job, worker_id, assets) -> bool:
        return self.creative.attach_assets(job, worker_id, assets)

    def finish_job(self, job, worker_id, ok, *, result=None, error_code=None, error=None):
        return self.creative.finish(job, worker_id, ok, result=result, error_code=error_code, error=error)

    def record_cost(self, job, usage):
        return self.creative.record_cost(job, usage)


__all__ = ["AssemblyOutcome", "DriveOutcome", "FILM_ERROR_CODES", "FilmOrchestrator", "FilmRefused", "FilmRest", "FilmUnavailable",
           "Media", "NARRATION_LEAD_S", "film_error_code", "failure_kind", "narration_provenance", "parse_ebur128"]

"""Film Studio P4b: one assembling segment → one finished, registered mp4 (server-side only).

S6's film worker (tools/film_worker.py, in the media-worker container) holds the segment's lease for its whole
life. When every take is terminal it calls ``film_begin_assembly`` (0171: ``assembly_status`` planned →
running) and then :func:`assemble_segment` here, on the same lease and with its heartbeat still running. From
there until ``film_record_assembly`` everything is this module's; the worker settles afterwards. The contract is
written out in docs/studio/NIGHTSHIFT_AI.md ("Assembly handoff").

Why it is shaped this way
-------------------------
* **On the holder's lease.** Every 0171 service call is gated on ``film_segments.worker_id`` and there is no
  hand-off function, so the assembly runs inside the lease holder's process. A lease CAN still move under a
  running assembly: ``film_claim_segment`` re-takes a segment whose heartbeat went stale. So each attempt works in
  its own folder, checks the lease again just before it registers anything, and when it learns it lost the
  segment after registering, asks 0200's ``film_discard_unrecorded_assembly`` to remove the file if nobody
  recorded it (Breach BR-P4B-01, -02).
* **The assembly has no hold of its own.** It is a line inside the segment's ``fm-<id>`` hold. "Releasing" it
  means ``film_record_assembly(ok=false)``, which charges 0; the worker's settle then captures only what the
  takes charged and releases the rest. Every path out that is a *decision* (a refusal, a bad output, an
  unexpected exception) records a failure first. What is NOT a decision is not recorded: the database being
  unreachable or answering 5xx (Lens L1: a 503 on the success record must not throw a paid film away), a lost
  lease (the new holder records), an assembly that is not running. Then the assembly stays running, the next
  claim calls this again, and 0171's attempt cap and deadline end it at 0 if it never comes back.
* **Idempotent per cut.** The master's asset id is a uuid5 of the segment and the cut's sha256, and the captions
  that go into the cut are cached per narration file (Whisper at temperature 0, read back on a retry), so a
  retry computes the same cut, finds the file a crashed attempt registered and records it without rendering
  again. A retry after the record is answered by 0171 once only: no double charge.
* **No silent quality fallback (CLAUDE.md rule 4).** A missing or unfinished clip, captions asked for and not
  producible (a word the narration's segments do not place included), too little disk for the fast
  intermediates, a render that used ``render_backend``'s compact (second lossy generation) encode anyway, an
  output whose length, frame or sound is not what the cut says, or a review copy missing or above 50 MB: each one
  fails the assembly by name, at 0 credits, with the remedy in ``detail``. A shorter film is never rendered.
* **Server-side and flagged.** Nothing here is reachable from a browser. ``NIGHTSHIFT_FILM_ASSEMBLY=on`` is a
  kill switch (default off). Which organizations is the database's single answer:
  ``film_studio_on_for(org)`` (S6's migration; the global Film Studio switch and the organization's own flag).
  Missing (not applied), refused or not a plain ``true``: not assembled.

The price is never read or computed here. 0171 charges the recorded length of the registered file at the
segment's confirmed ``film_assembly_minute`` rate (quoted through ``quote_film`` / ``creative_price`` when the
film started). This module only decides whether there is a file to charge for.
"""

from __future__ import annotations

import json
import logging
import math
import os
import re
import shutil
import subprocess
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, List, Mapping, Optional, Sequence

from modules import editor_export
from modules import film_timeline as ft
from modules import media_library as ml
from modules import render_backend
from modules import timeline as tl
from modules import timeline_render

logger = logging.getLogger(__name__)

#: The work folder under the media volume: <segment>/<attempt>, one per attempt, removed on every way out.
WORK_DIRNAME = ".film-assembly"
#: Word timings already transcribed, per narration file, so a retry builds the same cut (Lens L5).
CACHE_DIRNAME = ".film-assembly-cache"
#: Namespace of the master's asset id: uuid5(NS, "<segment>:<cut sha256>").
ASSET_NS = uuid.UUID("6f1c7a3e-2b8d-5e44-9a61-0c5e2f8d4b17")

#: How far the rendered file's length may differ from the cut's: two frames at 24 fps, plus the AAC
#: encoder's priming (about 21 ms at 48 kHz). The editor's render pads or trims to the frame, so a bigger
#: difference is a scene or a sound that did not make it, never rounding.
DURATION_TOLERANCE_S = 0.12
#: The review copy (the library's 480p proxy) must fit one object of the Supabase free tier
#: (CLAUDE.md "Known ceilings": 50 MB), so it can be copied to the previews bucket as it is.
REVIEW_COPY_MAX_BYTES = 50 * 1000 * 1000
#: Free space the work folder needs, per second of film, on top of the fast intermediates (the render_backend
#: figure for 1080p scaled by the frame's pixels): the output (measured 4.95 Mb/s at 1080p) and the library's
#: copy of it with its proxy. Measured use was 3.8 MB/s against 9 asked (docs/FILM_ASSEMBLY_MEASUREMENT.md);
#: the headroom is for detailed real footage and for a neighbour writing to the same volume meanwhile.
OUTPUT_MB_PER_S = 1.0
#: At most this many ids in one PostgREST ``in.(...)`` (a 60-scene film's request line stays far under 8 KB).
ID_CHUNK = 50

ENABLE_ENV = "NIGHTSHIFT_FILM_ASSEMBLY"

#: The machine words this module fails an assembly with (film_timeline's own refusals pass through as
#: they are, so the canvas shows the same word the cut used).
REASONS = ("assembly_not_enabled", "not_running", "lease_lost", "film_unavailable", "narration_missing",
           "captions_failed", "disk_low", "asset_unavailable", "render_timed_out", "render_failed",
           "render_degraded", "output_mismatch", "store_failed", "review_copy_missing", "review_copy_too_large",
           "assembly_crashed") + ft.REASONS


class AssemblyFailed(Exception):
    """Ends one assembly: ``reason`` is a machine word of REASONS, ``detail`` names the fix."""

    def __init__(self, reason: str, detail: str):
        assert reason in REASONS, reason
        self.reason, self.detail = reason, detail
        super().__init__(f"{reason}: {detail}")


class DbRefused(RuntimeError):
    """A database function refused, by name (a 4xx carrying its machine word: lease_lost, not_running, ...)."""

    def __init__(self, call: str, status: int, word: str):
        self.call, self.status, self.word = call, status, word
        super().__init__(f"{call}: HTTP {status} {word}")


class DbUnavailable(ConnectionError):
    """The database did not answer with a decision (unreachable, timed out, 5xx, a body that is not its own).

    Never recorded as the assembly's failure: nothing was decided, and the next claim asks again."""


class _LeaseLost(Exception):
    pass


class AssemblyDisabled(RuntimeError):
    """This worker's kill switch is off. Not a decision about the film: nothing is recorded, and the assembly stays
    running until a worker with the switch on calls again or 0171's deadline ends it at 0. The film worker does not
    begin an assembly while the switch is off (docs/studio/NIGHTSHIFT_AI.md)."""


@dataclass(frozen=True)
class AssemblyOutcome:
    ok: bool
    asset_id: Optional[str] = None
    reason: Optional[str] = None          # None on success; otherwise a word of REASONS
    detail: Optional[str] = None
    cut_sha256: Optional[str] = None
    captions_asset_id: Optional[str] = None
    rendered: bool = False                # False when a crashed attempt's file was reused
    recorded: bool = False                # whether THIS call recorded the outcome with 0171
    segment: Optional[dict] = None        # film_record_assembly's answer, or the segment as read back


# ── the flag ─────────────────────────────────────────────────────────────────

def enabled(env: Mapping[str, str]) -> bool:
    """The kill switch. Off unless the worker's environment says exactly ``on``."""
    return str(env.get(ENABLE_ENV, "")).strip().lower() == "on"


# ── captions ─────────────────────────────────────────────────────────────────

#: A cue ends at a sentence's end, after this long, or when the next word would not fit two lines.
CUE_MAX_S = 3.0
_SENTENCE_END = re.compile(r"[.!?…。！？]$")


def _clean_words(words: Sequence[Mapping]) -> List[tuple]:
    clean = []
    for w in words:
        text = str(w.get("word") or w.get("text") or "").strip()
        try:
            a, b = float(w["start"]), float(w["end"])
        except (KeyError, TypeError, ValueError):
            continue
        if not text or not (math.isfinite(a) and math.isfinite(b)) or b <= a:
            continue
        clean.append((a, b, text))
    clean.sort(key=lambda x: (x[0], x[1], x[2]))
    return clean


def cues_from_words(words: Sequence[Mapping], segments: Sequence[Mapping], max_chars: int) -> List[dict]:
    """Word timings (the narration file's time) → caption cues, never across a scene's segment.

    Each word belongs to the segment it overlaps most (alignment puts a scene's first word a few ms before its
    segment's start; Lens L3). A word that overlaps no segment is not placed: it is refused
    (``captions_failed``), never left out of the captions quietly, because between two segments the file may
    still be playing. Deterministic: the same words give the same cues. A word too long for a line is refused
    by build_cut later, by name, rather than cut here."""
    spans = sorted((float(s["start_s"]), float(s["end_s"])) for s in segments)
    placed: List[List[tuple]] = [[] for _ in spans]
    for a, b, text in _clean_words(words):
        best, k = 0.0, None
        for i, (sa, sb) in enumerate(spans):
            ov = min(b, sb) - max(a, sa)
            if ov > best:
                best, k = ov, i
        if k is None:
            raise AssemblyFailed("captions_failed", f"the narration says \"{text}\" at {a:.2f} s, outside every scene's "
                                 "narration segment: generate the narration again so its segments cover its words")
        placed[k].append((a, b, text))
    budget = max(8, int(max_chars)) * ft.MAX_CAPTION_LINES
    cues: List[dict] = []
    for (sa, sb), mine in zip(spans, placed):
        cur: List[tuple] = []

        def flush():
            if cur:
                cues.append({"start_s": round(max(cur[0][0], sa), 3), "end_s": round(min(cur[-1][1], sb), 3),
                             "text": " ".join(t for _a, _b, t in cur)})
                cur.clear()

        for a, b, text in mine:
            length = sum(len(t) + 1 for *_x, t in cur) + len(text)
            if cur and (length > budget or ft.wrap_caption(" ".join([*(t for *_x, t in cur), text]), max_chars) is None
                        or b - cur[0][0] > CUE_MAX_S):
                flush()
            cur.append((a, b, text))
            if _SENTENCE_END.search(text):
                flush()
        flush()
    return [c for c in cues if c["end_s"] > c["start_s"]]


def whisper_words(path: Path, language: Optional[str]) -> List[dict]:
    """Word timings of the narration file from Whisper base (the worker image caches it at build time).

    Temperature 0 with no fallback: the same file gives the same words, so a retry builds the same cut."""
    import whisper  # noqa: PLC0415 — only the worker image has it

    model = whisper.load_model("base")
    out = model.transcribe(str(path), language=(language or None), word_timestamps=True, fp16=False,
                           condition_on_previous_text=False, temperature=0.0)
    words: List[dict] = []
    for seg in out.get("segments") or []:
        for w in seg.get("words") or []:
            words.append({"word": w.get("word"), "start": w.get("start"), "end": w.get("end")})
    return words


def cached_words(media_root: Path, narration_id: str, path: Path, language: Optional[str],
                 transcribe: Callable[[Path, Optional[str]], List[dict]]) -> List[dict]:
    """The narration's word timings, transcribed once per file: a retry reads the same words back."""
    cache = Path(media_root) / CACHE_DIRNAME / f"{narration_id}.json"
    try:
        data = json.loads(cache.read_text(encoding="utf-8"))
        if isinstance(data, list):
            return data
    except (OSError, ValueError):
        pass
    words = transcribe(path, language)
    try:
        cache.parent.mkdir(parents=True, exist_ok=True)
        tmp = cache.with_name(f".{cache.name}.{uuid.uuid4().hex}")
        tmp.write_text(json.dumps(words), encoding="utf-8")
        os.replace(tmp, cache)
    except OSError as e:
        # Not fatal: the cut is still right, only a retry would transcribe again (and could differ: then it renders anew).
        logger.warning("film assembly: could not cache the narration's words (%s)", type(e).__name__)
    return words


def vtt_text(srt: str) -> str:
    """The cut's .srt sidecar as WebVTT: the same cues, the decimal comma as a point."""
    body = re.sub(r"(\d{2}:\d{2}:\d{2}),(\d{3})", r"\1.\2", srt.strip())
    # SRT numbers each cue; VTT allows an identifier line, so the numbers stay as cue ids.
    return "WEBVTT\n\n" + body + "\n"


# ── the database ─────────────────────────────────────────────────────────────

class AssemblyStore:
    """The rows one assembly reads and the database calls it makes, over Supabase REST with the service key
    (server-side only). Reads use 0166/0171's service_role SELECT grants; calls are 0171's functions, 0200's
    discard and S6's ``film_studio_on_for``.

    A 4xx that carries the database's machine word is a refusal (:class:`DbRefused`). Anything else (no
    answer, a timeout, a 5xx from the gateway, a body that is not PostgREST's) is :class:`DbUnavailable`."""

    def __init__(self, media: ml.MediaStore):
        self.media = media

    def _send(self, method: str, path: str, **kw):
        try:
            return self.media.http().request(method, f"{self.media.url}/rest/v1/{path}", timeout=self.media._timeout, **kw)
        except Exception as e:  # noqa: BLE001 — requests' errors are not imported here; none of them is a decision
            raise DbUnavailable(f"{path}: {type(e).__name__}") from None

    #: SQLSTATEs a database function refuses with (0036's creative_refuse: NS400/NS402/NS409/NS429; raise exception:
    #: P0001; and 0171's not_found P0002, forbidden 42501, invalid 22023). A gateway's own 4xx (Kong's 429, a JWT 401,
    #: PostgREST's PGRST* codes) is not a decision about this film (Sentinel R2).
    _DB_CODES = ("P0001", "P0002", "42501", "22023")
    _WORD = re.compile(r"^[a-z][a-z0-9_]{0,63}$")

    @classmethod
    def _word(cls, r) -> str:
        """The database's machine word, or "" when the body is not a database function's refusal."""
        try:
            body = r.json()
        except ValueError:
            return ""
        if not isinstance(body, dict):
            return ""
        code, word = str(body.get("code") or ""), str(body.get("message") or "")
        if not (code.startswith("NS") or code in cls._DB_CODES) or not cls._WORD.match(word):
            return ""
        return word

    def _get(self, table: str, params: Mapping[str, str]) -> List[dict]:
        r = self._send("GET", table, params=dict(params), headers=self.media._h())
        if r.status_code >= 300:
            raise DbUnavailable(f"{table}: HTTP {r.status_code}")
        try:
            return list(r.json() or [])
        except ValueError:
            raise DbUnavailable(f"{table}: not JSON") from None

    def _call(self, name: str, payload: dict, *, missing_ok: bool = False):
        r = self._send("POST", f"rpc/{name}", json=payload, headers=self.media._h({"Content-Type": "application/json"}))
        if r.status_code == 404 and missing_ok:
            return None
        if 400 <= r.status_code < 500:
            word = self._word(r)
            if word:
                raise DbRefused(name, r.status_code, word)
        if r.status_code >= 300:
            raise DbUnavailable(f"{name}: HTTP {r.status_code}")
        try:
            return r.json() if r.content else None
        except ValueError:
            raise DbUnavailable(f"{name}: not JSON") from None

    def org_enabled(self, org_id: str) -> bool:
        """S6's ``film_studio_on_for(org)``: True only when it answers exactly true, False only when it answers
        exactly false (the database's decision). Missing (its migration not applied), refused or any other answer is
        no decision: :class:`DbUnavailable`, nothing is assembled and nothing recorded (Sentinel R3)."""
        try:
            answer = self._call("film_studio_on_for", {"p_org": org_id}, missing_ok=True)
        except DbRefused as e:
            raise DbUnavailable(f"film_studio_on_for refused ({e.word})") from None
        if answer is True or answer is False:
            return answer
        raise DbUnavailable("film_studio_on_for did not answer true or false (is its migration applied?)")

    def heartbeat(self, segment_id: str, worker: str) -> bool:
        return self._call("film_heartbeat_segment", {"p_segment": segment_id, "p_worker": worker}) is True

    def segment(self, segment_id: str) -> Optional[dict]:
        rows = self._get("film_segments", {"id": f"eq.{segment_id}", "select": "*"})
        return rows[0] if rows else None

    def film(self, film_id: str) -> Optional[dict]:
        rows = self._get("films", {"id": f"eq.{film_id}", "select": "*"})
        return rows[0] if rows else None

    def scenes(self, film_id: str) -> List[dict]:
        return self._get("film_scenes", {"film_id": f"eq.{film_id}", "select": "*", "order": "position"})

    def takes(self, segment_id: str) -> List[dict]:
        return self._get("film_takes", {"segment_id": f"eq.{segment_id}", "select": "*"})

    def assets(self, org_id: str, ids: Sequence[str]) -> List[dict]:
        ids = sorted(set(ids))
        out: List[dict] = []
        for i in range(0, len(ids), ID_CHUNK):
            out += self._get("media_assets", {"id": f"in.({','.join(ids[i:i + ID_CHUNK])})", "org_id": f"eq.{org_id}",
                                              "deleted_at": "is.null",
                                              "select": "id,org_id,kind,mime,duration_s,width,height,variants,"
                                                        "source,provenance,derived_bytes,deleted_at"})
        return out

    def begin(self, segment_id: str, worker: str) -> dict:
        return self._call("film_begin_assembly", {"p_segment": segment_id, "p_worker": worker}) or {}

    def record(self, segment_id: str, worker: str, ok: bool, asset_id: Optional[str]) -> dict:
        return self._call("film_record_assembly", {"p_segment": segment_id, "p_worker": worker, "p_ok": bool(ok),
                                                   "p_result_asset": asset_id}) or {}

    def discard_unrecorded(self, segment_id: str, asset_id: str) -> int:
        return int(self._call("film_discard_unrecorded_assembly", {"p_segment": segment_id, "p_asset": asset_id}) or 0)


# ── helpers ──────────────────────────────────────────────────────────────────

def master_asset_id(segment_id: str, cut_sha256: str) -> str:
    return str(uuid.uuid5(ASSET_NS, f"{ml.canonical_id(segment_id)}:{cut_sha256}"))


def captions_asset_id(segment_id: str, cut_sha256: str) -> str:
    return str(uuid.uuid5(ASSET_NS, f"{ml.canonical_id(segment_id)}:{cut_sha256}:vtt"))


def disk_needed_mb(width: int, height: int, length_s: float) -> float:
    return length_s * (render_backend.INTERMEDIATE_MB_PER_S_1080P * (width * height) / (1920 * 1080) + OUTPUT_MB_PER_S)


def free_mb(path: Path) -> Optional[float]:
    try:
        st = os.statvfs(str(path))
        return st.f_bavail * st.f_frsize / 1048576.0
    except OSError:
        return None


@dataclass(frozen=True)
class Probed:
    duration_s: Optional[float]
    width: Optional[int]
    height: Optional[int]
    has_audio: bool


def probe_output(ffprobe: str, path: Path) -> Probed:
    cmd = [ffprobe, "-v", "error", "-protocol_whitelist", "file", "-show_entries",
           "format=duration:stream=codec_type,width,height", "-of", "json", str(path)]
    out = subprocess.run(cmd, capture_output=True, timeout=60, check=False)
    if out.returncode != 0:
        return Probed(None, None, None, False)
    data = json.loads(out.stdout or b"{}")
    streams = data.get("streams") or []
    v = next((s for s in streams if s.get("codec_type") == "video"), {})
    try:
        dur = float((data.get("format") or {}).get("duration"))
    except (TypeError, ValueError):
        dur = None
    return Probed(dur, v.get("width"), v.get("height"), any(s.get("codec_type") == "audio" for s in streams))


def render_strict(norm, resolver, out: str, *, ffmpeg: str, workdir: str, jobs: int, timeout_s: float,
                  timings: render_backend.RenderTimings) -> str:
    """The editor's render (timeline_render.render) with its timings kept, so the caller can see which segment
    encode was used: render_backend falls back to the compact one without raising (Lens L2)."""
    spec = timeline_render.to_render_spec(norm, resolver, out)
    return render_backend.render(spec, ffmpeg=ffmpeg, workdir=workdir, jobs=jobs, timeout_s=timeout_s, timings=timings)


def _latest_completed(takes: Sequence[Mapping], kind: str) -> Optional[Mapping]:
    done = [t for t in takes if t.get("kind") == kind and t.get("status") == "completed" and t.get("result_asset_id")]
    return max(done, key=lambda t: (int(t.get("version") or 0), int(t.get("attempt") or 0))) if done else None


def _as_dict(v) -> dict:
    if isinstance(v, str):
        try:
            v = json.loads(v)
        except ValueError:
            return {}
    return v if isinstance(v, dict) else {}


def _with_versions(scenes: Sequence[Mapping], takes: Sequence[Mapping]) -> List[dict]:
    """The scenes with the version this segment shot where none was chosen yet.

    Nothing in 0166/0171 sets ``film_scenes.current_version``: choosing among versions is P7's (re-shoot).
    On a first shoot every take of a scene in this segment is one version, and that is the one to cut. A
    version a person chose is kept as it is; a scene this segment shot in two versions with none chosen is
    left unchosen, so build_cut refuses it by name (``scene_not_shot``) instead of this guessing which."""
    out = []
    for sc in scenes:
        sc = dict(sc)
        if sc.get("current_version") is None:
            sid = ml.canonical_id(sc.get("id"))
            vs = {int(t["version"]) for t in takes if t.get("scene_id") and ml.canonical_id(t["scene_id"]) == sid
                  and t.get("kind") in ("clip", "extend") and t.get("version") is not None}
            if len(vs) == 1:
                sc["current_version"] = vs.pop()
        out.append(sc)
    return out


def store_caption(path: Path, *, asset_id: str, org_id: str, store: ml.MediaStore, media_root: Path,
                  provenance: Mapping) -> dict:
    """The sidecar as a library caption file (kind caption, text/vtt, source generated). The library's own
    store_generated takes no caption (a provider never sends one), so this is its caption twin: the same
    check an uploaded caption gets, the same layout and permissions, the same register_asset."""
    ml.check_caption(path)
    final = ml.asset_dir(media_root, asset_id)
    work = final.with_name(f".{asset_id}.{uuid.uuid4().hex[:8]}.part")
    work.parent.mkdir(parents=True, exist_ok=True)
    os.chmod(work.parent, 0o755)  # the web container reads these as another user
    work.mkdir(mode=0o755)
    try:
        nbytes, digest = ml.copy_and_hash(path, work / ml.VARIANT_FILES["original"], ml.CAPTION_MAX_BYTES)
        os.chmod(work / ml.VARIANT_FILES["original"], 0o644)
        if final.exists() and not final.is_symlink():
            shutil.rmtree(final)
        os.replace(work, final)
    except BaseException:
        shutil.rmtree(work, ignore_errors=True)
        raise
    out = store.register(asset_id=asset_id, org=org_id, kind="caption", mime="text/vtt", bytes=nbytes, sha256=digest,
                         source="generated", width=None, height=None, duration_s=None, provenance=dict(provenance),
                         derived_bytes=0, variants=[], parent_asset_id=None, original_name="captions.vtt")
    if not out or out.get("id") != asset_id:
        raise ml.StoreUnavailable("register_asset did not record the captions")
    return out


_HTTP_5XX = re.compile(r"HTTP 5\d\d")


def _transient_store_error(e: BaseException) -> bool:
    """media_library's REST layer raises RuntimeError("<call>: HTTP <status>"): a 5xx or no answer is not a
    decision about this film (a quota refusal or a bad row is, and fails the assembly)."""
    if isinstance(e, (ConnectionError, TimeoutError)):
        return True
    try:
        import requests  # noqa: PLC0415 — media_library's REST layer lets requests' own errors through (Sentinel R1)
        if isinstance(e, requests.exceptions.RequestException):
            return True
    except ImportError:
        pass
    return isinstance(e, RuntimeError) and bool(_HTTP_5XX.search(str(e)))


# ── one assembly ─────────────────────────────────────────────────────────────

@dataclass
class Deps:
    """What the assembly touches outside itself; tests replace any of it."""
    render: Callable[..., str] = render_strict
    store_file: Callable[..., dict] = ml.store_generated
    store_captions: Callable[..., dict] = store_caption
    transcribe: Callable[[Path, Optional[str]], List[dict]] = whisper_words
    probe: Optional[Callable[[Path], Probed]] = None
    has_audio: Optional[Callable[[Path, str], bool]] = None
    free_mb: Callable[[Path], Optional[float]] = free_mb
    env: Mapping[str, str] = field(default_factory=lambda: os.environ)


def clients_from(db) -> tuple:
    """The assembly's own REST clients from the film worker's (modules/film_orchestrator.FilmRest): the same Supabase
    URL and service key, server-side, never logged. The assembly keeps its own clients because its refusal rules (only
    the database's code and word are a refusal; Sentinel R2) and its library calls are its own."""
    url, key = getattr(db, "url", None), getattr(db, "_key", None)
    if not url or not key:
        raise TypeError("assemble_segment needs db with the Supabase url and service key (FilmRest), or store and media")
    media = ml.MediaStore(url, key)
    return AssemblyStore(media), media


def assemble_segment(segment: Mapping, *, worker_id: str, media_root: Path, tools: ml.Tools,
                     db=None, store: Optional[AssemblyStore] = None, media: Optional[ml.MediaStore] = None,
                     deps: Optional[Deps] = None) -> AssemblyOutcome:
    """Assemble one segment whose ``assembly_status`` is running, and record the outcome with 0171.

    The film worker calls it as ``assemble_segment(segment, worker_id=..., db=<FilmRest>, media_root=..., tools=...)``
    (modules/film_orchestrator.py); tests pass ``store`` and ``media`` instead. Returns the outcome. A decision is always
    recorded (``outcome.recorded``); a database that does not answer raises :class:`DbUnavailable` and leaves the
    assembly running for the next claim (see the module docstring)."""
    deps = deps or Deps()
    if store is None or media is None:
        store, media = clients_from(db)
    seg_id = ml.canonical_id(segment.get("id"))
    org = ml.canonical_id(segment.get("org_id"))
    work = Path(media_root) / WORK_DIRNAME / seg_id / f"{uuid.uuid4().hex}"
    sha: Optional[str] = None
    registered: List[str] = []
    try:
        # Before any row is read or anything rendered: switched off, or a workspace the database does not enable.
        if not enabled(deps.env):
            raise AssemblyDisabled(f"film assembly is switched off on this worker ({ENABLE_ENV})")
        if not store.org_enabled(org):
            raise AssemblyFailed("assembly_not_enabled", "Film Studio is not switched on for this workspace")
        try:
            store.begin(seg_id, worker_id)
        except DbRefused as e:
            # Nothing is running for this call to record: a lost lease is the new holder's, anything else ended already
            # (0171's begin answers as it is only while running) or never began.
            if e.word == "lease_lost":
                return AssemblyOutcome(False, reason="lease_lost", detail="another worker holds this segment")
            row = store.segment(seg_id) or {}
            if row.get("assembly_status") == "completed" and row.get("assembly_asset_id"):
                return AssemblyOutcome(True, asset_id=str(row["assembly_asset_id"]), segment=row)
            return AssemblyOutcome(False, reason="not_running", segment=row,
                                   detail=f"film_begin_assembly refused ({e.word}): the segment is {row.get('status')} "
                                          f"and its assembly {row.get('assembly_status')}")
        result = _assemble(segment, seg_id, org, worker_id, work, store=store, media=media,
                           media_root=Path(media_root), tools=tools, deps=deps, registered=registered)
        sha = result["sha"]
        try:
            rec = store.record(seg_id, worker_id, True, result["asset_id"])
        except DbRefused as e:
            if e.word == "lease_lost":
                raise _LeaseLost() from None
            raise AssemblyFailed("store_failed", f"the database refused the film ({e.word}): retry the assembly") from None
        logger.info("film assembly %s: completed (%s, %s s)", seg_id, result["asset_id"], result["length_s"])
        return AssemblyOutcome(True, asset_id=result["asset_id"], cut_sha256=sha, recorded=True,
                               captions_asset_id=result.get("captions_asset_id"), rendered=result["rendered"],
                               segment=rec)
    except _LeaseLost:
        return _lost(store, seg_id, registered)
    except AssemblyDisabled:
        logger.warning("film assembly %s: switched off on this worker (%s); nothing recorded", seg_id, ENABLE_ENV)
        raise
    except AssemblyFailed as e:
        return _fail(store, seg_id, worker_id, e.reason, e.detail, sha, registered)
    except DbUnavailable:
        # No decision was made: the assembly stays running, a file this attempt registered is found by its id next time.
        logger.warning("film assembly %s: the database did not answer; leaving the assembly running", seg_id)
        raise
    except DbRefused as e:
        if e.word == "lease_lost":
            return _lost(store, seg_id, registered)
        return _fail(store, seg_id, worker_id, "assembly_crashed", f"{e.call} refused ({e.word}): retry the assembly",
                     sha, registered)
    except Exception as e:  # noqa: BLE001 — every unexpected failure is still recorded at 0 before it propagates
        logger.exception("film assembly %s: unexpected failure", seg_id)
        _fail(store, seg_id, worker_id, "assembly_crashed", f"the assembly stopped unexpectedly ({type(e).__name__})",
              sha, registered)
        raise
    finally:
        shutil.rmtree(work, ignore_errors=True)
        try:
            work.parent.rmdir()  # only when no other attempt is working in it
        except OSError:
            pass


def _lost(store: AssemblyStore, seg_id: str, registered: Sequence[str]) -> AssemblyOutcome:
    """Another worker holds the segment. A file this attempt registered goes, unless the segment's assembly is
    still running (the holder records the same file by its id) or recorded it (0200 decides, in the database)."""
    removed = 0
    for aid in registered[-1:]:   # the master; its provenance names the captions file
        try:
            removed = store.discard_unrecorded(seg_id, aid)
        except (DbRefused, DbUnavailable) as e:
            logger.warning("film assembly %s: could not ask to discard %s (%s)", seg_id, aid, e)
    logger.warning("film assembly %s: the lease is another worker's now; stopping (%d file(s) discarded)", seg_id, removed)
    return AssemblyOutcome(False, reason="lease_lost", detail="another worker holds this segment")


def _fail(store: AssemblyStore, seg_id: str, worker: str, reason: str, detail: str, sha: Optional[str],
          registered: Sequence[str]) -> AssemblyOutcome:
    logger.warning("film assembly %s: failed (%s): %s", seg_id, reason, detail)
    try:
        rec = store.record(seg_id, worker, False, None)
    except DbRefused as e:
        if e.word == "lease_lost":
            return _lost(store, seg_id, registered)
        if e.word in ("not_running", "idempotency_conflict"):
            # Ended meanwhile (the sweep, a cancel): nothing for this call to record.
            return AssemblyOutcome(False, reason=reason, detail=detail, cut_sha256=sha)
        raise
    return AssemblyOutcome(False, reason=reason, detail=detail, cut_sha256=sha, recorded=True, segment=rec)


def _assemble(segment: Mapping, seg_id: str, org: str, worker: str, work: Path, *, store: AssemblyStore,
              media: ml.MediaStore, media_root: Path, tools: ml.Tools, deps: Deps, registered: List[str]) -> dict:
    film_id = ml.canonical_id(segment.get("film_id"))
    film = store.film(film_id)
    if not film or ml.canonical_id(film.get("org_id")) != org:
        raise AssemblyFailed("film_unavailable", "the film is no longer there")
    scenes = store.scenes(film_id)
    takes = store.takes(seg_id)
    narr_take = _latest_completed(takes, "narration")
    # Only what the cut can use: clips, extends, the narration and the music (no key frames: a 60-scene film's
    # request stays small; Lens L7).
    ids = [t["result_asset_id"] for t in takes if t.get("result_asset_id") and t.get("status") == "completed"
           and t.get("kind") in ("clip", "extend", "narration")]
    if film.get("music_asset_id"):
        ids.append(film["music_asset_id"])
    rows = store.assets(org, [ml.canonical_id(i) for i in ids])
    by_id = {ml.canonical_id(r["id"]): r for r in rows}

    narration = None
    words: List[dict] = []
    if any((s.get("narration") or "").strip() for s in scenes):
        if narr_take is None:
            raise AssemblyFailed("narration_missing", "the scenes have narration but no narration take completed: "
                                 "generate the narration again")
        # The take's params, or (where P3 writes them: no service function sets a take's params) the narration file's
        # own provenance, registered with it: {"segments": [...], "loudness_lufs", "true_peak_db"}.
        p = _as_dict(narr_take.get("params"))
        if not p.get("segments"):
            p = _as_dict((by_id.get(ml.canonical_id(narr_take["result_asset_id"])) or {}).get("provenance"))
        narration = {"asset_id": narr_take["result_asset_id"], "segments": p.get("segments") or [],
                     "loudness_lufs": p.get("loudness_lufs"), "true_peak_db": p.get("true_peak_db")}
        words = list(p.get("words") or [])

    # Captions are part of the assembly (0171): from the vendor's word timings when the take carries them, otherwise
    # from Whisper on the file itself (cached per file). Asked for and not producible: the assembly fails, by name.
    # Without segments there is nothing to time them against: build_cut refuses that by its own name.
    captions = None
    mode = film.get("captions_mode") or "sidecar"
    if narration is not None and mode != "none" and narration["segments"]:
        aspect = film.get("aspect") or "16:9"
        w, h = ft.frame_for(aspect, film.get("resolution"))
        layout = ft.caption_layout(aspect, w, h)
        if not words:
            nid = ml.canonical_id(narration["asset_id"])
            path = ml.asset_file(media_root, nid, "original")
            if nid not in by_id or not path.is_file():
                raise AssemblyFailed("asset_unavailable", "the narration file is no longer in the library: generate "
                                     "the narration again")
            try:
                words = cached_words(media_root, nid, path, film.get("language"), deps.transcribe)
            except Exception as e:  # noqa: BLE001
                raise AssemblyFailed("captions_failed", f"the captions could not be transcribed ({type(e).__name__}): "
                                     "retry the assembly, or set captions to none") from None
        captions = cues_from_words(words, narration["segments"], layout["max_chars"])
        if not captions:
            raise AssemblyFailed("captions_failed", "no words of the narration could be timed for captions: "
                                 "retry the assembly, or set captions to none")

    try:
        cut = ft.build_cut(film, _with_versions(scenes, takes), takes, by_id, narration, captions)
    except ft.FilmTimelineRefused as e:
        raise AssemblyFailed(e.reason, e.detail) from None
    sha = cut.sha256
    norm = tl.load(cut.doc)
    width, height = norm["width"], norm["height"]
    aid = master_asset_id(seg_id, sha)
    vtt_id = captions_asset_id(seg_id, sha) if cut.srt else None

    # Idempotent per cut: a crashed attempt that registered this very file hands it in instead of a new render.
    prev = {ml.canonical_id(r["id"]): r for r in store.assets(org, [aid])}.get(aid)
    if prev is not None and prev.get("kind") == "video":
        _check_master(prev, media_root, aid, cut.length_s)
        return {"asset_id": aid, "sha": sha, "length_s": cut.length_s, "rendered": False, "captions_asset_id": vtt_id}

    need = disk_needed_mb(width, height, cut.length_s)
    have = deps.free_mb(Path(media_root))
    if have is None or have < need:
        have_txt = "unknown" if have is None else f"{have:.0f} MB"
        raise AssemblyFailed("disk_low", f"the media volume has {have_txt} free and this film needs {need:.0f} MB to "
                             "render at full quality: free space on the media volume and retry the assembly")

    resolver = editor_export.build_resolver(
        rows, media_root,
        has_audio=deps.has_audio or (lambda path, mime: editor_export.probe_has_audio(tools.ffprobe, path, mime)))
    missing = [a for a in tl.asset_ids(norm) if resolver(a) is None]
    if missing:
        raise AssemblyFailed("asset_unavailable", f"{len(missing)} of the film's files are not on the media volume: "
                             "re-shoot the scenes whose clips are gone")
    work.mkdir(parents=True, mode=0o700)
    out = work / "film.mp4"
    timings = render_backend.RenderTimings()
    budget = tl.render_timeout_s(cut.length_s)
    try:
        deps.render(norm, resolver, str(out), ffmpeg=tools.ffmpeg, workdir=str(work), jobs=1, timeout_s=budget,
                    timings=timings)
    except render_backend.RenderTimeout:
        raise AssemblyFailed("render_timed_out", f"the render ran past its {budget:.0f} s limit: retry when the "
                             "server is less busy") from None
    except Exception as e:  # noqa: BLE001
        raise AssemblyFailed("render_failed", f"the render failed ({type(e).__name__}): retry the assembly") from None
    if timings.mode == "fallback" or timings.intermediate != "fast":
        # render_backend redid the segments with the compact encode (a second lossy generation) instead of failing.
        raise AssemblyFailed("render_degraded", "the render could only finish with the lower-quality segment encode "
                             "(the disk filled up, or an encode failed): free space on the media volume and retry the "
                             "assembly")
    if not out.is_file() or out.stat().st_size <= 0:
        raise AssemblyFailed("render_failed", "the render produced no file: retry the assembly")

    got = (deps.probe or (lambda p: probe_output(tools.ffprobe, p)))(out)
    wants_sound = any(t.get("kind") == "A" and t.get("clips") for t in cut.doc["tracks"])
    if got.duration_s is None or abs(got.duration_s - cut.length_s) > DURATION_TOLERANCE_S:
        raise AssemblyFailed("output_mismatch", f"the film rendered {got.duration_s} s of the {cut.length_s} s its "
                             "scenes add up to: retry the assembly")
    if (got.width, got.height) != (width, height):
        raise AssemblyFailed("output_mismatch", f"the film rendered {got.width}x{got.height}, not the {width}x{height} "
                             "of its aspect: retry the assembly")
    if wants_sound and not got.has_audio:
        raise AssemblyFailed("output_mismatch", "the film rendered without its sound: retry the assembly")

    # Still this worker's segment? Checked right before anything is registered (Breach BR-P4B-01): a render that
    # outlived its lease registers nothing.
    if not store.heartbeat(seg_id, worker):
        raise _LeaseLost()

    prov = {"film_segment_id": seg_id, "film_id": film_id, "film_version": segment.get("film_version"),
            "cut_sha256": sha, "cut_format": ft.FORMAT_VERSION, "tool": "film_assembly"}
    if vtt_id:
        vtt = work / "captions.vtt"
        vtt.write_text(vtt_text(cut.srt), encoding="utf-8")
        _store(lambda: deps.store_captions(vtt, asset_id=vtt_id, org_id=org, store=media, media_root=media_root,
                                           provenance={**prov, "role": "captions"}), "captions")
        cap = {ml.canonical_id(r["id"]): r for r in store.assets(org, [vtt_id])}.get(vtt_id)
        if cap is None or cap.get("kind") != "caption":
            raise AssemblyFailed("store_failed", "the captions are not this workspace's file after storing them: retry "
                                 "the assembly")
        prov["captions_asset_id"] = vtt_id
    stored = _store(lambda: deps.store_file(out, asset_id=aid, org_id=org, store=media, media_root=media_root,
                                            tools=tools, expect_kind="video", source="generated",
                                            original_name="film.mp4", provenance=prov), "film")
    registered.append(aid)
    if ml.canonical_id(stored.get("id")) != aid:
        raise AssemblyFailed("store_failed", "the library recorded another file: retry the assembly")
    # register_asset answers with the id, not the row: read it back (this workspace's, live) for the checks.
    row = {ml.canonical_id(r["id"]): r for r in store.assets(org, [aid])}.get(aid)
    if row is None:
        raise AssemblyFailed("store_failed", "the film's file is not live in this workspace's library after storing it "
                             "(deleted meanwhile?): retry the assembly")
    _check_master(row, media_root, aid, cut.length_s)
    return {"asset_id": aid, "sha": sha, "length_s": cut.length_s, "rendered": True, "captions_asset_id": vtt_id}


def _store(fn: Callable[[], dict], what: str) -> dict:
    try:
        return fn()
    except ml.IngestReject as e:
        raise AssemblyFailed("store_failed", f"the library refused the {what} ({e.reason}): retry the assembly") from None
    except ml.StoreUnavailable as e:
        raise AssemblyFailed("store_failed", f"the {what} could not be stored ({type(e).__name__}): retry the "
                             "assembly") from None
    except Exception as e:  # noqa: BLE001
        if _transient_store_error(e):
            raise DbUnavailable(f"storing the {what}: {e}") from None
        raise


def _check_master(row: Mapping, media_root: Path, aid: str, length_s: float) -> None:
    """What 0171 charges by and the review copy, checked before the record so a refusal names its remedy."""
    if row.get("source") not in (None, "generated"):
        raise AssemblyFailed("store_failed", "the film's file is not a generated file: retry the assembly")
    try:
        secs = float(row.get("duration_s"))
    except (TypeError, ValueError):
        secs = None
    if secs is None or not math.isfinite(secs) or abs(secs - length_s) > max(DURATION_TOLERANCE_S, 0.5):
        raise AssemblyFailed("store_failed", f"the library recorded {secs} s for a {length_s} s film: retry the "
                             "assembly")
    variants = row.get("variants") or []
    proxy = ml.asset_file(media_root, aid, "proxy")
    if "proxy" not in variants or not proxy.is_file():
        raise AssemblyFailed("review_copy_missing", "the 480p review copy could not be made: retry the assembly")
    if proxy.stat().st_size > REVIEW_COPY_MAX_BYTES:
        raise AssemblyFailed("review_copy_too_large", f"the 480p review copy is {proxy.stat().st_size // 1_000_000} MB, "
                             "above the 50 MB a review object may be: shorten the film")


__all__ = ["AssemblyDisabled", "AssemblyFailed", "AssemblyOutcome", "AssemblyStore", "clients_from", "DbRefused", "DbUnavailable", "Deps", "REASONS",
           "assemble_segment", "cached_words", "captions_asset_id", "cues_from_words", "disk_needed_mb", "enabled",
           "master_asset_id", "render_strict", "store_caption", "vtt_text", "whisper_words"]

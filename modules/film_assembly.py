"""Film Studio P4b: one assembling segment → one finished, registered mp4 (server-side only).

S6's film worker (tools/film_worker.py) holds the segment's lease for its whole life. When every take is
terminal it calls ``film_begin_assembly`` (0171: ``assembly_status`` planned → running) and then
:func:`assemble_segment` here, on the same lease and with its heartbeat still running. From there until
``film_record_assembly`` everything is this module's; the worker settles afterwards. The contract is written
out in docs/studio/NIGHTSHIFT_AI.md ("Assembly handoff").

Why it is shaped this way
-------------------------
* **One lease, no second claimer.** Every 0171 service call is gated on ``film_segments.worker_id`` and there
  is no hand-off function, so a separate assembly process would either steal the lease (``attempts`` + 1,
  which can end the film at ``max_attempts``) or run unleased. The assembly therefore runs inside the lease
  holder's process.
* **The assembly has no hold of its own.** It is a line inside the segment's ``fm-<id>`` hold. "Releasing" it
  means ``film_record_assembly(ok=false)``, which charges 0. The worker's settle then captures only what the
  takes charged and releases the rest. Every path out of :func:`assemble_segment` that is not a recorded
  success records a failure first, an unexpected exception included. A process that dies outright (SIGKILL,
  OOM) leaves ``running`` behind. The next claim calls this again (``film_begin_assembly`` answers as it is),
  and past ``max_attempts`` or the deadline 0171 itself fails the assembly at 0 and settles.
* **Idempotent per cut.** The master's asset id is a uuid5 of the segment and the cut's sha256. A retry
  after a crash that registered the file but never recorded it finds that live asset and records it without
  rendering again. A retry after the record is answered as it is by 0171 (once only: no double charge).
* **No silent quality fallback (CLAUDE.md rule 4).** A missing or unfinished clip, a narration without
  segments, captions asked for and not producible, too little disk for the fast intermediates (below that,
  ``render_backend`` would quietly switch to a second lossy generation), an output whose length, frame or
  sound is not what the cut says, or a review copy that is missing or too big: each one fails the assembly
  by name, at 0 credits, with the remedy in ``detail``. A shorter film is never rendered.
* **Server-side and flagged.** Nothing here is reachable from a browser. It runs only while
  ``NIGHTSHIFT_FILM_ASSEMBLY=on`` in the worker's environment, and only for an organization listed in
  ``NIGHTSHIFT_FILM_ASSEMBLY_ORGS`` (the owner's and the demo workspaces). Both fail closed: unset means no
  organization is assembled.

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
from typing import Any, Callable, Dict, List, Mapping, Optional, Sequence

from modules import editor_export
from modules import film_timeline as ft
from modules import media_library as ml
from modules import render_backend
from modules import timeline as tl
from modules import timeline_render

logger = logging.getLogger(__name__)

#: The work folder under the media volume, one sub-folder per segment, removed on every way out.
WORK_DIRNAME = ".film-assembly"
#: Namespace of the master's asset id: uuid5(NS, "<segment>:<cut sha256>").
ASSET_NS = uuid.UUID("6f1c7a3e-2b8d-5e44-9a61-0c5e2f8d4b17")

#: How far the rendered file's length may differ from the cut's: two frames at 24 fps, plus the AAC
#: encoder's priming (about 21 ms at 48 kHz). The editor's render pads or trims to the frame, so a bigger
#: difference is a scene or a sound that did not make it, never rounding.
DURATION_TOLERANCE_S = 0.12
#: The review copy (the library's 480p proxy) must fit one object of the Supabase free tier
#: (CLAUDE.md "Known ceilings": 50 MB), so it can be copied to the previews bucket as it is.
REVIEW_COPY_MAX_BYTES = 50 * 1000 * 1000
#: Free space the work folder needs, per second of film: the fast intermediates at the measured
#: render_backend figure for 1080p, scaled by the frame's pixels, plus the output (measured 4.85 Mb/s for
#: 1080p, so 1 MB a second is room to spare). docs/FILM_ASSEMBLY_MEASUREMENT.md, "Temp disk".
OUTPUT_MB_PER_S = 1.0

ENABLE_ENV = "NIGHTSHIFT_FILM_ASSEMBLY"
ORGS_ENV = "NIGHTSHIFT_FILM_ASSEMBLY_ORGS"

#: The machine words this module fails an assembly with (film_timeline's own refusals pass through as
#: they are, so the canvas shows the same word the cut used).
REASONS = ("assembly_not_enabled", "not_running", "lease_lost", "film_unavailable", "narration_missing",
           "captions_failed", "disk_low", "asset_unavailable", "render_timed_out", "render_failed",
           "output_mismatch", "store_failed", "review_copy_missing", "review_copy_too_large",
           "assembly_crashed") + ft.REASONS


class AssemblyFailed(Exception):
    """Ends one assembly: ``reason`` is a machine word of REASONS, ``detail`` names the fix."""

    def __init__(self, reason: str, detail: str):
        assert reason in REASONS, reason
        self.reason, self.detail = reason, detail
        super().__init__(f"{reason}: {detail}")


@dataclass(frozen=True)
class AssemblyOutcome:
    ok: bool
    asset_id: Optional[str] = None
    reason: Optional[str] = None          # None on success; otherwise a word of REASONS
    detail: Optional[str] = None
    cut_sha256: Optional[str] = None
    captions_asset_id: Optional[str] = None
    rendered: bool = False                # False when a crashed attempt's file was reused
    segment: Optional[dict] = None        # film_record_assembly's answer


# ── the flag ─────────────────────────────────────────────────────────────────

def enabled(env: Mapping[str, str]) -> bool:
    return str(env.get(ENABLE_ENV, "")).strip().lower() == "on"


def allowed_orgs(env: Mapping[str, str]) -> frozenset:
    out = set()
    for part in str(env.get(ORGS_ENV, "")).split(","):
        try:
            out.add(ml.canonical_id(part.strip()))
        except ValueError:
            continue
    return frozenset(out)


def org_allowed(org_id: Any, env: Mapping[str, str]) -> bool:
    """Fails closed: off, unset, or an org not listed is never assembled."""
    if not enabled(env):
        return False
    try:
        return ml.canonical_id(org_id) in allowed_orgs(env)
    except ValueError:
        return False


# ── captions ─────────────────────────────────────────────────────────────────

#: A cue ends at a sentence's end, after this long, or when the next word would not fit two lines.
CUE_MAX_S = 3.0
_SENTENCE_END = re.compile(r"[.!?…。！？]$")


def cues_from_words(words: Sequence[Mapping], segments: Sequence[Mapping], max_chars: int) -> List[dict]:
    """Word timings (the narration file's time) → caption cues, never across a scene's segment.

    Deterministic: the same words give the same cues. A word outside every segment is left out of the
    captions (it is not in the film either). A word too long for a line is refused by build_cut later,
    by name, rather than cut here."""
    spans = sorted((float(s["start_s"]), float(s["end_s"])) for s in segments)
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
    budget = max(8, int(max_chars)) * ft.MAX_CAPTION_LINES
    cues: List[dict] = []
    for sa, sb in spans:
        cur: List[tuple] = []

        def flush():
            if cur:
                cues.append({"start_s": round(max(cur[0][0], sa), 3), "end_s": round(min(cur[-1][1], sb), 3),
                             "text": " ".join(t for _a, _b, t in cur)})
                cur.clear()

        for a, b, text in clean:
            if not (sa <= a < sb):
                continue
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
    """Word timings of the narration file from Whisper base (the worker image caches it at build time)."""
    import whisper  # noqa: PLC0415 — only the worker image has it

    model = whisper.load_model("base")
    out = model.transcribe(str(path), language=(language or None), word_timestamps=True, fp16=False,
                           condition_on_previous_text=False)
    words: List[dict] = []
    for seg in out.get("segments") or []:
        for w in seg.get("words") or []:
            words.append({"word": w.get("word"), "start": w.get("start"), "end": w.get("end")})
    return words


def vtt_text(srt: str) -> str:
    """The cut's .srt sidecar as WebVTT: the same cues, the decimal comma as a point."""
    body = re.sub(r"(\d{2}:\d{2}:\d{2}),(\d{3})", r"\1.\2", srt.strip())
    # SRT numbers each cue; VTT allows an identifier line, so the numbers stay as cue ids.
    return "WEBVTT\n\n" + body + "\n"


# ── the database ─────────────────────────────────────────────────────────────

class AssemblyStore:
    """The rows one assembly reads and the two 0171 calls it makes, over Supabase REST with the service
    key (server-side only). Reads use 0166/0171's service_role SELECT grants; writes are 0171's functions
    and register_asset (through media_library)."""

    def __init__(self, media: ml.MediaStore):
        self.media = media

    def _get(self, table: str, params: Mapping[str, str]) -> List[dict]:
        r = self.media.http().get(f"{self.media.url}/rest/v1/{table}", params=dict(params),
                                  headers=self.media._h(), timeout=self.media._timeout)
        if r.status_code >= 300:
            raise RuntimeError(f"{table}: HTTP {r.status_code}")
        return list(r.json() or [])

    def _call(self, name: str, payload: dict):
        r = self.media.http().post(f"{self.media.url}/rest/v1/rpc/{name}", json=payload,
                                   headers=self.media._h({"Content-Type": "application/json"}),
                                   timeout=self.media._timeout)
        if r.status_code >= 300:
            word = None
            try:
                word = (r.json() or {}).get("message")
            except ValueError:
                pass
            raise DbRefused(name, r.status_code, str(word or ""))
        return r.json() if r.content else None

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
        if not ids:
            return []
        return self._get("media_assets", {"id": f"in.({','.join(sorted(set(ids)))})", "org_id": f"eq.{org_id}",
                                          "deleted_at": "is.null",
                                          "select": "id,org_id,kind,mime,duration_s,width,height,variants,"
                                                    "source,provenance,derived_bytes,deleted_at"})

    def begin(self, segment_id: str, worker: str) -> dict:
        return self._call("film_begin_assembly", {"p_segment": segment_id, "p_worker": worker}) or {}

    def record(self, segment_id: str, worker: str, ok: bool, asset_id: Optional[str]) -> dict:
        return self._call("film_record_assembly", {"p_segment": segment_id, "p_worker": worker, "p_ok": bool(ok),
                                                   "p_result_asset": asset_id}) or {}


class _Unrecorded(Exception):
    """The success record did not reach the database (not a refusal): leave the assembly running."""


class DbRefused(RuntimeError):
    """A 0171 function refused (its message is the machine word, e.g. lease_lost, not_running)."""

    def __init__(self, call: str, status: int, word: str):
        self.call, self.status, self.word = call, status, word
        super().__init__(f"{call}: HTTP {status} {word}")


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


def _latest_completed(takes: Sequence[Mapping], kind: str) -> Optional[Mapping]:
    done = [t for t in takes if t.get("kind") == kind and t.get("status") == "completed" and t.get("result_asset_id")]
    return max(done, key=lambda t: (int(t.get("version") or 0), int(t.get("attempt") or 0))) if done else None


def _params(take: Mapping) -> dict:
    p = take.get("params") or {}
    if isinstance(p, str):
        try:
            p = json.loads(p)
        except ValueError:
            p = {}
    return p if isinstance(p, dict) else {}


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
    check an uploaded caption gets, the same layout, the same register_asset (a retry with the same id
    gets the same row)."""
    ml.check_caption(path)
    final = ml.asset_dir(media_root, asset_id)
    work = final.with_name(f".{asset_id}.part")
    work.parent.mkdir(parents=True, exist_ok=True)
    shutil.rmtree(work, ignore_errors=True)
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


# ── one assembly ─────────────────────────────────────────────────────────────

@dataclass
class Deps:
    """What the assembly touches outside itself; tests replace any of it."""
    render: Callable[..., str] = timeline_render.render
    store_file: Callable[..., dict] = ml.store_generated
    store_captions: Callable[..., dict] = store_caption
    transcribe: Callable[[Path, Optional[str]], List[dict]] = whisper_words
    probe: Optional[Callable[[Path], Probed]] = None
    has_audio: Optional[Callable[[Path, str], bool]] = None
    free_mb: Callable[[Path], Optional[float]] = free_mb
    env: Mapping[str, str] = field(default_factory=lambda: os.environ)


def assemble_segment(segment: Mapping, *, worker_id: str, store: AssemblyStore, media: ml.MediaStore,
                     media_root: Path, tools: ml.Tools, deps: Optional[Deps] = None) -> AssemblyOutcome:
    """Assemble one segment whose ``assembly_status`` is running, and record the outcome with 0171.

    Returns the outcome; never leaves a failure unrecorded (see the module docstring). A lost lease is
    the one failure that is NOT recorded here: another worker holds the segment and records it. A
    database outage while recording propagates: the assembly stays running, the next claim retries it,
    and 0171's attempt cap and deadline end it at 0 if it never comes back."""
    deps = deps or Deps()
    seg_id = ml.canonical_id(segment.get("id"))
    org = ml.canonical_id(segment.get("org_id"))
    work = Path(media_root) / WORK_DIRNAME / seg_id
    sha: Optional[str] = None
    try:
        if not org_allowed(org, deps.env):
            # Checked before any row is read or anything rendered: a non-flagged organization is never assembled.
            raise AssemblyFailed("assembly_not_enabled", "film assembly is not switched on for this workspace")
        try:
            began = store.begin(seg_id, worker_id)
        except DbRefused as e:
            if e.word == "lease_lost":
                logger.warning("film assembly %s: the lease is another worker's now; stopping", seg_id)
                return AssemblyOutcome(False, reason="lease_lost", detail="another worker holds this segment")
            if e.word != "not_running":
                raise AssemblyFailed("not_running", f"film_begin_assembly refused ({e.word or e.status})") from None
            # 0171's begin answers as it is only while the assembly runs; once it ended it refuses. Read what it ended as:
            # a completed one is answered as it is (a retry after a crash right after the record: nothing rendered or
            # charged again), anything else is not this call's to record.
            row = store.segment(seg_id) or {}
            st = row.get("assembly_status")
            if st == "completed" and row.get("assembly_asset_id"):
                return AssemblyOutcome(True, asset_id=str(row["assembly_asset_id"]), segment=row)
            return AssemblyOutcome(False, reason="not_running",
                                   detail=f"the segment is {row.get('status')} and its assembly {st}: nothing to assemble",
                                   segment=row)
        result = _assemble(segment, seg_id, org, work, store=store, media=media, media_root=Path(media_root),
                           tools=tools, deps=deps)
        sha = result["sha"]
        try:
            rec = store.record(seg_id, worker_id, True, result["asset_id"])
        except DbRefused:
            raise
        except Exception:
            # The film is rendered and registered; only the record did not reach the database. Recording a failure now
            # would throw a good film away, so the assembly stays running: the next claim calls this again, finds the
            # same file by its id and records it (0171's attempt cap and deadline end it at 0 if that never happens).
            logger.warning("film assembly %s: rendered %s, but the record did not reach the database", seg_id,
                           result["asset_id"])
            raise _Unrecorded() from None
        logger.info("film assembly %s: completed (%s, %s s)", seg_id, result["asset_id"], result["length_s"])
        return AssemblyOutcome(True, asset_id=result["asset_id"], cut_sha256=sha,
                               captions_asset_id=result.get("captions_asset_id"), rendered=result["rendered"],
                               segment=rec)
    except AssemblyFailed as e:
        return _fail(store, seg_id, worker_id, e.reason, e.detail, sha)
    except DbRefused as e:
        if e.word == "lease_lost":
            return AssemblyOutcome(False, reason="lease_lost", detail="another worker holds this segment")
        return _fail(store, seg_id, worker_id, "assembly_crashed", f"{e.call} refused ({e.word or e.status})", sha)
    except _Unrecorded:
        raise ConnectionError("film_record_assembly did not reach the database") from None
    except Exception as e:  # noqa: BLE001 — every unexpected failure is still recorded at 0 before it propagates
        logger.exception("film assembly %s: unexpected failure", seg_id)
        _fail(store, seg_id, worker_id, "assembly_crashed", f"the assembly stopped unexpectedly ({type(e).__name__})",
              sha)
        raise
    finally:
        shutil.rmtree(work, ignore_errors=True)


def _fail(store: AssemblyStore, seg_id: str, worker: str, reason: str, detail: str, sha: Optional[str]) -> AssemblyOutcome:
    logger.warning("film assembly %s: failed (%s): %s", seg_id, reason, detail)
    try:
        rec = store.record(seg_id, worker, False, None)
    except DbRefused as e:
        if e.word == "lease_lost":
            return AssemblyOutcome(False, reason="lease_lost", detail="another worker holds this segment")
        raise
    return AssemblyOutcome(False, reason=reason, detail=detail, cut_sha256=sha, segment=rec)


def _assemble(segment: Mapping, seg_id: str, org: str, work: Path, *, store: AssemblyStore, media: ml.MediaStore,
              media_root: Path, tools: ml.Tools, deps: Deps) -> dict:
    film_id = ml.canonical_id(segment.get("film_id"))
    film = store.film(film_id)
    if not film or ml.canonical_id(film.get("org_id")) != org:
        raise AssemblyFailed("film_unavailable", "the film is no longer there")
    scenes = store.scenes(film_id)
    takes = store.takes(seg_id)
    narr_take = _latest_completed(takes, "narration")
    ids = [t["result_asset_id"] for t in takes if t.get("result_asset_id") and t.get("status") == "completed"]
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
        # own provenance, registered with it: {"segments": [...], "loudness_lufs", "true_peak_db", "words": [...]}.
        p = _params(narr_take)
        if not p.get("segments"):
            row = by_id.get(ml.canonical_id(narr_take["result_asset_id"])) or {}
            prov = row.get("provenance") or {}
            if isinstance(prov, str):
                try:
                    prov = json.loads(prov)
                except ValueError:
                    prov = {}
            p = prov if isinstance(prov, dict) else {}
        narration = {"asset_id": narr_take["result_asset_id"], "segments": p.get("segments") or [],
                     "loudness_lufs": p.get("loudness_lufs"), "true_peak_db": p.get("true_peak_db")}
        words = list(p.get("words") or [])

    # Captions are part of the assembly (0171): from the TTS vendor's word timings when the take carries them,
    # otherwise from Whisper on the take itself. Asked for and not producible: the assembly fails, by name.
    captions = None
    mode = film.get("captions_mode") or "sidecar"
    if narration is not None and mode != "none":
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
                words = deps.transcribe(path, film.get("language"))
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
    prev = {ml.canonical_id(r["id"]): r for r in store.assets(org, [aid])}
    if aid in prev and prev[aid].get("kind") == "video":
        _check_review_copy(prev[aid], media_root, aid)
        return {"asset_id": aid, "sha": sha, "length_s": cut.length_s, "rendered": False,
                "captions_asset_id": vtt_id}

    need = disk_needed_mb(width, height, cut.length_s)
    work.parent.mkdir(parents=True, exist_ok=True)
    have = deps.free_mb(work.parent)
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
    shutil.rmtree(work, ignore_errors=True)
    work.mkdir(parents=True, mode=0o700)
    out = work / "film.mp4"
    try:
        deps.render(norm, resolver, str(out), ffmpeg=tools.ffmpeg, workdir=str(work), jobs=1,
                    timeout_s=tl.render_timeout_s(cut.length_s))
    except render_backend.RenderTimeout:
        raise AssemblyFailed("render_timed_out", f"the render ran past its {tl.render_timeout_s(cut.length_s):.0f} s "
                             "limit: retry when the server is less busy") from None
    except Exception as e:  # noqa: BLE001
        raise AssemblyFailed("render_failed", f"the render failed ({type(e).__name__}): retry the assembly") from None
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

    prov = {"film_segment_id": seg_id, "film_id": film_id, "film_version": segment.get("film_version"),
            "cut_sha256": sha, "cut_format": ft.FORMAT_VERSION, "tool": "film_assembly"}
    if vtt_id:
        vtt = work / "captions.vtt"
        vtt.write_text(vtt_text(cut.srt), encoding="utf-8")
        try:
            deps.store_captions(vtt, asset_id=vtt_id, org_id=org, store=media, media_root=media_root,
                                provenance={**prov, "role": "captions"})
        except (ml.IngestReject, ml.StoreUnavailable) as e:
            raise AssemblyFailed("store_failed", f"the captions could not be stored ({type(e).__name__}): retry the "
                                 "assembly") from None
        prov["captions_asset_id"] = vtt_id
    try:
        stored = deps.store_file(out, asset_id=aid, org_id=org, store=media, media_root=media_root, tools=tools,
                                 expect_kind="video", source="generated", original_name="film.mp4", provenance=prov)
    except (ml.IngestReject, ml.StoreUnavailable) as e:
        raise AssemblyFailed("store_failed", f"the film could not be stored ({type(e).__name__}): retry the "
                             "assembly") from None
    if ml.canonical_id(stored.get("id")) != aid:
        raise AssemblyFailed("store_failed", "the library recorded another file: retry the assembly")
    # register_asset answers with the id, not the variants: read the row back for the review copy.
    row = {ml.canonical_id(r["id"]): r for r in store.assets(org, [aid])}.get(aid)
    if row is None:
        raise AssemblyFailed("store_failed", "the film is not in the library after storing it: retry the assembly")
    _check_review_copy(row, media_root, aid)
    return {"asset_id": aid, "sha": sha, "length_s": cut.length_s, "rendered": True, "captions_asset_id": vtt_id}


def _check_review_copy(row: Mapping, media_root: Path, aid: str) -> None:
    """The library's 480p proxy is the review copy; it must exist and fit one Supabase object."""
    variants = row.get("variants") or []
    proxy = ml.asset_file(media_root, aid, "proxy")
    if "proxy" not in variants or not proxy.is_file():
        raise AssemblyFailed("review_copy_missing", "the 480p review copy could not be made: retry the assembly")
    if proxy.stat().st_size > REVIEW_COPY_MAX_BYTES:
        raise AssemblyFailed("review_copy_too_large", f"the 480p review copy is {proxy.stat().st_size // 1_000_000} MB, "
                             "above the 50 MB a review object may be: shorten the film")


__all__ = ["AssemblyFailed", "AssemblyOutcome", "AssemblyStore", "DbRefused", "Deps", "REASONS", "allowed_orgs",
           "assemble_segment", "captions_asset_id", "cues_from_words", "disk_needed_mb", "enabled",
           "master_asset_id", "org_allowed", "store_caption", "vtt_text", "whisper_words"]

#!/usr/bin/env python3
"""S6: the paid Lyria 3.5 probe behind the vocal-activity measurement (CLAUDE.md rule 8; docs/MEASUREMENT.md "Lyria vocal
activity (S6)"). It COSTS MONEY: every sample is one real Lyria call. At most ``MAX_CALLS`` per run, enforced here and not
only in the workflow.

    GEMINI_API_KEY=... python tools/lyria_vocal_probe.py --confirm spend-5-lyria-calls [--count N] > samples.jsonl
    python tools/lyria_vocal_probe.py --markdown samples.jsonl                      # the job summary table

Five prompts: three ask for SUNG lyrics (English, Russian, Uzbek) and two for instrumentals (plain piano, and a hard
negative: an expressive synth and saxophone lead). The positives exist to show what singing looks like to the detectors,
so they are sent WITHOUT the product's instrumental suffix and are NOT run through the product's output check. That is
done by ``_lyria_call`` below, a narrow request of this tool's own: ``GoogleLyriaAdapter`` gains no flag, argument or path
that skips its check. The negatives are sent with the product's exact suffix (``negative_input`` must equal what the
adapter would send; a test pins it), so they measure what the product would actually receive.

What reaches stdout (and ``--jsonl FILE``, written and fsynced the moment each line exists, so a cancelled run keeps every
row it paid for): a ``call_started`` line before each request leaves, then ONE JSON line per sample, numbers and fixed words
only. A run stopped mid-call (a cancel, a crash) leaves a row whose spend is "unknown". The lyrics or structure text Google returns is
reduced to its length, its line count and ``returned_singing(text)``; the audio to its byte count and ``measure()``'s
numbers. Neither the text nor the audio, base64 or decoded, is printed, logged or kept: the audio files live in a private
temporary directory that is deleted when the run ends, whatever happens. The repository is public, so its Actions log is.

The price is not written here: the run is counted in calls.
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import re
import shutil
import signal
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Callable, Dict, Iterable, List, Mapping, Optional, TextIO

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from modules.capabilities.google_interactions import (  # noqa: E402  (after the path fix, as the other tools)
    LYRIA_API_REVISION,
    LYRIA_INSTRUMENTAL,
    _InteractionsBase,
    _structured_block,
    returned_singing,
)

#: The hard cap. A sixth call is refused by the code, whatever the workflow or the command line says.
MAX_CALLS = 5
#: The literal a person types to run it (the workflow's ``confirm`` input is the same word).
CONFIRM = "spend-5-lyria-calls"
MODEL = "lyria-3.5"
ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/interactions"
TIMEOUT_S = 300
#: The product adapter's own cap on what it decodes (GoogleLyriaAdapter.max_inline_bytes).
MAX_INLINE_BYTES = 32 * 1024 * 1024
_B64 = re.compile(r"^[A-Za-z0-9+/]*={0,2}$")

#: (id, prompt, sung). Lyrics are original and written for this probe (Google's filter blocks real songs' lyrics).
PROMPTS = (
    ("P1", "An upbeat acoustic pop song with a female lead vocal singing these lyrics in English.\n"
           "[Verse]\nMorning light across the river, I can hear the city wake\n"
           "Every window holds a story, every street a chance to take\n"
           "[Chorus]\nSing it out, the day is ours, hold on to the sound\n"
           "Sing it out beneath the stars, our feet above the ground", True),
    ("P2", "A warm ballad with a male lead vocal singing these lyrics in Russian.\n"
           "[Verse]\nТихий вечер над рекою, свет в окне горит\n"
           "Ветер лёгкою рукою с нами говорит\n"
           "[Chorus]\nПой со мной, пока не поздно, пой, пока светло\n"
           "Пусть над нами будут звёзды и в душе тепло", True),
    ("P3", "A lively folk-pop song with a female lead vocal singing these lyrics in Uzbek.\n"
           "[Verse]\nTong otdi, quyosh chiqdi, bog'larda gul ochildi\n"
           "Shamol kelib qo'shiq aytdi, yo'llarga nur sochildi\n"
           "[Chorus]\nKuyla, do'stim, kuyla bugun, quvonch to'la bu kunda\n"
           "Kuyla, do'stim, birga kuylaylik, yurak to'la shu tunda", True),
    ("N1", "A calm solo piano piece, slow tempo, soft dynamics, instrumental.", False),
    ("N2", "An energetic instrumental track with an expressive synth lead and a saxophone melody, no vocals.", False),
)


def negative_input(prompt: str) -> str:
    """What the product adapter sends for an instrumental request (GoogleLyriaAdapter._input with no language)."""
    return f"{prompt.strip()}\n\n{LYRIA_INSTRUMENTAL}"


class ProbeRefused(RuntimeError):
    """Nothing was called: the run was refused before any spend."""


class CallBudget:
    """Counts calls and refuses the one past ``MAX_CALLS``: the cap is checked at the call, not only at the argument."""

    def __init__(self, limit: int):
        if not 1 <= limit <= MAX_CALLS:
            raise ProbeRefused(f"count must be 1 to {MAX_CALLS}")
        self.limit = limit
        self.used = 0

    def spend(self) -> None:
        if self.used >= self.limit:
            raise ProbeRefused(f"the call budget of {self.limit} is used up")
        self.used += 1


Post = Callable[[str, dict, dict, int], "object"]


def _post(url: str, headers: dict, body: dict, timeout: int):
    import requests

    # No redirect is followed: the key rides in a header (the adapter's rule, _InteractionsBase.follow_redirects).
    return requests.post(url, headers=headers, json=body, timeout=timeout, allow_redirects=False)


def _lyria_call(key: str, text: str, *, post: Post = _post):
    """The probe's own request: the adapter's endpoint, headers and body shape, no suffix added, no output check. Returns
    ``(status, json_or_None)``."""
    headers = {"x-goog-api-key": key, "Api-Revision": LYRIA_API_REVISION, "Content-Type": "application/json"}
    body = {"model": MODEL, "input": text, "response_format": {"type": "audio"}, "background": False, "store": False}
    resp = post(ENDPOINT, headers, body, TIMEOUT_S)
    status = int(getattr(resp, "status_code", 0) or 0)
    try:
        data = resp.json()
    except Exception:
        data = None
    return status, data if isinstance(data, dict) else None


def _audio_block(data: dict) -> Optional[dict]:
    blocks = _InteractionsBase._contents(data, "audio")
    if blocks:
        return blocks[-1]
    top = data.get("output_audio")
    return top if isinstance(top, dict) else None


def _reported_rate(block: dict) -> Optional[int]:
    for k in ("sample_rate", "sampleRate", "sample_rate_hertz", "sampleRateHertz"):
        v = block.get(k)
        if isinstance(v, int) and not isinstance(v, bool):
            return v
    mime = str(block.get("mime_type") or "")
    m = re.search(r"rate=(\d+)", mime)
    return int(m.group(1)) if m else None


#: The media types echoed by name; anything else Google labels its audio with reads "other" (the log is public).
_MIME_ECHOED = ("audio/mpeg", "audio/mp3", "audio/wav", "audio/x-wav")


def _mime(block: dict) -> Optional[str]:
    raw = block.get("mime_type")
    if not isinstance(raw, str):
        return None
    mime = raw.split(";", 1)[0].strip().lower()
    return mime if mime in _MIME_ECHOED else "other"


def _decoded_rate(path: Path) -> Optional[int]:
    try:
        from tools.vocal_activity import ffmpeg_exe

        out = subprocess.run([ffmpeg_exe(), "-hide_banner", "-nostdin", "-i", str(path)], capture_output=True, timeout=60)
    except Exception:
        return None
    m = re.search(rb"Audio:.*?(\d{4,6}) Hz", out.stderr)
    return int(m.group(1)) if m else None


class Sink:
    """Where rows go, each one AS SOON AS it exists: first the JSONL file (flushed and fsynced, so a cancelled or killed job
    still leaves every row it paid for), then stdout for the log. The file is the record; stdout is only its mirror."""

    def __init__(self, out: TextIO, jsonl: Optional[Path] = None):
        self.out = out
        self.fh = open(jsonl, "a", encoding="utf-8") if jsonl else None

    def __call__(self, row: dict) -> None:
        line = json.dumps(row, sort_keys=True, ensure_ascii=True) + "\n"
        if self.fh:
            self.fh.write(line)
            self.fh.flush()
            os.fsync(self.fh.fileno())
        try:
            self.out.write(line)
            self.out.flush()
        except (BrokenPipeError, ValueError):
            # The log's reader (tee) went away first, as it does when a job is cancelled. The row is already in the file.
            pass

    def close(self) -> None:
        if self.fh:
            self.fh.close()


def sample(pid: str, prompt: str, sung: bool, *, key: str, budget: CallBudget, workdir: Path, measure: Callable,
           emit: Callable[[dict], None], post: Post = _post) -> dict:
    """One call and its numbers. Never raises for anything Google answers: a failed call is a recorded sample. Anything that
    stops the run after the call was counted (a cancel, a crash) still leaves a row saying the spend is unknown."""
    row: Dict[str, object] = {"prompt_id": pid, "asked_for": "sung lyrics" if sung else "instrumental",
                              "product_suffix_sent": not sung, "product_output_check_applied": False}
    budget.spend()
    row["call"] = budget.used
    # Before the request leaves: even a job killed mid-call has counted it.
    emit({"event": "call_started", "prompt_id": pid, "call": budget.used})
    try:
        _fill(row, pid, prompt if sung else negative_input(prompt), key=key, workdir=workdir, measure=measure, post=post)
    except BaseException as e:
        emit({"prompt_id": pid, "call": budget.used, "ok": False, "error": {"kind": type(e).__name__}, "spend": "unknown"})
        raise
    emit(row)
    return row


def _fill(row: Dict[str, object], pid: str, text_in: str, *, key: str, workdir: Path, measure: Callable, post: Post) -> None:
    try:
        status, data = _lyria_call(key, text_in, post=post)
    except Exception as e:      # timeout, connection lost: the call may have run and billed
        row.update({"ok": False, "error": {"kind": type(e).__name__}, "spend": "unknown"})
        return
    row["http_status"] = status
    if status != 200 or data is None:
        err = (data or {}).get("error") if isinstance(data, dict) else None
        err = err if isinstance(err, dict) else {}
        google_status = err.get("status") if isinstance(err.get("status"), str) and re.fullmatch(r"[A-Z_]{1,40}", err["status"]) else None
        row.update({"ok": False, "error": {"kind": "http", "google_status": google_status, "block_reason": _structured_block(err)},
                    "spend": "unknown"})
        return
    istatus = data.get("status")
    row["interaction_status"] = istatus if isinstance(istatus, str) and re.fullmatch(r"[a-z_]{1,20}", istatus) else "unreadable"
    # A completed interaction has most likely been billed; anything else is not known either way (BILLING_UNKNOWN).
    row["spend"] = "likely" if istatus == "completed" else "unknown"
    text = _InteractionsBase._text(data)
    has_text = bool(_InteractionsBase._contents(data, "text"))
    row.update({"has_text_block": has_text, "text_length": len(text), "text_lines": len(text.splitlines()) if text else 0,
                "returned_singing": returned_singing(text)})
    block = _audio_block(data)
    raw = block.get("data") if block else None
    if not isinstance(raw, str) or not raw:
        row.update({"ok": False, "error": {"kind": "no_audio", "block_reason": _structured_block(data)}})
        return
    row.update({"mime": _mime(block), "reported_sample_rate": _reported_rate(block)})
    if len(raw) * 3 // 4 > MAX_INLINE_BYTES or len(raw) % 4 or not _B64.fullmatch(raw):
        row.update({"ok": False, "error": {"kind": "bad_base64_or_too_large", "base64_chars": len(raw)}})
        return
    audio = base64.b64decode(raw, validate=True)
    del raw
    row["audio_bytes"] = len(audio)
    path = workdir / f"{pid}.audio"
    try:
        path.write_bytes(audio)
        del audio
        row["decoded_sample_rate"] = _decoded_rate(path)
        try:
            m = measure(path)
        except Exception as e:
            # The detector did not run on this sample: said so, never read as "no vocals" (rule 5).
            from tools.vocal_activity import MeasurementError

            detail = str(e)[:200] if isinstance(e, MeasurementError) else ""
            row.update({"ok": False, "measure": None, "error": {"kind": "measure_failed", "type": type(e).__name__, "detail": detail}})
            return
        row.update({"ok": True, "duration_s": m.get("duration_s"), "measure": m})
    finally:
        if path.exists():
            path.unlink()


def run(count: int, *, env: Mapping[str, str], out: TextIO, measure: Optional[Callable] = None, post: Post = _post,
        prompts: Iterable = PROMPTS, jsonl: Optional[Path] = None) -> int:
    budget = CallBudget(count)          # refuses > MAX_CALLS before anything else
    key = (env.get("GEMINI_API_KEY") or "").strip()
    if not key:
        raise ProbeRefused("GEMINI_API_KEY is not set: nothing was called")
    if measure is None:
        # The models load BEFORE the first paid call (rule 6): a missing weight costs nothing.
        from tools.vocal_activity import MeasurementError, load_detectors, measure as _measure

        try:
            det = load_detectors()
        except MeasurementError as e:
            raise ProbeRefused(f"the detectors did not load, so nothing was called: {e}") from None
        measure = lambda p: _measure(p, detectors=det)  # noqa: E731
    base = env.get("RUNNER_TEMP") or None
    workdir = Path(tempfile.mkdtemp(prefix="lyria-probe-", dir=base))
    os.chmod(workdir, 0o700)
    emit = Sink(out, jsonl)
    failures = 0
    try:
        for pid, prompt, sung in list(prompts)[:count]:
            row = sample(pid, prompt, sung, key=key, budget=budget, workdir=workdir, measure=measure, emit=emit, post=post)
            failures += 0 if row.get("ok") else 1
    finally:
        emit.close()
        shutil.rmtree(workdir, ignore_errors=True)
    return 1 if failures else 0


# ── the job summary ───────────────────────────────────────────────────────────────────

def _cell(v) -> str:
    if v is None:
        return "—"
    if isinstance(v, bool):
        return "yes" if v else "no"
    return str(v)


def markdown(lines: Iterable[str]) -> str:
    """A table of the samples' numbers. Only known numeric and fixed-word fields are read, so nothing else reaches it."""
    head = ["id", "asked for", "ok", "HTTP", "text block", "text len", "lines", "returned_singing", "mime", "rate (rep/dec)",
            "bytes", "duration s", "UMX p50 dB", "UMX p90 dB", "UMX max dB", "share > -20 dB", "run > -20 dB s",
            "PANNs voice max", "PANNs class", "PANNs mean", "Silero speech s", "spend", "error"]
    rows = ["| " + " | ".join(head) + " |", "|" + "---|" * len(head)]
    started = 0
    for line in lines:
        line = line.strip()
        if not line:
            continue
        try:
            r = json.loads(line)
        except ValueError:
            continue
        if not isinstance(r, dict):
            continue
        if r.get("event") == "call_started":
            started += 1
            continue
        m = r.get("measure") or {}
        u = m.get("umx_vocal_to_mix") or {}
        th = (u.get("thresholds") or {}).get("-20") or {}
        p = m.get("panns") or {}
        s = m.get("silero") or {}
        err = r.get("error") or {}
        cells = [r.get("prompt_id"), r.get("asked_for"), r.get("ok"), r.get("http_status"), r.get("has_text_block"),
                 r.get("text_length"), r.get("text_lines"), r.get("returned_singing"), r.get("mime"),
                 f"{_cell(r.get('reported_sample_rate'))}/{_cell(r.get('decoded_sample_rate'))}", r.get("audio_bytes"),
                 r.get("duration_s"), u.get("p50_db"), u.get("p90_db"), u.get("max_db"), th.get("share_above"),
                 th.get("longest_run_s"), p.get("voice_max"), p.get("voice_max_class"), p.get("voice_mean"),
                 s.get("speech_s") if s.get("ran") else ("not run" if m else None), r.get("spend"),
                 "/".join(str(err[k]) for k in ("kind", "google_status", "block_reason") if err.get(k)) or None]
        rows.append("| " + " | ".join(_cell(c).replace("|", "/") for c in cells) + " |")
    # The count is of calls STARTED (one per spend()), not of rows completed: a call cut off mid-way may still have billed.
    return f"Paid Lyria calls started: {started}\n\n" + "\n".join(rows) + "\n"


class Terminated(BaseException):
    """SIGTERM, raised so that every finally runs."""


def _terminated(signum, frame):
    raise Terminated()


def main(argv: Optional[List[str]] = None, *, env: Optional[Mapping[str, str]] = None, out: TextIO = sys.stdout) -> int:
    ap = argparse.ArgumentParser(description="Paid Lyria probe for the S6 vocal-activity measurement")
    ap.add_argument("--count", type=int, default=MAX_CALLS)
    ap.add_argument("--confirm", default="")
    ap.add_argument("--markdown", type=Path, help="print the summary table of a samples file and stop (no call)")
    ap.add_argument("--jsonl", type=Path, help="also append every row to this file the moment it exists (flushed)")
    args = ap.parse_args(argv)
    if args.markdown:
        out.write(markdown(args.markdown.read_text(encoding="utf-8").splitlines()))
        return 0
    try:
        if args.confirm != CONFIRM:
            raise ProbeRefused(f"pass --confirm {CONFIRM}: each sample is a paid call")
        # A cancelled job gets SIGTERM, which would end Python without running a finally: as an exception it leaves the
        # "spend unknown" row for the call in flight and deletes the audio.
        previous = signal.signal(signal.SIGTERM, _terminated)
        try:
            return run(args.count, env=os.environ if env is None else env, out=out, jsonl=args.jsonl)
        finally:
            signal.signal(signal.SIGTERM, previous)
    except ProbeRefused as e:
        print(f"refused: {e}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())

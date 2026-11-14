"""Measure the voice video's transcription before trusting it: local Whisper ``base`` against ElevenLabs Scribe.

CLAUDE.md rule 8: measurement is its own deliverable. The voice video (modules/capabilities/voice_video.py) moved from
Whisper to Scribe on the owner's decision; this tool is how "Scribe reads our Uzbek better" becomes a number, on our own
recordings, with a reference transcript a person typed.

    python tools/stt_compare.py --pair narration1.wav narration1.txt --pair narration2.mp3 narration2.txt
    python tools/stt_compare.py --pair a.wav a.txt --engines scribe --scribe-model scribe_v3 --yes

For every recording and engine it reports:

* **WER**: word error rate against the reference, (substitutions + deletions + insertions) / reference words, on
  normalised words (case folded, punctuation out, every Uzbek apostrophe form ``ʻ ' ` ‘ ’ ʼ`` made one, so ``oʻ`` / ``o'`` /
  ``o‘`` compare equal). A plain word-level Levenshtein: no dependency. An empty reference has no WER ("n/a"), never 0.
  It is computed over EVERY word the engine returned, timed or not: what the engine heard in the narration the person
  hears. For Scribe that is the vendor's own list (``VoiceVideoAdapter.scribe(raw=True)``), not the job's, which leaves
  out the words without times; ``timed`` says how many of them the job could place.
* **words**: how many words the engine returned (for Scribe: every ``type: word`` entry with text, timed or not).
* **timed**: the share of those words whose times are numbers, run forward (each start at or after the one before, each
  end at or after its start) and lie inside the recording. That is what the scenes and captions are cut on. Both engines
  are judged on everything they returned, so Scribe's share is not 100 % by construction.

What it calls, and when it spends:

* the recording is decoded to the exact copy the job sends (16 kHz mono 16-bit WAV, ffmpeg) in a scratch folder;
* Whisper runs on THIS machine (free, CPU; ``pip install -r requirements.txt``);
* Scribe is the job's own call (``VoiceVideoAdapter.scribe``: the same request, endpoint, form and error words; only the
  untimed words are kept instead of dropped), PAID per audio
  minute with the ``ELEVENLABS_API_KEY`` of the person running it. The plan (files, minutes, the model, an estimate) is
  printed first, and nothing is sent without ``--yes`` or a typed ``yes``. ``--dry-run`` prints the plan and stops.

An engine that cannot run is reported as such for every file ("failed: <code>"), never as a number, and the other engine is
not substituted for it (rule 4, rule 5). The key is never printed: only whether it is set.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import tempfile
import unicodedata
from pathlib import Path
from typing import Callable, Dict, List, Mapping, Optional, Sequence

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

#: Scribe's price per audio hour (elevenlabs.io/pricing/api read 2026-11-11, registry elevenlabs-scribe-v2): the estimate
#: printed before anything is sent. Another model may cost something else; the estimate says which model it is for.
SCRIBE_USD_PER_HOUR = 0.20
ENGINES = ("whisper", "scribe")

#: Every way an Uzbek Latin apostrophe is typed (oʻ, gʻ, the tutuq belgisi): the modifier letters, the typewriter quote,
#: the backtick and the curly quotes. One form after normalisation, or "oʻzbek" and "o'zbek" would count as an error.
APOSTROPHES = "ʻʼ'`‘’´ʹ"
_APOSTROPHE = "'"
_APOS_RE = re.compile(f"[{re.escape(APOSTROPHES)}]")


def normalize_text(text: str) -> str:
    """Case folded, apostrophes made one, every other punctuation mark or symbol a space, whitespace collapsed. An
    apostrophe is kept only inside a word (``o'zbek``), so a quoted word is the word."""
    s = unicodedata.normalize("NFC", str(text or "")).casefold()
    s = _APOS_RE.sub(_APOSTROPHE, s)
    out = []
    for ch in s:
        if ch == _APOSTROPHE or ch.isalnum():
            out.append(ch)
        elif unicodedata.category(ch)[0] in "PSZC":
            out.append(" ")
        else:  # combining marks and the like stay with their letter
            out.append(ch)
    words = [w.strip(_APOSTROPHE) for w in "".join(out).split()]
    return " ".join(w for w in words if w)


def words_of(text: str) -> List[str]:
    return normalize_text(text).split()


def edit_distance(ref: Sequence[str], hyp: Sequence[str]) -> int:
    """Word-level Levenshtein (substitution, deletion, insertion each cost 1), two rows of memory."""
    prev = list(range(len(hyp) + 1))
    for i, r in enumerate(ref, 1):
        cur = [i] + [0] * len(hyp)
        for j, h in enumerate(hyp, 1):
            cur[j] = min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (r != h))
        prev = cur
    return prev[-1]


def wer(reference: str, hypothesis: str) -> Optional[float]:
    """Word error rate of ``hypothesis`` against ``reference``; None when the reference has no words (unknown, not 0)."""
    ref, hyp = words_of(reference), words_of(hypothesis)
    if not ref:
        return None
    return edit_distance(ref, hyp) / len(ref)


def _num(v) -> Optional[float]:
    """A time as the job reads one (modules/captions: a number or a numeric string, never a bool, NaN or infinity), so
    ``timed`` counts what the job could place, not a stricter or looser rule of its own."""
    from modules import captions  # noqa: PLC0415

    return captions._seconds(v)


def timing_share(words: Sequence[Mapping], duration_s: float) -> Optional[float]:
    """The share of ``words`` (``{t|word|text, s|start, e|end}``) whose times are numbers, run forward and lie inside a
    ``duration_s`` recording. None for no words (nothing to judge)."""
    if not words:
        return None
    good = 0
    last_start = 0.0
    for w in words:
        s = _num(w.get("s", w.get("start")))
        e = _num(w.get("e", w.get("end")))
        if s is not None and e is not None and last_start <= s <= e <= duration_s:
            good += 1
        if s is not None:
            last_start = max(last_start, s)
    return good / len(words)


def text_of(words: Sequence[Mapping]) -> str:
    return " ".join(str(w.get("t", w.get("word", w.get("text", "")))) for w in words)


# ── the engines ──────────────────────────────────────────────────────────────

def prepare(audio: Path, work: Path, index: int) -> tuple:
    """(the 16 kHz mono copy the job sends, its length in seconds)."""
    from modules import voice_explainer as ve  # noqa: PLC0415
    from modules.capabilities import voice_video as vv  # noqa: PLC0415

    speech = work / f"{index}_{vv.SPEECH_FILE}"
    vv.decode_to_wav(audio, speech, rate=vv.SPEECH_RATE, channels=1)
    return speech, ve.audio_seconds(speech)


def run_whisper(speech: Path, work: Path) -> List[dict]:
    from modules.subtitle_generator import SubtitleGenerator  # noqa: PLC0415 — torch + whisper

    gen = SubtitleGenerator("stt-compare", work_dir=work / "whisper")
    try:
        return gen.transcribe(speech)
    finally:
        gen.release_model()


def scribe_runner(env: Mapping[str, str], model: str, language: Optional[str]) -> Callable[[Path, float], List[dict]]:
    from modules.capabilities import voice_video as vv  # noqa: PLC0415

    adapter = vv.VoiceVideoAdapter(env=env)

    def run(speech: Path, duration: float) -> List[dict]:
        # raw: the vendor's whole answer, so `words` and `timed` measure Scribe and not the job's filter (module doc).
        return adapter.scribe(speech, vv.scribe_timeout(duration), model=model, language=language, raw=True)

    return run


def measure(engine: str, run: Callable[[], List[dict]], reference: str, duration: float) -> Dict[str, object]:
    """One engine on one file. A failure is reported by its code, never as a number."""
    try:
        words = run()
    except Exception as e:  # noqa: BLE001 — the measurement reports every failure and goes on to the next file
        code = getattr(e, "code", None) or type(e).__name__
        message = getattr(e, "message", None) or ""
        return {"engine": engine, "ok": False, "error": str(code), "message": str(message)[:300]}
    return {"engine": engine, "ok": True, "wer": wer(reference, text_of(words)), "words": len(words),
            "timed": timing_share(words, duration)}


# ── the command ──────────────────────────────────────────────────────────────

def plan_text(pairs: Sequence[tuple], durations: Sequence[float], engines: Sequence[str], model: str,
              language: Optional[str], key_set: bool) -> str:
    minutes = sum(durations) / 60.0
    lines = [f"{len(pairs)} recording(s), {minutes:.1f} min of audio in all:"]
    lines += [f"  {Path(a).name}  {d:.1f} s  (reference: {Path(r).name})" for (a, r), d in zip(pairs, durations)]
    if "whisper" in engines:
        lines.append("Will run: local Whisper base on this machine (free, CPU).")
    if "scribe" in engines:
        from modules.capabilities import voice_video as vv  # noqa: PLC0415

        usd = minutes / 60.0 * SCRIBE_USD_PER_HOUR
        caveat = "" if model == vv.SCRIBE_MODEL else f"; that is {vv.SCRIBE_MODEL}'s price, {model}'s was not read"
        lines.append(f"Will call: ElevenLabs POST /v1/speech-to-text, model {model}, "
                     f"language {language or 'detected by the vendor'}, once per recording: PAID, "
                     f"about ${usd:.4f} at ${SCRIBE_USD_PER_HOUR:.2f} an audio hour{caveat}.")
        lines.append(f"ELEVENLABS_API_KEY: {'set' if key_set else 'NOT SET'}")
    return "\n".join(lines)


def fmt(v, pct=True) -> str:
    if v is None:
        return "n/a"
    return f"{v * 100:.1f}%" if pct else str(v)


def report(rows: Sequence[dict]) -> str:
    out = [f"{'recording':32} {'engine':8} {'WER':>8} {'words':>6} {'timed':>7}"]
    for r in rows:
        if r["ok"]:
            out.append(f"{r['file'][:32]:32} {r['engine']:8} {fmt(r['wer']):>8} {r['words']:>6} {fmt(r['timed']):>7}")
        else:
            out.append(f"{r['file'][:32]:32} {r['engine']:8} failed: {r['error']} {r['message']}")
    return "\n".join(out)


def main(argv: Optional[Sequence[str]] = None, *, env: Optional[Mapping[str, str]] = None,
         ask: Callable[[str], str] = input, interactive: Optional[bool] = None) -> int:
    ap = argparse.ArgumentParser(description="Whisper base vs ElevenLabs Scribe on recordings with reference transcripts.")
    ap.add_argument("--pair", nargs=2, action="append", metavar=("AUDIO", "REFERENCE"), required=True,
                    help="a recording and a UTF-8 text file of what is said in it (repeat)")
    ap.add_argument("--engines", default=",".join(ENGINES), help="comma list of whisper, scribe (default both)")
    ap.add_argument("--scribe-model", default=None, help="Scribe model id (default: the one the voice video sends)")
    ap.add_argument("--language", default=None, help="a language_code for Scribe (default: none, as the job sends)")
    ap.add_argument("--json", type=Path, default=None, help="also write the rows here")
    ap.add_argument("--dry-run", action="store_true", help="print the plan and stop: no call, no spend")
    ap.add_argument("--yes", action="store_true", help="send without asking (the plan is still printed)")
    args = ap.parse_args(argv)
    env = os.environ if env is None else env

    from modules.capabilities import voice_video as vv  # noqa: PLC0415

    engines = [e.strip() for e in args.engines.split(",") if e.strip()]
    bad = [e for e in engines if e not in ENGINES]
    if bad or not engines:
        print(f"unknown engine(s) {bad or engines}: pick from {', '.join(ENGINES)}", file=sys.stderr)
        return 2
    if args.language is not None and not re.fullmatch(r"[a-z]{2,3}", args.language):
        print("--language must be a two- or three-letter code (uz, ru, en)", file=sys.stderr)
        return 2
    model = args.scribe_model or vv.SCRIBE_MODEL
    pairs = [(Path(a), Path(r)) for a, r in args.pair]
    for a, r in pairs:
        for f in (a, r):
            if not f.is_file():
                print(f"not a file: {f}", file=sys.stderr)
                return 2
    references = [r.read_text(encoding="utf-8") for _a, r in pairs]
    key_set = bool((env.get(vv.KEY_ENV) or "").strip())
    if "scribe" in engines and not key_set:
        # Never a silent "Whisper only" table: the person asked for Scribe.
        print(f"{vv.KEY_ENV} is not set: set it, or pass --engines whisper", file=sys.stderr)
        return 2

    with tempfile.TemporaryDirectory(prefix="stt-compare-") as tmp:
        work = Path(tmp)
        prepared = []
        for i, (a, _r) in enumerate(pairs):
            try:
                prepared.append(prepare(a, work, i))
            except Exception as e:  # noqa: BLE001 — named, then stop: nothing has been sent yet
                print(f"{a.name}: could not be decoded ({getattr(e, 'message', None) or type(e).__name__})", file=sys.stderr)
                return 2
        print(plan_text(pairs, [d for _s, d in prepared], engines, model, args.language, key_set))
        if args.dry_run:
            print("Dry run: nothing was called.")
            return 0
        if "scribe" in engines and not args.yes:
            tty = sys.stdin.isatty() if interactive is None else interactive
            if not tty or ask("Type yes to send these recordings to ElevenLabs (paid): ").strip().lower() != "yes":
                print("Nothing was sent.")
                return 1
        scribe = scribe_runner(env, model, args.language) if "scribe" in engines else None
        rows = []
        for (a, _r), (speech, duration), ref in zip(pairs, prepared, references):
            for engine in engines:
                if engine == "whisper":
                    run = lambda s=speech: run_whisper(s, work)  # noqa: E731
                else:
                    run = lambda s=speech, d=duration: scribe(s, d)  # noqa: E731
                row = measure(engine, run, ref, duration)
                row.update(file=a.name, duration_s=round(duration, 2), model="base" if engine == "whisper" else model)
                rows.append(row)
    print(report(rows))
    if args.json:
        args.json.write_text(json.dumps(rows, ensure_ascii=False, indent=2), encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

"""The film assembly's Whisper transcription, run as its own short-lived process (server-side only).

``modules.film_assembly.whisper_words`` starts this with ``python -m modules.film_whisper`` and reads the words back
from ``--out``. It is a separate process because Whisper base on a 10-minute narration peaks at 1.25 GB and leaves
about 810 MB held in the Python process after the call returns (gc does not give it back), and the render that
follows runs in the same 3 GiB container (docs/studio/S4_GAPS.md G4). A child's memory goes back to the kernel when it
exits.

It never downloads. The model is read from ``--model-dir`` (the image's read-only ``NIGHTSHIFT_WHISPER_DIR``,
S4_GAPS G1). Whisper's own loader would fetch the file again when its checksum does not match, so the checksum is
verified here first, and the network fetch is disabled in this process anyway.

Exit codes are the parent's contract:

* 0: the words were written to ``--out`` as a JSON list of ``{"word", "start", "end"}`` (:class:`Word`).
* 3 (``EXIT_MODEL``): the worker is broken, not the film: the model is missing, unreadable, corrupt or would not load,
  this Whisper no longer names the "base" model's checksum, or ffmpeg could not be started. Rebuild the image.
* 4 (``EXIT_AUDIO``): ffmpeg ran and could not decode the narration file. Generate the narration again.
* 5 (``EXIT_MEMORY``): the model or the transcription ran out of memory. Start the film again when the worker is idle.
* anything else: an unexpected failure. Its message is on stderr.

The arguments are a model folder, a language code and two file paths: nothing secret is ever passed, and the parent
starts this with a minimal environment that holds no key either.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
from typing import List, NoReturn, Optional, TypedDict

MODEL_NAME = "base"
MODEL_FILE = "base.pt"
EXIT_MODEL = 3
EXIT_AUDIO = 4
EXIT_MEMORY = 5


class Word(TypedDict):
    word: str
    start: float
    end: float


def _refuse_download(*_a, **_k) -> NoReturn:
    raise RuntimeError("the film assembly never downloads the Whisper model at run time")


def _expected_sha256(whisper) -> Optional[str]:
    """The checksum whisper itself checks, read from the address it would fetch from; None when that has moved."""
    try:
        sha = whisper._MODELS[MODEL_NAME].split("/")[-2]  # noqa: SLF001
    except (AttributeError, KeyError, IndexError, TypeError):
        return None
    return sha if isinstance(sha, str) and len(sha) == 64 else None


def _model_ok(whisper, model_dir: str) -> Optional[str]:
    """None when the folder holds Whisper's own ``base`` checkpoint byte for byte; otherwise what is wrong."""
    expected = _expected_sha256(whisper)
    if expected is None:
        return f"this Whisper does not name a {MODEL_NAME} model checksum (not the pinned version?)"
    path = os.path.join(model_dir, MODEL_FILE)
    h = hashlib.sha256()
    try:
        with open(path, "rb") as f:
            for chunk in iter(lambda: f.read(1 << 20), b""):
                h.update(chunk)
    except OSError as e:
        return f"cannot read {path} ({type(e).__name__})"
    if h.hexdigest() != expected:
        return f"{path} is not Whisper's {MODEL_NAME} model (checksum mismatch)"
    return None


def words_of(result: dict) -> List[Word]:
    words: List[Word] = []
    for seg in result.get("segments") or []:
        for w in seg.get("words") or []:
            words.append({"word": w.get("word"), "start": w.get("start"), "end": w.get("end")})
    return words


def main(argv: Optional[List[str]] = None) -> int:
    ap = argparse.ArgumentParser(prog="python -m modules.film_whisper")
    ap.add_argument("--model-dir", required=True)
    ap.add_argument("--language", default="")
    ap.add_argument("--out", required=True)
    ap.add_argument("audio")
    a = ap.parse_args(argv)

    import urllib.request  # noqa: PLC0415

    # whisper._download fetches through exactly this when the file is missing or its checksum differs.
    urllib.request.urlopen = _refuse_download
    try:
        import whisper  # noqa: PLC0415 — only the worker image has it
    except ImportError as e:
        print(f"film_whisper: whisper is not installed ({type(e).__name__})", file=sys.stderr)
        return EXIT_MODEL
    problem = _model_ok(whisper, a.model_dir)
    if problem:
        print(f"film_whisper: {problem}", file=sys.stderr)
        return EXIT_MODEL
    try:
        # By name, not by file path: a path loads without the "base" alignment heads, and the word timings change.
        model = whisper.load_model(MODEL_NAME, download_root=a.model_dir)
    except MemoryError:
        print("film_whisper: out of memory loading the model", file=sys.stderr)
        return EXIT_MEMORY
    except Exception as e:  # noqa: BLE001 — a checkpoint that does not load is the image's fault, not the film's
        print(f"film_whisper: the model did not load ({type(e).__name__})", file=sys.stderr)
        return EXIT_MODEL
    try:
        # What transcribe() would do with the path itself (log_mel_spectrogram → load_audio at 16 kHz), done here so
        # an undecodable narration is told apart from a broken worker.
        audio = whisper.load_audio(a.audio)
    except OSError as e:
        # ffmpeg itself could not be started (not on PATH, not executable): the image, not the narration.
        print(f"film_whisper: ffmpeg could not be started ({type(e).__name__})", file=sys.stderr)
        return EXIT_MODEL
    except RuntimeError as e:
        # whisper.load_audio's own "Failed to load audio": ffmpeg ran and refused the file.
        print(f"film_whisper: the narration could not be decoded ({type(e).__name__})", file=sys.stderr)
        return EXIT_AUDIO
    try:
        # Same arguments as before the move to a child (temperature 0, no fallback): the same file gives the same
        # words, so a second attempt builds the same cut.
        out = model.transcribe(audio, language=(a.language or None), word_timestamps=True, fp16=False,
                               condition_on_previous_text=False, temperature=0.0)
    except MemoryError:
        print("film_whisper: out of memory transcribing", file=sys.stderr)
        return EXIT_MEMORY
    tmp = f"{a.out}.part"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(words_of(out), f)
    os.replace(tmp, a.out)
    return 0


if __name__ == "__main__":
    sys.exit(main())

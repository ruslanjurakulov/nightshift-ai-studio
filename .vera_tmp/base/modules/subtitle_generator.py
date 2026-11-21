"""Stage 5: Whisper Subtitles — word-by-word animated captions (MrBeast / Hormozi style)."""

import ctypes
import gc
import logging
from pathlib import Path

import whisper

from modules.resource_monitor import process_rss_mb

from config import (
    OUTPUT_DIR,
    SUBTITLE_COLOR,
    SUBTITLE_FONT,
    SUBTITLE_FONT_SIZE,
    SUBTITLE_HIGHLIGHT_COLOR,
    SUBTITLE_STROKE_COLOR,
    SUBTITLE_STROKE_WIDTH,
)

logger = logging.getLogger(__name__)

# Whisper model size: "tiny" | "base" | "small" | "medium" | "large"
WHISPER_MODEL = "base"


class SubtitleGenerator:
    def __init__(self, topic_slug: str):
        self.slug = topic_slug
        self.work_dir = OUTPUT_DIR / topic_slug / "subtitles"
        self.work_dir.mkdir(parents=True, exist_ok=True)
        self._model: whisper.Whisper | None = None

    def _get_model(self) -> whisper.Whisper:
        if self._model is None:
            logger.info("Loading Whisper model '%s'...", WHISPER_MODEL)
            self._model = whisper.load_model(WHISPER_MODEL)
        return self._model

    def release_model(self) -> None:
        """Drop the Whisper model once transcription is done.

        The generator used to stay alive through the composite: `_model` is
        cached on the instance, main.py holds that instance, and the render
        happens two stages later. So Whisper's weights — 'base' is ~74M
        parameters held as fp32, plus torch's own runtime — sat in the process
        for the whole of the stage that has twice been killed, for a model no
        later stage uses.

        Dropping the reference frees the tensors, but glibc keeps the freed
        arenas mapped, so RSS often does not fall until malloc_trim hands them
        back. That call is Linux/glibc-only and guarded; where it is missing
        the collection still happens and only the return to the OS is delayed.

        The before/after RSS is logged, because "this frees memory" is a claim
        that should be checked against the machine rather than asserted.
        """
        if self._model is None:
            return
        before = process_rss_mb()
        self._model = None
        gc.collect()
        try:
            ctypes.CDLL("libc.so.6").malloc_trim(0)
        except (OSError, AttributeError):
            pass  # not glibc — the memory is freed, just not yet returned
        after = process_rss_mb()
        if before is None or after is None:
            logger.info("Released the Whisper model")
        else:
            logger.info(
                "Released the Whisper model: process RSS %.0f MB -> %.0f MB",
                before, after,
            )

    def transcribe(self, audio_path: Path) -> list[dict]:
        """
        Returns word-level timestamps:
        [{"word": str, "start": float, "end": float}, ...]
        """
        model = self._get_model()
        result = model.transcribe(
            str(audio_path),
            word_timestamps=True,
            verbose=False,
        )
        words = []
        for seg in result.get("segments", []):
            for w in seg.get("words", []):
                words.append({
                    "word": w["word"].strip(),
                    "start": w["start"],
                    "end": w["end"],
                })
        logger.info("Transcribed %d words", len(words))
        return words

    def to_srt(self, words: list[dict], out_path: Path | None = None) -> Path:
        """Write standard .srt subtitle file (3-4 words per line)."""
        out_path = out_path or self.work_dir / "subtitles.srt"
        lines = []
        chunk_size = 4
        idx = 1
        for i in range(0, len(words), chunk_size):
            chunk = words[i:i + chunk_size]
            start = chunk[0]["start"]
            end = chunk[-1]["end"]
            text = " ".join(w["word"] for w in chunk)
            lines.append(f"{idx}")
            lines.append(f"{_srt_time(start)} --> {_srt_time(end)}")
            lines.append(text)
            lines.append("")
            idx += 1
        out_path.write_text("\n".join(lines), encoding="utf-8")
        logger.info("SRT written: %s", out_path)
        return out_path

    def word_clips(self, words: list[dict], video_w: int, video_h: int) -> list[dict]:
        """
        Returns clip specs for the compositor to render animated word captions.
        Each entry: {word, start, end, x, y, color, highlight}
        Highlighted word = current word being spoken.
        """
        specs = []
        chunk_size = 4
        for i in range(0, len(words), chunk_size):
            chunk = words[i:i + chunk_size]
            line_text = " ".join(w["word"] for w in chunk)
            for j, w in enumerate(chunk):
                specs.append({
                    "word": w["word"],
                    "line": line_text,
                    "word_index_in_line": j,
                    "chunk_words": [c["word"] for c in chunk],
                    "start": w["start"],
                    "end": w["end"],
                    "x": video_w / 2,
                    "y": int(video_h * 0.82),
                    "color": SUBTITLE_COLOR,
                    "highlight_color": SUBTITLE_HIGHLIGHT_COLOR,
                    "font": SUBTITLE_FONT,
                    "font_size": SUBTITLE_FONT_SIZE,
                    "stroke_color": SUBTITLE_STROKE_COLOR,
                    "stroke_width": SUBTITLE_STROKE_WIDTH,
                })
        return specs


def _srt_time(seconds: float) -> str:
    h = int(seconds // 3600)
    m = int((seconds % 3600) // 60)
    s = int(seconds % 60)
    ms = int((seconds % 1) * 1000)
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"

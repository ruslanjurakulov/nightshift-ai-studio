"""Stage 6: MoviePy Compositor — assembles video clips + Ken Burns images + subtitles."""

import gc
import logging
import os
import random
from pathlib import Path

from PIL import Image

# moviepy 1.0.3 predates Pillow 10 and its PIL fallback resizer still calls
# Image.ANTIALIAS, which Pillow 10 removed. The resizer is chosen at moviepy
# import time, so this alias has to land first or every .resize() call dies on
# the first frame pull — that is, inside write_videofile, after the downloads,
# TTS and Whisper pass have all already been paid for.
if not hasattr(Image, "ANTIALIAS"):
    Image.ANTIALIAS = Image.LANCZOS

import numpy as np  # noqa: E402
from moviepy.editor import (  # noqa: E402
    AudioFileClip,
    ColorClip,
    CompositeVideoClip,
    TextClip,
    VideoClip,
    VideoFileClip,
    concatenate_videoclips,
)

from config import (  # noqa: E402
    OUTPUT_DIR,
    SUBTITLE_FONT,
    SUBTITLE_FONT_SIZE,
    SUBTITLE_HIGHLIGHT_COLOR,
    SUBTITLE_STROKE_COLOR,
    SUBTITLE_STROKE_WIDTH,
    VIDEO_FPS,
    VIDEO_HEIGHT,
    VIDEO_WIDTH,
)
from modules import broll_match  # noqa: E402
from modules.resource_monitor import mark_stage  # noqa: E402
from modules.script_engine import Script  # noqa: E402

logger = logging.getLogger(__name__)


def _render_threads() -> int:
    """How many x264 threads the final encode uses.

    Each thread keeps its own 1080p frame buffers, and on GitHub Actions the
    render has been killed at `exit 143` with ffmpeg children eating the ~7.9 GB
    machine (see README). Fewer threads means a lower peak — a little slower, the
    same file. Env-tunable so a memory-starved runner can drop to 1 without a
    code change; default 2 (today's value), clamped to 1..8. An unset or
    malformed value keeps the default, so nothing changes unless it is set."""
    raw = os.getenv("NIGHTSHIFT_RENDER_THREADS", "").strip()
    try:
        n = int(raw)
    except (TypeError, ValueError):
        return 2
    return max(1, min(8, n))


KEN_BURNS_ZOOM = 0.12   # fraction zoomed over a clip's life
KEN_BURNS_PAN = 0.30    # fraction of image width traversed on a pan
COVER_OVERSCAN = 1.15   # scale beyond canvas so panning has room to move


class Compositor:
    def __init__(self, topic_slug: str):
        self.slug = topic_slug
        self.out_dir = OUTPUT_DIR / topic_slug
        self.out_dir.mkdir(parents=True, exist_ok=True)
        # One reader per source file, not per clip slot. A 5-minute video cuts
        # into ~60-70 slots; opening a reader for each holds that many ffmpeg
        # subprocesses (and their frame buffers) alive until the render ends.
        self._readers: dict[Path, VideoFileClip] = {}
        # One render per distinct (text, colour), not one per clip. The word
        # highlight works by stacking a masked copy over the whole line, so a
        # four-word line asks for its white base line four times — byte-for-byte
        # the same image. On a real 554-word script that was 1108 ImageMagick
        # subprocesses and 1108 full-width rasters held at once; the render died
        # with the runner killed mid-composite.
        #
        # Clips built from a cached entry are still separate clips: set_start and
        # friends are outplace in moviepy, so each returns a copy that shares the
        # underlying image buffer. Nothing is dropped and nothing looks different
        # — the same picture is simply drawn once instead of four times.
        self._text_clips: dict[tuple[str, str], TextClip] = {}

    # ------------------------------------------------------------------ Ken Burns

    def _ken_burns_clip(self, image_path: Path, duration: float) -> VideoClip:
        """Animate a still image with zoom/pan (Ken Burns effect)."""
        img = Image.open(image_path).convert("RGB")
        src_w, src_h = img.size
        target_w, target_h = VIDEO_WIDTH, VIDEO_HEIGHT

        scale = max(target_w / src_w, target_h / src_h) * COVER_OVERSCAN
        new_w, new_h = int(src_w * scale), int(src_h * scale)
        img_np = np.array(img.resize((new_w, new_h), Image.LANCZOS))

        style = random.choice(["zoom_in", "zoom_out", "pan_left", "pan_right"])

        def make_frame(t: float):
            progress = min(1.0, t / max(duration, 0.001))

            if style == "zoom_in":
                zoom = 1.0 + KEN_BURNS_ZOOM * progress
            elif style == "zoom_out":
                zoom = (1.0 + KEN_BURNS_ZOOM) - KEN_BURNS_ZOOM * progress
            else:
                zoom = 1.06

            # Crop window, never larger than the source.
            frame_w = min(new_w, int(target_w / zoom))
            frame_h = min(new_h, int(target_h / zoom))

            if style == "pan_left":
                cx = int(new_w * (0.5 + KEN_BURNS_PAN / 2 - KEN_BURNS_PAN * progress))
            elif style == "pan_right":
                cx = int(new_w * (0.5 - KEN_BURNS_PAN / 2 + KEN_BURNS_PAN * progress))
            else:
                cx = new_w // 2

            # Clamp the window's POSITION, not its edges. Clamping x1 and x2
            # independently silently narrows the crop at the end of a pan, and
            # resizing that narrower crop back to full width stretches the image.
            x1 = min(max(0, cx - frame_w // 2), new_w - frame_w)
            y1 = min(max(0, new_h // 2 - frame_h // 2), new_h - frame_h)

            crop = img_np[y1:y1 + frame_h, x1:x1 + frame_w]
            resized = Image.fromarray(crop).resize((target_w, target_h), Image.LANCZOS)
            return np.array(resized)

        return VideoClip(make_frame, duration=duration)

    # ------------------------------------------------------------------ Clip pool

    def _open_video(self, path: Path) -> VideoFileClip:
        """Reader cache — reopening the same file per slot exhausts handles.

        `audio=False` is not a tidy-up: it is the fix for the memory death.
        MoviePy 1.0.3 builds an AudioFileClip inside VideoFileClip unless told
        not to, and that clip spawns an ffmpeg process of its own. Constructing
        the reader and *then* calling `.without_audio()` discards the clip but
        only after the process exists, so every source video cost two ffmpeg
        decoders instead of one — twenty-four of them for the twelve videos a
        run fetches, all alive for the whole render because the composed clips
        pull frames lazily and the readers cannot be closed early.

        Run #19 died exactly there: process RSS stayed flat near 1 GB while
        system free memory fell 6348 MB -> 112 MB and the runner was reclaimed
        (exit 143), leaving four orphaned ffmpeg processes behind. The audio we
        were paying for was thrown away in the next breath.
        """
        if path not in self._readers:
            self._readers[path] = VideoFileClip(str(path), audio=False)
        return self._readers[path]

    @staticmethod
    def _ordered_pool(
        video_paths: list[Path],
        image_paths: list[Path],
        section_keywords: list | None,
        clip_terms: dict | None,
    ) -> list:
        """The source order a section's cuts are filled from.

        When we know each clip's fetch keyword (`clip_terms`, path-str → keyword)
        and the section's own keywords, the videos are ordered by relevance so
        the footage under the narration actually matches what is being said —
        the whole point of modules/broll_match.py. A clip with no recorded term
        just scores zero and sinks; it is never dropped. Images follow the
        videos. With neither signal available we fall back to the original
        random shuffle, so behaviour is unchanged for callers that pass none.
        """
        videos = list(video_paths)
        if section_keywords and clip_terms:
            candidates = [
                {"path": str(p), "keyword": clip_terms.get(str(p), "")} for p in videos
            ]
            ranked = broll_match.rank_clips(candidates, section_keywords)
            videos = [Path(c["path"]) for c in ranked]
        else:
            random.shuffle(videos)
        images = list(image_paths)
        random.shuffle(images)
        return videos + images

    def _build_clip_pool(
        self,
        video_paths: list[Path],
        image_paths: list[Path],
        cut_interval: float,
        total_duration: float,
        section_keywords: list | None = None,
        clip_terms: dict | None = None,
    ) -> list:
        """Build a sequence of video/image clips to fill `total_duration`."""
        clips = []
        pool: list[Path | None] = self._ordered_pool(
            video_paths, image_paths, section_keywords, clip_terms
        )
        if not pool:
            pool = [None] * 20  # solid-colour placeholders

        elapsed = 0.0
        pool_idx = 0

        while elapsed < total_duration:
            clip_dur = min(cut_interval, total_duration - elapsed)
            if clip_dur < 0.1:
                break

            source = pool[pool_idx % len(pool)]
            pool_idx += 1

            try:
                if source is None:
                    clip = ColorClip((VIDEO_WIDTH, VIDEO_HEIGHT), color=(15, 15, 30),
                                     duration=clip_dur)
                elif source.suffix.lower() in (".mp4", ".mov", ".avi", ".webm", ".mkv"):
                    vc = self._open_video(source)
                    if vc.duration > clip_dur + 1:
                        start = random.uniform(0, vc.duration - clip_dur)
                        vc = vc.subclip(start, start + clip_dur)
                    else:
                        vc = vc.loop(duration=clip_dur)
                    clip = vc.resize((VIDEO_WIDTH, VIDEO_HEIGHT))
                else:
                    clip = self._ken_burns_clip(source, clip_dur)
            except Exception as e:
                logger.warning("Clip load error %s: %s", source, e)
                clip = ColorClip((VIDEO_WIDTH, VIDEO_HEIGHT), color=(15, 15, 30),
                                 duration=clip_dur)

            clips.append(clip)
            elapsed += clip_dur

        return clips

    # ------------------------------------------------------------------ Subtitles

    def _make_text_clip(self, text: str, color: str) -> TextClip:
        """A text clip for this string and colour, rendered at most once.

        Callers must treat the result as read-only and derive from it with the
        outplace setters (set_start / set_duration / set_position), which is what
        _build_subtitle_clips does. Mutating it in place would corrupt every
        other clip sharing the entry.
        """
        key = (text, color)
        cached = self._text_clips.get(key)
        if cached is not None:
            return cached
        clip = self._render_text_clip(text, color)
        self._text_clips[key] = clip
        return clip

    def _render_text_clip(self, text: str, color: str) -> TextClip:
        return TextClip(
            text,
            fontsize=SUBTITLE_FONT_SIZE,
            font=SUBTITLE_FONT,
            color=color,
            stroke_color=SUBTITLE_STROKE_COLOR,
            stroke_width=SUBTITLE_STROKE_WIDTH,
            method="caption",
            size=(VIDEO_WIDTH - 100, None),
            align="center",
        )

    def _build_subtitle_clips(self, word_specs: list[dict]) -> list[TextClip]:
        """One clip per word: the whole line, with the spoken word highlighted.

        word_specs carries one entry per word, each repeating its 4-word line.
        Rendering the line once per word (rather than deduping to one clip per
        line) is what makes the highlight move — and each clip spans exactly the
        word's own start..end, so there are no gaps where the line blinks out.
        """
        if not word_specs:
            return []

        clips = []
        failures = 0

        for spec in word_specs:
            words = spec.get("chunk_words") or [spec["word"]]
            idx = spec.get("word_index_in_line", 0)
            start = spec["start"]
            duration = max(0.05, spec["end"] - start)

            # ImageMagick has no inline markup, so the highlight is a second
            # clip stacked over the line with only the active word visible.
            base = " ".join(words)
            masked = " ".join(w if i == idx else " " * len(w) for i, w in enumerate(words))

            try:
                layer = self._make_text_clip(base, "white")
                hi = self._make_text_clip(masked, SUBTITLE_HIGHLIGHT_COLOR)
            except Exception as e:
                failures += 1
                if failures == 1:
                    logger.error("Subtitle rendering failed: %s", e)
                continue

            y = int(VIDEO_HEIGHT * 0.80)
            for c in (layer, hi):
                clips.append(
                    c.set_start(start).set_duration(duration).set_position(("center", y))
                )

        if failures:
            logger.warning("%d/%d subtitle clips failed", failures, len(word_specs))
        if not clips:
            raise RuntimeError(
                "Every subtitle failed to render. TextClip needs ImageMagick:\n"
                "  Windows: install from https://imagemagick.org/script/download.php\n"
                "           (tick 'Install legacy utilities' so convert.exe exists)\n"
                "  Linux:   sudo apt-get install imagemagick\n"
                f"The configured font is {SUBTITLE_FONT!r}; try 'Arial' or a font "
                "file path if ImageMagick is installed but cannot resolve it."
            )
        return clips

    # ------------------------------------------------------------------ Master render

    def _build_presenter_clip(self, presenter_path: Path, total_duration: float):
        """Load the AITuber presenter clip and size/position it into a corner
        inset. Returns a positioned VideoClip, or None if the file can't be used
        — a bad presenter must degrade to a faceless render, never crash it or
        put a broken frame on screen. Its own audio is dropped so it can't
        displace the narration set on the final composite."""
        from modules.avatar import presenter_layout

        try:
            clip = VideoFileClip(str(presenter_path))
        except Exception as e:
            logger.error("Could not open presenter clip %s (%s: %s) — rendering faceless",
                         presenter_path, type(e).__name__, e)
            return None
        # Registered so the finally-block in render() closes its reader.
        self._readers[Path(presenter_path)] = clip
        try:
            layout = presenter_layout(VIDEO_WIDTH, VIDEO_HEIGHT)
            src_dur = clip.duration or total_duration
            dur = min(src_dur, total_duration)
            positioned = (
                clip.subclip(0, dur)
                .without_audio()
                .resize(newsize=(layout["w"], layout["h"]))
                .set_position((layout["x"], layout["y"]))
                .set_start(0)
                .set_duration(dur)
            )
            return positioned
        except Exception as e:
            logger.error("Could not place presenter clip (%s: %s) — rendering faceless",
                         type(e).__name__, e)
            return None

    def render(
        self,
        script: Script,
        audio_path: Path,
        video_paths: list[Path],
        image_paths: list[Path],
        word_timestamps: list[dict],
        section_timeline: list[dict],
        presenter_path: Path | None = None,
        clip_terms: dict | None = None,
    ) -> Path:
        logger.info("Starting render for: %s", self.slug)

        # The render is one call to the pipeline and half a dozen phases in
        # here. Naming each one costs a log line and lets the memory sampler
        # say which phase a spike belongs to; nothing below behaves
        # differently for having been named. See modules/resource_monitor.py.
        mark_stage("open audio")
        audio = AudioFileClip(str(audio_path))
        total_duration = audio.duration

        # Pre-initialised so `finally` can release them even if a phase below
        # raises before they exist. These composites own the open ffmpeg readers;
        # closing them and collecting frees that memory before the Short renders
        # in this SAME process, so the long video's readers never stack under it.
        all_clips: list = []
        bg = None
        final = None
        try:
            # Sections are laid end to end, in the same order and with the same
            # durations as the audio timeline they were measured from.
            sections = len(script.sections)
            for i, section in enumerate(script.sections):
                if i >= len(section_timeline):
                    break
                entry = section_timeline[i]
                sec_dur = (entry["end_ms"] - entry["start_ms"]) / 1000
                if sec_dur <= 0:
                    continue

                # Stills only get Ken Burns room during slower story sections;
                # the hook's 2s cuts stay on motion footage.
                images = image_paths if section.section_type == "story" else []
                mark_stage(f"build clip pool, section {i + 1}/{sections}")
                seg_clips = self._build_clip_pool(
                    video_paths, images, section.cut_interval, sec_dur,
                    section_keywords=section.keywords, clip_terms=clip_terms,
                )
                if seg_clips:
                    mark_stage(
                        f"concatenate section {i + 1}/{sections} "
                        f"({len(seg_clips)} clips)"
                    )
                    all_clips.append(concatenate_videoclips(seg_clips, method="compose"))

            if not all_clips:
                logger.warning("No visual clips built — using black background")
                all_clips = [ColorClip((VIDEO_WIDTH, VIDEO_HEIGHT), color=(0, 0, 0),
                                       duration=total_duration)]

            mark_stage(f"concatenate {len(all_clips)} section(s)")
            bg = concatenate_videoclips(all_clips, method="compose")
            bg = bg.set_duration(total_duration)

            mark_stage("render subtitles")
            subtitle_clips = self._build_subtitle_clips(word_timestamps)
            # Both numbers, because the gap between them is the whole point:
            # the clips are what the viewer sees, the renders are what the
            # machine pays for.
            logger.info(
                "Subtitles: %d clips from %d distinct text render(s)",
                len(subtitle_clips), len(self._text_clips),
            )

            # Optional AITuber presenter, composited into a corner beneath the
            # subtitles (so captions always stay legible on top of it). Absent by
            # default — presenter_layer is then empty and the layer stack is
            # exactly what it has always been.
            presenter_layer = []
            if presenter_path is not None:
                mark_stage("build presenter overlay")
                presenter_clip = self._build_presenter_clip(presenter_path, total_duration)
                if presenter_clip is not None:
                    presenter_layer = [presenter_clip]

            mark_stage(f"composite {len(subtitle_clips) + len(presenter_layer) + 1} layer(s)")
            final = CompositeVideoClip([bg] + presenter_layer + subtitle_clips,
                                       size=(VIDEO_WIDTH, VIDEO_HEIGHT))
            final = final.set_audio(audio).set_duration(total_duration)

            out_path = self.out_dir / "final_video.mp4"
            # Where the frames are actually pulled: every reader, every Ken
            # Burns resize and every x264 thread are live at the same time from
            # here until the file is written.
            threads = _render_threads()
            # The render's memory drivers, named in the log BEFORE the encode
            # that has been OOM-killed at exit 143 — so the next Actions run
            # says which of them was large enough to matter, rather than the
            # spike arriving unexplained. See README "Status" and
            # modules/resource_monitor.py.
            logger.info(
                "Encoding %s: %d open source reader(s), %d subtitle clip(s), "
                "%d section(s), %d x264 thread(s)",
                out_path.name, len(self._readers), len(subtitle_clips), sections, threads,
            )
            mark_stage("encode")
            final.write_videofile(
                str(out_path),
                fps=VIDEO_FPS,
                codec="libx264",
                audio_codec="aac",
                preset="fast",
                # Each x264 thread keeps its own frame buffers at 1080p. Four
                # of them is a lot to hold while a dozen decoders are also
                # resident; two (the default) encodes the same file, a little
                # slower. NIGHTSHIFT_RENDER_THREADS can drop it to 1 on a
                # memory-starved runner without a code change.
                threads=threads,
                verbose=False,
                logger=None,
            )
        finally:
            mark_stage("close readers")
            # Windows keeps the media files locked until these are released.
            for reader in self._readers.values():
                try:
                    reader.close()
                except Exception:
                    pass
            self._readers.clear()
            for clip in self._text_clips.values():
                try:
                    clip.close()
                except Exception:
                    pass
            self._text_clips.clear()
            try:
                audio.close()
            except Exception:
                pass
            # Release the composites too — they hold the concatenated readers.
            # Closing them and forcing a collection here (not at some later GC)
            # is what lets the Short render, which runs next in this same
            # process, start from a clean floor instead of stacking on the long
            # video's ffmpeg buffers. Guarded: any of these may be None if a
            # phase above raised before it was built.
            for composite in (final, bg, *all_clips):
                if composite is not None:
                    try:
                        composite.close()
                    except Exception:
                        pass
            gc.collect()

        logger.info("Video rendered: %s", out_path)
        return out_path

"""Voice to 2D video, on the command line (modules/voice_explainer.py).

    python tools/voice_to_video.py --audio narration.mp3 --look dusk --out out/explainer.mp4

An operator tool for now: it spends nothing of a customer's (no hold, no queue job, no
upload). With ``--planner model`` it makes ONE Gemini call (GEMINI_API_KEY); with
``--planner rules`` (the default) none. Transcription is the local Whisper model, in ``--language``, unless
``--words`` gives a word track (``[{"text","start_s","end_s"}]``, Whisper's
``{"word","start","end"}`` or the captions track's ``{"t","s","e"}``).

Everything a run needs is checked before the slow parts (the transcription and the planner): the recording is readable and
not longer than MAX_SECONDS, the look exists, the engine is installed, the effects are
there, and with ``--planner model`` a key is set. A failure names the fix (CLAUDE.md #6).
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from modules import voice_explainer as ve  # noqa: E402
from modules.captions import CaptionLanguageMissing  # noqa: E402

logger = logging.getLogger("voice_to_video")


def _words(args, audio: Path):
    if args.words:
        try:
            raw = json.loads(Path(args.words).read_text(encoding="utf-8"))
        except (OSError, ValueError) as e:
            raise ve.ExplainerError(f"--words {args.words} is not a readable JSON word track ({type(e).__name__})") from None
        if isinstance(raw, dict) and isinstance(raw.get("words"), list):
            raw = raw["words"]
        words = ve.normalize_words(raw) if isinstance(raw, list) else []
        if not words:
            # A malformed file is not "nothing was said": the fix is the file, not the recording.
            raise ve.ExplainerError(f"--words {args.words} holds no timed words: a list of {{text,start_s,end_s}} "
                                    "(or Whisper's {word,start,end}) is expected")
        return words
    try:
        from modules.subtitle_generator import SubtitleGenerator  # noqa: PLC0415 — loads torch + whisper
    except ImportError as e:
        raise ve.ExplainerError(f"Whisper is not installed ({e.name}): `pip install -r requirements.txt`, or pass --words") from None
    gen = SubtitleGenerator(audio.stem)
    try:
        return ve.normalize_words(gen.transcribe(audio, args.language))
    except CaptionLanguageMissing as e:
        raise ve.ExplainerError(e.message) from None
    finally:
        gen.release_model()


def _model_gen():
    if not os.environ.get("GEMINI_API_KEY"):
        raise ve.ExplainerError("--planner model needs GEMINI_API_KEY; use --planner rules for the free planner")
    try:
        from google.genai import types as genai_types  # noqa: PLC0415

        from modules.gemini_client import generate_with_retry, make_client  # noqa: PLC0415
        from modules.gemini_stages import model_for  # noqa: PLC0415
    except ImportError as e:
        raise ve.ExplainerError(f"the model planner needs {e.name}: `pip install -r requirements.txt`") from None

    client = make_client()

    def gen(prompt: str, system=None) -> str:
        config = genai_types.GenerateContentConfig(system_instruction=system, response_mime_type="application/json")
        return generate_with_retry(client, model_for("script"), prompt, config).text

    return gen


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--audio", required=True, help="the narration (mp3, wav, m4a …)")
    ap.add_argument("--out", required=True, help="the .mp4 to write")
    ap.add_argument("--look", default="dusk", choices=ve.LOOKS)
    ap.add_argument("--planner", default="rules", choices=("rules", "model"))
    ap.add_argument("--plan", help="a JSON plan (one object per sentence) to use instead of a planner")
    ap.add_argument("--words", help="a JSON word track instead of Whisper")
    ap.add_argument("--language", default="", help="the narration's language ('Uzbek' or 'uz'): required to transcribe "
                    "(it is never guessed), and given to the model planner")
    ap.add_argument("--music", help="a music bed (mp3/wav); default: none")
    ap.add_argument("--sfx-dir", default=str(ROOT / "assets" / "sfx"), help="where whoosh/deep_boom are; 'none' for no effects")
    ap.add_argument("--no-captions", action="store_true")
    ap.add_argument("--no-media-card", action="store_true", help="draw character scenes without the video-card frame")
    ap.add_argument("--width", type=int, default=1080)
    ap.add_argument("--height", type=int, default=1920)
    ap.add_argument("--fps", type=int, default=30)
    ap.add_argument("--browser", default=os.environ.get("CHRONOS_REMOTION_BROWSER", ""), help="a Chrome to render with")
    ap.add_argument("--dump-props", help="also write the render props here (JSON)")
    args = ap.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(message)s")

    try:
        audio = Path(args.audio)
        if not audio.is_file():
            raise ve.ExplainerError(f"--audio {audio} does not exist")
        if not args.words and not args.language.strip():
            # Whisper left to guess heard accented Uzbek as another language: the language is the operator's to state.
            raise ve.ExplainerError("--language is required to transcribe the recording (it is never guessed): "
                                    "pass the language it is spoken in, e.g. --language Uzbek, or pass --words")
        duration = ve.audio_seconds(audio)
        if duration > ve.MAX_SECONDS:
            raise ve.ExplainerError(f"the recording is {duration:.0f} s; the explainer takes up to {ve.MAX_SECONDS:.0f} s — cut it first")
        if args.music and not Path(args.music).is_file():
            raise ve.ExplainerError(f"--music {args.music} does not exist; leave it out for no music")
        if not (ve.ENGINE_DIR / "node_modules").exists():
            raise ve.ExplainerError(f"the Remotion engine is not installed: run `npm ci` in {ve.ENGINE_DIR}")
        if shutil.which("npx") is None:
            raise ve.ExplainerError("npx is not on PATH: install Node 22 to render")
        # A recording long enough to be rendered in chunks is joined by ffmpeg: missing, it would fail after the render.
        if duration >= 2 * ve.CHUNK_S and shutil.which("ffmpeg") is None:
            raise ve.ExplainerError(f"a recording over {2 * ve.CHUNK_S:.0f} s is rendered in chunks joined by ffmpeg: install ffmpeg")
        if not 1 <= args.fps <= 60:
            raise ve.ExplainerError(f"--fps {args.fps} is not 1 to 60")
        for name, v in (("--width", args.width), ("--height", args.height)):
            if not 16 <= v <= 4096 or v % 2:
                raise ve.ExplainerError(f"{name} {v} is not an even number from 16 to 4096")
        # Everything cheap is checked before the transcription and the (paid) planner call (CLAUDE.md rule 6).
        sfx_dir = None if args.sfx_dir == "none" else Path(args.sfx_dir)
        if sfx_dir is not None:
            ve.find_sfx(sfx_dir)
        plan_raw = None
        if args.plan:
            try:
                plan_raw = json.loads(Path(args.plan).read_text(encoding="utf-8"))
            except (OSError, ValueError) as e:
                raise ve.ExplainerError(f"--plan {args.plan} is not a readable JSON plan ({type(e).__name__})") from None
            if not isinstance(plan_raw, list):
                raise ve.ExplainerError(f"--plan {args.plan} is not a list of scenes")
        gen = _model_gen() if args.planner == "model" and plan_raw is None else None

        words = _words(args, audio)
        if not words:
            raise ve.ExplainerError("no words were heard in the recording: is it speech, and is the language one Whisper knows?")
        words = ve.fit_words(words, duration)
        sentences = ve.split_sentences(words)
        if plan_raw is not None:
            if len(plan_raw) != len(sentences):
                raise ve.ExplainerError(f"--plan has {len(plan_raw)} scenes for {len(sentences)} sentences")
            plans = [ve.validate_scene(p, index=i) for i, p in enumerate(plan_raw)]
        elif gen is not None:
            plans = ve.plan_model(sentences, gen, language=args.language)
        else:
            plans = ve.plan_rules(sentences)
        scenes = ve.build_scenes(sentences, plans, duration)
        cues, files = ve.sound_cues(scenes, sfx_dir)
        files[f"narration{audio.suffix.lower()}"] = audio
        music = ""
        if args.music:
            music = f"music{Path(args.music).suffix.lower()}"
            files[music] = Path(args.music)
        props = ve.build_props(look=args.look, duration_s=duration, words=words, scenes=scenes,
                               narration=f"narration{audio.suffix.lower()}", music=music, sfx=cues,
                               captions=not args.no_captions, media_card=not args.no_media_card, width=args.width, height=args.height, fps=args.fps)
        if args.dump_props:
            Path(args.dump_props).write_text(json.dumps(props, ensure_ascii=False, indent=2), encoding="utf-8")
        logger.info("%d words, %d scenes, %.1f s, look %s — rendering…", len(words), len(scenes), duration, args.look)
        out = ve.render(props, Path(args.out), files=files, browser=args.browser or None)
        logger.info("wrote %s", out)
        return 0
    except ve.PlanRejected as e:
        print(f"error: the plan was refused, nothing was rendered: {e}", file=sys.stderr)
        return 2
    except ve.ExplainerError as e:
        print(f"error: {e}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())

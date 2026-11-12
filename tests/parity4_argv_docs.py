"""Documents WITHOUT the parity-4 fields (``voice``, ``bleeps``, a text's ``tracking`` / ``italic`` / ``align``,
the ``single_word`` caption style) but with everything around them that they touch: sounds with ``denoise`` /
``loudnorm``, a ducked music track under speech, a clip's own sound with a gain, a cross-faded pair of sounding
clips, texts with looks, animations and fades, styled captions. The golden file samples/parity4_argv_golden.json
was made by this module against origin/main at 06be5521 (#690), before any parity-4 field existed
(``python3 -m tests.parity4_argv_docs <out.json>`` in a checkout of main), and tests/test_editor_parity4.py checks
this branch still builds exactly those commands and writes exactly those ASS files."""

import json
import sys
from pathlib import Path

B = "11111111-1111-4111-8111-111111111111"     # a video with sound
P = "22222222-2222-4222-8222-222222222222"     # a picture
M = "33333333-3333-4333-8333-333333333333"     # a music file
V = "44444444-4444-4444-8444-444444444444"     # a voice file


def _doc(clips, tracks=(), **top):
    d = {"version": 1, "width": 1280, "height": 720, "fps": 30,
         "tracks": [{"id": "v1", "kind": "V", "clips": clips}, *tracks]}
    d.update(top)
    return d


def _a(tid, clips, **opts):
    return {"id": tid, "kind": "A", "clips": clips, **opts}


def docs():
    clip = {"id": "c1", "asset_id": B, "start_s": 0, "in_s": 0, "out_s": 6}
    return {
        "sound_cleanup_and_ducking": _doc(
            [{**clip, "audio": True, "denoise": True, "gain_db": -3}],
            [_a("a1", [{"id": "m1", "asset_id": M, "start_s": 0, "in_s": 2, "out_s": 8, "gain_db": -6,
                        "fade_in_s": 0.5, "fade_out_s": 1, "loudnorm": True}],
                duck={"amount_db": 12}),
             _a("a2", [{"id": "s1", "asset_id": V, "start_s": 1, "in_s": 0, "out_s": 3, "denoise": True,
                        "loudnorm": True}], role="speech")]),
        "crossfaded_sounds": _doc(
            [{**clip, "audio": True, "loudnorm": True},
             {"id": "c2", "asset_id": B, "start_s": 5.5, "in_s": 1, "out_s": 4, "audio": True, "speed": 1.5,
              "transition": {"type": "crossfade", "duration_s": 0.5}}]),
        "detached_sound_no_audio": _doc(
            [{**clip, "audio": False}],
            [_a("a1", [{"id": "d1", "asset_id": B, "start_s": 0, "in_s": 0, "out_s": 6, "denoise": True}])]),
        "texts_and_styled_captions": _doc(
            [clip],
            [{"id": "t1", "kind": "T", "clips": [
                {"id": "x1", "start_s": 0, "end_s": 3, "text": "Title\nsecond line", "size": 64, "bold": True,
                 "anchor": "center", "x": 0.5, "y": 0.4, "shadow": 4, "fade_in_s": 0.3},
                {"id": "x2", "start_s": 3, "end_s": 6, "text": "Boxed", "box_color": "#112233", "anim_in": "pop",
                 "anim_out": "slide-up", "font": "DejaVu Serif"}]},
             {"id": "t2", "kind": "T", "clips": [
                {"id": "x3", "start_s": 1, "end_s": 5, "text": "Typed out", "anim_in": "typewriter",
                 "anchor": "bottom-left", "x": 0.05, "y": 0.95}]}],
            captions={"style": {"preset": "karaoke"},
                      "cues": [{"id": "k1", "start_s": 0.5, "end_s": 2.5, "text": "Hello big wide world"},
                               {"id": "k2", "start_s": 2.5, "end_s": 4, "text": "one more"}]}),
        "plain_captions": _doc([clip], captions={"cues": [{"id": "k1", "start_s": 0, "end_s": 2, "text": "Hi"}]}),
    }


def new_docs():
    """Documents WITH the parity-4 fields: their commands are pinned in samples/parity4_new_argv_golden.json, written
    by this branch (``python3 -m tests.parity4_argv_docs --new <out.json>``), so a change to the clean-voice chain,
    the bleep graph or the burn filter's force_style is seen in review."""
    clip = {"id": "c1", "asset_id": B, "start_s": 0, "in_s": 0, "out_s": 6}
    speech = _a("a2", [{"id": "s1", "asset_id": V, "start_s": 1, "in_s": 0, "out_s": 3, "voice": "clean"}], role="speech")
    return {
        "voice_on_sound_and_own_sound_under_ducking": _doc(
            [{**clip, "audio": True, "voice": "clean", "gain_db": -3}],
            [_a("a1", [{"id": "m1", "asset_id": M, "start_s": 0, "in_s": 2, "out_s": 8, "gain_db": -6,
                        "fade_out_s": 1}], duck={"amount_db": 12}), speech]),
        "bleeps_mute_and_tone": _doc(
            [{**clip, "audio": True}],
            bleeps=[{"start_s": 1.004, "end_s": 1.5, "mode": "mute"}, {"start_s": 1.5, "end_s": 2.0, "mode": "tone"},
                    {"start_s": 5.9, "end_s": 7.0, "mode": "mute"}]),
        "bleeps_mute_only": _doc([{**clip, "audio": True}], bleeps=[{"start_s": 2, "end_s": 2.25, "mode": "mute"}]),
        "bleep_tone_with_no_sound": _doc([clip], bleeps=[{"start_s": 2, "end_s": 2.25, "mode": "tone"}]),
        "bleep_past_the_end": _doc([{**clip, "audio": True}], bleeps=[{"start_s": 6.5, "end_s": 7, "mode": "tone"}]),
        "text_properties": _doc(
            [clip],
            [{"id": "t1", "kind": "T", "clips": [
                {"id": "x1", "start_s": 0, "end_s": 3, "text": "Left lines\nof text", "tracking": 120, "italic": True,
                 "align": "left"}]},
             {"id": "t2", "kind": "T", "clips": [
                {"id": "x2", "start_s": 0, "end_s": 3, "text": "Plain", "y": 0.8}]},
             {"id": "t3", "kind": "T", "clips": [
                {"id": "x3", "start_s": 1, "end_s": 4, "text": "Right\nside", "align": "right", "tracking": -40,
                 "anim_in": "pop"}]}],
            captions={"style": {"preset": "single_word"},
                      "cues": [{"id": "k1", "start_s": 0.5, "end_s": 2.5, "text": "Hello big wide world"}]}),
    }


def _res(a):
    from modules import timeline as tl
    return {B: tl.ResolvedAsset(a, "video", "/m/a.mp4", 60.0, True),
            P: tl.ResolvedAsset(a, "image", "/m/p.png", None, False),
            M: tl.ResolvedAsset(a, "audio", "/m/music.mp3", 60.0, None),
            V: tl.ResolvedAsset(a, "audio", "/m/voice.wav", 60.0, None)}.get(a)


def argv(doc):
    """Every command the export runs for ``doc`` (segments, then the final pass) and the ASS file of its texts."""
    from modules import ass_captions
    from modules import render_backend as rb
    from modules import render_spec as rs
    from modules import timeline_render as tr
    spec = tr.to_render_spec(doc, _res, "/w/out.mp4")
    out = []
    for i, seg in enumerate(spec.segments):
        out.extend(rb.segment_commands("ffmpeg", seg, Path(f"/w/s{i}.mp4"), spec.width, spec.height, spec.fps,
                                       seed=f"s{i}", x264=rb.INTERMEDIATE_X264, frame_exact=True))
    out.append(list(rs.build_ffmpeg_command(spec, "/w/concat.txt", "/w/overlays.ass")))
    ass = (ass_captions.build_overlay_ass(spec.overlays, width=spec.width, height=spec.height)
           if spec.overlays else "")
    return {"argv": out, "ass": ass}


if __name__ == "__main__":
    sys.path.insert(0, str(Path.cwd()))
    which, out = (new_docs, sys.argv[2]) if sys.argv[1] == "--new" else (docs, sys.argv[1])
    Path(out).write_text(json.dumps({k: argv(d) for k, d in which().items()}, indent=1) + "\n")

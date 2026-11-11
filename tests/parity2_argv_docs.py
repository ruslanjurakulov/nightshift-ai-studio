"""Documents WITHOUT the parity-2 fields (colour, mask), and the argv the backend builds for them: the
golden file samples/parity2_argv_golden.json was made by this module against origin/main before colour
and masks existed (``python3 -m tests.parity2_argv_docs <out.json>`` run in a checkout of main), and
tests/test_editor_parity2.py checks this branch still builds exactly those commands."""

import json
import sys
from pathlib import Path

B = "11111111-1111-4111-8111-111111111111"
P = "22222222-2222-4222-8222-222222222222"


def _doc(clips, **top):
    d = {"version": 1, "width": 1280, "height": 720, "fps": 30, "tracks": [{"id": "v1", "kind": "V", "clips": clips}]}
    d.update(top)
    return d


def docs():
    return {
        "plain": _doc([{"id": "c1", "asset_id": B, "start_s": 0, "in_s": 1, "out_s": 4}]),
        "effects": _doc([{"id": "c1", "asset_id": B, "start_s": 0, "in_s": 0, "out_s": 3, "filter": "vintage",
                          "filter_strength": 0.5, "vignette": 0.4, "blur": 3, "sharpen": 0.2, "grain": 0.3,
                          "rotate": 90, "flip_h": True, "grade": {"brightness": 0.1, "contrast": 1.2, "saturation": 0.8},
                          "fade_in_s": 0.5, "fade_out_s": 0.5}]),
        "crossfade": _doc([{"id": "c1", "asset_id": B, "start_s": 0, "in_s": 0, "out_s": 3, "fit": "blur"},
                           {"id": "c2", "asset_id": P, "start_s": 2.5, "in_s": 0, "out_s": 3,
                            "transition": {"type": "crossfade", "duration_s": 0.5, "style": "wipeleft"},
                            "move": {"from": {"zoom": 1}, "to": {"zoom": 1.5, "x": 0.3}}}]),
        "speed_reverse_crop": _doc([{"id": "c1", "asset_id": B, "start_s": 0, "in_s": 0, "out_s": 2, "speed": 2,
                                     "crop": {"x": 0.1, "w": 0.5}, "angle": 10},
                                    {"id": "c2", "asset_id": B, "start_s": 1, "in_s": 0, "out_s": 2, "reverse": True},
                                    {"id": "c3", "asset_id": P, "start_s": 3, "in_s": 0, "out_s": 2}]),
        "overlay_shapes": _doc([{"id": "c1", "asset_id": B, "start_s": 0, "in_s": 0, "out_s": 3, "audio": True}],
                               overlays=[{"id": "o1", "asset_id": P, "start_s": 0, "end_s": 2}],
                               shapes=[{"id": "s1", "kind": "circle", "start_s": 0, "end_s": 2}]),
    }


def argv(doc):
    from modules import render_backend as rb
    from modules import timeline as tl
    from modules import timeline_render as tr
    res = lambda a: (tl.ResolvedAsset(a, "video", "/m/a.mp4", 60.0, True) if a == B
                     else tl.ResolvedAsset(a, "image", "/m/p.png", None, False))
    spec = tr.to_render_spec(doc, res, "/w/out.mp4")
    out = []
    for i, seg in enumerate(spec.segments):
        out.extend(rb.segment_commands("ffmpeg", seg, Path(f"/w/s{i}.mp4"), spec.width, spec.height, spec.fps,
                                       seed=f"s{i}", x264=rb.INTERMEDIATE_X264, frame_exact=True))
    out.append(list(__import__("modules.render_spec", fromlist=["x"]).build_ffmpeg_command(
        spec, "/w/concat.txt", "/w/overlays.ass")))
    return out


if __name__ == "__main__":
    sys.path.insert(0, str(Path.cwd()))
    Path(sys.argv[1]).write_text(json.dumps({k: argv(d) for k, d in docs().items()}, indent=1) + "\n")

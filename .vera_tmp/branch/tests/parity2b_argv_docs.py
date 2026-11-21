"""Documents WITHOUT the parity-2b fields (``fx``, a clip's ``anim_in`` / ``anim_out``) but with everything up to
2a (colour, masks, a cross-fade, a still, a move, fades), and the argv the backend builds for them: the golden file
samples/parity2b_argv_golden.json was made by this module against origin/main at 94cc4acf (#675), before the
effects pack and clip animations existed (``python3 -m tests.parity2b_argv_docs <out.json>`` in a checkout of
main), and tests/test_editor_parity2b.py checks this branch still builds exactly those commands. The older
golden (samples/parity2_argv_golden.json, documents without colour or masks) is checked by test_editor_parity2."""

import json
import sys
from pathlib import Path

from tests.parity2_argv_docs import B, P, _doc, argv


def docs():
    return {
        "colour_mask_fades": _doc([{"id": "c1", "asset_id": B, "start_s": 0, "in_s": 0, "out_s": 3, "fade_in_s": 0.4,
                                    "fade_out_s": 0.6, "color": {"temperature": 30, "hue": 20, "curve": "matte"},
                                    "mask": {"shape": "rounded", "feather": 0.2}}]),
        "masked_crossfade_still_move": _doc([
            {"id": "c1", "asset_id": B, "start_s": 0, "in_s": 0, "out_s": 3, "mask": {"shape": "ellipse"}},
            {"id": "c2", "asset_id": P, "start_s": 2.5, "in_s": 0, "out_s": 3, "mask": {"shape": "rect", "invert": True},
             "transition": {"type": "crossfade", "duration_s": 0.5}, "move": {"from": {"zoom": 1}, "to": {"zoom": 1.5}},
             "fade_out_s": 0.5}]),
        "effects_speed_text": _doc([{"id": "c1", "asset_id": B, "start_s": 0, "in_s": 0, "out_s": 4, "speed": 2,
                                     "filter": "warm", "vignette": 0.3, "color": {"tint": -10}},
                                    {"id": "c2", "asset_id": B, "start_s": 2, "in_s": 1, "out_s": 3, "fit": "blur"}]),
    }


if __name__ == "__main__":
    sys.path.insert(0, str(Path.cwd()))
    Path(sys.argv[1]).write_text(json.dumps({k: argv(d) for k, d in docs().items()}, indent=1) + "\n")

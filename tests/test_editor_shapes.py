"""Stickers, shapes and the progress bar (``shapes`` in the timeline document), end to end.

A shape is a document entry, not a library file: ``{id, kind, start_s, end_s, color?, opacity?,
x?, y?, w?, ...}`` with ``kind`` from a closed set (arrow, circle, rect, star, pill, line,
progress). The export draws each into a PNG (``modules/shape_art.py``, Pillow) and lays it with
the picture-overlay path, so position, size, opacity, entrance / exit and move behave as they do
for a picture; the progress bar is a frame-wide bar slid in from the left by the clock.

What is pinned here, by class:

* the document: every kind, every range at both ends and beyond, fields that do not apply to a
  kind, the text rules, the layer caps, normalisation, the JSON schema and the constants the
  three languages share (the TypeScript twin is read from source);
* the spec and the argv: shapes ride after the picture overlays, a document WITHOUT shapes (or an
  empty list, an invisible shape, one after the end) renders the same commands as before, the
  filter strings are pinned (these never skip), no document text reaches a graph;
* the art: sizes, even sides, pixels of every kind, deterministic bytes, a missing font is
  refused (never a bitmap fallback);
* the PIXELS, with real ffmpeg (skipped cleanly where none runs): every kind appears where the
  document puts it in the colour it names, the progress bar grows by the clock from empty to full,
  opacity, entrance and move are measured.

Preview vs export: the browser preview draws the same polygons as SVG (tests in
command-center/tests/editor-shapes*.test.ts); a pill's width is estimated there.
"""

import json
import re
import subprocess
import tempfile
import unittest
from pathlib import Path

from modules import render_backend
from modules import render_spec as rs
from modules import shape_art as sa
from modules import timeline as tl
from modules import timeline_render as tr

ROOT = Path(__file__).resolve().parent.parent
SHAPES_TS = ROOT / "command-center" / "lib" / "editorShapes.ts"
EDITOR_TS = ROOT / "command-center" / "lib" / "editor.ts"
FIXTURE = ROOT / "samples" / "shape_layout.json"

BASE = "11111111-1111-4111-8111-111111111111"
PIC = "33333333-3333-4333-8333-333333333333"


def doc_with(shapes=None, width=1280, height=720, fps=30, out_s=4, overlays=None, **top):
    doc = {"version": 1, "width": width, "height": height, "fps": fps, "tracks": [
        {"id": "v1", "kind": "V", "clips": [
            {"id": "c1", "asset_id": BASE, "start_s": 0, "in_s": 0, "out_s": out_s}]}]}
    if overlays is not None:
        doc["overlays"] = overlays
    if shapes is not None:
        doc["shapes"] = shapes
    doc.update(top)
    return doc


def sh(**kw):
    s = {"id": "s1", "kind": "arrow", "start_s": 1, "end_s": 3}
    s.update(kw)
    return s


def problems(doc):
    return tl.validate(doc)


#: One valid example per kind (every field the kind takes).
EXAMPLES = {
    "arrow": sh(kind="arrow", dir="up", x=0.2, y=0.3, w=0.2, color="#FF3B30"),
    "circle": sh(kind="circle", outline=0.1, x=0.4, y=0.4, w=0.2),
    "rect": sh(kind="rect", outline=0.05, aspect=2.0, w=0.3),
    "star": sh(kind="star", outline=0.08, w=0.2),
    "pill": sh(kind="pill", text="Subscribe", outline=0.1, w=0.3, y=0.8),
    "line": sh(kind="line", thick=0.01, w=0.5, y=0.9),
    "progress": sh(kind="progress", edge="top", thick=0.02, start_s=0, end_s=4),
}


class DocumentTestCase(unittest.TestCase):
    def test_every_kind_has_a_valid_example_and_the_set_is_the_documented_one(self):
        self.assertEqual(set(EXAMPLES), set(sa.SHAPE_KINDS))
        self.assertEqual(sa.SHAPE_KINDS, ("arrow", "circle", "rect", "star", "pill", "line", "progress"))
        for kind, ex in EXAMPLES.items():
            with self.subTest(kind):
                self.assertEqual(problems(doc_with([ex])), [])

    def test_a_field_that_does_not_apply_to_a_kind_is_refused_for_every_kind(self):
        every = {"x": 0.5, "y": 0.5, "w": 0.3, "dir": "up", "outline": 0.1, "aspect": 2.0,
                 "thick": 0.01, "text": "hi", "edge": "top", "move": {"to": {"x": 0.6}}}
        for kind in sa.SHAPE_KINDS:
            for field, value in every.items():
                with self.subTest(kind=kind, field=field):
                    s = {"id": "s1", "kind": kind, "start_s": 1, "end_s": 3, field: value}
                    if kind == "pill":
                        s.setdefault("text", "hi")
                    got = [p for p in problems(doc_with([s])) if field in p and "does not apply" in p]
                    self.assertEqual(bool(got), field not in sa.KIND_FIELDS[kind], got)

    def test_every_number_outside_its_range_is_refused_naming_the_field(self):
        bad = [("x", -0.01), ("x", 1.01), ("y", -0.01), ("y", 1.01), ("w", 0.04), ("w", 1.01),
               ("opacity", -0.01), ("opacity", 1.01)]
        for key, v in bad:
            with self.subTest(key=key, v=v):
                got = problems(doc_with([sh(**{key: v})]))
                self.assertTrue(any(f"{key} must be a number" in p for p in got), got)
        for kind, key, v in (("circle", "outline", 0.51), ("circle", "outline", -0.01),
                             ("rect", "aspect", 0.19), ("rect", "aspect", 5.01),
                             ("line", "thick", 0.0019), ("progress", "thick", 0.051)):
            with self.subTest(kind=kind, key=key, v=v):
                got = problems(doc_with([sh(kind=kind, **{key: v})]))
                self.assertTrue(any(f"{key} must be a number" in p for p in got), got)

    def test_the_ends_of_every_range_are_valid(self):
        for key, v in (("x", 0), ("x", 1), ("y", 0), ("y", 1), ("w", 0.05), ("w", 1), ("opacity", 0), ("opacity", 1)):
            with self.subTest(key=key, v=v):
                self.assertEqual(problems(doc_with([sh(**{key: v})])), [])
        for kind, key, v in (("circle", "outline", 0), ("circle", "outline", 0.5), ("rect", "aspect", 0.2),
                             ("rect", "aspect", 5), ("line", "thick", 0.002), ("progress", "thick", 0.05)):
            with self.subTest(kind=kind, key=key, v=v):
                self.assertEqual(problems(doc_with([sh(kind=kind, **{key: v})])), [])

    def test_not_a_number_is_refused_in_every_numeric_field(self):
        for key in ("x", "y", "w", "opacity", "start_s", "end_s"):
            for v in ("0.5", None, True, [0.5], float("nan")):
                with self.subTest(key=key, v=v):
                    self.assertTrue(problems(doc_with([sh(**{key: v})])))
        for v in ("0.7;movie=/etc/passwd", "0.1,eq", "a'b"):
            self.assertTrue(problems(doc_with([sh(x=v)])))
            with self.assertRaises(tl.TimelineError):
                tr.to_render_spec(doc_with([sh(x=v)]), lambda a: tl.ResolvedAsset(a, "video", "/m/b.mp4", 9.0), "/o.mp4")

    def test_the_enums_are_closed(self):
        for kind, key, v in (("arrow", "dir", "diagonal"), ("arrow", "dir", "UP"), ("arrow", "dir", "up\n"),
                             ("progress", "edge", "left"), ("progress", "edge", "Top")):
            with self.subTest(key=key, v=v):
                got = problems(doc_with([sh(kind=kind, **{key: v})]))
                self.assertTrue(any(f"{key} must be one of" in p for p in got), got)
        for v in ("triangle", "Arrow", "arrow\n", 3, None, ["arrow"], ""):
            with self.subTest(kind=v):
                self.assertTrue(any("kind must be one of" in p for p in problems(doc_with([sh(kind=v)]))))

    def test_the_colour_is_the_shared_hex_pattern(self):
        for v in ("#FF3B30", "#ff3b30", "#000000"):
            self.assertEqual(problems(doc_with([sh(color=v)])), [], v)
        for v in ("red", "#fff", "FF3B30", "#FF3B30\n", "#GG0000", 255, None, "#FF3B30 "):
            with self.subTest(v=v):
                self.assertTrue(any("color must be a #RRGGBB colour" in p for p in problems(doc_with([sh(color=v)]))))

    def test_the_label_text_rules(self):
        def pill(text):
            return doc_with([sh(kind="pill", text=text)])
        for ok in ("New", "abcdefghijklmnopqrstuvwx", "\U0001F600" * 24, "Obuna boʻling",
                   "Подписаться", "{braces} and \\ slash"):
            with self.subTest(ok=ok):
                self.assertEqual(problems(pill(ok)), [])
        for bad in ("", "   ", "abcdefghijklmnopqrstuvwxy", "\U0001F600" * 25, "two\nlines", "tab\there",
                    "a\u0007b", "a‍b", "a b", "a b", "lone\ud800surrogate", 5, None, ["x"]):
            with self.subTest(bad=bad):
                self.assertTrue(any("text" in p for p in problems(pill(bad))), bad)
        got = problems(doc_with([sh(kind="pill")]))
        self.assertTrue(any("text is missing" in p for p in got), got)

    def test_the_progress_bar_takes_only_its_own_fields_and_a_fade(self):
        self.assertEqual(problems(doc_with([sh(kind="progress", anim_in="fade", anim_out="fade")])), [])
        for key in ("anim_in", "anim_out"):
            for v in ("slide-up", "pop", "slide-left"):
                with self.subTest(key=key, v=v):
                    got = problems(doc_with([sh(kind="progress", **{key: v})]))
                    self.assertTrue(any("takes only" in p for p in got), got)
        for field in ("x", "y", "w"):
            got = problems(doc_with([sh(kind="progress", **{field: 0.5})]))
            self.assertTrue(any("does not apply" in p for p in got), got)
        self.assertTrue(problems(doc_with([sh(kind="progress", move={"to": {"x": 0.5}})])))

    def test_a_typewriter_is_for_text_only_and_animations_must_fit(self):
        self.assertTrue(problems(doc_with([sh(anim_in="typewriter")])))
        self.assertTrue(problems(doc_with([sh(anim_in_s=0.5)])), "a duration needs its animation")
        self.assertTrue(problems(doc_with([sh(anim_in="fade", anim_in_s=1.5, anim_out="fade", anim_out_s=1)])))
        self.assertEqual(problems(doc_with([sh(anim_in="pop", anim_in_s=1, anim_out="slide-down", anim_out_s=1)])), [])

    def test_a_move_changes_position_and_size_but_never_opacity(self):
        self.assertEqual(problems(doc_with([sh(move={"to": {"x": 0.9, "y": 0.1, "w": 0.5}})])), [])
        for move in ({"to": {"opacity": 0.5}}, {"to": {}}, {"to": {"x": 1.1}}, {"to": {"w": 0.01}}, {},
                     3, {"to": {"x": 0.5}, "from": {"x": 0.1}}, {"to": 3}):
            with self.subTest(move=move):
                self.assertTrue(problems(doc_with([sh(move=move)])), move)

    def test_shapes_leave_the_partial_opacity_budget_to_the_pictures(self):
        """The per-pixel opacity move (geq) is the render engine's slow path: only overlays can take
        it, and twelve moving shapes beside two such overlays stay valid because shapes cannot."""
        moving = [{"id": f"o{i}", "asset_id": PIC, "start_s": 0, "end_s": 2, "opacity": 1.0,
                   "move": {"to": {"opacity": 0.5}}} for i in range(tl.MAX_PARTIAL_OPACITY_MOVES)]
        shapes = [sh(id=f"s{i}", move={"to": {"x": 0.9}}) for i in range(12)]
        self.assertEqual(problems(doc_with(shapes, overlays=moving)), [])
        too_many = moving + [dict(moving[0], id="o9")]
        self.assertTrue(any("may change opacity" in p for p in problems(doc_with(shapes[:1], overlays=too_many))))

    def test_the_caps_shapes_alone_and_layers_together(self):
        self.assertEqual(problems(doc_with([sh(id=f"s{i}") for i in range(sa.MAX_SHAPES)])), [])
        self.assertIn(f"shapes: at most {sa.MAX_SHAPES}",
                      problems(doc_with([sh(id=f"s{i}") for i in range(sa.MAX_SHAPES + 1)])))
        pics = lambda n: [{"id": f"o{i}", "asset_id": PIC, "start_s": 0, "end_s": 2} for i in range(n)]
        self.assertEqual(problems(doc_with([sh(id=f"s{i}") for i in range(12)], overlays=pics(4))), [])
        got = problems(doc_with([sh(id=f"s{i}") for i in range(12)], overlays=pics(5)))
        self.assertTrue(any("overlays and shapes together: at most 16" in p for p in got), got)
        self.assertEqual(sa.MAX_LAYERS, tl.MAX_OVERLAYS, "the layers are the final pass's inputs")
        self.assertEqual(sa.MAX_LAYERS, rs.MAX_PICTURE_OVERLAYS)

    def test_a_frame_above_1440p_takes_fewer_layers_once_it_has_a_shape(self):
        """Measured on the bundled ffmpeg 7.0.2 under the export's 2 GiB: at 3840x2160 and 60 fps six
        layers ran out of memory whatever their size (five passed); a frame up to 1440p passed twelve.
        The guard is only asked of a document that has shapes, so no older document changes."""
        self.assertEqual(sa.LARGE_FRAME_LAYERS_MAX, 5)
        pics = lambda n: [{"id": f"o{i}", "asset_id": PIC, "start_s": 0, "end_s": 2} for i in range(n)]
        shapes = lambda n: [sh(id=f"s{i}") for i in range(n)]
        for w, h in ((3840, 2160), (2160, 3840), (3000, 2000)):
            with self.subTest(frame=(w, h)):
                self.assertEqual(problems(doc_with(shapes(3), overlays=pics(2), width=w, height=h)), [])
                got = problems(doc_with(shapes(3), overlays=pics(3), width=w, height=h))
                self.assertTrue(any("at most 5 in a frame above 1440p (got 6)" in p for p in got), got)
        self.assertEqual(problems(doc_with(shapes(12), overlays=pics(4), width=2560, height=1440)), [],
                         "1440p itself is not above 1440p")
        self.assertEqual(problems(doc_with(None, overlays=pics(8), width=3840, height=2160)), [],
                         "no shapes: the picture overlays are as they were")
        self.assertEqual(problems(doc_with([], overlays=pics(8), width=3840, height=2160)), [])
        self.assertEqual(tl.LARGE_FRAME_PX, 2560 * 1440)

    def test_the_shape_is_strict(self):
        for extra in ({"path": "/etc/passwd"}, {"asset_id": PIC}, {"chroma": {"color": "#00FF00"}},
                      {"rotation": 90}, {"font": "DejaVu Sans"}):
            with self.subTest(extra=extra):
                self.assertTrue(problems(doc_with([sh(**extra)])))
        self.assertTrue(problems(doc_with(["x"])))
        self.assertTrue(problems(doc_with("x")))
        self.assertTrue(problems(doc_with() | {"shapes": None}))
        self.assertTrue(problems(doc_with([{"id": "s1", "start_s": 1, "end_s": 3}])), "kind is required")

    def test_ids_share_the_documents_namespace(self):
        self.assertTrue(any("already used" in p for p in problems(doc_with([sh(id="c1")]))))
        self.assertTrue(any("already used" in p for p in problems(doc_with([sh(), sh()]))))
        self.assertTrue(any("already used" in p for p in problems(
            doc_with([sh(id="o1")], overlays=[{"id": "o1", "asset_id": PIC, "start_s": 0, "end_s": 2}]))))
        self.assertTrue(problems(doc_with([sh(id="a b")])))

    def test_the_span_must_be_at_least_one_frame(self):
        self.assertTrue(any("greater than start_s" in p for p in problems(doc_with([sh(start_s=2, end_s=2)]))))
        self.assertTrue(any("shorter than one frame" in p for p in problems(doc_with([sh(start_s=1, end_s=1.01)]))))
        self.assertEqual(problems(doc_with([sh(start_s=1, end_s=1.034)])), [])

    def test_shapes_do_not_lengthen_the_timeline(self):
        doc = doc_with([sh(start_s=3, end_s=9)])
        self.assertEqual(tl.duration_s(tl.load(doc)), 4)

    def test_normalise_fills_the_kinds_defaults_rounds_and_drops_an_empty_list(self):
        norm = tl.load(doc_with([sh(color="#ff3b30")]))["shapes"][0]
        self.assertEqual(norm, {"id": "s1", "kind": "arrow", "start_s": 1, "end_s": 3, "color": "#FF3B30",
                                "opacity": 1.0, "x": 0.5, "y": 0.5, "w": 0.3, "dir": "right"})
        rect = tl.load(doc_with([sh(kind="rect", outline=0)]))["shapes"][0]
        self.assertEqual(rect["aspect"], 1.6)
        self.assertNotIn("outline", rect, "solid is the absence of a stroke")
        bar = tl.load(doc_with([sh(kind="progress")]))["shapes"][0]
        self.assertEqual((bar["edge"], bar["thick"]), ("bottom", 0.012))
        self.assertNotIn("x", bar)
        line = tl.load(doc_with([sh(kind="line", thick=0.0123456)]))["shapes"][0]
        self.assertEqual(line["thick"], 0.0123)
        anim = tl.load(doc_with([sh(anim_in="fade")]))["shapes"][0]
        self.assertEqual(anim["anim_in_s"], 0.4)
        move = tl.load(doc_with([sh(move={"to": {"x": 0.123456}})]))["shapes"][0]
        self.assertEqual(move["move"], {"to": {"x": 0.123}})
        self.assertNotIn("shapes", tl.load(doc_with([])), "an empty list is the document without the field")
        order = tl.load(doc_with([sh(id="b"), sh(id="a", kind="star")]))["shapes"]
        self.assertEqual([s["id"] for s in order], ["b", "a"], "list order is the layering")

    def test_a_split_leaves_the_shapes_alone_and_asset_ids_do_not_include_them(self):
        doc = doc_with([sh()])
        self.assertEqual(tl.split_clip(doc, "c1", 2.0, "c2")["shapes"], doc["shapes"])
        self.assertEqual(tl.asset_ids(doc), [BASE])

    def test_a_shape_never_carries_an_asset_id(self):
        """The database function checks asset_id at any depth; a shape has none, so it passes
        without a migration, and no field of a shape may ever be named asset_id."""
        self.assertNotIn("asset_id", tl._SHAPE_KEYS)

    def test_the_json_schema_names_the_same_fields_enums_and_ranges(self):
        schema = json.loads(tl.SCHEMA_PATH.read_text(encoding="utf-8"))
        self.assertEqual(schema["properties"]["shapes"]["maxItems"], sa.MAX_SHAPES)
        item = schema["$defs"]["shape"]
        props = item["properties"]
        self.assertEqual(set(props), set(tl._SHAPE_KEYS))
        self.assertEqual(tuple(item["required"]), tl._SHAPE_REQUIRED)
        self.assertFalse(item["additionalProperties"])
        self.assertEqual(props["kind"]["enum"], list(sa.SHAPE_KINDS))
        self.assertEqual(props["dir"]["enum"], list(sa.ARROW_DIRS))
        self.assertEqual(props["edge"]["enum"], list(sa.PROGRESS_EDGES))
        self.assertEqual(props["color"]["pattern"], tl._HEX_RE.pattern)
        self.assertEqual((props["text"]["minLength"], props["text"]["maxLength"]), (1, sa.TEXT_MAX))
        for key, lo, hi in (("x", 0, 1), ("y", 0, 1), ("opacity", 0, 1), ("w", sa.W_MIN, sa.W_MAX),
                            ("outline", 0, sa.OUTLINE_MAX), ("aspect", sa.ASPECT_MIN, sa.ASPECT_MAX),
                            ("thick", sa.THICK_MIN, sa.THICK_MAX)):
            self.assertEqual((props[key]["minimum"], props[key]["maximum"]), (lo, hi), key)
        self.assertEqual(props["color"]["default"], sa.COLOR_DEFAULT)
        self.assertEqual(props["move"]["properties"]["to"]["properties"].keys(), {"x", "y", "w"})
        self.assertEqual(props["anim_out"]["enum"], schema["$defs"]["overlay"]["properties"]["anim_out"]["enum"])

    def test_every_kind_field_is_a_documented_key_and_the_common_ones_are_the_anim_fields(self):
        for kind, fields in sa.KIND_FIELDS.items():
            self.assertTrue(set(fields) <= set(tl._SHAPE_KEYS), kind)
        self.assertEqual(set(tl._SHAPE_COMMON), {"id", "kind", "start_s", "end_s", "color", "opacity",
                                                 "anim_in", "anim_out", "anim_in_s", "anim_out_s"})

    def test_the_typescript_twin_has_the_same_lists_and_numbers(self):
        ts = SHAPES_TS.read_text(encoding="utf-8")

        def tup(name):
            body = re.search(rf"export const {name} = \[(.*?)\] as const;", ts, re.S).group(1)
            return tuple(re.findall(r'"([^"]+)"', body))
        self.assertEqual(tup("SHAPE_KINDS"), sa.SHAPE_KINDS)
        self.assertEqual(tup("ARROW_DIRS"), sa.ARROW_DIRS)
        self.assertEqual(tup("PROGRESS_EDGES"), sa.PROGRESS_EDGES)
        self.assertEqual(tup("PROGRESS_ANIMS"), sa.PROGRESS_ANIMS)
        nums = {m[0]: float(m[1]) for m in re.findall(r"export const (\w+) = (-?[\d.]+);", ts)}
        self.assertEqual({k: nums[k] for k in ("MAX_SHAPES", "SHAPE_TEXT_MAX", "SHAPE_OUTLINE_MAX", "THICK_MIN",
                                               "THICK_MAX", "ASPECT_MIN", "ASPECT_MAX", "ASPECT_DEFAULT",
                                               "SHAPE_W_MIN", "SHAPE_W_MAX", "SHAPE_W_DEFAULT")},
                         {"MAX_SHAPES": sa.MAX_SHAPES, "SHAPE_TEXT_MAX": sa.TEXT_MAX,
                          "SHAPE_OUTLINE_MAX": sa.OUTLINE_MAX, "THICK_MIN": sa.THICK_MIN,
                          "THICK_MAX": sa.THICK_MAX, "ASPECT_MIN": sa.ASPECT_MIN, "ASPECT_MAX": sa.ASPECT_MAX,
                          "ASPECT_DEFAULT": sa.ASPECT_DEFAULT, "SHAPE_W_MIN": sa.W_MIN,
                          "SHAPE_W_MAX": sa.W_MAX, "SHAPE_W_DEFAULT": sa.W_DEFAULT})
        self.assertIn(f'export const SHAPE_COLOR_DEFAULT = "{sa.COLOR_DEFAULT}";', ts)
        self.assertIn(f"export const LARGE_FRAME_LAYERS_MAX = {sa.LARGE_FRAME_LAYERS_MAX};", ts)
        self.assertIn(f'THICK_DEFAULTS = {{ line: {sa.THICK_DEFAULTS["line"]}, progress: {sa.THICK_DEFAULTS["progress"]} }}', ts)
        for kind, fields in sa.KIND_FIELDS.items():
            m = re.search(rf"\b{kind}: \[([^\]]*)\]", ts[ts.index("export const KIND_FIELDS"):])
            self.assertEqual(tuple(re.findall(r'"(\w+)"', m.group(1))), fields, kind)
        for const, value in (("PILL_PAD_X_EM", sa.PILL_PAD_X_EM), ("PILL_HEIGHT_EM", sa.PILL_HEIGHT_EM),
                             ("STAR_INNER", sa.STAR_INNER), ("ARROW_SHAFT", sa.ARROW_SHAFT),
                             ("ARROW_HEAD_AT", sa.ARROW_HEAD_AT)):
            self.assertAlmostEqual(float(re.search(rf"const {const} = ([\d.]+);", ts).group(1)), value, 5, const)
        editor = EDITOR_TS.read_text(encoding="utf-8")
        self.assertEqual(float(re.search(r"export const MAX_OVERLAYS = (\d+);", editor).group(1)), sa.MAX_LAYERS)

    def test_the_layout_fixture_is_what_the_python_geometry_computes(self):
        cases = json.loads(FIXTURE.read_text(encoding="utf-8"))["cases"]
        self.assertGreater(len(cases), 20)
        for c in cases:
            art = sa.ShapeArt.from_dict(c["shape"])
            with self.subTest(c["name"]):
                self.assertEqual(list(sa.png_size(art, c["w"], c["frame"][0], c["frame"][1])), c["px"])


# ── the spec ────────────────────────────────────────────────────────────────

def table():
    return {BASE: tl.ResolvedAsset(BASE, "video", "/media/base.mp4", 20.0, False),
            PIC: tl.ResolvedAsset(PIC, "image", "/media/pic.png", None)}


def spec_of(doc):
    return tr.to_render_spec(doc, table().get, "/out/x.mp4")


class SpecTestCase(unittest.TestCase):
    def test_shapes_become_picture_overlays_after_the_pictures_with_a_drawn_shape(self):
        spec = spec_of(doc_with([sh(kind="circle", outline=0.1, x=0.25, y=0.75, w=0.2, opacity=0.5, color="#0a84ff")],
                                overlays=[{"id": "o1", "asset_id": PIC, "start_s": 0, "end_s": 2}]))
        pic, shape = spec.picture_overlays
        self.assertEqual(pic.path, "/media/pic.png")
        self.assertIsNone(pic.shape)
        self.assertEqual((shape.path, shape.kind, shape.shape.kind, shape.shape.color, shape.shape.outline),
                         ("", "image", "circle", "#0A84FF", 0.1))
        self.assertEqual((shape.x, shape.y, shape.w, shape.opacity, shape.start_s, shape.end_s),
                         (0.25, 0.75, 0.2, 0.5, 1.0, 3.0))
        self.assertEqual(rs.validate(spec), [])

    def test_the_bar_is_frame_wide_against_its_edge_and_a_move_carries_over(self):
        for edge, want in (("bottom", 1 - 4 / 720), ("top", 4 / 720)):  # 0.012 of 720 is 8 pixels
            bar = spec_of(doc_with([sh(kind="progress", edge=edge, thick=0.012)])).picture_overlays[0]
            self.assertEqual((bar.x, bar.w), (0.5, 1.0))
            self.assertAlmostEqual(bar.y, want, 9)
            self.assertTrue(bar.progress)
        moving = spec_of(doc_with([sh(move={"to": {"x": 0.9, "w": 0.5}})])).picture_overlays[0]
        self.assertEqual((moving.to_x, moving.to_w, moving.to_y, moving.to_opacity), (0.9, 0.5, None, None))

    def test_what_shows_nothing_is_left_out(self):
        for s in (sh(opacity=0), sh(start_s=5, end_s=6)):
            self.assertEqual(spec_of(doc_with([s])).picture_overlays, [])

    def test_a_document_without_shapes_renders_the_commands_it_always_did(self):
        def cmds(doc):
            spec = spec_of(doc)
            return (rs.build_ffmpeg_command(spec, "/w/concat.txt", "/w/overlays.ass"), spec.to_dict())
        plain = cmds(doc_with())
        self.assertEqual(cmds(doc_with([])), plain)
        self.assertEqual(cmds(doc_with([sh(opacity=0)])), plain)
        self.assertEqual(cmds(doc_with([sh(start_s=5, end_s=6)])), plain)
        self.assertNotIn("shape", json.dumps(plain[1]))

    def test_the_spec_round_trips_with_a_shape(self):
        spec = spec_of(doc_with([EXAMPLES["pill"], dict(EXAMPLES["progress"], id="s2")]))
        again = rs.RenderSpec.from_dict(spec.to_dict())
        self.assertEqual(again.picture_overlays, spec.picture_overlays)
        self.assertEqual(again.to_dict(), spec.to_dict())

    def test_a_spec_is_refused_for_what_would_not_render(self):
        art = sa.ShapeArt
        base = spec_of(doc_with([sh()]))
        ov = base.picture_overlays[0]

        def refused(**kw):
            from dataclasses import replace
            changed = replace(base, picture_overlays=[replace(ov, **kw)])
            return rs.validate(changed)
        self.assertTrue(refused(shape=art(kind="triangle")))
        self.assertTrue(refused(shape=art(kind="circle", color="red")))
        self.assertTrue(refused(shape=art(kind="pill", text="")))
        self.assertTrue(refused(shape=art(kind="pill", text="x" * 25)))
        self.assertTrue(refused(shape=art(kind="pill", text="a\nb")))
        self.assertTrue(refused(shape=art(kind="rect", aspect=9)))
        self.assertTrue(refused(shape=art(kind="line", thick=0.0)))
        self.assertTrue(refused(shape=art(kind="progress", thick=0.01, edge="left")))
        self.assertTrue(refused(shape=art(kind="progress", thick=0.01), to_x=0.5))
        self.assertTrue(refused(shape=art(kind="progress", thick=0.01), anim_in="pop"))
        self.assertTrue(refused(path="", shape=None), "no path and no shape")
        self.assertEqual(refused(shape=art(kind="arrow")), [])


# ── the argv ────────────────────────────────────────────────────────────────

class CommandTestCase(unittest.TestCase):
    """The final pass for shapes, string by string. None of this needs ffmpeg."""

    def final(self, shapes, **top):
        from dataclasses import replace
        spec = spec_of(doc_with(shapes, **top))
        # what the backend does after drawing: the path of each PNG
        spec = replace(spec, picture_overlays=[
            replace(o, path=f"/w/shape-{k}.png") if o.shape else o for k, o in enumerate(spec.picture_overlays)])
        return rs.build_ffmpeg_command(spec, "/w/concat.txt", "/w/overlays.ass")

    @staticmethod
    def graph(cmd):
        return cmd[cmd.index("-filter_complex") + 1]

    def test_a_circle_is_the_picture_overlay_chain_and_nothing_else(self):
        graph = self.graph(self.final([sh(kind="circle", x=0.25, y=0.75, w=0.2)]))
        self.assertEqual(graph, (
            "[1:v]trim=end_frame=1,setpts=PTS-STARTPTS,scale=256:1440:force_original_aspect_ratio=decrease"
            ":force_divisible_by=2:flags=bicubic,format=rgba,scale=out_color_matrix=bt709:out_range=tv"
            ":flags=bicubic,format=yuva420p,fps=30,tpad=stop=59:stop_mode=clone,setpts=PTS+30/(30*TB)[p0];"
            "[0:v][p0]overlay=x='round(320.000-w/2)':y='round(540.000-h/2)'"
            ":enable='between(t,0.983333,2.983333)':eof_action=pass[pv0]"))

    def test_the_bar_slides_in_from_the_left_with_the_clock(self):
        graph = self.graph(self.final([sh(kind="progress", start_s=1, end_s=3)]))
        # frames 30..89: p = (t - 1) / (59 / 30), empty on the first frame, full on the last
        self.assertIn("overlay=x='round(W*(clip((t-1.000000)/1.966667,0,1)-1))'", graph)
        self.assertIn(":y='round(716.000-h/2)'", graph)
        self.assertIn(":enable='between(t,0.983333,2.983333)':eof_action=pass", graph)
        self.assertNotIn("drawbox", graph)
        top = self.graph(self.final([sh(kind="progress", edge="top", start_s=0, end_s=4)]))
        self.assertIn("overlay=x='round(W*(clip((t-0.000000)/3.966667,0,1)-1))':y='round(4.000-h/2)'", top)

    def test_a_one_frame_bar_is_full_not_a_division_by_zero(self):
        graph = self.graph(self.final([sh(kind="progress", start_s=1, end_s=1.034)]))
        self.assertIn("clip((t-1.000000)/0.033333,0,1)", graph)

    def test_a_fade_and_a_move_use_the_pictures_filters(self):
        graph = self.graph(self.final([sh(kind="star", anim_in="fade", anim_in_s=0.5, anim_out="pop", anim_out_s=0.5,
                                          move={"to": {"x": 0.9, "w": 0.5}})]))
        self.assertIn(",fade=t=in:st=1.000:d=0.500:alpha=1", graph)
        self.assertIn(",fade=t=out:st=2.500:d=0.500:alpha=1", graph)
        self.assertIn("scale=w='max(2,trunc(iw*", graph)
        self.assertIn("+(", graph.split("overlay=x='")[1].split("'")[0], "the move shifts x")
        self.assertNotIn("geq", graph, "no per-pixel opacity filter for a shape, ever")

    def test_opacity_is_the_cheap_channel_mix(self):
        graph = self.graph(self.final([sh(kind="rect", opacity=0.4)]))
        self.assertIn("colorchannelmixer=aa=0.400", graph)
        self.assertNotIn("geq", graph)

    def test_shapes_chain_in_layer_order_over_pictures_and_under_the_text(self):
        cmd = self.final([sh(id=f"s{i}", kind="circle") for i in range(3)],
                         overlays=[{"id": "o1", "asset_id": PIC, "start_s": 0, "end_s": 2}],
                         tracks=[{"id": "v1", "kind": "V", "clips": [
                             {"id": "c1", "asset_id": BASE, "start_s": 0, "in_s": 0, "out_s": 4}]},
                             {"id": "t1", "kind": "T", "clips": [
                                 {"id": "x1", "start_s": 0, "end_s": 2, "text": "HI"}]}])
        graph = self.graph(cmd)
        inputs = [cmd[i + 1] for i, t in enumerate(cmd) if t == "-i"]
        self.assertEqual(inputs[1:], ["/media/pic.png", "/w/shape-1.png", "/w/shape-2.png", "/w/shape-3.png"])
        for i in range(4):
            src = "[0:v]" if i == 0 else f"[pv{i - 1}]"
            self.assertIn(f"{src}[p{i}]overlay=", graph)
        self.assertIn("[pv3]subtitles=", graph, "text goes over the shapes")

    def test_no_document_text_reaches_the_graph_and_a_path_is_only_an_argument(self):
        nasty = "it's;[x]=,\"q\" {\\an8} видео"
        cmd = self.final([sh(kind="pill", text=nasty[:24]), sh(id="s2", kind="circle", color="#ff3b30")])
        graph = self.graph(cmd)
        for needle in ("it's", "[x]", "q\"", "an8", "видео", "pill", "circle", "ff3b30", "FF3B30", "s1", "s2"):
            self.assertNotIn(needle, graph, needle)
        # the only thing of a shape in the command is a path the backend wrote
        self.assertIn("/w/shape-1.png", cmd)
        self.assertEqual(sum(1 for t in cmd if "pill" in str(t)), 0)

    def test_numbers_are_formatted_with_fixed_precision_never_pasted(self):
        graph = self.graph(self.final([sh(kind="circle", x=0.123456789, y=1 / 3, w=0.1 + 0.2, opacity=0.1 + 0.2,
                                          move={"to": {"x": 1 / 7}})]))
        for number in re.findall(r"\d+\.\d+", graph):
            self.assertLessEqual(len(number.split(".")[1]), 6, number)
        self.assertNotIn("0.30000000000000004", graph)

    def test_a_move_to_a_bigger_width_scales_down_from_it(self):
        graph = self.graph(self.final([sh(kind="circle", w=0.2, move={"to": {"w": 0.5}})]))
        self.assertIn("scale=640:1440:force_original_aspect_ratio=decrease", graph, "the widest it ever is")

    def test_decoder_caps_are_the_stills(self):
        cmd = self.final([sh(kind="circle")])
        i = cmd.index("/w/shape-0.png")
        self.assertEqual(cmd[i - 1], "-i")
        self.assertIn(str(rs.decoder_max_pixels(rs.DECODE_MAX_PIXELS)), cmd[:i])
        self.assertIn("file", cmd[:i], "protocol whitelist")


# ── the art ─────────────────────────────────────────────────────────────────

def have_font() -> bool:
    try:
        sa._font_path()
        return True
    except sa.ShapeArtError:
        return False


class GeometryTestCase(unittest.TestCase):
    def test_sizes_are_even_and_fit_the_filters_box(self):
        for frame in ((1280, 720), (720, 1280), (1080, 1080), (3840, 2160), (2160, 3840)):
            for w in (0.05, 0.1234, 0.3, 0.5, 1.0):
                for art in (sa.ShapeArt("circle"), sa.ShapeArt("star"), sa.ShapeArt("rect", aspect=0.2),
                            sa.ShapeArt("rect", aspect=5), sa.ShapeArt("arrow", dir="up"),
                            sa.ShapeArt("arrow", dir="right"), sa.ShapeArt("line", thick=0.01),
                            sa.ShapeArt("progress", thick=0.012)):
                    pw, ph = sa.png_size(art, w, *frame)
                    with self.subTest(frame=frame, w=w, kind=art.kind):
                        self.assertEqual((pw % 2, ph % 2), (0, 0))
                        self.assertLessEqual(ph, 2 * frame[1])
                        self.assertLessEqual(pw, max(2, round(w * frame[0]) // 2 * 2) if art.kind != "progress" else frame[0])

    def test_the_bar_is_the_frames_width_and_an_even_height(self):
        self.assertEqual(sa.png_size(sa.ShapeArt("progress", thick=0.012), 1.0, 1280, 720), (1280, 8))
        self.assertEqual(sa.png_size(sa.ShapeArt("progress", thick=0.05), 1.0, 1080, 1920), (1080, 96))
        self.assertEqual(sa.progress_height_px(0.002, 720), 2, "never below two pixels")
        self.assertAlmostEqual(sa.progress_center_y(sa.ShapeArt("progress", thick=0.012, edge="bottom"), 720), 1 - 4 / 720)
        self.assertAlmostEqual(sa.progress_center_y(sa.ShapeArt("progress", thick=0.012, edge="top"), 720), 4 / 720)

    def test_a_tall_arrow_is_cut_to_the_filters_box_so_the_filter_leaves_it_alone(self):
        pw, ph = sa.png_size(sa.ShapeArt("arrow", dir="up"), 1.0, 1920, 1080)
        self.assertEqual(ph, 2160)
        self.assertEqual(pw, 1080)

    def test_contrast_text_colour_is_a_fixed_threshold(self):
        self.assertEqual(sa.contrast_on("#FFFFFF"), "#111111")
        self.assertEqual(sa.contrast_on("#FFD60A"), "#111111")
        self.assertEqual(sa.contrast_on("#000000"), "#FFFFFF")
        self.assertEqual(sa.contrast_on("#0A84FF"), "#FFFFFF")


class ArtTestCase(unittest.TestCase):
    def setUp(self):
        try:
            import PIL  # noqa: F401
        except ImportError:
            self.skipTest("Pillow is a worker dependency but not installed here")

    def alpha(self, art, w=0.3, frame=(640, 360)):
        pw, ph = sa.png_size(art, w, *frame)
        im = sa.draw(art, pw, ph)
        return im, pw, ph

    def test_a_solid_circle_is_round_and_a_ring_has_a_hole(self):
        solid, pw, ph = self.alpha(sa.ShapeArt("circle", color="#FF0000"))
        self.assertEqual(solid.getpixel((pw // 2, ph // 2)), (255, 0, 0, 255))
        self.assertEqual(solid.getpixel((1, 1))[3], 0, "the corner of the box is clear")
        ring, pw, ph = self.alpha(sa.ShapeArt("circle", color="#FF0000", outline=0.15))
        self.assertEqual(ring.getpixel((pw // 2, ph // 2))[3], 0, "the hole")
        self.assertEqual(ring.getpixel((pw // 2, 2))[3], 255, "the band at the top")

    def test_a_rectangle_is_solid_or_a_frame(self):
        solid, pw, ph = self.alpha(sa.ShapeArt("rect", color="#00FF00", aspect=2.0))
        self.assertEqual(pw, ph * 2)
        self.assertEqual(solid.getpixel((1, 1)), (0, 255, 0, 255))
        frame, pw, ph = self.alpha(sa.ShapeArt("rect", color="#00FF00", aspect=2.0, outline=0.2))
        self.assertEqual(frame.getpixel((pw // 2, ph // 2))[3], 0)
        self.assertEqual(frame.getpixel((1, ph // 2))[3], 255)

    def test_a_star_has_points_and_a_centre_but_no_corners(self):
        im, pw, ph = self.alpha(sa.ShapeArt("star", color="#0000FF"))
        self.assertEqual(im.getpixel((pw // 2, ph // 2))[:3], (0, 0, 255))
        self.assertEqual(im.getpixel((1, 1))[3], 0)
        self.assertEqual(im.getpixel((pw - 2, ph - 2))[3], 0)
        self.assertGreater(im.getpixel((pw // 2, int(ph * 0.1)))[3], 200, "the top point")
        ring, pw, ph = self.alpha(sa.ShapeArt("star", color="#0000FF", outline=0.08))
        self.assertEqual(ring.getpixel((pw // 2, int(ph * 0.55)))[3], 0, "the middle is a hole")

    def test_an_arrow_points_where_dir_says(self):
        for d, tip, off in (("right", (0.97, 0.5), (0.97, 0.1)), ("left", (0.03, 0.5), (0.03, 0.1)),
                            ("up", (0.5, 0.03), (0.1, 0.03)), ("down", (0.5, 0.97), (0.1, 0.97))):
            with self.subTest(d):
                im, pw, ph = self.alpha(sa.ShapeArt("arrow", dir=d, color="#FFFFFF"), w=0.3)
                self.assertGreater(im.getpixel((int(pw * tip[0]), int(ph * tip[1])))[3], 100, "the tip")
                self.assertEqual(im.getpixel((int(pw * off[0]), int(ph * off[1])))[3], 0, "beside the tip")
        right, pw, ph = self.alpha(sa.ShapeArt("arrow", dir="right"))
        self.assertEqual(pw, ph * 2)
        up, pw, ph = self.alpha(sa.ShapeArt("arrow", dir="up"))
        self.assertEqual(ph, pw * 2)

    def test_a_line_has_rounded_ends_and_the_bar_square_ones(self):
        line, pw, ph = self.alpha(sa.ShapeArt("line", thick=0.04, color="#FFFFFF"), w=0.5)
        self.assertEqual(line.getpixel((pw // 2, ph // 2))[3], 255)
        self.assertEqual(line.getpixel((0, 0))[3], 0, "a rounded end")
        bar, pw, ph = self.alpha(sa.ShapeArt("progress", thick=0.05, color="#FFFFFF"))
        self.assertEqual(bar.getpixel((0, 0))[3], 255)
        self.assertEqual(bar.getpixel((pw - 1, ph - 1))[3], 255)
        self.assertEqual((pw, bar.size[0]), (640, 640))

    def test_the_drawing_is_deterministic(self):
        art = sa.ShapeArt("star", color="#FFD60A", outline=0.05)
        with tempfile.TemporaryDirectory() as d:
            a, b = Path(d) / "a.png", Path(d) / "b.png"
            sa.write_png(art, 0.3, 1280, 720, a)
            sa.write_png(art, 0.3, 1280, 720, b)
            self.assertEqual(a.read_bytes(), b.read_bytes())

    def test_a_huge_shape_is_drawn_without_an_enormous_canvas(self):
        self.assertEqual(sa._supersample(3840, 3840), 1)
        self.assertEqual(sa._supersample(100, 100), sa.SUPERSAMPLE_MAX)
        self.assertGreater(sa._supersample(1080, 1080), 1)
        self.assertLessEqual(1080 * 1080 * sa._supersample(1080, 1080) ** 2, sa.SUPERSAMPLE_BUDGET_PX)

    @unittest.skipUnless(have_font(), "no bold font on this machine (the worker image has fonts-dejavu)")
    def test_a_pill_draws_its_text_and_different_text_is_a_different_picture(self):
        a, pw, ph = self.alpha(sa.ShapeArt("pill", text="Subscribe", color="#FF0000"), w=0.4)
        b, _pw, _ph = self.alpha(sa.ShapeArt("pill", text="Part 2", color="#FF0000"), w=0.4)
        self.assertEqual(a.getpixel((int(ph * 0.1), ph // 2))[:3], (255, 0, 0), "the box")
        self.assertEqual(a.getpixel((0, 0))[3], 0, "a rounded box")
        light = sum(1 for x in range(pw) for y in range(ph) if a.getpixel((x, y))[:3] == (255, 255, 255)
                    or a.getpixel((x, y))[:3] > (200, 200, 200))
        self.assertGreater(light, 200, "the text is drawn in white on red")
        self.assertNotEqual(a.tobytes(), b.tobytes())
        self.assertGreater(sa.pill_aspect("Subscribe"), sa.pill_aspect("New"))

    @unittest.skipUnless(have_font(), "no bold font on this machine")
    def test_cyrillic_and_uzbek_letters_are_drawn_not_boxes(self):
        for text in ("Подписаться", "Obuna boʻling"):
            im, pw, ph = self.alpha(sa.ShapeArt("pill", text=text, color="#FF0000"), w=0.6)
            dark_or_white = sum(1 for x in range(pw) for y in range(ph) if im.getpixel((x, y))[:3] == (255, 255, 255))
            self.assertGreater(dark_or_white, 100, text)

    @unittest.skipUnless(have_font(), "no bold font on this machine")
    def test_the_text_is_cleaned_like_a_text_overlays_words(self):
        """``{`` and ``\\`` are made inert by the same clean-up the ASS writer uses, and runs of
        white space collapse: the drawn text is the escaped one."""
        from modules import ass_captions
        self.assertEqual(ass_captions.escape_text("{a}  \\ b"), "(a) / b")
        im, pw, ph = self.alpha(sa.ShapeArt("pill", text="{a}  \\ b", color="#FF0000"), w=0.5)
        self.assertGreater(im.getpixel((ph // 2, ph // 2))[3], 0)

    def test_a_missing_font_is_refused_never_replaced_by_a_bitmap(self):
        original = sa._FONT_FILES
        sa._FONT_FILES = ("/nonexistent/none.ttf",)
        try:
            with self.assertRaises(sa.ShapeArtError) as cm:
                sa.png_size(sa.ShapeArt("pill", text="Hi"), 0.3, 640, 360)
            self.assertIn("fonts-dejavu", str(cm.exception))
            spec = spec_of(doc_with([sh(kind="pill", text="Hi")]))
            with self.assertRaises(render_backend.RenderBackendError):
                render_backend.draw_shapes(spec, Path(tempfile.gettempdir()))
        finally:
            sa._FONT_FILES = original

    def test_draw_shapes_writes_a_png_per_shape_and_leaves_pictures_alone(self):
        spec = spec_of(doc_with([sh(kind="circle"), sh(id="s2", kind="progress", start_s=0, end_s=2)],
                                overlays=[{"id": "o1", "asset_id": PIC, "start_s": 0, "end_s": 2}]))
        with tempfile.TemporaryDirectory() as d:
            out = render_backend.draw_shapes(spec, Path(d))
            self.assertEqual(out[0].path, "/media/pic.png")
            self.assertEqual([Path(o.path).name for o in out[1:]], ["shape-1.png", "shape-2.png"])
            from PIL import Image
            self.assertEqual(Image.open(out[2].path).size, (1280, 8))
            self.assertEqual(Image.open(out[1].path).mode, "RGBA")


# ── real ffmpeg ─────────────────────────────────────────────────────────────

def _ffmpeg():
    exe = render_backend.resolve_ffmpeg()
    try:
        ok = subprocess.run([exe, "-version"], capture_output=True).returncode == 0
    except OSError:
        return None
    return exe if ok else None


GREY = (128, 128, 128)
FW, FH = 640, 360


class _Real(unittest.TestCase):
    def setUp(self):
        self.ffmpeg = _ffmpeg()
        if not self.ffmpeg:
            self.skipTest("ffmpeg not available")
        try:
            import PIL  # noqa: F401
        except ImportError:
            self.skipTest("Pillow not installed")
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)
        self.n = 0
        path = self.dir / "base.mp4"
        self.run_ffmpeg("-f", "lavfi", "-i", f"color=c=0x808080:s={FW}x{FH}:r=30:d=4", "-c:v", "libx264",
                        "-pix_fmt", "yuv420p", str(path))
        self.table = {BASE: tl.ResolvedAsset(BASE, "video", str(path), 4.0, False)}

    def tearDown(self):
        self.tmp.cleanup()

    def run_ffmpeg(self, *args):
        proc = subprocess.run([self.ffmpeg, "-hide_banner", "-loglevel", "error", "-y", *args], capture_output=True)
        self.assertEqual(proc.returncode, 0, proc.stderr.decode()[-500:])
        return proc.stdout

    def export(self, shapes, **kw):
        self.n += 1
        out = self.dir / f"out{self.n}.mp4"
        tr.render(doc_with(shapes, width=FW, height=FH, **kw), self.table.get, str(out), ffmpeg=self.ffmpeg)
        return out

    def frames(self, path, indexes):
        """``{index: rgb24 bytes}``, decoded with the matrix a small frame has (BT.601)."""
        sel = "+".join(f"eq(n\\,{i})" for i in indexes)
        raw = self.run_ffmpeg("-i", str(path), "-vf", f"select={sel},scale=in_color_matrix=bt601:in_range=tv,format=rgb24",
                              "-vsync", "0", "-f", "rawvideo", "-")
        step = FW * FH * 3
        self.assertEqual(len(raw), step * len(indexes), "frames are missing")
        return {i: raw[k * step:(k + 1) * step] for k, i in enumerate(indexes)}

    @staticmethod
    def px(raw, x, y):
        i = (y * FW + x) * 3
        return tuple(raw[i:i + 3])

    def close(self, got, want, tol=10, label=""):
        gap = max(abs(g - t) for g, t in zip(got, want))
        self.assertLessEqual(gap, tol, f"{label}: got {got}, want about {tuple(round(v) for v in want)}")

    def count(self, raw, color, tol=12, rows=None, cols=None):
        n = 0
        for y in (rows if rows is not None else range(FH)):
            for x in (cols if cols is not None else range(FW)):
                p = self.px(raw, x, y)
                if max(abs(p[0] - color[0]), abs(p[1] - color[1]), abs(p[2] - color[2])) <= tol:
                    n += 1
        return n


class ShapePixelsTestCase(_Real):
    """Each kind at a known place in a flat grey frame, measured on the exported pixels."""

    RED = (255, 0, 0)

    def frame(self, shape, at=45):
        out = self.export([dict(shape, start_s=1, end_s=3)])
        return self.frames(out, [at])[at]

    def test_a_solid_circle_is_where_the_document_puts_it_and_round(self):
        raw = self.frame(sh(kind="circle", x=0.25, y=0.5, w=0.2, color="#FF0000"))
        cx, cy, r = int(0.25 * FW), FH // 2, int(0.2 * FW) // 2
        self.close(self.px(raw, cx, cy), self.RED, 14, "centre")
        self.close(self.px(raw, cx + r - 6, cy), self.RED, 14, "inside the rim")
        self.close(self.px(raw, cx + r + 8, cy), GREY, 8, "outside the rim")
        self.close(self.px(raw, cx + r - 3, cy - r + 3), GREY, 8, "the corner of the box is the picture")
        self.close(self.px(raw, 5, 5), GREY, 6, "far away")

    def test_a_ring_has_a_hole_and_a_frame_is_hollow(self):
        raw = self.frame(sh(kind="circle", x=0.5, y=0.5, w=0.3, outline=0.15, color="#FF0000"))
        cx, cy, r = FW // 2, FH // 2, int(0.3 * FW) // 2
        self.close(self.px(raw, cx, cy), GREY, 8, "the hole shows the picture")
        self.close(self.px(raw, cx + r - 5, cy), self.RED, 14, "the band")
        raw = self.frame(sh(kind="rect", x=0.5, y=0.5, w=0.4, aspect=2.0, outline=0.15, color="#FF0000"))
        w, h = int(0.4 * FW), int(0.4 * FW / 2)
        self.close(self.px(raw, FW // 2, FH // 2), GREY, 8, "hollow")
        self.close(self.px(raw, FW // 2 - w // 2 + 6, FH // 2), self.RED, 14, "left edge")
        self.close(self.px(raw, FW // 2, FH // 2 - h // 2 + 6), self.RED, 14, "top edge")

    def test_a_solid_rectangle_a_star_and_a_line(self):
        raw = self.frame(sh(kind="rect", x=0.5, y=0.5, w=0.4, aspect=2.0, color="#00FF00"))
        self.close(self.px(raw, FW // 2, FH // 2), (0, 255, 0), 14, "rectangle")
        raw = self.frame(sh(kind="star", x=0.5, y=0.5, w=0.3, color="#0000FF"))
        s = int(0.3 * FW)
        self.close(self.px(raw, FW // 2, FH // 2), (0, 0, 255), 14, "star centre")
        self.close(self.px(raw, FW // 2 - s // 2 + 3, FH // 2 - s // 2 + 3), GREY, 8, "star corner")
        raw = self.frame(sh(kind="line", x=0.5, y=0.8, w=0.5, thick=0.03, color="#FFFFFF"))
        y = int(0.8 * FH)
        self.close(self.px(raw, FW // 2, y), (255, 255, 255), 14, "line")
        self.close(self.px(raw, FW // 2, y - 12), GREY, 8, "above the line")
        self.close(self.px(raw, FW // 2, y + 12), GREY, 8, "below the line")
        self.close(self.px(raw, 10, y), GREY, 8, "left of the line")

    def test_an_arrow_points_the_way_dir_says(self):
        for d, tip, off in (("right", (0.5 + 0.13, 0.5), (0.5 + 0.13, 0.5 - 0.1)),
                            ("up", (0.5, 0.5 - 0.17), (0.5 - 0.06, 0.5 - 0.17))):
            raw = self.frame(sh(kind="arrow", dir=d, x=0.5, y=0.5, w=0.3 if d == "right" else 0.15, color="#FF0000"))
            self.close(self.px(raw, int(tip[0] * FW), int(tip[1] * FH)), self.RED, 30, f"{d} tip")
            self.close(self.px(raw, int(off[0] * FW), int(off[1] * FH)), GREY, 8, f"{d} beside the tip")

    @unittest.skipUnless(have_font(), "no bold font on this machine (the worker image has fonts-dejavu)")
    def test_a_pill_has_a_box_and_its_text_in_a_contrasting_colour(self):
        raw = self.frame(sh(kind="pill", text="Subscribe", x=0.5, y=0.5, w=0.5, color="#FF0000"))
        box_h = int(0.5 * FW / sa.pill_aspect("Subscribe"))
        self.close(self.px(raw, FW // 4 + 5, FH // 2), self.RED, 14, "the box")
        self.close(self.px(raw, 5, 5), GREY, 6, "away")
        white = self.count(raw, (255, 255, 255), tol=40, rows=range(FH // 2 - box_h // 2, FH // 2 + box_h // 2),
                           cols=range(FW // 4, 3 * FW // 4))
        self.assertGreater(white, 250, "the label is drawn in white on the red box")
        other = self.frame(sh(kind="pill", text="New", x=0.5, y=0.5, w=0.5, color="#FF0000"))
        self.assertNotEqual(raw, other, "the text is part of the picture")

    @unittest.skipUnless(have_font(), "no bold font on this machine (the worker image has fonts-dejavu)")
    def test_a_label_in_cyrillic_is_drawn(self):
        raw = self.frame(sh(kind="pill", text="Подписаться", x=0.5, y=0.5, w=0.6,
                            color="#FF0000"))
        self.assertGreater(self.count(raw, (255, 255, 255), tol=40, rows=range(FH // 3, 2 * FH // 3)), 250)

    def test_opacity_blends_with_the_picture(self):
        raw = self.frame(sh(kind="rect", x=0.5, y=0.5, w=0.4, opacity=0.5, color="#FF0000"))
        self.close(self.px(raw, FW // 2, FH // 2), tuple(0.5 * a + 0.5 * b for a, b in zip(self.RED, GREY)), 14, "half")

    def test_the_span_is_frame_exact(self):
        out = self.export([sh(kind="rect", x=0.5, y=0.5, w=0.4, color="#FF0000", start_s=1, end_s=2)])
        f = self.frames(out, [28, 29, 30, 31, 58, 59, 60, 61])
        shown = {i: self.px(f[i], FW // 2, FH // 2) for i in f}
        for i in (28, 29, 60, 61):
            self.close(shown[i], GREY, 8, f"frame {i} is outside the span")
        for i in (30, 31, 58, 59):
            self.close(shown[i], self.RED, 14, f"frame {i} is inside it")

    def test_a_fade_in_starts_clear_and_a_move_goes_where_it_says(self):
        out = self.export([sh(kind="rect", x=0.5, y=0.5, w=0.3, color="#FF0000", start_s=1, end_s=3,
                              anim_in="fade", anim_in_s=1.0)])
        f = self.frames(out, [30, 45, 75])
        self.close(self.px(f[30], FW // 2, FH // 2), GREY, 10, "the first frame of a fade-in is clear")
        mid = self.px(f[45], FW // 2, FH // 2)
        self.assertTrue(10 < mid[1] < 120 and mid[0] > 150, f"half faded in: {mid}")
        self.close(self.px(f[75], FW // 2, FH // 2), self.RED, 14, "fully in")
        out = self.export([sh(kind="circle", x=0.2, y=0.5, w=0.1, color="#FF0000", start_s=0, end_s=4,
                              move={"to": {"x": 0.8}})])
        f = self.frames(out, [0, 119])
        self.close(self.px(f[0], int(0.2 * FW), FH // 2), self.RED, 14, "starts left")
        self.close(self.px(f[0], int(0.8 * FW), FH // 2), GREY, 8, "not yet right")
        self.close(self.px(f[119], int(0.8 * FW), FH // 2), self.RED, 14, "ends right")
        self.close(self.px(f[119], int(0.2 * FW), FH // 2), GREY, 8, "left it")

    def test_shapes_layer_in_list_order_and_over_nothing_else_is_disturbed(self):
        out = self.export([sh(id="a", kind="rect", x=0.5, y=0.5, w=0.4, color="#FF0000", start_s=1, end_s=3),
                           sh(id="b", kind="circle", x=0.5, y=0.5, w=0.2, color="#0000FF", start_s=1, end_s=3)])
        raw = self.frames(out, [45])[45]
        self.close(self.px(raw, FW // 2, FH // 2), (0, 0, 255), 14, "the later shape is on top")
        self.close(self.px(raw, FW // 2 - int(0.18 * FW), FH // 2), self.RED, 14, "the earlier one shows beside it")


class ProgressBarPixelsTestCase(_Real):
    """The bar grows with time: empty on its first frame, full on its last."""

    BAR = (255, 0, 0)

    def bar_px(self, raw, edge="bottom"):
        """How many columns of the bar's row are the bar's colour."""
        y = FH - 2 if edge == "bottom" else 1
        return sum(1 for x in range(FW) if max(abs(a - b) for a, b in zip(self.px(raw, x, y), self.BAR)) <= 20)

    def test_the_bar_fills_across_its_span_by_the_clock(self):
        out = self.export([sh(kind="progress", start_s=0.5, end_s=3.5, thick=0.03, color="#FF0000")])
        first, last = 15, 105                      # frames 15..104
        idx = [first - 1, first, first + 22, first + 44, first + 67, last - 1, last]
        f = self.frames(out, idx)
        width = {i: self.bar_px(f[i]) for i in idx}
        self.assertEqual(width[first - 1], 0, "before the span")
        self.assertEqual(width[last], 0, "after the span")
        self.assertLessEqual(width[first], 3, "empty on the first frame")
        self.assertGreaterEqual(width[last - 1], FW - 3, "full on the last frame")
        span = (last - 1) - first
        for i in (first + 22, first + 44, first + 67):
            want = FW * (i - first) / span
            self.assertLessEqual(abs(width[i] - want), 4, f"frame {i}: {width[i]} columns, expected {want:.0f}")
        self.assertTrue(width[first + 22] < width[first + 44] < width[first + 67], "it grows")
        print(f"[progress bar] columns by frame: {width}")

    def test_the_bar_sits_on_the_edge_it_names_and_has_the_thickness_it_names(self):
        out = self.export([sh(kind="progress", start_s=0, end_s=4, thick=0.05, edge="top", color="#FF0000")])
        raw = self.frames(out, [119])[119]
        h = sa.progress_height_px(0.05, FH)
        self.assertEqual(h, 18)
        self.close(self.px(raw, FW // 2, 2), self.BAR, 14, "top edge")
        self.close(self.px(raw, FW // 2, h - 3), self.BAR, 14, "inside the bar")
        self.close(self.px(raw, FW // 2, h + 4), GREY, 8, "below the bar")
        self.close(self.px(raw, FW // 2, FH - 3), GREY, 8, "the bottom is the picture")
        self.assertEqual(self.bar_px(raw, "top"), FW)

    def test_the_bar_fades_in_and_out_like_a_picture(self):
        out = self.export([sh(kind="progress", start_s=0, end_s=4, thick=0.05, color="#FF0000",
                              anim_out="fade", anim_out_s=1.0)])
        f = self.frames(out, [85, 119])
        self.assertGreater(self.bar_px(f[85]), 300)
        self.close(self.px(f[119], FW - 3, FH - 3), GREY, 20, "faded out on the last frame")

    def test_the_bar_works_at_other_frame_rates_and_in_a_portrait_frame(self):
        for fps in (24, 60):
            with self.subTest(fps=fps):
                self.n += 1
                out = self.dir / f"fps{fps}.mp4"
                base = self.dir / f"base{fps}.mp4"
                self.run_ffmpeg("-f", "lavfi", "-i", f"color=c=0x808080:s={FW}x{FH}:r={fps}:d=3", "-c:v", "libx264",
                                "-pix_fmt", "yuv420p", str(base))
                table = {BASE: tl.ResolvedAsset(BASE, "video", str(base), 3.0, False)}
                tr.render(doc_with([sh(kind="progress", start_s=0, end_s=2, thick=0.05, color="#FF0000")],
                                   width=FW, height=FH, fps=fps, out_s=3), table.get, str(out), ffmpeg=self.ffmpeg)
                last = round(2 * fps) - 1
                f = self.frames(out, [0, last // 2, last])
                self.assertLessEqual(self.bar_px(f[0]), 3)
                self.assertLessEqual(abs(self.bar_px(f[last // 2]) - FW * (last // 2) / last), 5)
                self.assertGreaterEqual(self.bar_px(f[last]), FW - 3)


class VersionNoteTestCase(unittest.TestCase):
    def test_which_ffmpeg_ran_the_pixel_tests(self):
        exe = _ffmpeg()
        if not exe:
            self.skipTest("ffmpeg not available")
        line = subprocess.run([exe, "-version"], capture_output=True, text=True).stdout.splitlines()[0]
        print(f"[ffmpeg] {line}")
        self.assertIn("ffmpeg version", line)


if __name__ == "__main__":
    unittest.main()

# Editor render fields (timeline document v1) — for the editor UI

Running list of every optional field the export engine understands beyond the
original document, with limits and defaults. Written for whoever builds the
editor controls. Every field is OPTIONAL: a document without it renders
exactly as it did before. Python (`modules/timeline.py`) and TypeScript
(`command-center/lib/editor.ts`, `lib/server/editor-guard.ts`) validate the
same limits; `schemas/timeline.schema.json` is the machine-readable twin.
The database function `editor_doc_problem` only checks `asset_id` values (at
any depth) and size, so it accepts all of these without a migration — and it
means a new field must never carry a media id under a name other than
`asset_id`.

Preview vs export: the export (ffmpeg) is the truth. Where the browser cannot
match it, the UI should say the preview is approximate (like the existing
note for text looks).

## Status

| # | Branch | Fields | State |
|---|--------|--------|-------|
| 1 | `claude/render-xfade-more` | `transition.style` (23 more names) | PR open |
| 2 | `claude/render-anim-inout` | text and overlay `anim_in`, `anim_out`, `anim_in_s`, `anim_out_s` | PR open (stacked on 1) |
| 3 | `claude/render-effects` | V clip `filter`, `filter_strength`, `vignette`, `blur`, `sharpen`, `grain`, `flip_h`, `flip_v`, `rotate` | PR open (stacked on 2) |
| 4 | `claude/render-keyframes` | V clip `move` (Ken Burns zoom/pan); overlay `move.to` (x, y, w, opacity) | PR open (stacked on 3) |
| 5 | `claude/render-blur-fit` | V clip `fit: "blur"` | PR open (stacked on 4) |
| 6 | `claude/render-speed` | V clip `speed` 0.25-4 (pitch kept), `reverse`, `freeze` | PR open (stacked on 5) |
| 7 | `claude/render-chroma-audio` | overlay `chroma`; `denoise`, `loudnorm` on A clips and V clips | PR open (stacked on 6) |

## 1. Blend styles (`transition.style`, crossfade only)

Closed list, `XFADE_STYLES` in `lib/editor.ts` (this order is the picker order).
`fade` is the default and is never stored. Anything not on the list is refused
(no free text reaches ffmpeg).

Old 14: fade, dissolve, fadeblack, fadewhite, wipeleft, wiperight, slideleft,
slideright, slideup, slidedown, circleopen, circleclose, radial, zoomin.

New 23: wipeup, wipedown, smoothleft, smoothright, smoothup, smoothdown,
vertopen, vertclose, horzopen, horzclose, diagtl, diagtr, diagbl, diagbr,
wipetl, wipetr, wipebl, wipebr, squeezeh, squeezev, pixelize, hblur, distance.

Notes for glyphs/labels: the names follow ffmpeg, not intuition. Measured on
the real export (see `test_the_new_styles_draw_the_side_their_name_says`):
`diagtl` and `wipetl` bring the incoming picture in from the BOTTOM RIGHT;
`wipeup` brings it from the bottom; `smoothleft` is a soft edge moving
left to right; `vertopen` opens a column in the middle; `squeezeh` leaves the
old picture in a shrinking horizontal band. `pixelize`, `hblur` and
`distance` look like a plain mix on flat colours — only textures show them.
Duration limits are unchanged (0.2–2 s). The picker already lists every name
(glyph + en/ru/uz label added with this change); the UI builder may regroup.

## 2. Entrance / exit animations (text clips and overlays)

Fields (all optional, on a T clip and on an entry of `overlays`):

| field | values | default | notes |
|-------|--------|---------|-------|
| `anim_in` | `fade`, `slide-up`, `slide-down`, `slide-left`, `slide-right`, `pop`, `typewriter` | none | `typewriter` only on a TEXT |
| `anim_out` | `fade`, `slide-up`, `slide-down`, `slide-left`, `slide-right`, `pop` | none | no typewriter |
| `anim_in_s` | 0.1 – 2 s | 0.4 when `anim_in` is set | refused without `anim_in` |
| `anim_out_s` | 0.1 – 2 s | 0.4 when `anim_out` is set | refused without `anim_out` |

Rules the UI must respect (the validators refuse otherwise):

* in + out durations (a missing one counts as 0.4) must fit in the time the
  item is shown (`end_s - start_s`);
* on a text, `anim_in` and `fade_in_s > 0` cannot both be set (same for
  `anim_out` / `fade_out_s`): a fade IS an animation. The other side may keep
  its plain fade. Offer either the old fade slider or the animation picker,
  not both on the same side;
* at most 20 texts per document with `typewriter`;
* captions (`captions.style`) have no animation fields (the caption-styles
  track owns captions).

What each one does in the export: every animation except `typewriter` also fades
the alpha (0 to 1 on entry, 1 to 0 on exit) over its duration. Slides are named
by the direction the item MOVES: `slide-up` enters from below and leaves
upwards. A slide travels 15 % of the frame (width for left/right, height for
up/down). `pop` scales from 60 % to 100 % about the item's centre (a text:
about its anchor). `typewriter` shows one more character at a time, left to
right, with the text's final position and wrapping fixed from the first
character. Easing is linear. There is no browser preview of these; say in the
product that the export shows the motion.

Model round trip: `toModel`/`toDoc` keep all four fields on texts (they are
spread) and on overlays (`PictureOverlay` in `lib/editor.ts` gained the same
four optional fields).

## 3. Clip effects (V clips; stills too)

All optional, on a V clip. "Off" values are dropped on save by the backend's
`normalise` (and by `toModel`), so the model should treat missing as off.

| field | values | default | meaning |
|-------|--------|---------|---------|
| `filter` | `mono`, `sepia`, `vintage`, `cinematic`, `cool`, `warm`, `high-contrast` | none | a named colour look |
| `filter_strength` | 0 – 1 | 1 | how far toward the look; refused without `filter`; 0 drops the look |
| `vignette` | 0 – 1 | 0 | darkened edges |
| `blur` | 0 – 30 | 0 | Gaussian sigma in OUTPUT pixels (so it looks the same at any export size only relative to the frame, not to the clip) |
| `sharpen` | 0 – 1 | 0 | unsharp mask |
| `grain` | 0 – 1 | 0 | film grain, fixed seed (the same document is the same video) |
| `flip_h` | true/false | false | mirror left-right |
| `flip_v` | true/false | false | mirror top-bottom |
| `rotate` | 0, 90, 180, 270 | 0 | degrees CLOCKWISE |

Order of operations (the UI preview should follow it when it can):
turn (`rotate`) then mirror, both on the SOURCE before it is fitted (a 90 degree
turn of a landscape clip is fitted as a portrait picture, so a `contain` fit
gets side bars); then the fit; then `grade`; then the look; then blur, sharpen,
grain, vignette; then the bars of a `contain` fit are added (bars stay black).
With a cross-fade, each side carries its own clip's effects. Speed, fades and
the cross-fade itself are unchanged.

Preview vs export: a browser can approximate mono, sepia, blur, flip, rotate,
vignette with CSS filters/transforms; vintage/cinematic/cool/warm/high-contrast
are curve looks the preview can only approximate, and grain/sharpen have no
faithful CSS equivalent. Say so in the product.

Not done here (later items): free-angle rotation and crop (item 8).

## 4. Moves and two-point keyframes

### Clip `move` (video and stills): a zoom/pan window over the fitted picture

```json
"move": { "from": {"zoom": 1, "x": 0.5, "y": 0.5}, "to": {"zoom": 2, "x": 0.25, "y": 0.5} }
```

* both `from` and `to` are required; inside each, `zoom` (1 to 4; 1 = the whole
  picture, 2 = a window half as wide and tall), `x` and `y` (0 to 1, the
  window's CENTRE as a fraction of the picture) are optional (defaults 1, 0.5,
  0.5).
* the window goes in a straight line (linear in frames) from `from` on the
  clip's first frame to `to` on its last. If the window would leave the
  picture, its centre is held at the nearest place where it stays inside
  (so `zoom: 2, x: 0` still shows the left half, never black).
* the picture is the FITTED one: with `contain` the bars are part of what zooms.
* a still WITHOUT `move` keeps its automatic slow zoom; a still WITH `move` has
  this move instead; a still with `from` equal to `to` is held completely
  still. A video whose two points are equal and at zoom 1 is unchanged.
* splitting a clip carries the move across the cut (the first half ends where
  the second begins); the editor's `splitClip` and the backend's `split_clip`
  both do this.
* works on both sides of a cross-fade; the move runs over each clip's WHOLE
  length, not just the part outside the blend.
* rotate/flip (item 3) happen before the move; effects after.

### Overlay `move.to`: end keyframe of an overlay

```json
"move": { "to": {"x": 0.8, "y": 0.2, "w": 0.4, "opacity": 0.4} }
```

* `to` needs at least one of `x`, `y` (0-1, centre), `w` (0.05-1, width as a
  fraction of the frame), `opacity` (0-1). The start values are the overlay's
  own `x`, `y`, `w`, `opacity`; the values go linearly over `start_s`..`end_s`.
* entrance/exit animations (item 2) add to a move (a slide moves from where the
  move has the overlay).
* an opacity move to or from 0 is a cheap fade; any other opacity move is
  rendered per pixel and is slower on a large overlay (still fine for the
  caps in place: 16 overlays, 4 videos).
* an overlay whose own `opacity` is 0 is still rendered when its move brings
  the opacity above 0.
* no preview parity in a browser beyond straight CSS interpolation: say that
  the export is the truth.

## 5. Blurred-background fit (`fit: "blur"`)

`fit` on a V clip is now `contain` (default, bars), `cover` (fill and crop) or
`blur`: the whole picture, centred like `contain`, over a blurred and enlarged
copy of itself, so a portrait clip in a landscape frame (or the other way) has
no black bars. Where the picture already has the frame's shape, `blur` looks
like `contain` (the picture alone).

* The background is the picture scaled to cover the frame, shrunk to 1/8,
  blurred (a fixed, strong blur; not adjustable) and enlarged again. No
  darkening.
* Grade (`grade`) and effects (item 3) act on the composed frame, background
  included.
* A fit is for VIDEO clips. Stills are always drawn filling the frame (their
  slow zoom starts from a cover-scaled picture), exactly as before; `fit` has
  no effect on them, so don't offer it for photos.
* The editor's `Fit` type in `lib/editorFrame.ts` and `fitOf()` still know only
  contain/cover: `fitOf` reports a `blur` clip as `contain` and the current
  picker cannot select `blur`; `toModel` keeps the value, so opening and saving a
  document with `blur` does not lose it. Track C: add the third option, and draw
  the preview with a CSS `filter: blur()` copy of the video behind the picture
  (approximate; say so).
* Cross-fades: both sides can use `blur`.

## 6. Speed 0.25 to 4, reverse, freeze

* `speed` on a V clip is now 0.25 to 4 (was 0.5 to 2). `in_s`/`out_s` stay SOURCE
  times; the clip lasts `(out_s - in_s) / speed` on the timeline. Its own sound
  (`audio: true`) keeps its pitch at every speed (chained `atempo` stages).
  The editor's own list (`SPEEDS` in `lib/editor.ts`, 0.5 to 2) is a subset
  the picker offers; the constants `SPEED_MIN`/`SPEED_MAX` are the document's
  (0.25/4), and `setSpeed` clamps to them. Track C: widen `SPEEDS` (and the
  picker) as wanted, e.g. 0.25, 0.5, ..., 3, 4.
  At 0.25x a frame is shown four times; there is no frame interpolation (a
  later item adds optional flow-based slow motion).
* `reverse: true`: plays the source range backwards (picture and the clip's own
  sound), at its `speed`. ffmpeg's `reverse` holds the whole range in memory,
  so the range is capped: `out_s - in_s` frames at the DOCUMENT's frame size
  and rate must fit 512 MiB of 4:2:0 frames. Use `reverseMaxSeconds(width,
  height, fps)` from `lib/editor.ts` to tell the user the limit: 1920x1080 at 30
  fps = 5.75 s, 1280x720 at 30 fps = 12.9 s, 1080x1920 (portrait) at 30 fps =
  5.75 s, 3840x2160 at 60 fps = 0.7 s. The validators refuse a longer range
  with that number in the message. (Measured: a range at the cap peaks near
  660 MB resident, inside the export's 2 GiB limit.)
* `freeze: true`: holds the frame at `in_s` for the clip's whole length
  (`out_s - in_s`; the file does not have to reach `out_s`, only `in_s`). No
  sound; `speed` must be 1 (or absent); cannot be combined with `reverse` or
  `audio: true`. A "freeze frame at the playhead" edit in the UI is: split
  the clip at the playhead, set `freeze: true` on a new clip with `in_s` =
  the playhead's source time and `out_s` = `in_s` + the hold length, and
  shift the rest of the timeline.
* both are for VIDEO clips; the export refuses them on a picture
  ("for video, not a picture").
* splitting: `reverse` and `freeze` stay on both halves, and both splitters
  (`splitClip` in `lib/editor.ts`, `split_clip` in the backend) keep the
  picture continuous: for a reversed clip the part that comes first on the
  timeline gets the LATER part of the source range (the halves swap their
  `in_s`/`out_s` roles); for a frozen clip both halves hold the same frame
  (`in_s` unchanged) and only their lengths (`out_s - in_s`) differ.

## 7. Chroma key, noise reduction, loudness

### Overlay `chroma` (picture or video overlays)

```json
"chroma": { "color": "#00FF00", "similarity": 0.15, "blend": 0.1 }
```

* `color` (required, `#RRGGBB`): the colour to remove. The UI should offer a
  colour picker, ideally sampled from the overlay's own first frame.
* `similarity` 0.01 to 0.6 (default 0.15): how far from `color` a pixel may be
  and still go. Small = only almost exactly that colour; 0.3 to 0.4 for a
  rough green screen.
* `blend` 0 to 0.5 (default 0.1): how softly the edge fades (0 = hard).
* it is applied to the overlay file BEFORE it is scaled; the overlay's
  `opacity`, `move` and `anim_*` then act on what is left. Works on pictures
  (PNG/JPG) too. A video overlay is still silent.
* no despill (green fringes on hair etc. are not corrected).

### `denoise` and `loudnorm` (boolean, default false) on A clips and on V clips

* on an A clip, and on a V clip that plays its own sound (`audio: true`; the
  flag does nothing without it). Order: speed/reverse, `denoise`, `loudnorm`,
  then the clip's `gain_db` and fades, then ducking and the mix. So `loudnorm`
  evens out the clip and `gain_db` is an offset on top of that level.
* `denoise`: adaptive FFT noise reduction. It clears a steady background hiss
  quieter than about -35 dB (a quiet room: measured 19 dB or more) and leaves
  the voice or tone beside it alone; steady noise LOUDER than that is mostly
  left as it is. Say "reduces background hiss" in the product, not "removes
  all noise".
* `loudnorm`: single-pass loudness normalisation to -16 LUFS (true peak
  -1.5 dB). Two clips of very different levels come out within 2 dB of each
  other. On a very short clip (under a few seconds) the measuring window is
  short, so the result is approximate. Speech and music both go to the same
  target, so use it per clip on purpose (a ducked music track normalised to
  -16 LUFS is as loud as the voice before ducking).
* a clip's length never changes.

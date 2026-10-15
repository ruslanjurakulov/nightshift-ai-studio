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
| 8 | `claude/render-crop` | V clip `crop` rectangle, free `angle` | PR open (stacked on 7) |
| 9 | `claude/render-speed-ramp` | V clip `speed_curve` (2-6 points), `interpolate` | PR open (stacked on 8) |
| 10 | `claude/render-stabilise` | V clip `stabilize` | PR open (stacked on 9) |
| 11 | `claude/editor-shapes` | top-level `shapes` (stickers, shapes, progress bar) | PR open (on main) |

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

Limits that come from memory and disk (measured, the validators refuse them):

* a clip that is CROSS-FADED (either side of a blend) in a frame above 1440p
  (2560x1440, either way up) takes NO `blur`: a cross-fade on 4K60 already needs
  about 1.75 of the worker's 2 GiB, and a blur failed it ("Cannot allocate
  memory") with ffmpeg 7.0.2 at every sigma tried and with 5.1.1 from sigma 30.
  The other effects (look, sharpen, grain, vignette, turns) passed with both.
  `LARGE_FRAME_PX` / `XFADE_LARGE_BLUR_MAX` (0) in `lib/editor.ts`; a UI should
  disable the blur control on such a clip. Single clips and hard cuts are fine.
* `grain` makes the intermediate video about 13x bigger (42.7 MB/s at 1080p30,
  73 MB/s at 1080p60). The disk guard charges grainy seconds 12x and falls back
  to compact intermediates (slower) when the temp disk is short; nothing for the
  UI to do, but a long grainy export is slower on a nearly full disk.
* KNOWN ISSUE (harmless): where a millisecond rounding lands exactly on a half
  millisecond, Python `round(x, 3)` (half to even) and JavaScript
  `Math.round(x * 1000) / 1000` (half up) can differ by 0.001 s. The editor side is
  the stricter one for the checks that use it (reverse limit, budgets), so a
  document it accepts the backend accepts.
* `rotate` is an integer; `90.0` is accepted as `90` (the editor cannot tell them
  apart after JSON.parse).

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
* MEMORY LIMIT: the fitted picture is scaled up to `zoom` x the frame on every
  frame, so a zoom is refused above 2 (`XFADE_LARGE_ZOOM_MAX`) on a CROSS-FADED
  clip (either side of a blend, either keyframe) in a frame above 1440p
  (2560x1440, either way up): a cross-faded 4K60 clip failed at a zoom of 3 with
  ffmpeg 7.0.2 under the worker's 2 GiB limit (up to 2 passed with both 7.0.2 and
  5.1.1; 5.1.1 alone passed 4). A single clip or a hard cut zooms to 4 at any
  size (measured at 4K60), and so does any frame up to 1440p. A UI should clamp
  the zoom control for such a clip. (Cutting the window first and scaling it
  would avoid the big frame, but ffmpeg's `crop` size cannot change per frame and
  `zoompan` rounds the window to whole pixels, which jitters; the cap keeps the
  exact, smooth zoom the preview shows.)

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
  rendered per pixel (`geq`: 3.6x slower for one video overlay, 13x for four,
  out of memory at 4K60), so at most TWO overlays per document may move between
  two visible opacities (`MAX_PARTIAL_OPACITY_MOVES`, `partialOpacityMove()` in
  `lib/editor.ts`); the validators refuse a third.
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
* Pixel shape: a `blur` clip comes out with SQUARE pixels (the chain ends with
  `setsar=1`; without it the scaler's rounding left e.g. 1697:1711 for a 16:9
  clip in a portrait frame and a player would stretch it). KNOWN ISSUE, not
  changed here: the legacy `contain` chain (scale + pad, in use before any of
  this work) can leave a non-square sample aspect ratio on main too (measured
  1216:1215); touching it would change every older document's command, so it is
  left alone and listed for the owner. Chains of the new fields (`blur`, turns,
  crop, effects that turn) add `setsar=1` themselves.

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
* a PICTURE that has transparency of its own (a PNG sticker) keeps it: the
  backend multiplies the key's alpha by the picture's own, so keying only ever
  removes more. A VIDEO overlay with an alpha channel (a WebM with alpha) does
  not: the key replaces its alpha, so do not key a video that is already
  transparent (it is rare; the UI need not special-case it).
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

## 8. Crop and free-angle rotation

### `crop` (V clips, video and stills)

```json
"crop": { "x": 0.25, "y": 0.1, "w": 0.5, "h": 0.8 }
```

* a rectangle of the SOURCE picture as fractions of it: `x`,`y` the top-left
  corner (0 to 1; defaults 0), `w`,`h` its size (0.05 to 1; defaults 1).
  `x + w` and `y + h` must not exceed 1 (refused otherwise). The whole picture
  (0, 0, 1, 1) is dropped on save.
* it is taken AFTER `rotate`/`flip_*` (so it is the rectangle of the picture the
  user sees once turned/mirrored) and BEFORE the fit: the cropped part is what
  is fitted to the frame (`contain` bars, `cover` fill, `blur` background all
  work on the cropped picture). Sizes are rounded down to even pixels.
* a crop of a landscape clip to a portrait window in a portrait frame fills
  it with `fit: "cover"` (or by `contain` if the window has the frame's shape).
* a split keeps the same crop on both halves; a `move` (Ken Burns) zooms into
  the cropped, fitted picture.

### `angle` (V clips), degrees clockwise, -180 to 180

* turns the FITTED picture about the centre of the frame. The frame keeps its
  size: what leaves it is cut, what the turn uncovers is black (a layer
  turned in the frame; it does not straighten-and-crop). Positive = clockwise.
  0 is dropped on save.
* separate from `rotate` (0/90/180/270), which turns the SOURCE before the
  fit and re-fits it (so a landscape clip becomes a portrait picture with bars);
  both can be set (the quarter turn first).
* with `fit: "blur"` the whole composed frame turns, background included; a
  `move` zooms into the turned frame.
* a 45 degree turn of a picture that fills the frame leaves black corners; the
  UI may suggest a zoom (`move` or a `cover` fit of a crop) to hide them.

## 9. Speed ramps (`speed_curve`) and interpolated slow motion (`interpolate`)

### `speed_curve` (V clips, video only)

```json
"speed_curve": [ {"at": 0, "speed": 1}, {"at": 0.5, "speed": 4}, {"at": 1, "speed": 0.5} ]
```

* 2 to 6 points. `at` is a fraction (0 to 1) of the SOURCE range `in_s`..`out_s`;
  the first point must be at 0 and the last at 1, in increasing order and at
  least 0.01 apart. `speed` 0.25 to 4. Between two points the speed changes
  linearly (a smooth ramp, not steps); a flat pair is a constant stretch.
* it REPLACES `speed`: leave `speed` out (or 1). Not with `reverse` or `freeze`.
  Setting a constant speed in the editor (`setSpeed`) drops the curve.
* the clip lasts the integral of 1/speed over its range, e.g. the example above
  on a 4 s range lasts 2.112 s. Use `clipLength(clip)` / `clipEnd(clip)` from
  `lib/editor.ts` (they know curves); `rampOutTime` / `rampSourceAt` in
  `lib/editorSpeedRamp.ts` convert between source time and timeline time (for a
  preview scrubber, a speed graph, a time-remap display).
* SOUND FOLLOWS (it is not muted): with `audio: true` the clip's range is cut into
  equal slices (about one per half second, 2 to 16), each played at the tempo that
  makes it last exactly as long as the picture does there, pitch kept. The sound
  is therefore on the picture at every slice boundary; inside a slice the speed
  is the average, so a steep ramp on a short clip is stepped, not smooth.
  Everything stays within 0.25 to 4, so nothing is dropped for exceeding atempo.
* SYNC IS EXACT ONLY AT THE SLICE BOUNDARIES, and there are at most 16 slices
  (`SLICES_MAX`), so on a long range each slice is longer than half a second and
  the sound can be off the picture BETWEEN boundaries: the worst measured offsets
  of a steep ramp were 0.15 s on a 10 s range, 0.44 s on 30 s and 1.7 s on 120 s
  (it is back to zero at every boundary and at the end, so the clip's length and
  what follows are not affected). Say so in the product (or keep ramps on clips
  of a few seconds, where it is under a frame or two); a gentle ramp is much closer.
* the ramp's expression is printed with 9 decimals (12 for the slope), and two
  speeds that differ by less than one part in ten million count as the same
  speed, so a very slight ramp still renders and nothing drifts over an hour.
* a clip with a curve CANNOT be split (the editor's `canSplit` is false, the
  backend's `split_clip` refuses): remove the curve first. Trimming it changes the
  range, and so the shape in time, the points stay at the same fractions.
* known approximations in OTHER helpers: `wordsOnTimeline` (captions import) and
  the trim-snap helper still use the scalar `speed` (1 for a curve clip), so
  imported caption times on a curved clip are off; do not offer auto-captions on
  such a clip until they learn about curves.
* DATABASE: `editor_doc_duration` (migration 0054) computes a clip's length from
  `speed` only, so the 30-minute check at request time does not see a curve. The
  worker recomputes the real length (`tl.duration_s`) and refuses an export longer
  than `EXPORT_MAX_S` (1800 s) itself (modules/editor_export.py), so a curve
  cannot get a longer render through; the answer to the user comes from the
  worker instead of from the request. NO migration is written here.

### `interpolate` (boolean, V clips)

* smoother slow motion: ffmpeg motion-compensated interpolation makes the
  in-between frames before the clip is retimed. Only valid when the clip plays
  below speed 1 somewhere (a constant `speed` under 1, or a curve with a point
  under 1); not with `reverse`/`freeze`.
* it is SLOW (about 3 frames per second at 1080p on a busy 4-core machine), so
  the budget is hard: the frames it has to make (the range at the interpolated
  rate `min(120, ceil(fps / slowest speed))`) times the frame size, counted as
  1080p-equivalent frames, must be at most 300 per clip and 600 per document.
  Examples at 30 fps, 0.5x: 5 s of source at 1080p, 11.2 s at 720p. The validator
  names the limit; `interpolatedFrames()` in `lib/editor.ts` computes it for a UI
  that wants to disable the switch or warn before saving.
* the budget is ALSO in ESTIMATED SECONDS and must fit the worker's timeout: each
  1080p-equivalent frame is charged `INTERP_SECONDS_PER_FRAME` (0.4 s; measured
  0.39 s on a loaded box, so one clip of 300 is about 117 s), the timeline itself
  `RENDER_PLAIN_FACTOR` (1) s per second, and the total must be at most the
  worker's `renderTimeoutS(length)` = `min(5400, 3 x length + 120)` seconds
  (`RENDER_TIMEOUT_*` in `lib/editor.ts`). So two clips that are each inside the
  per-clip cap can still be refused on a short timeline ("would take about 255 s
  to render, but a 20 s timeline is allowed 179 s"): slow less of it or make the
  timeline longer. A UI can show the estimate with the same constants.
* NOT OFFERED ABOVE 1440p: a frame of more than 2560 x 1440 pixels (either way
  up, `INTERP_MAX_PIXELS`) is refused ("interpolate is not offered above
  1440p"): a 4K render died with "Cannot allocate memory" under the worker's 2 GiB
  limit. Disable the switch for those projects; plain slow motion is unaffected.
* the source frames are first taken at the project's frame rate, then
  interpolated: a 24 fps source in a 30 fps project is interpolated from the
  30 fps (duplicated-frame) version, which is smoother than nothing but not
  ideal; a source at the project's rate is best.

## 10. Stabilise (`stabilize`, boolean, V clips)

* smooths camera shake. A toggle, no strength: the UI offers an on/off switch
  and says it takes longer to export.
* which method runs is decided by the worker's ffmpeg build, not by the
  document: with libvidstab (the bundled static ffmpeg 7.0.2 has it; the Debian
  `ffmpeg` package the worker image installs is built with it too) it is two
  passes: a detect pass over the clip's source frames, then a smoothed path with
  an automatic zoom (`optzoom=1`) so no moving border shows. A build without
  vidstab gets ffmpeg's single-pass built-in `deshake`, which is much weaker
  (measured on a synthetic shaky clip: vidstab removes about 70 % of the frame to
  frame motion, deshake about 35 %). The method is not reported to the user;
  if you need to, ask the worker (`render_backend.stabilizer(ffmpeg)`).
* the first pass is a real extra decode of the clip, so the budget: a stabilised
  clip's source range is at most 120 s and a document's stabilised ranges at most
  300 s in all (validators, same numbers: `STABILIZE_MAX_S`, `STABILIZE_MAX_DOC_S`).
* the budget is ALSO in ESTIMATED SECONDS, weighted by frame size, and must fit
  the worker's timeout (the same rule as `interpolate`, and they add up). Measured
  on the shared 4-core box, detect + transform ran at 9.6 frames per second at
  1080p30 and 1.75 at 4K30; 7 frames per second of 1080p-equivalent frame
  (`STABILIZE_FPS_1080P`, `stabilizeSeconds()` in `lib/editor.ts`) is charged, so a
  minute of 1080p30 is about 257 s and a minute of 4K30 about 1030 s, plus the
  timeline itself, against `min(5400, 3 x length + 120)` s. So 60 s of 1080p
  stabilised on a 60 s timeline is refused ("stabilising would take about 317 s to
  render, but a 60 s timeline is allowed 300 s"), and so is 60 s of 4K; stabilise
  less of it or make the timeline longer. A UI can show the estimate. The
  `deshake` fallback is for a build without vidstab, not a way to make a slow clip
  fit.
* video only; not with `freeze`. It runs on the source frames, right after
  `rotate`/`flip`/`crop` and before speed, fit, effects and `angle`.
* if the detect pass cannot run, the export FAILS (it is never quietly exported
  unsteadied).
* an automatic zoom crops a little of the edges: say so in the product.

## 11. Shapes, stickers and a progress bar (`shapes`)

A drawn sticker is a document entry, not a library file: a top-level `shapes` list beside `overlays`.
Free (ffmpeg and Pillow only; no provider, no art from anywhere, no migration: a shape has no
`asset_id`, so `editor_doc_problem` passes it, and no field of a shape may ever be named
`asset_id`). Absent or empty = today's document and the same commands.

```json
"shapes": [
  { "id": "h1", "kind": "arrow", "start_s": 1, "end_s": 4, "x": 0.2, "y": 0.3, "w": 0.2,
    "dir": "up", "color": "#FF3B30", "opacity": 0.9, "anim_in": "slide-left", "anim_in_s": 0.4 },
  { "id": "h2", "kind": "pill", "start_s": 0, "end_s": 5, "y": 0.82, "w": 0.32, "text": "Subscribe" },
  { "id": "h3", "kind": "progress", "start_s": 0, "end_s": 12, "edge": "bottom", "thick": 0.012 }
]
```

`kind` is one of `arrow`, `circle`, `rect`, `star`, `pill`, `line`, `progress` (closed list,
`SHAPE_KINDS` in `lib/editorShapes.ts` / `modules/shape_art.py`; a test pins them). Every shape has
`id`, `kind`, `start_s`, `end_s` (required) and `color` (`#RRGGBB`, the shared hex pattern; default
`#FFD60A`), `opacity` (0-1, default 1), `anim_in` / `anim_out` / `anim_in_s` / `anim_out_s` (the
overlay's lists and rules: no typewriter, in + out inside the time shown). The rest depends on the
kind, and the validators refuse a field the kind does not take ("`outline` does not apply to a arrow"):

| kind | fields | what it draws |
|------|--------|---------------|
| `arrow` | `x` `y` `w` `dir` (`right`/`left`/`up`/`down`, default right) `move` | a block arrow, 2:1 (1:2 up or down) |
| `circle` | `x` `y` `w` `outline` `move` | a disc, or a ring with `outline` |
| `rect` | `x` `y` `w` `outline` `aspect` (width / height 0.2-5, default 1.6) `move` | a rectangle, solid or a frame |
| `star` | `x` `y` `w` `outline` `move` | a five-point star, solid or outlined |
| `pill` | `x` `y` `w` `outline` `text` (required) `move` | a rounded label with words |
| `line` | `x` `y` `w` `thick` `move` | an underline with round ends |
| `progress` | `edge` (`bottom`/`top`, default bottom) `thick` | a bar as wide as the frame |

* **Position and size are the picture overlay's model**: (`x`, `y`) is the CENTRE and `w` (0.05-1) the
  width, as fractions of the frame; the height follows the kind. The export draws the shape at that
  size into a PNG (so it is sharp) and lays it with the overlay path: opacity is the same cheap
  channel multiply, `anim_*` are the same filters, `move` is the same linear move. A shape's
  height is cut to the overlay filter's box (twice the frame's height): a full-width UP arrow in a
  16:9 frame is therefore smaller than `w` asks.
* `outline` (0-0.5 of the shape's shorter side; 0 or absent = solid). On a `pill`, an outline draws
  the box as a border and the text takes `color`; a solid pill takes a contrasting text colour
  (black or white by luminance, fixed threshold).
* `thick` (0.002-0.05) is a fraction of the frame HEIGHT: a line's thickness, the bar's height
  (made even, at least 2 px; 0.012 of 720 is 8 px). Defaults: line 0.008, bar 0.012.
* **`pill` text** is at most 24 characters (code points; `SHAPE_TEXT_MAX`), not blank, and only of
  characters the worker's font really draws: Basic Latin, Latin-1 and Latin Extended letters, the Uzbek
  apostrophes (U+02BB, U+02BC), Cyrillic (U+0400-U+0525), dashes, quotation marks, bullet, ellipsis, euro,
  tenge and numero (`TEXT_RANGES`, a closed rule shared by both validators and pinned by
  `samples/shape_text_cases.json`, 1,600 texts with the worker's verdict). Anything else (emoji, CJK,
  Arabic, Greek, combining marks, invisible fillers such as U+3164, no-break space, tabs and line
  breaks) is refused with "text can only use Latin and Cyrillic letters, digits and common
  punctuation": the font would draw an empty box and the exported label would silently differ from
  what was typed. The worker also compares every character with the font's empty box while drawing and
  stops the export with a named message if it ever meets one (another font). The editor's text box leaves
  such characters out and says so. The text is typed or one of the editor's ready labels
  ("Subscribe", "New", "Link below", "Part 2", in the person's language). It reaches the export as
  PIXELS: the worker cleans it with the same `ass_captions.escape_text` the text overlays' words get
  (braces to parentheses, backslash to slash, white space collapsed), draws it with the bold
  DejaVu/Liberation font and never writes it into a filter graph or a file name; the preview shows the
  cleaned words too. A missing font stops the export BEFORE any segment is encoded, with a message that
  names the fix (`fonts-dejavu`), never a bitmap fallback.
* **The progress bar** takes only `edge` and `thick` (no `x`, `y`, `w`, no move) and a fade as
  `anim_in` / `anim_out`. It is as wide as the frame and fills from the left across
  `start_s`..`end_s` by the clock: EMPTY on its first frame, FULL on its last. How: a bar-shaped PNG
  the width of the frame is laid with `overlay=x='round(W*(clip((t-t0)/d,0,1)-1))'`, so the part
  inside the frame is `t / length` of its width. (`drawbox` cannot animate its width on the ffmpeg
  builds the worker may have; `x` of `overlay` is evaluated per frame on all of them.) Measured at
  30, 24 and 60 fps. If the picture ends before `end_s`, the bar is cut where the picture ends and
  never gets full: the editor warns ("runs past the end") and offers "Fill the whole video" and "Fill the
  clip at the playhead".
* **`move.to`** takes `x`, `y`, `w` only. There is no opacity move on a shape (fade it with
  `anim_in` / `anim_out`), so shapes never use the per-pixel `geq` opacity path and the
  `MAX_PARTIAL_OPACITY_MOVES` (2) budget of section 4 is untouched: it counts overlays only.
* **Limits**: at most 12 shapes (`MAX_SHAPES`), and `overlays` + `shapes` together at most 16
  (`MAX_OVERLAYS`): each is one more input of the final pass ("overlays and shapes together: at most
  16"). The editor counts both (`layerCount`, `canAddShape`, and `canAddOverlay` now counts shapes
  too). A shape never lengthens the timeline (what runs past the picture is cut).
* **Memory budget** (`shape_art.memory_estimate_bytes`, `memoryEstimateBytes` in `lib/editorShapes.ts`,
  refused early by both validators as "shapes: drawing them in a WxH frame would need about N MB to
  render [with the picture overlays], but M MB is the most the export has ... (memory)"). It is charged
  to a document WITH shapes; one without is budgeted by nothing new. Measured with the bundled ffmpeg
  7.0.2 under the export's own limit (2 GiB of address space, `jobs=1`, a timeout set: the worker's path)
  by binary search on the limit, about 80 documents of circles in five frame sizes,
  with and without full-frame pictures.
  * **Why the layers' threads are pinned.** Left automatic, what ffmpeg starts per layer grows with the
    machine's cores: a decoder with frame threads and a filter thread pool for every PNG (62 threads at twelve
    shapes on four cores, 13 pinned), each thread a stack of address space under the limit. The same twelve
    circles at `w` 0.8 in 1080p60 needed 1767 MiB on four cores and 1346 on one, so a fit on one machine was
    the CI runner's exit 187 (a libx264 malloc) on another. A command with shapes therefore runs the filter
    graph (`-filter_threads`, `-filter_complex_threads`) and the decoder of every picture and shape input
    (`-threads`) on ONE thread (`render_spec.cap_inputs(single_thread_inputs=...)`); the clips' input and the
    encoder keep theirs. The same document needs 1351 MiB on one core, 1378 on two and 1351 on four. A
    document without shapes keeps exactly the options it has always had (a test compares them).
  * **The fit** (pinned): up to 2560x1440 about 354 MiB + 273 bytes per pixel of the frame, above it (the encoder
    has 2 threads and a lookahead of 20, `ffmpeg_limits.LARGE_OUTPUT_PX`) about 24 MiB + 200 bytes per pixel; plus
    21 MiB per layer and 9 bytes per pixel of its PNG. A PICTURE OVERLAY is a layer like a shape: it is charged
    its box, as wide as it ever is (a move to a bigger `w` counts) and as tall as the frame, because the
    document does not know the picture's own size. A picture whose own pixels are many times its box (a big photo
    shrunk to a corner) is therefore not covered; it stays held to the decoder's cap as before. The constants
    are that fit rounded UP by about 100 MiB (never below any of the 25 points the test lists), and the budget keeps 150
    MiB under the 2 GiB besides: every document the budget accepts had been measured at 1776 MiB or less.
  * **What it decides** (1080p60 unless said): twelve circles at `w` 0.8, with 1, 2 or 4 full pictures at 0.85,
    eight shapes with eight full pictures, and 1440x2560 with twelve circles at 0.6 or twelve mixed kinds at
    0.75 all pass and are rendered under the limit by `tests/test_editor_shapes.py` (what the reviewer and the CI
    runner had seen fail before the threads were pinned); 1440p with twelve circles at 1.0, eight shapes at 0.8
    with four full pictures, and eight at 1.0 with eight full pictures are refused. A sampled test finds, for five
    frames and a few mixes, the widest shapes the validator accepts and renders each under the limit.
  * **Above 1440p** (3840x2160, 2160x3840): the plain clip alone needs about 1650-1700 MiB, so only a few small
    shapes pass (three circles at `w` 0.2 do, four do not, twelve at 0.3 need 2068). That over-refusal is
    deliberate and safe: the studio offers 1080-based presets, so a 4K frame comes from a saved document or the
    API.
  A shape's PNG is its whole picture at the widest it ever is (a move to a bigger `w` scales down from it) and a
  PILL is charged as a box of aspect 0.9 (an upper bound that needs no font). A clip that also
  cross-fades or blurs at a large frame (their own limits) is not added up with it. A PNG is not cut to the
  frame (a 16:9 circle at `w` 1.0 is 1920x1920, taller than the frame): cutting it would change the layout
  of a shape that moves or pops, so the budget charges the real size instead. Where the budget is met the
  editor stops: a shape stops growing at the limit, the one being added is narrowed to fit or refused with
  the numbers (role="status"), a picture is narrowed or not added when the shapes leave it no room (it says
  so), the inspector says how much of the budget the shapes use once it is 60% or
  more, and settling after a frame change narrows the widest shapes (then removes the last, said, undoable).
* **Render time** is charged like interpolation and stabilising, against the worker's timeout
  (`render_timeout_s` = min(5400, 3 x length + 120)): per layer, per OUTPUT frame, whatever the layer's span
  (a layer is an `overlay` pass over every frame; one shown for 10% of a clip cost 90% of the same), 2.5 ms
  per 1080p-equivalent frame plus 1.0 ms per megapixel of its PNG. Measured on a quiet box (ffmpeg 7.0.2, 1080p
  30 fps, 10 s, twelve layers of every kind with pop, fade and move): 0.6 / 0.8 ms per layer-frame for 0.3 / 1.3
  MP PNGs, 0.5 ms at 60 fps; a reviewer's loaded box saw 5.5-5.8 ms (twelve 3 MP layers, 20 s: +42 s at 30 fps,
  +80 s at 60 fps) and the charge is that loaded figure (the same way `INTERP_SECONDS_PER_FRAME` was set). A
  document is refused when `length + interpolation + stabilising + shapes` is over the allowance ("the shapes
  would take about N s to render ... (render time)"), so twelve 0.6-wide layers at 1080p60 pass on 20 s and are
  refused on 10 minutes, and the same at 30 fps pass. It counts shapes that render something (opacity above 0,
  starting before the end). In the editor the same sum is `renderWork().shapeEst`, so the notice under the
  toolbar, adding and growing a shape and settling all use it.
* **Layering**: shapes are drawn after the pictures (so over them), under the texts and captions;
  list order is the layering among shapes.
* **Worker**: `modules/timeline_render._shapes` turns each shape into a `PictureOverlay` carrying a
  `ShapeArt` (path empty); `render_backend.draw_shapes` writes the PNGs into the render's temp
  directory and fills the paths in; the rest is `picture_overlay_filters`. The command of a
  document without shapes is unchanged (the existing digest tests, plus a new one with an empty list,
  an invisible shape and one after the end).
* **ffmpeg versions**: every pixel test passes with the bundled static 7.0.2 and with 5.1.1. The memory
  and time figures above are 7.0.2's (what `resolve_ffmpeg` picks); 5.1.1 needed less memory in the
  few cases tried (it passed seven 4K60 layers that 7.0.2 could not). The
  only filters used are the overlay path's own (`scale`, `format`, `colorchannelmixer`, `fade`,
  `tpad`, `overlay`) plus the `x` expression above; nothing in it is version-sensitive that was
  seen. Pillow is a worker dependency (requirements.txt, `Pillow>=12.3.0`).
* **Known approximations** (not bugs): the pill's text is anti-aliased and a pill's width comes from
  the font's real metrics, which the browser cannot know (the preview estimates it from the character
  count, within about 15% for ordinary words); a star's outline is drawn inset by a fixed factor;
  at frame sizes where a canvas would pass 24 million pixels while drawing, anti-aliasing is
  reduced (a full-width circle in a 4K frame has plain edges).

## Editor controls (track C)

Where a person finds each field in the editor. The controls read their limits
from `lib/editor.ts`, clamp in the browser and leave the final word to the
validators; every change is one undo step (a slider drag too), is carried by the
local draft and by Save, and an "off" value removes the field so an untouched
project keeps exactly its document.

| Field(s) | Control | PR |
|----------|---------|----|
| text and overlay `anim_in/out(_s)` | "Entrance and exit" (`AnimPicker`), in the text and overlay inspectors | C1 |
| `filter`, `filter_strength`, `vignette`, `blur`, `sharpen`, `grain`, `flip_h/v`, `rotate` | "Look and effects" (`ClipEffectsSection`) | C1 |
| `crop`, `angle` | "Crop and tilt" (`ClipCropSection`) | C1 |
| clip `move` | "Zoom and pan" (`ClipMoveSection`): presets, start and end windows, a map | C2 |
| overlay `move.to` | "Move to an end position" (`OverlayMoveSection`) | C2 |
| clip `fit: "blur"` | third key of "Picture in the frame" (`FitPicker`); `fitOf()` reports it | C2 |
| clip `speed` 0.25-4, `reverse`, `freeze` | "Speed" keys + number box, "Direction, freeze and slow motion" (`ClipSpeedSection`), "Freeze the frame at the playhead" | C2 |
| overlay `chroma` | "Remove a background colour" (`OverlayChromaSection`): ready screens, colour box, code, screen picker where the browser has one, how much, softness | C3 |
| `denoise`, `loudnorm` | "Steady picture and clean sound" on a clip (`ClipCleanSection`), "Clean up sound" on a music / sound clip | C3 |
| clip `stabilize` | toggle in "Steady picture and clean sound", with the cost, the limits and the project's use | C3 |
| clip `speed_curve`, `interpolate` | "Speed curve" (point rows and a plot), "Smoother slow motion" with its budget | C2 |
| `shapes` | "Add shape" beside Add overlay and Add text: a picker of seven tiles (radio group, 44 px) and an inspector per kind (`ShapePanel.tsx`) | E |

Preview: look (curve tables as an SVG filter, pinned to
`samples/clip_look_curves.json`), blur, vignette, turn, mirror, crop, free angle
and the entrance / exit at the playhead are drawn approximately; sharpen and film
grain are not drawn. The note under the preview says the exported file is the
reference.

C2 guard rails, as the UI enforces them (each says why on the screen): backwards
play is off for a part longer than the memory cap (`reverseLimit`, whole frames,
so a range it allows always validates; trimming a backwards clip stops there); a
frozen clip has speed 1, no sound and none of backwards, curve, interpolation or
stabilise; a speed curve replaces speed, backwards and freeze, and such a clip
cannot be split (the reason is shown) and gets no auto-captions (nor does a
backwards one); smoother slow motion is off with the numbers when the part is not
slow, is backwards or frozen, or would pass the per-clip / per-project frame
budget (`interpolateCheck`, the longest part that fits is shown), and trimming a
clip that uses it stops at the budget. A reversed, frozen or ramped clip is
stepped through frame by frame in the preview (no sound).

C3 notes: the chroma preview (`lib/editorChromaPreview.ts`) is the export's
`chromakey` rule as an SVG filter (distance in the two chroma planes only,
`diff = sqrt((du^2 + dv^2) / 2)`, alpha ramp `(diff - similarity) / blend`), pinned
by a test that runs the filter's own arithmetic against the definition; it is
rough, and the panel says the exported file is the reference. Clean-up and
stabilise are not shown in the preview (the note says so). Stabilise is off, with
the numbers, for a photo, a frozen frame, a part over `STABILIZE_MAX_S` or a
project total over `STABILIZE_MAX_DOC_S`; trimming a steadied clip stops at what
is left; freezing a clip turns steadiness off.

C1 limits mirrored in the UI after the engine's last changes: the room for an
animation counts a text's plain fade on the other side (the validator refuses an
animation plus the other side's fade longer than the time shown; shortening a text
shortens the animation, and drops it when nothing is left); blur is off, with the
frame size said, on a cross-faded clip in a frame above 1440p (`LARGE_FRAME_PX`,
`XFADE_LARGE_BLUR_MAX`).

C2 limits mirrored in the UI after the engine's last changes (all from the shared
constants, none copied): the reverse limit is the validator's own whole-frame
number (`reverseMaxSeconds`); smoother slow motion is judged by its per-clip and
per-project frame budgets, by "not above 1440p" (`INTERP_MAX_PIXELS`) and by the
export's time allowance (`renderWork()`: the timeline's length + 0.4 s per
interpolated 1080p frame + the steadying estimate, against `renderTimeoutS(length)`),
and the panel shows the estimate and the allowance; after any edit that changes a
clip's speed or length its smoothing / steadying is switched off if it no longer
fits, a notice under the toolbar names the numbers when a document does not fit
(a shorter timeline, for example), and trimming such a clip stops where it last
fitted; a zoom above `XFADE_LARGE_ZOOM_MAX` is off on a cross-faded clip in a frame
above 1440p; an overlay can change opacity between two visible values only while
fewer than `MAX_PARTIAL_OPACITY_MOVES` others do (past that the control offers
"keep" and "fade to clear"); the speed curve says that sound is in step with the
picture only at a few points along a long clip.

C3 limits mirrored in the UI after the engine's last changes: stabilise is judged by
the per-clip and per-project seconds AND by the export's time allowance
(`stabilizeCheck()` -> `renderWork()`: the timeline's length, interpolated frames and
`stabilizeSeconds()` against `renderTimeoutS(length)`), so a minute of 1080p30 on a
minute-long timeline is off, with "about 317 s to render, but 300 s allowed" on the
screen, and the hint states what a minute costs at the project's frame size; the
chroma hint says a picture's own transparency is kept and that a video that is
already transparent should not be keyed.

Settling after any edit (`lib/editorSettle.ts`, applied by the editor to every edit):
some limits depend on something other than the clip a control belongs to, so a
frame shape, a deleted or shortened clip, a new cross-fade or a speed change can push
a clip that was fine over one. The policy, the same everywhere: a backwards part is
shortened to the new whole-frame limit; smoothing and steadying that no longer fit
(per-clip, per-project or the export's time allowance, dearest first) are switched
off; a blur on a cross-faded clip in a frame above 1440p is removed and a zoom
lowered to the cap. The editor says exactly what it changed in a polite live region
and one Undo returns it; a document that is fine is left alone. Trimming an edge
re-asks the validator itself (frame counts are taken on the stored float
difference) and steps in by a millisecond until it is satisfied.

Shapes (track E): the entry is "Add shape"; the picker is a radio group of visual tiles (arrow, circle,
rectangle, star, label, line, progress bar) with an "Add to video" button, and the inspector's "Shape"
group changes the kind in place (span, colour and opacity are kept; the new kind's own look starts
fresh). Per kind: ready colours and a colour box and a typed code (a bad code is said, in a polite
status, and not taken), start / end and "Start at the playhead", position / size / opacity sliders and
the arrow keys on the selected frame in the preview (drag too), outline, width-to-height, direction,
thickness, edge, the label's text with four ready labels (an empty box keeps the last words and
says so), a move to an end position and entrance / exit (a bar: a fade only). Limits are said where
they apply (role="status"): the shapes limit, the shared layers with the pictures, and a shape that
would not show. Every edit is one undo step (a slider drag or a run of arrow presses is one) and
goes through the same `settleAll`: the export's memory and time budgets depend on the frame size and the
timeline, so a frame change or a shorter timeline can push shapes over them, and settling then narrows the widest
shapes and, only if even the narrowest do not fit, removes the last (said in the polite notice; Undo returns
them). A 400-step fuzz test (edits, frame changes between 1080p and 4K, other overlays) checks that no edit
leaves a document the validators refuse.
Preview: the same polygons as SVG (close to exact), the progress bar's fill at the playhead, the
entrance / exit roughly; the note under the preview says the exported file is the reference, and the
label's width is an estimate.

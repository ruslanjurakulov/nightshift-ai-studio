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

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

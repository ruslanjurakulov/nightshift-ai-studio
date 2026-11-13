# Site motion: the interaction layer on the public pages

Status: round 11, on top of the AI-studio landing (#726). Code: `command-center/components/site/site-motion.css` (everything
visible) and `command-center/components/site/motion/` (the script half: `SiteMotion.tsx`, `attach.ts`, `env.ts`,
`geometry.ts`, `nav-intent.ts`, `ModelMarquee.tsx`). Contract tests: `command-center/tests/site-motion.test.tsx`.

## Why this differs from MOTION.md and IDENTITY.md

`MOTION.md` §1 and `IDENTITY.md` §8 rule out parallax, glow, blur and anything that runs constantly, and round 7B removed a slow
drift over the stills. The owner asked for the public site to move and respond like the AI-studio sites it competes with
(dark-first, glossy, a lot of motion). This round does that **on the public pages only** (`.nx`, and `.st` for the shared
header and keys); the app keeps MOTION.md unchanged. The push-in on the hero is not 7B's drift: it moves the box that holds
both the still and the clip, and stops when the clip plays, so the cross-fade is never a cut between two framings.

## What each page got

| Where | What |
| :-- | :-- |
| Every public page (header, keys) | From 1024 px the sticky header turns to frosted glass and a visually slimmer bar once scrolled (a scaled backdrop layer, the row lifted 4 px: the box keeps its height). The primary keys (`.nx-btn`, `.st-key`) get a turning gradient edge, one sheen per hover, a wider glow, the existing press scale, and a magnetic pull of at most 6 px on a mouse. A key that opens another page shows a small ring in place of its arrow until the page arrives. |
| `/` | A slow push-in on the hero's still until its clip plays; up to 8 px of parallax on a mouse; glass pills for the closing panel's secondary actions; film grain on the hero, the explore grid and the closing panel; an aurora behind the explore grid; a pointer spotlight across the grid and a lean-in with a sweep of light on each card; a strip of the model names between the grid and the model tiles; the facts count up once; a gradient hairline atop each section. |
| `/pricing`, `/solutions`, `/studio` | The header, keys, section hairlines and the existing reveal. |
| `/mcp` | The header and keys, and its landing sections now ease in like the other pages'. |
| `/login`, `/signup` | The keys, and film grain on the stage. |

## Rules (each one tested)

- Nothing moves under `prefers-reduced-motion: reduce`; every repeating animation stops with "Pause motion"
  (`html[data-motion="paused"]`); the scripts ask on every event, so the switch works mid-page.
- Transforms and opacity only: no box changes size or place, so CLS stays 0. Nothing is hidden at first paint; the hero's
  still is still the LCP element and loads exactly as before.
- Pointer-follow effects only for a fine pointer that can hover on a screen of 1024 px or more: a phone gets the light
  version, and a tap never leaves a key pulled aside.
- The scripts write CSS variables and data attributes only. Keyboard order, focus rings (the 3 px outline) and what a screen
  reader reads are unchanged: the count-up draws over the server's number, which stays in the page; the models strip is
  hidden from assistive technology because the tiles under it say the same names once; the "loading" ring is visual only.
- No invented numbers: the count-up only animates a plain integer the server already printed, and only one that starts
  below the fold.

## Larger files

The site's clips are 720p to 768p. `ShowcaseFiles.lg` (lib/site/showcase.ts) lets an entry carry a larger rendition with its
true width when the model made one; `lib/site/renditions.ts` then adds it to the still's `srcset` and plays its clip on a screen
with at least 1600 device pixels across and a fast link. No entry has one today, and nothing is upscaled: the exporter
(`tools/export_showcase.py`) still writes the 640 and 1280 files only, and emitting `lg` is a follow-up once a model's real
output is larger than 1280.

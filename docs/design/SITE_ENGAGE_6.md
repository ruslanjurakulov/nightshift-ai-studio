# Site engagement, round 6

Six stills and code only; no new generation, no new dependency, CSP unchanged, signed-in app untouched. Screenshots in
`site-engage-6/before` (main, e15bb1c0) and `site-engage-6/after`.

## 1. One idea per page

| Page | What it has now |
| :-- | :-- |
| /solutions | A tabbed audience switcher (`AudienceTabs`): the three audiences the product serves, each with its words and its own product picture. A real tablist (arrows, Home, End, one tab stop); all panels are in the HTML, the closed ones `hidden`. |
| /pricing | "Plan your month" (`PackPlanner`, `PlanSlider`): slide the minutes of finished video, read the credits at the published per-minute rate, and the smallest listed pack that covers them with its own price text. Several packs are written "N x price", never added into a figure the source did not publish. With no published rate the section is absent. |
| /login, /signup | `FlowCard`: brief, plan, approve, played once in CSS (the topic types, four plan lines arrive, lamps light, the drawn key lights last). Drawn art behind (`BrandArt` dawn / rundown), no still. The phone gets a compact form. |
| /mcp | The hero card is the same exchange over drawn art (`BrandArt` tools); the "ask your assistant" prompt types, the reply is labelled "example reply". |

Typing is per-letter spans with a CSS delay (no script, no fetch, hidden letters keep their room, the whole line is also in
the page once as screen-reader text). `nx-show` must use `steps(1, start)`: with `end` the finished progress is 0.9999999
and letters stay hidden.

## 2. Motion in the frame, without new media

`StillFx` draws light over a still, masked to it: shafts, motes, mist, a sun, water shimmer, moon glow, twinkling stars,
lantern flicker, and a foreground layer that drifts against the background (parallax). Transform and opacity only. It is
off under reduced motion, never fetched, and stops with the page's pause switch. While it runs, the badge reads
"Example clip (animated still)", else "Example frame". Pause rules use `animation-play-state: paused !important`: the
shorthand of the rules that start the loops resets it and comes later in the file (a bug found in this round: the pause
did nothing for the new effects until then).

## 3. Less repetition

No still appears twice on a page. The landing uses silkroad (hero), library, valley and moon; /pricing nightmarket with
lanterns; /solutions its own product pictures; auth, /mcp and the Try thumbnail are drawn from the stage tokens
(`BrandArt`, `ThumbArt`: the topic's own three words, same topic same drawing). The five recoloured variants of the stills
were deleted (-5 files).

## 4. Tool pill carousel

`ToolStrip`: the nine capability names as swipeable pills (17 px, snap, edge fade) with simple icons; hover, tap or arrows
show what it does and whether it costs credits. A tablist (one tab stop). Names of what the product does only.

## 5. Data

Phones get a 640 x 360 rendition of each clip (75 to 126 KB, MP4 and WebM). The clip files are imported in
`components/site/clip-assets.ts`, read by the Client Component `LoopClip`: a file imported only by Server Components is
written for the server bundle and never copied to `/_next/static/media` (the first R6 build 404'd every clip).

| Landing (prod build, headless Chromium, median of 7) | main | round 6 |
| :-- | --: | --: |
| Phone, first load (4 s) | 770 KB | 500 KB |
| Phone, after a full scroll | 1,385 KB | 714 KB |
| Desktop, first load | 772 KB | 778 KB |
| Desktop, after a full scroll | 1,385 KB | 1,392 KB |
| LCP, phone / desktop | 172 / 208 ms | 176 / 216 ms |

## 6. Phone length

| | main | round 6 |
| :-- | --: | --: |
| Landing, 390 | 10,423 px | 8,908 px (-14.5%) |
| /solutions, 390 | 4,929 | 3,261 |
| /pricing, 390 | 5,978 | 6,379 (the planner is new) |
| /mcp, 390 | 8,636 | 8,454 |

How: a how-it-works block that holds the tool strip (one section fewer), full-bleed showcases with the AI-still note once
under the last, tighter section rhythm (`--nx-sec` 34 px), a three-column footer, a 16:10 hero picture. One Start free is
on screen at a time.

## 7. Smaller things

- The rail starts on Topic from the first painted frame (checked frame by frame: no Approve flash).
- 21st.dev search (free) for pricing sliders: the useful patterns (discrete breakpoints, an animated figure) were already
  in the planner. No code retrieval spent.
- Press states (`:active` scale), focus rings on the new controls, dark-mode parity (the stage is dark in both themes).
- Found and fixed: the pricing page's own `ol.st-flow.nx-flow` picked up the new flow card's styles (white text on white,
  axe 1.13:1); the card is `.nx-fcard`. Russian sign-in shifted by 0.007 when the display face arrived (a key label that
  wraps once, a `ch`-wide ledger); both reserve their room now.

## 8. Verification

tsc, eslint, vitest (225 files, 4,747 tests). State matrix on the final build: landing, /pricing, /solutions,
/solutions/youtube-channels, /login, /signup, /mcp x 390 / 1280 x light / dark x en / ru / uz: axe 0, overflow 0, targets
under 24 px 0. Layout shift with fonts held back 1.2 s: 0.0017 at most (6 pages x 2 widths x 3 locales). Pause: 0 running
animations and 0 playing videos on every page with the switch; reduced motion: 0 animations, 0 video elements, all letters
visible. At 4x CPU throttle the landing's idle frames over 34 ms: 0 (main: 0 to 1); programmatic jumps between sections
can drop 1 to 4 frames of 34 to 50 ms, as on main.

## 9. Weak spots

- The motion is still three clips and procedural light over stills; nothing here is footage.
- Desktop data did not fall (the large clips are the same); only phones got lighter.
- The phone landing is -14.5%, short of -15 to -20%: what is left is honesty and legal text, four stills and the planner.
- /pricing got longer on purpose; it has two calculators (the video's cost and the month's pack).
- Login and sign-up have no pause switch (the card plays once; the one breathing lamp is the old status lamp).

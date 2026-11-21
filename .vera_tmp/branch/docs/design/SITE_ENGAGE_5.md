# Site, round 5: real motion and more distinct imagery, without buying a picture

> **Superseded in part (round 7b and after).** The pictures this document describes as AI-generated stills, the clips made from them and the drawn light over them are gone: the public pages now show credited Pexels stock photos and footage, labelled as examples (`SITE_ENGAGE_7B.md`, `SITE_ENGAGE_8.md`, `MEDIA_CREDITS.md`). Read what follows as history; the layout, type, motion and honesty rules it records still apply unless a later round says otherwise.


Status: 2026-10-06 (revised the same day after the review of PR #404: see section 8). Builds on `SITE_ENGAGE.md` to `_4`. Round 4 (structure) scored about 73 on a phone and 77 on a desktop.
The reviewer's verdict was that the next ten points need more distinct imagery and real motion, and that 95 is not reachable
with six stills and none. The owner has not approved paid generation, so this round is everything that can be done without
buying an image: slow camera moves rendered from the stills we already have, graded and cropped variants of them, and the
layout and interaction work that makes the pictures count. Every honesty, accessibility and performance rule holds; no
dependency, font, script or external origin was added; the CSP is unchanged (it already allows same-origin media).

## 1. The phone showcases show their still

The still sits at the top of the card, whole and bright (4:5.2), with only the label and a short dark panel under the
headline over it; the sentence and the button are on solid dark below. The panel is at least 78% black behind every line of
the headline (white on the brightest possible pixel is over 10:1), the label has its own dark pill, and
`tests/site-engage.test.tsx` works the numbers from the stops. On a desktop the words sit on the left over a gradient, as
before.

## 2. Real motion, honestly

Three clips, drawn by `scripts/render-site-clips.py` from the owner's approved stills: a slow push-in and drift (zoom 1.0 to
1.19 and back, a pan on both axes, a light that breathes once), 8 seconds, 24 fps, **1280 x 720**, seamless, no audio.
**Frame 0 of every clip is its still**, which is also the poster, so the loop starts and ends on the picture the page shows
without script. Each is in two formats (H.264 MP4 and VP9 WebM); the browser fetches one.

| Clip | Still | Where | MP4 | WebM |
| :-- | :-- | :-- | --: | --: |
| `silkroad` | the caravan | the landing's chat card (the first screen) | 401 KB | 409 KB |
| `library` | the scroll library | the "A whole video" showcase | 343 KB | 339 KB |
| `valley` | the misty valley | the "The Studio" showcase | 300 KB | 254 KB |

**The loop seam** (the first version, which asked ffmpeg's `zoompan` for the same moves, did not close: its frame counter did
not match the loop, so the last frame was framed differently from the first, and the wrap was 4.9 to 5.6 grey levels,
a twitch every 8 seconds). Every frame is now a closed-form function of the loop position, drawn with Pillow and encoded by
ffmpeg, and Pillow's own brightness and colour enhancers are not used because they truncate: any frame whose factor was
not exactly 1 came out half a grey level darker than frame 0, whose factor is exactly 1. Measured on the decoded files,
mean absolute difference of luma between the last frame and the first (the wrap), against the median step between
neighbouring frames in the same clip:

| Clip | Wrap before | Wrap now (MP4 / WebM) | Median step now |
| :-- | --: | --: | --: |
| `silkroad` | 4.86 | 2.37 / 1.15 | 4.07 / 4.19 |
| `library` | not measured | 1.73 / 1.15 | 3.48 / 3.50 |
| `valley` | not measured | 1.93 / 1.10 | 2.42 / 2.40 |

The wrap is smaller than an ordinary frame-to-frame step, so there is nothing to see at the join. (The source frames match to
0.00; what is left is encoder noise.)

`components/site/LoopClip.tsx` plays them under these rules, each one in `tests/site-engage-5.test.tsx` and checked in a
browser:

- never rendered, so never fetched, under `prefers-reduced-motion`, on Save-Data or on a 2g/3g connection (the still is
  all there is);
- `preload="none"` until wanted: the first screen's clip starts after the page has loaded and gone idle (so the still,
  not the clip, is what LCP measures), the others when they are within 150 px of the screen;
- muted, looping, inline, no controls, `aria-hidden` (the still's description covers it); the still is also the `poster`
  attribute (the same file, already cached), and the WebM is listed before the MP4 (a browser takes the first it can play;
  Safari on a phone takes the MP4);
- paused while off screen, in a hidden tab and while the page's pause switch is pressed (the same switch that stops the
  drifting light; it resumes when released). The switch is in the hero and also **on the picture of each showcase clip**
  (a 44 px button, top right, named "Pause motion", `aria-pressed`): the three are one switch and always agree;
- one pixel smaller than the still under it on every side, so the clip is never a larger picture than the still. Without
  that, the clip's first frame became a new LCP candidate 180 ms after the still on this machine (measured: 384 and
  408 ms against 220 and 216 ms in two of six runs); with it the LCP element is the still in every run;
- labelled: the badge on the picture reads "Example frame" until the clip is playing, then "Example clip (animated
  still)"; the note under the card gains one sentence ("Where a picture moves, it is the same still, panned and zoomed
  slowly.", in English, Russian and Uzbek). Nothing says or implies the clip is Nightshift's output.

The files are served from `/_next/static/media/` (hashed, immutable, range requests work), which the middleware never
gates; the clips are imported like the stills, which needed one webpack rule in `next.config.ts` (`asset/resource` for
`.mp4` and `.webm`; no loader, no package). **That rule is webpack-only**: `next dev` and `next build` use webpack here (the
scripts in `package.json` pass no `--turbopack`), and a Turbopack build would ignore `webpack()` and need an equivalent
`turbopack.rules` entry; a test pins the rule so a change of bundler fails loudly. The CSP's `media-src` and `default-src` already allow `'self'`, so it did not
change.

### What it costs

| | Main | This branch |
| :-- | --: | --: |
| Landing, first load after 4 s, phone | 294 KB | 770 KB (the hero clip is 399 KB of it) |
| Landing, after scrolling the whole page, phone | 399 KB | 1,385 KB (all three clips: 979 KB, WebM in this browser) |
| Landing, first load after 4 s, desktop | 336 KB | 772 KB |
| LCP, median of 6 to 8, phone / desktop | 172 / 224 ms | 168 / 216 ms (the still, in every run) |
| JavaScript, landing first load | 117 kB | 120 kB |

A visitor who asked for less data, has reduced motion on or is on a slow link pays nothing for the clips.

## 3. Variants of the stills

`scripts/make-site-sample-variants.py` makes five graded and cropped variants of the six stills (a split-tone grade and a
crop, 900 px wide, 23 to 58 KB each): `silkroad-dusk`, `library-teal`, `valley-rose`, `nightmarket-cool`, `lighthouse-wide`.
A variant is described, in every language, as the still it comes from. The slots now give each page its own look:

| Page | Stills |
| :-- | :-- |
| Landing | silkroad (warm), library, valley, moon: the originals |
| /pricing, /mcp | nightmarket, lighthouse: the originals |
| /solutions | library-teal, valley-rose, lighthouse-wide |
| /login, /signup | nightmarket-cool, silkroad-dusk |

A test fails if the landing, /solutions and the auth pages share a still. The colour accent beyond amber that the review
asked for comes from the pictures (teal, rose, cool blue), not from the interface: `IDENTITY.md` keeps amber as the only
brand hue and blue, green and red as lamp states, and that holds.

Provenance, as for the six: AI-generated stills made on 2026-10-05 for demonstration; the commercial-use licence of the
generating tool is still to be confirmed by the owner. The clips and variants are those stills moved, cropped or graded.

## 4. The hero

On a desktop the chat card is beside the headline, top right, and the whole card is above the fold at 1280 x 900 (it was
below it). The headline is two lines at 68 px. On a phone the order is the pill, the headline, the button, then the chat
card with a 4:3 still, then the words: the whole picture is on the first screen. The rail (Topic, Plan, Approve, Live)
steps **once**, the first time the card is on screen after the page has loaded: Topic, Plan, Approve, where it rests for good
(it no longer loops); the step it rests on is the one the card names (`copy.current`), not a number in the rail; it never
reaches Live, because nothing
goes live without the person pressing the button, and the card's last row says so. The state of the rest of the card
follows (the lamps and the drawn button wait for Approve), by colour only, never by fading text. With reduced motion, the
pause switch or without script it shows Approve, the state the server renders.

## 5. The rest

- **Try, on a desktop:** three columns, the picture card down the right across two rows, each card's lines spread over its
  height and the picture taking what is left, so no card has a blank area under it. A card that is not drawn yet keeps its
  box and its title while its words are held back (the screenshot that showed an orphan third card was taken mid-draw,
  when the hidden cards left holes). Cards slide in; they no longer fade (a card mid-fade failed a contrast check for
  the moment it took).
- **What Nightshift can make:** a strip of the Studio's nine tool names (image, video clip, voice, edit, animate, upscale,
  cut out, styles, editor); hover, tap or focus one and a line says what it does and whether it costs credits. Names of
  what the product does, no provider or model. No new strings beyond the heading.
- **Small:** the Russian "Одобрение" no longer breaks mid-word in the rail; the carousel track has a scroll padding of
  16 px; the header's language code (12 px) and the /mcp banner (13.5 px) are 14 px; the header's Start free and the
  sticky bar were two buttons for one action, so the bar is now for phones and tablets only and, while it shows, the
  header's button is hidden (hidden, not removed: removing it moved the header's tools and counted as a layout shift each
  time the bar came and went).
- **/solutions and /login:** taller pictures, the graded variants, a bigger band on the phone sign-in.
- **Layout shift:** the desktop hero's three promises are one per line (they wrapped in one row in the fallback face and in
  two in Onest, a shift of 0.12); the sign-in and sign-up headline used `16ch` (the unit that changes with the font) and is
  `9em` now, which also fixes the 0.0026 in Uzbek that had been on main since round 2.

## 6. Measurements (first pass; section 8 has what changed after the review)

Production build against a fake backend that answers the public price list. Screenshots in
`site-engage-5/{before,after}` (before is main at 04b5f19d).

| Page | Phone before | Phone after | Desktop before | Desktop after |
| :-- | --: | --: | --: | --: |
| Landing | 9,051 | 10,418 | 8,277 | 8,340 |
| /pricing | 5,932 | 5,978 | 4,031 | 4,031 |
| /solutions | 4,687 | 4,929 | 3,059 | 3,145 |
| /mcp | 8,587 | 8,636 | 6,255 | 6,277 |
| /login | 1,055 | 1,103 | 900 | 900 |

The landing is longer on a phone because the pictures are now larger, not smaller: three 4:5.2 pictures, the tool strip
and the clip sentence.

- **State matrix:** 9 pages x 360 / 390 / 1280 x light and dark x en / ru / uz (135 states): axe serious and critical 0,
  horizontal overflow 0, targets under 44 px 0.
- **Layout shift** (fonts held back 1.2 s, 36 states): 0.0011 or less everywhere.
- **Headlines:** three lines or fewer on a desktop in all three languages, on every page.
- **Tests:** 4,728 pass (27 new in `tests/site-engage-5.test.tsx`); tsc clean; eslint clean on the changed files.

## 7. Weak spots

- Two thirds of the pictures that move are still three stills; a clip over the same still on two pages would look
  repeated, so only three exist. New clips are one render command and one line in `CLIPS` once there are more stills.
- A phone downloads about 0.5 MB more on a full read of the landing (nothing under Save-Data, reduced motion or a slow
  link).
- The clips are camera moves, not footage: honest, but they do not add anything a generated clip would.
- The landing is 10,400 px on a phone.

## 8. After the review of #404

- **Showcase badges on a desktop were nearly invisible (1.4 to 1.5:1).** The badge sat inside the picture, which has
  `z-index: -1`, and the card's own `::after` gradient (88% black) painted over it. The gradient is now the picture's
  `::after` (z-index 1), the badge is 2 and the pause button 3. Measured in a browser, the brightest pixel of the drawn text
  against the brightest pixel behind it (text hidden for the second shot), over four frames of the clip, white badge text:

  | | Before | After |
  | :-- | --: | --: |
  | Desktop, "Example clip" on the library showcase | 1.52 | 20.1 |
  | Desktop, "Example clip" on the valley showcase | 1.45 | 19.1 |
  | Desktop, "Example frame" on the moon showcase | 1.40 | 19.9 |
  | Phone, the three showcases (unchanged) | 6.2 to 10.9 | 6.2 to 10.9 |
  | Hero card, phone and desktop (unchanged) | 7.9 to 8.2 | 7.8 to 8.1 |

  axe cannot see text over a picture, so `tests/site-engage-5.test.tsx` pins the stacking order and the arithmetic of the
  badge's own dark pill (white on 62% black over the brightest possible pixel is 6.2:1).
- **The rail got `rest`** (the step the card names), so `ChatRail` no longer assumes three steps among four tabs; it runs once.
- **The clips were re-drawn** (section 2): 1280 x 720, a 19% push-in, a lower CRF (32 for MP4, 41 for VP9) and no seam.
- **A pause button on each clip picture** (section 2).
- **WebM first, a `poster`** on every video; the webpack-only note (section 2).
- **Try card text:** nothing on any public page is under 14 px (measured as computed style over every text node on the
  landing, /pricing, /solutions, /mcp and /login at 390 and 1280); the plan cards' item labels and the "Example" tag are
  15 px now for margin.
- **One more layout shift found while re-measuring:** the /solutions headline's `max-width` was in `ch` (the unit that
  changes with the font), so in one load of about ten the headline wrapped differently in the fallback face and moved the
  page (0.04 in the Russian desktop page). It is `em` now; 44 loads since show 0.0012, one 0.0107, none above.

State matrix on the final build: 9 pages x 360 / 390 / 1280 x light and dark x en / ru / uz (135 states), then again for the
landing, /solutions, /mcp, /pricing and /login after the last two CSS changes: axe 0, overflow 0, targets under 44 px 0.
Layout shift with the fonts held back: 0.0014 or less in 36 states. LCP element is the still in every run.

# Site engagement, round 8: more real pictures, fewer flat spots

> **Superseded in part by round 9 (`SITE_ENGAGE_9.md`).** Round 9 dropped the landing's first showcase (the library photograph), made the hero's footage a phone's whole first screen, put the capability wall behind a "show four more tools" button, replaced the /login and /signup stages (the alley and lantern photographs are gone: /login shows a desert photograph, /signup plays the floating lanterns), retired /mcp's drawn hub for a header panel of footage, and moved the numbers below. Honesty, credit and budget rules still apply as written.

Same rules as round 7b (`SITE_ENGAGE_7B.md`): every picture is a credited Pexels stock photo or clip, labelled "Example"
or "Stock photos, illustrating each tool" in en, ru and uz, never called AI or animated stills; derivatives only (the
originals and the local manifest are not in the repository); credit on each picture, in the footer list, in
`lib/site/media.ts` and in `MEDIA_CREDITS.md`. Colour system, CSP, `next.config.ts`, dependencies and the signed-in app are
unchanged. Baseline in every table below is `main` at the end of 7b (39ea227f).

## What changed

1. **Contrast, measured on rendered pixels.** Text is made transparent, the pixels behind its box are sampled (95th percentile of
   luminance, so one bright speck cannot hide) and the text colour is composited over them. 40 probes (10 areas x light/dark x
   1280/390), 0 flagged. Worst rows: closing "Start free" 4.92:1 (needs 4.5), /login aside 5.53, /signup aside 5.18, /mcp card tag
   8.91, pricing badge 18 to 20, signup phone band 8.4. The closing headline over the moon now clears 3.0 for 64 px text (a
   veil that is heavy under the words, clear over the moon). The drawn "Approve and publish" key is still `aria-hidden`, but it is
   dashed and has no fill so it cannot be read as a second button beside the real submit; it is hidden on phones. The "Studio" label
   now has 4.5:1 or more. The key edge is an outside 1 px ring, so the button's border and text no longer fight.
2. **/login and /signup are photographic.** /login: lit window in a quiet evening street (Maria Orlova), /signup: paper lanterns
   glowing at night (creator credited as Pexels shows the name). Different photos, a lighter veil only where small text sits
   (`data-photo` on the aside and the phone band), ru and uz wrap checked at 390 and 1280. Captions name no place and no festival.
3. **/solutions tab 1** no longer has the flat teal-brown "Illustration" block: it plays the caravan clip inside the publish desk's
   frame with its "Example clip" label and credit; on phones the three labels move into a caption under the frame (the frame was too
   small for three overlays).
4. **Four new clips** (one plays at a time, the best-visible one; nothing is fetched under reduced motion, Save-Data or 2g/3g):
   cloud sea (landing first screen), pottery (landing, second showcase), floating lanterns (/pricing), loom (/solutions, creative
   studio tab). With the caravan and the coast clip: six clips, each at most once per page. The misty river clip is gone.
5. **Capability wall** replaces the pill carousel on the landing: eight photo tiles (Image, Video clip, Voice, Edit, Animate,
   Upscale, Cut out, Styles), each with the real tool name, the one-line description from the old strip, "Photo: name / Pexels",
   and the price only for tools that cost credits; "Editor" (no credits) is a plain line, since there is no picture for it. The
   label "Stock photos, illustrating each tool" and a note ("The pictures stand for the tools ... not what the tools make") are
   visible. Two columns on phones, four from 640 px, lazy, 7 to 24 KB per tile (448 x 336 webp). `ToolStrip.tsx` is deleted.
6. **Credit links** are at least 44 px tall (footer list, credit pills that are links) and credit text is at least 14 px.
7. **Lighthouse and the pause button** (coast showcase): at 860 px and wider the pause control sits at the right, 60 px above the
   bottom edge, away from the lighthouse; the clip is framed from the top.
8. **Seams.** Loops are cross-dissolves whose seam is the next source frame, so the wrap is one ordinary step. Lossless (before
   encoding), mean absolute grey-level step at the wrap versus the median step: coast 1.00 vs 1.20, cloud 0.51 vs 0.57, floating
   0.28 vs 0.43, pottery 2.81 vs 3.11, loom 2.47 vs 3.10. After encoding (the files people get, 1280 mp4/webm): caravan 5.6/5.0
   vs 3.3/3.4, cloud 0.9/0.8 vs 0.4/0.5, coast 3.6/3.1 vs 0.7/1.0, floating 0.9/0.7 vs 0.3/0.4, loom 4.3/3.7 vs 2.7/3.2,
   pottery 3.8/3.7 vs 2.4/3.0. Fixes made: loom's seam moved off a fast hand sweep (it was 3x the median), cloud and floating are
   encoded without the temporal denoise (it made their first frame differ from the rest), dissolves 2.0 to 2.8 s.
9. **Frame pacing at 4x CPU throttle** (Chromium, playing clip, 5 s window): 59.7 to 60.0 fps on all six showcases at 1280 and 390,
   no frame over 34 ms (two single 33 ms frames: hero and loom at 1280). Decoding cost: the 1280 clips are 240 to 400 KB per 8 to
   10 s loop (about 0.2 to 0.35 Mbit/s), H.264 and VP9 at 25 to 30 fps, 40 fps for the floating lanterns (120 fps source, played at
   shot speed), so the decoder's work is small. The test machine has no GPU decode, so this was software decoding under a 4x
   slowdown, and it held 60 fps; phones get the 640 px rendition (75 to 130 KB), and only one clip is decoding at a time, the rest are paused.
10. Stale docs: `SITE_ENGAGE.md` to `_6.md`, `SITE_KREA.md` and `SITE_ENGAGE_7B.md` carry a short "superseded" header.

## Slots

| Page | Slot | Picture |
| :-- | :-- | :-- |
| / first screen | hero card | cloud-sea clip (K) |
| / | showcase 1 / 2 / 3 | library photo / pottery clip (AP Vibes) / coast clip (Nui MALAMA) |
| / | capability wall | eight stock photos, one per tool |
| / | closing panel | moon photo |
| /pricing | chat card | floating lanterns clip (Matheus Bertelli), dark pill labels |
| /solutions | tab 1 / 2 / 3 | caravan clip / loom clip (Magda Ehlers) / city lights photo |
| /login | stage | lit window in an alley photo |
| /signup | stage | paper lanterns photo |
| /mcp | six example cards | valley, lighthouse, market, moon, library, dunes (unchanged) |

Dropped on purpose: the misty river clip, fishermen, workshop, woven lanterns, dawn fog and calm water (replaced, see
`MEDIA_CREDITS.md`); the new desert and ridge photographs were not used (nothing weak was forced into a slot). /mcp hero card
stays drawn: it shows an assistant reaching tools, and a photograph there would suggest a real result; the six example cards
below it already carry real pictures.

## Numbers

Data, kB over the wire (first load after 3.5 s idle / full scroll). Phone 390 and desktop 1280, `next start` against a scratch
backend, measured with CDP `encodedDataLength`. Targets: phone first load <= 600, phone full scroll <= 1,000, desktop full
scroll <= 1,500.

| Page | phone before | phone after | desktop before | desktop after |
| :-- | :-- | :-- | :-- | :-- |
| / | 465 / 721 | 437 / 776 | 773 / 1,327 | 665 / 1,147 |
| /pricing | 277 / 294 | 287 / 381 | 275 / 292 | 285 / 552 |
| /solutions | 274 / 279 | 305 / 447 | 274 / 274 | 671 / 671 |
| /login | 318 / 319 | 330 / 330 | 316 / 316 | 363 / 363 |
| /signup | 328 / 329 | 355 / 356 | 326 / 326 | 422 / 422 |
| /mcp | 340 / 412 | 342 / 413 | 340 / 447 | 345 / 454 |

Worst case (scroll in 1.5 s steps so every clip plays long enough to buffer): landing 773 kB phone, 1,411 kB desktop (was 726 and
1,327). Nothing is over a target.

Page height (scrollHeight, px), en, light:

| Page | 390 before | 390 after | 1280 before | 1280 after |
| :-- | :-- | :-- | :-- | :-- |
| / | 9,137 | 9,720 (+583) | 8,130 | 8,639 (+509) |
| /solutions | 3,744 | 3,621 | 2,781 | 2,474 |
| /pricing | 6,565 | 6,586 | 4,723 | 4,723 |
| /login | 1,159 | 1,103 | 950 | 950 |
| /signup | 1,358 | 1,302 | 993 | 993 |
| /mcp | 8,666 | 8,666 | 6,344 | 6,344 |

LCP (median of 7 loads) and CLS (worst of plain and font-held, en, ru, uz): all pages 124 to 244 ms LCP, within 40 ms of the
baseline; CLS 0.0000 to 0.0017 (the 0.0017 is /pricing on phones, the same as before this round); ceiling 0.002 held.

Checks: axe 0 on all six pages x en/ru/uz x light/dark x 390/1280 (and the three /solutions tabs); 96 states (8 pages x 3
languages x 2 widths x 2 themes) with no overflow, no flagged small target; tsc clean; eslint clean on changed files; vitest
227 files, 4,778 tests (new: every media item has a credit, no label says AI, the shared grade is applied, one clip leads at a
time, the key edge ring, the capability wall).

## Weak spots, plainly

- The phone landing is +583 px longer than before (9,720 vs 9,137), not shorter than 9.1k. The wall costs about 640 px at 390;
  trimming elsewhere (pictures 2:1 on phones, tighter margins) brought it under +600, not under the old height.
- The coast clip's encoded seam is 3 to 5 times its median step (about 3 grey levels): the lossless wrap is clean, the encoder's
  noise at the dissolve is not. Caravan is similar in absolute terms. Both are soft, not visible jumps, at normal viewing.
- Pottery is a macro shot; the clay's blur at 640 px is soft.
- The wall tiles stand for the tools, they are not what the tools make (said on the page). The "Styles" tile is a photograph of
  someone's painting.
- /signup's veil is still fairly heavy so the small text reads; the lanterns are visible but dimmer than in the source.
- The contrast probe uses the 95th percentile of the pixels behind the text; a single bright speck is not counted.
- Frame pacing was measured in desktop Chromium under 4x CPU throttle, not on a real low-end phone.

# Site engagement, round 7b: real pictures

> **Superseded in part by round 8 (`SITE_ENGAGE_8.md`).** The slot table below is the round 7b allocation. Round 8 dropped the misty river clip, the fishermen, the workshop, the woven lanterns, the dawn fog and the calm water, added four clips and ten photographs, and moved several slots (landing hero, showcases, /pricing, /solutions, /login, /signup). Colour, honesty labels and credit rules below still apply.

The AI-generated stills and the clips made from them are gone. The public pages now show stock photography and footage
by Pexels contributors the owner approved (15 items, `docs/design/MEDIA_CREDITS.md`). They are real, they are not Nightshift
output, and every place that shows one says so: a visible "Example" badge ("Example frame (stock photo)", "Example frame
(stock footage)", "Example clip (stock footage)"), a courtesy credit on the picture ("Photo: name / Pexels"), a visible
note under each card ("These pictures are stock photos and footage from Pexels contributors ... not output from a real
account") and a collapsed "Image credits" list in the footer, built from the one data file (`lib/site/media.ts`). en, ru
and uz all carry it. The word "AI" is no longer used about any picture, and "animated still" is gone.

Colour system (indigo key, amber accent), signed-in app, CSP, `next.config.ts` and dependencies are unchanged.

## Where each picture went

| Page | Slot | Picture |
| :-- | :-- | :-- |
| / first screen | hero card | caravan clip (Simeon Stoilov); its still is the clip's own first frame |
| / | showcase 1 (video) | library photograph, no motion |
| / | showcase 2 (studio) | misty river clip (Tom Fisk) |
| / | showcase 3 (approvals) | breaking waves and a small lighthouse, clip (Nui MALAMA), framed from the top |
| / | closing panel | the moon photograph, a veil heavy under the words and light over the moon |
| /pricing | chat card | woven lanterns (small red-lit partial face cropped out of the derivative) |
| /solutions | one per audience tab | fishermen in silhouette (channels), workshop carving (creative studio), city lights (developers), above the product's own picture |
| /login, /signup | stage and phone band | misty hills at dawn, calm water at dawn (caption only that), under a veil |
| /mcp | the six example cards | valley, lighthouse, market (Marrakech), moon, library, dunes: six different pictures. The hero card there stays drawn art: it shows an assistant reaching tools, and a photograph would be a false picture of it |

No picture appears twice on a page.

Slots changed from the brief, said plainly:

- The clips' stills are their own first frames, not the separate photographs listed beside them (caravan 15848441, valley
  10352688, lighthouse 4390834): a clip fading in over a different photograph is a cut, and the badge would credit two people for
  one picture. Those three photographs are used on the /mcp cards.
- The moon moved from the approvals showcase to the closing panel and /mcp; the lighthouse clip took the approvals showcase (the
  moon is a small disc on a dark sky and sits badly under a left-hand text column).
- The night market (Marrakech) is on /mcp, not /pricing; /pricing has the lanterns.
- The library no longer has a clip.
- Nothing was dropped for looking bad. The procedural light (dust, shafts, mist, shimmer, stars, lantern flicker) and the slow
  drift over stills were removed everywhere: drawn light over a real photograph looks fake, and "animated still" was the wrong
  word for footage. `StillFx` is deleted.

## Derivatives, grade and loops

`scripts/make-site-media.py` (Pillow and ffmpeg, no new dependency) turns the originals into the committed files; the originals
(`STOCK=` directory) are not in the repository. One grade for all of them (`grade()`: blacks lifted about 3%, highlights warmed a
little, saturation x0.82 on the fishermen and x0.9 on the two backdrops), applied to every photo and every video frame.

| | 1280 | 640 |
| :-- | :-- | :-- |
| stills (webp) | 6 to 109 KB each | 2 to 32 KB each |
| caravan clip | mp4 390, webm 359 KB | mp4 125, webm 141 KB |
| mist clip | mp4 316, webm 196 KB | mp4 95, webm 69 KB |
| coast clip | mp4 375, webm 293 KB | mp4 115, webm 145 KB |

Loops are cross-dissolves (1.4 s on the caravan, 1.6 s on the others), so the last frame is followed by the next source frame.
Mean absolute grey difference (320 x 180) of the wrap, against the loop's own frame steps:

| clip | loop | wrap | median step | p95 step | largest step |
| :-- | --: | --: | --: | --: | --: |
| caravan (played at 0.69x) | 7.0 s | 3.59 | 2.84 | 5.34 | 6.56 |
| mist | 8.8 s | 0.45 | 0.36 | 0.54 | 0.67 |
| coast | 9.0 s | 1.03 | 1.22 | 1.41 | 1.54 |

The wrap is an ordinary frame step in all three (the caravan's is inside its own p95; the camels and the pan make every step large).

`LoopClip` keeps every rule: no fetch under reduced motion, Save-Data or 2g/3g; the first screen's clip starts after load and idle;
paused off screen, in a hidden tab and by the page's pause switch; the 640 rendition on phones. One change: only the clip that
shows most of itself plays. Two playing at once cost a 4x-throttled phone half its frames (the showcase with the next one's edge in
view measured 30 fps against 60 with one playing; the same 30 fps measured on the first showcase in round 6). Stills are `srcset`
pairs (640 and 1280), clip posters are the 640 still.

## Numbers (production build, headless Chromium, scratch fake backend)

| | main (round 7a) | round 7b |
| :-- | --: | --: |
| Landing, phone, first load (4 s) | 500 KB | 453 KB |
| Landing, phone, after a full scroll | 713 KB | 703 KB |
| Landing, desktop, first load | 778 KB | 761 KB |
| Landing, desktop, after a full scroll | 1,392 KB | 1,314 KB |
| LCP, phone / desktop (median of 7) | 192 / 240 ms | 184 / 244 ms |
| 4x CPU, frame rate with each showcase in view, desktop and phone | 30.7 fps on the first clip showcase | 60 fps on all three |
| Layout shift, fonts held back 1.2 s, 6 pages x 2 widths x en/ru/uz | 0.0017 at most | 0.0017 at most |
| Page height at 390: landing / solutions / pricing / mcp | 9,049 / 3,402 / 6,520 / 8,595 px | 9,137 / 3,744 / 6,565 / 8,666 px |

Text over a picture, measured on the rendered pixels (text made transparent, the 95th-percentile background luminance in each
text box, then the text colour over it; showcases, the closing panel, the sign-in stage and band, light and dark, 1280 and 390):
the showcase text is 8.6:1 or better; the sign-in stage's large text is 4.5:1 or better (needs 3) and its small text 5.4:1 or better;
the closing panel's words 4.9:1 or better, except its indigo button's label, which the harness reads as 4.49:1 (its 1 px inner highlight is in the 95th percentile; the colour pair itself is 4.92:1). Badges, credits and the pause button sit on a dark pill (0.62 to 0.68 black) and are 7.5:1
or better over the brightest picture.

axe 0, overflow 0 and no target under 24 px on 8 routes x 390 / 1280 x light / dark x en / ru / uz (96 states); the footer's credits
opened, every audience tab opened, targets 44 px on phones.

## Weak spots

- The sign-in stage's veil is heavy: the dawn and horizon photographs read as a warm dim wash behind the words, not as pictures.
  Lighter would break the 4.5:1 on the small text over the brightest sky.
- The caravan loop has a visible dissolve at its seam (the camels' gait does not match across it); it is a stock clip of 8 s.
- The lighthouse in the coast footage sits under the pause button at 1280.
- The picture pixel check uses the 95th percentile of each text box (borders and icons would otherwise dominate); a single bright
  speck under a letter is not counted. The hero card's and /mcp phone card's pills were flagged by the harness and then checked by
  hand (the harness did not make their text transparent there): 7.5:1.
- /solutions is 342 px longer at 390 (a photograph above each audience's product picture).
- Older documents (`SITE_ENGAGE*.md`, `SITE_KREA.md`) still describe the AI stills they replaced.

# Site engagement, round 9: the picture owns the first screen, a shorter phone landing

Same rules as rounds 7b and 8 (`SITE_ENGAGE_7B.md`, `SITE_ENGAGE_8.md`): every picture is a credited Pexels stock photo or clip, labelled "Example" (or "Stock photos, illustrating each tool") in en, ru and uz, never called AI; derivatives only; a credit on each picture, in the footer list, in `lib/site/media.ts` and in `MEDIA_CREDITS.md`. No new sourcing: everything below reuses what the repository and the two download batches already held. Colour system, CSP, `next.config.ts`, dependencies and the signed-in app are unchanged. Baseline in every table is `main` after round 8 (fbc3af57).

## What changed

1. **A phone's first screen is the hero footage.** Below 1024 px the cloud-sea clip runs edge to edge behind the pill, the headline and the one "Start free" (a dark panel in both themes, rounded at the bottom, veil clear over the sky and heavy under the words, the pill on its own dark fill). Its still is the clip's first frame (the poster) and the panel's still stays the page's LCP element. The desktop keeps the chat card with its clip; the card's picture is hidden below 1024 px, the panel above it, so the footage is never on screen twice. Checked at 360, 390 and 430 px, light and dark, en, ru and uz.
2. **A shorter phone landing** (about 1,500 px). The drawn "ask, reply, wait" card stays but without its picture on a phone (the panel is the picture); the hero's lead (the steps say it) and the "Try an example" eyebrow are hidden; the first of the three showcases (a still photograph, the least alive) is dropped on every screen; the capability wall shows two rows (four tools) and a "Show four more tools" button, the other four are in the page but hidden, so every tool name is reachable and their lazy pictures are not fetched until the button shows them (checked: four tile files before the tap, eight after); the pricing block loses its intro line (the quote card says it); section padding 34 to 28 px. The wall's label "Stock photos, illustrating each tool", the three steps with "Watch it, then publish", the hero's "Nothing goes public without you" and the dashed "Approve and publish" are all still visible.
3. **/mcp header.** The drawn hub is gone. The page's words sit on a panel of the cloud-sea clip (framed on its dark ridge, a different crop from the landing, labelled "Example clip (stock footage)" and credited), and the "ask your assistant" card stands under it (a phone) or beside it (a desktop) with no picture at all, its note now "An example of an ask and the wait for approval. Not a real run, not a real result." Why this is honest: the clip is an atmosphere behind the page's words and says what it is; nothing pictured is Nightshift working, so nothing can be read as a result. The drawn hub (`BrandArt` "tools") is unused and kept in `BrandArt.tsx` so the diagram can come back.
4. **/login** shows a bright desert photograph (golden light over dunes, Stephen Leonardi) instead of the dark alley; the stage's small text sits on dark panels of its own (the three promises, the lamp and credit lines) rather than under a heavy veil, the flow card keeps its own fill, and the veil is light (0.16 to 0.4). Caption: "Golden light over desert dunes" (no place, no hour).
5. **A moving moment where it is cheap.** /signup plays the floating lanterns clip behind its stage (and its phone band) with a pause button; /mcp's header plays the cloud-sea clip; /mcp's sixth example card plays the caravan clip (it was a photograph of a caravan; the photograph is dropped). Every one is a clip already used on another page, with its own crop; one plays at a time (the best-visible), nothing is fetched under reduced motion, Save-Data or 2g/3g, the still is the poster.
6. **Wall tiles alive.** The best-visible tile (and a hovered one) zooms slowly (a 7 s, 12% CSS zoom of its own photograph, never under reduced motion or the pause switch). There is no second still or tiny clip to crossfade to without new sourcing, so none was added; nothing extra is fetched.
7. **Small items.** The "Video" label over the landing photograph (4.03:1) went with the dropped showcase; the ru /signup "Одобрение" label no longer runs into its lamp (a 96 px label column in ru and uz); the drawn "Approve and publish" key is dashed and unfilled on the landing, /pricing and /mcp, as it was on the stages, so it cannot read as a second button.
8. **Clip cost on /solutions and /pricing.** A frame that is never wider than 560 px (the publish desk's, the pricing card) uses the 640 px file on any screen (`compact`): /solutions first load on a desktop 665 to 451 kB, /pricing full scroll 553 to 381 kB.
9. **Coast loop.** The dissolve is 3.2 s (was 2.4 s). The lossless wrap is one ordinary step (1.00 against a median of 1.16), as before; the encoded wrap did not improve (see below). MP4 structure verified on all twelve files: `ftyp`, `moov`, `mdat` (fast start), H.264 Main, yuv420p, 25 fps, even sizes, no audio. **To do: play the clips once on an iPhone in Safari** (Low Power Mode keeps autoplay of muted inline video off; the stills then stay, which is the designed fallback).
10. This note, `MEDIA_CREDITS.md` (desert added, alley, lantern grid and desert caravan photographs removed, usage and sizes updated), and the "superseded in part" headers on `SITE_ENGAGE_7B.md` and `SITE_ENGAGE_8.md`.

Boxes that cannot move when the web font replaces the fallback: the new /mcp panel holds three runs of text whose line counts differ by one or two between the fallback face and Onest (and between languages), which first made CLS 0.011 on /mcp; each run now reserves the most lines it takes at its width (a table per width bucket, en and ru/uz separately, measured at 320 to 1440 px), and the phone band over the sign-in form keeps its height for the longer ru and uz topics. A clip is a few pixels smaller than its still so the still stays the page's largest paint.

## Slots

| Page | Picture |
| :-- | :-- |
| / | hero: cloud-sea clip (a phone's panel, a desktop's card); showcases: pottery clip, coast clip; wall: eight tiles; closing panel: moon |
| /pricing | floating lanterns clip (640 px file) |
| /solutions | tab 1 caravan clip (640 px file), tab 2 loom clip, tab 3 city lights |
| /login | desert photograph |
| /signup | floating lanterns clip, with a pause button |
| /mcp | header: cloud-sea clip; examples: valley, lighthouse, market, moon, library, caravan clip |

Dropped: the landing's library showcase (the photograph stays on /mcp), the alley and lantern-grid photographs (removed from the repository), the desert caravan photograph (replaced by the caravan clip), the drawn hub on /mcp. Not used: the orange mountain ridge (28784109), which no slot needed.

## Numbers

Heights (scrollHeight, px, en):

| Page | 360 before / after | 390 before / after | 430 before / after | 1280 before / after |
| :-- | :-- | :-- | :-- | :-- |
| / | 10,052 / 8,576 | 9,720 / 8,296 | 9,590 / 8,076 | 8,639 / 8,010 |
| /mcp | 8,948 / 9,110 | 8,666 / 8,775 | 8,464 / 8,494 | 6,344 / 6,391 |
| /login | 1,120 / 1,156 | 1,103 / 1,139 | 1,103 / 1,139 | 950 / 985 |
| /signup | 1,380 / 1,457 | 1,302 / 1,378 | 1,302 / 1,378 | 993 / 1,005 |
| /pricing, /solutions | unchanged within 10 px | | | |

The phone landing is 1,424 px shorter at 390 (1,476 at 360, 1,514 at 430). /mcp and the two stages grow on a phone (the header panel, the band's brand row) by 30 to 110 px.

Data, kB over the wire (first load after 3.5 s idle / full scroll):

| Page | phone before | phone after | desktop before | desktop after |
| :-- | :-- | :-- | :-- | :-- |
| / | 437 / 775 | 422 / 650 | 670 / 1,419 | 663 / 1,316 |
| /pricing | 289 / 384 | 286 / 381 | 292 / 553 | 286 / 381 |
| /solutions | 303 / 449 | 304 / 446 | 664 / 665 | 451 / 451 |
| /login | 330 / 330 | 326 / 326 | 363 / 363 | 355 / 355 |
| /signup | 355 / 356 | 410 / 410 | 422 / 422 | 595 / 595 |
| /mcp | 344 / 420 | 463 / 535 | 344 / 450 | 610 / 710 |

Budgets: phone first load at most 600 (worst 463), phone full scroll at most 1,000 (worst 650), desktop full scroll at most 1,500 (worst 1,316; 1,322 scrolling in 1.5 s steps so every clip plays long enough to buffer). /signup and /mcp grow because they now play a clip (the stage is tall, so it needs the 1,280 px file).

LCP (median of 7 loads, ms, before / after) and CLS (worst of plain and font-held loads in en, ru and uz, after):

| Page | 390 LCP | 390 CLS | 1280 LCP | 1280 CLS |
| :-- | :-- | :-- | :-- | :-- |
| / | 196 / 184 | 0.0001 | 260 / 260 | 0.0002 |
| /pricing | 192 / 176 | 0.0017 | 224 / 224 | 0.0002 |
| /solutions | 148 / 132 | 0.0007 | 200 / 208 | 0.0008 |
| /login | 144 / 140 | 0.0011 | 188 / 184 | 0.0000 |
| /signup | 140 / 144 | 0.0011 | 184 / 216 | 0.0000 |
| /mcp | 176 / 424 | 0.0001 | 248 / 240 | 0.0003 |

CLS is at or under 0.0017 everywhere (/pricing on a phone, unchanged by this round); the 0.011 to 0.032 the first /mcp, /login and /signup builds showed (a text wrap that differed between the two faces) is what the reserved lines and the band heights fixed. /mcp on a phone waits for its clip: the clip's first frame is a later paint of the same box and the browser counts its whole box, so LCP moves from the still (about 200 ms) to the moment the clip starts (about 420 ms); making the clip several pixels smaller than its still fixed it on a desktop but not on that phone panel.

Checks: axe 0 on six pages x en/ru/uz x light/dark x 390/1280 (and the three /solutions tabs); 96 states (8 pages x 3 languages x 2 widths x 2 themes) with no overflow and no small target; 42 contrast probes on rendered pixels (text made transparent, 95th percentile of the pixels behind each text box, large text 3:1, small 4.5:1), 0 flagged, the worst small text 4.92:1 (the closing "Start free"); tsc, eslint and vitest (new `tests/site-engage-9.test.tsx`: the panel, the wall button and hidden tiles, the bare card, the dashed key, the compact rendition, the reserved lines, the removed pictures); every media item still has a credit, no label says AI.

Frame pacing at 4x CPU throttle (Chromium, playing clip, 6 s window), 18 showcases (nine at 1280, nine at 390): 59.3 to 60.0 fps, one clip playing at a time everywhere. In three of the 18 runs a single frame took 50 to 67 ms, and in earlier runs one of 100 ms, never twice in the same place: the pattern fits the loop's wrap (a seek back to the start) under a 4x slowdown, not steady decoding cost. Decoding cost: the 1,280 clips are 215 to 400 KB per 8 to 10 s loop (about 0.2 to 0.35 Mbit/s), H.264 and VP9, 25 fps, so the decoder's work is small; the test machine has no GPU decode, so this was software decoding.

Seams (mean absolute grey-level step at the wrap against the median step, 1,280 px files, mp4 / webm): lossless coast 1.00 vs 1.16; encoded coast 3.6 / 3.0 against 0.7 / 1.0 (each encoded frame differs from its source by 2.6 to 3.6 grey levels, high-frequency wave texture, and the first and last frames are far apart in the encoder's prediction chain; a longer dissolve, no denoise and a lower crf did not change it, so the seam is a brief re-randomising of the foam texture, not a jump).

## Weak spots, plainly

- The phone landing is 1,424 px shorter, not the full 1,500; /mcp and the sign-in/up pages are 30 to 110 px longer on a phone.
- The /mcp header panel reserves text lines for the worst case, so in English at some widths there is a visible gap of one or two lines between the headline and the lead; that is the price of zero layout shift without a hidden-until-font-loaded trick.
- LCP on /mcp's phone layout is the clip's first frame (about 420 ms against 176 ms before); every other page is within 40 ms of before. Still far under 2.5 s, and the cost of a clip over a header.
- The wall tiles do not crossfade or play: there was nothing to cross to without new sourcing, so they zoom slowly.
- The coast clip's encoded wrap is unchanged (above). An isolated 50 to 100 ms frame appears occasionally at a loop wrap under 4x throttle.
- Not checked on a real iPhone or in Safari; the files are structurally standard.
- Pre-existing and untouched: the header overflows by 4 to 60 px at 1024 px in ru and uz (and by 20 to 30 px at 320 px) on every public page.

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
10a. **Review fixes (WCAG 2.2.2, phone LCP).** The picture panel on the landing and on /mcp now has its own pause button, the same switch as the one under the chat card and on the clips (`ClipPause`: 44 x 44 px, top right, 12 px in, named "Pause motion" in all three languages, `aria-pressed`, one state in `sessionStorage` and on `<html data-motion>`, so it agrees with the page-wide switch; /signup already had one). It is clear of the badge (top left), the credit (bottom right) and the pill, its icon is white on a dark fill (0.8 alpha, at least 6:1 even over pure white, 4.5:1 or more also when pressed and amber), its focus ring is 3 px stage amber outside a dark gap, and it is hidden under reduced motion (where no video is rendered). Two latent faults found on the way and fixed: /mcp's header is outside `.nx`, so the stage tokens the button used (`--nx-stage-amber`, `--nx-stage-act`) were undefined there and an unresolved `var()` in `outline` drops the ring; they now have literal fallbacks. The phone panel's still asks for the 1,280 px file (`sizes` 200vw instead of 100vw, +8 kB, see the LCP note below).
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
| / | 437 / 775 | 435 / 664 | 670 / 1,419 | 663 / 1,316 |
| /pricing | 289 / 384 | 286 / 381 | 292 / 553 | 286 / 381 |
| /solutions | 303 / 449 | 304 / 446 | 664 / 665 | 451 / 451 |
| /login | 330 / 330 | 326 / 326 | 363 / 363 | 355 / 355 |
| /signup | 355 / 356 | 410 / 410 | 422 / 422 | 595 / 595 |
| /mcp | 344 / 420 | 477 / 547 | 344 / 450 | 610 / 710 |

Budgets: phone first load at most 600 (worst 477), phone full scroll at most 1,000 (worst 664), desktop full scroll at most 1,500 (worst 1,316; 1,322 scrolling in 1.5 s steps so every clip plays long enough to buffer). /signup and /mcp grow because they now play a clip (the stage is tall, so it needs the 1,280 px file).

LCP (median of 7 loads, ms, before / after) and CLS (worst of plain and font-held loads in en, ru and uz, after):

| Page | 390 LCP | 390 CLS | 1280 LCP | 1280 CLS |
| :-- | :-- | :-- | :-- | :-- |
| / | 196 / 184 | 0.0001 | 260 / 260 | 0.0002 |
| /pricing | 192 / 176 | 0.0017 | 224 / 224 | 0.0002 |
| /solutions | 148 / 132 | 0.0007 | 200 / 208 | 0.0008 |
| /login | 144 / 140 | 0.0011 | 188 / 184 | 0.0000 |
| /signup | 140 / 144 | 0.0011 | 184 / 216 | 0.0000 |
| /mcp | 200 / 192 | 0.0001 | 228 / 240 | 0.0003 |

CLS is at or under 0.0017 everywhere (/pricing on a phone, unchanged by this round); the 0.011 to 0.032 the first /mcp, /login and /signup builds showed (a text wrap that differed between the two faces) is what the reserved lines and the band heights fixed.

LCP at five phone widths (median of 7 loads, ms, Chromium at 1x, the LCP element in brackets). Before is this branch at 2c7679b6; after is the review fix; main is round 8 (fbc3af57), measured in the same run:

| Page, width | main | before | after |
| :-- | :-- | :-- | :-- |
| / 360 | 208 [img] | 220 [img] | 220 [img] |
| / 375 | 208 [img] | 196 [img] | 196 [img] |
| / 390 | 196 [img] | 192 [img] | 204 [img] |
| / 412 | 180 [img] | 364 [video] | 176 [img] |
| / 430 | 180 [img] | 368 [video] | 192 [img] |
| /mcp 360 | 204 [text] | 200 [img] | 220 [img] |
| /mcp 375 | 184 [text] | 196 [img] | 220 [img] |
| /mcp 390 | 196 [text] | 416 [video] | 212 [img] |
| /mcp 412 | 184 [text] | 200 [img] | 204 [img] |
| /mcp 430 | 180 [text] | 204 [img] | 204 [img] |
| /signup 360 | 152 [img] | 152 [img] | 144 [img] |
| /signup 375 | 156 [img] | 152 [img] | 148 [img] |
| /signup 390 | 160 [img] | 140 [img] | 144 [img] |
| /signup 412 | 144 [img] | 172 [img] | 140 [img] |
| /signup 430 | 148 [img] | 192 [img] | 156 [img] |

(main's /mcp LCP is a paragraph; a run to run spread of 20 to 60 ms is normal here, main itself moved 184 to 212 at /mcp 390 between two runs. /, /mcp at 768 and 1,023 px: 208 and 220 ms, 200 and 220 ms, images, against 196 to 224 on main.)

Cause (diagnosed by measurement: only the still's size changed and the element flipped back to the image at every width, not read from the browser's source), and why the 1 px inset of round 5 (3 px here) was not enough: the clip was never larger than its still, but Chromium discounts an image's paint area when the image is drawn larger than its own pixels. The panel is about 390 x 800 CSS px and its still was the 640 x 360 file stretched to cover it, so the still's candidate was a fraction of its box, while the clip's first frame (a later paint) is counted at its whole box. Which of the two wins depends on the width and on the run, which is why only 412, 430 (landing) and 390 (/mcp) failed. The panel's still now asks for the 1,280 x 720 file (`sizes` 200vw), which is never drawn larger than its pixels on a phone, so it counts in full and is also the earlier paint. The clips on /signup and /mcp, the landing's and the card's already start after the page has loaded and gone idle (`early`), so nothing is fetched during the LCP window.

Checks: axe 0 on six pages x en/ru/uz x light/dark x 390/1280 (and the three /solutions tabs); 96 states (8 pages x 3 languages x 2 widths x 2 themes) with no overflow and no small target; 42 contrast probes on rendered pixels (text made transparent, 95th percentile of the pixels behind each text box, large text 3:1, small 4.5:1), 0 flagged, the worst small text 4.92:1 (the closing "Start free"); tsc, eslint and vitest (new `tests/site-engage-9.test.tsx`: the panel, the wall button and hidden tiles, the bare card, the dashed key, the compact rendition, the reserved lines, the removed pictures); every media item still has a credit, no label says AI.

Frame pacing at 4x CPU throttle (Chromium, playing clip, 6 s window), 18 showcases (nine at 1280, nine at 390): 59.3 to 60.0 fps, one clip playing at a time everywhere. In three of the 18 runs a single frame took 50 to 67 ms, and in earlier runs one of 100 ms, never twice in the same place: the pattern fits the loop's wrap (a seek back to the start) under a 4x slowdown, not steady decoding cost. Decoding cost: the 1,280 clips are 215 to 400 KB per 8 to 10 s loop (about 0.2 to 0.35 Mbit/s), H.264 and VP9, 25 fps, so the decoder's work is small; the test machine has no GPU decode, so this was software decoding.

Seams (mean absolute grey-level step at the wrap against the median step, 1,280 px files, mp4 / webm): lossless coast 1.00 vs 1.16; encoded coast 3.6 / 3.0 against 0.7 / 1.0 (each encoded frame differs from its source by 2.6 to 3.6 grey levels, high-frequency wave texture, and the first and last frames are far apart in the encoder's prediction chain; a longer dissolve, no denoise and a lower crf did not change it, so the seam is a brief re-randomising of the foam texture, not a jump).

## Weak spots, plainly

- The phone landing is 1,424 px shorter, not the full 1,500; /mcp and the sign-in/up pages are 30 to 110 px longer on a phone.
- The /mcp header panel reserves text lines for the worst case, so in English at some widths there is a visible gap of one or two lines between the headline and the lead; that is the price of zero layout shift without a hidden-until-font-loaded trick.
- The phone panel's still is now the 1,280 px file (8 kB more than the 640 one, about 13 kB on the first load of / and /mcp), which is what keeps the still, not the clip, the page's LCP element (below). A clip's first frame is not discounted for its own size; a still drawn larger than its pixels is, so a 640 px still stretched over a tall phone panel loses to the clip.
- The wall tiles do not crossfade or play: there was nothing to cross to without new sourcing, so they zoom slowly.
- The coast clip's encoded wrap is unchanged (above). An isolated 50 to 100 ms frame appears occasionally at a loop wrap under 4x throttle.
- Not checked on a real iPhone or in Safari; the files are structurally standard.
- Pre-existing and untouched: the header overflows by 4 to 60 px at 1024 px in ru and uz (and by 20 to 30 px at 320 px) on every public page.

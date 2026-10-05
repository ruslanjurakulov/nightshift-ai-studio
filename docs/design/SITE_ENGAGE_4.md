# Site, round 4: image-led, one column, six blocks

Status: 2026-10-05. Builds on `SITE_ENGAGE.md`, `_2` and `_3`. The independent score of round 3 was 62 to 70 on a phone
(about 67) and 70 to 80 on a desktop (about 75): a plateau after three polish rounds. The reviewer's diagnosis was the
layout concept itself (card-heavy, text-forward, six short horizontal rails, 15,000 px phone pages, six stills repeated),
so this round replaces the concept instead of adjusting it. Every honesty, accessibility and performance rule of the earlier
rounds holds; no dependency, font, origin or script was added, and nothing generated or paid for.

## 1. The new landing: six blocks, one column

| # | Block | What it is |
| :-- | :-- | :-- |
| 1 | Hero | A pill, a very large tight headline (two lines on a desktop, three on a phone), one lead, one pill button, then the **chat card**: the ask, an "example reply", an example still with its badge, the drawn (unpressable) approve key, and the note under it. On a phone the ask, the reply and the top of the still are on the first screen. |
| 2 | How it works | Three steps in a strip: a numeral, a title, a sentence. The last step is the person's own press. |
| 3 | Three showcases | Three full-width rounded stills, one per capability (video, Studio, approvals), the headline over the picture, one sentence and one outlined button. A different still in each. |
| 4 | Try it | Compact: a prefilled sample plan (never an empty placeholder), two sample topics on a phone, the matching still on the thumbnail card. |
| 5 | Pricing | One block: the price check (from the published rate only) beside what is on sale (the plans, or the credit packs). There is no second "what it costs" panel anywhere on the page. |
| 6 | Questions and the last button | The FAQ (refunds open on arrival), the Google data statement beside it, and one closing button. |

Removed: the six horizontal rails (the capability rail, the studio tools, the gallery, the rules rail, the compare block
and the who-for tabs), the app screenshot figure, and everything that said a thing twice. The examples gallery is gone
rather than kept: it was the component with the dead-gap bug (a 566 px track under 228 px cards), and the three showcases
carry the stills now. `tests/site-engage.test.tsx` pins that none of those selectors is on the page.

### Showcase contrast

The words sit on a dark panel (phone) or a left-to-right gradient (desktop, text column 46% wide) that is at least 76%
black wherever there is text. Worst case, white text over a pure white pixel under a 0.78 black overlay is 11:1 (AA needs
4.5). The test works the numbers from the stops in the stylesheet and fails if they are lightened.

## 2. The media slot list

`components/site/samples.tsx` now has a `SLOTS` registry: pages ask for a slot by name (`<SlotImg slot="show.video" />`),
never for a file. The slots are `hero`, `show.video`, `show.studio`, `show.approvals`, `pricing.card`, `mcp.card`,
`sol.channels`, `sol.studio`, `sol.developers`, `auth.signin`, `auth.signup`. To add a still: put a WebP (900 px wide, under
60 KB) in `components/site/samples/`, import it in `samples.tsx`, add it to `SAMPLES`, give it an alt in
`lib/i18n/site/{en,ru,uz}.ts` under `site.samples.alts`, then point a slot at it: one line each. The owner has been asked to
approve eight to twelve more stills; with them the repeats between pages (not within a page) go away.

Rules the registry keeps: at most one still per section; no still twice on one page (a test counts); every still carries its
"Example frame" badge and a visible note.

## 3. Other pages

- **/solutions** is image-led: a short opening, then three large example frames (one different still each), each with who it
  is for, its three promises and the one thing it will not do. The three product pictures (publish desk, composer, endpoint
  list) open each solution page, where the API picture no longer breaks a path mid-word (the method sits on its own line,
  the path never wraps) and "what it will not do" is full width instead of a heading over an empty column.
- **/pricing** puts the headline and the price check in the first phone screen (the button follows them, side by side on a
  desktop). One flow follows: what you can buy (plans and packs together; the plan comparison is a disclosure), how a price
  goes from quote to charge (four words beside the chat card, the formulas one tap away), the terms with the payments
  paragraph (the Merchant of Record sentence, once), the questions. The money-anchor panel and the "Current rates" panel are
  gone; their facts are in the price check. When there is no published rate the page says why in words, and a failed read
  still reads as unknown (`tests/read-failures-pages.test.ts`).
- **/mcp** has the chat card above the fold instead of the row of client logos; the connect card follows. The walk-through,
  the six ask cards with drawn frames, the "works with" marquee and the open tool table are replaced by six plain cards, the
  example carousel and the tool list in a disclosure. The hero copy is left-aligned, so a font swap cannot re-centre its
  lines (the English page had a layout shift of 0.082 from that).
- **/login and /signup** are unchanged; the headline limit of three lines on a desktop is measured below.

## 4. Smaller items

- Labels and tags that were 13 px are 14 px or more (`site.css`, `site-next.css`, and four `text-xs` in public components);
  the honesty captions are 15 to 16 px.
- `MotionToggle` is a toggle button: its name stays "Pause motion" and `aria-pressed` says whether motion is paused.
- The footer and the table-of-contents rules use a mid-tone edge between the soft and the strong rule colour.
- Dead CSS was pruned (the rails, the old marquee, the drawn /mcp frames, the hero tiles); `SampleFrame` is only the
  example-still helper now.

## 5. Measurements

Production build against a fake backend that answers the public price list (60 credits a minute, minimum 10, packs
$10 / $45 / $160). Screenshots: `site-engage-4/before` (main, 47efa8c1) and `site-engage-4/after`, full page and first screen,
English, light theme, 390 and 1280 px wide (the phone pages are also at 360 px in the QA run).

### Page heights (px, English)

| Page | Phone before | Phone after | Desktop before | Desktop after |
| :-- | --: | --: | --: | --: |
| Landing | 15,082 | 9,051 | 14,395 | 8,277 |
| /pricing | 6,619 | 5,932 | 4,085 | 4,031 |
| /solutions | 5,674 | 4,687 | 3,360 | 3,059 |
| /mcp | 15,821 | 8,587 | 11,620 | 6,255 |
| /login | 1,055 | 1,055 | 900 | 900 |

On a phone the landing in Russian is 9,430 px and in Uzbek 9,316 px (longer words); on a desktop all three languages are
within 8,277 to 8,377 px.

### The checks

- **State matrix:** 9 public pages (landing, pricing, solutions and its three pages, mcp, login, signup) x 360 / 390 /
  1280 px x light and dark x English, Russian and Uzbek (the full matrix ran on an earlier build of this branch; the landing (18 states) and /pricing, /mcp and /solutions (54 states) were run again on the final build): axe serious and
  critical 0, horizontal overflow 0, targets under 44 px 0, no new external origin.
- **Layout shift** with the fonts held back 1.2 s, 36 page and language and width states: every state is 0.0039 or less
  before the last two fixes and **0.0004 or less on the landing and pricing after them**; `/mcp` English was 0.082 and is 0.0003;
  `/solutions` at 390 px in Uzbek was 0.0036 and is 0. Two causes found by listing the shifting nodes: a `ch` unit on the
  length read-out of the calculator (it re-sized with the font) and the "From the live price list" source, an inline run
  at the end of a paragraph that jumped 66 px when the paragraph wrapped differently (now a block of its own). The sign-in
  and sign-up pages in Uzbek on a desktop stay at 0.0026 as on main (a stage headline that wraps differently).
- **LCP** (median of six, throttle-free, dark) against main: landing 390 px 200 ms against 212, 1280 px 208 against 240;
  pricing +8 and +16 ms; solutions +32 and +40 ms; login and signup -4 and +16 to +24 ms; mcp -44 ms. All within
  100 ms of main.
- **JavaScript** on the page: 120 to 178 kB against 120 to 183 kB on main (the landing sends 125 kB against 127 kB); the
  landing transfers 294 kB against 462 kB at 390 px (fewer pictures). No new dependency, font or script.
- **Headlines:** every page's first heading is three lines or fewer on a desktop in all three languages (the landing's is
  two); on a phone the landing's Uzbek headline is four.
- **The carousel on /mcp** (the only one left): six slides of 272 x 340 px in a 364 px track at 390 px, 288 x 360 px in a
  384 px track at 1280 px: no dead gap (measured in a browser, not read from the CSS).
- **Tests:** tsc clean, eslint clean on the changed files (the six errors in `tests/public-menu.test.tsx` are on main),
  vitest 4,700 tests.

## 6. Weak spots, said plainly

- The landing is 9,051 px on a phone against a target of about 9,000, and longer in Russian (9,430). The Try block shows one
  sample card on a phone (the working titles); the other four are on a desktop.
- There are still six stills in the whole site and they repeat between pages (not within one). New ones are one line each in
  the slot list once the owner approves them.
- The Solutions pages (one per way in) are the least changed: the product picture and the ruled lists are as before, only
  full width where there was an empty column. They are 4,400 to 4,800 px on a phone.
- /pricing is only 10% shorter on a phone: the plan cards and the pack cards are the content the page exists for.
- /login and /signup are untouched by design.

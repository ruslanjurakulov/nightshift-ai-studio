# Site, round 3: structural

Status: 2026-10-05. Builds on `SITE_ENGAGE.md` and `SITE_ENGAGE_2.md`. The independent score of round 2 was 63 to 70 on a
phone and 66 to 77 on a desktop (round 1: 62 to 68 and 63 to 74), a gain of three to six points a round against a bar of
95, so this round is structural rather than polish: the first screen on a phone, pages that lead with the product,
fewer repeated pictures, motion that is honest and pausable, and the pages that had been left behind (`/mcp`, sign-in).
Every honesty, accessibility and performance rule of the earlier rounds holds; no dependency, origin or font was added.

## 1. The three should-fix items from the review

1. **Gallery dead gap.** The portrait frame (540 x 968) made the rail 540 to 570 px tall while the others were about
   230. The track now aligns its cards to the top and the portrait card is narrower (200 px).
2. **Sign-in and sign-up field edges were still hairline (1.2:1)** and the round-2 claim that they were fixed was
   false. See section 2: the cause was one level up from where round 2 looked.
3. **Approvals badge and the voice reply.** The Approvals example's picture said "Private on YouTube" instead of
   "Example frame", and the voice card said "made a voice-over" over a waveform. Every reply in the capability cards now
   reads "example reply" and every still carries "Example frame".

## 2. The border-colour root cause, properly this time

`app/globals.css` had an unlayered `* { border-color: var(--color-border) }`. An unlayered declaration beats every layered
one whatever its specificity, and **both** public stylesheets, `site.css` and `site-next.css`, sit entirely in
`@layer components`. So no border colour either file declared ever applied on the public pages: the amber edge of the
primary button, the 3:1 field edges (`.st-field input { border: 1px solid var(--ns-rule-strong) }` drew in the hairline
colour), the footer rules, the documentation tables. Round 2 only patched `site-next.css` (with a `--nx-edge`
indirection) and so missed the sign-in fields, which are styled in `site.css`.

The fix is at the root and costs the signed-in app nothing: the unlayered default now excludes the public pages'
subtree (`:where(*:not(.st):not(.st *))`, specificity zero, so the app keeps exactly the rule it had), and the same
default lives in `@layer base` inside `.st` (`PublicShell` and `AuthShell` are the only elements with that class), where
anything that names a colour wins. The `--nx-edge` indirection is deleted. `tests/site-next-css.test.ts` pins both halves
and that both stylesheets are layered, so it fails loudly if either side changes. Visible effect, everywhere on the public
pages: control edges are the intended strong colour (WCAG 1.4.11), footer and table rules are the intended weight.

## 3. The ranked list

| # | Point | What was done |
| :-- | :-- | :-- |
| 1 | Phone first screen | On a phone the hero is flattened and re-ordered: pill, headline (40 px, three lines), ask, button, **then the chat card, which opens with its frame**; the notes and the three promises follow. The frame now sits at about 560 to 740 px of an 844 px screen (it was 890 px down). Headline 40 to 96 px |
| 2 | Pricing and Solutions, product first | Pricing: the price check is the right half of the hero (no separate section, no second Start free inside it); the plan and pack cards come straight after; "What it costs" appears once, with the packs; the moon frame is gone. Solutions: each way in shows the product's own state (the publish desk, the composer, the endpoint list: the same pictures the solution pages open with) instead of a photograph |
| 3 | Fewer repeated pictures | The capability examples and the demo's thumbnail are **crops** of their stills (`data-crop`, a zoomed region), so the six frames do not read as the same picture four times; the hero and the gallery stay whole frames. Sign-in and sign-up each get their own bright frame (lanterns, dunes) instead of the dark moon. Solutions and Pricing no longer use a still |
| 4 | Honest motion with a pause | A very slow drift (48 to 61 s, transform only, alternating, desynchronised) on the hero frame and the gallery frames; the gallery cards ease in staggered; the sample plan draws itself once when it first scrolls into view (held back only when it starts below the fold, never when motion is reduced or paused). The drift starts after load like the hero light and stops with the existing "Pause motion" switch (a test pins the specificity and that every infinite animation is named by a pause rule) |
| 5 | One primary action | The header's "Start free" is the same amber key as the page's button |
| 6 | Sign-in and sign-up | A bright warm frame under a lighter overlay on a wide screen; on a phone the same frame is a band above the form with the brand over it (it was plain text cards) |
| 7 | Small labels, ru tab, cramped heading | Captions, notes, the rail, the badges and the calc text moved from 13 to 14.5 px up to 14 to 15 px; the rail's labels have room (Russian "Одобрение" and "В эфире" no longer touch); the price-check heading is "What will your video cost?" (two lines, not four) |
| 8 | Rhythm | The three promises are open columns with a top rule on a wide screen instead of three more rounded cards; the comparison and demo cards use tighter corners; the gallery and the demo under it are one raised band (no double section padding) |
| 9 | `/mcp` | Replies read "example reply", the video frame and the thumbnails carry "Example frame", no play glyph on a still; the hero's headline, lead and note are sized in `em` (a `ch` is the width of the font's zero, so a box sized in it re-centres every line when the fonts swap): font-swap CLS ru 0.0332 to 0.0005, uz 0.0097 to 0.0016 |
| 10 | Stale comment | The "four-state picture" comment in `Landing.tsx` is gone |

Not done: the `/mcp` hero was not rebuilt around a chat card (it already has the ask-and-reply cards and the six-frame
carousel, so adding the landing's card would duplicate them), and its English font-swap CLS is reduced but not fixed
(section 4).

## 4. Measured results

Real Chromium (chromium-1194), production builds of the head of `claude/site-engage-2` (cdda0f68, "before") and of this
branch, built the same way (the visual-QA fake backend extended in a scratch copy to answer `public_video_rates`: 60
credits a minute, minimum 10; packs $10 / $45 / $160). 6 pages x 360 / 390 / 1280 x light and dark x en, ru, uz = 108 states
per side. Screenshots: `site-engage-3/before/` and `site-engage-3/after/`.

| Check | before (round 2 head) | this branch |
| :-- | --: | --: |
| States captured without an error | 108 / 108 | 108 / 108 |
| axe 4.x serious or critical | 4 (all `/mcp`, a scan landing mid-fade of the "How it works" rows) | `/mcp` only, the same fade (which states it lands in varies from run to run); the one landing hit seen in a first run was the start bar fading out under a scan, fixed by making it leave at once and re-checked (below) |
| Horizontal overflow | 0 | 0 |
| Controls under 44 px | 0 | 0 |
| External requests | 0 | 0 |
| CLS with every font held back 1.2 s (36 loads) | max 0.149 (`/mcp` 1280 en) | max 0.082 (`/mcp` 1280 en); `/mcp` ru 0.0332 to 0.0003, uz 0.0097 to 0.0021; `/pricing` 1280 ru 0.0058 to 0.0036. Over the 0.002 budget: `/mcp` 1280 en 0.082, `/solutions` 390 uz 0.0036 (was 0.0001: the product picture below a heading that wraps differently in the fallback face), `/pricing` 1280 ru 0.0036, `/login` 1280 uz 0.0027 and `/signup` 1280 uz 0.0026 (both unchanged) |

| Page and width | First-load transfer KB | First-load JS KB | LCP ms, median of 6 | Page height px (en, dark) |
| :-- | --: | --: | --: | --: |
| landing 390 / 1280 | 462 -> 462 / 549 -> 549 | 127 -> 127 | 220 -> 240 / 276 -> 272 | 15,598 -> 15,082 / 14,565 -> 14,395 |
| pricing 390 / 1280 | 284 -> 251 / 285 -> 253 | 130 -> 129 | 148 -> 164 / 240 -> 184 | 7,481 -> 6,619 / 5,050 -> 4,085 |
| solutions 390 / 1280 | 367 -> 240 / 368 -> 241 | 120 -> 120 | 136 -> 140 / 160 -> 200 | 4,474 -> 5,674 / 3,035 -> 3,360 |
| sign in 390 / 1280 | 290 -> 350 / 321 -> 350 | 182 -> 182 | 120 -> 128 / 156 -> 160 | 985 -> 1,055 / 900 -> 900 |
| sign up 390 / 1280 | 292 -> 336 / 323 -> 336 | 183 -> 183 | 112 -> 124 / 184 -> 160 | 1,182 -> 1,252 / 992 -> 992 |
| `/mcp` 390 / 1280 | 360 -> 361 / 361 -> 361 | 124 -> 124 | 232 -> 232 / 276 -> 244 | 15,821 -> 15,821 / 11,590 -> 11,620 |

Read this honestly:

- **The phone landing barely got shorter** (15,598 to 15,082 px; 19,345 on `main` before round 2). The first screen is what
  changed, not the length: the frame now starts at about 560 px. The comparison's "by hand" list is hidden on a phone
  (one summary line instead), which is most of the saving.
- **Solutions is taller** (the product pictures are bigger than the photographs were) and Pricing is shorter (one
  "what it costs", no separate price-check section). The Solutions transfer fell by about 130 KB for the same reason.
- LCP moved within run-to-run noise (+20 ms at worst on the landing at 390). First-load JavaScript is unchanged.
- The one new CLS regression is Solutions 390 uz (0.0001 to 0.0036): the picture sits below a title that wraps
  differently once the fonts swap. It is small but it breaks the 0.002 budget.


## 5. Weak spots, in my own order

1. **It is still stills and text.** The motion is a slow drift on six frames; there is no video, so the "alive" gap to a
   product that shows moving output is imagery and cost, not CSS.
2. **The phone landing is still about 15,000 px.** Three more cuts are obvious (the real approval screenshot, the tabs
   panel, the money panel) and each loses real content.
3. **`/mcp` English font-swap CLS is 0.08** (was 0.149): the centred hero re-centres its lines when the fonts swap, and
   only a left-aligned hero or a measured fallback face fixes that.
4. **Four-line Uzbek headline on a phone** and the new ru/uz strings still need a native read.
5. **The border fix changes the weight of every edge on the public pages.** I looked at Terms, the API reference and the
   404 in both themes and they read well, but the other legal pages, the MCP tool pages and the OAuth screens were not
   looked at.
6. **Stills' licence is unconfirmed** (`SITE_ENGAGE.md` section 3).

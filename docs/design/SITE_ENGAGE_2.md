# Site, round 2: toward Krea

Status: 2026-10-05. Builds on `SITE_ENGAGE.md` (round 1, merged as #400). An independent scorer put round 1 at 62 to 74
out of 100 against the owner's bar of 95 ("Krea-level"). This round is the reviewer's ranked list. Everything the
earlier rounds promised still holds: no invented proof, no provider names, every picture labelled as an example, the
publish story unchanged, no new dependency, origin or font. Pinned by `tests/site-engage.test.tsx`,
`tests/site-next-css.test.ts`, `tests/public-pages.test.tsx`.

## 1. What changed, against the list

| # | Reviewer's point | What was done |
| :-- | :-- | :-- |
| 2 | A real frame on the first screen, not an empty black stage | The four-tab drawn stage (`PressStage`) is gone. The hero is a very large, left-aligned headline beside a chat card (`HeroCard`): the ask, an "example reply", one of the example stills, the private/check/waiting lamps and the drawn "Approve and publish" key, with the AI-still note printed under it. It uses the page's own theme, so it works on paper and on the console |
| 3 | An examples rail like Krea's art carousel | `Gallery` (`#examples`): the six stills on the same keyboard-operable snap carousel `/mcp` uses, each with "Example frame" and its one-line ask under it. Nothing moves by itself, so there is nothing to pause |
| 5 | The Try idle state was ~1,100 px of grey skeletons | It opens filled with the first sample topic's plan, tagged Example, with a line saying so; typing a topic of your own replays it. The ghosts and the shimmer are deleted |
| 6 | Larger, tighter display type; fewer 13-14 px labels | Hero 46 to 96 px, section headings 34 to 64 px at -0.036em with a 17ch measure; the labels and kickers moved to 15 px, the pill to 15, the hero notes to 15; the compare and tab copy to 16 |
| 7 | Frames on Pricing and Solutions, the price check on Pricing, a richer sign-in stage | Each Solutions row has an example frame; Pricing has one above the promises and the price check from the published rate (absent when none is published); the sign-in and sign-up stage is the moon frame under the three rules, with the note printed |
| 8 | Cut the phone length | The landing is **19,345 px to 15,598 px** at 390 (en). The five capability sections are one sideways snap rail on a phone; the three promises are a rail; the plan's five cards are a snap row; the comparison is two short lists instead of six repeated rows |
| 9 | A topic-aware demo with a matching still | `pickStill` (`lib/site/demo-plan.ts`): the first of six frames whose words (en, ru, uz) the topic touches, else a fixed hash, so a topic always shows the same frame. It is a stand-in from six and says so beside the picture (`try.thumbNote`); nothing is generated |
| 10 | ru and uz headlines wrapped to four lines | ru/uz hero size retuned (36 to 72 px). Russian sits on two or three lines; Uzbek ("Videoni biz tayyorlaymiz. Nashr qilishni siz bosasiz.") is still four at 390, balanced, because at a size that would fit one line it would be 27 px, which is the opposite of the brief |

## 2. A finding that was not on the list: layered border colours never applied

> **Correction (round 3).** This section first described a `--nx-edge` workaround for `site-next.css` and said the
> sign-in fields' edges were fixed. Both were wrong in scope: `site.css` is in the same layer, so the fields (whose edge
> is written there) and every other `site.css` border stayed hairline. Round 3 fixes it at the root; see
> `SITE_ENGAGE_3.md` section 2. The diagnosis below stands.

`app/globals.css` held an unlayered `* { border-color: var(--color-border) }`. An unlayered declaration beats every
layered one whatever its specificity, and both public stylesheets (`site.css`, `site-next.css`) are entirely inside
`@layer components`, so **no border colour either of them declared ever applied**: the amber edge of the primary button,
the 3:1 edge of the sign-in fields, the outline of a selected tab all drew in the hairline colour (measured on `main`:
every one of them `rgb(45, 43, 38)`).

Another cause worth knowing: visually-hidden spans (`.sr-only`, `position: absolute`) inside a horizontal rail whose
ancestors are not positioned escape the rail's clipping and widen the page on a phone (a first build overflowed by 417 px).
The rails are `position: relative`.

## 3. Example frames

Provenance as in `SITE_ENGAGE.md` section 3: AI-generated stills made on 2026-10-05 for demonstration; the commercial-use
licence of the generating tool is still to be confirmed by the owner. They were re-encoded to 900 px wide WebP (the
portrait one 540), 30 to 60 KB each (the first round's 1200 px files were 55 to 115 KB and pulled 360 KB onto the first
load). Where they appear: the hero card, the gallery, the capability examples, the Try thumbnail, the Solutions rows,
the Pricing hero, the sign-in stage and `/mcp`. Every one carries "Example frame" and a visible note.

## 4. Measured results

Real Chromium (chromium-1194), production builds of `main` (7b73ae5b, which includes round 1) and of this branch, built
the same way (the visual-QA fake backend extended in a scratch copy to answer `public_video_rates`: 60 credits a minute,
minimum 10; pack prices $10 / $45 / $160). 6 pages x 360 / 390 / 1280 x light and dark x en, ru, uz = 108 states per
side. Screenshots: `site-engage-2/before/` and `site-engage-2/after/`.

| Check | main | this branch |
| :-- | --: | --: |
| States captured without an error | 108 / 108 | 108 / 108 |
| axe 4.x serious or critical | 4 (all `/mcp`, a scan landing mid-fade of the "How it works" rows; see round 1) | 6 (all `/mcp`, the same fade, which state it lands in varies from run to run); 0 on every other page |
| Horizontal overflow | 0 | 0 |
| Controls under 44 px | 0 | 0 |
| External requests | 0 | 0 |
| CLS with every font held back 1.2 s (36 loads), pages this round touched | landing 390 en 0.0114, landing 1280 en 0.0037, solutions 390 ru 0.0122 | 0.0001, 0.0003, 0.0000 |
| Same test, pages with a pre-existing value | `/mcp` 1280 en 0.1495, `/mcp` 1280 ru 0.0332, `/mcp` 1280 uz 0.0097, `/pricing` 1280 ru 0.0058, `/login` 1280 uz 0.0026 | 0.149, 0.0337, 0.0097, 0.0058, 0.0027: unchanged, not caused by this round |

| Page and width | First-load transfer KB | First-load JS KB | LCP ms, median of 6 | Page height px (en, dark) |
| :-- | --: | --: | --: | --: |
| landing 390 / 1280 | 299 -> 462 / 301 -> 549 | 127 -> 127 | 248 -> 216 / 272 -> 256 | 19,345 -> 15,598 / 14,316 -> 14,565 |
| pricing 390 / 1280 | 250 -> 284 / 251 -> 285 | 129 -> 130 | 176 -> 156 / 188 -> 260 | 6,230 -> 7,481 / 4,482 -> 5,050 |
| solutions 390 / 1280 | 236 -> 367 / 238 -> 368 | 120 -> 120 | 140 -> 136 / 160 -> 168 | 4,060 -> 4,474 / 2,554 -> 3,035 |
| sign in 390 / 1280 | 290 -> 290 / 290 -> 321 | 181 -> 182 | 124 -> 120 / 148 -> 164 | 985 -> 985 / 900 -> 900 |
| sign up 390 / 1280 | 291 -> 292 / 291 -> 323 | 182 -> 183 | 140 -> 124 / 148 -> 176 | 1,182 -> 1,182 / 992 -> 992 |
| `/mcp` 390 / 1280 | 360 -> 360 / 361 -> 361 | 124 -> 124 | 228 -> 248 / 268 -> 248 | 15,821 -> 15,821 / 11,590 -> 11,590 |

Read this honestly:

- The first screen now holds an image and LCP stayed inside the budget (+72 ms at worst, on `/pricing` 1280, where the
  frame above the promises is the largest paint; everywhere else it is the headline and within noise). The landing's
  JavaScript is unchanged: the four-state stage's timers left, the example's phone-scroller check and the rails came in.
- **First-load transfer grew** (landing +163 KB at 390, +248 KB at 1280; Solutions +130 KB): the browser fetches lazy
  frames that sit within roughly a screen and a half of the fold, including the first cards of the gallery. The frames
  are 30 to 60 KB each; the first round's 1200 px files would have made this about 80 KB worse.
- The wide landing is *not* shorter (14,316 to 14,565 px): it gained the gallery and the frames, and the capability rows
  are still rows. The phone landing is 19% shorter. Pricing and Solutions are taller on purpose (a price check, frames).
- The `/mcp` font-swap value (0.149) is a lead paragraph that wraps to three lines in the fallback face and two in Onest
  (the fallback is tuned for the landing's sizes); it is old, outside this round's pages, and left for its own fix.

## 5. Weak spots, in my own order

1. **The page is still mostly stills and text.** There is no video and nothing animates except the hero light, so the
   "cinematic" gap to Krea is imagery: six frames, one of them reused four times across the site.
2. **The wide landing is long** (about 14,500 px). Capabilities are still five alternating rows on a desktop.
3. **ru and uz headlines are four lines at 390** in Uzbek.
4. **`/mcp` got the least**: outlined buttons, frames and the pointer light; its "How it works" tab loop still produces
   the axe mid-fade hit on `main` and here.
5. **The 900 px frames** are soft at 2x pixel density on the biggest cards.
6. **The border fix changes the weight of every edge on the public pages**; it is the intended design, but it is a
   visible change that nobody has reviewed side by side except in the screenshots.
7. **Native-speaker pass** for the new ru/uz strings (gallery captions, compare summaries, try notes) is still owed.

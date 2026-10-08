# Site, third pass: reasons to stay

> **Superseded in part (round 7b and after).** The pictures this document describes as AI-generated stills, the clips made from them and the drawn light over them are gone: the public pages now show credited Pexels stock photos and footage, labelled as examples (`SITE_ENGAGE_7B.md`, `SITE_ENGAGE_8.md`, `MEDIA_CREDITS.md`). Read what follows as history; the layout, type, motion and honesty rules it records still apply unless a later round says otherwise.


Status: 2026-10-05. Owner of this file: design. Builds on `SITE_KREA.md` (the layout and the
honest-copy rules), `HUMAN_TYPE.md` (Onest, the scale) and `IDENTITY.md` (the palette). Code:
`components/site/site-next.css`, `components/site/{SiteEffects,HeroFx,MotionToggle,StickyCta,samples}.tsx`,
`components/landing/{TryDemo,PriceCheck,PriceSlider,WhoTabs,Compare}.tsx`, pure logic in
`lib/site/{demo-plan,price-check,motion}.ts`, copy in `lib/i18n/site/{en,ru,uz}.ts`. Pinned by
`tests/site-engage.test.tsx`, `tests/site-next-css.test.ts`, `tests/public-pages.test.tsx`,
`tests/mcp-landing.test.tsx`, `tests/human-type-tokens.test.ts`.

The owner (Uzbek): make the public site commercial-level, with effects, clarity, fonts, colours and
components that make a visitor stay. Everything below stays honest: no invented customers, counts,
ratings or scarcity, no provider or model names, every picture labelled as an example, the publish
story unchanged (nothing goes public without the person; uploads are private).

## 1. What the tools suggested, what was used, what was refused

### 21st.dev (free tier: search and previews free, two code retrievals a day)

Searches: animated aurora hero backgrounds, pointer-following spotlight cards, pricing cards with
hover highlight, feature tabs. Previews were fetched and looked at. The two retrievals went on the two
pieces that would be hardest to get right from a picture:

| Piece (21st id) | What it showed | Used? |
| :-- | :-- | :-- |
| Spotlight (35180) | A soft radial light that follows the pointer across a card, plus a lit 1px edge ring, written as two CSS variables updated in `requestAnimationFrame` | **Idea and technique, own code.** `components/site/SiteEffects.tsx` (one delegated listener, no per-card component) and the pseudo-elements in `site.css`. The source depends on Radix Slot and a `cn` helper and carries no licence statement, so none of it was copied; the amber colour, the fine-pointer and motion gating and the focus behaviour are ours |
| LiquidAurora (7937) | The retrieved file held only the markup (three `liquid-shape` divs); its keyframes and CSS were not part of the retrieval | **Idea only.** `HeroFx` is three radial-gradient blobs drifting with two composited transforms, in the theme's amber (the sample is a blue-purple aurora, which `IDENTITY.md` bans) |
| Feature tab switcher (27081), Feature 108 (607) | Preview only: a vertical tab list beside a panel, arrow keys move between tabs | **Pattern.** `WhoTabs` is a roving-tabindex tablist whose panels are all in the HTML; every word comes from the Solutions pages' copy |
| Pricing cards (10471, 27099, 27096) | Preview only: hover-animated cards, a monthly/annual toggle | **Hover only.** Pack and plan rows take the pointer light. **Refused:** the monthly/annual toggle (the plan data holds monthly prices only) and any "most popular" badge (nobody measured it) |
| Aurora Background (8268, 18263) | Framer Motion / canvas aurora | **Refused.** A new dependency or a canvas loop for a decoration; no |
| Video hero results (inspiration search) | Glass hero with a video background | **Refused.** Autoplay video, blur and glass are out (`IDENTITY.md`, WCAG 2.2.2, LCP) |

No dependency was added (`package.json` is unchanged; `motion` was already there and is not used by
this pass). No new origin, font or script.

### ui-ux-pro-max

`--design-system` for "YouTube video automation SaaS landing" returned Glassmorphism, a blue primary
with an orange accent, and Plus Jakarta Sans. Refused: glass and a blue primary contradict the
identity, and Plus Jakarta Sans has no Cyrillic (`HUMAN_TYPE.md` measured that). What it said that
we took: a hero with a sticky call to action and one at the end; check the label contrast against the
button fill at 4.5:1; keep focus and component edges visible on their own; **disable hero
motion under reduced motion and render the static final state**; an interactive demo only where it
explains value better than static media, with a non-motion fallback and a way to pause; focus
rings on every control; smooth scrolling for anchors; disable a button while it works.

## 2. What was built

One primary action across the site: the amber button (`.nx-btn`, `.st-key`). Everything else is
outlined in the same 14px corners or is a link. The black pills (the capability buttons on the
landing, the "copy this ask" buttons on `/mcp`) became outlined buttons; the header's "Start free"
stays outlined on purpose, so the hero's button is the only filled one on the first screen.

**Landing (`/`)**
1. *Hero.* The headline's second line is set in the lit amber text colour (the paper-safe amber on
   light); a faint grid and three soft blobs drift behind it (transform only; paused by one switch);
   the three promises sit under the button as a checklist (they are the page's own promise titles);
   the four-state picture keeps its stage and gains an amber rim. The example frame inside it is
   fetched only once the visitor is past the first state.
2. *Try it* (`#try`). Type a topic or pick one of four; five cards fill in one after another: working
   titles, script outline, voice and look, shot list, thumbnail brief. It is the shape of a plan with
   the visitor's words dropped in; the card says "Example", the lead says nothing is generated and
   nothing leaves the browser, and when it is done it says what the real run adds (research and
   checking, the price on the button, your approval) next to "Make this for real". No server, no paid
   call. Empty asks are refused in words; reduced motion or the pause switch shows the whole plan at once.
3. *How it works*, the five capability rows (now with example frames), then *Who it is for* as tabs
   (channels, creators, developers), each panel built from that Solutions page: what it does for you,
   where to start, the one thing it will not do.
4. *What you control*: the three promises, each as before, with the pointer light.
5. *By hand or with Nightshift*: six steps, who does each. It has no hours, percentages or
   "x times faster" because nothing measures them; the two steps that stay with the person (the topic,
   the publish press) are tinted.
6. *Price check*: a slider from 1 to 20 minutes and the quote it implies, from the published
   per-minute rate (the smallest quote, the dollars at the smallest pack's price, how long the free
   credits last). **Only rendered when a rate is published**; otherwise the money panel below keeps
   saying "No price published yet". The slider's range is a control's bounds, not a claim.
7. *Money*, *Questions*, the closing call (now with a third link back to the example) and a
   **sticky start bar** that appears once the hero's button has scrolled away and steps aside at the
   closing call and the footer (dismissible for the tab; `position: fixed`, so it shifts nothing).

**Pricing, Solutions, Solution pages**: the same light behind the hero; pack and plan rows and the
solution rows take the pointer light (hover highlight; no "most popular"). **Sign in / sign up**:
the shared button and token changes only. **`/mcp`**: outlined secondary buttons, pointer light on the
ask and demo cards, and the AI-generated example frames in place of the drawn scenes.

**Motion rules kept.** Every transition and animation is in a `prefers-reduced-motion: no-preference`
block (pinned by a test); `html[data-motion="paused"]` stops every infinite one, and a "Pause motion"
button (44px, near the picture) sets it for the tab; the four-state picture and the example's reveals
follow it; no autoplay video; transform and opacity only; no scroll-jacking; the below-the-fold
ease-in marks only elements that start off screen, after the script has run, and a jump to an anchor
or the End key reveals what it skipped.

## 3. Example frames: provenance and rules

Six AI-generated stills in `components/site/samples/` (re-encoded from the supplied files to 1200 px
wide WebP, 55-115 KB each, the lighthouse vertical at 720 px wide; the PNG originals are not in the
repository). **Provenance: AI-generated stills made on 2026-10-05 for demonstration; the
commercial-use licence of the generating tool is still to be confirmed by the owner.** Until it is,
these are placeholders to be swapped for licensed or owned media: nothing else depends on them
(`components/site/samples.tsx` is the only place that names the files).

Rules each use keeps: labelled "Example frame" (or inside a figure that says "Example"); never
presented as a customer's result or as output of a real account (`site.samples.note` says they are
AI-generated stills made for the page); no tool or provider named; width and height on every `<img>`,
inside an aspect-ratio box, all lazy (no frame is the largest paint; the hero's is not even requested until the visitor is past the first state); served from this
origin (`img-src 'self'` already allows it); `alt` is descriptive in en, ru and uz where the picture
stands alone (the `/mcp` carousel, the capability figures' labels) and empty inside pictures that are
already hidden from assistive tech.

| Frame | Where |
| :-- | :-- |
| silkroad | the hero picture (approve and live states); `/mcp` "dunes" |
| library | the Video capability; `/mcp` "rings" |
| valley | the Studio capability; `/mcp` "hills" |
| nightmarket | the Channels capability and its thumbnail; `/mcp` "city" |
| moon | the Approvals capability; `/mcp` "stars" |
| lighthouse | `/mcp` "waves" (portrait) |

## 4. Rules kept

No fabricated proof (a test greps the landing for customer, rating, count and countdown wording);
no provider or model names (`PROVIDER_BRANDS`); en/ru/uz parity and the Uzbek apostrophe rules; prices
only from the pricing source; the Merchant of Record sentence appears once on `/pricing`;
middleware, public paths, CSP, auth, API routes and `supabase/` untouched; flags unchanged; no new
dependency, origin or font.

## 5. Measured results

Real Chromium (chromium-1194), production builds of `main` (6b5ba3a3) and of this branch built the
same way (Supabase URL pointed at the repo's read-only visual-QA fake, extended in a scratch copy to answer
`public_video_rates` with 60 credits a minute and a minimum of 10, so the priced states can be seen;
display prices $10 / $45 / $160 for the packs). 6 pages (landing, pricing, solutions, sign in, sign up,
`/mcp`) x 360 / 390 / 1280 x light and dark x en, ru, uz = **108 states per side**. Screenshots are in
`site-engage/before/` and `site-engage/after/` (a selection named `<page>-<width>-<theme>-<lang>.webp`,
full page, cut at 9,000 px; `after/fx-*.webp` show the sticky bar, a played-out example and the pointer
light).

| Check | Before | After |
| :-- | --: | --: |
| States captured without an error | 108 / 108 | 108 / 108 |
| axe 4.x, serious or critical | 0 | **0** on every page but `/mcp`; see the note below |
| Horizontal overflow, 360 / 390 / 1280 | 0 | **0** |
| Controls under 44px high | 0 | **0** |
| External requests | 0 | **0** |
| CLS, normal load (max of 108) | 0.0005 | **0.0005** |
| CLS with every font file held back 1.2 s (36 loads: 6 pages x 3 languages x 390 / 1280) | max 0.1495 (`/mcp` 1280 en) | **max 0.149**; no state is worse than before. The pages this pass touched: landing 390 en 0.0116 -> 0.0114, landing 1280 en 0.0035 -> 0.0037 |

`/mcp` axe note: the existing "How it works" job panel fades its rows in (`.st-reveal`), and a scan that
lands inside the 0.45 s fade reads a half-transparent colour. With the same capture script **`main`
shows the same hit** (`mcp` 360 dark en, 390 light ru, 390 dark ru, 390 light uz on main; five other
states on this branch: the timing decides which), and every one of them reads 0 when the scan waits 3 s
for the fade. It is not part of this pass and is left for its own fix.

| Page and width | Transfer KB, first load | First-load JS KB (route) | LCP ms, median of 6 | Page height px |
| :-- | --: | --: | --: | --: |
| landing 390 | 283 -> 299 | 114 -> 120 | 168 -> 244 (+76) | 14,617 -> 19,074 |
| landing 1280 | 313 -> 301 | 114 -> 120 | 184 -> 264 (+80) | 10,640 -> 14,116 |
| pricing 390 / 1280 | 244 -> 250 / 245 -> 252 | 120 -> 122 | 128 -> 144 / 128 -> 172 | 6,170 -> 6,230 / 4,422 -> 4,482 |
| solutions 390 / 1280 | 231 -> 236 / 233 -> 238 | 111 -> 113 | 120 -> 136 / 148 -> 164 | 4,101 -> 4,161 / 2,494 -> 2,554 |
| sign in 390 / 1280 | 280 -> 290 | 159 -> 159 | 116 -> 116 / 120 -> 136 | 985 -> 985 |
| sign up 390 / 1280 | 281 -> 291 | 160 -> 160 | 116 -> 120 / 124 -> 136 | 1,182 -> 1,182 |
| `/mcp` 390 / 1280 | 360 -> 360 | 116 -> 117 | 228 -> 220 / 252 -> 248 | 15,821 -> 15,821 / 11,567 -> 11,590 |

Read this honestly:

- **The landing is 30% taller** (it gained the example, the tabs, the comparison and the price check) and
  the whole-page weight after scrolling to the end goes from 313 to 638 KB at 1280 because the example
  frames are lazy and now exist (`/mcp`: 361 -> 832 KB scrolled to the end, six carousel and frame
  pictures). The first load carries none of them: the landing's JavaScript grew by 6 KB.
- **LCP** (it is the first paint: the text) is within the +100 ms budget on every page, +80 ms on the landing at worst. Two first
  versions were worse and were fixed after measuring: the light's drift started at first paint (about
  50 ms; it now starts 200 ms after load), and one client component was handed the whole dictionary
  as a prop, which put 300 KB into the HTML (a test now forbids it).
- The pointer light, the ease-in, the sticky bar, the slider and the tabs add no layout shift: the bar is
  fixed, the plan's cards share one grid cell with their ghosts, the tabs' panels share one cell, and the
  ease-in is opacity and transform only on elements that start below the fold.

### Review fixes (step 1 after the first independent score)

- **Pause now stops the hero light.** The blobs' running rule (`html[data-fx="on"] .nx-fx-blob[data-n]`, 0,3,1) beat the
  pause rule (0,2,1); the pause selector now names `[data-fx]` and `[data-n]` too (0,4,1) and a test compares the two
  specificities and order. Checked in Chromium: running, then paused and frozen, and still paused on the next page. The
  remembered choice is restored to `<html>` before `data-fx` is set (`restoreMotion`), and nothing moves before JavaScript
  has run at all, so no inline script is needed.
- **The disclosure is printed.** The note that the frames are AI-generated stills is now visible text under the hero picture
  and under every capability example that holds a still (en/ru/uz), not only an aria-label. Replies over a still read
  "example reply" instead of "made a video". The play glyph on stills (hero stage and `/mcp`) is gone: it implied video.

## 6. Risks and what to do next

1. **The example frames' licence.** They are AI-generated stills; the tool's commercial-use licence is
   unconfirmed (section 3). Swap them (one file, `samples.tsx`) if it cannot be confirmed.
2. **Uzbek and Russian copy** for the new strings was written for the page, not translated word by word,
   and has not been read by a native speaker other than the owner. `lib/i18n/site/uz.ts` is the review.
3. **The try-it example is a template, not a generator.** The five cards are the same for every topic with the
   topic dropped in. The page says so; if it ever feels thin, the honest upgrade is a real (rate-limited,
   server-side, free-tier) plan call, which is a different PR.
4. **The price check disappears when no rate is published**, by design; check it on a deployment that has one.
5. **Landing length.** If it is too long, cut in this order: the comparison, the tabs (their content lives on
   the Solutions pages), then the Studio row.
6. **A sticky bar under the hero** covers the bottom 70 px of the screen until it is dismissed; `html:has(.nx-bar)`
   adds scroll padding so a focused control is not hidden behind it (WCAG 2.4.11).

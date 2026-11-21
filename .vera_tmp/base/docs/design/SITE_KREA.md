# Site, second pass: what makes Krea's site feel calm and premium, and what we took

> **Superseded in part (round 7b and after).** The pictures this document describes as AI-generated stills, the clips made from them and the drawn light over them are gone: the public pages now show credited Pexels stock photos and footage, labelled as examples (`SITE_ENGAGE_7B.md`, `SITE_ENGAGE_8.md`, `MEDIA_CREDITS.md`). Read what follows as history; the layout, type, motion and honesty rules it records still apply unless a later round says otherwise.


Status: 2026-10-03. Owner of this file: design. Builds on `HUMAN_TYPE.md` (Onest, the scale,
the radii) and `ATELIER_CONCEPTS.md` (the earlier landing concepts). Code: `components/landing/*`,
`components/site/site-next.css`, `components/pricing/PricingView.tsx`, `components/auth/AuthShell.tsx`,
copy in `lib/i18n/site/{en,ru,uz}.ts`. Pinned by `tests/public-pages.test.tsx`,
`tests/site-next-css.test.ts`, `tests/site-copy.test.ts`.

The owner, after the type overhaul: "Yes, do it: look at Krea, what an excellent design." So the
public pages (landing, pricing, solutions, sign in, sign up) were brought to that bar, in our own
identity: the folded N on its black tile, amber, Onest, original copy and drawn product states.
Nothing of Krea's was copied: not a word, not an asset, not its palette (Krea is black, white and
one blue; we are warm neutrals and amber).

## 1. Research (public pages only, no login, third-party scripts blocked)

Method: `curl` with `Accept: text/html` and Chromium (`/opt/pw-browsers`) through the session
proxy, trusting only the proxy's CA (SPKI pin, verification never disabled). 390 and 1280 px.
Measured with computed styles; screenshots in `design-inbox/site-krea/research/` (not committed;
the ones that matter are described below). Also looked at Higgsfield, Linear and Vercel for contrast.
`krea.ai/image`, `/video` are the signed-out app itself (a sidebar and an empty canvas), `/enhance`
is a 404: the marketing surface is the home, pricing, `/mcp` and the docs.

### Krea home (`/`)

| Aspect | What it does (measured) |
| :-- | :-- |
| Hero, phone 390x844 | Header 68px (logo tile, white pill "Sign up for free", dark pill "Log in", menu). A small "New" pill, **one** H1 (36px, weight 400, line 37.8, set in three lines, centred), one 18px line, **two** buttons stacked (white pill 48px, ghost pill 50px). The product (a monitor with the app on it, a dark photographic desk) shows behind the buttons and is cut by the fold. First frame: message + CTA + a hint of the product. |
| Hero, desktop | Same, H1 60/63, the monitor with the app UI centred under the buttons. One idea per frame. |
| Rhythm | Dark hero, then an abrupt switch to white for the rest. Sections are 80-128px apart. Headlines: 36px phone, **72px desktop**, weight 600, tight; two-line statements ("Dead simple UI. No tutorials needed."). Body 16, secondary text grey. |
| How the product is shown | A bento grid of tiles, each one idea (a number, a word, an image): "22K pixels upscaling", "64+ models", "Train". Tiles are 16-24px radius, tone-on-tone, no borders. A looping muted video inside the use-case block. |
| Social proof | Logo strip of partner names, one big number ("Trusted by over 30,000,000 users"). We have neither and must not invent either. |
| Pricing on the home | A segmented Monthly / Yearly toggle with a "-40%" badge, three plan cards, one featured card in colour, "For teams" cards, then a compare table behind a picker. |
| Pricing page | 15,200px tall on desktop, 7,800 on phone: gradient hero, plans as a horizontal swipe row on phone, slider for compute, compare plans collapsed into four accordions, FAQ as one card per question, "Still have questions?" with one button. |
| Type | One grotesque (Suisse Intl), weights 400/450/500/600, normal tracking at body sizes, -1.2px on 48px. No capitals, no mono outside code. |
| CTA | White pill on black; 48px phone. A ghost pill beside it. One filled button per view. |
| Motion | 10-12 CSS animations running on the home (marquee of model logos, a carousel, hover lifts), a muted autoplay video. Header hides on scroll down (700ms). Nothing is loud. |
| Footer | Six link columns, a prompt row "Ask ... about Krea", the legal line. |

### Contrast

| Site | What stands out | What we avoid |
| :-- | :-- | :-- |
| Higgsfield | Neon lime CTA, a mosaic of media tiles in the first frame, many nav items with "New"/"Top" badges. Energetic, busy. | The opposite of calm: ten places to click above the fold. |
| Linear | Dark, tiny nav, one headline at 64px / weight 510, the product UI as the hero image. Late-loading content. | A black page with a product screenshot as the only idea. |
| Vercel | Left-aligned 64px / weight 400 headline, one black button, one white, one object, then a logo strip. | Nothing; the discipline is the point: one object, one button. |

### What makes Krea feel premium and calm (the short list)

1. **One idea per frame**, set big (60-72px headlines) with 100px of air around it.
2. **One filled button** per view; the second is a ghost.
3. **The product is the picture**: an app frame, not an illustration of an idea.
4. **Tone, not lines**: cards are a slightly different grey, with 16-24px corners and almost no border.
5. **Alternation**: a dark stage, then light sections. Rhythm comes from colour and space.
6. **One neutral grotesque** in a few weights, normal tracking, sentence case.
7. **Motion that means something**: a loop inside the product frame, a lift on hover; the page itself does not move.

### What is portable to a YouTube-video-automation product, and what is not

| Take | Because | Our version |
| :-- | :-- | :-- |
| One headline, one button | The page must answer "what is it, what do I press" in one frame on a phone | "We make the video. You press publish." + Start free |
| The product in the first screen | Visitors judge by the product, not by claims | A dark stage that **draws** one video in four states (topic, plan, approve, live), with real UI parts and a label "Example". No stock, no 3D, no generated imagery |
| Bento tiles | One idea each, easy to scan | The nine Studio tools as tiles (icon, name, one line, "No credits" only where true) |
| Dark stage, light page | Rhythm without hairlines | The stage is a fixed warm near-black in both themes; sections alternate ground and raised tones, both designed per theme |
| FAQ as cards | Calm, scannable | One card per question; the refund and unused-credit answers stay open on arrival |
| Big numbers and a logo strip | It signals scale | **Not taken.** There are no customers, logos or usage figures to show, so there are none. The only figures are the welcome grant and the configured prices |
| Monthly / Yearly toggle with a discount | Anchors price | **Not taken.** The plan data holds monthly prices only; a yearly discount nobody set would be invented (a test pins "no switch") |
| Autoplay video | Shows the product moving | **Not taken.** The stage moves by itself only while it is on screen and untouched, and never under reduced motion; no video |
| Marquee of partner logos | Trust | **Not taken.** Client logos live on the `/mcp` page only |

## 2. What was built

### Landing (`/`)

One idea per section, in the order a visitor asks the questions. The owner then sent five phone
screenshots of Krea's `/mcp` page ("build our public pages in this style"); what fit was folded in as the
capability sections below (a label pill, a two-line headline, a grey paragraph, one black button, and a card
that shows the capability as a short exchange).

1. **Hero.** A pill ("For YouTube channels, faceless or not"), the H1 in two lines (the second in the
   dim ink), one 20px line, **one** amber button and a plain link, the welcome-credit note, and, only when the
   live price list holds it, one price line ("A video in the app: N credits a minute of finished video").
   Under it the **approval press**: a dark rounded stage with four tabs, Topic, Plan, Approve, Live. Each tab is
   one drawn state of the same video: the typed topic and a "Make a plan" key; the plan (script, voice, visuals,
   captions) with "the price is on the button before you start"; the video private on YouTube with the publish
   check passed and an amber-outlined "Approve and publish" waiting; and the video public "by you". It starts at
   the topic and moves on every 4.6 seconds **only while it is on screen and untouched**; hover, focus, a tap, or
   reduced motion stop it, and the tabs always work. All four panels share one grid cell, so the stage never
   changes height (CLS 0).
2. **How it works.** "Three steps. The last one is yours." Give it a topic; start it at a price you have seen;
   watch it, then publish. Beside it, the **real approval screen** (the existing captures, sample data, labelled).
3. **Capabilities, five sections** (Video, Voice, Studio, Channels, Approvals), each: label pill, two-line
   headline, paragraph, one black pill button, and an **example exchange**: your grey bubble, the reply row (the N
   tile, "Nightshift", a check and "made a video"), a result drawn in flat shapes (the moon video frame, a
   waveform, a caravan at dusk, the market arch), and small chips (language, narrator, 16:9, a style). Every card
   carries an "Example" tag and one label for assistive tech. The Studio's nine tools are chips under its button
   ("No credits" only on the editor and the style library). The Approvals card reuses the wording of the sign-off
   picture on the Solutions page, so the two cannot disagree. Sections alternate the page ground and the raised
   tone, and every second one flips the text and the card on a wide screen.
4. **Made for people who run channels.** Three tiles linking to the three Solutions pages.
5. **Promises.** Price first, a failure costs nothing, nothing goes public without you: each backed by what the
   code does (section 4), each with its three-line ledger on a wide screen.
6. **Money.** The existing honest anchor (smallest pack, a video in the app, a video through the API, the free
   grant; "No price published yet" where nothing is configured), the pack or plan rows, the quote / hold /
   charge / return row (tablet and up).
7. **Questions**, and the Google data statement (kept for the OAuth review).
8. **Closing call** on a dark stage, then the footer.

### Pricing (`/pricing`)

Same data, fewer words on screen: the hero is the headline, the anchor and one button, with the three
promises as a checklist; plans (only when on sale) with **one honest line** about extra credits ("Plan
credits are spent first. When they run out, a run can keep going on credits from a top-up pack. You can
turn that off on the Usage page." Verified: migration 0094, `use_extra_credits` defaults to true, and
the Usage page switch); the packs; the terms; "What a credit buys" with the formulas folded into a
"Show the math" disclosure instead of a wall; payments (the Merchant of Record sentence is still there
exactly once); questions.

### Sign in and sign up

One card on a phone: wordmark, title, one friendly line, the fields (54px, 16px text), one 56px button,
the three promises under it. On a wide screen the promises sit on a dark stage beside the card. The invite
banner, the disabled-server notice, the OAuth callback errors and every handler are untouched.

### Copy

Short, warm, plain, in en, ru and uz with key parity (`tests/site-copy.test.ts`); Uzbek spells `oʻ gʻ` with
U+02BB and `ʼ` with U+02BC (`tests/uz-apostrophes.test.ts`). The Uzbek lines were written for the page, not
translated word for word. Legal text (terms, privacy) was not touched.

## 3. Rules kept

Middleware matcher and public paths, JSON-LD, metadata and OG (the OG card reads the new headline), the
cached public reads, the `ATELIER_CONCEPTS` flag and its pages, the header and footer links, 44px targets,
AA contrast, visible focus, `prefers-reduced-motion`, no new external request, fonts unchanged.

## 4. Truth table for the promises

| Claim on the page | Where the code does it |
| :-- | :-- |
| The price is on the button, and you are asked again if it changes | Priced keys in the Studio and the run form; `price_changed` (NS409) in the creative and reply-draft SQL (e.g. 0081) |
| A failed run returns the whole hold | `credit_lots_*` / hold-capture-release functions; the refund ledger on the Credits page; pinned by the SQL tests |
| Charged never more than the hold | `charge <= hold` in the capture function (the same sentence was already on the live site) |
| Videos upload as private, behind a publish check | `config.YOUTUBE_PRIVACY` defaults to `private`; `modules/publish_gate.py`; CLAUDE.md rule 2 |
| Auto-publish is per channel and off by default | CLAUDE.md rule 2; the channel switch |
| Extra credits are on by default and can be turned off | migration 0094 `use_extra_credits boolean not null default true`; Usage page |
| Languages: Uzbek, Russian, English | `lib/i18n/{en,ru,uz}.ts`; per-channel language setting |

## 5. Measured results

Real Chromium (chromium-1194), production builds of `main` and of this branch built the same way (Supabase
URL pointed at the repo's read-only visual-QA fake, display prices `$10 / $45 / $160` for the packs and `$19 / $49`
for the plans), 5 pages (landing, pricing, solutions, sign in, sign up) x 360 / 390 / 1280 x light and dark x en, ru,
uz = **90 states per side**. Screenshots: `before/` and `after/` here (a selection, named `<page>-<width>-<theme>-<lang>.webp`;
the full set of 180 full-page captures and the scripts are in `design-inbox/site-krea/`), `contact-*.webp` are
before / after side by side, `after/stage-*.webp` are the four states of the hero picture.

| Check | Before | After |
| :-- | --: | --: |
| States captured without an error | 90 / 90 | 90 / 90 |
| axe 4.x, serious or critical | 0 | **0** (and 0 of any impact) |
| Horizontal overflow, 360 / 390 / 1280 | 0 | **0** |
| Controls under 44px high | 0 | **0** |
| External requests | 0 | **0** |
| Text under 13px, capitals, tracked labels (`tests/human-type-tokens.test.ts` now also reads `site-next.css`) | 0 | **0** |
| CLS with every font file held back 1.2 s (30 loads: 5 pages x 3 languages x 390/1280) | max 0.014 | **max 0.0085** (landing 390 en was 0.042 until the H1 size was set so its first line breaks the same before and after the swap) |
| Hero picture height across its four states | n/a | identical (547 at 1280, 621-675 at 360-390) |

| Page and width | Transfer KB | LCP ms (local, median of 6) | Document height px |
| :-- | --: | --: | --: |
| landing 390 | 303 -> 323 | 158 -> 208 | 14,150 -> 14,612 |
| landing 1280 | 313 -> 334 | 208 -> 252 | 8,821 -> 10,892 |
| pricing 390 | 246 -> 254 | 164 -> 154 | 9,458 -> 8,880 |
| pricing 1280 | 248 -> 255 | 192 -> 158 | 6,002 -> 6,128 |
| solutions 390 / 1280 | 230 -> 235 / 232 -> 237 | 128 -> 124 / 152 -> 148 | 4,013 -> 4,175 / 2,536 -> 2,586 |
| sign in 390 / 1280 | 275 -> 283 | 140 -> 114 / 200 -> 140 | 1,019 -> 1,026 / 900 -> 900 |
| sign up 390 / 1280 | 277 -> 284 | 122 -> 146 / 148 -> 156 | 1,210 -> 1,207 / 960 -> 1,000 |

Read this honestly: the landing is **not shorter** than before. It carries five capability sections that did not
exist (Video, Voice, Studio, Channels, Approvals, each with an example), so it is 3% taller on a phone and 23%
taller on a wide screen, and it costs 20 KB more (the new stylesheet, the stage's script and the extra drawings). Its
local LCP is about 50 ms slower; every other page is the same or faster. Fonts did not change (one Latin file,
34 KB; plus the Cyrillic file on Russian pages). The pricing page is shorter on a phone (the long credit steps and
the formulas now sit behind "Show the math").

## 6. Score and risks

My own score against `design-rubric.md` (an independent scorer has not seen it yet; Pixel's earlier landing was
94 to 96):

| # | Criterion | Score | Why |
| :-- | :-- | --: | :-- |
| 1 | Identity (20) | 17 | One idea (you press publish) drawn in four states; amber, the N tile, Onest, a warm near-black stage; no cream/serif, no purple gradient. Deducted: the hero is centred (the rubric dislikes centring everything) and the capability cards are close to the chat-card pattern the owner pointed at |
| 2 | Hierarchy and layout (15) | 14 | One headline, one amber button; 16 / 24 / 28 radii; a consistent label-headline-paragraph-button-card section; tabular numerals in prices. The hero stage is taller than its content in the shorter states on a phone |
| 3 | Commercial clarity (15) | 14 | What it is, who it is for, the one known price above the fold, the packs and plans, credits math one tap away, the three promises. Unpriced deployments say "No price published yet" |
| 4 | Responsive and themes (10) | 10 | 0 overflow in 90 states, 44px controls, both themes designed from tokens |
| 5 | Accessibility (10) | 10 | axe 0, tabs with roving focus, inert inactive panels, reduced motion stops the autoplay, focus rings |
| 6 | Performance (10) | 9 | +20 KB on the landing, +50 ms local LCP, CLS under 0.0085 with late fonts |
| 7 | Copy and i18n (10) | 9 | Short and warm in three languages with parity; the Uzbek and Russian lines were written for the page but not read by a native speaker other than the owner |
| 8 | Product truth (5) | 5 | Every picture is labelled "Example" and drawn; no photographs, logos, testimonials or figures; one price line only from the live list |
| 9 | Polish (5) | 4 | Motion used once and on purpose; the 404 and the loading states were not touched |
| | Total | **92** | |

Against Krea: ahead on the clarity of what the product does and on trust that is true (a checked table of claims);
behind on visual richness (their hero is photographic and their tiles carry real renders; ours are flat drawings,
by rule) and on the amount of proof (they have millions of users; we have none to show and say none).

Risks:

1. The landing is long and heavier than before; if the owner wants it shorter, the first things to cut are the Studio
   and Channels capability sections (their content lives on the Solutions pages).
2. The hero picture's copy ("Make a plan", "Start", "Approve and publish") names buttons that exist in the app; if a
   button is renamed there, the drawn one should follow.
3. Uzbek and Russian copy for the new strings was written by the builder; the owner reads Uzbek, a native pass on
   `lib/i18n/site/uz.ts` is the one review this needs.
4. The hero price line and the plan rows only appear when the deployment publishes prices; the screenshots here are
   taken with display prices set, and with none the page says "No price published yet" (both states are tested).
5. The `ATELIER_CONCEPTS` pages still read `site.hero`, `site.rundown`, `site.rules` and `site.desk`; their copy
   changed with the headline, their layouts did not.
6. Sections alternate tones with a data attribute and CSS; a new section that forgets `data-tone` will sit on the
   ground colour next to another ground section.

## 7. Fixes after review (Lens and Pixel)

- Hero note says the welcome credits are one-time again (en, ru, uz), matching `grant_welcome_credits`.
- "You press publish." no longer stands alone: the FAQ answer says auto-publish is off unless you turn it on for
  a channel; the drawn "Approve and publish" key carries a small "Example" label next to it.
- The approval screen on the landing is recaptured from the current app (main with the calm-app change),
  light and dark, en/ru/uz, desktop and phone, from the repo's visual-QA fake backend extended in a scratch copy
  with one sample video (a drawn moon clip, "Small Science", private, publish gate passed). The panel is now
  sentence case with no monospace. The caption still says everything on it is sample data.
- "key" became "button" in the English site copy where it meant the priced button (Russian and Uzbek already said
  button); API keys stay keys. The credit-math equations are set in the page's face with aligned figures.
- The Uzbek hero pill is short enough to stay on one line at 340px and up; the sign-up line says a link confirms
  the email and no card is needed (what the flow does: `signUp`, then `/auth/callback`, then `/welcome`).
- Left for a separate PR: the hydration mismatch on `/pricing` in Uzbek (Intl currency output differs between
  server and browser in `lib/pricing.ts`).

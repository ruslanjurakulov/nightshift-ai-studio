# S5 benchmark — where we stand against the leaders, and what to fix first

**Internal.** Stream S5 (design & benchmark), 22 Nov 2026. Rule 8 applies: this is the measurement, its own PR; the token and
component changes that follow are separate PRs that cite it. Nothing here may be copied onto a public page: no vendor price,
no competitor name, no comparison (owner's rule; `docs/studio/PROGRAM.md`).

Read with: `docs/studio/STUDIO_BENCHMARK.md` (14 Nov, the *interaction* benchmark: steps, waiting, cost display — not
repeated here), `docs/design/TOKENS.md`, `docs/design/SITE_KREA.md`, `docs/design/APP_KREA.md`.

## How this was measured

- Signed-out public pages only, Chromium (preinstalled Playwright), dark colour scheme, 1440 × 900 and 390 × 844,
  deviceScaleFactor 2 for the fold shots, 1 for the scroll strips. No sign-in, no form submitted, cookie banners dismissed
  where a "Dismiss"/"Deny" key existed. Sites: higgsfield.ai, krea.ai, runwayml.com, buzzy.now, openart.ai, and our own
  nightshift-ai.studio (`/` and `/pricing`) **as deployed on 22 Nov, i.e. before PR #889** (the deployed site still sets
  headings in Unbounded; #889 returns the public site to Onest headings and no `ds-skin`).
- A text census in the page (`getComputedStyle` over every visible text node, counted in words): distinct font sizes, share
  of words under 14 px, families, the most common corner radii, words per 1000 px of page height.
- The Studio surfaces were taken from `docs/studio/qa/canvas-ux/` (21 Nov, the live canvas) and
  `docs/studio/prototype/` (the reference look), plus a mock harness pass of today's components
  (`docs/design/s5-benchmark/ours/`, added when that pass lands).
- Screenshots: `docs/design/s5-benchmark/web/` — `<site>-1440-fold.jpg`, `<site>-390-fold.jpg`, `<site>-1440-scroll.jpg`
  (four viewports down, side by side), `<site>-1440-full-thumb.jpg`. Lazy, virtualised pages (Higgsfield, OpenArt) render
  black in a full-page shot; the scroll strips are the evidence for those.

Labels: **[M]** measured here (number given) · **[O]** observed in a screenshot (file named) · **[J]** judgement, argued.

### The census

| | words | distinct sizes | words < 14 px | families on page | most common radii | words / 1000 px |
| :-- | --: | --: | --: | :-- | :-- | --: |
| Higgsfield | 2718 | 17 | 4 % | Inter, Space Grotesk, Space Mono | 10, 8, pill | 197 |
| Krea | 1490 | 21 | 13 % | Suisse Intl | 8, 14, pill | (one-screen fold, lazy below) |
| Runway | 707 | 10 | 9 % | ABC Normal | 6, 4, 8 | 137 |
| Buzzy | 256 | 14 | 31 % | Poppins + 5 campaign faces | pill, 16 | 58 |
| OpenArt | 2657 | 19 | 13 % | system UI, Bricolage Grotesque | 10, 20, pill | 170 |
| **Nightshift `/`** | 1587 | 16 | 12 % | Onest, Unbounded | 12, 16, 10 | 185 |
| **Nightshift `/pricing`** | 1973 | 17 | 11 % | Onest, Unbounded | 12, pill, 10 | **269** |

[M] Our pages are not unusual in size count; they are unusual in **how much prose each screen carries** (pricing is the densest
page measured, 2× Runway) and in **how little of it is picture**. The leaders are media walls with short labels; we are
paragraphs with a picture beside them.

## Per surface: what the leaders do better

### 1. Public home, first screen (`*-1440-fold.jpg`, `*-390-fold.jpg`)

| Dimension | What the leaders do | What we do | Gap |
| :-- | :-- | :-- | :-- |
| Hierarchy | One sentence, one key. Krea: 60 px/400 headline, one line of sub-copy, two pill keys, then a product frame [M, O krea-1440-fold]. Runway: 56 px/400 on a full-bleed film still [M]. | 73.6 px/600 headline in a wide display face over three lines, a 3-line paragraph, a labelled textarea, a key, a 2-line disclaimer, a link [M, O nightshift-1440-fold]. Six things compete in the first screen. | **High.** Too many voices above the fold. |
| Type | Neutral grotesques at **regular weight (400–500)** for display; size and air do the work, not weight. Tracking −1 to −1.5 % [M Krea, Runway, Buzzy]. Only OpenArt shouts (102 px/900, uppercase). | Heavy (600) wide display at −2 % — reads as "loud template" to the owner (his words on 22 Nov, the reason for #889). | **High**, already being corrected by #889 (Onest). The system below sets the weight and tracking so Onest display does not just become "bold Onest". |
| Colour | Near-black neutral grounds: `#0f1113`, `#101010`, `#070707`, `#090a0a` [M]. One loud accent at most (Higgsfield lime, Buzzy yellow, OpenArt magenta), used only on the primary key. | Navy ground `#070a14` + electric blue key + lime badges + coloured icon tiles, all in one screen [O]. | **Medium.** A blue-tinted ground reads "dashboard"; neutral near-black reads "cinema". The accent is spent on badges as well as the key. |
| Motion | Hero is a playing video or a living product frame (Krea's monitor, Buzzy's floating cards, OpenArt's orbiting stills) [O scroll strips]. | A still photo with an overlay [O]. | **High.** A video product with a still hero. |
| Density at 390 | Krea: headline + 2 keys fit; nothing else [O krea-390-fold]. | Headline, paragraph, textarea and key fill the screen; the disclaimer falls below [O nightshift-390-fold]. | Medium. |
| Copy tone | Claims about the output ("Pro Video, Made Easy", "Where ideas become visual stories"). | Claims about the process and its honesty ("Nothing runs and nothing is charged here…"). | **[J]** Keep the honesty — it is a rule — but move it next to the key it qualifies, at caption size, not into the hero. |

### 2. Public home, below the fold (`*-1440-scroll.jpg`, `nightshift-1440-howitworks.jpg`)

- **Leaders sell with work, not with explanations.** Higgsfield, OpenArt and Buzzy are walls of outputs (rows of 9:16 and
  16:9 tiles, category rails: "AI Film", "Branding Ads", "MV", "Explainer") [O scroll strips]. Krea uses a bento grid of
  capability tiles with one big number or word each ("4K", "22K", "Train") [O krea-1440-scroll].
- **We explain.** "How it works" is three icon cards with numbers 01–03 and two-line bodies, then a nine-step stepper with
  a paragraph that mentions "a real file from our repository" [O nightshift-1440-howitworks]. The icon-tile + "01" card is
  the single most common landing template on the web — this is the part the owner calls "a programmer who just started".
- **Section rhythm.** Leaders: a one-line section title, then the media [O scroll strips]. Ours: a title, a sub-title, a
  paragraph, and then cards, so every section opens on a block of text before anything to look at [O howitworks]. Our section headings are 20 px/600 for h2 cards and 73 px for section display — **no middle step**, so a page
  alternates between shouting and small print [M h1 73.6, h2 20].
- **Social proof.** OpenArt shows customer logos and "Loved by 10M+" [O openart-1440-scroll]. **We must not** (no logo or
  number the code cannot back). Our substitute is our own made pieces, labelled as made with Nightshift; we have 17 clips
  on the home today [M nVideo 17].

### 3. Pricing (`nightshift-pricing-*`)

- Ours is the densest page measured (269 words / 1000 px), 3 % media [M]. Two calculators, plan cards, a
  "what a credit buys" demo, terms-at-a-glance, FAQ — six modules, each with its own heading style [O full-thumb].
- Leaders' pricing is not in scope (they sit behind campaigns; Higgsfield and Buzzy run countdown banners) — and we must not
  imitate those: a countdown or "X cards left" is a claim our code cannot back.
- **[J] Fix:** one plan row, one calculator, everything else folded into the FAQ; numbers in a tabular display size
  (`.ds-num` at the display step), not body size.

### 4. Studio canvas (`docs/studio/qa/canvas-ux/*`, `docs/studio/prototype/*`)

| Dimension | Reference (buzzy canvas, agentcut timeline — PROGRAM.md) | Ours today (`first-run-1440-dark-en.png`) | Gap |
| :-- | :-- | :-- | :-- |
| Chrome | One floating dock; the canvas is the page. | A 60 px header with **ten** controls (project switcher, Canvas/Timeline, Channel look, search, credits battery, bell, language, theme, display, avatar), a 40 px status strip, a 60 px bottom bar with nine controls [O]. ~160 px of chrome out of 900, about 18 % [O, measured on the screenshot]. | **High.** |
| Cards | 1 px border, small title *above* the card, the media is the card. | First-run choice cards with an icon tile, title, two-line sub-copy; disabled ones say "Not available yet" in the same size [O]. | Medium — the honesty is right (a model shows only once real), the treatment is a form, not a canvas. |
| Wires | Soft grey beziers converging into a round "+" merge hub. | Wires exist in FlowBoard; no merge hub [O, code]. | Medium (S3 owns the canvas; finding goes to Atlas). |
| Type | Small uppercase monospace for labels, regular text for titles. | Onest everywhere at 14–16 px; no monospace role except the timecode prototype. | Medium — needs a mono role token. |
| Credit display | (reference has none on canvas) | A lime "battery" of bars + number [O]. Ten saturated bars in the header pull the eye more than the work. | Medium. |

### 5. Timeline (`docs/studio/prototype/studio-timeline-1440-dark.png`)

The prototype is already close to the reference: monospace timecode, track headers with coloured badges, saturated pills,
agent tags. What separates it from the reference: [O]
- Timecode is 28 px Onest; the reference is a **large monospace in the accent colour** with "/ total" and a status word.
- Track pills use five saturated hues at full strength *and* coloured borders, plus coloured agent tags on top — the reference
  keeps one tone per track and lets only the *tag* be loud.
- Track header labels are sentence case 15 px; reference: small uppercase mono with a dim second line.
- Gaps between segments are visibly wider than the reference's 1–2 px, so the lane reads as one strip.

### 6. Empty, loading, error, insufficient credits

- Leaders signed out show none of these, so the benchmark is our own Definition of Done. Ours has the right words (the
  canvas says "Empty canvas · nothing spent"; the Create key says "Nothing spends without a quote"), but **each surface draws
  its own**: a status strip on the canvas, inline text in the timeline, a toast elsewhere [O, code]. There is no shared
  empty/loading/error/insufficient-credits component in either primitive layer (gap 1).

## Ranked gaps — what most separates us from first place

1. **Two primitive layers, and the states half-shared.** `components/ui/` (Panel, Chip, Timecode, StatusLamp, Meter,
   PriceButton, StepCard … on the older `--ns-*` names) and `components/ds/` (`Button`, plus `.ds-chip`/`.ds-input`/
   `.ds-toggle` CSS on `--ds-*`) live side by side. Shared states exist for empty (`components/ui.tsx` `EmptyState`), error
   (`ReadError.tsx` `ErrorState`) and loading (`feedback/Skeleton`, `motion/LoadingGrace`), but four surfaces still draw
   their own empty state (the timeline's `Empty`, `AdvisoryPanel`'s `Empty`, `EmptyHint`, `EmptyCard`) [M grep], and there
   is **no shared insufficient-credits, provider-unavailable or session-expired state** [M grep]. → S5 PR "ds states":
   the three missing states, the existing three moved onto `--ds-*`, one spec for all six.
   *Correction: the first push of this document said `components/ds/` held only `Button` and implied no shared states
   existed; `components/ui/` and the shared Empty/Error/Skeleton were missed.*
2. **Type has no middle.** Display (56–74 px) and body/labels (13–20 px), nothing at 24–40 px; display weight 600 with
   heavy tracking. Leaders run display at 400–500 with −1 to −1.5 % tracking and a clear 5–6 step scale. → S5 PR
   "type scale" (Onest display, per #889).
3. **Prose where the leaders show work.** Home and pricing carry 185–269 words per 1000 px; leaders 58–197 with media
   walls. → Finding to Atlas for #889 (public homepage owner): a made-with-Nightshift wall, one-line section titles,
   honesty notes at caption size next to the key they qualify.
4. **Chrome on the Studio canvas.** ~160 px of bars and 17+ controls around an empty canvas; the reference is one floating
   dock. → S5 owns shell/rail/header styles; the dock is S3's (lane branch). Finding to Atlas.
5. **Ground colour reads "dashboard".** Navy-blue ground plus blue key plus lime marks; leaders sit on neutral near-black
   with one accent. → S5 proposal, **owner's decision** (the navy/neon look is owner-approved; not changed without him):
   neutral-ish ground `#0a0b0f` family with the same blue key. Shown as an option in the system doc, not shipped.
6. **No motion language on the public site.** Still hero for a video product. Motion tokens exist (press/panel/page) but
   nothing for "media reveal" or "living frame". → S5 PR "motion tokens", consumption by #889's owner.
7. **Timeline polish** (mono timecode in accent, uppercase mono track labels, 1–2 px gaps, one tone per track). → finding
   to S3 via Atlas; S5 supplies the `--ds-font-mono`, `--ds-track-*` tokens.
8. **States drawn per surface.** → covered by gap 1 (EmptyState, LoadingState, ErrorState, InsufficientCredits,
   ProviderUnavailable, SessionExpired as ds components with i18n strings passed in).

What we already do better and must keep: prices only from the backend, unknown shown as unknown, "Not available yet" for a
model that has not answered, private-by-default — none of the leaders' fold screens can say any of that, and their
countdowns and "X left" banners are exactly what our rules forbid.

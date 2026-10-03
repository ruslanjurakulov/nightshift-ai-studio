# Human type: one friendly sans, calm density, plain words

Status: 2026-10-03. Owner of this file: design. It replaces the type, radius,
density and label rules of `IDENTITY.md` (the palette hue, the amber accent, the
dark-first look and the wordmark stay). Tokens: `command-center/app/globals.css`
(`@theme` and `:root`), the font files and their CSS: `command-center/app/fonts.css`
and `command-center/public/fonts/`. Pinned by `tests/human-type-tokens.test.ts`
and `tests/test_fonts.py`.

## 1. Why this changed

The owner, on an iPhone, annoyed: "You know about many sites' designs. Make the
design convenient and as simple as them. You still can't make the site's design
good; the fonts look like a robot wrote them." The reference they hold up is
Claude's own Settings → Usage page and the Krea / Higgsfield MCP pages.

What the screenshots showed, and what I measured on the live product before
changing anything (390px wide, `/`, `/pricing`, `/login`, counted over rendered
text nodes):

| | landing | pricing | login |
| :-- | --: | --: | --: |
| text nodes | 279 | 133 | 28 |
| set in ALL CAPS | 84 (30%) | 29 (22%) | 3 |
| of those, letter-spaced 0.1em or more | 64 | 28 | 3 |
| set in the monospace "counter" face | 37 | 10 | 1 |
| smaller than 13px | 57 | 3 | 4 |
| condensed display face | 103 | 36 | 5 |

A condensed face in capitals for every heading, a monospace for ordinary
labels and numbers, 10–11px tracked capitals for every micro-label, and a
hairline box around nearly everything. That is a control-room skin, not a
product a person wants to use at 7 a.m.

## 2. Research: what makes the references feel human

Measured with Chromium (computed styles, 1280px, dark scheme) on 2026-10-03
through the session proxy (TLS: the session CA pinned by SPKI; verification was
never disabled). Public pages only: `claude.ai` and `chatgpt.com` answered the
automated browser with a Cloudflare challenge (HTTP 403, "Just a moment"), so
their signed-in settings screens are **not measured**; for those I rely on the
owner's screenshots and the shape of the Claude Help Center, which uses the same
type family and tokens.

| Product | Text face | Body | Heading | H1 weight / tracking | Buttons | Cards | Caps / mono (share of text) |
| :-- | :-- | :-- | :-- | :-- | :-- | :-- | :-- |
| Claude Help Center | Anthropic Sans (humanist) + serif headings | 16 / 25.6 (1.6) | 22–48, 1.1–1.3 | 500–600, normal | inputs 49px high, 12px radius | 12px, 1px at 15% ink | 0 caps, 2 mono nodes |
| anthropic.com | Anthropic Sans / Serif | 20 / 28 | 58–65, 1.1 | 500–700, normal | – | 24px | 0 tracked caps |
| Linear | Inter Variable (mono for code) | 16 / 24 | 40–64 | 510, −0.022em | 32px, pill | 9–12px, 1px at 8% white | 8 caps of 659; mono only for code |
| Notion | Inter (+ a serif accent) | 16 / 24, lead 20 / 28 | 54–96 | 600–700, −0.05em at 96px | 30px, 4px radius | 16px, no border | 0 caps, 0 mono |
| Stripe | Söhne (neutral grotesque) | 16 | 32–48 | **300**, −0.02em | 40px, 4px | – | 0 caps, 0 mono |
| Vercel | Geist Sans (mono for code) | 16 / 24 | 56–64 | 400–450, −0.06em at 64px | 32px | – | 0 caps, 3 mono of 65 |
| Krea | Suisse Intl | 16 / 24, app UI 14 / 20 | 18–60 | 450, normal | 36px, 10px | 16px, no border (tone only) | 0 caps, 0 mono |
| Higgsfield | Inter + Space Grotesk headline | 16 / 24, UI 14 / 20 | 56 caps (the exception) | 700, −0.04em | 36px, 10px | 8px | 37 caps of 182, none tracked, 0 mono |
| Airbnb | Cereal (rounded humanist) | 14 / 20 | 28 / 40 | 700 | 40–48px, 8–20px | 32px | 0 caps |
| Duolingo (counter-example) | duolingo-sans | 17 / 20, weight 500 | 32–48 | 700 | 50px, 12px | – | 48 caps in buttons, tracked: playful, with a mascot |

What they share, and what I took from it:

1. **One sans for UI and reading**; a second face only as an accent. Mono only
   for code (Linear, Vercel). No product sets its own name for a label in a
   condensed face.
2. **Normal tracking for text**; negative tracking only on large headings.
   Positive tracking appears only in all-caps labels, and the humane references
   have none of those.
3. **Weights 400 / 500 / 600** in the product UI (Linear 510, Krea 450, Notion
   600, Claude 500–600). Hairline weights (Stripe 300) belong to big marketing
   headlines only, and we do not use them.
4. **Body 16 with a 1.5–1.6 line**; dense app UI at 14 / 20 (Krea, Higgsfield),
   never below 13 for anything a person reads. Krea's 11px nodes are badges.
5. **Sentence case** everywhere.
6. **Soft cards**: 12–24px radius, a 1px low-contrast border or none, a tonal
   surface instead of a line; buttons 36–50px high with 8–12px radius; Claude's
   own inputs are 49px.
7. Generous, regular space: about 24px between cards, 20–24px inside them.

## 3. The type system

**One family: Onest** (SIL Open Font License 1.1; Copyright 2021 The Onest
Project Authors, <https://github.com/simpals/onest>; licence text in
`command-center/brand/og-fonts/OFL-Onest.txt`). It is a neutral, friendly
grotesque with a tall x-height and open, round counters, drawn for Cyrillic first
(so Russian is not a fallback), a single variable file per script on a `wght`
axis (100–900), with tabular figures (`tnum`).

### Chosen by rendering, not by name

I rendered the same real en / ru / uz strings (headline, body, buttons, a price
row, the Uzbek `oʻ gʻ ʼ ’`) at 360px in nine candidates and checked the glyph
tables with fontTools:

| Candidate | Latin | Cyrillic (ru) | Uzbek ʻ ʼ ’ | tnum | Verdict |
| :-- | :-- | :-- | :-- | :-- | :-- |
| **Onest** | yes | yes | **all three** | yes | **chosen**: complete, friendly, no fallback glyphs anywhere |
| Inter | yes | yes | all three | yes | complete, but the generic default; colder; larger Latin file (48 KB) |
| Golos Text | yes | yes | **no ʻ** (U+02BB) | yes | warm and legible, but the Uzbek letter falls back to another font |
| Geologica | yes | yes | **no ʻ** | yes | too wide and heavy; same fallback |
| Manrope | yes | yes | **no ʻ ʼ**, no Uzbek Cyrillic қ ғ ҳ | yes | rounded, but incomplete |
| Nunito Sans | yes | yes | all three | **no tnum** | soft, but spaces `ʻ` visibly in the render, numbers do not align |
| Figtree, Plus Jakarta Sans, Albert Sans | yes | **no Cyrillic** | no | partly | cannot serve Russian |

None of the candidates has `→ ≈ ✓` in its text files; those few symbols fall
back to the system font, which is what they did before.

Coverage pinned in `tests/test_fonts.py` (needs fontTools; skipped where it is
not installed): Latin file has `ʻ ʼ ‘ ’`, the Cyrillic files have all of
А–я, Ёё and the Uzbek Cyrillic `ў қ ғ ҳ`, the Latin file has `tnum`, and the
font is variable over 400–600. The Uzbek texts use U+02BB for the letter and
U+2019 after a Latin name (`tests/uz-apostrophes.test.ts`); both are in the
Latin file.

No second display face. The brief allowed one warm display face "only if it
clearly improves warmth"; it does not: Onest at 600 and 34–60px is already warm
and gives Russian and Uzbek headlines their full glyph set, and a serif would
add a file and a second voice for nothing.

### Delivery

* Self-hosted from `public/fonts/` under versioned, immutable-cached names; no
  request leaves for Google (and `next/font/google` is gone).
* Four subsets, Google's own `unicode-range`s: latin 34 KB, latin-ext 28 KB,
  cyrillic 16 KB, cyrillic-ext 11 KB; `font-display: swap`.
* Preload by language (`components/site/fonts.ts`, called from the root
  layout): English and Uzbek preload **one file (34 KB)**; Russian preloads two
  (**50 KB**). Before: three Latin files for every page, plus two Cyrillic for
  Russian. The budget was 150 KB.
* CLS: a metric-matched fallback face (`Onest Fallback`: Arial / Helvetica /
  Roboto scaled to 104% of Arial's width, measured on our own en / ru / uz
  strings, ascent 93.3%, descent 29.3%, line gap 0) is first in the stack, so
  the swap moves nothing.
* The wordmark keeps its own logotype: the condensed capitals, cut down to the
  nine letters of the name (about 2 KB, inlined as a data URI in `fonts.css`),
  used by `.ns-wordmark` and `.st-brand` only. The social card (`/og.png`) is set
  in Onest and the same wordmark.
* Monospace is the system's (`ui-monospace, SF Mono, Menlo, Consolas`), no
  download, and only for real code: API keys, commands, JSON, a raw id, the
  unit's code name.

## 4. Tokens (what changed)

| Token | Before | After |
| :-- | :-- | :-- |
| `--font-sans` / `--font-display` | Sofia Sans / Sofia Sans Extra Condensed | Onest / the same (alias, so existing markup needs no edit) |
| `--font-mono` | Martian Mono, width-narrowed "counter face" | system monospace, code only |
| scale (`--ns-t-*`, Tailwind `--text-*`) | 11 · 12 · 13 · 14 · 16 · 20 · 26 · 34 · 48 | 13 · 13 · 14 · 16 · 18 · 20 · 24 · 30 · 40 (text-xs is 13, text-base 16) |
| body | 14px | 16px, line 1.55; headings 1.2 |
| weights | 300 … 800, many at 650–800 | 400 / 500 / 600 (the `font-bold`, `font-light` … utilities are mapped onto them) |
| tracking | +0.08 … +0.24em on caps labels | 0; `tracking-wide/wider/widest` = 0; only −0.011 … −0.02em on headings |
| capitals | every label, nav group, table head, button, price key | none (the wordmark only) |
| radius | frame 2 · chip 4 · key 6 · panel 10 · sheet 14 | 8 · 8 · 12 · 16 · 20 (Tailwind `rounded-md/lg/xl` = 12 / 16 / 20) |
| controls | buttons 36px, chips 32px | buttons and fields ≥ 44px, chips 40px |
| space | panel padding 16 | card padding 20 (24 from 640px), 24px between cards |
| surfaces | hairline on everything; wells with borders | tonal surfaces; chips and inner stats have no border |
| balance bar | 24-segment VU ladder with hatching | one rounded bar; the paler part is "on hold" |
| neutrals (dark) | ink blue `#0B0F16`, `#11161F`, text `#ECE5D8` | warm charcoal `#131210`, `#1B1A17`, text `#F1EDE6` |
| neutrals (light) | cool paper `#E4E7EC` / `#FAFAF9` | `#F3F3F1` / `#FFFFFF` |
| primary button (light) | ink slab | amber, as in dark and on the public pages |
| amber accent | `#FFA940` dark, `#F29A1E` mark / `#9C5300` text on paper | unchanged |

Contrast (computed in `tests/human-type-tokens.test.ts` from the tokens):
text and dim text on ground, card and field ≥ 4.5:1 in both themes; amber,
red, green, blue and yellow as text on card and ground ≥ 4.5:1; the primary
button's label ≥ 4.5:1; a control's edge ≥ 3:1.

## 5. Rules for new screens

1. Sentence case, always. A heading says what the card is; a label says what the
   field is. No capitals, no letter-spacing, no monospace for words or numbers
   (`tnum` for figures that must line up).
2. 16px for text, 14px for dense secondary lines, 13px only for captions and
   badges; nothing smaller. Inputs are 16px on a phone (no zoom).
3. One card, one idea. Group with space (24px) before you draw a line; a hairline
   is a 1px low-contrast divider, never the only thing that says a control is a
   control (controls keep the 3:1 edge).
4. One primary button per card, ≥ 44px, 12px corners, amber with ink text.
5. Say the plain meaning first and the code name small: `Download, per minute of
   1080p video` above `download_1080p_minute`.
6. Money, limits and legal text keep their meaning when the tone is softened.

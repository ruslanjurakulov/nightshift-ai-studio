# Nightshift visual identity: "Master control, 03:00"

Status: v1, 2026-10-01. Owner of this file: design. Tokens live in
`command-center/app/globals.css` (`--ns-*`), primitives in
`command-center/components/ui/`, the living style guide at
`/{channel}/design` (platform admins only).

## 1. The concept

Nightshift is the studio that works while the creator sleeps, so the product
is drawn as a **broadcast master-control room in the small hours**. The room
light is off. What is lit is information: the amber faces of the meters, the
tally lamp on the job that is running, the timecode counting credits and
seconds. Nothing glows for decoration, nothing floats; the console is solid,
engraved, and every light means something. In the morning the editor reads
the night's work on a **proof sheet**: cool photo paper, black ink, the frames
printed with their edge numbers, and one amber mark where a decision is
needed. That is the light theme. It is not the dark theme inverted: the dark
theme's lit key (amber with ink legend) becomes an ink slab on paper with the
price printed in amber, because on paper the mark is ink and the lamp is the
exception.

The one thing only this product has: **everything that counts is a counter**.
Credits, prices, durations and frame numbers are set in a narrowed monospace
counter face with slashed zeros and tabular figures, the way timecode reads on
a master-control monitor; run state is a lamp in a bezel with its word beside
it; the credit balance is a VU ladder whose "peak hold" is the credits held
for work in progress.

## 2. Palette

Neutrals are chosen, never a mid grey. In the control room the darks lean to
the console's ink blue and the type leans to the lamp's warmth; on the proof
sheet the paper leans cool (photo paper under daylight, never cream) and the
ink is near-black. Amber is the only brand hue; red, green and blue exist
only as lamp states (failed, done, cue/focus).

| Token | Role | Dark (control room) | Light (proof sheet) |
| :-- | :-- | :-- | :-- |
| `--ns-ground` | page | `#0B0F16` console ink | `#E4E7EC` light table |
| `--ns-console` | panels, sidebar | `#11161F` | `#FAFAF9` print paper |
| `--ns-key` | fields, wells, inactive keys | `#18202C` | `#F0F2F5` |
| `--ns-rule` / `--ns-rule-strong` | hairline / control edge | `#252F40` / `#56637C` | `#CDD3DC` / `#838C9D` |
| `--ns-text` / `--ns-text-dim` | type / secondary type | `#ECE5D8` lamp-warmed / `#A39D91` | `#12151B` ink / `#525C6C` |
| `--ns-amber` | the lit thing: meter, lamp, selection | `#FFA940` | `#F29A1E` (never text) |
| `--ns-amber-ink` | amber as text or a mark | `#FFA940` | `#9C5300` |
| `--ns-cta-bg` / `-fg` / `-price` | the one action | amber / `#1A1105` / `#1A1105` | `#12151B` / `#F7F5F0` / `#FFA940` |
| `--ns-tally` · `--ns-go` · `--ns-cue` · `--ns-caution` | failed · done · focus/info · warning | `#FF6E5E` · `#5FD49A` · `#8DB4FF` · `#F3D36B` | `#B9341F` · `#0A7346` · `#2A5BC0` · `#7E6100` |
| `--ns-film` / `--ns-edge-print` | contact-sheet rebate / edge numbers (both themes) | `#07090C` / `#FFA940` | same |

Measured contrast (WCAG 2.x, text on its surfaces): dark text 13.1–15.3,
dim text 6.1–6.7, amber 8.6–10.1, tally 6.0–7.0, go 8.9–10.4, cue 7.9–9.2,
caution 11.2–13.1, ink on amber key 9.8. Light ink 14.9–17.5, dim 5.5–6.5,
amber-ink 4.7–5.5, tally 4.8–5.6, go 4.8–5.7, cue 5.1–6.0, caution 4.8–5.6,
paper on ink key 16.7, amber price on ink key 9.6. Control edges
(`--ns-rule-strong`) are about 3:1 against panels; plain hairlines are
dividers only and never the sole boundary of a control.

The old role names are remapped onto these (`--color-bg` → `--ns-ground`,
`--color-primary` → `--ns-amber-ink`, `--studio-cta-bg` → `--ns-cta-bg`,
`--shell-bg` → `--ns-console`, ...), so every screen took the palette without
an edit. Theme resolution is unchanged: light at `:root`, dark under
`prefers-color-scheme: dark`, an explicit `data-theme` wins; a
`data-theme-scope` attribute themes a box inside a page (the style guide).
Dark is the product's first design; the person's system or their toggle
decides which one they see.

## 3. Type

Google Fonts only, through `next/font/google` (self-hosted at build, no
run-time request to Google), all three with Cyrillic for Russian and the
Latin set that carries Uzbek's ʻ.

| Role | Face | Why | Fallbacks |
| :-- | :-- | :-- | :-- |
| Display | **Sofia Sans Extra Condensed** (variable 1–1000) | The engraving on a console: tall, narrow capitals that label a key or a rack without shouting. Used for page titles, figures, labels in capitals, the Generate key. | Arial Narrow, Roboto Condensed, sans-serif |
| Body | **Sofia Sans** (variable 1–1000) | The same family at reading width, so the labels and the copy are one voice at two widths. A humanist grotesk with a strong Cyrillic (Bulgarian foundry), not one of the faces every generated UI uses. | Segoe UI, Helvetica Neue, Arial |
| Counter | **Martian Mono** (wdth 75–112.5, set to 87.5) | Timecode: slashed zero, tabular figures, and a width axis that narrows it into a readout instead of code. Credits, prices, durations, frame numbers. | ui-monospace, SF Mono, Menlo, Consolas |

Scale (px, tokens `--ns-t-*`): label 11 (display, capitals, +0.12–0.14em) ·
small 12 · UI 13 · body 14 · lead 16 · h3 20 · h2 26 · h1 34 · hero 48.
Display face from 20 px up and for capital labels at any size; small section
headings (13–17 px) use the body face at 600–650.

## 4. Space, shape, elevation

- **Space:** a 4 px base; controls sit on 8 px steps; panel padding 16; page
  gutter 16 on phones.
- **Radius varies by role, never one radius for everything:** frame 2 (cut
  film) · chip 4 · key 6 (buttons, fields, segmented keys, nav rows) · panel
  10 · sheet 14. No pills except the lamp.
- **Elevation: one thing is lifted.** Per screen: an open sheet, a popover, or
  the surface you work at (the Studio composer, `--ns-lift`). Everything else
  is a solid rack face with a hairline (`.panel`, `.section-card`). No glass,
  no blur, no glow; the app hides the night footage the public pages keep.

## 5. Motion

Short, mechanical, no bounce: `--ns-ease` = `cubic-bezier(0.2, 0, 0, 1)`,
120 / 200 / 320 ms. Motion only confirms a state change (a key pressed, a
sheet opening, a lamp breathing while a job runs). The static state is always
complete; under `prefers-reduced-motion: reduce` every animation and
transition is cut to zero (globals.css) and the running lamp stays lit
without breathing.

The full motion language, its tokens (`lib/motion/tokens.ts`), the kit
(`components/motion/`), recipes and the bundle and licence notes are in
`MOTION.md`.

## 6. Iconography

- Lucide, stroke 1.75–2, sized 14/16/18/20; colour from text tokens, amber
  only for the current or lit item.
- No "sparkle" for AI, no emoji, no gradient icon tiles. Making something is a
  play/record glyph or the tool's own glyph; a running job is a lamp, not a
  spinner.
- Tool tiles are engraved keys (hairline square, dim glyph); the current
  tool's key lights amber.

## 7. Signature devices (each encodes real data)

1. **Timecode** (`<Timecode>`): credits, prices, durations (`0:05`,
   `1:02:07`), frames (`00:00:05:12`). Unknown renders as words, never 0.
2. **Status lamp** (`<StatusLamp>`): queued/cancelled = unlit ring, running =
   lit amber (breathing), done = green, failed = tally red, expired = caution.
   The state word is always beside the lamp.
3. **Credit meter** (`<Meter>`): balance as a VU ladder: lit = available,
   hatched = held for running work, unlit = spent. The scale is the real
   balance; with no balance the meter is not drawn.
4. **Price key** (`<PriceButton>`): the action and its price as two legends
   on one key, split by a hairline; a discount shows the old price struck.
5. **Contact sheet** (`<ContactSheet>`, `<Frame>`): results as frames on film
   with an amber edge print of the frame's own facts (shape, length, price).
6. **Rundown steps** (`<StepCard>`): a long make as numbered steps with this
   step's price and the running total.
7. **Ruler** (`.ns-ruler`): seconds ticks under a timeline, only where a tick
   is a real position.

## 8. Do / don't

| Do | Don't |
| :-- | :-- |
| Light one thing: the key you press, the lamp that runs, the row you are on | Glow, blur, frost or gradient anything for mood |
| Put the price on the action, in the counter face | Show a price that the backend did not compute, or 0 for unknown |
| Say a state in words next to its lamp | Use colour as the only signal |
| Vary radius by role (2/4/6/10/14) | Put the same rounded card + soft shadow on every block |
| Use the condensed face for titles and capital labels | Set long copy in the condensed face |
| Left-align; let the grid and the hairlines carry the page | Centre everything; add accent bars to cards |
| Use the cue blue only for focus | Use amber for focus (it means "selected") |
| Keep ticks and numbers where they count something | Add rulers, ticks or numbering as decoration |

Banned unless this file is changed with a reason: warm cream + serif +
terracotta; near-black with one acid-green or vermilion pop; purple-to-blue
gradients; Inter / Space Grotesk / Roboto / system UI as the personality;
emoji section markers; glassmorphism blobs; sparkle icons for AI.

## 9. Pattern map: reference product → our component

| Reference pattern | Ours | Where |
| :-- | :-- | :-- |
| Krea model sheet: speed/quality marks + price per model | `ModelSheet` rows: `TierMarks` as meter ladders, price as `Timecode` | Studio |
| Krea node strip: steps with per-step price | `StepCard` list in a row (`layout="row"`) with step price + running total | style guide; storyboard/video next |
| Krea before/after slider | `BeforeAfter` inside a `Frame` | Studio feed |
| Krea styles/moodboards as chips | `Chip` with pilot lamp (`studio-chip`/`ns-chip`), `ChipRow` | Studio style row |
| Krea enhance with a fidelity slider | `Meter`-styled range (next: `upscale` factor) | to adopt |
| Krea model catalog cards | `ContactSheet` of `Frame`s with an edge print | to adopt (models page) |
| Higgsfield mode switcher in the header | `SegmentedSwitch` (radiogroup, arrow keys) | style guide; Studio header next |
| Higgsfield reference drop zone with count | `Panel tone="sunken"` + `Chip` count (`count` prop) | to adopt (ReferencePicker) |
| Higgsfield chips row under the prompt | `.studio-seg` / `ChipRow` under the prompt | Studio composer |
| Higgsfield one big Generate with price, old price struck | `PriceButton` (`credits`, `was`) | Studio composer |
| Higgsfield preset gallery with "for whom" line | `TileGrid` + `Frame` caption | to adopt (PresetGallery) |
| Higgsfield phone tab bar with centre create | `.ns-tabbar` with the lit `.ns-tab-create` key | customer shell |
| MagicLight step cards with a total at each step | `StepCard` (`price`, `total`) | to adopt (storyboard review) |
| Credit counter in the header that opens balance (never a payment offer) | `CreditMenu` key with `Meter` | customer shell |

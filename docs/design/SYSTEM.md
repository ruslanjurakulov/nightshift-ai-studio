# Nightshift visual system (S5)

One visual language for the public site and the Studio, dark-first. Owner of this file: stream S5. It extends
`docs/design/TOKENS.md` (colour roles, keys, contrast) and is driven by the measured gaps in
`docs/design/S5_BENCHMARK.md` (PR #894). Tokens live in `command-center/app/tokens.css`; the "Type scale, rhythm and motion (--ds)"
block of the live specimen (`/{channel}/design`) shows every role at its real size in both themes.

**What is decided by the owner and not changed here:** the navy/neon colour family (TOKENS.md), Onest as the display and
body face and the public site without the `ds-skin` class (both the owner's choice of 22 Nov, carried by PR #889, merged;
the roles below take whichever face `--ds-font-display` names). Anything below that would touch those is written as a proposal.

## 1. Type

One family (Onest, per #889) for display and body, the system monospace (`--font-mono`) for machine labels and time. Hierarchy comes from **size,
air and weight together**, never weight alone: display is 500 with tight tracking; the leaders measured at 400–500
(benchmark §1). Every fluid size is **linear** between a 360 px phone and a 1440 px desk (it reaches its maximum at 1440,
not before). A role works on a real `<h1>`–`<h4>`: the app's unlayered heading rule (`globals.css`) skips any element with
a `ds-t-*` class.

| Role | Class | 360 → 1440 | Line height | Tracking | Weight | Use |
| :-- | :-- | :-- | :-- | :-- | :-- | :-- |
| Display XL | `.ds-t-display-xl` | 40 → 72 | 1.04 | −2.5 % | 500 | The one hero line per page |
| Display L | `.ds-t-display-lg` | 32 → 56 | 1.08 | −2 % | 500 | A section's opening line |
| Heading XL | `.ds-t-heading-xl` | 28 → 40 | 1.12 | −1.5 % | 500 | **The missing middle**: a plan name, a big number, a page title in the app |
| Heading L | `.ds-t-heading-lg` | 22 → 28 | 1.2 | −1 % | 600 | A panel or card title that leads |
| Heading M | `.ds-t-heading-md` | 20 | 1.3 | 0 | 600 | A dialog title, a group |
| Heading S | `.ds-t-heading-sm` | 16 | 1.4 | 0 | 600 | A card title in a grid |
| Body L | `.ds-t-body-lg` | 18 | 1.6 | 0 | 400 | A lede: one or two lines under a display line |
| Body | `.ds-t-body` | 16 | 1.6 | 0 | 400 | Prose (max 62 ch) |
| Body S | `.ds-t-body-sm` | 14 | 1.5 | 0 | 400 | Dense UI: inspectors, lists |
| Caption | `.ds-t-caption` | 13 | 1.45 | 0 | 400 | The honest note next to a key ("Nothing is charged until…"). **The floor for prose.** |
| Label | `.ds-t-label` | 12 | 1.3 | +8 % | 500, mono, UPPERCASE | Track headers, node titles, eyebrows. Never a sentence. |
| Timecode | `.ds-timecode` | 24 → 36 | 1 | −1 % | mono, tabular, accent | The transport clock; `<span data-part="total">/ 00:08:00:00</span>` dims the total |

Rules: a component never sets `font-size` by hand; it takes a role. A number that changes or lines up takes `.ds-num`
(or `.ds-mono`). `text-wrap: balance` on display and headings, `pretty` on prose. Uzbek uses ʻ (U+02BB) and ʼ (U+02BC);
uppercase labels in ru/uz run ~30 % longer than English — size a label's box for the Russian string.

**Superseded helpers** (kept for existing callers, not for new work): `.ds-display` (weight 600) → `.ds-t-display-*`;
`.mono` and `.tnum` (globals.css) → `.ds-mono` for monospace, `.ds-num` for tabular figures in the body face.

## 2. Space and rhythm

- **4 px base** (`--ds-space-1…24`, same as Tailwind's `p-1`).
- **Gutter** `--ds-gutter` 16 → 40 px. **Container** `--ds-container` 1200 px, `--ds-container-wide` 1440 px
  (`.ds-container`, `.ds-container--wide`).
- **Section** `.ds-section`: `--ds-section-y` 64 → 144 px top and bottom. **Section head** `.ds-section-head`: title, at most
  one line of lede, then `--ds-section-head-gap` (24 → 48) to the content. A section opens on something to look at, not a
  paragraph (benchmark gap 3).
- **Stacks** inside a component: `--ds-stack-tight` 8, `--ds-stack` 16, `--ds-stack-loose` 32.

## 3. Shape, edges, elevation

| | Token | Value | Rule |
| :-- | :-- | :-- | :-- |
| Chip, media frame, segment | `--ds-r-chip` | 8 | Anything that holds media or is a token in a row |
| Key, field | `--ds-r-key` | 12 | Anything you press or type in |
| Card, panel | `--ds-r-panel` | 16 | A container of keys/fields |
| Sheet, dialog | `--ds-r-sheet` | 20 | Something that sits over the page |
| Pill | `--ds-r-pill` | full | Tags, toggles, the dock |

Nesting: an inner radius is the outer radius minus the padding between them (a 16 card with 8 padding holds 8 frames). One
**1 px hairline** (`--ds-hairline`, colour `--ds-border`) is the default edge; `--ds-border-strong` only on controls that
need 3:1. Elevation: `--ds-elev-1` resting card, `--ds-elev-2` floating dock/popover, `--ds-elev-3` sheet. Glow
(`--ds-glow-accent`) belongs to the **one** primary key in view, nothing else.

## 4. Colour: one accent strategy

- **Blue = the machine and the one primary action.** The primary key, the timecode, a "working" state. One primary key per
  view.
- **Lime = a person's mark.** Selection, focus ring, a person's approval. Never decoration, never a badge background.
  Because focus and selection share the hue (the canvas made every focus ring lime in #932), they must differ by **shape**, not
  colour: focus is a 2 px outline drawn *outside* the element with a gap (`outline-offset` ≥ 2 px), selection is the element's own
  border or `--ds-glow-select`. A focused, selected node then shows both at once, and neither can be read as the other. A
  container that clips (`overflow: hidden/auto`) must leave room for the ring's offset, or the ring is cut (seen on the canvas: 4 px).
- **Type hues** (text yellow, image cyan, video magenta, audio green) = **media identity only**: a chip's dot, a track's pill,
  a node's edge. Not icon-tile backgrounds, not section badges (benchmark §1: we spend the accent on badges).
- **Status** (success/warning/danger) only for status.
- Everything else is neutral: text, text-2, muted on bg/surfaces.

**Proposal for the owner (not shipped):** the leaders all sit on a neutral near-black (`#0f1113`, `#101010`, `#070707`); ours
is a blue-tinted navy (`#070a14`), which reads "dashboard" rather than "cinema". A neutral ground (`#0a0b0e` / surfaces
`#101216`, `#16191f`, `#1f232b`) with the same blue key and lime mark would keep the identity and lose the dashboard tint.
It is one block of `--ds-*` values; S5 can prepare it as a switchable specimen for the owner to compare before anything
changes.

## 5. Motion

| Token | Value | For |
| :-- | :-- | :-- |
| `--ds-dur-press` / `--ds-ease-press` / `--ds-press-scale` | 120 ms, .97 | A key under the finger |
| `--ds-dur-panel` / `--ds-ease-out` | 200 ms | A panel, popover, drawer arriving |
| `--ds-dur-page` | 300 ms | A route or view change |
| `--ds-dur-reveal` / `--ds-ease-emphasized` / `--ds-reveal-shift` | 480 ms, 12 px | Media and cards arriving (`.ds-reveal`) |
| `--ds-stagger` | 40 ms | Order in a list: `style={{"--i": index}}` |
| `--ds-dur-ambient` | 2400 ms | Skeleton shimmer, a "working" pulse |
| `--ds-ease-exit` | — | Something leaving (faster in, slower never) |

`.ds-reveal` supersedes the older `.reveal` / `reveal-in` (globals.css, 55 ms stagger) for new work. Set `--i` on the
element itself; a `.ds-reveal` nested in another has its `--i` reset to 0.

**Reduced motion** (`prefers-reduced-motion: reduce`): every duration above is 0, the press does not scale, nothing travels
(`--ds-reveal-shift: 0`), the stagger is 0. A spinner becomes a still half-ring next to its spoken label (Button already
does this). Motion never carries meaning on its own: a state change is also a word or an icon.

Motion must be true: a pulse means a real job is running (an event said so), a card lighting up means a real status
changed. A demo animation is labelled as a demo.

## 6. Component specs

These are the pieces every stream uses. Where a component already exists it is named; where it is missing, S5 builds it in
`components/ds/` (next PR) and the stream consumes it. All strings come from `lib/i18n/{en,ru,uz}` as props.

**Buttons** — `components/ds/Button.tsx` (exists; TOKENS.md). One primary per view. A key that spends shows the backend's
price on its face (`PriceButton`, `components/ui/`), never a client-side guess; without a quote it is disabled with the
reason as a caption under it.

**Chips** — `.ds-chip` (exists): 36 px (44 on touch), pill, `aria-pressed` for a filter, `data-type` for a media dot.

**Tags** — small pill, `.ds-t-label` text, neutral surface-3 background, 24 px high. Agent tags on the timeline (`caps-01`,
`fx-02`) are the one tag that may take a type hue at full strength, because they move and must be followed.

**Cards** — surface-1, 1 px hairline, `--ds-r-panel`, padding 16 (12 on a phone). Media card: the media *is* the card
(frame radius 8 inside, no padding at the top), the title sits above it in `.ds-t-label` (the canvas reference). Hover:
border to `--ds-border-strong`, no lift. Selected: `--ds-glow-select`.

**Panels** — surface-1 docked panels (Brain, inspector, library): a 48 px header with a `.ds-t-heading-sm` title and at most
two icon keys; body scrolls, header and footer do not. Width 360–420 at desk; a bottom sheet (`--ds-r-sheet` top corners)
under 768.

**Dock** — one floating pill bar, `--ds-elev-2`, surface-2 at 92 % with a backdrop blur, 52 px high, centred 16 px above the
bottom edge. It holds the canvas's tools; the page header holds navigation only. The benchmark measured ~160 px of chrome
and 19 controls around our empty canvas (gap 4): the target is a 56 px header and the dock.

**Timecode** — `.ds-timecode`: mono, tabular, accent, total dimmed. Unknown duration renders the word ("unknown"), never
`00:00` (rule 5).

**Timeline lane** — track header in `.ds-t-label` with a dim second line in `.ds-t-caption`; one hue per track from the type
tokens at a soft fill (`color-mix(in srgb, var(--ds-type-video) 22%, var(--ds-surface-2))`) with the label in the hue; 1–2 px
gaps between segments; the playhead is a 1 px `--ds-text` line with a flag.

**States** — one spec for all six; every one has an icon, a one-line title (`.ds-t-heading-sm`), at most one line of
explanation (`.ds-t-body-sm`, muted) and **one way forward** (a key or a link). None is a dead end.

| State | Title says | Way forward | Never |
| :-- | :-- | :-- | :-- |
| Empty | what will appear here | the action that makes the first one | an illustration with no action |
| Loading | nothing (skeleton in the content's shape, `--ds-dur-ambient` shimmer); after 10 s, "Still working…" | cancel, if the job can be cancelled | a spinner over a blank page; a fake progress % |
| Error | what failed, in words | retry, and the remedy when known (rule 6) | an error code alone; "something went wrong" with no action |
| Insufficient credits | the backend's price and the balance, both from the server | add credits (→ billing) | a price the client computed; disabling silently |
| Provider unavailable | which model/voice is down and that the run will not substitute another (rule 4) | choose another *yourself*, or try later | quietly using a different model |
| Session expired | you were signed out; nothing was lost (when true) | sign in again, returning here | dropping the person's draft |

Existing shared pieces these replace or restyle: `EmptyState` (`components/ui.tsx`), `ErrorState`
(`components/ReadError.tsx`), `Skeleton` (`components/feedback/Skeleton.tsx`), `LoadingGrace`
(`components/motion/LoadingGrace.tsx`).

## 7. Review checklist (what Pixel checks against this file)

1. Every text takes a role from §1; no prose under 13 px; no display at 600+ in new work.
2. One primary key per view; lime only for selection/focus/approval, focus told from selection by shape (§4); type hues only for
   media identity.
3. Radii by role (§3); one hairline; glow only on the primary key.
4. Sections open on media or a one-line title, not a paragraph.
5. Every motion has a reduced path and a truthful trigger.
6. All six states present where they can occur; none a dead end; unknown reads unknown.
7. 360 / 768 / 1440 without horizontal scroll; 44 px targets on touch; focus visible; en/ru/uz fit.

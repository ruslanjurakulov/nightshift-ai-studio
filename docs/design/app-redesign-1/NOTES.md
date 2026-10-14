# The signed-in app, round 1: one lit desk per page

Status: 2026-10-11, branch `app-design-1`. Builds on `FOUNDATION.md` (tokens, classes, rules) in this folder. The owner's complaint:
the public site went through nine rounds, the app after login still read as a generic dark dashboard of rounded cards with an amber
button. This round makes it read as the same product: same Onest type, same indigo key with amber as accent, the same warm-room
depth, and one idea carried through every page.

## The one idea

**One lit desk per page.** The room is dark (a proof sheet on paper). Work is laid out as ruled, open sections on the ground, and
exactly one thing is lit: the desk that holds the page's job. The desk is the only lifted surface and its top edge carries the
warm-to-indigo hairline the public hero is lit by. The page's one filled key is the public indigo; amber is only lamps, selection,
edge numbers and the focus ring. Media is shown as numbered frames, not icon-tile cards.

| Page | What the desk is | What became ruled or framed |
| :-- | :-- | :-- |
| Studio / Create | the five desks as one lit patch bay; on a tool desk, the composer | recent work, credits and edit projects are ruled; the Assistant is an open section |
| Home | the four numbered steps of the video flow (topic, look and sound, price, the one key) | videos are numbered frames you swipe on a phone; "more things to make" is one ruled list; the three promises sit beside the desk |
| Credits | the balance (a large figure, the meter, where credits come from, the one filled "Get more credits" key) | plans, invite and activity are ruled sections; every pack and plan key is the same PriceButton outlined (`tone="quiet"`), Copy and Create link are quiet. Checked on a build that offers packs and plans (fake test-mode checkout settings, not committed): exactly one filled key |
| Library | the drop zone when empty (media itself was already contact-sheet frames) | storage is a ruled strip; its Upload key goes quiet while the empty desk holds the primary |
| Videos list | none needed: the list is the page | stats are one ruled strip; each row starts with a small frame (a Short is upright); filters are chips |
| Settings | Account and security (the workspace name and "another organization" cards were removed in the settings cleanup) | Developers is ruled; fields are 44px with 16px text |

## Shell and primitives

- **Sidebar**: group names are slug lines (label and hairline), the current row is an indigo tick on the sliding plate, desktop rows
  are 40px (touch keeps 44), so the whole rail fits a 900px window. A panel-toggle button beside the wordmark collapses it to a
  72px icon rail (a row's name is screen-reader text plus a tooltip that shows on hover and on keyboard focus), remembered per
  browser, no layout flash (the localStorage value is mirrored to a cookie the layout reads; checked on a production build: the
  HTML carries `data-collapsed="true"` with the cookie, CLS 0), no width animation under reduced motion. No keyboard shortcut was added.
- **Top bar**: icon keys are quiet until pointed at; the credit key is the one bordered object, with its meter.
- **Page header**: the slug line (page mark and hairline) then a 44px title; the icon tile is gone.
- **Section tabs** (Studio's screens): underlined, the current one amber, as the public Studio card draws them.
- **Phone**: the bottom bar's Create key is the lit indigo key; the current tab is an indigo tint.
- **Keys**: `btn-primary`, `studio-cta`, `PriceButton`, `btn-sky is-solid` are indigo with a white legend, a 1px edge and a glow; hover
  swaps the fill (no brightness filter). A pressed segmented key is raised with an amber underline, so it is never a second primary.
- **Focus**: amber, 3px ring outside a 2px gap, everywhere.
- **Primitives** (`components/ui`: Panel, PriceButton, Chip, Meter, SegmentedSwitch, StepCard): restyled, props unchanged.
  `Panel tone="lifted"` is the desk, `flat` is a ruled section.
- **Room**: the public hero's warm glow, indigo wash and fine grid, quieter, behind the page head.
- **Honesty**: nothing invented. Frames carry the item's real title and state (the library already shows real thumbnails; videos
  have none in the data, so their frame shows the title and number, not a made-up picture). No stock photos in the app.

## Measured (tools/visual-qa, fake backend, real Chromium)

Six pages, 1440 and 390, light and dark, full-page. Before is `main` (3bdaf0fe), after is this branch.

| Check (24 shots, en) | Before | After |
| :-- | --: | --: |
| axe (wcag2a/aa, any impact) | 0 | 0 |
| CLS, worst | 0 | 0.0001 |
| Horizontal overflow | 0 | 0 |
| Animations still running after settle | 0 | 0 |
| Text fields under 16px, all shots | 14 | 2 (the read-only invite link on Credits, 14px, at 1440 in both themes) |
| Touch targets under 44px at 390 | 2 | 2 (the same visually hidden 1x1 px file input of the Library, in both themes) |
| Reduced-motion run, same pages | n/a | 0 violations, 0 running |

Files are named `{page}_{width}_{theme}.webp` (pages: create, home, credits, library, videos, organization).

Russian: the same six pages at 1440 and 390 in light and dark, no overflow, axe 0. Uzbek: Home, Credits and Settings at 1440 and 390
in dark, no overflow. Screenshots: `before/`, `after/` (en), `after-ru/`, `after-uz/`, `sidebar/` (expanded and collapsed, 1440, light and
dark) and `phone/` (the tab bar). Before shots exist for en only. Desktop sidebar rows are 40px on a mouse by design (44 on touch), which the
tool counts under 44px at 1440.

## Tests

`tests/sidebar-toggle.test.tsx` (new, 8): toggle flips `aria-expanded` and the rail, persists to storage and cookie, draws collapsed from the
server cookie, still works when storage throws, tooltip on hover and keyboard focus, ru and uz labels, 44px key and focus ring.
`tests/sidebar-pref.test.ts` (new): the cookie reader is an allow-list (`collapsed` only) and lives in a plain module the layout imports.
`tests/credits-one-key.test.tsx` (new): with packs and plans on offer the Credits view has exactly one filled key. `tests/site-colour.test.ts` and
`tests/light-theme-tokens.test.ts` were updated for what the colours legitimately changed (the app's key is now the public indigo, focus is
amber, `--color-primary` is the interaction ink); the app's key and focus pairs are pinned equal to the public ones, with contrast floors.
Full suite 231 files (4818 tests), all green; `tsc` and `next lint` clean.

## Not done in round 1

Other page groups (operator pages, Developers, Models, Styles, Editor, Channels) keep their old chrome inside the new shell until their
builders adopt `ns-open`. The Videos detail page, the storyboard review and the clip desks were only touched through shared tokens and
primitives. No real thumbnails for videos (none stored). The credit menu, command palette and notification sheet got the new key colours
but no layout work.

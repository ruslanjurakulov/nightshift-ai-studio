# App redesign, round 1, group G3 (production pages)

Branch `app-design-g3`, stacked on the Foundation commit (`app-design-1`, 06cd32d3). Pages: Pipeline, Jobs, Approvals,
Decisions, Inbox, Editor (home), Workflows (list, one workflow, one run), Studio (the canvas desk page), Time machine and
the command palette. Rules are the foundation's (`docs/design/app-redesign-1/FOUNDATION.md`); nothing in the foundation
files was edited. Page rules live in `command-center/app/(app)/app-pages-g3.css`, every selector prefixed `g3-`, loaded
app-wide from `components/CommandPalette.tsx` (the palette is mounted by the layout, so no layout edit was needed).
Shared pieces: `components/g3/Section.tsx` (`Section` = ruled section or the desk, `Note` = one true line).

## What each page does now

| Page | Desk (the one lit surface) | The one filled key | Media and status |
| :-- | :-- | :-- | :-- |
| Pipeline | Video pipelines | none (read-only page) | Stage rundown: numbered, amber edge print, lamps; 9 columns on a wide desk, 2 or 3 on a phone (container query), never a sideways scroll |
| Jobs | The job list | none | Lamps; the table becomes stacked, labelled rows on a phone |
| Approvals | The request list | Request approval | Lamps; Approve / Reject outlined; every guard unchanged; the requirement switch was removed (the two-person feature is not offered) |
| Decisions | The decision list | none | Outcome lamp, evidence word, reason in a sunken well, `aria-expanded` on Explain |
| Inbox | The first reply that waits for approval | the final Approve and post (after the exact text is shown) | Lamp per state; Draft a reply stays priced but outlined |
| Studio | Style presets | New style kit | Presets, kits and characters are film frames with edge numbers; amber selection |
| Editor (home) | New project | Create project | Library videos are frames you pick (radio inside), projects are ruled rows |
| Workflows | Your workflows (the builder when open) | New workflow | Steps as a numbered rundown; runs with lamps |
| One workflow | The total price and Run now | Run now (then the confirm) | The price rule is untouched: no total, no Run now |
| One run | The run summary | none | Step lamps; only a working step breathes |
| Time machine | The timeline | none | Range chips (amber pressed), lamps, ruled aside for the chosen event |
| Palette | the sheet itself | none | Grouped results, indigo active row with a tick, kbd keys, 44px rows and close |

Editor detail (`/editor/<id>`) keeps the tool's own boxed panels (preview, timeline, clip form); only its header and notes
are aligned, and its fields are 16px. The operator frame (`SectionShell`) is untouched; see `FOUNDATION_REQUESTS.md`.

## Copy

Engineer wording was made plain in en, ru and uz: Pipeline and Jobs subtitles, the read-only line on Jobs, Studio presets
hint and autopilot line (no environment variable named), Time machine and Decisions subtitles and empty state.

## Checks (production build against the fake backend, `tools/visual-qa`)

axe 0 violations on every page at 1440 and 390, light and dark, en, ru and uz; no horizontal overflow; CLS at most 0.0001;
with reduced motion no animation runs. Screenshots: `before/` (the foundation as it was) and `after/`, plus `after-ru/`,
`after-uz/` and `states/` (inbox approval step, workflow builder, palette).

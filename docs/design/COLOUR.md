# Colour: one primary action in indigo, amber stays the accent

Owner decision (variant B of the colour options sheet): the public site's primary action is indigo with a white legend.
Amber is no longer a button. Scope: the public pages (`/`, `/pricing`, `/solutions`, `/login`, `/signup`, `/mcp`, the
legal pages, the shared header, sticky bar and footer) through the `.st` and `.nx` scopes in `site.css` and
`site-next.css`. The signed-in app's tokens (`app/globals.css`) are not edited: it keeps its amber key and its blue focus ring.

## Rule

- One filled key per screen, indigo (`--st-lit-*`). Everything that answers a pointer is the same family: link hovers,
  hover borders of outlined buttons, the planner slider (`--st-act`, `--st-act-ink`).
- Amber is the brand's accent and a state: lamps and status dots, the lit key drawn inside an Example, the selected tab or
  pill, the pressed pause button, the playhead, badges, the price figure, the glow behind the cards.
- Keyboard focus on the public site is amber (`--ns-focus` on `.st`), so it never reads as "primary". On the key the ring
  is drawn outside a 2 px gap in the page's own colour.
- The second headline line takes `--st-act-ink`.

## Numbers

| Pair (WCAG contrast) | Before (amber) | After, light | After, dark |
| :-- | --: | --: | --: |
| Key fill | #f29a1e / #ffa940 | #4f46e5 | #6558f5 |
| Legend on the key | 7.80 (ink) / 9.77 | 6.29 (white) | 4.92 (white) |
| Legend on the key, hover | n/a (brightness) | 7.9 (#4338ca) | 5.66 (#5b4ee9) |
| Key fill against the page | 2.01 / 9.81 | 5.66 | 3.80 |
| Key edge against the page | faint amber edge | 7.11 (#4338ca) | 7.81 (#a39cff, a 1 px light edge) |
| Headline second line against the page | 5.18 (#9c5300) / 9.81 | 7.11 (#4338ca) | 9.15 (#b3acff) |
| Focus ring against the page | 5.63 (blue) | 4.58 (#a85a00); 5.09 on white | 11.73 (#ffc266) |
| Focus ring against the key | n/a | gap: white is 6.29 on the key; direct 1.24 | 3.08 direct (gap #131210 as well) |
| Closing panel and sticky bar (dark in both themes) | n/a | dark pair: legend 4.92, fill 3.89, edge 7.99 against #100f0d | same |

The light ring cannot be 3:1 against the key as well as against the page: an amber dark enough for the paper is as dark as
the indigo. The ring is therefore never next to the key, it is next to a white gap that is 6.29:1 on the key.
The dark key fill is 3.80:1 on the page by itself (the number the sheet showed); the light edge and the glow delimit it.

## Where each thing is

- Tokens and the dark groups: top of `components/site/site.css` (the `.st` block, then `:root[data-theme="dark"] .st,
  .nx-final, .nx-bar, .st-auth-aside` and the `prefers-color-scheme` mirror). `--color-primary` is overridden on `.st`
  only, so the legal pages' links and bullets follow.
- `.st-key`, `.nx-btn`, `.nx-bar-go`: hover swaps the fill (no brightness filter, which would lower the legend contrast),
  press moves 1 px, disabled keeps the fill and shows no hover.
- Tests: `tests/site-colour.test.ts` computes the pairs above from the stylesheet and pins the app's tokens.

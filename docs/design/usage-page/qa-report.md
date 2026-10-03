# Usage page: visual QA

Real Chromium against `tools/visual-qa/fake-supabase.mjs` (made-up rows, no database),
`next build && next start`, `--fake-state <state>` per account state.

Matrix: 9 states (`sub0` 0% used, `sub62`, `sub100` all used with extra credits on, `sub100off` all used with
extra credits off and a pack waiting, `zeroextra`, `off62`, `free`, `nolot` a live plan with no credits added,
`ended` a live plan whose last period expired) x en/ru/uz x 360/390/1280 px x light/dark = 162 loads of
`/night-owl/usage`, plus the switch pressed (2) and the Credits page (12).

| check | result |
|---|---|
| horizontal overflow | 0 px in every load |
| axe-core (wcag2a, 2aa, 21a, 21aa), all impacts | 0 violations in every load |
| layout shift (CLS) | 0 to 0.01, none above 0.1 |
| running animations after settle | none |
| text fields under 16 px | none on the Usage page |
| touch targets under 44 px (phone widths) | none on the Usage page; the credit pill in the top bar was 40 px high and 33 px wide at "0" and is now 44 px under a finger (`.shell-pill`, globals.css) |

Known, not from this change: in this lab's Chromium the Uzbek locale has no ICU data, so after hydration dates and
"in 21 days" render in the fallback form ("2026 M10 24") and React logs a text mismatch (#418) for the `uz`
runs. Node renders them correctly ("24-okt, 2026", "21 kundan keyin") and every other browser ships the data. The
Credits page's dates behave the same way.

Pictures: `<state>-<width>-<theme>-<language>.webp`; full-page, with the phone's fixed tab bar hidden.

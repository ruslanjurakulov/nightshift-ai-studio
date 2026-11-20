# Design tokens (`--ds-*`) and the key system

The owner-approved navy/neon look, made into one token file so every screen can
use it: `command-center/app/tokens.css`. It is imported by `app/globals.css`
right after Tailwind, so the tokens and the Tailwind names exist on every page.

It is **additive**. The older `--ns-*` identity (globals.css) still paints every
existing screen; nothing changes colour because this file exists. A screen
moves to `--ds-*` when someone edits it.

## Themes

Dark is the primary theme. The app already has a light one, so `--ds-*`
follows the same selectors as globals.css: an explicit `[data-theme]` wins,
otherwise the system preference; `[data-theme-scope]` boxes work too. Every
token is declared in light, prefers-dark and explicit-dark
(`tests/ds-tokens.test.tsx` fails if one is missing or the two dark blocks
drift).

## Roles

| Role | CSS variable | Tailwind | Dark | Light |
| :-- | :-- | :-- | :-- | :-- |
| Page | `--ds-bg` | `bg-ds-bg` | `#070a14` | `#f5f7fc` |
| Surface 1 / 2 / 3 | `--ds-surface-1…3` | `bg-ds-surface-1…3` | `#0a0f1c` `#0f1626` `#19243b` | `#fff` `#eef2f9` `#e3e9f4` |
| Hairline / control edge | `--ds-border`, `--ds-border-strong` | `border-ds-border(-strong)` | 18 % blue, `#56698f` | `#d6deeb`, `#7d8aa3` |
| Text primary / secondary / muted | `--ds-text`, `--ds-text-2`, `--ds-muted` | `text-ds-text…` | `#e6eefc` `#a9b8d4` `#8a9bbd` | `#0a1222` `#33425e` `#536079` |
| Accent (text, glow) | `--ds-accent`, `--ds-accent-hover` | `text-ds-accent` | `#2f8bff`, `#57a2ff` | `#1a5fd0`, `#1550b3` |
| Accent fill (keys) | `--ds-accent-solid(-hover)`, `--ds-on-accent` | `bg-ds-accent-solid` | `#1a5fd0`→`#1f6fe5`, white | `#1a5fd0`→`#1550b3`, white |
| Selection (a person's mark) | `--ds-select`, `--ds-select-soft` | `ring-ds-select` | `#c8ff2e` | `#406a00` |
| Success / warning / danger | `--ds-success`, `--ds-warning`, `--ds-danger` | `text-ds-…` | `#3dff8a` `#ffd23f` `#ff5c6c` | `#0a7346` `#7e6100` `#c0263a` |
| Focus ring | `--ds-focus` | `outline-ds-focus` | `#c8ff2e` | `#406a00` |
| Type: text / image / video / audio | `--ds-type-*` | `text-ds-type-*` | `#ffd23f` `#33d6ff` `#ff4fa3` `#3dff8a` | darker inks, ≥ 4.5:1 |

Every text role is ≥ 4.5:1 on all four grounds in both themes; control edges
and the focus ring are ≥ 3:1. The test computes it, so a new value that fails
does not merge. The focus ring is lime, not blue: the primary key is blue, and
a blue ring would read as "primary" rather than "you are here".

**Space** `--ds-space-1…24` (4px base; Tailwind's `p-1 = 4px` is the same
scale). **Radius** `--ds-r-chip` 8, `--ds-r-key` 12, `--ds-r-panel` 16,
`--ds-r-sheet` 20, `--ds-r-pill`. **Elevation** `--ds-elev-1…3`, **glow**
`--ds-glow-accent`, `--ds-glow-select`. **Motion** `--ds-dur-press` 120 ms,
`--ds-dur-panel` 200 ms, `--ds-dur-page` 300 ms, `--ds-ease-out`,
`--ds-ease-press`, `--ds-press-scale` .97 — all zeroed under
`prefers-reduced-motion`. **Layers** `--ds-z-raised` < `sticky` < `header` <
`dropdown` < `overlay` < `modal` < `toast` < `tooltip`: take a role, never a
raw number.

## Type

Body, labels and keys stay **Onest**. Display headings only — a hero, a
section title, a big number — use **Unbounded** (SIL OFL 1.1, licence in
`command-center/brand/og-fonts/OFL-Unbounded.txt`), self-hosted in the same four
subsets as Onest with `font-display: swap` and a metric-matched fallback (no
layout shift). Use `.ds-display` or the Tailwind `font-brand`. Numbers that
change or line up: `.ds-num` (tabular digits).

A page whose first screen sets a display heading calls
`preloadDisplayFont(locale)` from `components/site/fonts.ts` next to
`preloadFonts`. Never from the root layout: an app screen must not download a
face it does not show.

## Keys and controls

```tsx
import { Button, IconButton, Toggle, buttonClass } from "@/components/ds/Button";

<Button variant="primary">{t.x.create}</Button>
<Button variant="primary" loading={saving} busyLabel={t.x.saving}>{t.x.save}</Button>
<IconButton label={t.x.settings} icon={<Gear />} />            // tooltip on hover + keyboard focus, Esc closes
<Link href="/x" className={buttonClass({ variant: "secondary" })}>…</Link>
<input className="ds-input" />  <button className="ds-chip" aria-pressed={on} data-type="video" />
<Toggle checked={on} onChange={setOn} label={t.x.captions} />
```

Variants: `primary` (one per view; glows on hover), `secondary`, `quiet`,
`danger`; sizes `sm` / `md` / `lg`; `block`. Every key has hover, press (scale
.97 over 120 ms), `:focus-visible`, disabled and busy (spinner + a spoken
label; the key stays focusable and swallows a second press). The components
hold no strings — every label comes from `lib/i18n/{en,ru,uz}`.

The classes are unlayered (like the older `.btn-*`), so a Tailwind utility will
not override their padding or colour: use the size/variant modifiers instead.

Live specimen, both themes: `/{channel}/design` (operator only), "Keys and
controls (--ds)".

## Migration note for the other streams

1. Rebase onto this PR; nothing you have breaks.
2. For a screen you are already editing, replace `btn-primary` →
   `buttonClass({ variant: "primary" })` (or `<Button variant="primary">`),
   `btn-quiet` / `btn-sky ghost` → `secondary` or `quiet`, `btn-danger` →
   `danger`. Drop ad-hoc `disabled:opacity-*` — the key has its own disabled
   state. Use `loading` + `busyLabel` instead of swapping the label by hand.
3. Read colours from `--ds-*` (or `bg-ds-*` utilities), never a raw hex.
4. Do not edit `tokens.css` values in your PR; ask S4 (contrast is tested).

Already moved: the Welcome flow (`components/welcome/WelcomeFlow.tsx`).

# App redesign, round 1: the foundation other page groups build on

Branch `app-design-1`. Files: `command-center/app/globals.css` (tokens), `command-center/app/(app)/app-redesign.css`
(shell, primitives, opt-in sections), `components/PageHeader.tsx`, `components/navigation/SectionTabs.tsx`,
`components/shell/{CustomerSidebar,SidebarState}.tsx`, `components/ui/*` (CSS-only changes, props unchanged). Page work for
Studio/Create, Home, Credits, Library, Videos and Settings lives in `app/(app)/app-pages-1.css` and those pages' components:
do not depend on it.

## The one idea: one lit desk per page

The room is dark (on paper, a proof sheet). Work is laid out as **ruled, open sections on the ground**, and exactly **one
thing per page is lit**: the desk that holds the page's job (the composer, the balance, the workspace name). The desk is the
only lifted surface; its top edge carries the same warm-to-indigo hairline the public hero is lit by. The page's one filled
key is the public site's indigo. Amber is what it is on the public pages: lamps, selection, edge numbers, the focus ring.

Rules a page follows:

1. Start with `<PageHeader icon title subtitle actions />` (slug line, big title, lead). No icon tiles.
2. Put `ns-open` on the page's root element (`<div className="rhythm ns-open">`). Inside it, `.panel`, `.section-card` and the
   older `Panel` (ui.tsx) become ruled open sections instead of rounded boxes.
3. At most one **desk** per page: add `ns-desk` to the section that holds the job (`<section className="panel ns-desk">`), or
   use `<Panel tone="lifted">`. Not two, not on every card.
4. At most one **filled primary** per view: `btn-primary`, `studio-cta`, `PriceButton`, `btn-sky is-solid`. Everything else is
   `btn-quiet`, `btn-sky is-quiet` or `ghost`; a `PriceButton` that is not the one takes `tone="quiet"` (same price legend,
   outlined; default `primary`, so existing callers are unchanged). When several equal offers exist (packs, plans) the page's
   single main action is filled and each offer is quiet. Selected states (chips, segmented keys, tabs) use amber, never indigo fill.
5. Media is shown as **frames** (film tile, 16:9, edge number in amber), not as cards with an icon tile. Real thumbnails when the
   data has them, otherwise the kind's glyph on film. No stock photos in the app.
6. Status is a lamp with its word (`StatusLamp`); amber/green/red lamps only.

## Tokens (globals.css, all three theme blocks: light, `prefers-color-scheme: dark`, `data-theme="dark"`)

| Token | Light | Dark | Use |
| :-- | :-- | :-- | :-- |
| `--ns-cta-bg` / `-fg` / `-price` | `#4f46e5` / `#fff` / `#fff` | `#6558f5` / `#fff` / `#fff` | the one filled key (same pair as the public `--st-lit-*`) |
| `--ns-lit-hover` | `#4338ca` | `#5b4ee9` | key hover |
| `--ns-lit-edge` | `#4338ca` | `#a39cff` | 1px edge of the key |
| `--ns-lit-glow` | `rgba(79,70,229,.5)` | `rgba(101,88,245,.6)` | glow under keys and the desk |
| `--ns-act` / `--ns-act-ink` | `#4f46e5` / `#4338ca` | `#8f86ff` / `#b3acff` | interaction tone: current nav row, hovers, links |
| `--ns-act-soft` | `rgba(79,70,229,.09)` | `rgba(143,134,255,.14)` | tint for current/hover rows |
| `--ns-warm` / `--ns-cool` / `--ns-grid` | amber / indigo washes, fine grid | | the room behind the page head |
| `--ns-focus` | `#a85a00` | `#ffc266` | focus ring: 3px, 2px gap (global `:focus-visible`) |
| `--color-primary` | `var(--ns-act-ink)` | same | links and "lit" text (was amber) |
| `--ns-amber`, `--ns-amber-ink`, `--ns-select` | unchanged | unchanged | accent: lamps, meter, selection, edge numbers |

Contrast (pinned in `tests/site-colour.test.ts`): white on key 6.29 / 4.92, interaction ink on page 7.1 / 9.2.

## Classes

- `.ns-open` (opt-in scope), `.ns-desk` (the lit desk), `.ns-slug` + `.ns-slug-rule` (slug line), `.ns-pagehead`, `.ns-title`
  (page-title size for a hand-built heading), `.ns-field` (44px, 16px text field), `.ns-empty`, `.ns-tabs` / `.ns-tabs-link`
  (underlined tabs, amber current), `.shell-*` rows (current row = indigo tick on the sliding plate).
- Keys: `.btn-primary`, `.studio-cta`, `.ns-price-button`, `.btn-sky.is-solid` are indigo and lit; `.btn-quiet` and
  `.btn-sky.is-quiet|ghost` hover to the indigo family.
- The Studio desk bar shows each key's second line by a container query (`@container (min-width: 1240px)` on `.desk-bar`), so
  an open or collapsed sidebar is accounted for and a long Russian label cannot overflow the page.
- Primitives keep their props and class names (`PriceButton` gained the optional `tone`): `Panel` (`flat` = ruled section, `sunken` = well, `lifted` = desk), `PriceButton`
  (indigo, price in white), `Chip` (amber when pressed), `Meter` (amber lit, hatched held), `SegmentedSwitch` (pressed key raised
  with an amber underline), `StepCard` (current step in indigo tint), `StatusLamp`, `Timecode`, `ContactSheet`.

## Shell

Sidebar (customers, `lg` and up): `data-collapsed` on `#customer-sidebar`; the panel-toggle button (`data-testid="sidebar-toggle"`,
`aria-expanded`, `aria-controls="customer-sidebar-nav"`) next to the wordmark collapses it to a 72px icon rail. On the rail a row's
name is screen-reader text plus a tooltip (`data-tip`, drawn by the sidebar as a fixed `.shell-tip`) that shows on hover and on
keyboard focus (`:focus-visible`). State: `useSidebar()` from `components/shell/SidebarState.tsx`; stored in localStorage
`ns-sidebar` (try/catch) and mirrored to the cookie `ns_sidebar` so the layout draws the right width on the server (no flash:
verified on a production build, the HTML carries `data-collapsed="true"` when the cookie is `collapsed`). The names and the
reader (`SIDEBAR_COOKIE`, `SIDEBAR_KEY`, `isSidebarCollapsed`) are in the plain module `lib/sidebar-pref.ts`: never import them
from the client module into a Server Component, the constant does not resolve there.
Below `lg` customers have the bottom tab bar, as before; the toggle is a desktop control. No shortcut key was added.

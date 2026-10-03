# Third-party logos on /mcp

The `/mcp` page names the assistants Nightshift connects to and shows each one's
logo, the way "works with" pages do. Those names and marks belong to their
owners, who each have their own rules. This file is the register behind the code
(`command-center/lib/dev/brand-logos.ts`, the machine-readable twin; a test keeps
it complete). Read on **2026-10-03**; the owner-accepted decision is the same day.

Rules we hold ourselves to:

- Only the owner's own asset: from its brand or press page, its official
  download, or its official repository. Never redrawn, never taken from a
  third-party icon site. The originals are kept unmodified in
  `command-center/brand/third-party/`.
- Shown unmodified: no recolouring beyond the variants the owner provides
  (a mark for a light page, a mark for a dark page), no distortion, no outline,
  no effect. `tools/brand/build_brand_logos.mjs` only strips the XML wrapper,
  makes ids unique and narrows the viewBox to the drawing's own bounding box
  (the same pixels; the owner's clear space comes back as padding in the tile). A
  test checks every path in the page against the vendor's file.
- Used to say "compatible with": the footnote on the page says the names and
  logos are the owners' trademarks, shown only to indicate compatibility, and
  that Nightshift is not affiliated with or endorsed by them. No mark is larger
  or more prominent than ours (the Nightshift N is the centre tile).
- Inline SVG only: no request to another origin, the CSP is untouched.
- Where a vendor's rules do not clearly let us, the mark is still shown on the
  owner's decision (see "Accepted risk" below); the status column says which.
- Raster marks (Gemini CLI, Hermes) are the vendor's own picture, embedded as a
  `data:` URI inside the sprite, so the page still makes no request to another
  origin. Gemini's 1645 px original is scaled to 128 px and stored as WebP (the
  same picture, smaller); Hermes' 48 px PNG is used as is.

**Status:** *official* = the vendor publishes the asset and its rules allow this
use. *owner-accepted* = shown without the vendor's permission, on the owner's
decision of 2026-10-03.

| Client | Mark | Status | Asset source | Rules | What they allow |
| :-- | :-- | :-- | :-- | :-- | :-- |
| ChatGPT | OpenAI Blossom, black / white | **official** | `cdn.openai.com/brand/openai-logos.zip` ("Download logos" on openai.com/brand) | openai.com/brand usage terms | Only where it relates to OpenAI services, exactly as provided, no added colours or effects, open space, not more prominent than our marks, no implied endorsement. Permission requests: partnercomms@openai.com |
| Codex | OpenAI Blossom, black / white (OpenAI's kit has no Codex mark) | **official** | as ChatGPT | as ChatGPT | as ChatGPT |
| OpenClaw | lobster (favicon) | **official** | `openclaw.ai/favicon.svg` = `ui/public/favicon.svg` in github.com/openclaw/openclaw | repo LICENSE: MIT, (c) OpenClaw Foundation | No brand or trademark policy found (openclaw.ai, openclaw.org, repo). Used unmodified in its own colours; follow the Foundation's policy if one appears |
| Cursor | cube, 2D light / dark | **official** | cursor.com/brand -> `cursor-brand-assets.zip` -> General Logos / Cube | cursor.com/brand | Official assets "to represent Cursor consistently and accurately"; call it "Cursor", not "Cursor AI" or "Cursor Code" |
| VS Code | blue "stable" icon | **official** | code.visualstudio.com/assets/branding/visual-studio-code-icons.zip | code.visualstudio.com/brand | OK in documentation/tutorials/blog posts and to link to code.visualstudio.com. Not OK: promoting your own product, implying Microsoft association, a lock-up with the name, modifying it. Blue icon everywhere; white only when contrast is missing |
| Windsurf | symbol, black / white | **official** | windsurf.com/brand -> `exafunction.github.io/public/brand/windsurf-{black,white}-symbol.svg` | windsurf.com/brand | Symbol for space-limited layouts and logo grids; no outline, effects, rotation, reversal, gradients or colour; enough contrast; locked aspect ratio; prescribed spacing |
| Cline | bot icon, light / dark | **official** | cline.bot/brand -> `cline-brand-assets.zip` -> General Logos / Bot | cline.bot/brand (zip README: LIGHT/DARK name the intended background) | Official downloadable brand asset; no further conditions on the page |
| Zed | logomark, black / white | **official** | zed.dev/brand (logomark "Copy SVG") | zed.dev/brand | Brand blue, full white or full black only; no other colour, no distortion |
| Roo Code | extension icon (on a light tile in both themes: single black drawing) | **official** | `src/assets/icons/icon.svg` in github.com/RooCodeInc/Roo-Code | repo LICENSE: Apache-2.0 | No brand or trademark policy found; used unmodified |
| Warp | glyph, black / white | **official** | warp.dev/press -> Logos -> Google Drive "Warp Logos" / Glyph | warp.dev/press | "Logos ... you are free to use in all publications" |
| Claude | Claude Spark as a loose glyph (no tile) in the pill's text colour: muted on a plain pill, inverted on the selected one. The hero tile keeps the Claude app icon (`ClaudeIcon-Rounded.svg`, a finished tile) | **owner-accepted** | anthropic.com/press-kit (`ClaudeSpark-Clay.svg`; hero: `ClaudeIcon-Rounded.svg`) | anthropic.com/legal/trademark-guidelines | Marks only as Anthropic permits and only in materials it approves beforehand; no alterations; no implied endorsement. **No approval was asked.** Request address if ever wanted: marketing@anthropic.com |
| Claude Desktop | Claude Spark, loose, in the pill's text colour (the press kit has no separate Claude Desktop mark) | **owner-accepted** | as Claude | as Claude | as Claude |
| Claude Code | Claude Spark, loose (no tile), in clay `#D97757` on every pill, selected or not; the kit's Claude Code logo is a 7:1 wordmark lock-up that cannot sit in a square tile unchanged | **owner-accepted** | anthropic.com/press-kit (`ClaudeSpark-Clay.svg`) | as Claude | as Claude |
| Gemini CLI | the project's own icon | **owner-accepted** | `geminicli.com/icon.png` (Gemini CLI's own site; Google's Brand Resource Center releases assets only after an application) | partnermarketinghub.withgoogle.com/brands/google | No public official asset or usage terms for this mark; **no permission was asked** |
| Hermes | the project's own icon | **owner-accepted** | `hermes-agent.nousresearch.com/icon.png` (48 px), github.com/NousResearch/hermes-agent (MIT) | none published | No brand page and no larger official mark; **no permission was asked** |
| Other | plug glyph (icon set the site already uses) | n/a | - | - | Not a product |

## One-colour Claude Spark

The Claude and Claude Desktop tabs show the Claude Spark in one colour, the way
Anthropic's own one-colour press-kit variants differ from the clay one: the same
shape, only the fill changes. `tools/brand/build_brand_logos.mjs` builds
`claude-spark-mono` from `ClaudeSpark-Clay.svg` by swapping that file's single
`#D97757` fill for `currentColor`, so the pill's text colour fills it (muted on a
plain pill, inverted on the selected one, light and dark). A test checks every path
is character for character the vendor's and that the fill is the only difference.
Claude Code keeps the clay spark (the vendor's file as it is).

## Accepted risk (owner decision, 2026-10-03)

The owner decided to show every client's mark and accepted the trademark risk.
No vendor was asked and no vendor permission was obtained: this applies most to
Anthropic (its guidelines want prior approval of the material), Google (Gemini
CLI) and Nous Research (Hermes). The page keeps its trademark footnote (en / ru /
uz). The ledger row is BR-L-202 (info, accepted).

**Taking the marks down is a one-line flip.** In
`command-center/lib/dev/brand-logos.ts` set

```ts
export const ANTHROPIC_MARKS_APPROVED = false;
```

(`OWNER_ACCEPTED_MARKS_SHOWN` follows it). Every *owner-accepted* entry then
returns to its plain neutral icon and drops out of the sprite; *official* marks
stay. A test covers both states. To remove one vendor only, delete that entry's
`symbols`.

## Light and dark

A mark that comes in a version for a light page and one for a dark page (Cursor,
Windsurf, Zed, Warp, Cline, OpenAI) is shown in both and the theme picks one in
CSS (`[data-theme]`, then `prefers-color-scheme`). A mark that exists in one
drawing (VS Code, OpenClaw, Roo Code, the Claude marks, Gemini CLI, Hermes) is shown as it is: VS Code and
OpenClaw are coloured and read on both themes; Roo Code's single black drawing
sits on a light tile in both.

## Risks the owner should know

- **Anthropic, Google, Nous Research**: shown without permission (above). The
  worst case is a request to take the mark down; the gate flip does it at once.
- **VS Code** forbids using the icon "as a lock-up for Visual Studio Code" (icon
  and name drawn as one logo). The tab pill is a UI control with a label next to
  a tile, not a lock-up, but it is the nearest of our uses to that line.
- **OpenClaw** and **Roo Code** publish no brand policy; their marks are used on
  the basis of their open-source repositories. If either asks us to stop, remove
  its entry's `symbols` (the plain icon returns).
- **Codex** shares the OpenAI Blossom with ChatGPT because OpenAI's kit has no
  separate Codex mark.
- A vendor can change its rules; the "fetched" dates are the day each page was read.

## Updating

Add or replace a vendor's files under `command-center/brand/third-party/`, add the
file to `FILES` in `tools/brand/build_brand_logos.mjs`, run it, and edit
`lib/dev/brand-logos.ts` (source, rules, what is allowed, date). `tests/brand-logos.test.tsx`
fails until the register, the drawings and the page agree.

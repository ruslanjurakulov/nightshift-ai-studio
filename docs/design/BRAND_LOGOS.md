# Third-party logos on /mcp

The `/mcp` page names the assistants Nightshift connects to and shows each one's
logo, the way "works with" pages do. Those names and marks belong to their
owners, who each have their own rules. This file is the register behind the code
(`command-center/lib/dev/brand-logos.ts`, the machine-readable twin; a test keeps
it complete). Read on **2026-10-03**.

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
- Where the owner's rules do not let us, or no official vector can be verified,
  the client keeps a plain neutral icon (listed below with the reason).

| Client | Mark | Status | Asset source | Rules | What they allow |
| :-- | :-- | :-- | :-- | :-- | :-- |
| ChatGPT | OpenAI Blossom, black / white | **shown** | `cdn.openai.com/brand/openai-logos.zip` ("Download logos" on openai.com/brand) | openai.com/brand usage terms | Only where it relates to OpenAI services, exactly as provided, no added colours or effects, open space, not more prominent than our marks, no implied endorsement. Permission requests: partnercomms@openai.com |
| OpenClaw | lobster (favicon) | **shown** | `openclaw.ai/favicon.svg` = `ui/public/favicon.svg` in github.com/openclaw/openclaw | repo LICENSE: MIT, © OpenClaw Foundation | No brand or trademark policy found (openclaw.ai, openclaw.org, repo). Used unmodified in its own colours; follow the Foundation's policy if one appears |
| Cursor | cube, 2D light / dark | **shown** | cursor.com/brand → `cursor-brand-assets.zip` → General Logos / Cube | cursor.com/brand | Official assets "to represent Cursor consistently and accurately"; call it "Cursor", not "Cursor AI" or "Cursor Code" |
| VS Code | blue "stable" icon | **shown** | code.visualstudio.com/assets/branding/visual-studio-code-icons.zip | code.visualstudio.com/brand | OK in documentation/tutorials/blog posts and to link to code.visualstudio.com. Not OK: promoting your own product, implying Microsoft association, a lock-up with the name, modifying it. Blue icon everywhere; white only when contrast is missing |
| Windsurf | symbol, black / white | **shown** | windsurf.com/brand → `exafunction.github.io/public/brand/windsurf-{black,white}-symbol.svg` | windsurf.com/brand | Symbol for space-limited layouts and logo grids; no outline, effects, rotation, reversal, gradients or colour; enough contrast; locked aspect ratio; prescribed spacing |
| Cline | bot icon, light / dark | **shown** | cline.bot/brand → `cline-brand-assets.zip` → General Logos / Bot | cline.bot/brand (zip README: LIGHT/DARK name the intended background) | Official downloadable brand asset; no further conditions on the page |
| Zed | logomark, black / white | **shown** | zed.dev/brand (logomark "Copy SVG") | zed.dev/brand | Brand blue, full white or full black only; no other colour, no distortion |
| Roo Code | extension icon | **shown** (on a light tile in both themes: single black drawing) | `src/assets/icons/icon.svg` in github.com/RooCodeInc/Roo-Code | repo LICENSE: Apache-2.0 | No brand or trademark policy found; used unmodified |
| Warp | glyph, black / white | **shown** | warp.dev/press → Logos → Google Drive "Warp Logos" / Glyph | warp.dev/press | "Logos ... you are free to use in all publications" |
| Claude | Claude icon | **awaiting approval** (a plain icon until then) | anthropic.com/press-kit (ClaudeIcon-Rounded.svg) | anthropic.com/legal/trademark-guidelines | Marks only as Anthropic permits and **only in materials it approves beforehand**; no alterations; no implied endorsement. Request: marketing@anthropic.com. To switch on once approved: set `ANTHROPIC_MARKS_APPROVED = true` in `lib/dev/brand-logos.ts` |
| Claude Desktop | Claude icon | **awaiting approval** | as Claude | as Claude | as Claude |
| Claude Code | — | plain icon | anthropic.com/press-kit | as Claude | Needs the same approval, and the only Claude Code mark is a 7:1 wordmark lockup that cannot sit in a square tile unchanged |
| Hermes | — | plain icon | hermes-agent.nousresearch.com, github.com/NousResearch/hermes-agent (MIT) | none published | No brand page and no official vector mark (only a 48 px favicon and a 1.9 MB marketing badge) |
| Gemini CLI | — | plain icon | Google Brand Resource Center | partnermarketinghub.withgoogle.com/brands/google | Resources are released only after an application; no public official asset |
| Codex | — | plain icon | cdn.openai.com/brand/openai-logos.zip | openai.com/brand | The kit has no Codex mark; the Blossom is already the ChatGPT tab's and one mark must not stand for two products |
| Other | plug glyph (icon set the site already uses) | n/a | — | — | Not a product |

## Light and dark

A mark that comes in a version for a light page and one for a dark page (Cursor,
Windsurf, Zed, Warp, Cline, OpenAI) is shown in both and the theme picks one in
CSS (`[data-theme]`, then `prefers-color-scheme`). A mark that exists in one
drawing (VS Code, OpenClaw, Roo Code, Claude) is shown as it is: VS Code and
OpenClaw are coloured and read on both themes; Roo Code's single black drawing
sits on a light tile in both.

## Risks the owner should know

- **VS Code** forbids using the icon "as a lock-up for Visual Studio Code" (icon
  and name drawn as one logo). The tab pill is a UI control with a label next to
  a tile, not a lock-up, but it is the nearest of our uses to that line.
- **OpenClaw** and **Roo Code** publish no brand policy; their marks are used on
  the basis of their open-source repositories. If either asks us to stop, remove
  its entry's `symbols` (the plain icon returns).
- **Anthropic** requires approval first: nothing of theirs is shown yet.
- A vendor can change its rules; the "fetched" dates are the day each page was read.

## Updating

Add or replace a vendor's files under `command-center/brand/third-party/`, add the
file to `FILES` in `tools/brand/build_brand_logos.mjs`, run it, and edit
`lib/dev/brand-logos.ts` (source, rules, what is allowed, date). `tests/brand-logos.test.tsx`
fails until the register, the drawings and the page agree.

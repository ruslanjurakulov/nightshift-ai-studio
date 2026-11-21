# /mcp landing: analysis of the six reference tabs

Measured on 2026-10-03 with Playwright (Chromium) at 390 and 1280 px, on the six public tab pages of the reference
site (claude, chatgpt, claude-code, openclaw, cursor, hermes), and checked against the owner's phone screenshots.
Only proportions and computed values were taken. No text, image or logo was copied.

This file records what PR #395 was built from. The built page differs from the reference on purpose (see "What we do
instead").

## Section order (identical on all six tabs)

1. Hero and install card (black band)
2. How it works
3. Ready-to-run briefs
4. "Everything you'd open ... for": five capability rows
5. Models: a carousel plus a three-row logo marquee
6. Results carousel
7. FAQ (8 items)
8. Explore pills
9. Closing headline and button, footer

Only the install steps and the client name differ between tabs. The name appears in the How-it-works lead, in the chat
header (logo and name) and in the "Create with ... in {client}" heading.

## Measured values (390 / 1280)

| Part | Value |
|---|---|
| h1 | 36/41.4 and 48/55.2, weight 450 |
| Section h2 | 30/36 and 48/48, weight 500 |
| Capability h3 | 24/32 and 30/36 |
| Closing h2 | 40/42 and 56/58.8 |
| Paragraph | 16/28 (h2 lead), 16/24 (rows) |
| Section padding | 80 and 96 (models 64/80, closing 144 on desktop) |
| Column | 1280 max, side padding 24/40 |
| Rows | 64/96 apart; two columns of 560 with an 80 gap on desktop |
| Label pill | padding 12/16, 28 high |
| Black button | 40 high in rows, 42/56 in the closing |
| Demo card | white, 1px #e5e5e5, radius 14, padding 16/24, gap 20 |
| Prompt bubble | #f5f5f5, radius 16, padding 12/16; thumbnails 40 px |
| Reply row | 28 px logo tile, 14/20 name |
| Model cards | 312x195 and 448x280, gap 16, scroll-snap x mandatory, 12 cards |
| Marquee pills | 48/56 high, three rows, translateX keyframe, 90 s linear, duplicated content, rows offset |
| Results cards | about 250x313, radius 16, round 40 px arrows |
| FAQ rows | 56/64 high, radius 8 |
| Motion | chat bubbles animate in over 450 ms (translateY 10), typing 1 s, shimmer 1.6 s, no autoplay on the carousel |

## Could not be reached

- Interactive states (FAQ open, hover)
- The accessible names of the carousel buttons
- The reference site's source CSS (only computed values were read)
- The plugin and settings link targets
- Anything behind its sign-in

Chromium needed the proxy CA, so pages were fetched through Playwright's request layer with the CA bundle. No
certificate check was switched off.

## What we do instead

- Drawn illustration frames (CSS and inline SVG), captioned "Illustration, not a real result" in en/ru/uz, instead of
  photographic results.
- No model carousel: it would promise models we do not name.
- Text "ask it like this" cards instead of image briefs.
- Six sections of our own about real tools (video, channels, language and voice, approval, credits and limits, a list
  of topics in one ask). Nightshift has no upscale or trained-styles feature.
- Marquee: two rows moving the same way at the same speed with different clients in each (the reference has three),
  a visible Pause/Play button (WCAG 2.2.2), still pills when motion is reduced.
- While the sign-in (MCP_OAUTH_LIVE) is off, the page promises only API keys; Claude and ChatGPT are shown as
  "coming soon".

## Per-tab matrix (ours, 16 tabs)

Install steps and snippet per tab are the existing, doc-verified ones (sign-in steps when MCP_OAUTH_LIVE is on, API-key
steps otherwise):

| Tab | Snippet |
|---|---|
| Claude | URL + Settings, Connectors |
| ChatGPT | developer-mode app |
| Claude Code | bash |
| OpenClaw | bash + JSON |
| Cursor | json |
| Hermes | yaml |
| VS Code, Windsurf, Cline, Zed | json |
| Gemini CLI | bash |
| Codex | toml |
| Roo Code, Warp | json |
| Claude Desktop | json via mcp-remote |
| Other | text |

The landing under the card is identical across tabs except for the assistant's name.

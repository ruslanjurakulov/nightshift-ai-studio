/**
 * The third-party logos on /mcp, and what lets us show each one.
 *
 * A "works with" page names the assistants it connects to, and the owners of
 * those names have their own rules for their marks. This file is the register:
 * for every client on the page, the vendor's official asset (kept unmodified
 * under brand/third-party/, turned into inline SVG by
 * tools/brand/build_brand_logos.mjs), where it came from, the page that states
 * the rules, and what those rules allow. docs/design/BRAND_LOGOS.md is the same
 * register in prose. Fetched 2026-10-03.
 *
 * A mark is shown only when its status is "official". Where an owner's own
 * guideline does not let us, or no official vector can be verified, the client
 * keeps a plain neutral icon and the reason is written here: we never
 * redraw a logo, and never pull one from a site that is not its owner's.
 *
 * Everything on the page carries the same footnote (dev.mcp.trademarks): names
 * and logos are their owners' trademarks, shown only to indicate compatibility,
 * and Nightshift is not affiliated with or endorsed by them.
 *
 * The marks are inline SVG, no request to any other origin: the CSP's img-src
 * and font-src are untouched.
 */

export type BrandStatus =
  /** The owner publishes the asset and its rules allow this use: shown. */
  | "official"
  /** The owner's rules require its approval first: assets are ready, not shown until BRAND_APPROVED flips. */
  | "awaiting-approval"
  /** No verifiable official asset, or the owner's rules do not allow it: the neutral icon stays. */
  | "fallback";

export type BrandLogo = {
  /** The client's id on /mcp (lib/dev/mcp-clients.ts). */
  id: string;
  vendor: string;
  status: BrandStatus;
  /** The sprite symbols (brand-logos-art.ts): a mark for a light page and one for a dark page, or one for both. */
  symbols?: { light: string; dark: string } | { any: string };
  /** The surface the mark needs: the page's own neutral tile, or a light "paper" tile on both themes. */
  tile: "theme" | "paper";
  /** The vendor's own page that offers or links the asset. */
  source: string;
  /** The page that states the rules for using the mark. */
  guidelines: string;
  /** What those rules allow, in a sentence, as read on the fetch date. */
  allowed: string;
  /** Why a plain icon stays (fallback and awaiting-approval only). */
  reason?: string;
  fetched: "2026-10-03";
};

/**
 * Anthropic's trademark guidelines say its marks may be used "only in materials
 * we approve beforehand" (https://www.anthropic.com/legal/trademark-guidelines;
 * requests: marketing@anthropic.com). Until that approval is in hand the
 * Claude, Claude Code and Claude Desktop tabs keep a plain icon. Flip this to
 * true the day it is, and the Claude icon appears on Claude and Claude Desktop
 * (Claude Code has only a seven-to-one wordmark, which does not fit a tile).
 */
export const ANTHROPIC_MARKS_APPROVED = false;

const FETCHED = "2026-10-03" as const;

export const BRAND_LOGOS: readonly BrandLogo[] = [
  {
    id: "claude",
    vendor: "Anthropic",
    status: "awaiting-approval",
    symbols: { any: "claude-any" },
    tile: "theme",
    source: "https://www.anthropic.com/press-kit (zip: Claude logos / Claude icon / ClaudeIcon-Rounded.svg)",
    guidelines: "https://www.anthropic.com/legal/trademark-guidelines",
    allowed:
      "Marks may be used only as Anthropic permits and only in materials it approves beforehand; no alterations; no implied sponsorship or endorsement; reasonable space around the mark; no trademark symbol.",
    reason: "Anthropic's guidelines require its approval of the material first. Request: marketing@anthropic.com.",
    fetched: FETCHED,
  },
  {
    id: "chatgpt",
    vendor: "OpenAI",
    status: "official",
    symbols: { light: "openai-light", dark: "openai-dark" },
    tile: "theme",
    source: "https://cdn.openai.com/brand/openai-logos.zip (linked as \"Download logos\" on https://openai.com/brand/): OpenAI Blossom, black and white",
    guidelines: "https://openai.com/brand/ (usage terms)",
    allowed:
      "Use the logo only where it relates to OpenAI services, exactly as provided, no added colours or effects, with open space around it; do not feature it more prominently than our own marks; do not imply endorsement or confuse users about sponsorship. Black and white versions are provided. Permission requests: partnercomms@openai.com.",
    fetched: FETCHED,
  },
  {
    id: "claude-code",
    vendor: "Anthropic",
    status: "fallback",
    tile: "theme",
    source: "https://www.anthropic.com/press-kit (Claude Code logo)",
    guidelines: "https://www.anthropic.com/legal/trademark-guidelines",
    allowed: "As for Claude: only with Anthropic's prior approval of the material.",
    reason:
      "Needs Anthropic's approval like the other Anthropic marks, and the only Claude Code mark in the press kit is a seven-to-one wordmark lockup that cannot sit in a square tile unchanged.",
    fetched: FETCHED,
  },
  {
    id: "openclaw",
    vendor: "OpenClaw Foundation",
    status: "official",
    symbols: { any: "openclaw-any" },
    tile: "theme",
    source: "https://openclaw.ai/favicon.svg (the lobster; the same drawing as ui/public/favicon.svg in https://github.com/openclaw/openclaw)",
    guidelines: "https://github.com/openclaw/openclaw/blob/main/LICENSE (MIT, © OpenClaw Foundation); no separate brand or trademark page was found at openclaw.ai, openclaw.org or in the repository",
    allowed:
      "The project is MIT licensed and publishes no brand restrictions that we could find. The mark is the project's own static lobster, unmodified, in its own colours. If the Foundation publishes a brand policy, follow it.",
    fetched: FETCHED,
  },
  {
    id: "cursor",
    vendor: "Anysphere (Cursor)",
    status: "official",
    symbols: { light: "cursor-light", dark: "cursor-dark" },
    tile: "theme",
    source: "https://cursor.com/brand → \"Download brand assets\" (cursor-brand-assets.zip): General Logos / Cube / CUBE_2D_LIGHT.svg and CUBE_2D_DARK.svg",
    guidelines: "https://cursor.com/brand",
    allowed:
      "Cursor publishes the 2D cube mark in light and dark variants \"to represent Cursor consistently and accurately\" and asks only that we call it Cursor (not \"Cursor AI\" or \"Cursor Code\").",
    fetched: FETCHED,
  },
  {
    id: "hermes",
    vendor: "Nous Research",
    status: "fallback",
    tile: "theme",
    source: "https://hermes-agent.nousresearch.com/ and https://github.com/NousResearch/hermes-agent",
    guidelines: "https://github.com/NousResearch/hermes-agent/blob/main/LICENSE (MIT); no brand page found",
    allowed: "No brand guideline published.",
    reason:
      "No brand page and no official vector mark: the only assets are a 48 px favicon and a 1.9 MB marketing badge, neither a logo we can use unmodified at tile size.",
    fetched: FETCHED,
  },
  {
    id: "vscode",
    vendor: "Microsoft",
    status: "official",
    symbols: { any: "vscode-any" },
    tile: "theme",
    source: "https://code.visualstudio.com/assets/branding/visual-studio-code-icons.zip (linked from https://code.visualstudio.com/brand): vscode.svg, the blue \"stable\" icon",
    guidelines: "https://code.visualstudio.com/brand",
    allowed:
      "OK: using the icon in documentation or a tutorial, a blog post or news article, and to link to code.visualstudio.com. Not OK: to promote your own product, to imply a Microsoft association, merchandise, building it into your logo, a lock-up with the name, or modifying it. Use the blue icon everywhere; the white one only when contrast is missing. Clear space of a quarter of the \"fish\" motif.",
    fetched: FETCHED,
  },
  {
    id: "windsurf",
    vendor: "Windsurf",
    status: "official",
    symbols: { light: "windsurf-light", dark: "windsurf-dark" },
    tile: "theme",
    source: "https://windsurf.com/brand → \"Download Brand Assets\": https://exafunction.github.io/public/brand/windsurf-black-symbol.svg and windsurf-white-symbol.svg",
    guidelines: "https://windsurf.com/brand",
    allowed:
      "The symbol is for space-limited layouts and logo grids. Do not outline it, apply effects, rotate or reverse it, use it without sufficient contrast, apply gradients or colour, or scale it without a locked aspect ratio; keep the prescribed spacing. Black and white versions are provided. Anything else: contact them with a mockup.",
    fetched: FETCHED,
  },
  {
    id: "cline",
    vendor: "Cline Bot Inc.",
    status: "official",
    symbols: { light: "cline-light", dark: "cline-dark" },
    tile: "theme",
    source: "https://cline.bot/brand → cline-brand-assets.zip (https://cline.bot/assets/branding/brand/cline-brand-assets.zip): General Logos / Bot / SVG / BOT_LIGHT.svg and BOT_DARK.svg",
    guidelines: "https://cline.bot/brand (README.txt in the zip: LIGHT and DARK name the intended background)",
    allowed:
      "Cline publishes the bot icon for download as its official brand asset in light and dark variants for the matching background; the page sets no further conditions.",
    fetched: FETCHED,
  },
  {
    id: "zed",
    vendor: "Zed Industries",
    status: "official",
    symbols: { light: "zed-light", dark: "zed-dark" },
    tile: "theme",
    source: "https://zed.dev/brand (logomark, \"Copy SVG\"; the SVG text is in that page's own script): pure black and pure white",
    guidelines: "https://zed.dev/brand",
    allowed:
      "The logo can be used in brand blue, full white or full black; do not render it in any other colour or with distorted sizes or dimensions. The editor is called \"Zed\", the company \"Zed Industries\".",
    fetched: FETCHED,
  },
  {
    id: "gemini-cli",
    vendor: "Google",
    status: "fallback",
    tile: "theme",
    source: "https://partnermarketinghub.withgoogle.com/brands/google/overview/ (Google Brand Resource Center)",
    guidelines: "https://partnermarketinghub.withgoogle.com/brands/google/overview/",
    allowed: "Brand resources are released only after an application.",
    reason: "The Gemini mark is available only through Google's Brand Resource Center, which asks for an application first; no public official asset.",
    fetched: FETCHED,
  },
  {
    id: "codex",
    vendor: "OpenAI",
    status: "fallback",
    tile: "theme",
    source: "https://cdn.openai.com/brand/openai-logos.zip",
    guidelines: "https://openai.com/brand/",
    allowed: "The kit holds the OpenAI wordmark and the Blossom only.",
    reason: "OpenAI's logo kit has no Codex mark; the Blossom is already the ChatGPT tab's, and one mark must not stand for two products.",
    fetched: FETCHED,
  },
  {
    id: "roo-code",
    vendor: "Roo Code",
    status: "official",
    symbols: { any: "roo-any" },
    tile: "paper",
    source: "https://github.com/RooCodeInc/Roo-Code/blob/main/src/assets/icons/icon.svg (the extension's own icon)",
    guidelines: "https://github.com/RooCodeInc/Roo-Code/blob/main/LICENSE (Apache-2.0); no brand page or trademark policy was found",
    allowed:
      "The repository is Apache-2.0 and publishes no brand restrictions that we could find. The icon is single-colour black, so it sits on a light tile in both themes, unmodified.",
    fetched: FETCHED,
  },
  {
    id: "warp",
    vendor: "Warp",
    status: "official",
    symbols: { light: "warp-light", dark: "warp-dark" },
    tile: "theme",
    source: "https://www.warp.dev/press → \"Download\" under Logos (Google Drive folder \"Warp Logos\" → Glyph): Warp-Glyph-Black.svg and Warp-Glyph-White.svg",
    guidelines: "https://www.warp.dev/press (\"logos, press images, and product images you are free to use in all publications\")",
    allowed: "Warp offers its glyph in black and white for use in all publications.",
    fetched: FETCHED,
  },
  {
    id: "claude-desktop",
    vendor: "Anthropic",
    status: "awaiting-approval",
    symbols: { any: "claude-any" },
    tile: "theme",
    source: "https://www.anthropic.com/press-kit (Claude icon)",
    guidelines: "https://www.anthropic.com/legal/trademark-guidelines",
    allowed: "As for Claude: only with Anthropic's prior approval of the material.",
    reason: "Anthropic's guidelines require its approval of the material first. Request: marketing@anthropic.com.",
    fetched: FETCHED,
  },
  {
    id: "other",
    vendor: "—",
    status: "fallback",
    tile: "theme",
    source: "—",
    guidelines: "—",
    allowed: "Not a product: a plug glyph from the icon set the site already uses.",
    reason: "\"Other\" is any client; it has no mark.",
    fetched: FETCHED,
  },
];

/** The entry for a client id. */
export function brandLogo(id: string): BrandLogo | undefined {
  return BRAND_LOGOS.find((b) => b.id === id);
}

/** Is this client's real mark shown? Official, or awaiting-approval with the approval flipped on. */
export function logoShown(entry: BrandLogo | undefined): entry is BrandLogo & { symbols: NonNullable<BrandLogo["symbols"]> } {
  if (!entry?.symbols) return false;
  if (entry.status === "official") return true;
  return entry.status === "awaiting-approval" && entry.vendor === "Anthropic" && ANTHROPIC_MARKS_APPROVED;
}

/** The sprite symbol ids a page needs for the logos that are shown. */
export function shownSymbols(ids: readonly string[]): string[] {
  const out = new Set<string>();
  for (const id of ids) {
    const e = brandLogo(id);
    if (!logoShown(e)) continue;
    const s = e.symbols;
    if ("any" in s) out.add(s.any);
    else {
      out.add(s.light);
      out.add(s.dark);
    }
  }
  return [...out];
}

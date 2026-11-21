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
  /**
   * The vendor's own asset, unmodified, shown WITHOUT the vendor's permission (its rules require approval first,
   * or publish nothing either way): the site owner accepted the trademark risk on 2026-10-03. Shown while
   * OWNER_ACCEPTED_MARKS_SHOWN is true; flipping that one constant puts the plain icons back.
   */
  | "owner-accepted"
  /** No vendor asset exists: a plain neutral icon. */
  | "fallback";

export type BrandLogo = {
  /** The client's id on /mcp (lib/dev/mcp-clients.ts). */
  id: string;
  vendor: string;
  status: BrandStatus;
  /** The sprite symbols (brand-logos-art.ts): a mark for a light page and one for a dark page, or one for both. */
  symbols?: { light: string; dark: string } | { any: string };
  /**
   * The surface the mark needs: the page's own neutral tile, a light "paper" tile on both themes, or none ("bare":
   * the mark is itself a finished tile with its own background and corners, and is shown at the tile's size;
   * "plain": a loose glyph with no tile at all, in the pill's text colour or its own colour).
   */
  tile: "theme" | "paper" | "bare" | "plain";
  /**
   * A different mark for the hero tile row (the tab pill uses `symbols`/`tile`): used where the tab shows a
   * one-colour or small mark and the hero tile is better as the vendor's finished icon.
   */
  hero?: { symbols: { light: string; dark: string } | { any: string }; tile: "theme" | "paper" | "bare" | "plain" };
  /** The vendor's own page that offers or links the asset. */
  source: string;
  /** The page that states the rules for using the mark. */
  guidelines: string;
  /** What those rules allow, in a sentence, as read on the fetch date. */
  allowed: string;
  /** Why a mark is shown without the vendor's permission, or why a plain icon stays. */
  reason?: string;
  fetched: "2026-10-03";
};

/**
 * THE GATE. On 2026-10-03 the site's owner decided to show every client's own logo and accepted the
 * trademark risk himself ("nobody cares about my small site"). No vendor was asked and none gave
 * permission. This constant covers every mark whose status is "owner-accepted": Anthropic's Claude marks
 * (its guidelines, https://www.anthropic.com/legal/trademark-guidelines, allow use "only in materials we
 * approve beforehand"; requests go to marketing@anthropic.com). (It also covered the Gemini CLI and Hermes
 * icons until those clients left the page.)
 *
 * Since 2026-11-13 the page names six clients only (lib/dev/mcp-clients.ts), so the register has six
 * entries. The vendor files of the clients it dropped stay in brand/third-party and in the generated sprite
 * sheet (brand-logos-art.ts, whose byte-for-byte tests read them); they are never drawn, because the page's
 * sprite holds only the symbols of its own ids (shownSymbols).
 *
 * To take them all down: set it to false. The tabs and tiles fall back to the plain icons, with no other
 * change. The name is the original one; it now means "the owner accepted it".
 */
export const ANTHROPIC_MARKS_APPROVED = true;
/** The same gate under a name that says what it does. */
export const OWNER_ACCEPTED_MARKS_SHOWN = ANTHROPIC_MARKS_APPROVED;

const FETCHED = "2026-10-03" as const;

export const BRAND_LOGOS: readonly BrandLogo[] = [
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
    id: "claude",
    vendor: "Anthropic",
    status: "owner-accepted",
    symbols: { any: "claude-spark-mono" },
    tile: "plain",
    hero: { symbols: { any: "claude-any" }, tile: "bare" },
    source: "https://www.anthropic.com/press-kit (zip: Claude logos / Claude Spark / Claude Spark - Clay.svg for the tab, in one colour; Claude icon / ClaudeIcon-Rounded.svg for the hero tile)",
    guidelines: "https://www.anthropic.com/legal/trademark-guidelines",
    allowed:
      "Marks may be used only as Anthropic permits and only in materials it approves beforehand; no alterations; no implied sponsorship or endorsement; reasonable space around the mark; no trademark symbol.",
    reason:
      "Shown without Anthropic's approval: the site owner accepted the risk on 2026-10-03 (no vendor permission obtained). The tab shows the press kit's Claude Spark as a loose glyph in the pill's text colour (the one-colour variant: the same shape, only the fill is the text colour); the hero tile shows the press-kit app icon, unmodified, at the tile's size.",
    fetched: FETCHED,
  },
  {
    id: "gemini",
    vendor: "Google",
    status: "fallback",
    tile: "theme",
    source: "https://support.google.com/gemini/answer/17209137 (the connect steps; no asset was taken)",
    guidelines: "https://partnermarketinghub.withgoogle.com/brands/google (Google releases brand assets only on application)",
    allowed: "Nothing is assumed: the tab carries only the product's name and a plain icon.",
    reason:
      "Added on 2026-11-13. Google releases its marks only after an application, none was made, and the Gemini CLI icon the page once showed is not the Gemini app's mark, so the tab keeps the site's own chat icon.",
    fetched: FETCHED,
  },
  {
    id: "grok",
    vendor: "xAI",
    status: "fallback",
    tile: "theme",
    source: "https://docs.x.ai/grok/connectors (the connect steps; no asset was taken)",
    guidelines: "https://docs.x.ai (no brand or trademark page was read for this change)",
    allowed: "Nothing is assumed: the tab carries only the product's name and a plain icon.",
    reason: "Added on 2026-11-13. No official vector or brand rules were verified for it, so the tab keeps the site's own chat icon rather than a borrowed mark.",
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
];

/** The entry for a client id. */
export function brandLogo(id: string): BrandLogo | undefined {
  return BRAND_LOGOS.find((b) => b.id === id);
}

/** Is this client's real mark shown? Official, or owner-accepted while the gate is on. */
export function logoShown(
  entry: BrandLogo | undefined,
  /** The gate; a parameter so a test can show what the page does with it off. */
  gate: boolean = OWNER_ACCEPTED_MARKS_SHOWN,
): entry is BrandLogo & { symbols: NonNullable<BrandLogo["symbols"]> } {
  if (!entry?.symbols) return false;
  if (entry.status === "official") return true;
  return entry.status === "owner-accepted" && gate;
}

/** The sprite symbol ids a page needs for the logos that are shown. */
export function shownSymbols(ids: readonly string[]): string[] {
  const out = new Set<string>();
  for (const id of ids) {
    const e = brandLogo(id);
    if (!logoShown(e)) continue;
    for (const s of [e.symbols, e.hero?.symbols]) {
      if (!s) continue;
      if ("any" in s) out.add(s.any);
      else {
        out.add(s.light);
        out.add(s.dark);
      }
    }
  }
  return [...out];
}

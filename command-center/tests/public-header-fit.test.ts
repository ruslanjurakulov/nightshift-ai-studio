import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// The public header's structural contract (tools/visual-qa/public-header.mjs measures the real thing in a browser;
// this keeps the decision itself from being undone by an edit that looks harmless):
//  - the links, Sign in and the key never wrap or shrink;
//  - the full bar replaces the menu button at one breakpoint per language, and the menu button hides at exactly the
//    widths the bar appears (so there is never a width with neither, or with both);
//  - the longer the language's labels, the later the bar appears: en <= uz <= ru.

const root = process.cwd();
const css = readFileSync(path.join(root, "components/site/site.css"), "utf8");
const menu = readFileSync(path.join(root, "components/legal/PublicMobileMenu.tsx"), "utf8");

/** The rule body for an exact selector (the first one), or null. */
function body(selector: string): string | null {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = new RegExp(`(?:^|\\})\\s*${esc}\\s*\\{([^}]*)\\}`, "m").exec(css);
  return m ? m[1] : null;
}

/** min-width of the media block that holds `needle`. */
function minWidthFor(needle: string): number | null {
  const at = css.indexOf(needle);
  if (at < 0) return null;
  const before = css.slice(0, at);
  const m = [...before.matchAll(/@media \(min-width: (\d+)px\) \{/g)].at(-1);
  return m ? Number(m[1]) : null;
}

describe("public header fit", () => {
  it("never wraps or shrinks the links and Sign in, and the key never wraps", () => {
    expect(body(".st-nav a")).toMatch(/white-space:\s*nowrap/);
    expect(body(".st-nav a")).toMatch(/flex:\s*none/);
    expect(body(".st-signin")).toMatch(/white-space:\s*nowrap/);
    expect(body(".st-signin")).toMatch(/flex:\s*none/);
    expect(body(".st-key")).toMatch(/white-space:\s*nowrap/);
  });

  it("keeps a 44px tap target on the links, Sign in and the key", () => {
    expect(body(".st-nav a")).toMatch(/min-height:\s*44px/);
    expect(body(".st-signin")).toMatch(/min-height:\s*44px/);
    expect(body('.st-key[data-size="sm"]')).toMatch(/min-height:\s*44px/);
  });

  it("shows the bar and hides the menu button at the same width, per language", () => {
    const barDefault = minWidthFor('html:not([lang="ru"], [lang="uz"]) :is(.st-nav, .st-header-desk) { display: flex; }');
    const menuDefault = minWidthFor('html:not([lang="ru"], [lang="uz"]) .st-menu-root { display: none; }');
    const barUz = minWidthFor('html[lang="uz"] :is(.st-nav, .st-header-desk) { display: flex; }');
    const menuUz = minWidthFor('html[lang="uz"] .st-menu-root { display: none; }');
    const barRu = minWidthFor('html[lang="ru"] :is(.st-nav, .st-header-desk) { display: flex; }');
    const menuRu = minWidthFor('html[lang="ru"] .st-menu-root { display: none; }');
    expect(barDefault).toBe(1024);
    expect(menuDefault).toBe(barDefault);
    expect(menuUz).toBe(barUz);
    expect(menuRu).toBe(barRu);
    // Russian has the longest labels, Uzbek next, English the shortest.
    expect(barUz!).toBeGreaterThanOrEqual(barDefault!);
    expect(barRu!).toBeGreaterThanOrEqual(barUz!);
  });

  it("hides the bar by default (the menu is what a narrow screen gets)", () => {
    expect(body(".st-nav")).toMatch(/display:\s*none/);
    expect(body(".st-header-desk")).toMatch(/display:\s*none/);
  });

  it("the menu root no longer follows Tailwind's lg, which would put both on screen from 1024px", () => {
    expect(menu).toContain('className="st-menu-root"');
    expect(menu).not.toMatch(/className="lg:hidden"/);
  });

  it("the footer's six columns start at 1024px, not 900px (Russian's legal links need the room)", () => {
    expect(minWidthFor("grid-template-columns: minmax(0, 1.2fr) repeat(5, minmax(0, 1fr))")).toBe(1024);
  });
});

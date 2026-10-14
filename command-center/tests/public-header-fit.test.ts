import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// The public header's structural contract (tools/visual-qa/public-header.mjs measures the real thing in a browser;
// this keeps the decision itself from being undone by an edit that looks harmless):
//  - there is no menu on the public pages: no component, no st-menu rules; the links, language, theme and Sign in are
//    always visible;
//  - the links, Sign in and the key never wrap or shrink;
//  - below 1024px the wordmark and Start free are the first row and the rest (links, language, theme, Sign in) wrap onto
//    the rows under it; from 1024px they are one row. The links are the one part allowed to shrink, so nothing names a
//    width or a language and a new language cannot push Start free or Sign in off the page.

const root = process.cwd();
const css = readFileSync(path.join(root, "components/site/site.css"), "utf8");

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

  it("has no menu: no component, no menu rules, no language-named header layout", () => {
    expect(existsSync(path.join(root, "components/legal/PublicMobileMenu.tsx"))).toBe(false);
    expect(css).not.toMatch(/\.st-menu/);
    expect(css).not.toContain("st-menu-root");
    expect(css).not.toMatch(/html:not\(\[lang/);
    expect(css).not.toMatch(/html\[lang="[a-z]+"\] \.st-(nav|header-desk|header-row|header-sub)/);
  });

  it("wraps the rows under the wordmark and Start free below 1024px and joins them above, with the links as the one shrinkable part", () => {
    expect(body(".st-header-row")).toMatch(/flex-wrap:\s*wrap/);
    expect(css).toMatch(/@media \(min-width: 1024px\) \{ \.st-header-row \{ flex-wrap: nowrap; \} \}/);
    const sub = body(".st-header-sub") ?? "";
    expect(sub).toMatch(/flex:\s*1 0 100%/);
    expect(sub).toMatch(/flex-wrap:\s*wrap/);
    expect(css).toMatch(/\.st-header-sub \{ display: contents; \}/);
    const nav = body(".st-nav") ?? "";
    expect(nav).toMatch(/display:\s*flex/);
    expect(nav).toMatch(/flex:\s*0 1 auto/);
    expect(nav).toMatch(/flex-wrap:\s*wrap/);
    expect(nav).toMatch(/min-width:\s*0/);
    // The row grows with its content; it is not a fixed height.
    expect(body(".st-header-row")).toMatch(/min-height:\s*64px/);
    expect(body(".st-header-row")).not.toMatch(/[^-]height:\s*64px/);
  });

  it("sticks from 1024px only (two or three rows would take a quarter of a small phone), and the language list stays on the page", () => {
    expect(body(".st-header") ?? "").not.toMatch(/position:\s*sticky/);
    expect(css).toMatch(/@media \(min-width: 1024px\) \{ \.st-header \{ position: sticky; top: 0; \} \}/);
    expect(css).toMatch(/@media \(max-width: 1023px\) \{ \.st-header-desk ul\[role="listbox"\] \{ right: auto; left: 0; \} \}/);
  });

  it("the footer's six columns start at 1024px, not 900px (Russian's legal links need the room)", () => {
    expect(minWidthFor("grid-template-columns: minmax(0, 1.2fr) repeat(5, minmax(0, 1fr))")).toBe(1024);
  });
});

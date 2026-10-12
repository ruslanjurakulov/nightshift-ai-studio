import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// The public header's structural contract (tools/visual-qa/public-header.mjs measures the real thing in a browser;
// this keeps the decision itself from being undone by an edit that looks harmless):
//  - the links, Sign in and the key never wrap or shrink;
//  - no language or width is named: from 1024px the bar is shown for everyone, and when a language's labels do not fit one
//    row the links (the one part allowed to shrink) wrap onto a visible second line, so a new language cannot push
//    Start free or Sign in off the page;
//  - the existing menu keeps its original lg breakpoint.

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

  it("lets the links, and only the links, give way: they wrap onto a visible second line (no language or width is named)", () => {
    const at1024 = /@media \(min-width: 1024px\) \{\s*\.st-nav \{([^}]*)\}/.exec(css)?.[1] ?? "";
    expect(at1024).toMatch(/display:\s*flex/);
    expect(at1024).toMatch(/flex-wrap:\s*wrap/);
    expect(at1024).toMatch(/flex:\s*0 1 auto/);
    expect(at1024).toMatch(/min-width:\s*0/);
    expect(css).toMatch(/@media \(min-width: 1024px\) \{ \.st-header-desk \{ display: flex; \} \}/);
    // The row grows with the links; it is not a fixed height.
    expect(body(".st-header-row")).toMatch(/min-height:\s*64px/);
    expect(body(".st-header-row")).not.toMatch(/[^-]height:\s*64px/);
    // No per-language switch between the bar and the menu, no breakpoint named for a language's header.
    expect(css).not.toContain("st-menu-root");
    expect(css).not.toMatch(/html:not\(\[lang/);
    expect(css).not.toMatch(/html\[lang="[a-z]+"\] \.st-(nav|header-desk|header-row|menu)/);
  });

  it("hides the bar by default (the menu is what a narrow screen gets)", () => {
    expect(body(".st-nav")).toMatch(/display:\s*none/);
    expect(body(".st-header-desk")).toMatch(/display:\s*none/);
  });

  it("the menu keeps its original breakpoint (it is not widened for any language)", () => {
    expect(menu).toContain('className="lg:hidden"');
  });

  it("the footer's six columns start at 1024px, not 900px (Russian's legal links need the room)", () => {
    expect(minWidthFor("grid-template-columns: minmax(0, 1.2fr) repeat(5, minmax(0, 1fr))")).toBe(1024);
  });
});

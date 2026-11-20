/**
 * The Studio's top bar must stack above its rail (components/studio-canvas/studio-canvas.css).
 *
 * What broke (owner's report, 2026-11-20, /all-channels/studio at 1920 px): the project switcher's menu (.cv-pop, inside the bar)
 * opened under the rail, and its first ~50 px were hidden ("nvas", "neline", "deos"). Both the bar and the rail are sticky, so
 * each is its own stacking context; the menu's z-index only counts inside the bar. At equal z-index the later element in the
 * page wins, and in the owner's frame the rail comes after the bar (app/(app)/layout.tsx: {header}, then <SideNav operator />).
 *
 * Measured with the built CSS in Chromium before the fix: elementFromPoint at the menu's first item returned .cv-rail at 1440
 * and 1920 px, with or without html.ds-skin. These tests pin both halves of the cause, so a change to either fails here.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const css = readFileSync(path.join(root, "components/studio-canvas/studio-canvas.css"), "utf8");

/** The declarations of the first top-level rule whose selector is exactly `sel`. */
function rule(sel: string): Record<string, string> {
  const at = css.search(new RegExp(`(^|\\n)${sel.replace(/\./g, "\\.")}\\s*\\{`));
  expect(at, `${sel} rule`).toBeGreaterThanOrEqual(0);
  const body = css.slice(css.indexOf("{", at) + 1, css.indexOf("}", at));
  const out: Record<string, string> = {};
  for (const line of body.replace(/\/\*[\s\S]*?\*\//g, "").split(";")) {
    const [k, ...v] = line.split(":");
    if (k && v.length) out[k.trim()] = v.join(":").trim();
  }
  return out;
}

describe("the Studio bar's menu is never drawn under the rail", () => {
  it("the bar's z-index is above the rail's (both are sticky, so a tie goes to the rail)", () => {
    const bar = rule(".cv-appbar");
    const rail = rule(".cv-rail");
    expect(bar.position).toBe("sticky");
    expect(rail.position).toBe("sticky");
    expect(Number(bar["z-index"])).toBeGreaterThan(Number(rail["z-index"]));
  });

  it("the switcher's menu lives inside the bar (so the bar's z-index is the one that counts)", () => {
    const header = readFileSync(path.join(root, "components/Header.tsx"), "utf8");
    expect(header).toMatch(/<header className="cv-appbar"[^>]*>\s*<div id="studio-bar-slot"/);
    expect(rule(".cv-pop").position).toBe("absolute");
  });

  it("in the owner's frame the rail follows the bar in the page (why the tie was lost)", () => {
    const layout = readFileSync(path.join(root, "app/(app)/layout.tsx"), "utf8");
    const frame = layout.slice(layout.indexOf("{frame ? ("));
    expect(frame.indexOf("{header}")).toBeGreaterThan(-1);
    expect(frame.indexOf("<SideNav operator />")).toBeGreaterThan(frame.indexOf("{header}"));
  });
});

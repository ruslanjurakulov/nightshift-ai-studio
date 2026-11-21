/**
 * Two layout fixes from the demo-readiness pass (2026-11-21), measured in Chromium against the stand-in Supabase:
 * - the Studio rail cut its own names in Russian and Uzbek ("Медиатека", "Bosh sa…", "Mediate…") at 13 px on one line;
 * - on a phone, Home's "Waiting for you" row showed its second card cut off at the screen's edge.
 * These pin the rules that fixed them, so a later edit that brings either back fails here.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const read = (f: string) => readFileSync(path.join(process.cwd(), f), "utf8");
const block = (css: string, sel: string) => {
  const at = css.indexOf(`${sel} {`);
  expect(at, sel).toBeGreaterThanOrEqual(0);
  return css.slice(at, css.indexOf("}", at));
};

describe("the Studio rail names fit in every language", () => {
  const css = read("components/studio-canvas/studio-canvas.css");
  it("labels are 12 px and may take two lines; no ellipsis cuts a word", () => {
    const b = block(css, ".cv-rail-label");
    expect(b).toMatch(/font-size:\s*12px/);
    expect(b).toMatch(/-webkit-line-clamp:\s*2/);
    expect(b).not.toMatch(/white-space:\s*nowrap/);
    expect(b).not.toMatch(/text-overflow:\s*ellipsis/);
  });
  it("the rail and its links give their side padding to the label", () => {
    expect(block(css, ".cv-rail")).toMatch(/padding:\s*12px 4px/);
    expect(block(css, ".cv-rail a")).toMatch(/padding:\s*8px 0/);
  });
});

describe("Home's two waiting cards share a phone's width", () => {
  it("exactly two cards in a row get equal columns below 640 px", () => {
    const css = read("components/customer/customer.css");
    expect(css).toMatch(/@media \(max-width: 639px\) \{\s*\.hc-row:has\(> :last-child:nth-child\(2\)\) \{ grid-auto-columns: minmax\(0, 1fr\); \}/);
  });
});

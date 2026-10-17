/**
 * The danger key (.btn-danger) must be readable in both themes: it was red text
 * on the indigo call-to-action fill, 1.07:1 in light and 1.79:1 in dark. The
 * tokens are read from the stylesheet itself so a later edit cannot drift.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const css = readFileSync(join(__dirname, "..", "app/globals.css"), "utf8");

function luminance(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}
const token = (block: string, name: string) => block.match(new RegExp(`${name}:\\s*(#[0-9a-fA-F]{6})`))?.[1] ?? "";

// The three places the tokens live: light (:root), the OS-dark media block, and [data-theme="dark"].
const light = css.slice(css.indexOf(":root,\n:root[data-theme=\"light\"]"), css.indexOf("@media (prefers-color-scheme: dark)"));
const osDark = css.slice(css.indexOf("@media (prefers-color-scheme: dark)"), css.indexOf(':root[data-theme="dark"],'));
const dark = css.slice(css.indexOf(':root[data-theme="dark"],'), css.indexOf(':root[data-theme="dark"],') + 6000);

describe("danger key contrast", () => {
  it.each([
    ["light", light],
    ["OS dark", osDark],
    ["dark", dark],
  ])("%s: label on fill is at least 4.5:1", (_name, block) => {
    const bg = token(block, "--ns-danger-bg");
    const fg = token(block, "--ns-on-danger");
    expect(bg).not.toBe("");
    expect(fg).not.toBe("");
    expect(contrast(bg, fg)).toBeGreaterThanOrEqual(4.5);
  });

  it("the key is a fill with the on-danger label, not red text on the indigo CTA", () => {
    const rule = css.match(/\.btn-danger \{[^}]*\}/)?.[0] ?? "";
    expect(rule).toContain("background: var(--ns-danger-bg)");
    expect(rule).toContain("color: var(--ns-on-danger)");
    expect(rule).toContain("min-height: 2.75rem");
  });

  it("the old failure is what the test would catch", () => {
    expect(contrast("#ff6e5e", "#6558f5")).toBeLessThan(2);
    expect(contrast("#b9341f", "#4f46e5")).toBeLessThan(2);
  });

  it("toasts are lifted above the owner's tab bar on a phone", () => {
    expect(css).toMatch(/body:has\(\[data-operator-tabbar\]\) \.toast-viewport \{ bottom: calc\(env\(safe-area-inset-bottom\) \+ 4\.75rem\)/);
  });
});

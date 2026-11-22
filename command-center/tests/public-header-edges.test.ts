/**
 * The public bar's quiet controls (language, theme, view, the phone menu key) are told apart by their edge alone. Their shared
 * quiet border measured 1.37:1 on the dark ground (S5 Pixel, PR #889/#906); a control's boundary needs 3:1 (WCAG 1.4.11).
 * What would break: the header rule dropping back to the faint shared border, or the strong rule's value sinking under 3:1.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const site = readFileSync(path.join(root, "components/site/site.css"), "utf8");
const globals = readFileSync(path.join(root, "app/globals.css"), "utf8");

const lum = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a: string, b: string) => (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05);
const all = (name: string) => [...globals.matchAll(new RegExp(`${name}: (#[0-9a-f]{6});`, "g"))].map((m) => m[1]);

describe("the public bar's quiet controls have a 3:1 edge", () => {
  it("draws them with the strong rule, not the shared quiet border", () => {
    expect(site).toMatch(/\.st-header \.btn-sky\.is-quiet:not\(\.border-transparent\),\n\.st-menu-btn,\n\.st-menu-close \{ border-color: var\(--ns-rule-strong\); \}/);
  });

  it("keeps the strong rule at 3:1 or better on the ground and the console, in every theme block", () => {
    const strong = all("--ns-rule-strong");
    const ground = all("--ns-ground");
    const consoleBg = all("--ns-console");
    expect(strong.length).toBe(3);
    for (let i = 0; i < 3; i++) {
      expect(contrast(strong[i], ground[i]), `block ${i} ground`).toBeGreaterThanOrEqual(3);
      expect(contrast(strong[i], consoleBg[i]), `block ${i} console`).toBeGreaterThanOrEqual(3);
    }
  });
});

// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { parse, type Rule } from "postcss";
import { afterEach, describe, expect, it } from "vitest";

const css = parse(readFileSync("app/premium-shell.css", "utf8"));
const globals = readFileSync("app/globals.css", "utf8");
const rules: Rule[] = [];
css.walkRules((rule) => { rules.push(rule); });

function palette(mode: "light" | "dark"): Record<string, string> {
  const values: Record<string, string> = {};
  // Evaluate the declared base or explicit dark palette; system preference is verified separately below.
  for (const rule of rules) {
    if (rule.parent?.type === "atrule") continue;
    const dark = rule.selector.includes('[data-theme="dark"]');
    if (dark !== (mode === "dark") && dark) continue;
    rule.walkDecls((d) => { if (d.prop.startsWith("--premium-")) values[d.prop] = d.value; });
  }
  return values;
}
function luminance(hex: string): number {
  expect(hex, "Contrast inputs must remain explicit six-digit palette colors").toMatch(/^#[0-9a-f]{6}$/i);
  const rgb = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const [r, g, b] = rgb.map((x) => x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrast(a: string, b: string): number {
  const [lo, hi] = [luminance(a), luminance(b)].sort((x, y) => x - y);
  return (hi + 0.05) / (lo + 0.05);
}

afterEach(() => { document.body.innerHTML = ""; document.documentElement.removeAttribute("data-theme"); });

describe("D1 premium palette boundaries", () => {
  it("loads the signed-in override without replacing the global/public palette", () => {
    expect(globals).toContain('"./premium-shell.css"');
    document.body.innerHTML = '<main class="site"><div class="panel"><input><button class="btn-sky is-solid">Public CTA</button></div></main>';
    const publicElements = [document.documentElement, document.body, ...document.querySelectorAll(".site, .site *")];
    for (const rule of rules) {
      for (const element of publicElements) {
        expect(element.matches(rule.selector), `Public ${element.tagName} must not match ${rule.selector}`).toBe(false);
      }
    }
  });

  it("opts body portals into the same palette without retheming the public body", () => {
    document.body.innerHTML = '<div class="app-shell"><main></main></div><aside data-app-shell-portal></aside><aside id="public-popover"></aside>';
    const paletteRules = rules.filter((r) => r.nodes.some((n) => n.type === "decl" && n.prop === "--premium-ground"));
    expect(paletteRules.length).toBeGreaterThanOrEqual(2);
    for (const rule of paletteRules) {
      expect(rule.selector).toContain(".app-shell");
      expect(rule.selector).toContain("[data-app-shell-portal]");
      // Owned app pages may intentionally theme their body so existing body portals inherit.
      // The public-page test above proves this conditional selector does not leak onto public routes.
      if (!rule.selector.includes("body:has(.app-shell)")) expect(document.body.matches(rule.selector), rule.selector).toBe(false);
      expect(document.querySelector("#public-popover")!.matches(rule.selector)).toBe(false);
    }
  });

  for (const mode of ["light", "dark"] as const) {
    it(`${mode}: normal text, muted text and status text remain readable on every declared surface`, () => {
      const p = palette(mode);
      for (const fg of ["text", "dim", "accent-ink", "go", "caution", "fail", "info"]) {
        for (const bg of ["ground", "console", "key", "key-hi"]) {
          expect(contrast(p[`--premium-${fg}`], p[`--premium-${bg}`]), `${mode}: ${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5);
        }
      }
      expect(contrast(p["--premium-focus"], p["--premium-console"])).toBeGreaterThanOrEqual(3);
      expect(p["--premium-ground"]).not.toBe("#000000");
    });
  }

  it("honors an explicit light choice even when the system prefers dark", () => {
    const systemRules = rules.filter((r) => r.parent?.type === "atrule" && r.parent.name === "media" && r.parent.params.includes("prefers-color-scheme: dark"));
    expect(systemRules.length).toBeGreaterThan(0);
    document.documentElement.setAttribute("data-theme", "light");
    document.body.innerHTML = '<div class="app-shell"></div><div data-app-shell-portal></div>';
    for (const rule of systemRules) {
      for (const target of document.body.children) expect(target.matches(rule.selector)).toBe(false);
    }
  });

  it("keeps white primary-action labels readable at both gradient endpoints", () => {
    const primary = rules.find((r) => r.selector.endsWith(".btn-sky.is-solid"))!;
    const declarations = Object.fromEntries(primary.nodes.filter((n) => n.type === "decl").map((n) => [n.prop, n.value]));
    const stops = declarations.background.match(/#[0-9a-f]{6}/gi)!;
    expect(stops.length).toBeGreaterThanOrEqual(2);
    for (const stop of stops) expect(contrast(declarations.color, stop)).toBeGreaterThanOrEqual(4.5);
  });

  it("removes animated control transitions for reduced-motion readers", () => {
    const reduced = rules.filter((r) => r.parent?.type === "atrule" && r.parent.name === "media" && r.parent.params.includes("prefers-reduced-motion: reduce"));
    document.body.innerHTML = '<div class="app-shell"><button class="ns-account-trigger"></button><button class="ns-theme-choice"></button></div>';
    for (const button of document.querySelectorAll("button")) {
      const matching = reduced.filter((r) => button.matches(r.selector));
      expect(matching.some((r) => r.nodes.some((d) => d.type === "decl" && d.prop === "transition" && d.value === "none"))).toBe(true);
    }
  });
});

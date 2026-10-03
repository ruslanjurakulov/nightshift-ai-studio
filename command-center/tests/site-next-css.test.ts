import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The marketing pages' second pass (docs/design/SITE_KREA.md) keeps four
 * promises in its stylesheet, pinned here so a later edit cannot quietly break
 * them: nothing moves unless the visitor allows motion, the stage's text stays
 * readable on the stage, controls keep their 44px, and the whole sheet stays
 * scoped to `.nx` so the docs, MCP, legal and 404 pages are not restyled.
 */
const css = readFileSync(join(__dirname, "..", "components/site/site-next.css"), "utf8");

/** The text of every `@media (...) { ... }` block whose query contains this text. */
function mediaBlocks(source: string, needle: string): string[] {
  const out: string[] = [];
  let from = 0;
  for (;;) {
    const at = source.indexOf("@media", from);
    if (at < 0) return out;
    const open = source.indexOf("{", at);
    const query = source.slice(at, open);
    let depth = 0;
    let end = open;
    for (; end < source.length; end++) {
      if (source[end] === "{") depth++;
      else if (source[end] === "}" && --depth === 0) break;
    }
    if (query.includes(needle)) out.push(source.slice(open + 1, end));
    from = end + 1;
  }
}

function lum(hex: string) {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}
const contrast = (a: string, b: string) => {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};
const token = (name: string) => css.match(new RegExp(`${name}:\\s*(#[0-9a-fA-F]{6})`))![1];

describe("site-next.css", () => {
  it("moves nothing unless motion is allowed: every transition and animation sits in a no-preference block", () => {
    let rest = css;
    for (const inner of mediaBlocks(css, "prefers-reduced-motion: no-preference")) rest = rest.replace(inner, "");
    // The keyframes themselves are inert until something names them.
    rest = rest.replace(/@keyframes[^{]+\{(?:[^{}]|\{[^{}]*\})*\}/g, "");
    expect(rest).not.toMatch(/\btransition\s*:/);
    expect(rest).not.toMatch(/\banimation(?:-name)?\s*:/);
  });

  it("keeps every selector under .nx (or .nx-*), so no other page is restyled", () => {
    const stripped = css.replace(/\/\*[\s\S]*?\*\//g, "").replace(/@keyframes[^{]+\{(?:[^{}]|\{[^{}]*\})*\}/g, "");
    const selectors = [...stripped.matchAll(/(?:^|\})\s*([^{}@][^{}]*)\{/g)].map((m) => m[1].trim()).filter((s) => s && !/^\d+%|^to$|^from$|^@/.test(s));
    expect(selectors.length).toBeGreaterThan(50);
    for (const group of selectors) {
      for (const sel of group.split(/,(?![^(]*\))/).map((s) => s.trim())) {
        expect(sel, `unscoped selector: ${sel}`).toMatch(/\.nx|html:is\(\[lang="ru"\], \[lang="uz"\]\) \.nx/);
      }
    }
  });

  it("reads at 4.5:1 or better on the stage in both themes (the stage is the same in both)", () => {
    const stage = token("--nx-stage");
    const raised = token("--nx-stage-2");
    const active = token("--nx-stage-3");
    for (const bg of [stage, raised, active]) {
      expect(contrast(token("--nx-stage-text"), bg)).toBeGreaterThanOrEqual(7);
      expect(contrast(token("--nx-stage-dim"), bg)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(token("--nx-stage-amber"), bg)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(token("--nx-stage-go"), bg)).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("gives every control at least 44px of height", () => {
    const heights: Record<string, number> = {};
    for (const sel of [".nx-btn", ".nx-link", ".nx-tab", ".nx-ui-key"]) {
      const at = css.indexOf(`${sel} {`);
      const body = css.slice(at, css.indexOf("}", at));
      heights[sel] = Number(body.match(/min-height:\s*(\d+)px/)?.[1] ?? 0);
    }
    for (const [sel, h] of Object.entries(heights)) expect(h, sel).toBeGreaterThanOrEqual(44);
    expect(css).toMatch(/\.nx \.st-field input \{ height: 54px; min-height: 54px;/);
  });

  it("draws nothing as pressable that is not: the drawn keys are spans inside an aria-hidden picture", () => {
    const stage = readFileSync(join(__dirname, "..", "components/landing/PressStage.tsx"), "utf8");
    expect(stage).toMatch(/className="nx-ui" aria-hidden/);
    expect(stage).not.toMatch(/<button[^>]*nx-ui-key/);
    // Autoplay only when motion is allowed, the stage is visible and nobody has taken over.
    expect(stage).toContain("prefers-reduced-motion: reduce");
    expect(stage).toContain("IntersectionObserver");
  });
});

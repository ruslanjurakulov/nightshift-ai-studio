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
    for (const sel of [".nx-btn", ".nx-link", ".nx-chat-key", ".nx-try-pick", ".nx-show-cta", ".nx-motion-btn", ".nx-way-link"]) {
      // The base rule (at the start of a line), not a transition-only mention inside a media block.
      const m = css.match(new RegExp(`^${sel.replace(".", "\\.")} \\{[^}]*\\}`, "m"));
      heights[sel] = Number(m?.[0].match(/min-height:\s*(\d+)px/)?.[1] ?? 0);
    }
    for (const [sel, h] of Object.entries(heights)) expect(h, sel).toBeGreaterThanOrEqual(44);
    expect(css).toMatch(/\.nx \.st-field input \{ height: 54px; min-height: 54px;/);
  });

  it("sets the credit-math equations in the page's own face with aligned figures, not in a monospace", () => {
    const at = css.indexOf(".nx .st-formula code {");
    expect(at).toBeGreaterThan(-1);
    const body = css.slice(at, css.indexOf("}", at));
    expect(body).toContain("font-family: inherit");
    expect(body).toContain("tabular-nums");
  });

  it("draws nothing as pressable that is not: the hero card has no control and its drawn key is a span in an aria-hidden group", () => {
    const card = readFileSync(join(__dirname, "..", "components/landing/HeroCard.tsx"), "utf8");
    expect(card).toMatch(/className="nx-chat-foot" aria-hidden/);
    expect(card).not.toMatch(/<button|<a |<Link|<input/);
    expect(card).toMatch(/<span className="nx-chat-key">/);
  });

  it("lets the visitor stop everything that runs by itself: each infinite animation's class is paused by html[data-motion=paused] (WCAG 2.2.2)", () => {
    const running = [...css.matchAll(/([^{}]+)\{[^{}]*animation:[^;{}]*infinite[^;{}]*;/g)].flatMap((m) => m[1].split(",").map((x) => x.trim()));
    expect(running.length).toBeGreaterThan(3);
    const paused = css.slice(css.indexOf('html[data-motion="paused"] .nx-fx-blob'));
    const pausedRule = paused.slice(0, paused.indexOf("}")) + css.slice(css.indexOf('html[data-motion="paused"][data-fx] .nx-kb'), css.indexOf("}", css.indexOf('html[data-motion="paused"][data-fx] .nx-kb')));
    for (const sel of running) {
      const base = sel.match(/\.nx-[a-z-]+/)![0];
      expect(pausedRule, `${sel} keeps running when motion is paused`).toContain(base);
    }
    // And the one-shot reveal is never left hidden by it: print shows everything.
    expect(css).toMatch(/@media print \{ \.nx \[data-rv\] \{ opacity: 1; transform: none; \} \}/);
  });

  it("hides something for the reveal only after the script has marked it, and only when motion is allowed", () => {
    for (const hidden of css.matchAll(/\[data-rv="0"\]\s*\{[^}]*opacity:\s*0/g)) {
      const at = hidden.index!;
      const inNoPref = mediaBlocks(css, "prefers-reduced-motion: no-preference").some((b) => css.indexOf(b) <= at && at < css.indexOf(b) + b.length);
      expect(inNoPref).toBe(true);
    }
    const effects = readFileSync(join(__dirname, "..", "components/site/SiteEffects.tsx"), "utf8");
    expect(effects).toContain("prefers-reduced-motion: reduce");
    // Only what starts below the fold is ever hidden.
    expect(effects).toMatch(/getBoundingClientRect\(\)\.top < vh\) continue/);
  });

  it("has one primary action: the indigo button (amber stays the accent); the section buttons are outlined in the same corners, not black pills", () => {
    const body = (sel: string) => css.slice(css.indexOf(`${sel} {`), css.indexOf("}", css.indexOf(`${sel} {`)));
    expect(body(".nx-cta")).toMatch(/background:\s*transparent/);
    expect(body(".nx-cta")).toMatch(/border-radius:\s*14px/);
    expect(body(".nx-btn")).toContain("var(--st-lit-bg)");
    const site = readFileSync(join(__dirname, "..", "components/site/site.css"), "utf8");
    const mcp = site.slice(site.indexOf(".ml-cap-cta .st-copy {"), site.indexOf("}", site.indexOf(".ml-cap-cta .st-copy {")));
    expect(mcp).toMatch(/background:\s*transparent/);
    expect(mcp).not.toContain("999px");
  });

  it("lights a card under the pointer only for a fine pointer with motion allowed (site.css, shared by every public page)", () => {
    const site = readFileSync(join(__dirname, "..", "components/site/site.css"), "utf8");
    const at = site.indexOf("Pointer light on cards");
    const rest = site.slice(at);
    const media = mediaBlocks(rest, "pointer: fine");
    expect(media).toHaveLength(1);
    expect(rest.slice(0, rest.indexOf("@media"))).not.toMatch(/::before|::after/);
    expect(media[0]).toContain("[data-spot]::before");
  });

  it("lets the pause win over the blobs' own rule: the pause selector is at least as specific and comes later", () => {
    // (ids, classes + attributes + pseudo-classes, elements)
    const spec = (sel: string): [number, number, number] => {
      const s = sel.replace(/"[^"]*"/g, '""');
      return [(s.match(/#[\w-]+/g) ?? []).length, (s.match(/\.[\w-]+|\[[^\]]*\]|:(?!:)[\w-]+/g) ?? []).length, (s.match(/(?:^|[\s>+~])[a-z][\w-]*/g) ?? []).length];
    };
    const cmp = (a: number[], b: number[]) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
    const running = [...css.matchAll(/(html\[data-fx="on"\] \.nx-fx-blob\[data-n="\d"\])\s*\{[^}]*animation:/g)].map((m) => m[1]);
    expect(running).toHaveLength(3);
    const pauseAt = css.indexOf('html[data-motion="paused"][data-fx] .nx-fx-blob[data-n]');
    // The stills no longer drift (they are photographs); the clips are paused by LoopClip itself.
    expect(css).not.toContain(".nx-kb");
    expect(pauseAt).toBeGreaterThan(-1);
    const pauseRule = css.slice(pauseAt, css.indexOf("}", pauseAt));
    expect(pauseRule).toContain("animation-play-state: paused");
    for (const r of running) {
      expect(cmp(spec('html[data-motion="paused"][data-fx] .nx-fx-blob[data-n]'), spec(r)), r).toBeGreaterThanOrEqual(0);
      expect(pauseAt).toBeGreaterThan(css.indexOf(r));
    }
  });

  it("puts no play button on a still: a play glyph would say it is a video", () => {
    expect(css).not.toContain("nx-frame-play");
    const site = readFileSync(join(__dirname, "..", "components/site/site.css"), "utf8");
    expect(site).not.toContain("ml-frame-play");
  });

  it("lets a layered border colour apply on the public pages: the default hairline sits in the lowest layer inside .st, and stays unlayered outside it", () => {
    const globals = readFileSync(join(__dirname, "..", "app/globals.css"), "utf8");
    // The unlayered default beats every layered colour, so the stylesheets here (all in @layer components) never got theirs.
    expect(globals).not.toMatch(/\n\* \{\n  border-color/);
    expect(globals).toContain(":where(*:not(.st):not(.st *)) {\n  border-color: var(--color-border);\n}");
    expect(globals).toMatch(/@layer base \{\s*:where\(\.st, \.st \*\) \{\s*border-color: var\(--color-border\);/);
    // Both public stylesheets are layered, which is why the root fix is needed, and neither fakes the colour any more.
    const site = readFileSync(join(__dirname, "..", "components/site/site.css"), "utf8");
    expect(site).toContain("@layer components {");
    expect(css).toContain("@layer components {");
    expect(css).not.toContain("--nx-edge");
  });
});


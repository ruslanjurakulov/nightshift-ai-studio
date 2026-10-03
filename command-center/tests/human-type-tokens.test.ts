import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The "human, simple, readable" contract (docs/design/HUMAN_TYPE.md), pinned in
 * the tokens so a later change cannot quietly bring back the robot look: one
 * friendly sans, three weights, nothing below 13px, no letter-spaced capitals,
 * a body that reads at 16px / 1.55, and text that stays readable (WCAG AA) in
 * both themes.
 */
const root = join(__dirname, "..");
const read = (f: string) => readFileSync(join(root, f), "utf8");
const globals = read("app/globals.css");
const CSS_FILES = ["app/globals.css", "components/site/site.css", "components/studio/desk.css", "components/models/ModelDiscovery.module.css", "components/concepts/concepts.css", "components/motion/motion.css"];

/** The declarations of the block that opens with this selector text. */
function block(css: string, selectorStart: string, nth = 0): string {
  let at = -1;
  for (let i = 0; i <= nth; i++) at = css.indexOf(selectorStart, at + 1);
  if (at < 0) throw new Error(`no block ${selectorStart}`);
  const open = css.indexOf("{", at);
  let depth = 0;
  for (let i = open; i < css.length; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}" && --depth === 0) return css.slice(open + 1, i);
  }
  throw new Error("unbalanced");
}
const tokens = (body: string) => Object.fromEntries([...body.matchAll(/(--ns-[a-z0-9-]+):\s*(#[0-9a-fA-F]{6})\s*;/g)].map((m) => [m[1], m[2]]));

function lum(hex: string) {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}
const contrast = (a: string, b: string) => {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

const light = tokens(block(globals, ":root,\n:root[data-theme=\"light\"]"));
const dark = tokens(block(globals, ":root[data-theme=\"dark\"],\n[data-theme-scope=\"dark\"]"));

describe("the type tokens", () => {
  it("sets one sans for everything read and the system monospace for code only", () => {
    const theme = block(globals, "@theme");
    expect(theme).toMatch(/--font-sans:\s*"Onest"/);
    expect(theme).toMatch(/--font-display:\s*var\(--font-sans\)/);
    expect(theme).toMatch(/--font-mono:\s*ui-monospace/);
    expect(theme).not.toMatch(/Martian|Sofia/);
  });

  it("reads at 16px / 1.55 and headings at 1.2", () => {
    expect(block(globals, ":root {", 0)).toMatch(/--ns-t-body:\s*16px/);
    expect(block(globals, ":root {", 0)).toMatch(/--ns-lh-text:\s*1\.55/);
    expect(block(globals, ":root {", 0)).toMatch(/--ns-lh-head:\s*1\.2/);
    const body = block(globals, "\nbody {\n  font-family");
    expect(body).toContain("font-size: var(--ns-t-body)");
    expect(body).toContain("line-height: var(--ns-lh-text)");
  });

  it("has a scale of 13 · 14 · 16 · 18 · 20 · 24 · 30 · 40 and nothing smaller than 13", () => {
    const root1 = block(globals, ":root {", 0);
    const px = Object.fromEntries([...root1.matchAll(/(--ns-t-[a-z0-9]+):\s*(\d+)px/g)].map((m) => [m[1], Number(m[2])]));
    expect(Object.values(px).sort((a, b) => a - b)).toEqual([13, 13, 14, 16, 18, 20, 24, 30, 40]);
    const theme = block(globals, "@theme");
    expect(theme).toMatch(/--text-xs:\s*0\.8125rem/);
    expect(theme).toMatch(/--text-base:\s*1rem/);
  });

  it("maps every weight utility onto 400, 500 or 600", () => {
    const theme = block(globals, "@theme");
    const weights = [...theme.matchAll(/--font-weight-[a-z]+:\s*(\d+)/g)].map((m) => Number(m[1]));
    expect(weights.length).toBeGreaterThanOrEqual(9);
    expect(new Set(weights)).toEqual(new Set([400, 500, 600]));
  });

  it("has no wide tracking token", () => {
    const theme = block(globals, "@theme");
    for (const t of ["wide", "wider", "widest"]) expect(theme).toMatch(new RegExp(`--tracking-${t}:\\s*0;`));
  });

  it("makes buttons and fields at least 44px and corners soft", () => {
    const r1 = block(globals, ":root {", 0);
    expect(r1).toMatch(/--ns-control-h:\s*44px/);
    expect(r1).toMatch(/--ns-r-panel:\s*16px/);
    expect(r1).toMatch(/--ns-r-key:\s*12px/);
    expect(block(globals, ".btn-primary {")).toContain("min-height: 2.75rem");
    expect(block(globals, ".btn-quiet {")).toContain("min-height: 2.75rem");
  });
});

describe("no robot styling anywhere in the stylesheets", () => {
  it.each(CSS_FILES)("%s: no capitals, no weight outside 400/500/600, no size below 13px", (file) => {
    const css = read(file).replace(/\/\*[\s\S]*?\*\//g, "");
    // Only the wordmark (the logotype's own capitals, 700) is exempt.
    const stripped = css.replace(/\.(?:ns-wordmark|st-brand)\s*\{[^}]*\}/g, "");
    expect(stripped).not.toMatch(/text-transform:\s*uppercase/);
    expect([...stripped.matchAll(/font-weight:\s*(\d+)/g)].map((m) => Number(m[1])).filter((w) => ![400, 500, 600].includes(w))).toEqual([]);
    expect([...stripped.matchAll(/font-size:\s*(\d+(?:\.\d+)?)px/g)].map((m) => Number(m[1])).filter((n) => n < 13)).toEqual([]);
    expect([...stripped.matchAll(/letter-spacing:\s*(\d*\.?\d+)(?:em|px)/g)].map((m) => Number(m[1])).filter((n) => n > 0)).toEqual([]);
  });

  it("the wordmark keeps its own logotype", () => {
    expect(block(globals, ".ns-wordmark {")).toContain('"Nightshift Wordmark"');
    expect(block(read("components/site/site.css"), ".st-brand {\n  display")).toContain('"Nightshift Wordmark"');
  });
});

describe("contrast stays at WCAG AA in both themes", () => {
  const themes = { light, dark } as const;
  for (const [name, t] of Object.entries(themes)) {
    describe(name, () => {
      it("has its tokens", () => {
        for (const k of ["--ns-ground", "--ns-console", "--ns-key", "--ns-text", "--ns-text-dim", "--ns-amber-ink", "--ns-rule-strong"]) expect(t[k], k).toBeTruthy();
      });
      it.each(["--ns-ground", "--ns-console", "--ns-key"])("text and dim text on %s are 4.5:1 or better", (bg) => {
        expect(contrast(t["--ns-text"], t[bg])).toBeGreaterThanOrEqual(4.5);
        expect(contrast(t["--ns-text-dim"], t[bg])).toBeGreaterThanOrEqual(4.5);
      });
      it.each(["--ns-amber-ink", "--ns-tally", "--ns-go", "--ns-cue", "--ns-caution"])("%s as text on the card is 4.5:1 or better", (fg) => {
        expect(contrast(t[fg], t["--ns-console"])).toBeGreaterThanOrEqual(4.5);
        expect(contrast(t[fg], t["--ns-ground"])).toBeGreaterThanOrEqual(4.5);
      });
      it("the primary button's label is readable on its fill", () => {
        expect(contrast(t["--ns-cta-fg"], t["--ns-cta-bg"])).toBeGreaterThanOrEqual(4.5);
      });
      it("a control's edge is 3:1 against the card", () => {
        expect(contrast(t["--ns-rule-strong"], t["--ns-console"])).toBeGreaterThanOrEqual(3);
      });
    });
  }
});

describe("fonts", () => {
  it("the layout loads no web font from a third party and preloads by locale", () => {
    const layout = read("app/layout.tsx");
    expect(layout).not.toMatch(/next\/font/);
    expect(layout).toContain('import "./fonts.css"');
    expect(layout).toContain("preloadFonts(locale)");
  });
});

describe("words are written in sentence case, not capitals", () => {
  // A label used to be written in capitals because the stylesheet drew capitals anyway. Now
  // nothing does, so a dictionary value in capitals would shout. HTTP verbs, file types and
  // other fixed names are not words.
  const FIXED = new Set(["POST", "JSON", "HTTP", "HTTPS", "HTML", "PNG", "JPEG", "WEBP", "MPEG", "CSV", "UTC", "SRT", "VTT", "GIF", "HEVC", "FFMPEG", "MCP", "API", "OAUTH", "REST", "CHRONOS"]);
  it.each(["lib/i18n/en.ts", "lib/i18n/ru.ts", "lib/i18n/uz.ts", "lib/i18n/site/en.ts", "lib/i18n/site/ru.ts", "lib/i18n/site/uz.ts"])("%s has no value in capitals", (file) => {
    const shouting: string[] = [];
    for (const m of read(file).matchAll(/(\w+): "([^"\\]*)"/g)) {
      const letters = m[2].replace(/[^A-Za-zА-Яа-яЁёʻʼ]/g, "");
      if (letters.length >= 4 && letters === letters.toUpperCase() && !m[2].includes("_") && !m[2].split(/\s+/).every((w) => FIXED.has(w.replace(/[^A-Za-z]/g, "")))) shouting.push(`${m[1]}: ${m[2]}`);
    }
    expect(shouting).toEqual([]);
  });
  it("the status lamp's fallback words (components/ui.tsx) are not capitals either", () => {
    const labels = [...read("components/ui.tsx").matchAll(/label: "([^"]+)"/g)].map((m) => m[1]);
    expect(labels.length).toBeGreaterThan(3);
    expect(labels.filter((l) => l.length > 2 && l === l.toUpperCase())).toEqual([]);
  });
});

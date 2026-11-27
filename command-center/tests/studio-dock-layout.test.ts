/**
 * Where the canvas's docks and lane sit (components/studio-canvas/studio-canvas.css). What would break without these:
 * - the phone's dock, fixed to the screen, sat on the Nightshift AI panel stacked above the canvas and covered its Upgrade and
 *   Buy credits keys (the remedy for a blocked purchase) — it is sticky to the canvas, so it can never leave the canvas's box;
 * - the desk's floating dock covering the map, or the map covering the dock;
 * - the lane taking the page sideways instead of scrolling inside itself.
 * The layout itself is measured in Chromium by tools/visual-qa/studio-canvas.mjs (elementFromPoint on the panel's last key).
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const readCss = (file: string) => readFileSync(path.join(process.cwd(), file), "utf8");
const css = readCss("components/studio-canvas/studio-canvas.css");
const block = (sel: string) => {
  const at = css.indexOf(`${sel} {`);
  expect(at, sel).toBeGreaterThanOrEqual(0);
  return css.slice(at, css.indexOf("}", at));
};

describe("the canvas's docks never cover what is not theirs", () => {
  it("the phone's dock is sticky to the canvas, never fixed to the screen", () => {
    const b = block(".cv-flow-dock");
    expect(b).toMatch(/position:\s*sticky/);
    expect(b).not.toMatch(/position:\s*fixed/);
  });
  it("the desk's dock floats inside the board, and the map sits above its band", () => {
    expect(block(".cv-dockwrap")).toMatch(/position:\s*absolute/);
    expect(block(".react-flow__panel.cv-mini")).toMatch(/margin:\s*12px 12px 80px/);
  });
  it("keeps the desk dock's keys in view when the Library takes up part of the board", () => {
    expect(css).toMatch(/^\.cv-dockwrap\[data-drawer\] \.cv-deck \{[^{}]*flex-wrap:\s*wrap;[^{}]*height:\s*auto;/m);
    expect(css).toMatch(/^\.cv-dockwrap\[data-drawer\] \.cv-qnote \{\s*display:\s*none;/m);
  });
  it("keys and docks show an edge of at least 3:1 on every ground (the hairline measured 1.22:1)", () => {
    const lum = (hex: string) => {
      const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
      return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
    };
    const ratio = (a: string, b: string) => {
      const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
      return (hi + 0.05) / (lo + 0.05);
    };
    const dark = css.match(/--edge:\s*(#[0-9a-f]{6});/i)![1];
    const light = [...css.matchAll(/--edge:\s*(#[0-9a-f]{6});/gi)].map((m) => m[1]).find((v) => v !== dark)!;
    // The canvas's own grounds and key surfaces, and the near-black ground the owner chose (S5, #904).
    for (const g of ["#050811", "#0a0f1c", "#121b2e", "#0a0b0e", "#0f1115", "#15181d", "#1e2229"]) expect(ratio(dark, g), g).toBeGreaterThanOrEqual(3);
    for (const g of ["#e9f0fa", "#ffffff", "#e8eff9", "#f3f7fd"]) expect(ratio(light, g), g).toBeGreaterThanOrEqual(3);
    expect(css).toMatch(/\.cv-kbtn \{ border-color: var\(--edge\); \}/);
    expect(css).toMatch(/\.cv-deck,\n\.cv-flow-dock \{ border-color: var\(--edge\); \}/);
  });
  it("below lg, typing in the Nightshift AI panel puts the canvas's dock and lane away (a phone keyboard leaves 500px)", () => {
    expect(css).toMatch(/@media \(max-width: 1023px\) \{\s*:root:has\(\[data-testid="nightshift-ai-panel"\]:focus-within\) :is\(\.cv-flow-dock, \.cv-lane\) \{ display: none; \}/);
  });
  it("the dock's main key wraps in a long language instead of pushing the page sideways (ru, uz measured +101px)", () => {
    const b = block(":is(.cv-deck, .cv-flow-dock) .cv-kbtn.is-primary");
    expect(b).toMatch(/white-space:\s*normal/);
    expect(b).toMatch(/flex:\s*0 1 auto/);
    expect(b).toMatch(/min-width:\s*0/);
    // No docked max-content rule: it was never shown to fix anything (the +101px does not reproduce on main) and it can push the key
    // past the viewport when the Library is also open (Pixel on #932, 1440 docked + Library).
    expect(css).not.toContain(".grid:has(> .ns-ai-dock) .cv-deck .cv-kbtn.is-primary");
    expect(css).not.toMatch(/\.cv-deck[^{}]*dock-quote[^{}]*\{[^{}]*flex:\s*none/);
  });
  it("keeps Create as the only filled primary action while the tab bar is visible", () => {
    const selector = ':is(.cv-deck, .cv-flow-dock) .cv-kbtn.is-primary[data-state="choose"]';
    const quiet = css.match(/@media \(max-width: 1023px\) \{\s*\/\*[^]*?\*\/\s*([^{}]+)\{/);
    expect(quiet?.[1].trim()).toBe(selector);
    expect(block(selector)).toContain("background: var(--key)");
    expect(block(`${selector}:hover`)).toContain("background: var(--key-hi)");
  });
  it("uses the design-system focus color from the canvas to the Nightshift AI history", () => {
    for (const match of css.matchAll(/([^{}]*:focus-visible[^{}]*)\{([^{}]*)\}/g)) {
      const ring = match[2].match(/(?:outline|box-shadow):\s*[^;]+/g);
      for (const declaration of ring ?? []) {
        if (declaration.trimEnd().endsWith(": none")) continue;
        expect(declaration, match[1]).toContain("var(--ds-focus)");
      }
    }
    expect(block(":is(.cv-root, .cv-tok) :focus-visible")).toContain("outline: 2px solid var(--ds-focus)");
    const panel = readCss("components/brain/nightshift-ai-panel.css");
    expect(panel).toMatch(/\.ns-ai-dock :is\(\.chat-shell, \.chat-frame\) \{\s*--chat-focus: var\(--ds-focus\);/);
    expect(panel).toMatch(/\.chat-meter-link:focus-visible \{ outline: 2px solid var\(--chat-focus\)/);
    const history = readCss("components/chat/chat-history.css");
    expect(history).toMatch(/\.chat-history-expand:focus-visible \{ outline: 2px solid var\(--chat-focus\)/);
    expect(readCss("app/tokens.css")).toMatch(/\.ns-ai-dock,\s*:root\[data-theme="dark"\][^{]*\{[^}]*--ds-focus: #c8ff2e;/);
  });
  it("the lane scrolls sideways inside itself", () => {
    expect(block(".cv-lane-scroll")).toMatch(/overflow-x:\s*auto/);
  });
});

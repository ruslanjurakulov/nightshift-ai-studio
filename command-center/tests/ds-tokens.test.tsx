// @vitest-environment jsdom
/**
 * The --ds-* design system (app/tokens.css, components/ds/Button.tsx, docs/design/TOKENS.md). What would break
 * without these: a token declared for one theme only (a viewer who picks dark by hand gets the light value), a
 * text colour that drops under 4.5:1 on one of the four grounds, a reduced-motion user still getting the press
 * animation, the display face going unlicensed or sent to /login signed out, and a busy key that submits twice.
 */
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Button, IconButton, buttonClass } from "@/components/ds/Button";
import { PUBLIC_FONT_PATHS, isPublicFontPath } from "@/lib/public-paths";
import { FONT_FILES } from "@/next.config";

afterEach(cleanup);

const root = process.cwd();
const css = readFileSync(path.join(root, "app/tokens.css"), "utf8");
const fontsCss = readFileSync(path.join(root, "app/fonts.css"), "utf8");

/** The declarations inside the first block whose selector list starts with `start`. */
function block(start: string): Record<string, string> {
  const at = css.indexOf(start);
  expect(at, `block ${start}`).toBeGreaterThanOrEqual(0);
  const open = css.indexOf("{", at + start.length - 1);
  const close = css.indexOf("}", open);
  const out: Record<string, string> = {};
  for (const m of css.slice(open + 1, close).matchAll(/(--ds-[a-z0-9-]+)\s*:\s*([^;]+);/g)) out[m[1]] = m[2].trim();
  return out;
}

const light = block(":root,\n:root[data-theme=\"light\"],\n[data-theme-scope=\"light\"] {");
const darkMedia = block("  :root:not([data-theme=\"light\"]) {");
const darkExplicit = block(":root[data-theme=\"dark\"],\n[data-theme-scope=\"dark\"] {");

function lum(hex: string): number {
  const h = hex.replace("#", "");
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrast(a: string, b: string): number {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => p - q);
  return (y + 0.05) / (x + 0.05);
}

describe("--ds-* colour tokens", () => {
  it("declares every role in light, in prefers-dark and in an explicit dark choice", () => {
    expect(Object.keys(light).length).toBeGreaterThan(25);
    expect(Object.keys(darkMedia).sort()).toEqual(Object.keys(light).sort());
    expect(Object.keys(darkExplicit).sort()).toEqual(Object.keys(light).sort());
  });

  it("keeps the two dark blocks identical", () => {
    expect(darkExplicit).toEqual(darkMedia);
  });

  it("is the owner's approved navy/neon in dark", () => {
    expect(darkMedia["--ds-bg"]).toBe("#070a14");
    expect(darkMedia["--ds-accent"]).toBe("#2f8bff");
    expect(darkMedia["--ds-select"]).toBe("#c8ff2e");
    expect([darkMedia["--ds-type-text"], darkMedia["--ds-type-image"], darkMedia["--ds-type-video"], darkMedia["--ds-type-audio"]]).toEqual([
      "#ffd23f",
      "#33d6ff",
      "#ff4fa3",
      "#3dff8a",
    ]);
  });

  it.each([
    ["dark", darkMedia],
    ["light", light],
  ])("%s: every text role reads at >= 4.5:1 on all four grounds, edges and the ring at >= 3:1", (_name, theme) => {
    const grounds = ["--ds-bg", "--ds-surface-1", "--ds-surface-2", "--ds-surface-3"].map((k) => theme[k]);
    const text = ["--ds-text", "--ds-text-2", "--ds-muted", "--ds-accent", "--ds-select", "--ds-success", "--ds-warning", "--ds-danger", "--ds-type-text", "--ds-type-image", "--ds-type-video", "--ds-type-audio"];
    for (const role of text) for (const g of grounds) expect(contrast(theme[role], g), `${role} on ${g}`).toBeGreaterThanOrEqual(4.5);
    for (const g of grounds.slice(0, 3)) expect(contrast(theme["--ds-border-strong"], g), `edge on ${g}`).toBeGreaterThanOrEqual(3);
    for (const g of grounds) expect(contrast(theme["--ds-focus"], g), `focus on ${g}`).toBeGreaterThanOrEqual(3);
    expect(contrast(theme["--ds-on-accent"], theme["--ds-accent-solid"])).toBeGreaterThanOrEqual(4.5);
    expect(contrast(theme["--ds-on-accent"], theme["--ds-accent-solid-hover"])).toBeGreaterThanOrEqual(4.5);
    expect(contrast(theme["--ds-on-danger"], theme["--ds-danger-solid"])).toBeGreaterThanOrEqual(4.5);
    expect(contrast(theme["--ds-on-danger"], theme["--ds-danger-solid-hover"])).toBeGreaterThanOrEqual(4.5);
  });

  it("is wired into globals.css and exposed to Tailwind", () => {
    const globals = readFileSync(path.join(root, "app/globals.css"), "utf8");
    expect(globals).toMatch(/@import "tailwindcss";\s*(\/\*[^]*?\*\/\s*)?@import "\.\/tokens\.css";/);
    expect(css).toContain("@theme inline");
    expect(css).toContain("--color-ds-accent: var(--ds-accent);");
    expect(css).toContain("--font-brand: var(--ds-font-display);");
  });
});

describe("the display face is Onest (owner, 2026-11-22: the wide Unbounded face read as strange)", () => {
  it("points --ds-font-display at the Onest stack, by default and for Uzbek", () => {
    const decls = [...css.matchAll(/--ds-font-display:\s*([^;]+);/g)].map((m) => m[1].trim());
    expect(decls).toEqual(["var(--font-sans)", "var(--font-sans)"]);
    expect(css).toMatch(/:root:lang\(uz\) \{ --ds-font-display: var\(--font-sans\); \}/);
    const globals = readFileSync(path.join(root, "app/globals.css"), "utf8");
    expect(globals).toMatch(/--font-sans: "Onest"/);
  });

  it("keeps the display weight and tight spacing, now in Onest", () => {
    expect(css).toMatch(/\.ds-display \{[^}]*font-family: var\(--ds-font-display\);[^}]*font-weight: 600;[^}]*letter-spacing: -0\.02em;/);
    expect(css).toMatch(/\.ds-display \{[^}]*font-variant-numeric: tabular-nums/);
  });

  it("no stylesheet declares or preloads Unbounded, so no browser downloads it", () => {
    expect(fontsCss).not.toMatch(/unbounded/i);
    expect(css).not.toMatch(/unbounded/i);
    for (const f of ["app/page.tsx", "app/layout.tsx", "components/site/fonts.ts"]) {
      expect(readFileSync(path.join(root, f), "utf8"), f).not.toMatch(/unbounded|preloadDisplayFont|DISPLAY_FONT_PATHS/i);
    }
  });

  it("leaves the files and the OFL licence in place, still public and cached (a later decision)", () => {
    expect(readFileSync(path.join(root, "brand/og-fonts/OFL-Unbounded.txt"), "utf8")).toContain("SIL Open Font License, Version 1.1");
    for (const f of ["latin", "latin-ext", "cyrillic", "cyrillic-ext"].map((s) => `/fonts/unbounded-${s}-v1.woff2`)) {
      expect(existsSync(path.join(root, "public", f)), f).toBe(true);
      expect(PUBLIC_FONT_PATHS).toContain(f);
      expect(isPublicFontPath(f)).toBe(true);
      expect(FONT_FILES).toContain(f);
    }
  });
});

describe("motion", () => {
  it("presses at .97 over 120 ms, panels 200, pages 300", () => {
    expect(css).toMatch(/--ds-dur-press: 120ms;/);
    expect(css).toMatch(/--ds-dur-panel: 200ms;/);
    expect(css).toMatch(/--ds-dur-page: 300ms;/);
    expect(css).toMatch(/--ds-press-scale: 0\.97;/);
  });

  it("zeroes every duration and the press under prefers-reduced-motion", () => {
    const at = css.indexOf("@media (prefers-reduced-motion: reduce) {\n  :root {");
    expect(at).toBeGreaterThan(0);
    const chunk = css.slice(at, css.indexOf("}\n}", at));
    for (const v of ["--ds-dur-press: 0ms", "--ds-dur-panel: 0ms", "--ds-dur-page: 0ms", "--ds-press-scale: 1"]) expect(chunk).toContain(v);
  });
});

describe("buttonClass is usable from a Server Component", () => {
  it("lives in a plain module (no \"use client\"), so a server page can call it", () => {
    const src = readFileSync(path.join(root, "components/ds/button-class.ts"), "utf8");
    expect(src).not.toMatch(/^\s*["']use client["']/m);
    expect(src).toMatch(/export function buttonClass/);
  });
});

describe("Button", () => {
  it("builds the class list from variant, size and shape", () => {
    expect(buttonClass({ variant: "primary" })).toBe("ds-btn ds-btn--primary");
    expect(buttonClass({ variant: "danger", size: "sm", icon: true, className: "mt-2" })).toBe("ds-btn ds-btn--danger ds-btn--sm ds-btn--icon mt-2");
  });

  it("while loading: aria-busy, a spoken busy label, focus kept, and a second press swallowed", () => {
    const onClick = vi.fn();
    render(
      <Button variant="primary" loading busyLabel="Saving…" onClick={onClick}>
        Save
      </Button>,
    );
    const key = screen.getByRole("button", { name: /Save/ });
    expect(key.getAttribute("aria-busy")).toBe("true");
    expect(key.getAttribute("aria-disabled")).toBe("true");
    expect((key as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByRole("status").textContent).toBe("Saving…");
    fireEvent.click(key);
    fireEvent.click(key);
    expect(onClick).not.toHaveBeenCalled();
  });

  it("not loading: clicks go through and no busy attributes are set", () => {
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Go</Button>);
    const key = screen.getByRole("button", { name: "Go" });
    expect(key.hasAttribute("aria-busy")).toBe(false);
    fireEvent.click(key);
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});

describe("IconButton", () => {
  it("is named by its label, and its tooltip is not read twice", () => {
    render(<IconButton label="Settings" icon={<svg aria-hidden="true" />} />);
    const key = screen.getByRole("button", { name: "Settings" });
    const tip = document.querySelector(".ds-tip") as HTMLElement;
    expect(tip.getAttribute("aria-hidden")).toBe("true");
    expect(tip.dataset.open).toBe("false");
    fireEvent.mouseEnter(key);
    expect(tip.dataset.open).toBe("true");
    fireEvent.keyDown(document, { key: "Escape" });
    expect(tip.dataset.open).toBe("false");
  });
});

describe("Pixel #810 regressions", () => {
  it("the app's unlayered default border colour never reaches a --ds control (their edges are layered)", () => {
    const globals = readFileSync(path.join(root, "app/globals.css"), "utf8");
    const unlayered = globals.match(/^:where\(\*:not\(\.st\)[^\n]*\{/m)?.[0] ?? "";
    for (const c of ["ds-btn", "ds-input", "ds-chip", "ds-toggle", "ds-tip", "ds-spinner"]) expect(unlayered, c).toContain(`.${c}`);
    expect(globals).toMatch(/@layer base \{\s*:where\(\.st, \.st \*, \.ds-btn, \.ds-input, \.ds-chip, \.ds-toggle, \.ds-tip, \.ds-spinner\)/);
  });

  it("a tooltip near the screen's edge is moved back inside it", () => {
    Object.defineProperty(document.documentElement, "clientWidth", { configurable: true, value: 360 });
    const spy = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      return (this.classList.contains("ds-tip") ? { left: -7, right: 60, top: 0, bottom: 20, width: 67, height: 20 } : { left: 0, right: 44, top: 0, bottom: 44, width: 44, height: 44 }) as DOMRect;
    });
    render(<IconButton label="Settings" icon={<svg aria-hidden="true" />} tooltipSide="bottom" />);
    fireEvent.mouseEnter(screen.getByRole("button", { name: "Settings" }).parentElement as HTMLElement);
    const tip = document.querySelector(".ds-tip") as HTMLElement;
    expect(tip.style.getPropertyValue("--_nudge")).toBe("15px");
    spy.mockRestore();
  });
});

describe("the skin (html.ds-skin) leaves no old colour behind", () => {
  // Names in globals.css's dark block the skin deliberately does not touch: structure (display, folds), effects that are
  // already neutral or switched off in this look (sheens, glows, shadows), and the media chrome that is black on any picture.
  const UNTOUCHED = new Set([
    "--atmos-2", "--backdrop-glow", "--backdrop-video-display", "--cta-glow", "--cta-glow-hover", "--cta-sheen", "--ns-fold",
    "--ns-section-ground", "--shadow-panel", "--studio-canvas", "--studio-cta-shadow", "--studio-media-chip", "--studio-on-media",
    "--studio-scrim",
  ]);

  it("remaps every other role the app's dark theme declares", () => {
    const globals = readFileSync(path.join(root, "app/globals.css"), "utf8");
    const at = globals.indexOf(':root[data-theme="dark"],\n[data-theme-scope="dark"] {');
    const dark = new Set([...globals.slice(at, globals.indexOf("\n}", at)).matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]));
    const s = css.indexOf(":root.ds-skin.ds-skin,");
    const skin = new Set([...css.slice(s, css.indexOf("\n}", s)).matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]));
    const missing = [...dark].filter((n) => !skin.has(n) && !UNTOUCHED.has(n));
    expect(missing, "a new colour role in globals.css needs a line in the skin (app/tokens.css) or in UNTOUCHED here").toEqual([]);
  });

  it("is on the root of every page, and reaches the public shell and scoped boxes", () => {
    const layout = readFileSync(path.join(root, "app/layout.tsx"), "utf8");
    expect(layout).toMatch(/<html lang=\{locale\} className="ds-skin"/);
    expect(css).toMatch(/:root\.ds-skin\.ds-skin,\n\.ds-skin :is\(\.st, \.nx-final, \.nx-bar, \.st-auth-aside\),\n\.ds-skin \[data-theme-scope\] \{/);
  });
});

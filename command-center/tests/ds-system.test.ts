/**
 * The S5 system layer in app/tokens.css (docs/design/SYSTEM.md): type scale, rhythm, motion. What would break without
 * these: a heading step that drifts from its documented 360 → 1440 range, prose set under 13 px, the display weight
 * creeping back to the heavy 600 the owner rejected, and a reduced-motion user still seeing cards slide in.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const css = readFileSync(path.join(process.cwd(), "app/tokens.css"), "utf8");
const start = css.indexOf("/* ── The system: type scale, rhythm, motion");
const system = css.slice(start);

function token(name: string): string {
  const m = system.match(new RegExp(`${name}:\\s*([^;]+);`));
  expect(m, name).not.toBeNull();
  return m![1].trim();
}

/** Evaluates `clamp(Arem, Brem + Cvw, Drem)` (or a px/rem mix) at a viewport width, in px (1rem = 16px). */
function clampAt(expr: string, vw: number): number {
  const px = (s: string) => {
    let total = 0;
    for (const m of s.matchAll(/(-?[\d.]+)(rem|px|vw)/g)) {
      const n = parseFloat(m[1]);
      total += m[2] === "rem" ? n * 16 : m[2] === "px" ? n : (n * vw) / 100;
    }
    return total;
  };
  const m = expr.match(/^clamp\(([^,]+),([^,]+),([^)]+)\)$/);
  expect(m, expr).not.toBeNull();
  const [lo, mid, hi] = [px(m![1]), px(m![2]), px(m![3])];
  return Math.min(hi, Math.max(lo, mid));
}

describe("type scale", () => {
  it.each([
    ["--ds-fs-display-xl", 40, 72],
    ["--ds-fs-display-lg", 32, 56],
    ["--ds-fs-heading-xl", 28, 40],
    ["--ds-fs-heading-lg", 22, 28],
    ["--ds-fs-timecode", 24, 36],
  ])("%s runs from %ipx on a 360 phone to %ipx on a 1440 desk", (name, phone, desk) => {
    expect(clampAt(token(name), 360)).toBeCloseTo(phone, 0);
    expect(clampAt(token(name), 1440)).toBeCloseTo(desk, 0);
  });

  it("has a middle: every step between display and body is present, each smaller than the one above at both widths", () => {
    const steps = ["--ds-fs-display-xl", "--ds-fs-display-lg", "--ds-fs-heading-xl", "--ds-fs-heading-lg"];
    for (const vw of [360, 768, 1440]) {
      const sizes = steps.map((s) => clampAt(token(s), vw));
      for (let i = 1; i < sizes.length; i++) expect(sizes[i], `${steps[i]} at ${vw}`).toBeLessThan(sizes[i - 1]);
      expect(sizes[sizes.length - 1], `heading-lg above heading-md at ${vw}`).toBeGreaterThan(20);
    }
  });

  it("never sets prose under 13px; 12px is for uppercase labels only", () => {
    expect(token("--ds-fs-caption")).toBe("0.8125rem");
    expect(token("--ds-fs-body-sm")).toBe("0.875rem");
    expect(token("--ds-fs-label")).toBe("0.75rem");
    expect(system).toMatch(/\.ds-t-label \{[^}]*text-transform: uppercase/);
  });

  it("sets display at a regular-to-medium weight with tight tracking, not the heavy 600 the owner rejected", () => {
    expect(Number(token("--ds-fw-display"))).toBeLessThanOrEqual(500);
    expect(token("--ds-ls-display-xl")).toBe("-0.025em");
    expect(system).toMatch(/\.ds-t-display-xl,\n\.ds-t-display-lg \{[^}]*font-family: var\(--ds-font-display\)/);
  });

  it("keeps the mono face local: a timecode never waits for a downloaded font", () => {
    expect(token("--ds-font-mono")).not.toMatch(/url\(|"Unbounded"|"Onest"/);
    expect(system).toMatch(/\.ds-timecode \{[^}]*font-variant-numeric: tabular-nums/);
  });
});

describe("rhythm", () => {
  it("gives one gutter (16px on a phone), one container and one section step", () => {
    expect(clampAt(token("--ds-gutter"), 360)).toBe(16);
    expect(clampAt(token("--ds-gutter"), 1440)).toBe(40);
    expect(clampAt(token("--ds-section-y"), 360)).toBe(64);
    expect(clampAt(token("--ds-section-y"), 1440)).toBe(144);
    expect(token("--ds-container")).toBe("1200px");
  });
});

describe("motion", () => {
  it("zeroes the reveal, the ambient pulse, the stagger and the travel under prefers-reduced-motion", () => {
    const at = system.indexOf("@media (prefers-reduced-motion: reduce) {");
    expect(at).toBeGreaterThan(0);
    const chunk = system.slice(at, system.indexOf("}\n}", at));
    for (const v of ["--ds-dur-reveal: 0ms", "--ds-dur-ambient: 0ms", "--ds-stagger: 0ms", "--ds-reveal-shift: 0px"]) expect(chunk).toContain(v);
  });

  it("drives the reveal from the tokens, so the reduced path really is instant", () => {
    expect(system).toMatch(/\.ds-reveal \{[^}]*animation: ds-reveal var\(--ds-dur-reveal\) var\(--ds-ease-emphasized\)/);
    expect(system).toMatch(/animation-delay: calc\(var\(--i, 0\) \* var\(--ds-stagger\)\)/);
  });
});

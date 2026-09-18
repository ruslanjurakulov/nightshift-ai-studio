import { describe, expect, it } from "vitest";
import { STYLE_PRESETS, presetGradient } from "@/lib/stylePresets";

describe("style preset catalog", () => {
  it("has unique, slug-shaped ids and complete fields", () => {
    const ids = STYLE_PRESETS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const p of STYLE_PRESETS) {
      expect(p.id).toMatch(/^[a-z0-9-]+$/);
      expect(p.name.length).toBeGreaterThan(0);
      expect(p.directive.length).toBeGreaterThan(0);
      expect(p.mood.length).toBeGreaterThan(0);
      expect(p.colors).toHaveLength(3);
      for (const c of p.colors) expect(c).toMatch(/^#[0-9a-fA-F]{6}$/);
    }
  });

  it("builds a gradient string from a preset's colors", () => {
    const g = presetGradient(STYLE_PRESETS[0]);
    expect(g).toContain(STYLE_PRESETS[0].colors[0]);
    expect(g).toContain("linear-gradient");
  });
});

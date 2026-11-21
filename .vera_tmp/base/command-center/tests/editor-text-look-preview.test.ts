/**
 * The preview's CSS for outline, shadow and box is built from what the export
 * measurably draws (samples/text_looks.json `draws`, measured with real ffmpeg
 * + libass by tests/test_editor_transitions.py). It is an approximation and is
 * pinned here only to those numbers and to leaving older texts alone.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  BOX_PADDING_EM,
  SHADOW_OPACITY,
  hasLook,
  previewBoxStyle,
  previewTextStyle,
  rgba,
} from "@/lib/editorTextLookPreview";

const fixture = JSON.parse(
  readFileSync(join(__dirname, "..", "..", "samples", "text_looks.json"), "utf8"),
) as { draws: { shadow_opacity: number; box_padding_em: number } };
const LEGACY = "0 0 2px #000000, 0 0 3px #000000";

describe("the preview of a look", () => {
  it("uses the numbers the export was measured to draw", () => {
    expect(SHADOW_OPACITY).toBe(fixture.draws.shadow_opacity);
    expect(BOX_PADDING_EM).toBe(fixture.draws.box_padding_em);
  });

  it("leaves a text with no look field exactly as it was", () => {
    expect(hasLook({ size: 64 })).toBe(false);
    expect(previewTextStyle({ size: 64 }, 1080, LEGACY)).toEqual({ textShadow: LEGACY });
    expect(previewBoxStyle({ size: 64 }, 1080)).toEqual({});
  });

  it("draws a shadow down and right in 60% black, in a share of the frame width", () => {
    const s = previewTextStyle({ size: 80, shadow: 8, outline_width: 0 }, 1080, LEGACY);
    expect(s.textShadow).toBe(`${(8 / 1080) * 100}cqw ${(8 / 1080) * 100}cqw 0 rgba(0, 0, 0, 0.6)`.replace(/(\d+\.\d{3})\d+/g, (m) => String(Math.round(Number(m) * 1000) / 1000)));
  });

  it("draws an outline as a ring in the outline colour, none at width 0", () => {
    const s = previewTextStyle({ size: 80, outline_width: 4, outline_color: "#FF0000" }, 1080, LEGACY);
    const parts = String(s.textShadow).split(", ");
    expect(parts.length).toBeGreaterThanOrEqual(16);
    expect(parts.every((p) => p.endsWith(" #FF0000"))).toBe(true);
    expect(previewTextStyle({ size: 80, outline_width: 0 }, 1080, LEGACY).textShadow).toBe("none");
  });

  it("draws a box instead of the outline, a quarter of the size on every side", () => {
    const fields = { size: 60, outline_width: 6, outline_color: "#00FF00", box_color: "#FFE600", box_opacity: 0.5 };
    expect(previewTextStyle(fields, 1080, LEGACY).textShadow).toBeUndefined();
    const b = previewBoxStyle(fields, 1080);
    expect(b.backgroundColor).toBe("rgba(255, 230, 0, 0.5)");
    expect(b.padding).toBe(`${Math.round(((60 * 0.25) / 1080) * 100 * 1000) / 1000}cqw`);
    expect(b.boxDecorationBreak).toBe("clone");
    expect(previewBoxStyle({ ...fields, box_opacity: undefined }, 1080).backgroundColor).toBe("rgba(255, 230, 0, 0.7)");
    expect(previewBoxStyle({ ...fields, shadow: 4 }, 1080).boxShadow).toContain("rgba(0, 0, 0, 0.6)");
  });

  it("converts colours", () => {
    expect(rgba("#0A0b0C", 2)).toBe("rgba(10, 11, 12, 1)");
    expect(rgba("#000000", -1)).toBe("rgba(0, 0, 0, 0)");
  });
});

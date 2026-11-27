/**
 * The picture size (0208), from the model's spec to the params the quote and the job carry.
 *
 * What would break without these: a model priced by size offered no size (the database refuses it with none) or a model priced
 * flat sent one (refused there); the size silently left to the vendor's default; a size reaching a tool that is not a picture; and
 * the route letting through a size the database's closed list does not take.
 */
import { describe, expect, it } from "vitest";
import { buildParams, effectiveImageSize, withTiers, type StudioForm, type StudioModel } from "@/lib/creative/studio";
import { parseGenerationInput } from "@/lib/creative/operations";

const ORG = "11111111-1111-4111-8111-111111111111";
const base: StudioModel = { id: "m", displayName: "M", capabilities: ["t2i", "edit"], beta: false };
const form = (over: Partial<StudioForm>): StudioForm => ({ capability: "t2i", prompt: "a lighthouse", aspect: "1:1", duration: 5, ...over });

describe("the model's sizes", () => {
  it("are read only for a model priced by size, smallest first in the schema's order", () => {
    const [sized] = withTiers([base], [{ id: "m", spec: { price_variants_by: "image_size", image_sizes: ["4K", "1K", "8K", "2K"] } }]);
    expect(sized.imageSizes).toEqual(["1K", "2K", "4K"]);
    const [flat] = withTiers([base], [{ id: "m", spec: { image_sizes: ["1K"] } }]);
    expect(flat.imageSizes).toBeUndefined();
  });

  it("the effective size is the one picked if listed, else the smallest; none for a model not priced by size", () => {
    expect(effectiveImageSize({ imageSizes: ["1K", "2K"] }, "2K")).toBe("2K");
    expect(effectiveImageSize({ imageSizes: ["1K", "2K"] }, "4K")).toBe("1K");
    expect(effectiveImageSize({ imageSizes: ["1K", "2K"] }, null)).toBe("1K");
    expect(effectiveImageSize({}, "2K")).toBeNull();
  });
});

describe("the params", () => {
  it("carry image_size only for a picture tool and only when a size is named", () => {
    expect(buildParams(form({ imageSize: "2K" })).image_size).toBe("2K");
    expect(buildParams(form({ capability: "edit", sourceId: ORG, imageSize: "1K" })).image_size).toBe("1K");
    expect(buildParams(form({ imageSize: null }))).not.toHaveProperty("image_size");
    expect(buildParams(form({ capability: "t2v", imageSize: "2K" }))).not.toHaveProperty("image_size");
  });

  it("the route takes the closed list for t2i and edit, and refuses anything else before the database", () => {
    const parse = (capability: string, image_size: unknown) =>
      parseGenerationInput({ org_id: ORG, capability, model: "m", params: { prompt: "x", image_size } }, ORG, { requirePrice: false });
    for (const s of ["512", "1K", "2K", "4K"]) expect(parse("t2i", s).ok).toBe(true);
    for (const s of ["8K", "1k", 2, ""]) expect(parse("t2i", s).ok).toBe(false);
    expect(parse("t2v", "1K").ok).toBe(false);
  });
});

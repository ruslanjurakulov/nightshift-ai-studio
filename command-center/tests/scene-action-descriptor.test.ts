import { describe, expect, it } from "vitest";
import { sceneActionDescriptor, type SceneActionSource, type SceneActionStatus } from "../lib/studio/sceneActionDescriptor";
import type { StudioCapability } from "../lib/creative/studio";
import type { ToolAvailability } from "../lib/tool-availability";

const image = Object.freeze({ type: "image", assetId: "synthetic-image" } as const);
const describeAction = (
  capability: StudioCapability = "i2v",
  status: SceneActionStatus = "draft",
  source: SceneActionSource | null = image,
  availability: ToolAvailability = { state: "known", sold: [capability] },
) => sceneActionDescriptor({ capability, status, source, availability });

describe("Scene Inspector presentation adapter", () => {
  it.each(["draft", "approved"] as const)("preserves authoritative %s context and the supplied source", (status) => {
    const result = describeAction("i2v", status);
    expect(result).toMatchObject({ capability: "i2v", status, presentation: status, availability: "available", reason: null, source: { ...image, requirement: "image" } });
    expect(result.source).not.toBe(image);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.source)).toBe(true);
    for (const field of ["enabled", "canStart", "run", "handler", "credits", "modelId"]) expect(result).not.toHaveProperty(field);
  });

  it("reports a closed capability without substituting another operation or source", () => {
    const result = describeAction("i2v", "approved", image, { state: "known", sold: ["t2v"] });
    expect(result).toMatchObject({ capability: "i2v", status: "approved", presentation: "unavailable", availability: "unavailable", reason: "tool-unavailable", source: image });
  });

  it("keeps unread availability unknown instead of marking an existing operation unavailable", () => {
    expect(describeAction("i2v", "draft", image, { state: "unknown" })).toMatchObject({ presentation: "draft", availability: "unknown", reason: null });
  });

  it.each([null, { type: null, assetId: null }, { type: "image", assetId: null }] as const)("does not describe a missing or pending picture as supplied: %j", (source) => {
    expect(describeAction("i2v", "draft", source)).toMatchObject({ presentation: "unavailable", reason: "source-missing" });
  });

  it.each([
    ["i2v", "image", "image"],
    ["upscale", "image", "image"],
    ["video_upscale", "video", "video"],
    ["voice_change", "audio", "recording"],
    ["dub", "video", "recording"],
  ] as const)("composes existing %s source rules for %s", (capability, type, requirement) => {
    expect(describeAction(capability, "draft", { type, assetId: "synthetic-file" })).toMatchObject({ presentation: "draft", source: { type, requirement }, reason: null });
  });

  it("distinguishes a wrong file type from a missing file", () => {
    expect(describeAction("video_upscale", "draft", image)).toMatchObject({ presentation: "unavailable", reason: "source-incompatible", source: { requirement: "video", type: "image", assetId: image.assetId } });
  });

  it("text-only creation does not acquire a file requirement", () => {
    expect(describeAction("t2v", "draft", null)).toMatchObject({ presentation: "draft", source: { requirement: "none", type: null, assetId: null }, reason: null });
  });

  it("keeps source facts explicit even when availability is not yet known", () => {
    expect(describeAction("i2v", "draft", null, { state: "unknown" })).toMatchObject({ availability: "unknown", presentation: "unavailable", reason: "source-missing" });
  });

  it("returns independent snapshots when context changes without mutating the input facts", () => {
    const availability = Object.freeze({ state: "known", sold: Object.freeze(["i2v"]) } as const);
    const context = Object.freeze({ capability: "i2v", status: "approved", source: image, availability } as const);
    const first = sceneActionDescriptor(context);
    const second = sceneActionDescriptor({ ...context, source: { type: "image", assetId: "replacement-synthetic-image" } });
    expect(first.source.assetId).toBe("synthetic-image");
    expect(second.source.assetId).toBe("replacement-synthetic-image");
    expect(context.source).toBe(image);
  });
});

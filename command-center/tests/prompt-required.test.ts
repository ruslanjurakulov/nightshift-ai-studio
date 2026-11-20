import { describe, expect, it } from "vitest";
import { blockedReason, canQuote, promptRule, withTiers, type StudioModel } from "@/lib/creative/studio";

/**
 * Live E2E, 2026-11-20: MiniMax H3's Image -> Video was offered with "The shot · optional"; pressed empty, a job was created
 * and failed with a vague "settings were not accepted". The registry now says which tools a model needs words for
 * (inputs.prompt_required, projected by sellable_models as spec.inputs); the form makes the words required, and no price
 * is asked (so nothing can be pressed) until they are there.
 */
const base = { id: "minimax-h3", displayName: "MiniMax H3", capabilities: ["t2v", "i2v"], beta: false } as StudioModel;
const sellable = [{ id: "minimax-h3", spec: { inputs: { image_refs_max: 1, prompt_required: ["t2v", "i2v", "not-a-tool"] } } }];
const form = (prompt: string) =>
  ({ capability: "i2v", prompt, sourceId: "11111111-1111-4111-8111-111111111111", aspect: "16:9", duration: 5 }) as never;

describe("a model that needs words for image-to-video", () => {
  const [model] = withTiers([base], sellable);

  it("carries the requirement from its spec, keeping only real tools", () => {
    expect(model.wordsRequired).toEqual(["t2v", "i2v"]);
    expect(withTiers([base], [{ id: "minimax-h3", spec: {} }])[0].wordsRequired).toBeUndefined();
  });

  it("makes the shot's words required, and blocks the quote until they are typed", () => {
    expect(promptRule("i2v")).toBe("optional");
    expect(promptRule("i2v", model)).toBe("required");
    expect(blockedReason(form(""), true, model)).toBe("need_words");
    expect(canQuote(form(""), model)).toBe(false);
    expect(canQuote(form("the camera drifts left"), model)).toBe(true);
    // A model that does not say so keeps the words optional, as before.
    expect(canQuote(form(""), base)).toBe(true);
  });
});

describe("the canvas's Image -> Video node", () => {
  it("starts from the chain's words, so a model that needs them is not pressed empty by default", async () => {
    const { recipeState } = await import("@/lib/studio/canvas");
    const { upstreamWords } = await import("@/components/studio-canvas/nodeState");
    const { nodePrefill } = await import("@/components/studio-canvas/Inspector");
    let n = 0;
    const state = recipeState("promptVideo", () => `n${++n}`, "a fox on a ridge at dawn");
    const clip = state.nodes.find((x) => x.kind === "animate")!;
    expect(upstreamWords(state, clip)).toBe("a fox on a ridge at dawn");
    const pre = nodePrefill(clip, { type: "image", assetId: "11111111-1111-4111-8111-111111111111" }, [], upstreamWords(state, clip));
    expect(pre).toMatchObject({ capability: "i2v", prompt: "a fox on a ridge at dawn" });
    // The person's own words win.
    expect(nodePrefill({ ...clip, draft: "slow push-in" }, { type: "image", assetId: null }, [], "ignored")?.prompt).toBe("slow push-in");
  }, 60_000);
});

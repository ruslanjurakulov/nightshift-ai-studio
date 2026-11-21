import { describe, expect, it } from "vitest";
import {
  alternativeModels,
  cleanLinkPrompt,
  createHref,
  directorGroupsFor,
  directorText,
  parseTemplate,
  parseTemplateList,
  parseTemplateOne,
  templateModel,
  templatePrefill,
} from "@/lib/customer/create";
import { ownerFrame } from "@/lib/owner-mode";
import type { StudioModel } from "@/lib/creative/studio";

const model = (id: string, caps: string[], lock: StudioModel["lock"] = null): StudioModel =>
  ({ id, displayName: id.toUpperCase(), capabilities: caps, beta: false, lock }) as StudioModel;

const TPL = {
  slug: "neon-city-drone",
  kind: "video",
  title: "Neon city drone",
  prompt: "A drone shot over a neon city at night",
  model_id: "veo-3",
  aspect: "9:16",
  duration_s: 8,
  quality: "1080p",
};

describe("the S3 template contract", () => {
  it("reads a well-formed template, and the list in either shape", () => {
    expect(parseTemplate(TPL)).toMatchObject({ slug: "neon-city-drone", kind: "video", model_id: "veo-3", duration_s: 8 });
    expect(parseTemplateList([TPL])).toHaveLength(1);
    expect(parseTemplateList({ templates: [TPL, { slug: "x" }] })).toHaveLength(1);
    expect(parseTemplateOne({ template: TPL })?.slug).toBe("neon-city-drone");
  });

  it("refuses a template that is not one, never filling half a form from it", () => {
    expect(parseTemplate({ ...TPL, kind: "3d" })).toBeNull();
    expect(parseTemplate({ ...TPL, slug: "../etc" })).toBeNull();
    expect(parseTemplate({ ...TPL, model_id: "" })).toBeNull();
    expect(parseTemplate({ ...TPL, prompt: 42 })).toBeNull();
    // A list that is not a list is "couldn't read", not "no templates".
    expect(parseTemplateList({ nope: true })).toBeNull();
  });

  it("reads S3's director object as prompt guidance and its placeholders as names only", () => {
    const t = parseTemplate({ ...TPL, director: { camera: "slow push-in", lighting: "warm practicals", n: 3 }, placeholders: ["product", "x y"] })!;
    expect(t.director).toBe("slow push-in, warm practicals");
    expect(t.placeholders).toEqual(["product"]);
    expect(parseTemplate({ ...TPL, director: {} })?.director).toBeNull();
  });
});

describe("a template's model is never swapped silently (CLAUDE.md #4)", () => {
  const tpl = parseTemplate(TPL)!;

  it("is ready only when that exact model is on sale here for the tool, unlocked and switched on", () => {
    expect(templateModel(tpl, [model("veo-3", ["t2v"])]).state).toBe("ready");
    expect(templateModel(tpl, [model("kling", ["t2v"])])).toEqual({ state: "unavailable", reason: "not_offered" });
    expect(templateModel(tpl, [model("veo-3", ["t2i"])])).toEqual({ state: "unavailable", reason: "not_offered" });
    expect(templateModel(tpl, [model("veo-3", ["t2v"], "first_purchase")])).toEqual({ state: "unavailable", reason: "locked" });
    expect(templateModel(tpl, [model("veo-3", ["t2v"])], ["veo-3"])).toEqual({ state: "unavailable", reason: "switched_off" });
  });

  it("offers as alternatives only models the person can actually start, for the person to pick", () => {
    const alts = alternativeModels("video", [model("veo-3", ["t2v"], "not_on_sale"), model("kling", ["t2v"]), model("flux", ["t2i"]), model("off", ["t2v"])], ["off"]);
    expect(alts.map((m) => m.id)).toEqual(["kling"]);
  });

  it("fills the form with the template's own settings and the model it was given, and nothing else", () => {
    const p = templatePrefill(tpl, "veo-3");
    expect(p).toMatchObject({ capability: "t2v", model: "veo-3", aspect: "9:16", duration: 8, resolution: "1080p", prompt: TPL.prompt });
    expect(templatePrefill({ ...tpl, director: "slow dolly-in" }, "veo-3").prompt).toBe(`${TPL.prompt}, slow dolly-in`);
    // An image template's quality is a picture quality only when it is one the form knows.
    const img = parseTemplate({ ...TPL, kind: "image", quality: "not-a-quality" })!;
    expect(templatePrefill(img, "flux").quality).toBeNull();
  });
});

describe("links into Create", () => {
  it("carry the kind, the words and the template, and no price", () => {
    expect(createHref("image", "a cat")).toBe("/create?kind=image&prompt=a+cat");
    expect(createHref("video", "", "neon-city-drone")).toBe("/create?kind=video&template=neon-city-drone");
    expect(createHref("audio")).not.toContain("credits");
  });

  it("bound and flatten the words a link may carry", () => {
    expect(cleanLinkPrompt("a\u0000b\nc")).toBe("a b c");
    expect(cleanLinkPrompt("x".repeat(5000))).toHaveLength(2000);
    expect(cleanLinkPrompt(["a"])).toBe("");
  });
});

describe("the Director is prompt guidance", () => {
  it("adds nothing on Auto, and only the picked presets' words otherwise, in a fixed order", () => {
    expect(directorText({})).toBe("");
    expect(directorText({ palette: "warm", camera: "wide" })).toBe("wide establishing shot, warm color palette");
    expect(directorText({ camera: "not-a-preset" })).toBe("");
  });

  it("offers camera and motion only where they mean something", () => {
    expect(directorGroupsFor("video")).toContain("motion");
    expect(directorGroupsFor("image")).not.toContain("motion");
    expect(directorGroupsFor("audio")).toEqual([]);
  });
});

describe("Owner mode", () => {
  it("is a viewing preference the cookie can only narrow for the operator, never grant to anyone else", () => {
    expect(ownerFrame(true, undefined, true)).toBe(true);
    expect(ownerFrame(true, "off", true)).toBe(false);
    expect(ownerFrame(true, "on", true)).toBe(true);
    // An admin who is not the owner has no User account: an "off" left by the old toggle never strands them as a customer.
    expect(ownerFrame(true, "off")).toBe(true);
    expect(ownerFrame(true, "off", false)).toBe(true);
    expect(ownerFrame(false, "on")).toBe(false);
    expect(ownerFrame(false, undefined)).toBe(false);
  });
});

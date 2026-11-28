import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ttsOptionBlock } from "@/lib/pipeline-options";
import { createPipelineOptions, createPipelineOptionsFor, routingOptions } from "@/lib/server/pipeline-options";
import { TTS_PICKER_MODELS, TTS_MODEL_LABELS, ttsModelBlock } from "@/lib/ttsModels";
import { IMAGE_GENERATORS } from "@/lib/imageProviders";
import { PROVIDERS } from "@/lib/providers";
import { DEFAULT_ORG_ID } from "@/lib/orgs";

/**
 * The operator's routing lists moved from client imports to server props (lib/server/pipeline-options.ts) so that no static
 * chunk carries them. These hold that the move changed nothing a person sees or a run receives.
 */
describe("the Create form's pipeline options", () => {
  const options = createPipelineOptions();

  it("offer the video models the form always offered, in its order, and not the unprobed Higgsfield b-roll", () => {
    expect(options.video).toEqual([
      { id: "seedance", name: "Seedance" },
      { id: "kling", name: "Kling" },
      { id: "veo", name: "Veo" },
      { id: "wan", name: "Wan" },
      { id: "minimax", name: "MiniMax" },
    ]);
  });

  it("offer stock first, then every image generator by name, and carry no secret name or default model", () => {
    expect(options.image).toEqual([{ id: "pexels", name: "Pexels (stock)" }, ...IMAGE_GENERATORS.map(({ id, name }) => ({ id, name }))]);
    const text = JSON.stringify(options);
    for (const g of IMAGE_GENERATORS) {
      expect(text).not.toContain(g.secretName);
      expect(text).not.toContain(`"${g.defaultModel}"`);
    }
  });

  it("switch a narration model off exactly where the server's own rule does, for every model and language", () => {
    expect(options.tts.map((o) => o.id)).toEqual([...TTS_PICKER_MODELS]);
    const languages = ["", "Uzbek", "uz_UZ", "Oʻzbek", "Ўзбек", "Russian", "ru", "English", "en-US", "Arabic", null, 42];
    for (const o of options.tts) {
      expect(o.label).toBe(TTS_MODEL_LABELS[o.id as (typeof TTS_PICKER_MODELS)[number]]);
      for (const lang of languages) {
        expect(ttsOptionBlock(o, lang), `${o.id} / ${String(lang)}`).toEqual(ttsModelBlock(o.id as (typeof TTS_PICKER_MODELS)[number], lang));
      }
    }
  });

  it("an unchecked model is never switched off for a language (unknown is not no)", () => {
    expect(ttsOptionBlock({ id: "x", label: "x", deprecated: false, onQueue: true, speaks: null }, "Uzbek")).toBeNull();
  });

  it("go to the operator in the operator's own organization (or none) only: the route's customerRun rule", () => {
    expect(DEFAULT_ORG_ID).toMatch(/^[0-9a-f-]{36}$/);
    expect(createPipelineOptionsFor({ operator: true, orgId: DEFAULT_ORG_ID })).toEqual(options);
    expect(createPipelineOptionsFor({ operator: true, orgId: null })).toEqual(options);
    expect(createPipelineOptionsFor({ operator: true, orgId: "22222222-2222-4222-8222-222222222222" })).toBeNull();
    expect(createPipelineOptionsFor({ operator: false, orgId: DEFAULT_ORG_ID })).toBeNull();
    expect(createPipelineOptionsFor({ operator: false, orgId: null })).toBeNull();
  });
});

describe("the Providers page's routing options", () => {
  it("are the registry's video providers and the image generators, each with the key the panel warns about", () => {
    const r = routingOptions();
    expect(r.video).toEqual(PROVIDERS.filter((p) => p.category === "video").map(({ id, name, secretName }) => ({ id, name, secretName })));
    expect(r.image).toEqual(IMAGE_GENERATORS.map(({ id, name, secretName }) => ({ id, name, secretName })));
  });
});

describe("the client modules no longer hold the vendor data", () => {
  const read = (rel: string) => readFileSync(path.join(process.cwd(), rel), "utf8");

  it("lib/channels.ts (imported by nearly every screen) does not name the narration vendor", () => {
    expect(read("lib/channels.ts")).not.toMatch(/elevenlabs/i);
  });

  it.each([
    "lib/providers.ts",
    "lib/imageProviders.ts",
    "lib/model-keys.ts",
    "lib/agent-providers.ts",
    "lib/ttsLanguages.ts",
    "lib/ttsModels.ts",
    "lib/server/pipeline-options.ts",
    "lib/server/creative-examples.ts",
  ])("%s is server-only", (rel) => {
    expect(read(rel)).toMatch(/^import "server-only";$/m);
  });

  it("the starters no longer carry the model they were written for", () => {
    expect(read("lib/creative/examples.ts")).not.toMatch(/modelId:\s*"/);
  });
});

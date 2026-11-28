import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { TTS_MODELS, TTS_MODEL_LABELS, isTtsModel } from "../lib/ttsModels";
import { buildRenderJobInsert } from "../lib/runBackend";

const ROOT = join(__dirname, "..", "..");

describe("ElevenLabs models", () => {
  it("match the workflow's tts_model choice list and the latest queue check", () => {
    const wf = readFileSync(join(ROOT, ".github/workflows/daily_video.yml"), "utf8");
    const m = wf.match(/tts_model:[\s\S]*?options: \[([^\]]*)\]/);
    expect(m).not.toBeNull();
    const options = m![1].split(",").map((s) => s.trim().replace(/"/g, "")).filter(Boolean);
    expect(options).toEqual([...TTS_MODELS]);
    const sql = readFileSync(join(ROOT, "supabase/migrations/0025_voice_id.sql"), "utf8");
    for (const model of TTS_MODELS) expect(sql).toContain(`'${model}'`);
  });

  it("labels every model", () => {
    for (const model of TTS_MODELS) expect(TTS_MODEL_LABELS[model]).toBeTruthy();
  });

  it("forwards only a known model on the queue", () => {
    expect(isTtsModel("eleven_v3")).toBe(true);
    expect(isTtsModel("eleven_monolingual_v1")).toBe(false);
    expect(buildRenderJobInsert("c", { ttsModel: "eleven_v3" }, "u").params.tts_model).toBe("eleven_v3");
    expect(buildRenderJobInsert("c", { ttsModel: "bogus" }, "u").params.tts_model).toBeUndefined();
  });
});

describe("ElevenLabs voices", () => {
  it("lists only well-formed, unique voice ids", async () => {
    const { VOICES, isVoiceId } = await import("../lib/voices");
    expect(VOICES.length).toBeGreaterThan(5);
    for (const v of VOICES) expect(isVoiceId(v.id), v.name).toBe(true);
    expect(new Set(VOICES.map((v) => v.id)).size).toBe(VOICES.length);
    expect(isVoiceId("not-a-voice")).toBe(false);
  });

  it("forwards only a well-formed voice id on the queue", () => {
    expect(buildRenderJobInsert("c", { voiceId: "pNInz6obpgDQGcFmaJgB" }, "u").params.voice_id).toBe("pNInz6obpgDQGcFmaJgB");
    expect(buildRenderJobInsert("c", { voiceId: "../../x" }, "u").params.voice_id).toBeUndefined();
  });
});

describe("the voice-model picker and the language a model speaks", () => {
  it("lists eleven_v4 but keeps it off until the queue accepts it", async () => {
    const { TTS_PICKER_MODELS, ttsModelBlock } = await import("../lib/ttsModels");
    expect(TTS_PICKER_MODELS).toContain("eleven_v4");
    expect(isTtsModel("eleven_v4")).toBe(false);
    expect(ttsModelBlock("eleven_v4", "English")).toEqual({ reason: "not_on_queue" });
  });

  it("switches off every model the docs do not list Uzbek for, and only those", async () => {
    const { ttsModelBlock } = await import("../lib/ttsModels");
    for (const model of ["eleven_multilingual_v2", "eleven_flash_v2_5", "eleven_turbo_v2_5"] as const) {
      expect(ttsModelBlock(model, "Uzbek"), model).toEqual({ reason: "language", language: "uz" });
      expect(ttsModelBlock(model, "uz"), model).toEqual({ reason: "language", language: "uz" });
    }
    expect(ttsModelBlock("eleven_v3", "Uzbek")).toBeNull();
  });

  it("disables nothing for Russian, English, or a language the table never verified", async () => {
    const { ttsModelBlock } = await import("../lib/ttsModels");
    for (const model of TTS_MODELS) {
      for (const language of ["Russian", "English", "Arabic", ""]) expect(ttsModelBlock(model, language), `${model} ${language}`).toBeNull();
    }
  });

  it("marks Turbo v2.5 deprecated and says it is Flash v2.5", async () => {
    const { DEPRECATED_TTS_MODELS } = await import("../lib/ttsModels");
    expect(DEPRECATED_TTS_MODELS).toEqual(["eleven_turbo_v2_5"]);
    expect(TTS_MODEL_LABELS.eleven_turbo_v2_5).toContain("Flash v2.5");
  });

  it("reads every way people write Uzbek, so none slips past the picker", async () => {
    const { ttsLanguageCode } = await import("../lib/tts-language-code");
    for (const v of ["Uzbek", "uz_UZ", "uz-Latn", "Uzbekcha", "Oʻzbek", "O’zbek", "Oʼzbek", "O‘zbek", "O`zbek", "Ўзбек", "ўзбекча"]) {
      expect(ttsLanguageCode(v), v).toBe("uz");
    }
    expect(ttsLanguageCode("Arabic")).toBeNull();
  });

  it("has the picker's reasons in all three languages", async () => {
    const [{ en }, { ru }, { uz }] = await Promise.all([import("../lib/i18n/en"), import("../lib/i18n/ru"), import("../lib/i18n/uz")]);
    for (const dict of [en, ru, uz]) {
      for (const key of ["voiceModelDeprecated", "voiceModelNoLanguage", "voiceModelNotOnQueue", "voiceModelHint", "voiceModelDefaultMayNot", "voiceModelDropped"] as const) {
        expect(dict.create[key], key).toBeTruthy();
      }
      expect(dict.create.voiceModelNoLanguage).toContain("{language}");
      expect(dict.create.voiceModelDefaultMayNot).toContain("{language}");
      expect(dict.create.voiceModelDropped).toContain("{model}");
    }
  });
});

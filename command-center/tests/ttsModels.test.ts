import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { TTS_MODELS, TTS_MODEL_LABELS, isTtsModel } from "../lib/ttsModels";
import { buildRenderJobInsert } from "../lib/runBackend";

const ROOT = join(__dirname, "..", "..");

describe("ElevenLabs models", () => {
  it("match the workflow's tts_model choice list and the queue check (0024)", () => {
    const wf = readFileSync(join(ROOT, ".github/workflows/daily_video.yml"), "utf8");
    const m = wf.match(/tts_model:[\s\S]*?options: \[([^\]]*)\]/);
    expect(m).not.toBeNull();
    const options = m![1].split(",").map((s) => s.trim().replace(/"/g, "")).filter(Boolean);
    expect(options).toEqual([...TTS_MODELS]);
    const sql = readFileSync(join(ROOT, "supabase/migrations/0024_tts_model.sql"), "utf8");
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

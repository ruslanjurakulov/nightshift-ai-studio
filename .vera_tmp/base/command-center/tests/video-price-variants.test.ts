/**
 * Video price variants (migration 0070): the route accepts `audio` for t2v and
 * i2v only, as a boolean; the database (not the browser) decides whether a
 * model offers it and what each resolution / soundtrack costs.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AUDIO_CAPABILITIES, PARAM_KEYS, parseGenerationInput } from "@/lib/creative/operations";

const ORG = "11111111-1111-4111-8111-111111111111";
const PIC = "22222222-2222-4222-8222-222222222222";
const parse = (capability: string, params: Record<string, unknown>) =>
  parseGenerationInput({ capability, model: "m", params, max_credits: 5 }, ORG, { requirePrice: true });

describe("the route's input check for a clip's soundtrack", () => {
  it("accepts a boolean audio on t2v and i2v, with or without a resolution", () => {
    expect(parse("t2v", { prompt: "x", duration_s: 5, audio: true }).ok).toBe(true);
    expect(parse("t2v", { prompt: "x", duration_s: 5, audio: false, resolution: "1080p" }).ok).toBe(true);
    expect(parse("i2v", { source_asset_id: PIC, duration_s: 5, audio: true }).ok).toBe(true);
    expect(parse("t2v", { prompt: "x", duration_s: 5 }).ok).toBe(true);
  });

  it("refuses audio that is not a boolean", () => {
    for (const audio of ["true", "yes", 1, 0, null, [true]]) {
      const p = parse("t2v", { prompt: "x", duration_s: 5, audio });
      expect(p.ok, JSON.stringify(audio)).toBe(false);
      if (!p.ok) expect(p.result.body.error).toBe("invalid_params");
    }
  });

  it("refuses audio on any other tool", () => {
    for (const [capability, extra] of [
      ["t2i", { prompt: "x" }],
      ["upscale", { source_asset_id: PIC, factor: 2 }],
      ["describe", { source_asset_id: PIC }],
      ["tts", { prompt: "x" }],
    ] as const) {
      const p = parse(capability, { ...extra, audio: true });
      expect(p.ok, capability).toBe(false);
    }
  });

  it("the key and its capabilities are the ones the database accepts", () => {
    expect(PARAM_KEYS).toContain("audio");
    expect([...AUDIO_CAPABILITIES]).toEqual(["t2v", "i2v"]);
    const sql = readFileSync(path.join(process.cwd(), "..", "supabase/migrations/0070_video_price_variants.sql"), "utf8");
    expect(sql).toContain("'language', 'quality', 'audio'");
    expect(sql).toContain("if p_capability not in ('t2v', 'i2v') then");
    expect(sql).toContain("jsonb_typeof(p_params -> 'audio') is distinct from 'boolean'");
  });
});

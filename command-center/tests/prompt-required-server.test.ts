import { describe, expect, it, vi } from "vitest";
import { missingWords } from "@/lib/creative/route-around";
import { CREATIVE_ERRORS } from "@/lib/creative/operations";
import { dictionaries } from "@/lib/i18n";

/**
 * Rule 6 on the server: a direct API call with no words for a model that needs them (registry inputs.prompt_required) is
 * refused at the quote and the create with the reason named, before anything is held — not created and then refused by
 * the adapter as "settings were not accepted" (live E2E, 2026-11-20, job 68b4954e).
 */
const H3 = { id: "minimax-h3", display_name: "MiniMax H3", spec: { inputs: { image_refs_max: 1, prompt_required: ["t2v", "i2v"] } } };
const OTHER = { id: "kling", display_name: "Kling", spec: { inputs: { image_refs_max: 1 } } };
const db = (rows: unknown, error: unknown = null) => ({ rpc: vi.fn(async () => ({ data: rows, error })) }) as never;

describe("missingWords", () => {
  it("refuses a model that needs words when none were sent, naming the model", async () => {
    const out = await missingWords(db([H3, OTHER]), "i2v", "minimax-h3", { source_asset_id: "x" });
    expect(out?.status).toBe(422);
    expect(out?.body).toMatchObject({ error: "prompt_required", model: "minimax-h3" });
    expect(String(out?.body.detail)).toContain("MiniMax H3");
  });

  it("lets words through without even reading the models, and other models through as before", async () => {
    const d = db([H3]);
    expect(await missingWords(d, "i2v", "minimax-h3", { prompt: "slow push-in" })).toBeNull();
    expect((d as unknown as { rpc: ReturnType<typeof vi.fn> }).rpc).not.toHaveBeenCalled();
    expect(await missingWords(db([H3, OTHER]), "i2v", "kling", {})).toBeNull();
    // Whitespace is not words.
    expect((await missingWords(db([H3]), "i2v", "minimax-h3", { prompt: "   " }))?.status).toBe(422);
  });

  it("does not guess when the model list cannot be read (the adapter still refuses, and nothing is charged)", async () => {
    expect(await missingWords(db(null, { message: "down" }), "i2v", "minimax-h3", {})).toBeNull();
  });

  it("is a known error code with a sentence in every language", () => {
    expect(CREATIVE_ERRORS).toContain("prompt_required");
    for (const l of ["en", "ru", "uz"] as const) expect(dictionaries[l].creative.errors.prompt_required).toBeTruthy();
  });
});

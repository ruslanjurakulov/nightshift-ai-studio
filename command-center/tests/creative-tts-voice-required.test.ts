/**
 * Speech without a voice of the account is refused at the door, before a quote or a hold.
 * What would break without this: the database accepts speech with no voice (0156), the credits are held, and the
 * worker's ElevenLabs adapter then refuses the job for want of a voice (rule 6: fail before spending).
 */
import { describe, expect, it } from "vitest";
import { parseGenerationInput } from "../lib/creative/operations";

const ORG = "11111111-1111-4111-8111-111111111111";
const body = (params: Record<string, unknown>) => ({ capability: "tts", model: "elevenlabs-v3", params });

describe("tts voice_id", () => {
  it.each([
    ["missing", { prompt: "Salom" }],
    ["a typed number", { prompt: "Salom", voice_id: "16516516145" }],
    ["the wrong length", { prompt: "Salom", voice_id: "pNInz6obpgDQGcFmaJg" }],
    ["not a string", { prompt: "Salom", voice_id: 12345678901234567890 }],
  ])("refuses a quote and a create when the voice is %s", (_name, params) => {
    for (const requirePrice of [false, true]) {
      const parsed = parseGenerationInput({ ...body(params), ...(requirePrice ? { max_credits: 5, idempotency_key: "studio:k" } : {}) }, ORG, { requirePrice });
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) {
        expect(parsed.result.status).toBe(400);
        expect(parsed.result.body).toMatchObject({ error: "invalid_params", detail: expect.stringContaining("voice_id") });
      }
    }
  });

  it("accepts a voice picked from the list", () => {
    const parsed = parseGenerationInput(body({ prompt: "Salom", voice_id: "pNInz6obpgDQGcFmaJgB" }), ORG, { requirePrice: false });
    expect(parsed.ok).toBe(true);
  });
});

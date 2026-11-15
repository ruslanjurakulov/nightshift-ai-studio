import { describe, expect, it } from "vitest";
import { conceptThumbnailOn, estimateRunReservation, parsePrices, quoteSeries } from "../lib/credits";
import { videoPriceCents } from "../lib/api/pricing";

const strip = "\t\n\v\f\r\x1c\x1d\x1e\x1f \x85\xa0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000";

describe("concept payer boundaries", () => {
  it.each([...strip])("prices Python/SQL strip character %j as concept", (char) => {
    const agentConfig = { thumbnail_mode: `${char}CoNcEpT${char}` };
    expect(conceptThumbnailOn(agentConfig)).toBe(true);
    expect(videoPriceCents(61, { video_minute: 120, concept_thumbnail_image: 1.125 }, agentConfig)).toBe(127);
    const prices = parsePrices([{ unit: "video_minute", credits_per_unit: 6 }, { unit: "image_generations", credits_per_unit: 2 }]);
    expect(quoteSeries({ prices, durationsS: [60], videos: [], agentConfig }).totalCredits).toBe(14);
  });
  it.each(["\ufeff", "\u200b", "\u180e"])("does not trim %j when Python/SQL do not", (char) => {
    expect(conceptThumbnailOn({ thumbnail_mode: `${char}concept${char}` })).toBe(false);
  });
  it("requires an independently configured API cents price, never converts site credits", () => {
    const mode = { thumbnail_mode: "concept" };
    expect(videoPriceCents(60, { video_minute: 120, image_generations: 100 }, mode)).toBeNull();
    expect(videoPriceCents(60, { video_minute: 120, concept_thumbnail_image: 0 }, mode)).toBe(120);
    for (const video_minute of [0, -1, NaN, Infinity]) {
      expect(videoPriceCents(60, { video_minute, concept_thumbnail_image: 2 }, mode)).toBeNull();
    }
  });
  it.each([undefined, 0, NaN, Infinity])("does not sell a site run on an absent/invalid base %j or historical fallback", (rate) => {
    const prices = parsePrices([
      { unit: "video_minute", credits_per_unit: rate },
      { unit: "job_minimum", credits_per_unit: 30 },
      { unit: "image_generations", credits_per_unit: 2 },
      { unit: "tts_characters", credits_per_unit: 1 },
    ]);
    const videos = [{ durationS: 60, drivers: [{ key: "tts_characters", unit: "tts_characters", provider: null, quantity: 100, usd: null, videos: 1 }] }];
    expect(estimateRunReservation({ prices, durationS: 60, videos }).credits).toBeNull();
    expect(quoteSeries({ prices, durationsS: [60], videos, agentConfig: { thumbnail_mode: "concept" } }).totalCredits).toBeNull();
  });
});

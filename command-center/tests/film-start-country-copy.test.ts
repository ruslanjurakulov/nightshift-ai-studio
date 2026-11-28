/**
 * 0244: start_film refuses a model the visitor's country may not use (country_blocked) or one it could not confirm
 * (country_unverified). The Timeline names each in all three languages with its remedy, and each has a way forward, so neither
 * reads as "the server did not start the project".
 */
import { describe, expect, it } from "vitest";
import { studioTimelineEn } from "../lib/i18n/studio-timeline/en";
import { studioTimelineRu } from "../lib/i18n/studio-timeline/ru";
import { studioTimelineUz } from "../lib/i18n/studio-timeline/uz";
import { coerceStart } from "../lib/studio/timeline";
import { startReasonText, startRemedy } from "../lib/studio/useFilmStart";

const LOCALES = { en: studioTimelineEn, ru: studioTimelineRu, uz: studioTimelineUz };
const WORDS = ["country_unverified", "country_blocked"] as const;

describe("0244: the Timeline names a country refusal of the start", () => {
  it.each(Object.entries(LOCALES))("%s: each word has its own sentence, never the generic refusal", (_lang, c) => {
    for (const w of WORDS) {
      const text = startReasonText(w, { create: c.create, startFailed: c.startFailed });
      expect(text, w).toBeTruthy();
      expect(text).not.toBe(c.startFailed.other);
    }
  });

  it("names the remedy (a VPN or proxy, or another model) and that nothing was held", () => {
    expect(studioTimelineEn.startFailed.country_unverified).toMatch(/VPN or proxy/);
    expect(studioTimelineEn.startFailed.country_blocked).toMatch(/another model/);
    for (const w of WORDS) expect(studioTimelineEn.startFailed[w]).toMatch(/Nothing was held/);
  });

  it("keeps each word as start_film answered it, with a way forward", () => {
    for (const w of WORDS) {
      expect(coerceStart({ ok: false, reason: w })).toEqual({ ok: false, reason: w });
      expect(startRemedy(w)).toBe("fix_and_requote");
    }
  });
});

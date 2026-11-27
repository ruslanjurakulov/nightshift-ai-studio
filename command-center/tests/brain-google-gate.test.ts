import { describe, expect, it, vi } from "vitest";

/**
 * Google's 18+ and country conditions on a Gemini chat turn (lib/server/brain/google-gate). Nothing after the web server checks a
 * chat turn, so what would break is a spend on Google for: someone under 18 or who never answered; someone in a country Google does
 * not serve; someone whose country could not be read; or the chat and Create disagreeing about a country because one of them kept
 * its own copy of Google's list.
 */

vi.mock("server-only", () => ({}));
import { chatGateDecision } from "@/lib/server/brain/google-gate";
import { CHAT_MODELS, type ChatModelId } from "@/lib/server/brain/llm";
import { GOOGLE_AVAILABLE_REGIONS, GOOGLE_BLOCKED, blockedCountriesOf, refusesUnknownCountry } from "@/lib/geo/blocked";
import type { CountryReading } from "@/lib/server/geo";

const GEMINI = "gemini-3.6-flash" as const;
const at = (country: string): CountryReading => ({ country, why: "found" });

describe("the Gemini chat gate", () => {
  it("lets an adult in a served country through", () => {
    expect(chatGateDecision(GEMINI, "adult", at("UZ"))).toBeNull();
    expect(chatGateDecision(GEMINI, "adult", at("US"))).toBeNull();
  });

  it.each([
    ["minor", 403, "adult_only_service"],
    ["none", 428, "adult_attestation_required"],
    ["unknown", 503, "age_unavailable"],
    ["absent", 503, "age_unavailable"],
  ] as const)("an age answer of %s is refused (%i %s), whatever the country", (age, status, error) => {
    expect(chatGateDecision(GEMINI, age, at("UZ"))).toEqual({ status, error });
  });

  it.each(["RU", "BY", "CN", "IR", "KP", "CU"])("%s, a known country Google does not serve, is refused", (c) => {
    expect(chatGateDecision(GEMINI, "adult", at(c))).toEqual({ status: 451, error: "country_blocked" });
  });

  it.each(["not_in_table", "no_address", "not_public", "no_table"] as const)("an unknown country (%s) is refused, never allowed", (why) => {
    expect(chatGateDecision(GEMINI, "adult", { country: null, why })).toEqual({ status: 451, error: "country_unverified" });
  });

  it("no address to read at all is refused", () => {
    expect(chatGateDecision(GEMINI, "adult", null)).toEqual({ status: 451, error: "country_unverified" });
  });

  it("a code Google neither lists nor blocks (outside ISO 3166-1) is unknown, not allowed by default", () => {
    expect(GOOGLE_BLOCKED).not.toContain("ZZ");
    expect(chatGateDecision(GEMINI, "adult", at("ZZ"))).toEqual({ status: 451, error: "country_unverified" });
    // Kosovo is Google's own entry without an ISO code: listed, so allowed.
    expect(chatGateDecision(GEMINI, "adult", at("XK"))).toBeNull();
  });

  it("every Google chat model is one the geo module refuses an unknown country for, with Google's list: the chat and Create agree", () => {
    const google = (Object.keys(CHAT_MODELS) as ChatModelId[]).filter((id) => CHAT_MODELS[id].provider === "google");
    expect(google).toContain(GEMINI);
    for (const id of google) {
      expect(refusesUnknownCountry(id)).toBe(true);
      expect(blockedCountriesOf(id)).toEqual(GOOGLE_BLOCKED);
    }
  });

  it("the gate's verdict matches Google's list for every ISO code, country by country", () => {
    for (const c of GOOGLE_BLOCKED) expect(chatGateDecision(GEMINI, "adult", at(c))?.error).toBe("country_blocked");
    for (const c of GOOGLE_AVAILABLE_REGIONS) expect(chatGateDecision(GEMINI, "adult", at(c))).toBeNull();
  });

  it.each(["anthropic-claude-sonnet-5-5", "openai-gpt-6-luna"] as const)("%s is not Google's: it passes untouched, as before", (id) => {
    expect(chatGateDecision(id, "none", null)).toBeNull();
    expect(chatGateDecision(id, "unknown", { country: null, why: "no_table" })).toBeNull();
    expect(chatGateDecision(id, "adult", at("RU"))).toBeNull();
  });
});

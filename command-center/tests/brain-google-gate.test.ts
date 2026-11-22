import { describe, expect, it, vi } from "vitest";

/**
 * Google's 18+ and country conditions on a Gemini chat turn (lib/server/brain/google-gate). Nothing after the web server checks a
 * chat turn, so what would break is a spend on Google for: someone under 18 or who never answered; someone in a country Google does
 * not serve; someone whose country could not be read; or anyone at all while no country list for the model exists yet.
 */

vi.mock("server-only", () => ({}));
import { chatGateDecision } from "@/lib/server/brain/google-gate";
import type { CountryReading } from "@/lib/server/geo";

const GEMINI = "gemini-3.6-flash" as const;
const MAP = { "gemini-3.6-flash": ["RU", "BY", "CN"] };
const at = (country: string): CountryReading => ({ country, why: "found" });

describe("the Gemini chat gate", () => {
  it("lets an adult in a served country through", () => {
    expect(chatGateDecision(GEMINI, "adult", at("UZ"), MAP)).toBeNull();
  });

  it.each([
    ["minor", 403, "adult_only_service"],
    ["none", 428, "adult_attestation_required"],
    ["unknown", 503, "age_unavailable"],
    ["absent", 503, "age_unavailable"],
  ] as const)("an age answer of %s is refused (%i %s), whatever the country", (age, status, error) => {
    expect(chatGateDecision(GEMINI, age, at("UZ"), MAP)).toEqual({ status, error });
  });

  it("a known country on Google's list is refused", () => {
    expect(chatGateDecision(GEMINI, "adult", at("RU"), MAP)).toEqual({ status: 451, error: "country_blocked" });
  });

  it.each(["not_in_table", "no_address", "not_public", "no_table"] as const)("an unknown country (%s) is refused, never allowed", (why) => {
    expect(chatGateDecision(GEMINI, "adult", { country: null, why }, MAP)).toEqual({ status: 451, error: "country_unverified" });
  });

  it("no address to read at all is refused", () => {
    expect(chatGateDecision(GEMINI, "adult", null, MAP)).toEqual({ status: 451, error: "country_unverified" });
  });

  it("while the model has no country list, every country is refused: no list is not 'allowed everywhere'", () => {
    expect(chatGateDecision(GEMINI, "adult", at("UZ"), {})).toEqual({ status: 451, error: "country_unverified" });
  });

  it.each(["anthropic-claude-sonnet-5-5", "openai-gpt-6-luna"] as const)("%s is not Google's: it passes untouched, as before", (id) => {
    expect(chatGateDecision(id, "none", null, {})).toBeNull();
    expect(chatGateDecision(id, "unknown", { country: null, why: "no_table" }, MAP)).toBeNull();
  });
});

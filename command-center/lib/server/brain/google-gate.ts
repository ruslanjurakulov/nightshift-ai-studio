import "server-only";
import { headers } from "next/headers";
import { runAgeRefusal, type RunAgeAnswer } from "@/lib/age";
import { BLOCKED_COUNTRIES, blockedCountriesOf, type BlockedMap } from "@/lib/geo/blocked";
import { readAgeAnswer } from "@/lib/server/age";
import { readCountry, type CountryReading } from "@/lib/server/geo";
import { CHAT_MODELS, type ChatModelId } from "@/lib/server/brain/llm";

/**
 * Google's two conditions on a Gemini chat turn, asked BEFORE the cap is touched and before any call to Google. A creative job has
 * the database behind it (0196's age gate, PR #881's country gate on creative_jobs); a chat turn has nothing after this server, so
 * this is the only place they hold, and both fail closed:
 *
 *   * 18+ (Gemini API Additional Terms; registry requires_adult; 0192): only a person who confirmed they are an adult. An unread
 *     answer, or 0192 not applied, is refused (try again) rather than spending on Google for someone who may never have answered.
 *   * The end user's country (lib/geo/blocked, lib/server/geo): a known country on the model's list is refused; an unknown one is
 *     refused for every reason, because Google's terms allow use only inside listed regions and "we could not tell" is not inside.
 *     While the model has no country list in lib/geo/blocked at all (PR #881 adds Google's), nothing can tell an allowed country
 *     from a blocked one, so every turn is refused: no list is not "allowed everywhere".
 *
 * Claude and GPT are not Google's: they pass untouched (no header read, no age read), exactly as before. A refusal is the reason,
 * never another model (CLAUDE.md rule 4).
 */

export type ChatGateError = "adult_only_service" | "adult_attestation_required" | "age_unavailable" | "country_blocked" | "country_unverified";
export type ChatGateRefusal = { status: number; error: ChatGateError };

export function chatGateDecision(
  id: ChatModelId,
  age: RunAgeAnswer,
  country: CountryReading | null,
  map: BlockedMap = BLOCKED_COUNTRIES,
): ChatGateRefusal | null {
  if (CHAT_MODELS[id].provider !== "google") return null;
  // Run now's rule for a run nothing after the route asks again ("actions"): minor 403, none 428, unread 503. And 0192 not applied
  // ("absent", which a run lets through) is refused too: no attestation exists to show this person is an adult.
  const ageRefusal = runAgeRefusal(age, "actions");
  if (ageRefusal) return ageRefusal as ChatGateRefusal;
  if (age !== "adult") return { status: 503, error: "age_unavailable" };
  const list = blockedCountriesOf(id, map);
  if (list.length === 0 || !country || country.country === null) return { status: 451, error: "country_unverified" };
  return list.includes(country.country) ? { status: 451, error: "country_blocked" } : null;
}

/** The same for the current request. Reads the person's attestation and the request's country only for a Google model. */
export async function chatModelGate(id: ChatModelId): Promise<ChatGateRefusal | null> {
  if (CHAT_MODELS[id].provider !== "google") return null;
  const age = await readAgeAnswer();
  let country: CountryReading | null = null;
  try {
    country = readCountry(await headers());
  } catch {
    // Outside a request there is no address to read: unknown, and refused below.
  }
  if (country && country.country === null) console.warn("brain: the country is unknown (%s) for a Google chat turn; refused", country.why);
  return chatGateDecision(id, age, country);
}

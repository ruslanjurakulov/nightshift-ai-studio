import "server-only";
import { headers } from "next/headers";
import { runAgeRefusal, type RunAgeAnswer } from "@/lib/age";
import { GOOGLE_AVAILABLE_REGIONS, GOOGLE_BLOCKED, refusesUnknownCountry } from "@/lib/geo/blocked";
import { readAgeAnswer } from "@/lib/server/age";
import { readCountry, type CountryReading } from "@/lib/server/geo";
import { CHAT_MODELS, type ChatModelId } from "@/lib/server/brain/llm";
import { CHAT_GATE_REMEDY, type ChatGateError, type ChatGateVerdict } from "@/lib/brain/chat-gate";

/**
 * Google's two conditions on a Gemini chat turn, asked BEFORE the cap is touched and before any call to Google. A creative job has
 * the database behind it (0196's age gate, 0208's country gate on creative_jobs); a chat turn has nothing after this server, so
 * this is the only place they hold, and both fail closed:
 *
 *   * 18+ (Gemini API Additional Terms; registry requires_adult; 0192): only a person who confirmed they are an adult. An unread
 *     answer, or 0192 not applied, is refused (try again) rather than spending on Google for someone who may never have answered.
 *   * The end user's country, by Google's own list in lib/geo/blocked (GOOGLE_BLOCKED, the twin of the registry's blocked_countries;
 *     never a copy here, so the chat and Create cannot disagree about a country). Google's terms are an allow-list, so the geo
 *     module refuses an unknown country for its models (refusesUnknownCountry), and so does this gate, for every reason.
 *
 * Claude and GPT are not Google's: they pass untouched (no header read, no age read), exactly as before. A refusal is the reason,
 * never another model (CLAUDE.md rule 4).
 */

export type { ChatGateCode, ChatGateError, ChatGateRemedy, ChatGateVerdict } from "@/lib/brain/chat-gate";
export type ChatGateRefusal = { status: number; error: ChatGateError };

/** The verdict as GET /api/brain hands it to the panel before any press: the code and its remedy, or null (nothing stands in the way). */
export function chatGateVerdict(refusal: ChatGateRefusal | null): ChatGateVerdict | null {
  return refusal ? { code: refusal.error, remedy: CHAT_GATE_REMEDY[refusal.error] } : null;
}

const UNVERIFIED: ChatGateRefusal = { status: 451, error: "country_unverified" };

export function chatGateDecision(id: ChatModelId, age: RunAgeAnswer, country: CountryReading | null): ChatGateRefusal | null {
  if (CHAT_MODELS[id].provider !== "google") return null;
  // Run now's rule for a run nothing after the route asks again ("actions"): minor 403, none 428, unread 503. And 0192 not applied
  // ("absent", which a run lets through) is refused too: no attestation exists to show this person is an adult.
  const ageRefusal = runAgeRefusal(age, "actions");
  if (ageRefusal) return ageRefusal as ChatGateRefusal;
  if (age !== "adult") return { status: 503, error: "age_unavailable" };
  // A Google chat model the geo module does not name (GOOGLE_MODELS, the registry's twin) was never registered as one of Google's
  // allow-list models: nothing vouches that GOOGLE_BLOCKED is its list, so it answers no one until it is added there.
  if (!refusesUnknownCountry(id)) return UNVERIFIED;
  if (!country || country.country === null) return UNVERIFIED;
  if (GOOGLE_BLOCKED.includes(country.country)) return { status: 451, error: "country_blocked" };
  // Neither blocked nor listed: a code outside ISO 3166-1 that is not Google's XK. GOOGLE_BLOCKED is "every ISO code Google does not
  // list", so a reading it cannot place would otherwise pass an allow-list by default; it is unknown, and refused as unknown.
  return GOOGLE_AVAILABLE_REGIONS.includes(country.country) ? null : UNVERIFIED;
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

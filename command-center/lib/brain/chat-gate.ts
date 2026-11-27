/**
 * The Gemini chat gate's vocabulary (lib/server/brain/google-gate decides; GET /api/brain and POST /api/brain/turn say it). Here and
 * not in the gate itself because the panel is a client component and the gate is server-only: a client may import these words, never
 * the code that reads a person's age and address.
 */

/** The gate's own refusals (adult_only_service is older and shared with downloads and Create; the panel already words it). */
export const CHAT_GATE_CODES = ["adult_attestation_required", "age_unavailable", "country_blocked", "country_unverified"] as const;
export type ChatGateCode = (typeof CHAT_GATE_CODES)[number];
export type ChatGateError = "adult_only_service" | ChatGateCode;

/**
 * What the person can do about a refusal (CLAUDE.md rule 6), as a stable key the panel words in en/ru/uz:
 *   confirm_age      no answer yet: the 18+ box is theirs to tick;
 *   retry            the answer could not be read right now;
 *   not_in_region    Google does not serve their country: nothing they can change here, so the box says that, never "try again";
 *   contact_support  an under-18 answer given by mistake, or a country that could not be read or checked (no address, no table, no
 *                    list for the model): a fix on our side, not theirs.
 */
export type ChatGateRemedy = "confirm_age" | "retry" | "not_in_region" | "contact_support";

export const CHAT_GATE_REMEDY: Record<ChatGateError, ChatGateRemedy> = {
  adult_only_service: "contact_support",
  adult_attestation_required: "confirm_age",
  age_unavailable: "retry",
  country_blocked: "not_in_region",
  country_unverified: "contact_support",
};

/** GET /api/brain's `gate`: why this person cannot use the chat's model right now, and the remedy; null when nothing stands in the way. */
export type ChatGateVerdict = { code: ChatGateError; remedy: ChatGateRemedy };

export function isChatGateError(v: unknown): v is ChatGateError {
  return typeof v === "string" && Object.prototype.hasOwnProperty.call(CHAT_GATE_REMEDY, v);
}

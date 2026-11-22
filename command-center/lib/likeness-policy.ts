/**
 * The likeness policy switch: ONE server-side switch for every feature that replaces a real person's face or reproduces a person's
 * voice. Pure (no React, no fetch, no Next), so the middleware, server pages and routes all read the same rule.
 *
 * WHY. Paddle's Acceptable Use Policy (updated 13 Apr 2026) prohibits "Face Swaps", "Deep Fakes", "Voice Impersonations" and content
 * generated from a person's likeness without that person's explicit consent; Dodo's Merchant Acceptance Policy allows no impersonation
 * or deepfakes. We told Dodo in writing (21 Nov 2026) that real-person face swap and custom voice cloning are switched off in the paid
 * product before live payments. This switch is that promise in code: OFF unless exactly "on", so a missing variable can never sell it.
 *
 * WHAT IT COVERS (and nothing else, so object, background, product, clothing, style and colour edits stay on sale):
 *  - Character Studio (0137): kling-4.0-omni-edit and seedance-2.5-edit replace the PEOPLE in a video with pictured characters. Their
 *    request schema has no "objects only" mode we could enforce, so the whole studio is off, not one mode of it.
 *  - Custom voice (0117): cloning a person's voice from a recording.
 *  - `dub`: the dubbing adapter does not ask the vendor to keep from cloning the original speakers, so a dub re-voices a real person
 *    in their own (cloned) voice. Off as a whole capability for the same reason.
 *
 * It sits IN FRONT of the features' own switches (NIGHTSHIFT_CHARACTER_STUDIO, CUSTOM_VOICE_ENABLED): those say whether a feature is
 * built and deployed, this one says whether the payment terms allow it to be offered. Both must be on. The workers read the same switch
 * (modules/likeness_policy.py): a swap or dub job that reaches them while it is off (queued before, or through a door this code does not
 * cover) is failed with the same word and its hold released. Finished assets stay in the library.
 */

export const LIKENESS_POLICY_FLAG = "NIGHTSHIFT_LIKENESS_FEATURES";

/** The closed word every refused route answers with. A screen words it; the raw value is never a sentence. */
export const POLICY_REFUSAL = "feature_unavailable_policy";
/** 403: the request is understood and will not be served, whoever asks; nothing was quoted, held or queued. */
export const POLICY_REFUSAL_STATUS = 403;

/** Creative capabilities (lib/creative/registry.ts) that re-voice a real person. Off while the policy is off. */
export const LIKENESS_CAPABILITIES: readonly string[] = ["dub"];

/** On only for exactly "on" (any case, trimmed). Unset, empty, "1", "true" are OFF. */
export function likenessFeaturesAllowed(raw: string | undefined = process.env.NIGHTSHIFT_LIKENESS_FEATURES): boolean {
  return String(raw ?? "").trim().toLowerCase() === "on";
}

export function isLikenessCapability(capability: unknown): boolean {
  return typeof capability === "string" && LIKENESS_CAPABILITIES.includes(capability);
}

/** The refusal to return, or null when the policy allows the feature. Callers return it before any session, quote or hold. */
export function likenessRefusal(allowed: boolean = likenessFeaturesAllowed()): { body: { error: string }; status: number } | null {
  return allowed ? null : { body: { error: POLICY_REFUSAL }, status: POLICY_REFUSAL_STATUS };
}

import "server-only";

/**
 * The cost ledger's units (modules/cost_ledger.py), offered as suggestions in the operator's price editor.
 *
 * Server-only because several of them name the vendor we meter (gemini_*, pexels_*): this list lived in lib/credits.ts,
 * which every public page loads, so the build put our vendor metering into the chunk on /, /pricing and /login
 * (scripts/vendor-bundle-check.mjs). The Credits page reads it here and hands it to the editor as a prop, so only that
 * page's server render ever holds it.
 */
export const LEDGER_UNITS = [
  "gemini_input_tokens",
  "gemini_output_tokens",
  "tts_characters",
  "render_seconds",
  "pexels_requests",
  "upload_bytes",
  "video_gen_clips",
  "image_generations",
  "vision_calls",
] as const;

export type LedgerUnit = (typeof LEDGER_UNITS)[number];

/**
 * The ledger units whose NAME carries a vendor. No browser chunk may hold any of these in any form, a dictionary key
 * included (scripts/vendor-bundle-check.mjs reads this list); their words are in lib/server/ledger-unit-labels.ts.
 * tests/ledger-units.test.ts holds every other unit to a vendor-free first word, so a new vendor unit cannot be left off.
 */
export const VENDOR_NAMED_LEDGER_UNITS = ["gemini_input_tokens", "gemini_output_tokens", "pexels_requests"] as const satisfies readonly LedgerUnit[];
export type VendorNamedLedgerUnit = (typeof VENDOR_NAMED_LEDGER_UNITS)[number];

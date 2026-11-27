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

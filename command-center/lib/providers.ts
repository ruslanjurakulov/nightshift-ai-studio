/**
 * Provider registry — the single source of truth for which external providers
 * the Command Center can hold an API key for.
 *
 * This module is client-safe on purpose: it names providers, their category,
 * the GitHub Actions secret each key is sealed into, and the provider's own
 * console page. It holds NO secret values and makes NO network calls, so it can
 * be imported by the Providers board in the browser and by the server-side
 * secret allowlist alike — one list, so the two can never drift.
 *
 * `secretName` is what the bot reads at runtime (see config.py) and what the
 * write endpoint seals into a repository secret. Every name here MUST also be
 * accepted by `isWritableSecretName` (github-secrets.ts imports this list to
 * guarantee that), or a key typed on the site would be silently refused.
 *
 * `live` marks a provider the pipeline already uses today; the rest are wired
 * by opt-in provider adapters (Track 4) and change nothing until a key is set.
 */

export type ProviderCategory = "llm" | "research" | "voice" | "video" | "image";

export const PROVIDER_CATEGORIES: ProviderCategory[] = [
  "llm",
  "research",
  "voice",
  "video",
  "image",
];

export interface ProviderDef {
  /** Stable slug, used as a key and in the DOM. */
  id: string;
  /** Display name, the provider's own brand — not localized. */
  name: string;
  category: ProviderCategory;
  /** The GitHub Actions secret this key is sealed into. Must be allow-listed. */
  secretName: string;
  /** The provider's own API-key / console page (opens in a new tab). */
  consoleUrl: string;
  /** true = the pipeline already uses this key; false = opt-in adapter, off until set. */
  live: boolean;
}

/**
 * Every provider a channel operator can configure from the site. Grouped by
 * category in the UI; ordering here is the display order within a category.
 */
export const PROVIDERS: ProviderDef[] = [
  // Language models — scripting, topic + prompt generation
  { id: "gemini", name: "Google Gemini", category: "llm", secretName: "GEMINI_API_KEY", consoleUrl: "https://aistudio.google.com/apikey", live: true },
  { id: "anthropic", name: "Anthropic Claude", category: "llm", secretName: "ANTHROPIC_API_KEY", consoleUrl: "https://console.anthropic.com/settings/keys", live: false },
  { id: "openai", name: "OpenAI", category: "llm", secretName: "OPENAI_API_KEY", consoleUrl: "https://platform.openai.com/api-keys", live: false },
  // Research / trends
  { id: "vidiq", name: "vidIQ", category: "research", secretName: "VIDIQ_ACCESS_TOKEN", consoleUrl: "https://vidiq.com", live: true },
  // Voice
  { id: "elevenlabs", name: "ElevenLabs", category: "voice", secretName: "ELEVENLABS_API_KEY", consoleUrl: "https://elevenlabs.io/app/settings/api-keys", live: true },
  // Video generation
  { id: "higgsfield", name: "Higgsfield", category: "video", secretName: "HIGGSFIELD_API_KEY", consoleUrl: "https://higgsfield.ai", live: false },
  { id: "minimax", name: "MiniMax", category: "video", secretName: "MINIMAX_API_KEY", consoleUrl: "https://www.minimax.io", live: true },
  { id: "kling", name: "Kling", category: "video", secretName: "KLING_API_KEY", consoleUrl: "https://klingai.com", live: false },
  { id: "veo", name: "Google Veo", category: "video", secretName: "VEO_API_KEY", consoleUrl: "https://aistudio.google.com/apikey", live: false },
  { id: "seedance", name: "Seedance", category: "video", secretName: "SEEDANCE_API_KEY", consoleUrl: "https://www.volcengine.com/product/seedance", live: false },
  { id: "wan", name: "Wan", category: "video", secretName: "WAN_API_KEY", consoleUrl: "https://tongyi.aliyun.com/wanxiang", live: false },
  // Images / stock
  { id: "leonardo", name: "Leonardo.Ai", category: "image", secretName: "LEONARDO_API_KEY", consoleUrl: "https://app.leonardo.ai/api-access", live: false },
  { id: "flux", name: "Black Forest Labs (FLUX)", category: "image", secretName: "BFL_API_KEY", consoleUrl: "https://dashboard.bfl.ai", live: false },
  { id: "ideogram", name: "Ideogram", category: "image", secretName: "IDEOGRAM_API_KEY", consoleUrl: "https://ideogram.ai/manage-api", live: false },
  { id: "fal", name: "fal.ai", category: "image", secretName: "FAL_KEY", consoleUrl: "https://fal.ai/dashboard/keys", live: false },
  { id: "pexels", name: "Pexels", category: "image", secretName: "PEXELS_API_KEY", consoleUrl: "https://www.pexels.com/api", live: true },
];

/** Secret names for every provider — the allowlist imports this. */
export const PROVIDER_SECRET_NAMES: readonly string[] = PROVIDERS.map((p) => p.secretName);

/** Providers grouped by category, preserving the order in `PROVIDERS`. */
export function providersByCategory(): { category: ProviderCategory; items: ProviderDef[] }[] {
  return PROVIDER_CATEGORIES.map((category) => ({
    category,
    items: PROVIDERS.filter((p) => p.category === category),
  })).filter((g) => g.items.length > 0);
}

/**
 * A provider's configured/not view state. `configured` names are the secrets
 * GitHub reports as present — GitHub never returns a value, only whether the
 * name exists, so this can say "set" without ever seeing the key.
 */
export function isConfigured(p: ProviderDef, configured: Iterable<string>): boolean {
  const set = configured instanceof Set ? configured : new Set(configured);
  return set.has(p.secretName);
}

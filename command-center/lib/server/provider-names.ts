import "server-only";

/**
 * How the registry's provider slugs are written: the companies themselves, as they spell their names. An unknown slug is
 * shown as it is, never guessed.
 *
 * Server-only: this map sat in lib/models-discovery.ts, which the plan finder imports, so the whole vendor list shipped in
 * the chunk loaded on /, /pricing and /login (scripts/vendor-bundle-check.mjs). The operator's Models screen is the one
 * place that names a provider; its page resolves the labels it needs here and passes them down (providerLabels).
 */
const PROVIDER_NAMES: Record<string, string> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
  google: "Google",
  elevenlabs: "ElevenLabs",
  bfl: "Black Forest Labs",
  ideogram: "Ideogram",
  kling: "Kling",
  minimax: "MiniMax",
  runway: "Runway",
  luma: "Luma",
  bytedance: "ByteDance",
  alibaba: "Alibaba",
};

export function providerName(slug: string): string {
  return Object.hasOwn(PROVIDER_NAMES, slug) ? PROVIDER_NAMES[slug] : slug;
}

/**
 * The display names of exactly these slugs (the models a screen shows), for a Client Component's props: never the whole map.
 * An empty slug (a customer's row, whose provider is blanked in lib/server/model-discovery.ts) is left out.
 */
export function providerLabels(slugs: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const s of slugs) if (s) out[s] = providerName(s);
  return out;
}

import "server-only";

/**
 * The registry model each "Start from an example" card on /create was written for (lib/creative/examples.ts), by example id.
 * Server-only: the pairing is our routing (which model we picked for which prompt) and the card list is in a static chunk.
 * A missing example has no model of its own; the composer's default stands.
 */
export const EXAMPLE_MODELS: Readonly<Record<string, string>> = {
  samarkand_dawn: "seedream-5.0-pro",
  thumbnail_portrait: "flux-2-pro",
  plov_flatlay: "seedream-5.0-pro",
  product_bottle: "ideogram-3",
  mountain_drone: "veo-3.1-fast",
  tea_pour: "kling-v3",
  city_night: "veo-3.1-fast",
  intro_voice: "elevenlabs-multilingual-v2",
};

/** The pairs whose model the page offers: StudioHome still checks the tool, and nothing the page does not offer is sent. */
export function exampleModelsFor(models: readonly { id: string }[]): Record<string, string> {
  const offered = new Set(models.map((m) => m.id));
  return Object.fromEntries(Object.entries(EXAMPLE_MODELS).filter(([, model]) => offered.has(model)));
}

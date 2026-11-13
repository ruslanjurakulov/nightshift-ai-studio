/**
 * Countries where a model may not be offered (docs/GEO_BLOCK.md). Pure.
 *
 * BLOCKED_COUNTRIES is the TWIN of `blocked_countries` in schemas/model_registry.json (the web image is built from command-center/
 * only and cannot read that file): tests/geo-block.test.ts fails when the two differ. The codes are ISO 3166-1 alpha-2, upper case.
 *
 * Here an unknown country (null) blocks nothing. The server decides what an unknown country means (lib/server/geo.ts): an address the
 * table has no country for is allowed and logged; a broken setup (no trusted address, a private one, no table) refuses and hides
 * every listed model in production. A VPN, a proxy or a traveller's roaming SIM reads as another country (the documented limit).
 */

export const BLOCKED_COUNTRIES: Readonly<Record<string, readonly string[]>> = {
  // Its vendor's Geographic Use Policy (dev.meta.ai/legal/geographic-use-policy, updated 2026-11-09): the Restricted Territories of
  // section 3 (section 2.2 no longer names this model; India was dropped). Crimea, Donetsk and Luhansk are on that list too, but a
  // country-level table cannot tell them from the rest of Ukraine.
  "grounded-image-1.0": ["AF", "BY", "CN", "CU", "EH", "ER", "ET", "HK", "HT", "IQ", "IR", "KH", "KP", "LY", "MM", "MO", "NI", "PK", "RU", "SO", "SY", "VE"],
};

export type BlockedMap = Readonly<Record<string, readonly string[]>>;

export function blockedCountriesOf(model: string, map: BlockedMap = BLOCKED_COUNTRIES): readonly string[] {
  return Object.prototype.hasOwnProperty.call(map, model) ? map[model] : [];
}

/** True only for a known country on the model's list. */
export function isBlockedIn(model: string, country: string | null, map: BlockedMap = BLOCKED_COUNTRIES): boolean {
  return country !== null && blockedCountriesOf(model, map).includes(country);
}

/** The picker's list without the models blocked in this country (an unknown country hides nothing). */
export function withoutBlocked<T extends { id: string }>(models: T[], country: string | null, map: BlockedMap = BLOCKED_COUNTRIES): T[] {
  if (country === null) return models;
  return models.filter((m) => !isBlockedIn(m.id, country, map));
}

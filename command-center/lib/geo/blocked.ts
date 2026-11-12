/**
 * Countries where a model may not be offered (docs/GEO_BLOCK.md). Pure.
 *
 * BLOCKED_COUNTRIES is the TWIN of `blocked_countries` in schemas/model_registry.json (the web image is built from command-center/
 * only and cannot read that file): tests/geo-block.test.ts fails when the two differ. The codes are ISO 3166-1 alpha-2, upper case.
 *
 * An unknown country (no trusted address, a private one, not in the table, no table) is NOT blocked: the caller logs it and allows.
 * That is the documented limit of blocking by address (a VPN, a proxy or a traveller's roaming SIM reads as another country).
 */

export const BLOCKED_COUNTRIES: Readonly<Record<string, readonly string[]>> = {};

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

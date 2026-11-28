/**
 * Countries where a model may not be offered (docs/GEO_BLOCK.md). Pure.
 *
 * BLOCKED_COUNTRIES is the TWIN of `blocked_countries` in schemas/model_registry.json (the web image is built from command-center/
 * only and cannot read that file): tests/geo-block.test.ts fails when the two differ. The codes are ISO 3166-1 alpha-2, upper case.
 *
 * Here an unknown country (null) blocks nothing, except for an allow-list vendor's models (REFUSE_UNKNOWN_COUNTRY). The server decides what an unknown country means (lib/server/geo.ts): an address the
 * table has no country for is allowed and logged; a broken setup (no trusted address, a private one, no table) refuses and hides
 * every listed model in production. A VPN, a proxy or a traveller's roaming SIM reads as another country (the documented limit).
 */

/** Every ISO 3166-1 alpha-2 code (249, officially assigned). An allow-list vendor blocks every code here that it does not list. */
export const ISO_3166_ALPHA2: readonly string[] = [
  "AD", "AE", "AF", "AG", "AI", "AL", "AM", "AO", "AQ", "AR", "AS", "AT", "AU", "AW", "AX", "AZ",
  "BA", "BB", "BD", "BE", "BF", "BG", "BH", "BI", "BJ", "BL", "BM", "BN", "BO", "BQ", "BR", "BS", "BT", "BV", "BW", "BY", "BZ",
  "CA", "CC", "CD", "CF", "CG", "CH", "CI", "CK", "CL", "CM", "CN", "CO", "CR", "CU", "CV", "CW", "CX", "CY", "CZ",
  "DE", "DJ", "DK", "DM", "DO", "DZ", "EC", "EE", "EG", "EH", "ER", "ES", "ET", "FI", "FJ", "FK", "FM", "FO", "FR",
  "GA", "GB", "GD", "GE", "GF", "GG", "GH", "GI", "GL", "GM", "GN", "GP", "GQ", "GR", "GS", "GT", "GU", "GW", "GY",
  "HK", "HM", "HN", "HR", "HT", "HU", "ID", "IE", "IL", "IM", "IN", "IO", "IQ", "IR", "IS", "IT", "JE", "JM", "JO", "JP",
  "KE", "KG", "KH", "KI", "KM", "KN", "KP", "KR", "KW", "KY", "KZ", "LA", "LB", "LC", "LI", "LK", "LR", "LS", "LT", "LU", "LV", "LY",
  "MA", "MC", "MD", "ME", "MF", "MG", "MH", "MK", "ML", "MM", "MN", "MO", "MP", "MQ", "MR", "MS", "MT", "MU", "MV", "MW", "MX", "MY", "MZ",
  "NA", "NC", "NE", "NF", "NG", "NI", "NL", "NO", "NP", "NR", "NU", "NZ", "OM",
  "PA", "PE", "PF", "PG", "PH", "PK", "PL", "PM", "PN", "PR", "PS", "PT", "PW", "PY", "QA", "RE", "RO", "RS", "RU", "RW",
  "SA", "SB", "SC", "SD", "SE", "SG", "SH", "SI", "SJ", "SK", "SL", "SM", "SN", "SO", "SR", "SS", "ST", "SV", "SX", "SY", "SZ",
  "TC", "TD", "TF", "TG", "TH", "TJ", "TK", "TL", "TM", "TN", "TO", "TR", "TT", "TV", "TW", "TZ",
  "UA", "UG", "UM", "US", "UY", "UZ", "VA", "VC", "VE", "VG", "VI", "VN", "VU", "WF", "WS", "YE", "YT", "ZA", "ZM", "ZW",
];

/**
 * Where Google's Gemini API (which also serves Imagen, Veo and the Gemini image models) may be used. Source: "Available regions for
 * Google AI Studio and Gemini API", https://aistudio.google.com/docs/available-regions (the redirect target of
 * ai.google.dev/gemini-api/docs/available-regions), read 2026-11-21; the page carries no "last updated" date. Its terms make this an
 * ALLOW-list: "You may only access the Services (or make API Clients available to users) within an available region" (Gemini API
 * Additional Terms, effective March 23, 2026). So every other code is blocked, and an unknown country is refused for these models
 * (REFUSE_UNKNOWN_COUNTRY), never allowed. Kosovo is listed by Google and has no ISO code; DB-IP writes it as XK, kept here so a
 * reading of XK is allowed (it is not in ISO_3166_ALPHA2, so it never lands in the blocked set either way).
 */
export const GOOGLE_AVAILABLE_REGIONS: readonly string[] = [
  "AL", "DZ", "AS", "AD", "AO", "AI", "AQ", "AG", "AR", "AM", "AW", "AU", "AT", "AZ", "BS", "BH", "BD", "BB", "BE", "BZ", "BJ", "BM",
  "BT", "BO", "BA", "BW", "BR", "IO", "VG", "BN", "BG", "BF", "BI", "CV", "KH", "CM", "CA", "BQ", "KY", "CF", "TD", "CL", "CX", "CC",
  "CO", "KM", "CK", "CR", "CI", "HR", "CW", "CZ", "CD", "DK", "DJ", "DM", "DO", "EC", "EG", "SV", "GQ", "ER", "EE", "SZ", "ET", "FK",
  "FO", "FJ", "FI", "FR", "GF", "GA", "GM", "GE", "DE", "GH", "GI", "GR", "GL", "GD", "GU", "GT", "GG", "GN", "GW", "GY", "HT", "HM",
  "HN", "HU", "IS", "IN", "ID", "IQ", "IE", "IM", "IL", "IT", "JM", "JP", "JE", "JO", "KZ", "KE", "KI", "XK", "KW", "KG", "LA", "LV",
  "LB", "LS", "LR", "LY", "LI", "LT", "LU", "MG", "MW", "MY", "MV", "ML", "MT", "MH", "MR", "MU", "MX", "FM", "MD", "MC", "MN", "ME",
  "MS", "MA", "MZ", "NA", "NR", "NP", "NL", "NC", "NZ", "NI", "NE", "NG", "NU", "NF", "MK", "MP", "NO", "OM", "PK", "PW", "PS", "PA",
  "PG", "PY", "PE", "PH", "PN", "PL", "PT", "PR", "QA", "CY", "CG", "RO", "RW", "RE", "BL", "SH", "KN", "LC", "PM", "VC", "WS", "SM",
  "ST", "SA", "SN", "RS", "SC", "SL", "SG", "SK", "SI", "SB", "SO", "ZA", "GS", "KR", "SS", "ES", "LK", "SD", "SR", "SE", "CH", "SY",
  "TW", "TJ", "TZ", "TH", "TL", "TG", "TK", "TO", "TT", "TN", "TM", "TC", "TV", "TR", "UG", "UA", "AE", "GB", "US", "UM", "UY", "VI",
  "UZ", "VU", "VA", "VE", "VN", "WF", "EH", "YE", "ZM", "ZW", "AX",
];

/** Every ISO code Google does not list, sorted: what each Google row's registry blocked_countries carries (the twin test). */
export const GOOGLE_BLOCKED: readonly string[] = ISO_3166_ALPHA2.filter((c) => !GOOGLE_AVAILABLE_REGIONS.includes(c));

/** The registry's provider='google' rows (tests/geo-block.test.ts fails when this and schemas/model_registry.json differ). */
export const GOOGLE_MODELS: readonly string[] = [
  "gemini-3.1-flash-image", "gemini-3.1-flash-lite-image", "gemini-3-pro-image", "gemini-2.5-flash-image-expand",
  "gemini-2.5-flash-image-relight", "gemini-2.5-flash-image-erase", "gemini-3.6-flash", "veo-3.1", "veo-3.1-fast", "veo-3.1-lite",
  "gemini-omni-1.1-flash", "gemini-nano-banana-2.1", "google-lyria-3.5",
];

/**
 * Models whose terms allow use only inside listed regions: an unknown country (any reason, not only a broken setup) is refused and
 * hidden for them, because "we could not tell" is not "inside an available region". Every other listed model keeps the older rule
 * (an address DB-IP has no country for is allowed and logged; lib/server/geo.ts).
 */
export const REFUSE_UNKNOWN_COUNTRY: ReadonlySet<string> = new Set(GOOGLE_MODELS);

export const BLOCKED_COUNTRIES: Readonly<Record<string, readonly string[]>> = {
  // Its vendor's Geographic Use Policy (dev.meta.ai/legal/geographic-use-policy, updated 2026-11-09): the Restricted Territories of
  // section 3 (section 2.2 no longer names this model; India was dropped). Crimea, Donetsk and Luhansk are on that list too, but a
  // country-level table cannot tell them from the rest of Ukraine.
  "grounded-image-1.0": ["AF", "BY", "CN", "CU", "EH", "ER", "ET", "HK", "HT", "IQ", "IR", "KH", "KP", "LY", "MM", "MO", "NI", "PK", "RU", "SO", "SY", "VE"],
  ...Object.fromEntries(GOOGLE_MODELS.map((m) => [m, GOOGLE_BLOCKED])),
};

/** True when an unknown country must refuse `model` whatever the reason (an allow-list vendor's terms). */
export function refusesUnknownCountry(model: string): boolean {
  return REFUSE_UNKNOWN_COUNTRY.has(model);
}

export type BlockedMap = Readonly<Record<string, readonly string[]>>;

export function blockedCountriesOf(model: string, map: BlockedMap = BLOCKED_COUNTRIES): readonly string[] {
  return Object.prototype.hasOwnProperty.call(map, model) ? map[model] : [];
}

/**
 * A code a country can be read as: ISO 3166-1 alpha-2, plus Google's Kosovo (XK). BR-S6-03: anything else (DB-IP placeholders such
 * as EU or AP, a typo in a refreshed table) is neither on a deny-list nor on Google's list, so it is read as UNKNOWN, never as a
 * country that happens to be allowed.
 */
export const KNOWN_COUNTRY_CODES: ReadonlySet<string> = new Set([...ISO_3166_ALPHA2, "XK"]);

export function isKnownCountry(code: string | null | undefined): code is string {
  return typeof code === "string" && KNOWN_COUNTRY_CODES.has(code);
}

/**
 * True only for a known country where the model is not offered. For an allow-list vendor (REFUSE_UNKNOWN_COUNTRY, BR-S6-03) that is
 * "not on GOOGLE_AVAILABLE_REGIONS", the vendor's own list, never "on the deny-list derived from it": a code outside both sets is
 * then blocked, not allowed by default. Every other model keeps its deny-list.
 */
export function isBlockedIn(model: string, country: string | null, map: BlockedMap = BLOCKED_COUNTRIES): boolean {
  if (country === null) return false;
  if (refusesUnknownCountry(model)) return !GOOGLE_AVAILABLE_REGIONS.includes(country);
  return blockedCountriesOf(model, map).includes(country);
}

/**
 * The picker's list without the models blocked in this country. An unknown country hides only the allow-list models
 * (REFUSE_UNKNOWN_COUNTRY): their terms need a country known to be inside a listed region.
 */
export function withoutBlocked<T extends { id: string }>(models: T[], country: string | null, map: BlockedMap = BLOCKED_COUNTRIES): T[] {
  if (country === null) return models.filter((m) => !refusesUnknownCountry(m.id));
  return models.filter((m) => !isBlockedIn(m.id, country, map));
}

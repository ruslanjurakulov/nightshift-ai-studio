import "server-only";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { headers } from "next/headers";
import { isPublicIp, lookupCountry, parseGeoTable, parseIp, type GeoTable } from "@/lib/geo/table";
import { trustedClientIp } from "@/lib/geo/client-ip";
import { BLOCKED_COUNTRIES, blockedCountriesOf, withoutBlocked, type BlockedMap } from "@/lib/geo/blocked";

/**
 * The request's country, from the address Caddy vouches for (lib/geo/client-ip) and the DB-IP table shipped in the image
 * (data/geoip/country.bin.gz, docs/GEO_BLOCK.md). Server only: the table is read from disk once per process, and only when a
 * model with a country list is asked about, so a deployment where no model has one never reads it.
 *
 * "Unknown" (no trusted address, a private or local one, an address the table has no country for, no readable table) is allowed and
 * logged, never refused and never guessed: the reason is logged, the address is not (it is personal data and the log is not the place).
 */

export type CountryReading =
  | { country: string; why: "found" }
  | { country: null; why: "no_address" | "not_public" | "not_in_table" | "no_table" };

/** Where the image keeps the table (command-center/Dockerfile copies data/geoip; `next dev` runs from command-center/). */
export const GEO_TABLE_PATH = join(process.cwd(), "data", "geoip", "country.bin.gz");

const cached = new Map<string, GeoTable | null>();

/** The table, read once per process (per path). A missing or damaged file is logged once and reads as "no table". */
export function loadGeoTable(path: string = GEO_TABLE_PATH): GeoTable | null {
  const hit = cached.get(path);
  if (hit !== undefined) return hit;
  let table: GeoTable | null = null;
  try {
    table = parseGeoTable(new Uint8Array(gunzipSync(readFileSync(path))));
  } catch (e) {
    console.error("geo: the country table could not be read (%s); every country reads as unknown", e instanceof Error ? e.message : "error");
  }
  cached.set(path, table);
  return table;
}

export function readCountry(h: Pick<Headers, "get">, load: () => GeoTable | null = () => loadGeoTable()): CountryReading {
  const ip = trustedClientIp(h);
  if (!ip) return { country: null, why: "no_address" };
  const parsed = parseIp(ip);
  if (!parsed || !isPublicIp(parsed)) return { country: null, why: "not_public" };
  const table = load();
  if (!table) return { country: null, why: "no_table" };
  const country = lookupCountry(table, ip);
  return country ? { country, why: "found" } : { country: null, why: "not_in_table" };
}

/**
 * The answer to send instead of quoting or creating `model` here, or null to go on. Called BEFORE any database call that prices,
 * holds or queues anything. The words are neutral (`country_blocked`: "not available in your region"), never the vendor's name or
 * its terms. A model with no list costs nothing: no header is read and no table is loaded.
 */
export function geoRefusal(
  model: string,
  h: Pick<Headers, "get">,
  map: BlockedMap = BLOCKED_COUNTRIES,
  load: () => GeoTable | null = () => loadGeoTable(),
): { status: 451; body: { error: "country_blocked" } } | null {
  const list = blockedCountriesOf(model, map);
  if (list.length === 0) return null;
  const reading = readCountry(h, load);
  if (reading.country === null) {
    console.warn("geo: the country is unknown (%s) for a model sold by country; allowed", reading.why);
    return null;
  }
  return list.includes(reading.country) ? { status: 451, body: { error: "country_blocked" } } : null;
}

/** The picker's models without those blocked where this request comes from. Reads nothing while no listed model has a country list. */
export function hideBlockedModels<T extends { id: string }>(
  models: T[],
  h: Pick<Headers, "get">,
  map: BlockedMap = BLOCKED_COUNTRIES,
  load: () => GeoTable | null = () => loadGeoTable(),
): T[] {
  if (!models.some((m) => blockedCountriesOf(m.id, map).length > 0)) return models;
  const reading = readCountry(h, load);
  if (reading.country === null) console.warn("geo: the country is unknown (%s); no model is hidden", reading.why);
  return withoutBlocked(models, reading.country, map);
}

/** The same for the current request (a page or a route). */
export async function hideBlockedModelsHere<T extends { id: string }>(models: T[]): Promise<T[]> {
  if (!models.some((m) => blockedCountriesOf(m.id).length > 0)) return models;
  try {
    return hideBlockedModels(models, await headers());
  } catch {
    return models;
  }
}

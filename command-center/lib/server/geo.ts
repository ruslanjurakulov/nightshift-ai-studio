import "server-only";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { headers } from "next/headers";
import { isPublicIp, lookupCountry, parseGeoTable, parseIp, type GeoTable } from "@/lib/geo/table";
import { ON_VERCEL, trustedClientIp } from "@/lib/geo/client-ip";
import { BLOCKED_COUNTRIES, blockedCountriesOf, withoutBlocked, type BlockedMap } from "@/lib/geo/blocked";

/**
 * The request's country, from the address our own proxy vouches for (lib/geo/client-ip) and the DB-IP table shipped in the image
 * (data/geoip/country.bin.gz, docs/GEO_BLOCK.md). Server only: the table is read from disk once per process, and only when a
 * model with a country list is asked about, so a deployment where no model has one never reads it.
 *
 * "Unknown" is never guessed. What happens next depends on why (the reason is logged, the address is not: it is personal data):
 *   not_in_table   an address DB-IP has no country for: a visitor's real situation. Allowed and logged, everywhere.
 *   no_address     no trusted address header, not_public: a private or local one, no_table: the table cannot be read. On the
 *                  self-hosted box each means the setup is broken (Caddy did not write the header, or the image lost its table), not
 *                  that a visitor is somewhere unknown. In production there (STRICT) a model with a country list is then refused
 *                  and hidden: fail closed. In development and on Vercel they are allowed and logged, as before.
 */

export type UnknownWhy = "no_address" | "not_public" | "not_in_table" | "no_table";
export type CountryReading = { country: string; why: "found" } | { country: null; why: UnknownWhy };

/** Fail closed on a broken setup: production on the self-hosted box (never `next dev`, a test, or Vercel). */
export const GEO_STRICT = process.env.NODE_ENV === "production" && !ON_VERCEL;

/** True when an unknown country must refuse a model with a country list (see above). */
export function unknownRefuses(why: UnknownWhy, strict: boolean = GEO_STRICT): boolean {
  return strict && why !== "not_in_table";
}

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
  strict: boolean = GEO_STRICT,
): { status: 451; body: { error: "country_blocked" } } | null {
  const list = blockedCountriesOf(model, map);
  if (list.length === 0) return null;
  const reading = readCountry(h, load);
  if (reading.country === null) {
    if (unknownRefuses(reading.why, strict)) {
      console.error("geo: the country is unknown (%s): the setup is broken; a model sold by country is refused", reading.why);
      return { status: 451, body: { error: "country_blocked" } };
    }
    console.warn("geo: the country is unknown (%s) for a model sold by country; allowed", reading.why);
    return null;
  }
  return list.includes(reading.country) ? { status: 451, body: { error: "country_blocked" } } : null;
}

/** The same for several models at once (a workflow's steps): the first refusal, or null. Each model is asked once. */
export function geoRefusalAny(
  models: readonly string[],
  h: Pick<Headers, "get">,
  map: BlockedMap = BLOCKED_COUNTRIES,
  load: () => GeoTable | null = () => loadGeoTable(),
  strict: boolean = GEO_STRICT,
): { status: 451; body: { error: "country_blocked" } } | null {
  for (const m of new Set(models)) {
    const refusal = geoRefusal(m, h, map, load, strict);
    if (refusal) return refusal;
  }
  return null;
}

/**
 * Which models this request's country forbids, as a test of a model id; null when it forbids none (the automatic choice then takes
 * the database's own path, lib/creative/route-around.ts). An unknown country forbids none, unless the setup is broken in
 * production: then every model with a country list is forbidden (fail closed).
 */
export function blockedModelsHere(
  h: Pick<Headers, "get">,
  map: BlockedMap = BLOCKED_COUNTRIES,
  load: () => GeoTable | null = () => loadGeoTable(),
  strict: boolean = GEO_STRICT,
): ((model: string) => boolean) | null {
  const listed = Object.keys(map).filter((m) => blockedCountriesOf(m, map).length > 0);
  if (listed.length === 0) return null;
  const reading = readCountry(h, load);
  let ids: Set<string>;
  if (reading.country === null) {
    if (!unknownRefuses(reading.why, strict)) return null;
    ids = new Set(listed);
  } else {
    const here = reading.country;
    ids = new Set(listed.filter((m) => blockedCountriesOf(m, map).includes(here)));
  }
  return ids.size > 0 ? (model) => ids.has(model) : null;
}

/** The picker's models without those blocked where this request comes from. Reads nothing while no listed model has a country list. */
export function hideBlockedModels<T extends { id: string }>(
  models: T[],
  h: Pick<Headers, "get">,
  map: BlockedMap = BLOCKED_COUNTRIES,
  load: () => GeoTable | null = () => loadGeoTable(),
  strict: boolean = GEO_STRICT,
): T[] {
  if (!models.some((m) => blockedCountriesOf(m.id, map).length > 0)) return models;
  const reading = readCountry(h, load);
  if (reading.country === null) {
    if (unknownRefuses(reading.why, strict)) {
      console.error("geo: the country is unknown (%s): the setup is broken; every model sold by country is hidden", reading.why);
      return withoutListed(models, map);
    }
    console.warn("geo: the country is unknown (%s); no model is hidden", reading.why);
  }
  return withoutBlocked(models, reading.country, map);
}

function withoutListed<T extends { id: string }>(models: T[], map: BlockedMap): T[] {
  return models.filter((m) => blockedCountriesOf(m.id, map).length === 0);
}

/** The same for the current request (a page or a route). Outside a request (no headers) it hides like a broken setup would. */
export async function hideBlockedModelsHere<T extends { id: string }>(models: T[]): Promise<T[]> {
  if (!models.some((m) => blockedCountriesOf(m.id).length > 0)) return models;
  let h: Pick<Headers, "get">;
  try {
    h = await headers();
  } catch {
    return GEO_STRICT ? withoutListed(models, BLOCKED_COUNTRIES) : models;
  }
  return hideBlockedModels(models, h);
}

/**
 * The startup check (instrumentation.ts): when a model has a country list, the table must load. A table that cannot be read is
 * logged loudly once at start, so a broken image is seen at deploy and not at the first visitor. In production on the self-hosted
 * box those models are then refused and hidden for everyone (fail closed) until the image is fixed.
 */
export function checkGeoTableAtStartup(
  map: BlockedMap = BLOCKED_COUNTRIES,
  load: () => GeoTable | null = () => loadGeoTable(),
  strict: boolean = GEO_STRICT,
): "no_list" | "ok" | "no_table" {
  const listed = Object.keys(map).filter((m) => blockedCountriesOf(m, map).length > 0);
  if (listed.length === 0) return "no_list";
  if (load()) return "ok";
  console.error(
    "GEO TABLE MISSING: data/geoip/country.bin.gz cannot be read; %d model(s) with a country list %s (docs/GEO_BLOCK.md)",
    listed.length,
    strict ? "are refused and hidden for every request" : "are allowed for every request (not production)",
  );
  return "no_table";
}

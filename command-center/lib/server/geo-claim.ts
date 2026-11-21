import "server-only";
import { createHmac } from "node:crypto";
import { blockedCountriesOf, BLOCKED_COUNTRIES, type BlockedMap } from "@/lib/geo/blocked";
import { loadGeoTable, readCountry } from "@/lib/server/geo";
import type { GeoTable } from "@/lib/geo/table";

/**
 * The country this server read, signed for the database (migration 0208, docs/GEO_BLOCK.md "The database's own check").
 *
 * WHY. The web routes refuse a model by country, but a signed-in member holds the anon key and their session and can call
 * create_creative_job (and the workflow functions) straight through PostgREST, skipping every route. So the database refuses a job
 * on a model with a country list unless the request carries this header, which only this server can write: an HMAC-SHA256 over
 * `v1.<country>.<user id>.<expiry>` with a key that lives in two places only, this server's environment (NIGHTSHIFT_GEO_CLAIM_KEY)
 * and Supabase Vault (secret `nightshift_geo_claim_key`). A member can send any header they like, but cannot sign one; a claim is
 * bound to the user it was made for and dies after GEO_CLAIM_TTL_S seconds. The header goes from this server to Supabase only, never
 * back to the browser, so a member never sees a valid claim to replay.
 *
 * It is attached only to a call that may create a job on a model with a country list: the country leaves this server only when a
 * gated model is asked for, and is stored nowhere (the database reads it inside the one transaction).
 */

export const GEO_CLAIM_HEADER = "x-nightshift-geo";
export const GEO_CLAIM_TTL_S = 120;
const KEY_ENV = "NIGHTSHIFT_GEO_CLAIM_KEY";
const MIN_KEY_CHARS = 32;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** `v1.<CC>.<uid>.<exp>.<hex hmac>`: the exact shape 0208's geo_claim_country() parses. */
export function signGeoClaim(country: string, userId: string, nowS: number, key: string): string {
  if (!/^[A-Z]{2}$/.test(country) || !UUID_RE.test(userId)) throw new Error("geo claim: bad country or user id");
  const body = `v1.${country}.${userId}.${Math.floor(nowS) + GEO_CLAIM_TTL_S}`;
  return `${body}.${createHmac("sha256", key).update(body, "utf8").digest("hex")}`;
}

/** The key, or null when it is missing or too short to be one (logged once per call, never its value or size). */
function claimKey(env: Record<string, string | undefined>): string | null {
  const key = env[KEY_ENV];
  if (!key || key.length < MIN_KEY_CHARS) {
    console.error(
      "geo: %s is not set (or is shorter than %d characters): the database refuses every job on a model with a country list. " +
        "Set the same value in the web environment and in Supabase Vault as nightshift_geo_claim_key (docs/GEO_BLOCK.md)",
      KEY_ENV, MIN_KEY_CHARS,
    );
    return null;
  }
  return key;
}

/**
 * The header to send with a call that may create a job on one of `models`, or undefined when none of them has a country list (no
 * country is sent) or there is nothing to vouch for (no known country, no key: the database then refuses, which is the point).
 */
export function geoClaimHeaders(
  models: readonly (string | null | undefined)[],
  h: Pick<Headers, "get">,
  userId: string,
  opts: { map?: BlockedMap; load?: () => GeoTable | null; env?: Record<string, string | undefined>; nowS?: number } = {},
): Record<string, string> | undefined {
  const map = opts.map ?? BLOCKED_COUNTRIES;
  if (!models.some((m) => typeof m === "string" && blockedCountriesOf(m, map).length > 0)) return undefined;
  const reading = readCountry(h, opts.load ?? (() => loadGeoTable()));
  if (reading.country === null) return undefined;
  // Read by its literal name: the self-host check (tests/test_deploy_self_host.py) can only prove the server provides a variable
  // it can see named, and handing over the whole environment would hide this one from it.
  const key = claimKey(opts.env ?? { [KEY_ENV]: process.env.NIGHTSHIFT_GEO_CLAIM_KEY });
  if (!key || !UUID_RE.test(userId)) return undefined;
  return { [GEO_CLAIM_HEADER]: signGeoClaim(reading.country, userId, opts.nowS ?? Date.now() / 1000, key) };
}

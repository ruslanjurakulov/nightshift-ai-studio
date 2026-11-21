/**
 * Is the Ads Factory workspace switched on? Evaluated on the SERVER at request time, default OFF.
 *
 * `NIGHTSHIFT_ADS_FACTORY=on` (also `1`, `true`, `yes`). Deliberately NOT a `NEXT_PUBLIC_` variable: those are compiled into the
 * browser bundle at build time, and a flag whose absence could leave a half-wired page visible is the failure this exists to
 * prevent. An unset, empty or unrecognised value is "off": the page answers 404, every /api/ads route answers `not_found` before
 * it reads the session or the database, and the navigation has no entry for it, exactly as if the feature did not exist (same
 * convention as lib/resultsDashboard/flag.ts). Nothing here enables the switch.
 */
export const ADS_FACTORY_FLAG = "NIGHTSHIFT_ADS_FACTORY";

export function adsFactoryEnabled(raw: string | undefined = process.env.NIGHTSHIFT_ADS_FACTORY): boolean {
  return ["on", "1", "true", "yes"].includes(String(raw ?? "").trim().toLowerCase());
}

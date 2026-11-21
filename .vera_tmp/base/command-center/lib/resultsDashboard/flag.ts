/**
 * Is the results dashboard switched on? Evaluated on the SERVER at request time, default OFF.
 *
 * `NIGHTSHIFT_RESULTS_DASHBOARD=on` (also `1`, `true`, `yes`). Deliberately NOT a `NEXT_PUBLIC_` variable: those are
 * compiled into the browser bundle at build time, and a flag whose absence could leave a half-wired page visible is the
 * failure this exists to prevent. An unset, empty or unrecognised value is "off": the page answers 404 and the route
 * answers `not_found`, exactly as if the feature did not exist (same convention as lib/regionEdit/flag.ts). Nothing here
 * enables the switch.
 */
export const RESULTS_DASHBOARD_FLAG = "NIGHTSHIFT_RESULTS_DASHBOARD";

export function resultsDashboardEnabled(raw: string | undefined = process.env.NIGHTSHIFT_RESULTS_DASHBOARD): boolean {
  return ["on", "1", "true", "yes"].includes(String(raw ?? "").trim().toLowerCase());
}

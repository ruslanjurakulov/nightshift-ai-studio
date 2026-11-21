/**
 * Is the region editor switched on? Evaluated on the SERVER at request time, default OFF.
 *
 * `NIGHTSHIFT_REGION_EDITOR=on` (also `1`, `true`, `yes`). Deliberately NOT a `NEXT_PUBLIC_` variable: those are
 * compiled into the browser bundle at build time, and a flag whose absence could leave a half-wired tool visible is
 * the failure this exists to prevent. An unset, empty or unrecognised value is "off": the page answers 404 and the
 * routes answer `not_found`, exactly as if the feature did not exist (same convention as
 * lib/server/release-flags.ts). Nothing here enables the switch.
 */
export const REGION_EDITOR_FLAG = "NIGHTSHIFT_REGION_EDITOR";

export function regionEditorEnabled(raw: string | undefined = process.env.NIGHTSHIFT_REGION_EDITOR): boolean {
  return ["on", "1", "true", "yes"].includes(String(raw ?? "").trim().toLowerCase());
}

/**
 * Is "one edit, several frame sizes" switched on? Evaluated on the SERVER at request time, default OFF.
 *
 * `NIGHTSHIFT_MULTI_RATIO_EXPORT=on` (also `1`, `true`, `yes`). Deliberately NOT a `NEXT_PUBLIC_` variable: those are
 * compiled into the browser bundle at build time, and a flag whose absence could leave a half-wired control visible is
 * the failure this exists to prevent. An unset, empty or unrecognised value is "off": the editor shows no size picker,
 * and POST /api/editor/projects/<id>/exports does not even read the `frames` field (same convention as
 * lib/imageEditor/flag.ts). The media worker reads the same name for its own half (modules/editor_export.py
 * FRAME_FLAG): one repository variable feeds both. Nothing here enables the switch.
 */
export const MULTI_RATIO_EXPORT_FLAG = "NIGHTSHIFT_MULTI_RATIO_EXPORT";

export function multiRatioExportEnabled(raw: string | undefined = process.env.NIGHTSHIFT_MULTI_RATIO_EXPORT): boolean {
  return ["on", "1", "true", "yes"].includes(String(raw ?? "").trim().toLowerCase());
}

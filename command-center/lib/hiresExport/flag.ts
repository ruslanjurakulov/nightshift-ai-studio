/**
 * Are 1440p and 4K exports offered here? Evaluated on the SERVER at request time, default OFF (migration 0132,
 * docs/HIRES_EXPORT.md).
 *
 * `NIGHTSHIFT_HIRES_EXPORT=on` (also `1`, `true`, `yes`). Not a `NEXT_PUBLIC_` variable, for the reason
 * lib/multiRatioExport/flag.ts gives. The paid frames ride on "Sizes to export", so they are offered only while
 * NIGHTSHIFT_MULTI_RATIO_EXPORT is on too. Off: the picker shows no paid frame, the quote route answers 404, and
 * POST /api/editor/projects/<id>/exports refuses a paid frame as an unknown one. The media worker reads the same name
 * for its own half (modules/hires_export.py FLAG): one repository variable feeds both. Nothing here enables the switch.
 */
export const HIRES_EXPORT_FLAG = "NIGHTSHIFT_HIRES_EXPORT";

export function hiresExportEnabled(raw: string | undefined = process.env.NIGHTSHIFT_HIRES_EXPORT): boolean {
  return ["on", "1", "true", "yes"].includes(String(raw ?? "").trim().toLowerCase());
}

/**
 * Exporting one edit in several frame sizes (migration 0129, NIGHTSHIFT_MULTI_RATIO_EXPORT): `t.editor.exportRatios`.
 * Own file so the main dictionaries only gain one line. English is the source: ru.ts and uz.ts are typed
 * `ExportRatiosDictionary`, so they must carry exactly these keys. The names of the sizes are the export formats'
 * (`t.editor.exportPreset.names`), not repeated here.
 */
export const exportRatiosEn = {
  legend: "Sizes to export",
  summaryOwn: "Sizes to export: this project's size",
  summaryCount: "Sizes to export: {count}",
  own: "This project's size",
  size: "{w} × {h}",
  hint: "Each size is a separate export and a separate video in your library, and each one counts toward the daily limit. You can start up to {max} at a time. Only the size of the picture changes. A clip with another shape keeps the fit you chose for it: bars, unless you chose to fill the frame or to blur the background.",
  atLimit: "That is {max} sizes, the most you can start at a time. Untick one to choose another.",
  none: "Choose at least one size to export.",
  blocked: "{name}: this edit cannot be exported in this size as it is. An effect is over its limit there. Choose this size under “Export format” to see what would change.",
  longFor: "{name}: this video is {length}, and this size works best up to {max}. You can still export it.",
  refused: "{name} was not started: {reason}",
  notAvailable: "Other sizes are not available on this server yet. Exporting in this project's size still works.",
  panelFor: "Latest export: {name}",
  mismatch: "This video is {w} × {h}, not the {fw} × {fh} that was asked for. The server rendered it in the project's size. Export this size again later.",
};

export type ExportRatiosDictionary = typeof exportRatiosEn;

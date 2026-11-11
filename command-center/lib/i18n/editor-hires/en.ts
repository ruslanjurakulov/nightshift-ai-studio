/**
 * 1440p and 4K exports, sold by the minute (migration 0132, NIGHTSHIFT_HIRES_EXPORT): `t.editor.exportHires`.
 * Own file so the main dictionaries only gain one line. English is the source: ru.ts and uz.ts are typed
 * `ExportHiresDictionary`, so they must carry exactly these keys. Every number in a sentence is the server's quote.
 */
export const exportHiresEn = {
  names: {
    youtube_1440p: "YouTube wide 16:9, 1440p",
    vertical_1440p: "Vertical 9:16, 1440p",
    youtube_2160p: "YouTube wide 16:9, 4K",
    vertical_2160p: "Vertical 9:16, 4K",
  },
  paidTag: "paid",
  intro: "Up to 1080p every export is free. 1440p and 4K take the server several times longer to render, so they cost credits for each started minute of video. A 1440p video can be up to {max1440}, a 4K video up to {max2160}.",
  loading: "Getting the price of {name}…",
  line: "{name}: {minutes} min × {perMinute} credits = {credits} credits",
  exemptLine: "{name}: nothing is held in this workspace.",
  available: "Available in this workspace: {available} credits.",
  total: "This export holds {credits} credits now. They are charged when the video is ready, and given back if it fails.",
  confirm: "Spend up to {credits} credits on this export",
  tooFast: "{name} is at most {max} frames per second, and this project is {fps}. Set the frame rate to {max} or lower under “Export format”, or choose 1440p.",
  notOnSale: "{name} is not on sale yet.",
  tooLong: "{name} can be at most {max} long, and this video is {length}. Shorten it to export in this size.",
  notAllowed: "{name}: only an editor, admin or owner of this workspace can spend its credits.",
  short: "{name} needs {credits} credits, and this workspace has {available}. Add credits or choose a smaller size.",
  failed: "The price of {name} could not be read.",
  retry: "Get the price again",
  saveFirst: "Save first: the price is for the saved version.",
};

export type ExportHiresDictionary = typeof exportHiresEn;

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
  line: "{name}: {minutes} min × {perMinute} credits = {credits} credits charged, {hold} held while it renders",
  exemptLine: "{name}: nothing is held in this workspace.",
  available: "Available in this workspace: {available} credits.",
  total: "This export holds {hold} credits while it renders and charges {credits} when the video is ready. The rest, and all of it if the export fails, is given back.",
  confirm: "Spend up to {credits} credits on this export",
  tooFast: "{name} is at most {max} frames per second, and this project is {fps}. Set the frame rate to {max} or lower under “Export format”, or choose 1440p.",
  notOnSale: "{name} is not on sale yet.",
  tooLong: "{name} can be at most {max} long, and this video is {length}. Shorten it to export in this size.",
  notAllowed: "{name}: only an editor, admin or owner of this workspace can spend its credits.",
  short: "{name} holds {hold} credits while it renders, and this workspace has {available}. Add credits or choose a smaller size.",
  speedCurve: "{name} cannot be exported for a video with a speed curve yet: its length cannot be priced. Remove the speed curve, or choose 1080p or smaller.",
  ownTooBig: "This project is larger than 1080p, and exports above 1080p are paid. Tick 1440p or 4K under “Sizes to export” and confirm the price, or set the project to 1080p or smaller under “Export format”.",
  ownTooBigOff: "This project is larger than 1080p, and exports above 1080p are paid and not offered here. Set the project to 1080p or smaller under “Export format” to export it.",
  failed: "The price of {name} could not be read.",
  retry: "Get the price again",
  freeLine: "{name}: free",
  introSold: "Every export costs credits for each started minute of video: up to 1080p, at 1440p and in 4K, each size at its own price. A 1440p video can be up to {max1440}, a 4K video up to {max2160}.",
  soldNoQuote: "Exports now cost credits, and this page cannot show their price yet. Try again later.",
  saveFirst: "Save first: the price is for the saved version.",
};

export type ExportHiresDictionary = typeof exportHiresEn;

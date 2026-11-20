/**
 * The download buttons of a finished file (stream S2): the original master and
 * its preview are always two different buttons. English is the source of
 * truth; ru.ts and uz.ts are typed against it.
 */
export const assetDownloadEn = {
  original: "Download original",
  originalSize: "Download original · {w}×{h}",
  originalHint: "The full-quality file, exactly as it was made.",
  preview: "Preview",
  previewHint: "A lighter copy for a quick look (480p for a video). It is not the file to publish.",
  captions: "Subtitles (SRT)",
  checking: "Preparing…",
  newTab: "(opens in a new tab)",
  retry: "Try again",
  errors: {
    unauthorized: "You are signed out. Sign in again to download.",
    not_found: "This file is no longer in your library.",
    gone: "The file was removed from storage. Export it again to get a new one.",
    media_unavailable: "Downloads are served from the Nightshift server, and this address cannot reach it.",
    no_captions: "This export has no subtitles.",
    no_preview: "This file has no preview yet.",
    failed: "The download could not start. Check your connection and try again.",
  },
};

export type AssetDownloadDictionary = typeof assetDownloadEn;
export type AssetDownloadError = keyof AssetDownloadDictionary["errors"];

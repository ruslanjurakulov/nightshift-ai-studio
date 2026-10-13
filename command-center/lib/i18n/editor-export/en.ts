/**
 * The editor's export status panel (components/editor/ExportStatusPanel.tsx).
 * English is the source: ru.ts and uz.ts are typed `ExportPanelDictionary`, so
 * they must carry exactly these keys. The status words and the failure
 * sentences themselves stay in `editor.exportStatus` / `editor.exportReasons`.
 */
export const editorExportEn = {
  region: "Export status",
  latest: "Latest export",
  queuedLine: "Your export is in line. It starts as soon as the server is free.",
  renderingLine: "The server is rendering your video. You can keep editing: this export uses the version you saved.",
  doneLine: "Your video is ready and saved in your library.",
  failedLine: "This export did not finish.",
  elapsed: "Elapsed {time}",
  tookLabel: "Took {time}",
  timeLeft: "Time left: unknown. The server does not report progress.",
  checkFailed: "Could not check this export just now. We keep trying.",
  checkNow: "Check now",
  checking: "Checking…",
  openVideo: "Open video",
  newTab: "(opens in a new tab)",
  noLink: "The video is in your library. Its preview link is not ready yet.",
  getLink: "Get the link",
  retry: "Try again",
  retryNeedsSave: "Save your changes to try again.",
  retryOtherVersion: "Trying again exports the version you saved now (version {rev}).",
  fixFirst: "Trying again would fail the same way. Change the edit, save it, then use Export video.",
};

export type ExportPanelDictionary = typeof editorExportEn;

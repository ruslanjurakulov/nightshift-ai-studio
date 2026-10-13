/**
 * Library niceties: sort by name, dropping files on the page, several files in
 * a row, and the selection bar's keyboard hint. English is the source of
 * truth; ru.ts and uz.ts are typed against it.
 */
export const libraryUxEn = {
  sortName: "Name, A to Z",
  dropHere: "Drop files to upload",
  dropHereFolder: "Drop files to upload into “{folder}”",
  dropHint: "You can also drop files onto this page.",
  cancelQueue: "Stop after this file",
  notSent: "{n} more files were not sent.",
  dropTooMany: "Only the first {max} files were taken.",
  queue: "File {i} of {n}",
  someFailed: "{failed} of {n} files could not be sent:",
  fileFailed: "{name}: {reason}",
  selectionHint: "Shift-click selects a range. Esc clears the selection.",
};

export type LibraryUxDictionary = typeof libraryUxEn;

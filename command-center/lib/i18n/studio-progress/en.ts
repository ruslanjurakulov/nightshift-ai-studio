/**
 * The Studio's generation placeholder (components/studio/GenerationPlaceholder): what a job is doing, from its row,
 * and the pill's number with what it is — an estimate from this organization's history, a reported figure, or only
 * the seconds since it started. English is the source of truth; ru.ts and uz.ts are typed against it.
 */
export const studioProgressEn = {
  phase: {
    queued: "Waiting in line",
    sending: "Sending to the model",
    making: "The model is working",
    storing: "Saving to your library",
    done: "Ready",
    failed: "Did not finish",
  },
  // A placeholder in place of the result, for a screen reader: what is coming.
  coming: "{kind} on its way",
  loadingResult: "Ready — loading the result",
  estimate: "~{n}%",
  estimateSpoken: "About {n}% done. An estimate from how long this model's last {count} jobs here took, not a measurement.",
  reported: "{n}%",
  reportedSpoken: "{n}% done, as the model reports it.",
  seconds: "{n} s",
  minutes: "{m} min {s} s",
  // Seconds without an estimate, each with its real reason (lib/creative/progress.ts NoEstimate): "too little history"
  // is said only when the history was read and is too short.
  elapsedSpoken: "{n} seconds since it started. No estimate: this model has fewer than {min} finished jobs here.",
  elapsedUnreadSpoken: "{n} seconds since it started. No estimate: this model's past jobs here have not been read.",
  elapsedNotAskedSpoken: "{n} seconds since it started. No estimate: with this many models working at once, only {max} are looked up.",
  elapsedNoStartSpoken: "{n} seconds since it was asked for. No estimate: the time it started is not recorded.",
  waitingSpoken: "{n} seconds in line.",
};

export type StudioProgressDictionary = typeof studioProgressEn;

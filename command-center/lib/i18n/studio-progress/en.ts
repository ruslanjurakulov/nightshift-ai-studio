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
  elapsedSpoken: "{n} seconds since it started. No estimate: this model has fewer than 3 finished jobs here.",
  waitingSpoken: "{n} seconds in line.",
};

export type StudioProgressDictionary = typeof studioProgressEn;

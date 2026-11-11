/**
 * Voice-over recorded in the editor (`t.editor.voiceOver`). Own file so the main dictionaries only gain one line.
 * English is the source: ru.ts and uz.ts are typed `VoiceOverDictionary`, so they must carry exactly these keys.
 * The ru and uz sentences are DRAFTS: have a native speaker read them.
 */
export const voiceOverEn = {
  open: "Record voice-over",
  title: "Record a voice-over",
  close: "Close",
  hint: "Up to {max}. Your browser asks to use the microphone each time you press Record; nothing is recorded before that.",
  record: "Record",
  stop: "Stop",
  cancel: "Cancel",
  retake: "Re-take",
  discard: "Discard",
  add: "Add to timeline",
  addAt: "Adds the take as a sound at {at}, and keeps it in your library.",
  preview: "Listen to the take",
  level: "Microphone level",
  elapsed: "{now} of {max}",
  requesting: "Waiting for your permission to use the microphone…",
  recording: "Recording. Press Stop when you are done.",
  recorded: "Take ready: {length}. Listen to it, then add it or record again.",
  hitMax: "Stopped at the {max} limit.",
  uploading: "Uploading the take to your library…",
  checking: "Checking the recording…",
  added: "Added to the timeline at {at}. It is in your library as “{name}”.",
  unsupported: "This browser cannot record sound here. Try a current Chrome, Edge, Firefox or Safari.",
  blockedBySite: "The microphone is not enabled on this page yet. Reload the page to turn it on.",
  reload: "Reload page",
  denied: "Microphone access was blocked. Allow the microphone for this site in your browser settings, then try again.",
  noDevice: "No microphone was found. Connect one and try again.",
  failed: "The recording stopped unexpectedly. Try again.",
  tooShort: "That take was {length}, shorter than {min}. Record again.",
  pastMax: "The page was in the background, so it stopped after the {max} limit. The whole take is kept; trim it on the timeline.",
  tooLarge: "The take is larger than {max}, so it cannot be uploaded. Record a shorter one.",
  uploadFailed: "The take could not be uploaded.",
  rejected: "The server refused the recording.",
  expired: "The upload window closed before the server checked the take. Try again.",
  stillChecking: "The take was uploaded and is still being checked. It will appear under Add sound shortly.",
  notAudio: "The server did not store the take as a sound with a length, so it was not added.",
  full: "The take is in your library, but this project has no room for another sound. Remove one, then add it from Add sound.",
  tryAgain: "Try again",
  recordAgain: "Record again",
};

export type VoiceOverDictionary = typeof voiceOverEn;

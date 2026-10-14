/**
 * "Improve with AI" on a file (library tile, library viewer, editor clip or
 * overlay picture): the menu, what each tool does, the honest unavailable
 * state, and "Add to project". English is the source of truth; ru.ts and
 * uz.ts are typed against it. No prices here: the Studio shows the price.
 */
export const improveEn = {
  action: "Improve with AI",
  actionFor: "Improve with AI: {name}",
  title: "Improve with AI",
  lead: "Choose what to do with “{name}”. Nothing starts here: the next page shows the price first, and you start it yourself.",
  close: "Close",
  unavailable: "Not available on this deployment yet",
  inEditor: "Made in the editor",
  tools: {
    upscale: { label: "Upscale", hint: "Make the picture sharper and bigger." },
    remove_bg: { label: "Cut out", hint: "Remove the background and keep the subject." },
    edit: { label: "Edit by prompt", hint: "Change the picture by describing what you want." },
    i2v: { label: "Animate", hint: "Turn the picture into a short clip." },
    video_upscale: { label: "Upscale video", hint: "Make the video sharper and bigger." },
    captions: { label: "Captions", hint: "Write what is said as subtitles, then style them." },
    voice_change: { label: "Change voice", hint: "Say the same words in another voice." },
    dub: { label: "Dub", hint: "Speak it in another language." },
  },
  // Started from an editor project: what the Studio says and offers.
  fromProject: "You came from a project. When your result is ready, add it back with “Add to project”.",
  backToProject: "Back to the project",
  addToProject: "Add to project",
  addToProjectFor: "Add to project: {name}",
  // The editor, opened with a finished result.
  offerTitle: "Add “{name}” to this project?",
  offerBody: "It is in your library now. Adding it puts it in the project; nothing is saved or exported until you do that.",
  offerAdd: "Add to project",
  offerNotNow: "Not now",
  offerAdded: "Added to the project. Save to keep it.",
  offerMissing: "This file is not among the library files the editor can take (a picture, video or sound).",
  offerFailed: "It could not be added: the project is full.",
  offerNoDuration: "It cannot be added yet: this file has no length the editor can read.",
  unnamed: "this file",
};

export type ImproveDictionary = typeof improveEn;

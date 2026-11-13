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
  // The panel: a tool, a model, and what should change. Pressing send only opens the Studio, which shows the price.
  panel: {
    lead: "“{name}”: pick a tool and a model, then say what should change. Nothing starts here: the Studio shows the price first, and you start it yourself.",
    toolLegend: "Tool",
    modelLabel: "Model",
    auto: "Auto — the Studio picks a model at the price it shows",
    preview: "{name} · preview",
    beta: "{name} · beta",
    modelNone: "No model is offered for this tool here, so it cannot be opened.",
    modelStudio: "The Studio picks the model (the list could not be read here).",
    wordsLabel: "What should change?",
    wordsRequired: "Describe the change",
    wordsOptional: "Optional: say what should change",
    wordsNone: "This tool works without words",
    wordsRequiredHint: "This tool needs a few words before the Studio can price it.",
    wordsNoneHint: "This tool needs no words: it works on the file as it is.",
    enterHint: "Enter opens the Studio · Shift+Enter for a new line",
    send: "See the price",
    sendFor: "See the price in the Studio: {tool}",
    captions: "Make captions in the editor",
    note: "The Studio opens with this file, tool, model and words filled in. Nothing is priced, held or spent until you press its Generate.",
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

/**
 * /create, the composer-first Studio (components/studio/StudioHome.tsx).
 * English is the source of truth; ru.ts and uz.ts are typed against it.
 *
 * No prices here (the button shows the quote), no speed or quality promise,
 * no provider names, and the page's own words never say "desk".
 */
export const studioHomeEn = {
  title: "What shall we make today?",
  lead: "Write what you want. The price is on the button before anything starts.",
  modesLabel: "What to make",
  modes: { image: "Image", video: "Video", voice: "Voice", enhance: "Enhance", youtube: "YouTube video" },
  /** The [+] button: what it adds on each mode. */
  attach: {
    image: "Add a picture",
    video: "Start from a picture",
    voice: "Add a recording",
    enhance: "Choose a file",
  },
  attachRemove: "Remove the attachment",
  settings: "Settings",
  settingsFor: "Settings: {summary}",
  settingsClose: "Hide settings",
  modelButton: "Model: {name}. Change the model",
  modelNone: "No model",
  enterHint: "Enter sends · Shift+Enter for a new line",
  composerLabel: "Composer",
  plan: {
    toggle: "Plan",
    toggleLabel: "Make a plan: one goal, several items, one total price",
    goalLabel: "Your goal",
    send: "Make a plan",
    note: "Making a plan only asks prices. Nothing starts until you confirm the total.",
  },
  youtube: {
    label: "Video topic",
    placeholder: "What is the video about? For example: how a silk carpet is woven in Khiva",
    send: "Continue",
    note: "The next page shows the price and asks you before the video starts.",
  },
  examples: {
    title: "Start from an example",
    lead: "A card fills the box above: the kind, the model and the words. Nothing starts until you press send.",
    use: "Use this example: {prompt}",
    listLabel: "Examples",
  },
  recent: {
    title: "Your recent work",
    emptyTitle: "Your work will appear here",
    emptyBody: "Write something above, or start from an example.",
    emptyAction: "Pick an example",
    all: "Open the library",
  },
  advanced: {
    title: "Advanced",
    lead: "A full page for each kind of work, with every option laid out, plus your credits and edit projects.",
    pages: {
      image: "Image page",
      video: "Video page",
      voice: "Voice page",
      enhance: "Enhance page",
      youtube: "YouTube video page",
    },
    presets: "Presets",
  },
  actions: {
    animate: "Make a video from this image",
    enhance: "Enhance this image",
    download: "Download",
  },
};

export type StudioHomeDictionary = typeof studioHomeEn;

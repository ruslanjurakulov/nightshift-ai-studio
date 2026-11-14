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
  /**
   * The [+] that takes a picture or a video from the device (lib/creative/attach.ts), and the file attached on the public home page,
   * picked up here (lib/site/pending-attachment.ts). The file goes into the library first; the tool is then chosen by its kind and
   * that change is said in one line. Nothing is priced or started by attaching.
   */
  attachFlow: {
    pick: "Attach a picture or a video",
    uploading: "Putting “{name}” in your library…",
    switchedImage: "Picture attached, so the tool is now {tool}. You can pick another tool above.",
    switchedVideo: "Video attached, so the tool is now {tool}. You can pick another tool above.",
    gone: "The file you attached on the home page is not in this browser any more (it is kept only in the browser it was chosen in). Attach it again with +.",
    expired: "The file you attached on the home page was kept for an hour and has been removed. Attach it again with +.",
    unreadable: "This browser does not let the page read the file you attached on the home page. Attach it again with +.",
    noOrg: "There is no workspace to put the file in yet. Once you have one, attach the file again with +.",
    badType: "That file is not a picture or a video the library takes (JPEG, PNG, WebP, GIF, HEIC, MP4, MOV, WebM, MKV).",
    tooBig: "That file is larger than {max}, the most one upload can be.",
    emptyFile: "That file is empty.",
    rejected: "The library refused this file after checking it. Try another picture or video.",
    expiredTicket: "The upload window closed before the file was checked. Try again.",
    stillChecking: "The file is uploaded and still being checked. It will be in your library shortly; choose it there.",
    wrongKind: "The library did not store this file as a picture or a video, so it was not attached.",
    uploadForbidden: "The library would not show this upload to your account. Sign in again, then attach the file again with +.",
    uploadGone: "The upload is no longer in the library (it was dismissed or cleaned up). Attach the file again with +.",
    /**
     * The home page's file, before anything is uploaded: the person decides (Use / Discard). Neutral words only, no picture and no
     * name: the person who signed in may not be the one who chose the file (a shared browser), so nothing of it is shown until Use.
     */
    confirmImage: "A picture was attached on the home page in this browser. Use it?",
    confirmVideo: "A video was attached on the home page in this browser. Use it?",
    confirmNote: "It is shown, and goes into your library, only if you choose Use. Nothing is made until you press Generate.",
    confirmUse: "Use it",
    confirmDiscard: "Discard",
    discarded: "The file was discarded. It was never uploaded.",
    /** The upload finished after the person had moved on (another mode, another box, a press of Generate): offered, not forced. */
    ready: "“{name}” is in your library.",
    readyUse: "Use it in the box",
  },
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
    downloadFailed: "The file could not be prepared. Try again.",
  },
};

export type StudioHomeDictionary = typeof studioHomeEn;

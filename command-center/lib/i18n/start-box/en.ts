/**
 * The app's start box (components/prompt/StartBox.tsx): Home and the Studio start. It only opens a place, filled; the place shows
 * the price and only its own press starts anything, which is why every note says where the words go and that nothing runs here.
 */
export const startBoxEn = {
  tabsLabel: "What to do",
  tabs: { create: "Create", edit: "AI edit" },
  label: { create: "Your idea", edit: "What to change" },
  placeholder: {
    film: "A short film about a lighthouse keeper who finds a message in a bottle",
    ad: "A 30-second ad for a family bakery in Tashkent, warm morning light",
    channel: "The topic of your channel's next video",
    video: "A slow drone shot over a misty mountain lake at sunrise…",
    image: "A cosy neon-lit noodle bar on a rainy Tashkent street…",
    audio: "A warm, calm voice reading: Welcome to our channel…",
    edit: "Make it night, add soft rain, keep the faces as they are",
  },
  submit: { create: "Continue", agent: "Open in Nightshift AI", channel: "Open the run form", connect: "Connect a channel", edit: "Open the edit desk" },
  note: {
    create: "Nothing runs here. Create opens with your words and shows the price before you send.",
    agent: "Nightshift AI asks a few questions, shaped by the format you chose, and drafts the video. Nothing is charged until you press Create there and see the price.",
    /** {channel}: the channel's name. */
    channel: "Opens the run form for {channel} with this topic. It shows the price and asks before it runs.",
    connect: "A channel video is made for a connected YouTube channel. Connect one first.",
    edit: "Opens the Enhance desk with your words. Choose the clip to change there; it shows the price before anything runs.",
  },
  empty: "Write a few words first.",
  /** {n} characters of {max}: shown only near the limit. */
  count: "{n} of {max}",
  /** {max}: TOPIC_MAX. Said before the press, so nobody finds a shorter topic on the form by surprise. */
  topicCut: "A channel video's topic is at most {max} characters: only the first {max} go to the run form.",
  editCut: "The edit desk takes at most {max} characters: shorten the words, or only the first {max} go there.",
  storageRefused: "This browser would not keep your words, so they cannot be carried over. Allow site data for Nightshift, or copy them first.",
  agent: {
    label: "Agent",
    /** The chip's tooltip and its accessible description when it can be used. */
    hint: "Nightshift AI plans the video with you",
    closed: "Not open for this workspace yet",
  },
  formatLabel: "Format",
  formats: { film: "AI film", ad: "Ad", channel: "Channel video" },
  received: { cut: "These words were longer than this tool takes, so only the first {max} characters are in the box. Check the end before you send." },
  library: {
    title: "Start from a template",
    lead: "Open a template: its model, shape and length come with it.",
    all: "All templates",
    purposes: { storytelling: "Storytelling", marketing: "Marketing", brand: "Brand assets" },
    loading: "Loading templates…",
    error: "Couldn't load the templates.",
    retry: "Try again",
    empty: "No templates yet.",
    notEnabled: "Templates are not switched on here yet.",
    signedOut: "Your session ended. Sign in again to see the templates.",
    /** {title}: the template's name. */
    use: "Open “{title}” in Create",
    kind: { video: "Video", image: "Image" },
  },
};

export type StartBoxDictionary = typeof startBoxEn;

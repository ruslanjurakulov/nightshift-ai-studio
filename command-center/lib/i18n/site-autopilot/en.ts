import { pillarEn } from "../autopilot-pillar/en";

/**
 * The landing's autopilot walk-through (components/site/AutopilotDemo.tsx) and the phone's Shorts feed of the vertical samples
 * (components/site/ShortsFeed.tsx). English is the source of truth; ru.ts and uz.ts are typed against it.
 *
 * The walk-through's files are shown as they are written (in English): these strings only frame them. Every sentence about
 * publishing says what CLAUDE.md rules 2 and 3 and docs/APPROVE_PUBLISH_1B.md say: uploads are private, approving changes
 * nothing on YouTube by itself, and the two switches that change that are per channel and off until someone turns them on.
 * No provider is named (tests/helpers/brands.ts).
 */
export const siteAutopilotEn = {
  demo: {
    label: "Autopilot",
    title: "One topic in. A private video out. You decide the rest.",
    lead: "The run Nightshift does for a channel, stage by stage. Each step shows a real file from our repository: the sample script our render test runs on, and the video engine’s scene files. Where there is no file to show, you see a mock of the app’s screen, marked as one.",
    rail: "The stages of one run",
    stepOf: "Step {n} of {total}",
    prev: "Previous stage",
    next: "Next stage",
    fileTag: "Sample file from our repository",
    mockTag: "Mock of the app’s screen",
    rulesTag: "How it works",
    fileNote: "Shown as written in the file, in English.",
    mockNote: "A drawing of the screen, filled with the sample script’s words. Not a real upload.",
    source: "From",
    stages: [
      {
        id: "topic",
        name: "Topic",
        title: "It starts from a topic",
        body: "A topic from the channel’s plan, or one you typed. Before anything is paid for, the run checks that the voice and the picture models the channel is set to can really be reached.",
      },
      {
        id: "research",
        name: "Research",
        title: "Research, then every claim checked",
        body: "It gathers what is known about the topic and, once the script is written, checks each claim in it. A claim it cannot verify is marked for a person, never passed as true.",
      },
      {
        id: "script",
        name: "Script",
        title: "A script in sections, hook first",
        body: "Two titles to compare, and sections with the length each one asks for. The lengths are what the script plans, not a measurement.",
      },
      {
        id: "voice",
        name: "Voice",
        title: "Narrated with its cues",
        body: "The narrator reads the script with its pauses, music and sound cues, and every word is timed for the captions. If the channel’s voice cannot be reached, the run stops: it never switches to another voice.",
      },
      {
        id: "visuals",
        name: "Visuals",
        title: "Footage words and a thumbnail plan",
        body: "Each section carries the search words for its footage. The thumbnail gets two prompts to compare and the text that goes over it.",
      },
      {
        id: "render",
        name: "Render",
        title: "Scenes built from recipes",
        body: "The video engine builds each scene from a recipe: a title card, a map zoom, a timeline, a quote, an evidence card, a slow push.",
      },
      {
        id: "upload",
        name: "Private upload",
        title: "Uploaded as private",
        body: "The finished video goes to your channel as private: only you and the people you share it with can watch it. A publish check runs on it.",
      },
      {
        id: "approve",
        name: "Your approval",
        title: "You watch it, then approve",
        body: "You approve one exact version. The app records who approved which version, for 24 hours, and approving does not by itself change the video’s privacy.",
      },
      {
        id: "publish",
        name: "Publish",
        title: "Public only by your decision",
        body: "By default you make the video public yourself, on YouTube. Two per-channel settings change that, and both stay off until they are turned on: auto-publish, and “Publish when approved”.",
      },
    ],
    topic: { topic: "Topic", hook: "Hook" },
    research: {
      claim: "Claim",
      status: "Fact-check",
      statuses: { likely_accurate: "Likely accurate", unverifiable: "Could not be verified" },
      review: "Marked for a person to check",
    },
    script: { titleA: "Title A", titleB: "Title B", sections: "Sections", seconds: "{n} s planned" },
    voice: {
      narration: "What the narrator reads (hook)",
      cue: "Cue",
      words: "Words timed for the captions",
      span: "{from}–{to} s",
      noAudio: "No recording is kept in the repository, so nothing plays here.",
    },
    visuals: { keywords: "Footage search words", thumbA: "Thumbnail prompt A", thumbB: "Thumbnail prompt B", overlay: "Text over the thumbnail" },
    render: { scene: "Scene", recipe: "Recipe", transition: "Transition" },
    upload: {
      screen: "Upload",
      title: "Title",
      privacy: "Privacy on YouTube",
      private: "Private",
      tags: "Tags",
      check: "Publish check",
      checkNote: "Runs before anything can go public; its verdict is shown on the video’s page.",
    },
    approve: {
      screen: "Video page",
      privacy: "Private",
      button: "Approve",
      records: "Records who approved this exact version (its fingerprint), until when (24 hours) and what they acknowledged.",
      unchanged: "The video stays private.",
    },
    publish: {
      defaultTitle: "By default",
      defaultBody: "You make the video public on YouTube, when you are ready.",
      autoTitle: "Auto-publish",
      autoBody: "A per-channel switch, off by default. The publish check runs in front of it.",
      approvedTitle: "“Publish when approved”",
      approvedSteps: [
        "Off by default for every channel. Only someone who manages the workspace can switch it on, on purpose, by typing a confirmation word, never the bot; one tap switches it off.",
        "With it on, approving one exact version queues one request.",
        "Just before acting, the worker asks the database again: still the approved version, the approval not expired, the publish check’s verdict stored and allowed, the switch still on.",
        "It asks YouTube once to make that video public, then reads the video back. The app says “Published” only when YouTube’s answer says public.",
        "If anything fails before YouTube is asked, the video stays private; after that, the app records only what YouTube reports.",
      ],
    },
    cta: {
      title: "Put your channel on autopilot, with your hand on the switch.",
      body: "Start free. Every upload is private, and nothing goes public unless you make it public or turn on a setting that does.",
      primary: "Start free",
      secondary: "How publishing works",
    },
  },
  /** The YouTube Autopilot pillar, /solutions/youtube-channels (lib/i18n/autopilot-pillar). */
  pillar: pillarEn,
  shorts: {
    open: "Watch as Shorts",
    openNote: "{n} vertical samples, full screen",
    dialog: "Our vertical samples, one at a time",
    close: "Close",
    prev: "Previous clip",
    next: "Next clip",
    play: "Play",
    pause: "Pause",
    unmute: "Turn sound on",
    mute: "Turn sound off",
    noSound: "This clip has no sound",
    position: "{n} of {total}",
    hint: "Swipe up for the next one",
  },
};

export type SiteAutopilotDictionary = typeof siteAutopilotEn;

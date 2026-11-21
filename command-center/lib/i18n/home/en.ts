/**
 * The public landing page "/" (components/landing/home/HomePage.tsx). English is the source; ru.ts and uz.ts are typed against it.
 *
 * Claims, each checked against the code (change the code, change the sentence):
 *  - "the price is on the button before anything starts": the Studio quotes every job before it runs (creative_price, PriceButton).
 *  - "YouTube uploads are private by default": CLAUDE.md rule 2, config.YOUTUBE_PRIVACY, /trust "Uploads are private by default".
 *    Never "until you approve": Approve alone does not change privacy (tests/approve-copy-truth.test.ts).
 *  - the MCP lines: the two states of MCP_OAUTH_LIVE (lib/mcp-oauth.ts), worded as /mcp words them (lib/i18n/site/dev-en.ts).
 *  - the model strip: migration 0193 public_models_on_sale; nothing is drawn when it cannot be read.
 * The trust section quotes /trust (t.site.trust) rather than paraphrasing it, so the two cannot disagree.
 * No numbers here: no user counts, no speed or quality promise, no testimonials. A model is named only where it is on sale (the
 * strip) or where it made the piece shown above its name (the reel's credit line).
 */
export const homeEn = {
  hero: {
    eyebrow: "Nightshift Studio",
    /** A no-break space before the dash, so a narrow screen never starts a line with it. */
    title: "From idea to finished video — one Studio",
    lead: "Write an idea. Nightshift turns it into pictures, clips, voice and a finished video, with the price on the button before anything starts.",
    primary: "Start creating",
    secondary: "See how it works",
    reelLabel: "Made in Nightshift Studio",
    reelNote: "Every piece here was made in our own Studio, with the models that made it named under it.",
    /** Joins the last two model names in a credit: "Ideogram 4.5 and MiniMax H3". */
    and: "and",
    /** {model}: the registry display name of the model that made the piece (lib/creative/model-names.ts). */
    credit: "Made with {model} in Nightshift Studio",
    /** The reel's titles for pieces whose data carries none (components/landing/home/home-reel.ts REEL keys). */
    reelTitles: {
      whaleCity: "A whale over the city at sunset",
      lighthouse: "A storm wave hits the lighthouse",
      snowGlobe: "A neon city in a snow globe",
      giantSneaker: "A giant sneaker lands in the rain",
      oldCity: "An old city at golden hour",
      coastRoad: "A road along the ocean cliffs",
      scaleShock: "Something enormous beneath the boat",
      drones: "Drones over a neon highway",
      stormJar: "A storm in a jar",
      samarkand: "Samarkand, from the sky to the table",
      aboveClouds: "Sunrise above the clouds",
    },
    /** The captions track's name (language-duo's spoken lines are English). */
    captions: "English",
    ai: "AI-generated",
  },
  how: {
    title: "How it works",
    lead: "Three steps, one place.",
    steps: [
      { id: "idea", label: "Idea", title: "Describe it", body: "Type what you want, or start from a template. Add a picture or a voice of your own if you have one." },
      { id: "create", label: "Create", title: "Make it", body: "Pictures, clips and voice from the models on sale, each priced on its button before it starts." },
      { id: "export", label: "Export", title: "Take it out", body: "Download the finished video, or send it to your channel. YouTube uploads are private by default." },
    ],
  },
  models: {
    title: "Models in the Studio today",
    lead: "The models you can use right now, read from the Studio itself: when one is added or retired, this list changes with it.",
    kinds: { video: "Video", image: "Image", voice: "Voice" },
    listLabel: "Models on sale",
    /** 0192: the maker's terms are 18+; the app's own words for it (t.studio.lock.adult_only). */
    adultOnly: "For adults (18+)",
  },
  mcp: {
    tag: "MCP",
    titleLive: "Works inside Claude and ChatGPT",
    bodyLive: "Connect Nightshift to Claude, ChatGPT, Cursor or VS Code and ask for a video in plain words. Your assistant spends credits only up to the monthly limit you set, and publishing still waits for you.",
    titleOff: "Works inside your AI assistant",
    bodyOff: "Connect Cursor or VS Code with an API key today and ask for a video in plain words. Sign-in for Claude and ChatGPT is coming soon.",
    cta: "How to connect",
  },
  trust: {
    title: "Trust and safety",
    lead: "What Nightshift does with your channel, your keys and your money, in the words of our Trust and safety page.",
    more: "Read the full page",
  },
  final: {
    title: "Start with an idea",
    lead: "Sign up, write what you want, and see the price before anything is made.",
    cta: "Start creating",
    pricing: "See pricing",
  },
};

export type HomeDictionary = typeof homeEn;

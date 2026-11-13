/**
 * The public model pages (/models and /models/<slug>, components/site/ModelPages.tsx). No model or maker is named here: the name
 * comes from the data ({model}, lib/site/model-facts.json), and only on a page that shows that model's own samples
 * (tests/site-copy.test.ts holds every dictionary to that). No price, speed or availability is claimed beyond what the page can
 * read: the availability lines follow the registry's flags the sample cards use (lib/site/model-pages.ts modelAvailability).
 */
export const modelPagesEn = {
  meta: {
    indexTitle: "AI models and their samples · Nightshift",
    indexDescription: "Real video and picture samples from our own Studio, grouped by the AI model that made each one, with the words it was given.",
    /** {model}: the registry's display name. Kept short: a long model name must still fit a search result's title. */
    title: "{model}: samples and what it can do · Nightshift",
    description: "Real samples made with {model} in our Studio, with their prompts, and the shapes, lengths and inputs the Studio can ask it for.",
    ogAlt: "AI-generated sample made by {model}",
  },
  crumbs: { label: "Breadcrumb", home: "Home", models: "Models" },
  index: {
    label: "Models",
    title: "AI models and their samples",
    lead: "Every model here made at least one of the samples on our site, in our own Studio. Open one to see all its samples, the words each was given and what the Studio can ask it for.",
    count: "Samples: {n}",
    video: "Video model",
    image: "Picture model",
    open: "Samples and details",
    openAria: "{model}: samples and details",
    empty: "No samples have been published yet, so there are no model pages yet.",
  },
  hero: {
    label: "AI model",
    lead: "Real samples made with {model} in our own Studio, each with the words it was given.",
    count: "Samples on this page: {n}",
    start: "Start free",
    allModels: "All models",
  },
  availability: {
    title: "In the Studio",
    /**
     * The registry's operator preview: only the platform's own team may run it (migration 0139). It says nothing about whether or
     * when customers will get it, so the line promises no future.
     */
    preview: "Not in the Studio yet. Only our own team can run it today.",
    /** The vendor's announced shutdown day has come. {date} is that day. */
    gone: "No longer in the Studio: its maker shut it down on {date}.",
    /** Neither flag: the page cannot know what a workspace may choose (that is the database's answer, read signed in). */
    unknown: "The Studio shows which models your workspace can choose, and the price, before anything starts.",
  },
  can: {
    title: "What it can do",
    lead: "What our Studio can ask this model for, from the model’s entry in our registry: exactly what the Studio sends it.",
    makes: "Makes",
    video: "Video",
    image: "Pictures",
    tools: "Tools",
    ratios: "Aspect ratios",
    /** One tool that takes fewer shapes than the model: "Video from words: 16:9, 9:16". */
    ratiosFor: "{tool}: {ratios}",
    lengths: "Clip lengths",
    range: "{min}–{max} seconds",
    seconds: "{n} s",
    resolutions: "Resolutions",
    inputs: "It starts from",
    words: "Words",
    picture: "A picture to start from",
    endFrame: "A picture to end on",
    sound: "Sound",
    soundYes: "The clip comes with sound it makes itself",
    soundNo: "Silent: the clip has no sound of its own",
  },
  /** The Studio tools a page can name. A model with a tool missing here is caught by tests/model-pages.test.tsx. */
  caps: {
    t2v: "Video from words",
    i2v: "Animate a picture",
    t2i: "Picture from words",
    edit: "Edit a picture",
  },
  price: {
    title: "Price",
    /** A model that is not on sale (operator preview or shut down). */
    none: "It is not on sale, so it has no price.",
    studio: "The Studio shows the price of every run before anything starts.",
    pricing: "See credit packs",
  },
  samples: {
    title: "More samples made with {model}",
    lead: "Every other sample of this model on our site, each with the words it was given and the day it was made.",
  },
  more: {
    title: "Other models",
    lead: "Each of these made samples on our site too.",
  },
  final: {
    title: "Make your own",
    lead: "Start free. The Studio shows the model and the price before anything starts.",
    start: "Start free",
    pricing: "See pricing",
  },
};

export type ModelPagesDictionary = typeof modelPagesEn;

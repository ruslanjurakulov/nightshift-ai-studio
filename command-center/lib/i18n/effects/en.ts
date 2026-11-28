/**
 * Effects (lib/effects/catalog.ts): the Studio's Effects desk, the banner over the composer an effect opens, and the public
 * site's Effects section. English is the source of truth; ru.ts and uz.ts are typed against it.
 *
 * The prompts themselves are not here: they are English in every language (lib/effects/effects.json). Nothing on the public side
 * names a model or its maker (tests/helpers/brands.ts): the Studio card names the model, because there it is the one that runs.
 */
import type { EffectId } from "@/lib/effects/shared";

/** One effect's copy: a picture effect says what picture works; a words effect asks for its subject, with an example. */
export interface EffectCopy {
  name: string;
  line: string;
  picture?: string;
  subject?: string;
  example?: string;
}

export const effectsEn = {
  items: {
    "photo-to-life": {
      name: "Bring a photo to life",
      line: "Your photo starts to move: a breeze, a blink, the light shifting, the camera drifting in.",
      picture: "A sharp photo with one clear subject works best.",
    },
    "product-burst": {
      name: "Product burst",
      line: "Your product bursts into paint and sparkles, then snaps back together.",
      picture: "A product photo on a plain background works best.",
    },
    "liquid-reveal": {
      name: "Liquid reveal",
      line: "A glossy liquid spiral wraps your product and falls away to reveal it.",
      picture: "A product photo on a plain background works best.",
    },
    "giant-in-the-city": {
      name: "Giant in the city",
      line: "Anything at colossal scale, walking down a street, as if filmed on a phone.",
      subject: "Who or what is giant?",
      example: "a ginger cat",
    },
    "snow-globe": {
      name: "World in a snow globe",
      line: "A tiny world inside a snow globe, shaken so the snow swirls.",
      subject: "What is inside the globe?",
      example: "a lighthouse on a rocky island",
    },
    "orbit-to-street": {
      name: "Orbit to street",
      line: "One shot from space down through the clouds to street level.",
      subject: "Where does the camera land?",
      example: "the old town of Bukhara",
    },
    "satisfying-macro": {
      name: "Satisfying macro",
      line: "A material shapes itself into a perfect form, in close-up.",
      subject: "Which material?",
      example: "glossy pink clay",
    },
    "time-freeze": {
      name: "Time freeze 360",
      line: "One moment frozen mid-air while the camera circles all the way round it.",
      subject: "What moment is frozen?",
      example: "a skateboarder mid-jump over a puddle",
    },
  } satisfies Record<EffectId, EffectCopy> as Record<EffectId, EffectCopy>,
  kinds: { t2v: "From words", i2v: "From a picture" },
  needs: { none: "You write the subject", picture: "You add one picture" },
  /** The card's drawing until a real sample exists: said in words, so it is never taken for a result. */
  noSample: "No sample yet: this is a drawing, not a result",
  sample: "A real result made in the Studio",
  desk: {
    title: "Effects",
    note: "Nothing is priced or started on this page. An effect has no price of its own: the clip costs what the same clip costs in the video form.",
    listLabel: "Effects",
    use: "Use this effect",
    useAria: "Use this effect: {name}",
    model: "Model",
    shape: "Shape",
    length: "Length",
    seconds: "{n} s",
    ownShape: "the model's own",
    pictureShape: "the picture's",
    preview: "Operator preview",
    previewNote: "Only your operator workspace is offered this model; customers do not see it yet.",
    nextChoice: "Its first-choice model is not open in this workspace, so it uses the next one on its list.",
    unavailable: "Not open here yet",
    unavailableNote: "None of the models this effect is written for is offered in this workspace yet. Nothing runs from this card.",
    noOrg: "Effects open in a workspace. Pick or create one first.",
  },
  banner: {
    label: "Effect",
    model: "Model: {model}",
    subjectHint: "Write it in a few words and press the button: it takes the place of the [words in brackets] in the description below. You can also edit the description itself.",
    apply: "Put it in",
    pictureHint: "Pick the picture in the form below.",
    promptNote: "The description is the effect's own, in English on purpose: video models follow English best. You can still change the words, the model, the shape or the length before you press Generate.",
    priceNote: "The price shows on Generate, as for any clip. Nothing runs until you press it.",
    all: "All effects",
    unavailableTitle: "This effect is not open here yet",
    unavailableBody: "None of the models it is written for is offered in this workspace, so nothing was filled in and nothing can run. It is not switched to another model for you.",
    plainTool: "Open the plain video form",
  },
  site: {
    label: "Effects",
    title: "Named shots, one press to start",
    lead: "Pick an effect, add your subject or one picture, and the Studio fills in the rest: the words, the shape and the length.",
    note: "Opens the Studio after you sign up. There you see which model the effect uses and the price before anything runs; an effect whose model is not open to your workspace yet says so.",
    listLabel: "Effects",
    use: "Use this effect",
    useAria: "Use this effect: {name}",
    /** The card's corner mark on an effect whose frame is still a drawing (not a result, so never "AI-generated"). */
    drawing: "Drawing",
  },
};

export type EffectsDictionary = typeof effectsEn;

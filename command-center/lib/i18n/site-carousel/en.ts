/**
 * The landing's three moving pieces over our own samples (components/site/ShowcaseCarousel.tsx, BeforeAfter.tsx, PromptTicker.tsx).
 * English is the source of truth; ru.ts and uz.ts are typed against it.
 *
 * Every sentence describes what the piece does: the clips are real generations from our Studio (lib/site/showcase.json), the
 * prompts are their own words, and a shortened prompt says it is shortened. No model or maker is named here: a model is named only
 * inside its own sample's box, from the data file. `titles` names what each clip shows (keyed by its job id); check a line against
 * its clip when the clip changes. A sample with no line here is titled by its tool (`kinds`).
 */
export const siteCarouselEn = {
  carousel: {
    label: "Watch",
    title: "One sample after another",
    lead: "Real generations from our Studio. Each clip plays to its end, then the next one comes in. Pick any card to watch it.",
    /** The carousel's accessible name (aria-roledescription "carousel"). */
    region: "Samples from our Studio",
    roledescription: "carousel",
    slideRole: "slide",
    /** Each slide's accessible name. */
    slide: "{n} of {total}",
    prev: "Previous sample",
    next: "Next sample",
    pause: "Stop the carousel",
    play: "Start the carousel",
    /** A side card's name: pressing it brings it to the centre. */
    show: "Show sample {n}: {title}",
    /** Under the centre card: what is left of its clip (or of a picture's turn), measured, never guessed. */
    left: "{time} left",
    position: "{n} / {total}",
    more: "Show more",
    less: "Show less",
    close: "Close the prompt",
    copy: "Copy prompt",
    copied: "Prompt copied",
    copyFailed: "Could not copy. Select the words and copy them yourself.",
    /** With reduced motion (or Save-Data) nothing plays by itself: the centre clip starts only when pressed. */
    playClip: "Play this clip",
    pauseClip: "Pause this clip",
    reduced: "Nothing here moves by itself on your device. Use the arrows to look through the samples, and play a clip when you want to.",
    /** Read out when the centre card changes by the visitor's own press (not while it advances by itself). */
    now: "Now showing: {title}",
    note: "“Use this prompt” asks you to create a free account first, then opens the Studio with those words on a model it offers. Nothing starts until you press Generate there, and the price is shown before you do.",
    kinds: { t2v: "Video from words", i2v: "Video from a picture", t2i: "Picture from words", other: "Studio sample" },
    titles: {
      "de53f364-eaf7-4cd1-8d44-7b56b21b03b6": "A whale over the city",
      "f92a89ed-2145-4342-acd5-f24b8805a0f9": "A sneaker bursts into neon paint",
      "01c9f1f0-d54b-4fd3-a88f-ddf459aece73": "A city inside a snow globe",
      "b72e18cd-d9e5-4535-9fea-f24fbd8c3fd9": "A giant dog downtown",
      "a6768488-04c6-4325-9465-62d61f888a70": "A chocolate rose",
      "9a52ebf1-bbe3-473c-b77c-7553bc18e0d8": "Above the clouds at sunrise",
      "ab0bcba2-8374-465d-b505-8dac19977948": "A camper van on a cliff road",
      "fc1fad12-16de-4cd5-9cd9-e77ed245f469": "The perfume bottle comes alive",
      "ab7cc0e2-8040-4643-8e14-74219fc1d8e2": "The lighthouse in the storm",
      "e3da9148-f2f8-443e-95b1-8ed36ef3dea4": "An amber perfume bottle",
      "28f164dc-809f-49a3-b2e2-ef0bdf88519b": "A retro robot with a clapperboard",
      "f17146fd-054c-4970-9dac-f7a0dc929bd6": "A lighthouse at dusk",
      "1b3d5f4b-f4f2-4e92-84db-77908a36df2a": "An evening street market",
      "639bbde5-dc70-4954-b71d-54db6a5b3ea9": "A river valley at sunrise",
      "1504b313-3a3c-4e78-bfda-5bca3ef7f3da": "A neon city in the rain",
      "64a7c2b8-a6c1-4359-9961-a1a2760f1cbf": "Moonrise behind a lone tree",
      "38c427b0-c41b-4d16-86ca-14dc2e69ec27": "Dunes at golden hour",
    } as Record<string, string>,
  },
  compare: {
    label: "Picture to video",
    title: "A picture, and the clip made from it",
    lead: "On the left, a picture made from words. On the right, the clip another model made from that same picture. Drag the line to compare.",
    picture: "Picture",
    video: "Video",
    /** The divider's accessible name (role="slider"); its value says how much of the frame is the picture. */
    slider: "Compare the picture and the video: {title}",
    value: "{n}% picture, {m}% video",
    pictureBy: "Picture:",
    videoBy: "Video:",
    prompt: "What the clip was asked for",
    playClip: "Play the video",
    pauseClip: "Pause the video",
    /** With reduced motion (or Save-Data) the video side shows the clip's first frame until the visitor presses play. */
    still: "The video side shows the clip’s first frame. Press play to watch it.",
  },
  ticker: {
    label: "Prompt to result",
    /** The words are the sample's own, cut to their first sentence; the label says so. */
    prompt: "Prompt (first sentence)",
    result: "What it made",
    next: "Next example",
    /** The keyboard's hold (shown when focused); a tap on the result does the same. */
    pause: "Hold the examples",
    play: "Play the examples",
    note: "Real prompts from our Studio and the clips they made.",
  },
};

export type SiteCarouselDictionary = typeof siteCarouselEn;

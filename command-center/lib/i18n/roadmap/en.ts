/**
 * The public /roadmap page ("What's coming"). The MASTER copy is Uzbek (./uz.ts, approved by the owner on
 * 2026-11-11); this file is its English translation, and the type the other two are checked against
 * (tests/roadmap-page.test.tsx holds the shapes and ids equal).
 *
 * Only the approved content: no status, date, number beyond the master's own "4K", no model or maker name, no
 * partnership claim, and nothing on the banned list (docs/news/banned-claims.json, tests/helpers/brands.ts). An item
 * with no description ("create") has no `body` and renders its title alone. Ids match lib/roadmap.ts.
 */
export const roadmapEn = {
  meta: {
    title: "What’s coming · Nightshift",
    description:
      "A professional video editor, powerful, modern video AI models, image, voice and music, an ads factory, a sample gallery and social posting. All in one studio.",
  },
  title: "What’s coming",
  items: [
    {
      id: "editor",
      title: "Professional video editor",
      body: "a multi-layer timeline, effects and animations, beat sync, colour and masks, automatic silence cutting, subtitles, voice recording, 4K export",
    },
    {
      id: "videoModels",
      title: "Powerful, modern video AI models",
      body: "video from text and from images, video editing, character swap, each through its own maker’s API",
    },
    { id: "create", title: "Image, voice and music generation" },
    { id: "ads", title: "Ads factory", body: "scan your site and get ads made to match your brand" },
    { id: "gallery", title: "Sample gallery", body: "see what each model makes, and try it with one button" },
    {
      id: "social",
      title: "Automatic posting to social networks",
      body: "send a finished video to YouTube, Instagram and other social networks without leaving the studio, with your consent, and schedule when it goes out.",
    },
  ] as { id: string; title: string; body?: string }[],
  closing: {
    title: "Everything in one studio.",
    body: "NIGHTSHIFT brings it all together in one place for you.",
    soon: "Coming soon.",
  },
  /** The footer link's label (components/legal/PublicFooter.tsx). */
  footer: "What’s coming",
};

export type RoadmapDictionary = typeof roadmapEn;

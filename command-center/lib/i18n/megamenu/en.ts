/**
 * The public header's panels (components/legal/PublicMegaMenu.tsx) and the phone sheet's sections
 * (components/legal/PublicMenu.tsx). English is the source; ru.ts and uz.ts are typed against it and
 * tests/public-megamenu.test.tsx holds the keys equal.
 *
 * Only words of our own live here: the pages' names come from the pages' own dictionaries (Solutions, the
 * /studio page's sections, Roadmap, Trust, the developer pages), so a renamed page renames its menu entry too.
 * Every description says what the page holds today, nothing it might hold later.
 */
export const megaMenuEn = {
  /** The trigger for Roadmap and Trust and safety. */
  resources: "Resources",
  apiPricing: "API pricing",
  desc: {
    api: "Make and follow videos from your own code",
    mcp: "Use Nightshift from an AI assistant",
    apiPricing: "What a call costs, when it is priced",
    roadmap: "What we are building next",
    trust: "What Nightshift may do with your channel, keys and money",
  },
};

export type MegaMenuDictionary = typeof megaMenuEn;

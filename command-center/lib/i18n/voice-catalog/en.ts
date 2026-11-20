/**
 * The Studio's speech voice picker (components/studio/VoiceCatalog.tsx). English is the source: ru.ts and uz.ts are typed
 * `VoiceCatalogDictionary`, so they must carry exactly these keys. The ru and uz sentences are machine drafts: have a native
 * speaker read them. Voice names and ElevenLabs' own label values (accent, age …) are shown as ElevenLabs writes them.
 */
export const voiceCatalogEn = {
  heading: "Voices on the account",
  loading: "Loading the account's voices…",
  builtInTitle: "ElevenLabs premade voices",
  builtInNote: "The account's own list is not shown, so these are ElevenLabs' standard voices.",
  notConfigured: "This server is not connected to the voice account, so its voice list cannot be shown here.",
  unreachable: "ElevenLabs could not be reached. Try again in a moment.",
  keyRejected: "ElevenLabs refused this server's key. The platform operator needs to replace it.",
  rateLimited: "The voice list was asked for too often. Try again in a few minutes.",
  signedOut: "Your session has ended. Sign in again to see the voices.",
  noWorkspace: "Choose a workspace to see the voices.",
  failed: "The voice list could not be loaded.",
  retry: "Try again",
  empty: "The account has no voices yet.",
  truncated: "This is only part of a very long list: a voice you search for may be missing.",
  noMatch: "No voice matches these filters.",
  clearFilters: "Clear filters",
  search: "Search by name or description",
  searchPh: "Calm, narrator, Brian…",
  facetAny: "Any",
  facets: { gender: "Gender", age: "Age", accent: "Accent", useCase: "Use" },
  categories: {
    premade: "Premade",
    generated: "Designed",
    cloned: "Cloned",
    professional: "Professional clone",
    famous: "Famous",
    high_quality: "High quality",
  },
  library: "Library voice: it can be withdrawn by its owner.",
  noPreview: "No sample",
  showing: "Showing {shown} of {total}",
  showMore: "Show more",
  pickedMissing: "The voice picked earlier is not on the account's list. Pick another voice.",
};

export type VoiceCatalogDictionary = typeof voiceCatalogEn;

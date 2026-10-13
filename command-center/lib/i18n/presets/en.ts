/**
 * The Presets & looks gallery's copy (app/(app)/[channel]/presets). Card titles
 * and descriptions are not here: they come from the dictionaries of the things
 * the cards open (the Home formats, the Studio templates, the voice list, the
 * Style Library), so a card never says anything its target does not.
 *
 * English is the source of truth; ru.ts and uz.ts are typed against it.
 */
export const presetsEn = {
  title: "Presets & looks",
  subtitle: "Starting points that already exist in Nightshift, in one place. Pick one and its form opens filled in.",
  note: "Nothing is priced or started on this page. The form it opens shows the price and asks you to confirm.",
  searchLabel: "Search presets",
  searchPlaceholder: "Search: story, vertical, a voice…",
  filterLabel: "Show",
  kinds: { all: "All", format: "Formats", look: "Looks", starter: "Starters", voice: "Voices" },
  cardKind: { format: "Video format", look: "Look", starter: "Studio starter", voice: "Voice" },
  sections: {
    format: {
      title: "Video formats",
      hint: "Opens the YouTube video form with a starter topic, the usual length and your language. Replace the [brackets].",
    },
    look: {
      title: "Looks",
      hint: "Written art directions for Studio pictures. This opens the look, where you can add it to your styles. It is a direction for the model, not a promise of how a picture turns out.",
    },
    starter: {
      title: "Studio starters",
      hint: "Opens the Studio tool with the description and the shape filled in. Starter text is in English on purpose; replace the [brackets].",
    },
    voice: {
      title: "Voices",
      hint: "Opens Voice-over with this voice picked. You add the text there.",
    },
  },
  actions: { format: "Open the video form", look: "See this look", starter: "Fill the form", voice: "Use this voice" },
  open: "{action}: {title}",
  count: "{n} of {total}",
  clear: "Clear search",
  noMatchTitle: "Nothing matches",
  noMatch: "Try another word, or clear the search to see every preset.",
  loading: "Loading presets",
  entryLink: "Presets & looks",
  homeLink: "All presets and looks",
};

export type PresetsDictionary = typeof presetsEn;

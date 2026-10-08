/**
 * The public site's pictures and clips, and who made them: the ONE data file the credits are read from (the footer's "Image
 * credits", the small credit lines on the pictures, docs/design/MEDIA_CREDITS.md and the tests that keep them in step).
 *
 * Every item is stock photography or footage by a Pexels contributor, used under the Pexels License (free to use, credit not
 * required, no implying that anyone or anything in a picture endorses Nightshift, no selling unaltered copies). They are
 * shown only as examples of the kind of picture a video can use. They are NOT AI-generated, NOT Nightshift output and not a
 * customer's work, and every place that shows one says so (lib/i18n/site/*.ts, site.samples and site.credits).
 *
 * A still named after a clip (caravan, mist, coast) is that clip's first frame, so the picture a clip fades in over is its own
 * frame: its credit is the footage's.
 *
 * Kept free of image imports (the files are imported in components/site/samples.tsx), so the footer and tests can read it.
 */
export type MediaKind = "photo" | "video";

export interface MediaItem {
  /** Pexels' own id, as in the source URL. */
  pexelsId: string;
  kind: MediaKind;
  /** The contributor's name as Pexels shows it. */
  creator: string;
  creatorUrl: string;
  /** The item's page on Pexels. */
  sourceUrl: string;
  /** Where it is used (plain words for the credits list; not translated, they are for the people who run the site). */
  used: string;
}

export const LICENCE = { name: "Pexels License", url: "https://www.pexels.com/license/" } as const;

export const MEDIA = {
  caravan: { pexelsId: "28673757", kind: "video", creator: "Simeon Stoilov", creatorUrl: "https://www.pexels.com/@simeon-theartist/", sourceUrl: "https://www.pexels.com/video/camel-caravan-traversing-desert-landscape-28673757/", used: "Landing, first screen (clip)" },
  mist: { pexelsId: "18197835", kind: "video", creator: "Tom Fisk", creatorUrl: "https://www.pexels.com/@tomfisk/", sourceUrl: "https://www.pexels.com/video/a-river-with-mist-rising-from-it-at-sunset-18197835/", used: "Landing, second showcase (clip)" },
  coast: { pexelsId: "14910095", kind: "video", creator: "Nui MALAMA", creatorUrl: "https://www.pexels.com/@nui-malama-169330637/", sourceUrl: "https://www.pexels.com/video/breaking-waves-and-a-lighthouse-on-a-rocky-shore-14910095/", used: "Landing, third showcase (clip)" },
  library: { pexelsId: "37387122", kind: "photo", creator: "TEBESSUM PROVALARI", creatorUrl: "https://www.pexels.com/@tebessumprovalari/", sourceUrl: "https://www.pexels.com/photo/historic-library-interior-with-chandelier-37387122/", used: "Landing, first showcase; /mcp examples" },
  moon: { pexelsId: "39335277", kind: "photo", creator: "Eve R", creatorUrl: "https://www.pexels.com/@ev4r137/", sourceUrl: "https://www.pexels.com/photo/full-moon-in-clear-night-sky-39335277/", used: "Landing, closing panel; /mcp examples" },
  market: { pexelsId: "20895317", kind: "photo", creator: "Mathias Dargnat", creatorUrl: "https://www.pexels.com/@mathias-dargnat-1141076318/", sourceUrl: "https://www.pexels.com/photo/bazaar-in-city-in-evening-20895317/", used: "/mcp examples" },
  valley: { pexelsId: "10352688", kind: "photo", creator: "Cris Ljungmann", creatorUrl: "https://www.pexels.com/@cris-ljungmann-140938814/", sourceUrl: "https://www.pexels.com/photo/scenic-view-of-mountains-during-sunset-10352688/", used: "/mcp examples" },
  lighthouse: { pexelsId: "4390834", kind: "photo", creator: "Ray Bilcliff", creatorUrl: "https://www.pexels.com/@raybilcliff/", sourceUrl: "https://www.pexels.com/photo/lighthouse-tower-located-under-evening-sky-4390834/", used: "/mcp examples" },
  dunes: { pexelsId: "15848441", kind: "photo", creator: "Valr Studio", creatorUrl: "https://www.pexels.com/@valr-studio-479653745/", sourceUrl: "https://www.pexels.com/photo/camels-caravan-on-desert-15848441/", used: "/mcp examples" },
  lanterns: { pexelsId: "16046217", kind: "photo", creator: "Mehrajul Karim", creatorUrl: "https://www.pexels.com/@mehrajul-karim-114876029/", sourceUrl: "https://www.pexels.com/photo/shining-lanterns-at-night-16046217/", used: "/pricing" },
  fishermen: { pexelsId: "39395221", kind: "photo", creator: "VANNGO Ng", creatorUrl: "https://www.pexels.com/@vanngo-ng-105653827/", sourceUrl: "https://www.pexels.com/photo/silhouetted-fishermen-at-sunrise-on-calm-sea-39395221/", used: "/solutions, channels" },
  workshop: { pexelsId: "19208266", kind: "photo", creator: "Beyzaa Yurtkuran", creatorUrl: "https://www.pexels.com/@beyzaa-yurtkuran-279977530/", sourceUrl: "https://www.pexels.com/photo/hand-carved-decorative-wooden-panels-in-workshop-19208266/", used: "/solutions, creative studio" },
  citynight: { pexelsId: "39659645", kind: "photo", creator: "Dinesh lens", creatorUrl: "https://www.pexels.com/@dineshlens/", sourceUrl: "https://www.pexels.com/photo/aerial-view-of-cityscape-at-twilight-39659645/", used: "/solutions, developers" },
  dawn: { pexelsId: "31550736", kind: "photo", creator: "Zetong Li", creatorUrl: "https://www.pexels.com/@zetong-li-880728/", sourceUrl: "https://www.pexels.com/photo/mystical-foggy-sunrise-over-mountain-landscape-31550736/", used: "/login" },
  horizon: { pexelsId: "14701162", kind: "photo", creator: "brazil topno", creatorUrl: "https://www.pexels.com/@braziltopno/", sourceUrl: "https://www.pexels.com/photo/calm-sea-under-blue-sky-14701162/", used: "/signup" },
} as const satisfies Record<string, MediaItem>;

export type MediaId = keyof typeof MEDIA;
export const MEDIA_IDS = Object.keys(MEDIA) as MediaId[];

/** "Photo: Tom Fisk / Pexels" from the dictionary's template ({name}). */
export function creditLine(id: MediaId, templates: { photo: string; video: string }): string {
  const m: MediaItem = MEDIA[id];
  return (m.kind === "video" ? templates.video : templates.photo).replace("{name}", m.creator);
}

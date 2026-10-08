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
  caravan: { pexelsId: "28673757", kind: "video", creator: "Simeon Stoilov", creatorUrl: "https://www.pexels.com/@simeon-theartist/", sourceUrl: "https://www.pexels.com/video/camel-caravan-traversing-desert-landscape-28673757/", used: "/solutions, channels tab (clip)" },
  coast: { pexelsId: "14910095", kind: "video", creator: "Nui MALAMA", creatorUrl: "https://www.pexels.com/@nui-malama-169330637/", sourceUrl: "https://www.pexels.com/video/breaking-waves-and-a-lighthouse-on-a-rocky-shore-14910095/", used: "Landing, third showcase (clip)" },
  library: { pexelsId: "37387122", kind: "photo", creator: "TEBESSUM PROVALARI", creatorUrl: "https://www.pexels.com/@tebessumprovalari/", sourceUrl: "https://www.pexels.com/photo/historic-library-interior-with-chandelier-37387122/", used: "Landing, first showcase; /mcp examples" },
  moon: { pexelsId: "39335277", kind: "photo", creator: "Eve R", creatorUrl: "https://www.pexels.com/@ev4r137/", sourceUrl: "https://www.pexels.com/photo/full-moon-in-clear-night-sky-39335277/", used: "Landing, closing panel; /mcp examples" },
  market: { pexelsId: "20895317", kind: "photo", creator: "Mathias Dargnat", creatorUrl: "https://www.pexels.com/@mathias-dargnat-1141076318/", sourceUrl: "https://www.pexels.com/photo/bazaar-in-city-in-evening-20895317/", used: "/mcp examples" },
  valley: { pexelsId: "10352688", kind: "photo", creator: "Cris Ljungmann", creatorUrl: "https://www.pexels.com/@cris-ljungmann-140938814/", sourceUrl: "https://www.pexels.com/photo/scenic-view-of-mountains-during-sunset-10352688/", used: "/mcp examples" },
  lighthouse: { pexelsId: "4390834", kind: "photo", creator: "Ray Bilcliff", creatorUrl: "https://www.pexels.com/@raybilcliff/", sourceUrl: "https://www.pexels.com/photo/lighthouse-tower-located-under-evening-sky-4390834/", used: "/mcp examples" },
  dunes: { pexelsId: "15848441", kind: "photo", creator: "Valr Studio", creatorUrl: "https://www.pexels.com/@valr-studio-479653745/", sourceUrl: "https://www.pexels.com/photo/camels-caravan-on-desert-15848441/", used: "/mcp examples" },
  citynight: { pexelsId: "39659645", kind: "photo", creator: "Dinesh lens", creatorUrl: "https://www.pexels.com/@dineshlens/", sourceUrl: "https://www.pexels.com/photo/aerial-view-of-cityscape-at-twilight-39659645/", used: "/solutions, developers" },
  cloud: { pexelsId: "4288029", kind: "video", creator: "K", creatorUrl: "https://www.pexels.com/@kelly/", sourceUrl: "https://www.pexels.com/video/drone-shot-of-the-mountain-peak-during-sunset-4288029/", used: "Landing, first screen (clip)" },
  pottery: { pexelsId: "27519716", kind: "video", creator: "AP Vibes", creatorUrl: "https://www.pexels.com/@apvibes/", sourceUrl: "https://www.pexels.com/video/a-person-is-making-a-pottery-on-a-pottery-wheel-27519716/", used: "Landing, second showcase (clip)" },
  floating: { pexelsId: "39181590", kind: "video", creator: "Matheus Bertelli", creatorUrl: "https://www.pexels.com/@bertellifotografia/", sourceUrl: "https://www.pexels.com/video/floating-lanterns-on-water-at-night-39181590/", used: "/pricing (clip)" },
  loom: { pexelsId: "32655899", kind: "video", creator: "Magda Ehlers", creatorUrl: "https://www.pexels.com/@magda-ehlers-pexels/", sourceUrl: "https://www.pexels.com/video/artisan-weaving-on-traditional-loom-32655899/", used: "/solutions, creative studio (clip)" },
  alley: { pexelsId: "4916113", kind: "photo", creator: "Maria Orlova", creatorUrl: "https://www.pexels.com/@orlovamaria/", sourceUrl: "https://www.pexels.com/photo/narrow-street-with-residential-houses-in-late-evening-4916113/", used: "/login" },
  lanterngrid: { pexelsId: "31108468", kind: "photo", creator: "浪 郭", creatorUrl: "https://www.pexels.com/@2150004161/", sourceUrl: "https://www.pexels.com/photo/festive-chinese-lanterns-lighting-up-night-sky-31108468/", used: "/signup" },
  peak: { pexelsId: "34033024", kind: "photo", creator: "Shashank Brahmavar", creatorUrl: "https://www.pexels.com/@shashank-brahmavar-737732917/", sourceUrl: "https://www.pexels.com/photo/golden-sunset-over-mount-cook-new-zealand-34033024/", used: "Landing, capability wall: Image" },
  waterfall: { pexelsId: "8780358", kind: "photo", creator: "SpotwizardLee", creatorUrl: "https://www.pexels.com/@spotwizardlee-35777904/", sourceUrl: "https://www.pexels.com/photo/long-exposure-photography-of-the-shifen-waterfall-in-taiwan-8780358/", used: "Landing, capability wall: Video clip" },
  mic: { pexelsId: "26280295", kind: "photo", creator: "Clement Lepetit", creatorUrl: "https://www.pexels.com/@clemlep/", sourceUrl: "https://www.pexels.com/photo/condenser-microphone-in-close-up-26280295/", used: "Landing, capability wall: Voice" },
  reel: { pexelsId: "34084909", kind: "photo", creator: "Sami TÜRK", creatorUrl: "https://www.pexels.com/@trksami/", sourceUrl: "https://www.pexels.com/photo/close-up-of-vintage-film-reel-in-soft-light-34084909/", used: "Landing, capability wall: Edit" },
  trails: { pexelsId: "36504036", kind: "photo", creator: "Catarina Kåsa", creatorUrl: "https://www.pexels.com/@catarina-kasa-2737553/", sourceUrl: "https://www.pexels.com/photo/vibrant-abstract-light-trails-at-night-36504036/", used: "Landing, capability wall: Animate" },
  fibres: { pexelsId: "37955302", kind: "photo", creator: "Валерий Линк", creatorUrl: "https://www.pexels.com/@167691936/", sourceUrl: "https://www.pexels.com/photo/close-up-macro-shot-of-tan-wool-fibers-texture-37955302/", used: "Landing, capability wall: Upscale" },
  paper: { pexelsId: "34051927", kind: "photo", creator: "Landiva Weber", creatorUrl: "https://www.pexels.com/@diva/", sourceUrl: "https://www.pexels.com/photo/colorful-abstract-paper-art-composition-34051927/", used: "Landing, capability wall: Cut out" },
  paint: { pexelsId: "1208949", kind: "photo", creator: "Steve A Johnson", creatorUrl: "https://www.pexels.com/@steve/", sourceUrl: "https://www.pexels.com/photo/blue-and-orange-abstract-painting-1208949/", used: "Landing, capability wall: Styles" },
} as const satisfies Record<string, MediaItem>;

export type MediaId = keyof typeof MEDIA;

/**
 * The capability wall on the landing: one stock photograph per tool, by the tool's id in `site.studio.tools`. They stand for the
 * tool, they are not what the tool made; the wall says so (`site.wall`). These pictures come as one 448 px file each.
 */
export const TILE_FOR_TOOL = { image: "peak", video: "waterfall", voice: "mic", edit: "reel", animate: "trails", upscale: "fibres", cutout: "paper", styles: "paint" } as const satisfies Record<string, MediaId>;
export const TILE_IDS = Object.values(TILE_FOR_TOOL);
export const MEDIA_IDS = Object.keys(MEDIA) as MediaId[];

/** "Photo: Tom Fisk / Pexels" from the dictionary's template ({name}). */
export function creditLine(id: MediaId, templates: { photo: string; video: string }): string {
  const m: MediaItem = MEDIA[id];
  return (m.kind === "video" ? templates.video : templates.photo).replace("{name}", m.creator);
}

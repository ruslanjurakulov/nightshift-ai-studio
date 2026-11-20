/**
 * The landing page's showcase reel: every item was generated inside our own Studio (demo workspace, 2026-11-20) with the
 * model named here, then transcoded for the web (public/showcase/<slug>.mp4 + .webp poster). Nothing here was made with
 * another company's product, so the page can say "made in Nightshift Studio" truthfully.
 */
export type ShowcaseItem = {
  slug: string;
  kind: "video" | "image";
  /**
   * The registry ids of the models that made it, in the order they worked; the page shows their display names. More than one
   * when a piece took more than one step (a picture, then a clip from it): crediting only the last one would hide the first.
   */
  modelIds: readonly string[];
  aspect: "16:9" | "9:16" | "1:1";
  /**
   * The language of its spoken words, when it has some: public/showcase/<slug>.vtt holds them as captions, timed from a transcript
   * of the clip's own audio. A separate track, never burned in, because burning them in is post-production the Studio did not do.
   */
  captions?: "en";
  title: { en: string; ru: string; uz: string };
};

export const SHOWCASE_ITEMS: readonly ShowcaseItem[] = [
  // Two steps in Studio: an Ideogram 4.5 picture of the two characters, then MiniMax H3 image-to-video with the dialogue written
  // into the prompt. The model speaks the lines itself; the captions are burned in from a transcript of its own audio, because
  // the landing plays clips muted.
  { slug: "language-duo", kind: "video", modelIds: ["ideogram-4.5", "minimax-h3"], aspect: "9:16", captions: "en",
    title: { en: "One picture, two talking characters", ru: "Одна картинка, два говорящих героя", uz: "Bitta rasm, ikki gapiruvchi personaj" } },
  { slug: "registan-dusk", kind: "video", modelIds: ["minimax-h3-max"], aspect: "16:9",
    title: { en: "Registan at blue hour", ru: "Регистан в синий час", uz: "Registon, kechki moviy soat" } },
  { slug: "perfume-splash", kind: "video", modelIds: ["minimax-h3"], aspect: "9:16",
    title: { en: "Perfume, golden splash", ru: "Парфюм и золотой всплеск", uz: "Atir va oltin sachrash" } },
  { slug: "neon-city-rain", kind: "video", modelIds: ["minimax-h3"], aspect: "16:9",
    title: { en: "Neon city in the rain", ru: "Неоновый город под дождём", uz: "Yomg'irdagi neon shahar" } },
  { slug: "desert-silk", kind: "video", modelIds: ["minimax-h3"], aspect: "9:16",
    title: { en: "Silk over the dunes", ru: "Шёлк над дюнами", uz: "Barxanlar uzra shoyi" } },
  { slug: "coffee-pour", kind: "video", modelIds: ["minimax-h3"], aspect: "16:9",
    title: { en: "Morning pour", ru: "Утренний кофе", uz: "Ertalabki qahva" } },
  { slug: "sneaker-orbit", kind: "video", modelIds: ["minimax-h3-highspeed"], aspect: "9:16",
    title: { en: "Sneaker drop", ru: "Кроссовки в движении", uz: "Krossovka reklamasi" } },
  { slug: "ikat-poster", kind: "image", modelIds: ["ideogram-4.5"], aspect: "9:16",
    title: { en: "Made in Tashkent", ru: "Сделано в Ташкенте", uz: "Toshkentda yaratilgan" } },
  { slug: "isometric-studio", kind: "image", modelIds: ["ideogram-4.5"], aspect: "1:1",
    title: { en: "A studio on an island", ru: "Студия на острове", uz: "Oroldagi studiya" } },
];

export const showcasePoster = (slug: string) => `/showcase/${slug}.webp`;
export const showcaseVideo = (slug: string) => `/showcase/${slug}.mp4`;
export const showcaseCaptions = (slug: string) => `/showcase/${slug}.vtt`;

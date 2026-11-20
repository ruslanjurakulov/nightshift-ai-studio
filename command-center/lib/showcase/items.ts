/**
 * The landing page's showcase reel: every item was generated inside our own Studio (demo workspace, 2026-11-20) with the
 * model named here, then transcoded for the web (public/showcase/<slug>.mp4 + .webp poster). Nothing here was made with
 * another company's product, so the page can say "made in Nightshift Studio" truthfully.
 */
export type ShowcaseItem = {
  slug: string;
  kind: "video" | "image";
  /** The registry id of the model that made it; the page shows the model's display name. */
  modelId: string;
  aspect: "16:9" | "9:16" | "1:1";
  title: { en: string; ru: string; uz: string };
};

export const SHOWCASE_ITEMS: readonly ShowcaseItem[] = [
  { slug: "registan-dusk", kind: "video", modelId: "minimax-h3-max", aspect: "16:9",
    title: { en: "Registan at blue hour", ru: "Регистан в синий час", uz: "Registon, kechki moviy soat" } },
  { slug: "perfume-splash", kind: "video", modelId: "minimax-h3", aspect: "9:16",
    title: { en: "Perfume, golden splash", ru: "Парфюм и золотой всплеск", uz: "Atir va oltin sachrash" } },
  { slug: "neon-city-rain", kind: "video", modelId: "minimax-h3", aspect: "16:9",
    title: { en: "Neon city in the rain", ru: "Неоновый город под дождём", uz: "Yomg'irdagi neon shahar" } },
  { slug: "desert-silk", kind: "video", modelId: "minimax-h3", aspect: "9:16",
    title: { en: "Silk over the dunes", ru: "Шёлк над дюнами", uz: "Barxanlar uzra shoyi" } },
  { slug: "coffee-pour", kind: "video", modelId: "minimax-h3", aspect: "16:9",
    title: { en: "Morning pour", ru: "Утренний кофе", uz: "Ertalabki qahva" } },
  { slug: "sneaker-orbit", kind: "video", modelId: "minimax-h3-highspeed", aspect: "9:16",
    title: { en: "Sneaker drop", ru: "Кроссовки в движении", uz: "Krossovka reklamasi" } },
  { slug: "ikat-poster", kind: "image", modelId: "ideogram-4.5", aspect: "9:16",
    title: { en: "Made in Tashkent", ru: "Сделано в Ташкенте", uz: "Toshkentda yaratilgan" } },
  { slug: "isometric-studio", kind: "image", modelId: "ideogram-4.5", aspect: "1:1",
    title: { en: "A studio on an island", ru: "Студия на острове", uz: "Oroldagi studiya" } },
];

export const showcasePoster = (slug: string) => `/showcase/${slug}.webp`;
export const showcaseVideo = (slug: string) => `/showcase/${slug}.mp4`;

/**
 * "Start from an example" on /create: a small typed list the gallery draws
 * from. A card only FILLS the composer — the mode, the model, the words (and
 * the shape or length where an example names one). Nothing is priced or spent
 * until the person presses send, and the price is the quote route's, as for
 * anything typed by hand. Pure and client-safe (tests/studio-home.test.tsx).
 *
 * There is no sample media yet: it will be made later with our own model, and
 * no stock or third-party picture is ever used in its place. Until then a card
 * is the prompt itself, set in type over the example's two colours. Adding a
 * picture or clip later is one line: `mediaSrc` (a same-origin path under
 * /public, e.g. "/examples/<id>.webp" or ".mp4").
 *
 * The model an example was written for is not here: which model we chose for
 * which prompt is ours, and this list is in a static chunk. It is
 * lib/server/creative-examples.ts, and the page passes StudioHome the pairs whose
 * model it offers (exampleModels). The composer uses one only when the
 * organization is offered that model for the tool; otherwise the composer's own
 * default stands, and the model button names what will really be used — never a
 * model that is not offered, never a price not quoted.
 */
import type { MediaDesk } from "@/lib/creative/desks";
import type { AspectRatio, StudioCapability, VideoDuration } from "@/lib/creative/studio";
import type { Locale } from "@/lib/i18n/core";

/** The composer's modes: the four media kinds and the YouTube video run. */
export const STUDIO_MODES = ["image", "video", "voice", "enhance", "youtube"] as const;
export type StudioMode = (typeof STUDIO_MODES)[number];

export function isStudioMode(v: unknown): v is StudioMode {
  return typeof v === "string" && (STUDIO_MODES as readonly string[]).includes(v);
}

/** Every media mode is one of the existing tool groups (lib/creative/desks): same tools, same prices. */
export function modeDesk(m: StudioMode): MediaDesk | null {
  return m === "youtube" ? null : m;
}

export interface CreativeExample {
  id: string;
  mode: StudioMode;
  /** The tool the example opens (one of the mode's tools); absent for the YouTube run. */
  capability?: StudioCapability;
  aspect?: AspectRatio;
  duration?: VideoDuration;
  prompt_uz: string;
  prompt_en: string;
  prompt_ru: string;
  /** A same-origin sample (image or video) once one exists; absent = the prompt-only card. */
  mediaSrc?: string;
  /** The prompt-only card's two colours (a gradient, not a picture). */
  hues: readonly [string, string];
}

export const CREATIVE_EXAMPLES: readonly CreativeExample[] = [
  {
    id: "samarkand_dawn",
    mode: "image",
    capability: "t2i",
    aspect: "16:9",
    prompt_uz: "Tong saharda Registon maydoni, moviy gumbazlarga tushgan iliq oltin nur, boʻm-boʻsh maydon, keng plan, kinematografik kadr",
    prompt_en: "Registan square at first light, warm gold light on the blue domes, the square empty, wide shot, cinematic frame",
    prompt_ru: "Площадь Регистан на рассвете, тёплый золотой свет на голубых куполах, пустая площадь, общий план, кинематографичный кадр",
    hues: ["#1f4e8c", "#f2a541"],
  },
  {
    id: "thumbnail_portrait",
    mode: "image",
    capability: "t2i",
    aspect: "16:9",
    prompt_uz: "YouTube muqovasi uchun: hayratlangan yosh dasturchi yaqin planda, orqasida ekranlar nuri, chap tomonda sarlavha uchun boʻsh joy, yorqin kontrast",
    prompt_en: "For a YouTube thumbnail: a surprised young programmer in close-up, screen glow behind, empty space on the left for a title, bold contrast",
    prompt_ru: "Для обложки YouTube: удивлённый молодой программист крупным планом, за спиной свет экранов, слева пустое место под заголовок, яркий контраст",
    hues: ["#ff4d4d", "#2b2d42"],
  },
  {
    id: "plov_flatlay",
    mode: "image",
    capability: "t2i",
    aspect: "1:1",
    prompt_uz: "Yogʻoch stolda bir lagan osh, ustidan qaralgan kadr, yonida non va choynak, yumshoq kunduzgi yorugʻlik, taom jurnali uslubida",
    prompt_en: "A platter of plov on a wooden table, seen from above, bread and a teapot beside it, soft daylight, food magazine style",
    prompt_ru: "Блюдо плова на деревянном столе, вид сверху, рядом лепёшка и чайник, мягкий дневной свет, в стиле кулинарного журнала",
    hues: ["#c8553d", "#f4d35e"],
  },
  {
    id: "product_bottle",
    mode: "image",
    capability: "t2i",
    aspect: "1:1",
    prompt_uz: "Shisha idishdagi atir, toza oq fon, yumshoq soya, studiyada suratga olingan mahsulot kadri, oʻrtada joylashgan",
    prompt_en: "A glass perfume bottle on a clean white background, soft shadow, studio product shot, centred",
    prompt_ru: "Стеклянный флакон духов на чистом белом фоне, мягкая тень, студийная предметная съёмка, по центру",
    hues: ["#e0e1dd", "#778da9"],
  },
  {
    id: "mountain_drone",
    mode: "video",
    capability: "t2v",
    aspect: "16:9",
    duration: 5,
    prompt_uz: "Chimyon togʻlari ustidan sekin uchayotgan dron kadri, quyosh botishi, vodiyda tuman, kamera oldinga siljiydi",
    prompt_en: "A slow drone shot over the Chimgan mountains at sunset, mist in the valley, the camera glides forward",
    prompt_ru: "Медленный пролёт дрона над горами Чимган на закате, туман в долине, камера плавно движется вперёд",
    hues: ["#3d5a80", "#ee6c4d"],
  },
  {
    id: "tea_pour",
    mode: "video",
    capability: "t2v",
    aspect: "9:16",
    duration: 5,
    prompt_uz: "Piyolaga choy quyilayotgan yaqin kadr, bugʻ koʻtariladi, sekinlashtirilgan harakat, iliq ertalabki yorugʻlik, vertikal format",
    prompt_en: "Close-up of tea being poured into a piyola, steam rising, slow motion, warm morning light, vertical format",
    prompt_ru: "Крупный план: чай наливают в пиалу, поднимается пар, замедленная съёмка, тёплый утренний свет, вертикальный формат",
    hues: ["#6b4226", "#e9c46a"],
  },
  {
    id: "city_night",
    mode: "video",
    capability: "t2v",
    aspect: "16:9",
    duration: 10,
    prompt_uz: "Yomgʻirdan keyingi tungi Toshkent koʻchasi, hoʻl asfaltda chiroqlar aksi, kamera piyodalar orasidan sekin oʻtadi",
    prompt_en: "A Tashkent street at night after rain, lights reflected on the wet asphalt, the camera moves slowly past people walking",
    prompt_ru: "Ночная улица Ташкента после дождя, огни отражаются в мокром асфальте, камера медленно проходит мимо прохожих",
    hues: ["#14213d", "#fca311"],
  },
  {
    id: "intro_voice",
    mode: "voice",
    capability: "tts",
    prompt_uz: "Assalomu alaykum! Kanalimizga xush kelibsiz. Bugun sizga qadimiy Buxoro haqida kam maʼlum boʻlgan uchta voqeani aytib beraman.",
    prompt_en: "Hello and welcome to the channel. Today I will tell you three little-known stories about old Bukhara.",
    prompt_ru: "Здравствуйте и добро пожаловать на канал. Сегодня я расскажу вам три малоизвестные истории о старой Бухаре.",
    hues: ["#5f0f40", "#9a031e"],
  },
  {
    id: "sharpen_photo",
    mode: "enhance",
    capability: "upscale",
    prompt_uz: "Eski yoki kichik suratni ikki baravar kattaroq va tiniqroq qilish. Kutubxonadan rasm tanlang.",
    prompt_en: "Make an old or small photo twice as large and sharper. Pick a picture from your library.",
    prompt_ru: "Сделать старое или маленькое фото вдвое больше и чётче. Выберите изображение в библиотеке.",
    hues: ["#2a9d8f", "#264653"],
  },
  {
    id: "yt_history",
    mode: "youtube",
    prompt_uz: "Ipak yoʻli: karvonlar Samarqanddan qanday yoʻl bosib oʻtgan",
    prompt_en: "The Silk Road: the route caravans took from Samarkand",
    prompt_ru: "Шёлковый путь: какой дорогой шли караваны из Самарканда",
    hues: ["#9c6644", "#ddb892"],
  },
];

/** The example's words in the reader's language. */
export function examplePrompt(e: CreativeExample, locale: Locale): string {
  return locale === "uz" ? e.prompt_uz : locale === "ru" ? e.prompt_ru : e.prompt_en;
}

/**
 * Whether an example's words go into the prompt box. An Enhance example
 * describes what to do (its tool takes no words), so its text is shown on the
 * card and never sent as a prompt.
 */
export function exampleFillsPrompt(e: CreativeExample): boolean {
  return e.mode !== "enhance";
}

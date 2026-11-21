/**
 * Ads Factory, Phase 1: concept drafts from FIXED TEMPLATES. No model is called and nothing is priced.
 *
 * Given a brand kit, the products a campaign advertises and the campaign's choices, this fills in sentences that were written here, by
 * hand, with the words the person typed (the brand's name, a product's title, its price text, the first sentence of its description).
 * The same input always gives the same drafts, so a retry of one press sends the database the same content and is answered as a replay
 * (0131 add_ad_concepts). A draft is a starting point a person edits: nothing here checks a claim, and the page says so.
 *
 * The planning idea (cycle products and formats, cap one batch at 12) is ported from the concept helper of draft PR #651
 * (lib/ads-studio.ts, buildAdConcepts), extended with art directions, objectives, three languages, a call to action, a visual brief
 * and storyboard beats for video. No text, code or asset of any other product is used.
 *
 * Wording rules the templates keep (tests/ads-factory-concepts.test.ts): no superlative, no promise, no "free", no discount the person
 * did not type, no model or vendor name, and a product's name always stands in a position where it needs no grammatical ending.
 */
import {
  ADS_LIMITS,
  charLength,
  cleanBlock,
  cleanLine,
  type AdDirection,
  type AdFormat,
  type AdKind,
  type AdLanguage,
  type AdObjective,
  type StoryboardBeat,
} from "./model";

export interface DraftBrand {
  name: string;
  palette: readonly string[];
}

export interface DraftProduct {
  id: string;
  title: string;
  description: string;
  price: string;
}

export interface DraftCampaign {
  objective: AdObjective;
  language: AdLanguage;
  formats: readonly AdFormat[];
  directions: readonly AdDirection[];
}

/** One element of add_ad_concepts' p_concepts: exactly these keys (0131 refuses any other). */
export interface ConceptDraft {
  product_id: string | null;
  format: AdFormat;
  direction: AdDirection;
  kind: AdKind;
  headline: string;
  body: string;
  cta: string;
  visual_brief: string;
  storyboard: StoryboardBeat[] | null;
}

interface Templates {
  /** Two headlines per objective; `{product}`, `{brand}`. The second is used from the second pass over the combinations. */
  headline: Record<AdObjective, readonly [string, string]>;
  /** The headline when the objective is `offer` and the person typed a price: it states the price they typed and nothing more. */
  headlineWithPrice: string;
  /** The body when the product has no description. */
  body: Record<AdDirection, string>;
  cta: Record<AdObjective, string>;
  /** What the picture shows, per art direction. */
  look: Record<AdDirection, string>;
  /** How the frame is laid out, per format. */
  frame: Record<AdFormat, string>;
  colours: string;
  logo: string;
  /** Video beats: opening (per direction), detail, context, end card. */
  open: Record<AdDirection, string>;
  detail: string;
  context: string;
  endCard: string;
  endCardWithPrice: string;
  byBrand: string;
}

const EN: Templates = {
  headline: {
    awareness: ["Meet {product}", "{product}, by {brand}"],
    traffic: ["See {product} up close", "{product}: the details are on the site"],
    sales: ["{product} is ready when you are", "Bring home {product}"],
    launch: ["New from {brand}: {product}", "{product} has arrived"],
    offer: ["{brand} presents: {product}", "{product}, by {brand}"],
  },
  headlineWithPrice: "{product}: {price}",
  body: {
    spotlight: "{product}, front and centre.",
    editorial: "A closer look at {product}.",
    minimal: "{product}. Nothing extra.",
    lifestyle: "{product}, part of an ordinary day.",
    bold: "{product}. Hard to miss.",
  },
  cta: { awareness: "Learn more", traffic: "Visit the site", sales: "Shop now", launch: "See what is new", offer: "See the offer" },
  look: {
    spotlight: "{product} alone on a clean surface, lit from one side, nothing else in the frame.",
    editorial: "{product} photographed like a magazine page: natural light, a little of the setting, calm colours.",
    minimal: "{product} on a plain single-colour background with a lot of empty space around it.",
    lifestyle: "{product} in use, in a real place, with a hand or a person partly in the frame.",
    bold: "{product} large and close, strong contrast, the brand colour filling the background.",
  },
  frame: {
    "1:1": "Square frame, the product in the centre, text along the bottom.",
    "4:5": "Tall feed frame, the product in the upper two thirds, room for text below.",
    "9:16": "Full vertical frame, the product in the middle third, text clear of the top and bottom edges.",
    "16:9": "Wide frame, the product on one side, text on the other.",
  },
  colours: "Brand colours: {palette}.",
  logo: "The logo small, in one corner.",
  open: {
    spotlight: "Open on {product} alone, a light moving slowly across it.",
    editorial: "Open on the setting, then find {product} in it.",
    minimal: "Open on an empty background; {product} comes into the frame.",
    lifestyle: "Open on a hand reaching for {product}.",
    bold: "Open close on {product}, filling the frame.",
  },
  detail: "A slow close shot of one detail of {product}.",
  context: "{product} where it is used, seen from a little further away.",
  endCard: "End card: the logo and the name {product}.",
  endCardWithPrice: "End card: the logo, the name {product} and the price {price}.",
  byBrand: "By {brand}.",
};

const RU: Templates = {
  headline: {
    awareness: ["Знакомьтесь: {product}", "{brand} представляет: {product}"],
    traffic: ["{product}: посмотрите ближе", "{product}: все подробности на сайте"],
    sales: ["{product}: уже в продаже", "{product}: можно заказать"],
    launch: ["Новинка от {brand}: {product}", "{product}: уже здесь"],
    offer: ["{brand} представляет: {product}", "Знакомьтесь: {product}"],
  },
  headlineWithPrice: "{product}: {price}",
  body: {
    spotlight: "{product} крупным планом.",
    editorial: "{product}: взгляд поближе.",
    minimal: "{product}. Ничего лишнего.",
    lifestyle: "{product} в обычном дне.",
    bold: "{product}. Трудно не заметить.",
  },
  cta: { awareness: "Узнать больше", traffic: "Перейти на сайт", sales: "Купить", launch: "Смотреть новинку", offer: "Смотреть предложение" },
  look: {
    spotlight: "В кадре только {product}: чистая поверхность, свет с одной стороны, больше ничего.",
    editorial: "В кадре {product}, снято как журнальная страница: естественный свет, немного окружения, спокойные цвета.",
    minimal: "В кадре {product} на ровном одноцветном фоне, вокруг много свободного места.",
    lifestyle: "В кадре {product} в деле, в настоящем месте; рука или человек частично в кадре.",
    bold: "В кадре {product} крупно и близко, сильный контраст, фон залит цветом бренда.",
  },
  frame: {
    "1:1": "Квадратный кадр, товар в центре, текст внизу.",
    "4:5": "Вертикальный кадр для ленты, товар в верхних двух третях, место для текста внизу.",
    "9:16": "Полный вертикальный кадр, товар в средней трети, текст не касается верхнего и нижнего края.",
    "16:9": "Широкий кадр, товар с одной стороны, текст с другой.",
  },
  colours: "Цвета бренда: {palette}.",
  logo: "Логотип маленький, в углу.",
  open: {
    spotlight: "Начало: в кадре только {product}, свет медленно скользит по нему.",
    editorial: "Начало: окружение, затем в нём находится {product}.",
    minimal: "Начало: пустой фон; в кадр входит {product}.",
    lifestyle: "Начало: рука тянется к товару, это {product}.",
    bold: "Начало: {product} крупно, во весь кадр.",
  },
  detail: "Медленный крупный план одной детали: {product}.",
  context: "Общий план: {product} там, где им пользуются.",
  endCard: "Финальная карточка: логотип и название {product}.",
  endCardWithPrice: "Финальная карточка: логотип, название {product} и цена {price}.",
  byBrand: "{brand}.",
};

const UZ: Templates = {
  headline: {
    awareness: ["Tanishing: {product}", "{brand} taqdim etadi: {product}"],
    traffic: ["{product}: yaqindan koʻring", "{product}: batafsil maʼlumot saytda"],
    sales: ["{product}: sotuvda", "{product}: buyurtma berish mumkin"],
    launch: ["{brand} yangiligi: {product}", "{product}: endi shu yerda"],
    offer: ["{brand} taqdim etadi: {product}", "Tanishing: {product}"],
  },
  headlineWithPrice: "{product}: {price}",
  body: {
    spotlight: "{product} yaqin planda.",
    editorial: "{product}: yaqindan nazar.",
    minimal: "{product}. Ortiqcha narsa yoʻq.",
    lifestyle: "{product} kundalik hayotda.",
    bold: "{product}. Eʼtibordan chetda qolmaydi.",
  },
  cta: { awareness: "Batafsil", traffic: "Saytga oʻtish", sales: "Sotib olish", launch: "Yangilikni koʻrish", offer: "Taklifni koʻrish" },
  look: {
    spotlight: "Kadrda faqat {product}: toza sirt, yorugʻlik bir tomondan, boshqa hech narsa yoʻq.",
    editorial: "Kadrda {product}, jurnal sahifasidek suratga olingan: tabiiy yorugʻlik, biroz muhit, sokin ranglar.",
    minimal: "Kadrda {product} bir rangli tekis fonda, atrofida koʻp boʻsh joy.",
    lifestyle: "Kadrda {product} ishlatilmoqda, haqiqiy joyda; qoʻl yoki odam qisman koʻrinadi.",
    bold: "Kadrda {product} katta va yaqin, kuchli kontrast, fon brend rangida.",
  },
  frame: {
    "1:1": "Kvadrat kadr, mahsulot markazda, matn pastda.",
    "4:5": "Lenta uchun tik kadr, mahsulot yuqori uchdan ikki qismida, pastda matn uchun joy.",
    "9:16": "Toʻliq tik kadr, mahsulot oʻrta uchdan bir qismida, matn yuqori va pastki chetga tegmaydi.",
    "16:9": "Keng kadr, mahsulot bir tomonda, matn ikkinchi tomonda.",
  },
  colours: "Brend ranglari: {palette}.",
  logo: "Logotip kichik, burchakda.",
  open: {
    spotlight: "Boshlanishi: kadrda faqat {product}, yorugʻlik uning ustidan sekin oʻtadi.",
    editorial: "Boshlanishi: muhit, soʻng unda {product} koʻrinadi.",
    minimal: "Boshlanishi: boʻsh fon; kadrga {product} kiradi.",
    lifestyle: "Boshlanishi: qoʻl mahsulotga choʻziladi, bu {product}.",
    bold: "Boshlanishi: {product} yaqindan, butun kadrni egallaydi.",
  },
  detail: "Bir detalning sekin yaqin plani: {product}.",
  context: "Umumiy plan: {product} ishlatiladigan joyda.",
  endCard: "Yakuniy kartochka: logotip va {product} nomi.",
  endCardWithPrice: "Yakuniy kartochka: logotip, {product} nomi va narxi {price}.",
  byBrand: "{brand}.",
};

export const CONCEPT_TEMPLATES: Record<AdLanguage, Templates> = { en: EN, ru: RU, uz: UZ };

/** The first `max` characters (code points), cut back to a word boundary when one lies in the second half; no ellipsis is invented. */
export function clip(text: string, max: number): string {
  const chars = [...text];
  if (chars.length <= max) return text;
  const head = chars.slice(0, max);
  const space = head.lastIndexOf(" ");
  // The cut falls inside a word when a letter or digit stands on both sides of it: step back to the last space, if that keeps at least half.
  const word = /[\p{L}\p{N}]/u;
  const cut = word.test(chars[max]) && word.test(head[max - 1]) && space >= max / 2 ? head.slice(0, space) : head;
  return cut.join("").replace(/[\s,;:.-]+$/u, "");
}

function fill(template: string, values: Record<string, string>): string {
  // One pass over the template only: a product called "{brand}" stays those characters and is never expanded again.
  return template.replace(/\{(\w+)\}/g, (whole, key: string) => (key in values ? values[key] : whole));
}

/** The first sentence of a description, if it has one that fits a body line. */
function firstSentence(description: string): string {
  const flat = cleanLine(description);
  if (!flat) return "";
  const m = /^(.+?[.!?])(\s|$)/u.exec(flat);
  return clip(m ? m[1] : flat, 200);
}

/**
 * `count` drafts (1..12) for one campaign. The combinations are walked product first, then format, then art direction, so the first
 * drafts already cover every product, and a larger count covers every format and direction before anything repeats; a second pass
 * over the same combinations uses the second headline. Returns [] when there is nothing to plan from.
 */
export function buildConceptDrafts(input: {
  brand: DraftBrand;
  products: readonly DraftProduct[];
  campaign: DraftCampaign;
  kind: AdKind;
  count: number;
}): ConceptDraft[] {
  const { brand, products, campaign, kind } = input;
  const t = CONCEPT_TEMPLATES[campaign.language];
  const P = products.length;
  const F = campaign.formats.length;
  const D = campaign.directions.length;
  if (!t || !P || !F || !D || !cleanLine(brand.name)) return [];
  const count = Math.min(ADS_LIMITS.conceptsPerAdd, Math.max(1, Math.trunc(Number.isFinite(input.count) ? input.count : 1)));
  const brandName = clip(cleanLine(brand.name), 60);
  const palette = brand.palette.filter((c) => /^#[0-9a-f]{6}$/.test(c)).join(", ");

  const out: ConceptDraft[] = [];
  for (let i = 0; i < count; i++) {
    const product = products[i % P];
    const format = campaign.formats[Math.floor(i / P) % F];
    const direction = campaign.directions[Math.floor(i / (P * F)) % D];
    const pass = Math.floor(i / (P * F * D)) % 2;
    const title = clip(cleanLine(product.title), 70);
    const price = clip(cleanLine(product.price), ADS_LIMITS.price);
    const values = { product: title, brand: brandName, price, palette };

    const headlineTemplate =
      campaign.objective === "offer" && price && pass === 0 ? t.headlineWithPrice : t.headline[campaign.objective][pass as 0 | 1];
    const headline = clip(fill(headlineTemplate, values), ADS_LIMITS.headline);
    const body = clip(firstSentence(product.description) || fill(t.body[direction], values), ADS_LIMITS.body);
    const cta = clip(t.cta[campaign.objective], ADS_LIMITS.cta);
    const brief = cleanBlock(
      [fill(t.look[direction], values), t.frame[format], palette ? fill(t.colours, values) : "", t.logo].filter(Boolean).join("\n"),
    );

    let storyboard: StoryboardBeat[] | null = null;
    if (kind === "video") {
      storyboard = [
        { visual: fill(t.open[direction], values), line: headline },
        { visual: fill(t.detail, values), line: firstSentence(product.description) },
        { visual: fill(t.context, values), line: fill(t.byBrand, values) },
        { visual: fill(price ? t.endCardWithPrice : t.endCard, values), line: cta },
      ].map((b) => ({ visual: clip(cleanLine(b.visual), ADS_LIMITS.beatVisual), line: clip(cleanLine(b.line), ADS_LIMITS.beatLine) }));
    }
    out.push({
      product_id: product.id,
      format,
      direction,
      kind,
      headline,
      body,
      cta,
      visual_brief: clip(brief, ADS_LIMITS.brief),
      storyboard,
    });
  }
  // A draft whose headline came out empty (a product title of nothing but removed characters) is not sent: the database would refuse the batch.
  return out.filter((d) => charLength(d.headline) >= 1);
}

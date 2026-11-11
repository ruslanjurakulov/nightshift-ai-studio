/**
 * Ads Factory, Phase 1 (migration 0131, docs/ADS_FACTORY.md): the pure, client-safe half.
 *
 * A brand kit is a brand a person wrote down (name, site address as text, a logo and product pictures from the organization's own
 * media library, colours, font names, voice notes); a campaign picks products, formats, an objective, a language and art directions,
 * each from a closed list; a concept is the words of one ad. The database is the authority on every rule here: the ten functions of
 * 0131 check sign-in, membership, the editor role, every length, every closed list, every picture and the caps again. This file checks
 * the same things first so a form can say what is wrong before a round trip, shapes rows for the page and maps the database's refusals
 * to words. tests/test_ads_factory_migration.py holds the lists and limits below to the SQL, so the two cannot drift apart unseen.
 *
 * Nothing here fetches a site, calls a model or prices anything: Phase 1 does none of those.
 */

// ── closed lists (verbatim from 0131's checks) ───────────────────────────────

/** A format is a ratio. `exportPreset` names the export preset (schemas/export_presets.json) a later phase renders it with. */
export const AD_FORMATS = [
  { id: "1:1", width: 1080, height: 1080, exportPreset: "square_1080" },
  { id: "4:5", width: 1080, height: 1350, exportPreset: "feed_4x5_1080" },
  { id: "9:16", width: 1080, height: 1920, exportPreset: "vertical_1080p" },
  { id: "16:9", width: 1920, height: 1080, exportPreset: "youtube_1080p" },
] as const;
export type AdFormat = (typeof AD_FORMATS)[number]["id"];
export const AD_FORMAT_IDS: readonly AdFormat[] = AD_FORMATS.map((f) => f.id);

export const AD_OBJECTIVES = ["awareness", "traffic", "sales", "launch", "offer"] as const;
export type AdObjective = (typeof AD_OBJECTIVES)[number];

export const AD_LANGUAGES = ["en", "ru", "uz"] as const;
export type AdLanguage = (typeof AD_LANGUAGES)[number];

export const AD_DIRECTIONS = ["spotlight", "editorial", "minimal", "lifestyle", "bold"] as const;
export type AdDirection = (typeof AD_DIRECTIONS)[number];

export const AD_KINDS = ["image", "video"] as const;
export type AdKind = (typeof AD_KINDS)[number];

export const AD_STATUSES = ["draft", "approved", "archived"] as const;
export type AdStatus = (typeof AD_STATUSES)[number];

/** The lengths and counts 0131 enforces. The four per-organization caps are NOT here: they are the owner's numbers, known only to the database. */
export const ADS_LIMITS = {
  kitName: 80,
  voice: 1000,
  siteUrl: 300,
  palette: 8,
  fonts: 4,
  fontName: 60,
  productTitle: 120,
  productDescription: 1000,
  price: 40,
  productImages: 4,
  campaignName: 80,
  campaignProducts: 20,
  campaignDirections: 3,
  headline: 120,
  body: 500,
  cta: 40,
  brief: 1500,
  beats: 8,
  beatVisual: 300,
  beatLine: 200,
  conceptsPerAdd: 12,
} as const;

// ── text (the same cleaning as 0131's ads_clean_text) ─────────────────────────

/**
 * Code point ranges removed from every text: control characters and every character nobody sees, the class the comment inbox removes
 * (BR-L-120: modules/comment_replies.py, lib/comment-inbox, tests/fixtures/inbox_cleaner_cases.txt) plus the emoji/text selectors U+FE0E and
 * U+FE0F: the C1 block, soft hyphen, combining grapheme joiner, Arabic letter mark, Hangul fillers, Khmer inherent vowels, Mongolian selectors,
 * zero-width and direction marks, separators, embeddings and overrides, word joiner, invisible operators and deprecated format controls, braille
 * blank, every variation selector, BOM, interlinear annotation controls, the Egyptian, Bamum and musical format controls and the whole Unicode
 * tag block (text spelled in tag characters is a hidden-instruction channel to a model). The same class as 0131's ads_clean_text. Written as
 * numbers on purpose: a source file with those characters in it is a file nobody can review.
 */
const INVISIBLE_RANGES: readonly (readonly [number, number])[] = [
  [0x01, 0x1f],
  [0x7f, 0x9f],
  [0xad, 0xad],
  [0x34f, 0x34f],
  [0x61c, 0x61c],
  [0x115f, 0x115f],
  [0x1160, 0x1160],
  [0x17b4, 0x17b4],
  [0x17b5, 0x17b5],
  [0x180b, 0x180f],
  [0x200b, 0x200f],
  [0x2028, 0x202e],
  [0x2060, 0x206f],
  [0x2800, 0x2800],
  [0x3164, 0x3164],
  [0xfe00, 0xfe0f],
  [0xfeff, 0xfeff],
  [0xffa0, 0xffa0],
  [0xfff0, 0xfffb],
  [0x13430, 0x1343f],
  [0x1bca0, 0x1bca3],
  [0x1d173, 0x1d17a],
  [0xe0000, 0xe0fff],
];
/** Blank-looking spaces read as one ordinary space (no-break, ogham, U+2000-200A, narrow no-break, medium mathematical, ideographic). */
const BLANK_SPACES: readonly (readonly [number, number])[] = [
  [0xa0, 0xa0],
  [0x1680, 0x1680],
  [0x2000, 0x200a],
  [0x202f, 0x202f],
  [0x205f, 0x205f],
  [0x3000, 0x3000],
];
/** What a single-line field reads as one space: tab, the line breaks, and the two Unicode line separators. */
const LINE_BREAKS: readonly number[] = [0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x2028, 0x2029];

function isInvisible(cp: number): boolean {
  return cp === 0 || INVISIBLE_RANGES.some(([lo, hi]) => cp >= lo && cp <= hi);
}

function isBlankSpace(cp: number): boolean {
  return BLANK_SPACES.some(([lo, hi]) => cp >= lo && cp <= hi);
}

/**
 * A run of spaces reads as one (the blank-looking spaces are ordinary spaces by then, and whatever was removed between them is gone), then
 * only spaces and line feeds are trimmed, as Postgres btrim(text, ' \n') trims.
 */
function trimPlain(raw: string): string {
  const s = raw.replace(/ {2,}/g, " ");
  let a = 0;
  let b = s.length;
  while (a < b && (s[a] === " " || s[a] === "\n")) a++;
  while (b > a && (s[b - 1] === " " || s[b - 1] === "\n")) b--;
  return s.slice(a, b);
}

/**
 * A single-line field: a run of line breaks or tabs is one space, a blank-looking space is a space, everything invisible is removed, trimmed.
 * A run of spaces is one space. A text of nothing but those cleans to "" (and is refused wherever the field needs a character).
 */
export function cleanLine(raw: unknown): string {
  const out: string[] = [];
  let inBreak = false;
  for (const ch of typeof raw === "string" ? raw : "") {
    const cp = ch.codePointAt(0) ?? 0;
    if (LINE_BREAKS.includes(cp)) {
      if (!inBreak) out.push(" ");
      inBreak = true;
      continue;
    }
    inBreak = false;
    if (isBlankSpace(cp)) out.push(" ");
    else if (!isInvisible(cp)) out.push(ch);
  }
  return trimPlain(out.join(""));
}

/** A multi-line field: line breaks are kept (\r\n and \r read as \n), a blank-looking space is a space, everything else invisible is removed, trimmed. */
export function cleanBlock(raw: unknown): string {
  const text = (typeof raw === "string" ? raw : "").replace(/\r\n?/g, "\n");
  const out: string[] = [];
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    if (isBlankSpace(cp)) out.push(" ");
    else if (cp === 0x0a || !isInvisible(cp)) out.push(ch);
  }
  return trimPlain(out.join(""));
}

/** Length in characters as Postgres counts them (code points, not UTF-16 units). */
export function charLength(s: string): number {
  return [...s].length;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** A canonical lower-case uuid, or null. */
export function parseAdsId(raw: unknown): string | null {
  return typeof raw === "string" && UUID_RE.test(raw) ? raw : null;
}

/** The shape 0131's ads_site_url_ok accepts, character for character (the migration pin test compares the two). */
export const SITE_URL_PATTERN = String.raw`^https://([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+(xn--[a-z0-9-]{1,59}|[a-z]{2,63})(/[\x21-\x7e]*)?$`;
const SITE_URL_RE = new RegExp(SITE_URL_PATTERN);

/**
 * The site address as it is stored: `null` for none, the normalised https address, or `undefined` when it is not one the database
 * takes (http, an IP address, `localhost`, a port, a user:password, anything that is not a plain public-looking name).
 * This is a note a person typed. Nothing in Phase 1 opens it.
 */
export function normalizeSiteUrl(raw: unknown): string | null | undefined {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== "string") return undefined;
  const text = raw.trim();
  if (text === "") return null;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port) return undefined;
  const path = url.pathname === "/" && !url.search ? "/" : `${url.pathname}${url.search}`;
  const out = `https://${url.hostname}${path}`;
  return charLength(out) <= ADS_LIMITS.siteUrl && SITE_URL_RE.test(out) ? out : undefined;
}

const HEX_RE = /^#[0-9a-f]{6}$/;
/** A font NAME: letters, digits, space, dot, underscore, apostrophe, hyphen; never a URL, a CSS value or a file (0131 ads_text_list_ok). */
const FONT_RE = /^[A-Za-z0-9][A-Za-z0-9 ._'-]*$/;

/** `#AABBCC` -> `#aabbcc`, or null when it is not exactly a six-digit hex colour. Never any other CSS value. */
export function parseHexColor(raw: unknown): string | null {
  const v = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  return HEX_RE.test(v) ? v : null;
}

// ── input ───────────────────────────────────────────────────────────────────

export type AdsInputError =
  | "bad_request"
  | "invalid_name"
  | "invalid_site_url"
  | "invalid_voice"
  | "invalid_palette"
  | "invalid_fonts"
  | "invalid_reference"
  | "duplicate_reference"
  | "too_many_references"
  | "invalid_title"
  | "invalid_description"
  | "invalid_price"
  | "invalid_objective"
  | "invalid_language"
  | "invalid_formats"
  | "invalid_directions"
  | "invalid_products"
  | "invalid_headline"
  | "invalid_body"
  | "invalid_cta"
  | "invalid_visual_brief"
  | "invalid_storyboard"
  | "invalid_status"
  | "invalid_kind"
  | "invalid_count"
  | "invalid_idempotency_key";

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: AdsInputError };

function record(raw: unknown): Record<string, unknown> | null {
  return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
}

function textOf(raw: unknown): string | null {
  if (raw === undefined || raw === null) return "";
  return typeof raw === "string" ? raw : null;
}

/** A list of distinct ids, at most `max`; `min` is the fewest a save takes. */
function idList(raw: unknown, min: number, max: number, tooMany: AdsInputError, bad: AdsInputError, dup: AdsInputError): Parsed<string[]> {
  const list = raw === undefined || raw === null ? [] : raw;
  if (!Array.isArray(list)) return { ok: false, error: "bad_request" };
  if (list.length > max) return { ok: false, error: tooMany };
  const ids: string[] = [];
  for (const v of list) {
    const id = parseAdsId(v);
    if (!id) return { ok: false, error: bad };
    if (ids.includes(id)) return { ok: false, error: dup };
    ids.push(id);
  }
  if (ids.length < min) return { ok: false, error: bad };
  return { ok: true, value: ids };
}

function closedList<T extends string>(raw: unknown, allowed: readonly T[], min: number, max: number): T[] | null {
  if (!Array.isArray(raw) || raw.length < min || raw.length > max) return null;
  const out: T[] = [];
  for (const v of raw) {
    if (typeof v !== "string" || !(allowed as readonly string[]).includes(v) || out.includes(v as T)) return null;
    out.push(v as T);
  }
  return out;
}

export interface KitInput {
  name: string;
  siteUrl: string | null;
  logoAssetId: string | null;
  palette: string[];
  fonts: string[];
  voice: string;
}

/** `{ name, site_url?, logo_asset_id?, palette?, fonts?, voice? }` for POST /api/ads/kits and PATCH /api/ads/kits/<id>. */
export function parseKitInput(raw: unknown): Parsed<KitInput> {
  const b = record(raw);
  if (!b) return { ok: false, error: "bad_request" };
  if (typeof b.name !== "string") return { ok: false, error: "invalid_name" };
  const name = cleanLine(b.name);
  if (charLength(name) < 1 || charLength(name) > ADS_LIMITS.kitName) return { ok: false, error: "invalid_name" };
  const siteUrl = normalizeSiteUrl(b.site_url);
  if (siteUrl === undefined) return { ok: false, error: "invalid_site_url" };
  const voiceRaw = textOf(b.voice);
  if (voiceRaw === null) return { ok: false, error: "bad_request" };
  const voice = cleanBlock(voiceRaw);
  if (charLength(voice) > ADS_LIMITS.voice) return { ok: false, error: "invalid_voice" };

  const paletteRaw = b.palette === undefined || b.palette === null ? [] : b.palette;
  if (!Array.isArray(paletteRaw) || paletteRaw.length > ADS_LIMITS.palette) return { ok: false, error: "invalid_palette" };
  const palette: string[] = [];
  for (const v of paletteRaw) {
    const hex = parseHexColor(v);
    if (!hex || palette.includes(hex)) return { ok: false, error: "invalid_palette" };
    palette.push(hex);
  }

  const fontsRaw = b.fonts === undefined || b.fonts === null ? [] : b.fonts;
  if (!Array.isArray(fontsRaw) || fontsRaw.length > ADS_LIMITS.fonts) return { ok: false, error: "invalid_fonts" };
  const fonts: string[] = [];
  for (const v of fontsRaw) {
    const font = typeof v === "string" ? cleanLine(v) : "";
    if (charLength(font) < 1 || charLength(font) > ADS_LIMITS.fontName || !FONT_RE.test(font) || fonts.includes(font)) {
      return { ok: false, error: "invalid_fonts" };
    }
    fonts.push(font);
  }

  let logoAssetId: string | null = null;
  if (b.logo_asset_id !== undefined && b.logo_asset_id !== null && b.logo_asset_id !== "") {
    logoAssetId = parseAdsId(b.logo_asset_id);
    if (!logoAssetId) return { ok: false, error: "invalid_reference" };
  }
  return { ok: true, value: { name, siteUrl, logoAssetId, palette, fonts, voice } };
}

export interface ProductInput {
  title: string;
  description: string;
  price: string;
  imageIds: string[];
}

/** `{ title, description?, price?, image_ids? }` for POST /api/ads/kits/<id>/products and PATCH /api/ads/products/<id>. */
export function parseProductInput(raw: unknown): Parsed<ProductInput> {
  const b = record(raw);
  if (!b) return { ok: false, error: "bad_request" };
  if (typeof b.title !== "string") return { ok: false, error: "invalid_title" };
  const title = cleanLine(b.title);
  if (charLength(title) < 1 || charLength(title) > ADS_LIMITS.productTitle) return { ok: false, error: "invalid_title" };
  const d = textOf(b.description);
  const p = textOf(b.price);
  if (d === null || p === null) return { ok: false, error: "bad_request" };
  const description = cleanBlock(d);
  if (charLength(description) > ADS_LIMITS.productDescription) return { ok: false, error: "invalid_description" };
  const price = cleanLine(p);
  if (charLength(price) > ADS_LIMITS.price) return { ok: false, error: "invalid_price" };
  const ids = idList(b.image_ids, 0, ADS_LIMITS.productImages, "too_many_references", "invalid_reference", "duplicate_reference");
  if (!ids.ok) return ids;
  return { ok: true, value: { title, description, price, imageIds: ids.value } };
}

export interface CampaignInput {
  name: string;
  objective: AdObjective;
  language: AdLanguage;
  formats: AdFormat[];
  directions: AdDirection[];
  productIds: string[];
}

/** `{ name, objective, language, formats, directions, product_ids }` for POST /api/ads/campaigns and PATCH /api/ads/campaigns/<id>. */
export function parseCampaignInput(raw: unknown): Parsed<CampaignInput> {
  const b = record(raw);
  if (!b) return { ok: false, error: "bad_request" };
  if (typeof b.name !== "string") return { ok: false, error: "invalid_name" };
  const name = cleanLine(b.name);
  if (charLength(name) < 1 || charLength(name) > ADS_LIMITS.campaignName) return { ok: false, error: "invalid_name" };
  // Closed lists, compared exactly: an unknown word is refused, never read as a default.
  if (typeof b.objective !== "string" || !(AD_OBJECTIVES as readonly string[]).includes(b.objective)) return { ok: false, error: "invalid_objective" };
  if (typeof b.language !== "string" || !(AD_LANGUAGES as readonly string[]).includes(b.language)) return { ok: false, error: "invalid_language" };
  const formats = closedList(b.formats, AD_FORMAT_IDS, 1, AD_FORMAT_IDS.length);
  if (!formats) return { ok: false, error: "invalid_formats" };
  const directions = closedList(b.directions, AD_DIRECTIONS, 1, ADS_LIMITS.campaignDirections);
  if (!directions) return { ok: false, error: "invalid_directions" };
  const ids = idList(b.product_ids, 1, ADS_LIMITS.campaignProducts, "invalid_products", "invalid_products", "invalid_products");
  if (!ids.ok) return ids;
  return {
    ok: true,
    value: { name, objective: b.objective as AdObjective, language: b.language as AdLanguage, formats, directions, productIds: ids.value },
  };
}

export interface StoryboardBeat {
  visual: string;
  line: string;
}

/** 1..8 beats, each `{ visual, line? }` and nothing else, cleaned; or null when it is not that. */
export function parseBeats(raw: unknown): StoryboardBeat[] | null {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > ADS_LIMITS.beats) return null;
  const out: StoryboardBeat[] = [];
  for (const item of raw) {
    const b = record(item);
    if (!b || Object.keys(b).some((k) => k !== "visual" && k !== "line") || typeof b.visual !== "string") return null;
    const lineRaw = textOf(b.line);
    if (lineRaw === null) return null;
    const visual = cleanLine(b.visual);
    const line = cleanLine(lineRaw);
    if (charLength(visual) < 1 || charLength(visual) > ADS_LIMITS.beatVisual || charLength(line) > ADS_LIMITS.beatLine) return null;
    out.push({ visual, line });
  }
  return out;
}

export interface ConceptEdit {
  headline: string;
  body: string;
  cta: string;
  visualBrief: string;
  /** null for an image concept; the database refuses beats on an image and a video without them. */
  storyboard: StoryboardBeat[] | null;
}

/** `{ headline, body?, cta?, visual_brief?, storyboard? }` for PATCH /api/ads/concepts/<id> (the words of a draft). */
export function parseConceptEdit(raw: unknown): Parsed<ConceptEdit> {
  const b = record(raw);
  if (!b) return { ok: false, error: "bad_request" };
  if (typeof b.headline !== "string") return { ok: false, error: "invalid_headline" };
  const headline = cleanLine(b.headline);
  if (charLength(headline) < 1 || charLength(headline) > ADS_LIMITS.headline) return { ok: false, error: "invalid_headline" };
  const bodyRaw = textOf(b.body);
  const ctaRaw = textOf(b.cta);
  const briefRaw = textOf(b.visual_brief);
  if (bodyRaw === null || ctaRaw === null || briefRaw === null) return { ok: false, error: "bad_request" };
  const body = cleanBlock(bodyRaw);
  if (charLength(body) > ADS_LIMITS.body) return { ok: false, error: "invalid_body" };
  const cta = cleanLine(ctaRaw);
  if (charLength(cta) > ADS_LIMITS.cta) return { ok: false, error: "invalid_cta" };
  const visualBrief = cleanBlock(briefRaw);
  if (charLength(visualBrief) > ADS_LIMITS.brief) return { ok: false, error: "invalid_visual_brief" };
  let storyboard: StoryboardBeat[] | null = null;
  if (b.storyboard !== undefined && b.storyboard !== null) {
    storyboard = parseBeats(b.storyboard);
    if (!storyboard) return { ok: false, error: "invalid_storyboard" };
  }
  return { ok: true, value: { headline, body, cta, visualBrief, storyboard } };
}

export function parseStatus(raw: unknown): AdStatus | null {
  return typeof raw === "string" && (AD_STATUSES as readonly string[]).includes(raw) ? (raw as AdStatus) : null;
}

/** The id of one press of "add concept drafts": the same press again answers the first one (0131 add_ad_concepts). */
export const BATCH_KEY_RE = /^[A-Za-z0-9_:.-]{8,128}$/;

export interface GenerateInput {
  kind: AdKind;
  count: number;
  batch: string;
}

/** `{ kind, count, batch }` for POST /api/ads/campaigns/<id>/concepts. */
export function parseGenerateInput(raw: unknown): Parsed<GenerateInput> {
  const b = record(raw);
  if (!b) return { ok: false, error: "bad_request" };
  if (typeof b.kind !== "string" || !(AD_KINDS as readonly string[]).includes(b.kind)) return { ok: false, error: "invalid_kind" };
  if (typeof b.count !== "number" || !Number.isInteger(b.count) || b.count < 1 || b.count > ADS_LIMITS.conceptsPerAdd) {
    return { ok: false, error: "invalid_count" };
  }
  if (typeof b.batch !== "string" || !BATCH_KEY_RE.test(b.batch)) return { ok: false, error: "invalid_idempotency_key" };
  return { ok: true, value: { kind: b.kind as AdKind, count: b.count, batch: b.batch } };
}

// ── rows ────────────────────────────────────────────────────────────────────

/** A library picture a kit or a product names. `live` is false once it was deleted from the library: the gap is shown, never hidden. */
export interface AdsPicture {
  assetId: string;
  live: boolean;
  thumbUrl: string | null;
  name: string | null;
}

export interface BrandProduct {
  id: string;
  kitId: string;
  title: string;
  description: string;
  price: string;
  source: "manual" | "scan";
  images: AdsPicture[];
}

export interface BrandKit {
  id: string;
  name: string;
  siteUrl: string | null;
  logo: AdsPicture | null;
  palette: string[];
  fonts: string[];
  voice: string;
  source: "manual" | "scan";
  updatedAt: string | null;
  products: BrandProduct[];
}

export interface AdConcept {
  id: string;
  campaignId: string;
  productId: string | null;
  format: AdFormat;
  direction: AdDirection;
  kind: AdKind;
  headline: string;
  body: string;
  cta: string;
  visualBrief: string;
  storyboard: StoryboardBeat[] | null;
  status: AdStatus;
  updatedAt: string | null;
}

export interface AdCampaign {
  id: string;
  kitId: string;
  name: string;
  objective: AdObjective;
  language: AdLanguage;
  formats: AdFormat[];
  directions: AdDirection[];
  productIds: string[];
  updatedAt: string | null;
  concepts: AdConcept[];
}

/** What the page reads (lib/server/ads-factory.ts). `available: false`: migration 0131 is not applied. `error`: a read failed. */
export interface AdsWorkspaceData {
  available: boolean;
  kits: BrandKit[];
  campaigns: AdCampaign[];
  error?: "read_failed";
}

export const BRAND_KIT_COLUMNS = "id, name, site_url, logo_asset_id, palette, fonts, voice_notes, source, updated_at";
export const BRAND_PRODUCT_COLUMNS = "id, kit_id, title, description, price_text, source, created_at";
export const AD_CAMPAIGN_COLUMNS = "id, kit_id, name, objective, language, formats, directions, updated_at";
export const AD_CONCEPT_COLUMNS =
  "id, campaign_id, product_id, format, direction, kind, headline, body, cta, visual_brief, storyboard, status, updated_at, created_at, batch_n";

function str(v: unknown): string | null {
  return typeof v === "string" && v ? v : null;
}

function oneOf<T extends string>(v: unknown, allowed: readonly T[]): T | null {
  return typeof v === "string" && (allowed as readonly string[]).includes(v) ? (v as T) : null;
}

function listOf<T extends string>(v: unknown, allowed: readonly T[]): T[] {
  return Array.isArray(v) ? v.filter((x): x is T => typeof x === "string" && (allowed as readonly string[]).includes(x)) : [];
}

function rows(data: unknown): Record<string, unknown>[] {
  return Array.isArray(data) ? data.filter((r): r is Record<string, unknown> => Boolean(r) && typeof r === "object") : [];
}

export interface OrderedRef {
  owner: string;
  target: string;
  position: number;
}

/** brand_product_images / ad_campaign_products rows -> (owner, target, position), in order. */
export function coerceOrderedRefs(data: unknown, ownerColumn: string, targetColumn: string): OrderedRef[] {
  const out: OrderedRef[] = [];
  for (const r of rows(data)) {
    const owner = parseAdsId(r[ownerColumn]);
    const target = parseAdsId(r[targetColumn]);
    const position = typeof r.position === "number" && Number.isFinite(r.position) ? r.position : null;
    if (owner && target && position !== null) out.push({ owner, target, position });
  }
  return out.sort((a, b) => a.position - b.position);
}

export type PictureLookup = ReadonlyMap<string, { thumbUrl: string | null; name: string | null }>;

function picture(assetId: string, live: PictureLookup): AdsPicture {
  const a = live.get(assetId);
  return { assetId, live: Boolean(a), thumbUrl: a?.thumbUrl ?? null, name: a?.name ?? null };
}

export function coerceProducts(data: unknown, images: OrderedRef[], live: PictureLookup): BrandProduct[] {
  const out: BrandProduct[] = [];
  for (const r of rows(data)) {
    const id = parseAdsId(r.id);
    const kitId = parseAdsId(r.kit_id);
    if (!id || !kitId || typeof r.title !== "string") continue;
    out.push({
      id,
      kitId,
      title: r.title,
      description: typeof r.description === "string" ? r.description : "",
      price: typeof r.price_text === "string" ? r.price_text : "",
      source: r.source === "scan" ? "scan" : "manual",
      images: images.filter((i) => i.owner === id).map((i) => picture(i.target, live)),
    });
  }
  return out;
}

export function coerceKits(data: unknown, products: BrandProduct[], live: PictureLookup): BrandKit[] {
  const out: BrandKit[] = [];
  for (const r of rows(data)) {
    const id = parseAdsId(r.id);
    if (!id || typeof r.name !== "string") continue;
    const logoId = parseAdsId(r.logo_asset_id);
    out.push({
      id,
      name: r.name,
      siteUrl: str(r.site_url),
      logo: logoId ? picture(logoId, live) : null,
      // Only what the page may put into a style attribute: a stored value that is not #rrggbb is dropped, never drawn.
      palette: Array.isArray(r.palette) ? r.palette.filter((c): c is string => typeof c === "string" && HEX_RE.test(c)) : [],
      fonts: Array.isArray(r.fonts) ? r.fonts.filter((f): f is string => typeof f === "string" && FONT_RE.test(f)) : [],
      voice: typeof r.voice_notes === "string" ? r.voice_notes : "",
      source: r.source === "scan" ? "scan" : "manual",
      updatedAt: str(r.updated_at),
      products: products.filter((p) => p.kitId === id),
    });
  }
  return out;
}

export function coerceConcepts(data: unknown): AdConcept[] {
  const out: AdConcept[] = [];
  for (const r of rows(data)) {
    const id = parseAdsId(r.id);
    const campaignId = parseAdsId(r.campaign_id);
    const format = oneOf(r.format, AD_FORMAT_IDS);
    const direction = oneOf(r.direction, AD_DIRECTIONS);
    const kind = oneOf(r.kind, AD_KINDS);
    const status = oneOf(r.status, AD_STATUSES);
    // A row this version cannot name (a later migration's format or status) is left out rather than shown as something it is not.
    if (!id || !campaignId || !format || !direction || !kind || !status || typeof r.headline !== "string") continue;
    out.push({
      id,
      campaignId,
      productId: parseAdsId(r.product_id),
      format,
      direction,
      kind,
      headline: r.headline,
      body: typeof r.body === "string" ? r.body : "",
      cta: typeof r.cta === "string" ? r.cta : "",
      visualBrief: typeof r.visual_brief === "string" ? r.visual_brief : "",
      storyboard: kind === "video" ? (parseBeats(r.storyboard) ?? []) : null,
      status,
      updatedAt: str(r.updated_at),
    });
  }
  return out;
}

export function coerceCampaigns(data: unknown, products: OrderedRef[], concepts: AdConcept[]): AdCampaign[] {
  const out: AdCampaign[] = [];
  for (const r of rows(data)) {
    const id = parseAdsId(r.id);
    const kitId = parseAdsId(r.kit_id);
    const objective = oneOf(r.objective, AD_OBJECTIVES);
    const language = oneOf(r.language, AD_LANGUAGES);
    if (!id || !kitId || !objective || !language || typeof r.name !== "string") continue;
    out.push({
      id,
      kitId,
      name: r.name,
      objective,
      language,
      formats: listOf(r.formats, AD_FORMAT_IDS),
      directions: listOf(r.directions, AD_DIRECTIONS),
      productIds: products.filter((p) => p.owner === id).map((p) => p.target),
      updatedAt: str(r.updated_at),
      concepts: concepts.filter((c) => c.campaignId === id),
    });
  }
  return out;
}

// ── errors ──────────────────────────────────────────────────────────────────

export type AdsError =
  | AdsInputError
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "limit_reached"
  | "kit_in_use"
  | "concept_not_draft"
  | "invalid_transition"
  | "idempotency_conflict"
  | "invalid_concept"
  | "invalid_concepts"
  | "org_required"
  | "not_available"
  | "not_configured"
  | "read_failed"
  | "failed";

const INPUT_WORDS: readonly string[] = [
  "invalid_name", "invalid_site_url", "invalid_voice", "invalid_palette", "invalid_fonts", "invalid_reference", "duplicate_reference",
  "too_many_references", "invalid_title", "invalid_description", "invalid_price", "invalid_objective", "invalid_language", "invalid_formats",
  "invalid_directions", "invalid_products", "invalid_headline", "invalid_body", "invalid_cta", "invalid_visual_brief", "invalid_storyboard",
  "invalid_status", "invalid_idempotency_key", "invalid_concept", "invalid_concepts",
];
const CONFLICT_WORDS: readonly string[] = ["kit_in_use", "concept_not_draft", "invalid_transition", "idempotency_conflict"];

export interface MappedAdsError {
  error: AdsError;
  status: number;
  /** The cap the database named in a `limit_reached` refusal (its own number, never a guess); absent when it named none. */
  max?: number;
}

/** A refusal from 0131's functions, checks or triggers -> a word and an HTTP status. No database text is passed through. */
export function mapAdsError(error: { code?: string; message?: string; details?: string } | null | undefined): MappedAdsError {
  const word = (error?.message ?? "").trim();
  switch (error?.code) {
    case "NS400":
      return { error: INPUT_WORDS.includes(word) ? (word as AdsError) : "bad_request", status: 400 };
    case "NS409":
      return { error: CONFLICT_WORDS.includes(word) ? (word as AdsError) : "failed", status: CONFLICT_WORDS.includes(word) ? 409 : 502 };
    case "NS429": {
      const m = /(?:^|\s)max=(\d{1,5})(?:\s|$)/.exec(error?.details ?? "");
      return m ? { error: "limit_reached", status: 409, max: Number(m[1]) } : { error: "limit_reached", status: 409 };
    }
    case "42501":
      return { error: "forbidden", status: 403 };
    case "P0002":
      return { error: "not_found", status: 404 };
    case "PGRST202":
    case "PGRST205":
    case "42883":
    case "42P01":
    case "42703":
      return { error: "not_available", status: 503 };
  }
  if (/could not find the (function|table)|does not exist/i.test(error?.message ?? "")) return { error: "not_available", status: 503 };
  return { error: "failed", status: 502 };
}

/** Is this read failure "0131 is not applied" (degrade honestly) rather than a failed read? */
export function isMissingRelation(error: { code?: string; message?: string } | null | undefined): boolean {
  if (!error) return false;
  return error.code === "42P01" || error.code === "PGRST205" || error.code === "42703" || /does not exist|could not find the table/i.test(error.message ?? "");
}

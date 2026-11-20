/**
 * Trend templates (migration 0181): the Trends gallery's ready formats. Pure and client-safe — the row coercion, the API's wire
 * shape (the contract with the Create screen), the placeholder list and the media URL. The database read lives in ./server.ts.
 *
 * A template is a FORMAT: a prompt with {placeholders}, a model it was written for, a shape and a length. Following one opens
 * Create prefilled and stops there; the price is the quote route's (CLAUDE.md rule 3).
 *
 * Whether the model is on sale is never stored with the template: it is asked of sellable_models() per request, and the answer
 * keeps three states (rule 5). `model_available` is true only when the registry said so for this viewer; `model_status` says
 * whether a false is a measured "not on sale" or an "unknown" (signed out, registry not readable). No substitute model is ever
 * named (rule 4).
 */
import type { Locale } from "@/lib/i18n/core";

export const TEMPLATE_CATEGORIES = ["business", "story", "lifestyle", "text"] as const;
export type TemplateCategory = (typeof TEMPLATE_CATEGORIES)[number];

export const TEMPLATE_KINDS = ["video", "image"] as const;
export type TemplateKind = (typeof TEMPLATE_KINDS)[number];

export const TEMPLATE_ASPECTS = ["16:9", "9:16", "1:1"] as const;
export type TemplateAspect = (typeof TEMPLATE_ASPECTS)[number];

/** The public bucket 0181 creates; a stored path is always inside it. */
export const TEMPLATE_MEDIA_BUCKET = "template-media";

/** Home shows this many; the gallery asks for all of them. */
export const HOME_TEMPLATE_LIMIT = 6;
export const MAX_TEMPLATE_LIMIT = 50;

export const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,47}$/;
// Mirrors 0181's creative_templates_media_path_check: no scheme, no host, no "..", so a URL can only point at our bucket.
const VIDEO_PATH_RE = /^[a-z0-9][a-z0-9_/-]{0,150}\.(mp4|webm)$/;
const IMAGE_PATH_RE = /^[a-z0-9][a-z0-9_/-]{0,150}\.(webp|jpg|jpeg|png)$/;
const PLACEHOLDER_RE = /\{([a-z][a-z0-9_]{0,31})\}/g;

export type ModelStatus = "available" | "unavailable" | "unknown";

type L10n = Record<Locale, string>;

/** One row of creative_templates as read (published rows only reach an API role). */
export interface TemplateRow {
  slug: string;
  title: L10n;
  description: L10n;
  category: TemplateCategory;
  kind: TemplateKind;
  promptTemplate: string;
  modelId: string;
  aspect: TemplateAspect;
  durationS: number | null;
  quality: string | null;
  director: Record<string, unknown> | null;
  previewPath: string | null;
  posterPath: string | null;
  sort: number;
}

/** The wire shape of /api/templates and /api/templates/<slug> (the contract with the Create screen). */
export interface TemplateDto {
  slug: string;
  kind: TemplateKind;
  title: string;
  description: string;
  category: TemplateCategory;
  prompt: string;
  /** The {names} the person fills in, in the order they first appear in the prompt. */
  placeholders: string[];
  model_id: string;
  model_available: boolean;
  model_status: ModelStatus;
  aspect: TemplateAspect;
  duration_s: number | null;
  quality: string | null;
  director?: Record<string, unknown>;
  preview_url?: string;
  poster_url?: string;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const oneOf = <T extends string>(list: readonly T[], v: unknown): v is T => typeof v === "string" && (list as readonly string[]).includes(v);

export const isTemplateCategory = (v: unknown): v is TemplateCategory => oneOf(TEMPLATE_CATEGORIES, v);

function l10n(v: unknown): L10n | null {
  if (!isObj(v)) return null;
  const { en, ru, uz } = v;
  if (typeof en !== "string" || typeof ru !== "string" || typeof uz !== "string" || !en || !ru || !uz) return null;
  return { en, ru, uz };
}

/**
 * Rows as typed templates. A malformed row is dropped, never shown half-filled: a missing translation would be a blank card,
 * a bad media path a link off our bucket (the CHECKs refuse both; this is the second lock in case one is edited).
 */
export function coerceTemplateRows(rows: unknown): TemplateRow[] {
  if (!Array.isArray(rows)) return [];
  const out: TemplateRow[] = [];
  for (const r of rows) {
    if (!isObj(r)) continue;
    const title = l10n(r.title);
    const description = l10n(r.description);
    if (!title || !description) continue;
    if (typeof r.slug !== "string" || !SLUG_RE.test(r.slug)) continue;
    if (!isTemplateCategory(r.category) || !oneOf(TEMPLATE_KINDS, r.kind) || !oneOf(TEMPLATE_ASPECTS, r.aspect)) continue;
    if (typeof r.prompt_template !== "string" || !r.prompt_template) continue;
    if (typeof r.model_id !== "string" || !r.model_id) continue;
    const duration = r.duration_s;
    if (r.kind === "video" && !(duration === 5 || duration === 10)) continue;
    if (r.kind === "image" && duration !== null && duration !== undefined) continue;
    const preview = typeof r.preview_asset_path === "string" && VIDEO_PATH_RE.test(r.preview_asset_path) && !r.preview_asset_path.includes("..")
      ? r.preview_asset_path
      : null;
    const poster = typeof r.poster_path === "string" && IMAGE_PATH_RE.test(r.poster_path) && !r.poster_path.includes("..")
      ? r.poster_path
      : null;
    out.push({
      slug: r.slug,
      title,
      description,
      category: r.category,
      kind: r.kind,
      promptTemplate: r.prompt_template,
      modelId: r.model_id,
      aspect: r.aspect,
      durationS: r.kind === "video" ? (duration as number) : null,
      quality: typeof r.quality === "string" && r.quality ? r.quality : null,
      director: isObj(r.director) && Object.keys(r.director).length > 0 ? r.director : null,
      previewPath: preview,
      posterPath: poster,
      sort: typeof r.sort === "number" ? r.sort : 100,
    });
  }
  return out.sort((a, b) => a.sort - b.sort || a.slug.localeCompare(b.slug));
}

export function placeholdersOf(prompt: string): string[] {
  const seen: string[] = [];
  for (const m of prompt.matchAll(PLACEHOLDER_RE)) if (!seen.includes(m[1])) seen.push(m[1]);
  return seen;
}

/** A public object URL in the template bucket; null without a configured Supabase URL (no guessed host). */
export function templateMediaUrl(supabaseUrl: string, path: string | null): string | null {
  if (!path || !/^https?:\/\//.test(supabaseUrl)) return null;
  const base = supabaseUrl.replace(/\/+$/, "");
  return `${base}/storage/v1/object/public/${TEMPLATE_MEDIA_BUCKET}/${path.split("/").map(encodeURIComponent).join("/")}`;
}

/**
 * The capability a template's model must be sold for. A video template is written as text-to-video and an image one as
 * text-to-image: a model on sale only for another tool is not "available" for this template.
 */
export function capabilityFor(kind: TemplateKind): "t2v" | "t2i" {
  return kind === "video" ? "t2v" : "t2i";
}

/**
 * `sellable` is the set of model ids on sale for the template's capability for this viewer, or null when that could not be
 * read (signed out, registry not migrated, an error): then the status is "unknown" and model_available is false.
 */
export function toDto(
  row: TemplateRow,
  locale: Locale,
  sellable: { t2v: ReadonlySet<string>; t2i: ReadonlySet<string> } | null,
  supabaseUrl: string,
): TemplateDto {
  const status: ModelStatus = sellable === null ? "unknown" : sellable[capabilityFor(row.kind)].has(row.modelId) ? "available" : "unavailable";
  const dto: TemplateDto = {
    slug: row.slug,
    kind: row.kind,
    title: row.title[locale],
    description: row.description[locale],
    category: row.category,
    prompt: row.promptTemplate,
    placeholders: placeholdersOf(row.promptTemplate),
    model_id: row.modelId,
    model_available: status === "available",
    model_status: status,
    aspect: row.aspect,
    duration_s: row.durationS,
    quality: row.quality,
  };
  if (row.director) dto.director = row.director;
  const preview = templateMediaUrl(supabaseUrl, row.previewPath);
  const poster = templateMediaUrl(supabaseUrl, row.posterPath);
  if (preview) dto.preview_url = preview;
  if (poster) dto.poster_url = poster;
  return dto;
}

/** Parse the list route's query. An unknown category is refused (400), never read as "all". */
export function parseListQuery(
  params: URLSearchParams,
): { ok: true; category: TemplateCategory | null; limit: number; locale: Locale | null } | { ok: false; error: string } {
  const cat = params.get("category");
  if (cat !== null && cat !== "" && !isTemplateCategory(cat)) return { ok: false, error: "bad_category" };
  const rawLimit = params.get("limit");
  let limit = MAX_TEMPLATE_LIMIT;
  if (rawLimit !== null) {
    const n = Number(rawLimit);
    if (!Number.isInteger(n) || n < 1 || n > MAX_TEMPLATE_LIMIT) return { ok: false, error: "bad_limit" };
    limit = n;
  }
  const loc = params.get("locale");
  if (loc !== null && loc !== "" && loc !== "en" && loc !== "ru" && loc !== "uz") return { ok: false, error: "bad_locale" };
  return { ok: true, category: cat ? (cat as TemplateCategory) : null, limit, locale: loc ? (loc as Locale) : null };
}

/** The Create screen's address for a template (S1 reads ?template=). Following it only fills the form. */
export function templateCreateHref(slug: string): string {
  return `/create?template=${encodeURIComponent(slug)}`;
}

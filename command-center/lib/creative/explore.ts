/**
 * The Studio's explore grid, the part a browser may hold (components/studio/StudioExplore.tsx, below the fold of the customer's
 * Create screen): the shapes the page hands it, and the rules it applies to the one thing it reads itself, /api/templates. Nothing
 * here may import lib/site/showcase* (the samples' manifest names vendors and models and stays on the server): the samples are built
 * in ./explore-server.ts and arrive as ExploreSample, which holds no model id, name or maker.
 *
 * What is shown as available (CLAUDE.md "Definition of Done": nothing is shown as available that is not): a card appears only when
 * its model is on sale to THIS workspace for the card's tool, as the server's own catalogue says (`OnSale`, built in
 * ./explore-server.ts). An operator preview is not on sale, even to the operator; a locked or unpriced model is not either.
 */
import { capabilityFor, type TemplateDto } from "@/lib/templates/trends";

/** The model ids on sale to this workspace, per tool. Built on the server from the page's catalogue; the browser only reads it. */
export type OnSale = Readonly<Record<string, readonly string[]>>;

/** Own keys only: a capability of `__proto__` or `constructor` (a forged body) is simply not on sale, never a TypeError. */
export function isOnSale(onSale: OnSale, capability: string, modelId: unknown): boolean {
  if (typeof capability !== "string" || typeof modelId !== "string" || !Object.hasOwn(onSale, capability)) return false;
  const list = onSale[capability];
  return Array.isArray(list) && list.includes(modelId);
}

/** Nothing on sale here for any tool the grid shows: no sample, and no model a format could use. */
export function nothingOnSale(samples: readonly unknown[], onSale: OnSale): boolean {
  return samples.length === 0 && Object.values(onSale).every((ids) => !Array.isArray(ids) || ids.length === 0);
}

/**
 * What the page hands the grid: `ok` with the server-built samples and catalogue, or `unread` when the registry could not be read
 * (readStudioModels() answered null) or there is no organization to read it for. Unread is never drawn as "nothing on sale yet"
 * (CLAUDE.md rule 5): the grid then says, quietly, that it could not check.
 */
export type ExploreData = { state: "ok"; samples: ExploreSample[]; onSale: OnSale } | { state: "unread" };

/** One sample card, as the browser gets it: no model id, no model name, no maker. */
export interface ExploreSample {
  /** The creative job that made it (its clip's key, and the card's own id). */
  id: string;
  kind: "video" | "image";
  width: number;
  height: number;
  poster: string;
  srcSet: string;
  /** A clip file ships for it (a video whose files are here); a picture is its poster alone. */
  clip: boolean;
  /** The hand-written title in this language (lib/site/card-titles.ts), or null for a sample merged before its title was. */
  title: string | null;
  /** One grey line: the export's card line in this language, else the prompt's first sentence (marked `en`); "" for none. */
  line: { text: string; lang: string };
  /** This channel's Studio form for it, as a section for useChannelPath (`/create?tool=…&model=…&prompt=…[&sample=…]`). */
  href: string;
}

/** The template rows: what is trending, videos by topic, and the business pictures as brand-style variants. */
export const TEMPLATE_ROWS = ["trending", "topics", "brand"] as const;
export type TemplateRow = (typeof TEMPLATE_ROWS)[number];

/**
 * Which row a template belongs to, or null for none: `viral` is the trend row (0186), the other video formats are the topic row,
 * the `business` pictures are the brand-style row (docs/studio/S8_MEDIA_FIRST.md). The text pictures (a fact card, a quote poster)
 * have no row here; the Trends page lists them.
 */
export function templateRow(t: Pick<TemplateDto, "category" | "kind">): TemplateRow | null {
  if (t.category === "viral") return "trending";
  if (t.kind === "video") return "topics";
  if (t.category === "business" && t.kind === "image") return "brand";
  return null;
}

/**
 * The templates each row shows. Two answers must agree that the template's model is on sale: the templates route's own
 * (`model_status`, sellable_models() for this person) and this page's catalogue (`onSale`, which also knows this organization's
 * locks). An "unknown" status is not "available": it gets no card here (the Trends page says "unknown" out loud; a media-first
 * card has no room to). A template with no picture of its own gets no card either: the card IS its media.
 */
export function exploreTemplates(templates: readonly TemplateDto[], onSale: OnSale): Record<TemplateRow, TemplateDto[]> {
  const rows: Record<TemplateRow, TemplateDto[]> = { trending: [], topics: [], brand: [] };
  for (const t of templates) {
    const row = templateRow(t);
    if (!row || t.model_status !== "available" || !isTemplateMedia(t)) continue;
    // Words the card draws as text: anything but a string (a forged body) drops the template rather than draw "[object Object]".
    if (typeof t.title !== "string" || typeof t.description !== "string" || typeof t.slug !== "string") continue;
    if (!isOnSale(onSale, capabilityFor(t.kind), t.model_id)) continue;
    rows[row].push(t);
  }
  return rows;
}

/** A template's box shape from its aspect (0183's CHECK: one of three). */
export const TEMPLATE_ASPECT: Readonly<Record<string, readonly [number, number]>> = { "16:9": [16, 9], "9:16": [9, 16], "1:1": [1, 1] };

/** The only media addresses the route builds (lib/templates/trends.ts templateMediaUrl): this origin's /templates files. */
const TEMPLATE_MEDIA = /^\/templates\/[a-z0-9-]+\/(poster\.webp|preview\.mp4)$/;

/**
 * The route's body is data from the network, not a promise: a poster or preview outside /templates/<slug>/, or an aspect the grid has
 * no box for, drops the template (Breach I-1: a bad aspect would otherwise throw while drawing the screen).
 */
function isTemplateMedia(t: TemplateDto): boolean {
  if (typeof t.poster_url !== "string" || !TEMPLATE_MEDIA.test(t.poster_url) || !t.poster_url.endsWith("/poster.webp")) return false;
  if (t.preview_url !== undefined && (typeof t.preview_url !== "string" || !TEMPLATE_MEDIA.test(t.preview_url) || !t.preview_url.endsWith("/preview.mp4"))) return false;
  return typeof t.aspect === "string" && Object.hasOwn(TEMPLATE_ASPECT, t.aspect);
}

/**
 * The route could not say for any template whether its model is on sale (every row "unknown": signed out, the registry unread).
 * That is "could not check", not "nothing yet".
 */
export function templatesUnread(templates: readonly TemplateDto[]): boolean {
  return templates.length > 0 && templates.every((t) => t.model_status === "unknown");
}

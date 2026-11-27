/**
 * The Studio's explore grid (components/studio/StudioExplore.tsx, below the fold of the Studio home): the shipped model samples
 * (lib/site/showcase.json) and the trend templates (0183, /api/templates), media first, each card one link into this channel's
 * Studio form. Pure and client-safe; the create page calls the sample half on the server.
 *
 * Owner decision 22 Nov: no model name on a card. A card carries only what it draws (its media, its title, one line, its link); the
 * model travels in the link's `model=` alone, so the sample DTO below is built on the server and never holds the export's
 * modelName or provider (the client payload of the page would otherwise carry them under every card).
 *
 * What is shown as available (CLAUDE.md "Definition of Done": nothing is shown as available that is not): a card appears only when
 * its model is on sale to THIS workspace for the card's tool, as the server's own catalogue says (loadStudioModels: the registry,
 * sellable_models(), the owner's switch, a vendor's shutdown, the country, and this organization's locks). An operator preview is
 * not on sale, even to the operator; a locked model (the database would refuse this organization) is not on sale here either.
 */
import type { Locale } from "@/lib/i18n/core";
import type { StudioModel } from "@/lib/creative/studio";
import { modelLeftOut, sourceOnlyJobs, type ShowcaseEntry, type ShowcaseFiles } from "@/lib/site/showcase";
import { studioCreateSection, type ShippedSamples } from "@/lib/site/showcase-link";
import { cardTitle } from "@/lib/site/card-titles";
import { cardWords } from "@/lib/site/card-words";
import { posterSrcSet } from "@/lib/site/renditions";
import { capabilityFor, type TemplateDto } from "@/lib/templates/trends";

/** The model ids on sale to this workspace, per tool. Built on the server from the page's catalogue; the browser only reads it. */
export type OnSale = Readonly<Record<string, readonly string[]>>;

/** Only what the explore grid needs to know, per tool: models this organization can actually buy for it today. */
export function onSaleCatalog(models: readonly StudioModel[], capabilities: readonly string[]): OnSale {
  const out: Record<string, string[]> = {};
  for (const cap of capabilities) {
    out[cap] = models.filter((m) => !m.preview && !m.lock && m.capabilities.includes(cap)).map((m) => m.id);
  }
  return out;
}

export function isOnSale(onSale: OnSale, capability: string, modelId: string): boolean {
  return onSale[capability]?.includes(modelId) === true;
}

/** At most this many samples below the fold: the page is the composer's, and every clip in view plays (six at most at once). */
export const EXPLORE_SAMPLE_LIMIT = 12;

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

/**
 * The sample cards for this workspace, newest first: an entry whose files ship, that is not only an animation's starting frame
 * (sourceOnlyJobs, as the landing's grid rules), whose model is on sale here for its tool (`onSale`), and which the shipped data
 * does not itself mark as left out of its link (an operator preview or past its shutdown day: the link would not name the model,
 * so the Studio would open on another one). Anything else gets no card; there is never a placeholder.
 */
export function exploreSamples(
  entries: readonly ShowcaseEntry[],
  files: Readonly<Record<string, ShowcaseFiles>>,
  onSale: OnSale,
  locale: Locale,
  now: Date = new Date(),
  limit: number = EXPLORE_SAMPLE_LIMIT,
): ExploreSample[] {
  const frames = sourceOnlyJobs(entries);
  const shipped: ShippedSamples = { entries, files };
  const out: ExploreSample[] = [];
  for (const e of entries) {
    if (out.length >= limit) break;
    const f = files[e.jobId];
    if (!f || frames.has(e.jobId)) continue;
    if (modelLeftOut(e, now) !== null || !isOnSale(onSale, e.capability, e.modelId)) continue;
    const href = studioCreateSection(e, now, shipped);
    if (!href) continue;
    const words = cardWords(e, locale);
    out.push({
      id: e.jobId,
      kind: e.kind,
      width: e.width,
      height: e.height,
      poster: f.poster,
      srcSet: posterSrcSet(f),
      clip: e.kind === "video" && f.clip !== null,
      title: cardTitle(e.jobId, locale),
      line: { text: words.text, lang: words.lang },
      href,
    });
  }
  return out;
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
    if (!row || t.model_status !== "available" || !t.poster_url) continue;
    if (!isOnSale(onSale, capabilityFor(t.kind), t.model_id)) continue;
    rows[row].push(t);
  }
  return rows;
}

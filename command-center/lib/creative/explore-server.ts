import "server-only";
/**
 * The Studio's explore grid, the server's half (the create page calls buildExploreData): the shipped model samples
 * (lib/site/showcase.json, through lib/site/showcase.ts and showcase-link.ts) filtered to what is on sale here, each turned into a
 * card the browser may hold. Server-only on purpose: the manifest names vendors and models, and a client import of this file would
 * put all of it in the Create chunk (the build refuses one).
 *
 * Owner decision 22 Nov: no model name on a card. A card carries only what it draws (its media, its title, one line, its link); the
 * model travels in the link's `model=` alone, so the sample DTO is built here and never holds the export's modelName or provider.
 */
import type { Locale } from "@/lib/i18n/core";
import type { StudioModel } from "@/lib/creative/studio";
import { modelLeftOut, sourceOnlyJobs, type ShowcaseEntry, type ShowcaseFiles } from "@/lib/site/showcase";
import { studioCreateSection, type ShippedSamples } from "@/lib/site/showcase-link";
import { cardTitle } from "@/lib/site/card-titles";
import { cardWords } from "@/lib/site/card-words";
import { posterSrcSet } from "@/lib/site/renditions";
import { onlyOpenToSome, onlyPriced } from "@/lib/tool-availability";
import { isOnSale, type ExploreData, type ExploreSample, type OnSale } from "@/lib/creative/explore";

/** Only what the explore grid needs to know, per tool: models this organization can actually buy for it today. */
export function onSaleCatalog(models: readonly StudioModel[], capabilities: readonly string[]): OnSale {
  const out: Record<string, string[]> = {};
  for (const cap of capabilities) {
    out[cap] = models.filter((m) => !m.preview && !m.lock && m.capabilities.includes(cap)).map((m) => m.id);
  }
  return out;
}

/**
 * The explore grid's catalogue from the page's models, by the same filtering the Studio's availability marks use
 * (lib/server/tool-availability.ts readToolAvailability): less any model the price list has no rate for (`catalog`, the Models page's
 * read; null = prices unread, nothing taken out on a guess) and any model no organization can buy (a plan-tier entitlement). A
 * sellable model with no price is not on sale: its card would open a form whose quote is refused.
 */
export function exploreCatalog(
  models: readonly StudioModel[],
  catalog: readonly { id: string; state: string }[] | null,
  capabilities: readonly string[],
): OnSale {
  return onSaleCatalog(onlyOpenToSome(onlyPriced(models, catalog)), capabilities);
}

/** At most this many samples below the fold: the page is the composer's, and every clip in view plays (six at most at once). */
export const EXPLORE_SAMPLE_LIMIT = 12;

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

/**
 * The page's answer for the grid, decided on the server: "unread" when the registry (`registryRead` false: readStudioModels() said
 * null) or the price list (`catalog` null: readCatalogStates could not read it) could not be read, since a guess either way would be
 * a card for something unbuyable or a "nothing yet" that is not known (rule 5); else the samples and catalogue on sale here.
 */
export function buildExploreData(p: {
  registryRead: boolean;
  models: readonly StudioModel[];
  catalog: readonly { id: string; state: string }[] | null;
  entries: readonly ShowcaseEntry[];
  files: Readonly<Record<string, ShowcaseFiles>>;
  locale: Locale;
  now?: Date;
}): ExploreData {
  if (!p.registryRead || p.catalog === null) return { state: "unread" };
  const onSale = exploreCatalog(p.models, p.catalog, ["t2v", "t2i", "i2v"]);
  return { state: "ok", samples: exploreSamples(p.entries, p.files, onSale, p.locale, p.now), onSale: { t2v: onSale.t2v, t2i: onSale.t2i } };
}


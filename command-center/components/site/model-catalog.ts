/**
 * The model pages built from the shipped data: lib/site/showcase.json with its files (components/site/showcase-assets.ts) and
 * lib/site/model-facts.json. Here, not in lib/site/model-pages.ts, because it reads the file module; the pages, the sitemap and
 * the links on the landing's tiles and the explore cards all read this one list, so a link is never to a page that is not built.
 *
 * It pairs entries with their files itself (the rule of ShowcaseGallery's showcaseItems: an entry without its files is never
 * shown) instead of importing that component, which links here: the two modules must not import each other.
 */
import { buildModelPages, type ModelPage, type ModelSample } from "@/lib/site/model-pages";
import { SHOWCASE_ENTRIES } from "@/lib/site/showcase";
import { SHOWCASE_FILES } from "@/components/site/showcase-assets";

/** Every sample whose files are here, of every model (a clip's source picture may be another model's sample). */
export const SAMPLE_ITEMS: readonly ModelSample[] = SHOWCASE_ENTRIES.flatMap((e) => (SHOWCASE_FILES[e.jobId] ? [{ e, f: SHOWCASE_FILES[e.jobId] }] : []));

export const MODEL_PAGES: readonly ModelPage[] = buildModelPages(SAMPLE_ITEMS);

/** The page of the model with this registry id, or null when it has none (no sample here, or no facts). */
export function modelPageHref(modelId: string, pages: readonly ModelPage[] = MODEL_PAGES): string | null {
  return pages.find((p) => p.facts.id === modelId)?.path ?? null;
}

export function modelPageBySlug(slug: string, pages: readonly ModelPage[] = MODEL_PAGES): ModelPage | null {
  return pages.find((p) => p.slug === slug) ?? null;
}

/**
 * The landing page with and without its model samples (components/site/ShowcaseGallery.tsx).
 *
 * The gallery is the one part of the public site that shows real generations and names the model that made each one; the rest
 * of the page shows only labelled stock examples and AI-generated decoration, and names no provider (tests/helpers/brands.ts).
 * The page-wide tests were written while lib/site/showcase.json was empty and counted the gallery's picture, clip and pause
 * button as if they were the stock showcases', and read its model name as a leak: the first real export (#720) failed them.
 * They now check the page outside the gallery's root, so they hold with zero or any number of merged samples, and what the
 * gallery itself may say is pinned over the real data file in tests/site-showcase.test.tsx ("the shipped samples").
 */
import { showcaseItems } from "@/components/site/ShowcaseGallery";

/** The gallery's root. It renders only when a sample whose files are in the repository exists. */
export const GALLERY = "section#samples";
/** One sample's card: the only element on the public site that may name a model. */
export const SAMPLE_CARD = "[data-showcase-entry]";

/** A detached copy of `container` without the elements `selector` matches; the rendered page is untouched. */
export function without(container: Element, selector: string): HTMLElement {
  const copy = container.cloneNode(true) as HTMLElement;
  copy.querySelectorAll(selector).forEach((n) => n.remove());
  return copy;
}

/** The elements that are not inside the gallery. */
export function outsideGallery<T extends Element>(els: Iterable<T>): T[] {
  return [...els].filter((e) => !e.closest(GALLERY));
}

/**
 * The samples the shipped data file shows (an entry whose files are missing is never shown), how many of them play a clip, and
 * how many clips also show the sample picture they were animated from (a second, smaller picture in that card).
 */
export function shippedSamples(): { cards: number; clips: number; sources: number } {
  const items = showcaseItems();
  const jobs = new Set(items.map(({ e }) => e.jobId));
  return {
    cards: items.length,
    clips: items.filter(({ e, f }) => e.kind === "video" && f.clip !== null).length,
    sources: items.filter(({ e }) => e.kind === "video" && e.input.kind === "operator_job" && jobs.has(e.input.jobId)).length,
  };
}

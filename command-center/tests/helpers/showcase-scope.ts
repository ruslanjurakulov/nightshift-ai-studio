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
import type { Dictionary } from "@/lib/i18n";
import { creditLine } from "@/lib/site/media";
import { landingExcludedJobs, type PlaceMedia } from "@/components/site/samples";
import { showcaseItems } from "@/components/site/ShowcaseGallery";
import { landingGalleryJobs } from "@/components/site/landing-samples";

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

/**
 * The landing's other places that show the samples themselves, each in its own box like the gallery's cards: the carousel, picture
 * → video and prompt → result (components/site/landing-samples.tsx). Like the gallery they show whatever the owner has merged.
 */
export const SAMPLE_SECTIONS = "[data-sample-section]";

/**
 * The public Effects section's root (components/site/EffectsGallery.tsx). An effect whose preview is merged shows that sample's
 * poster and loop there, so its number is whatever lib/effects/effects.json points at: the fourth showcase batch (#746) put five
 * there and the page-wide counts below went from 16 pictures to 21 and from 4 clips to 9. What that section may show (one poster
 * and one silent clip per sampled effect, same-origin, lazy, no pause button, no maker named) is pinned over the real data in
 * tests/effects-ui.test.tsx ("the public Effects section"). It is not a [data-sample-section]: its cards name no model.
 */
export const EFFECTS_SECTION = "section#effects";

/** The elements that are not inside the gallery, one of the other sample sections, or the Effects section. */
export function outsideGallery<T extends Element>(els: Iterable<T>): T[] {
  return [...els].filter((e) => !e.closest(GALLERY) && !e.closest(SAMPLE_SECTIONS) && !e.closest(EFFECTS_SECTION));
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

/**
 * The same for the landing, whose gallery shows only its share (components/site/landing-samples.tsx landingGalleryJobs): not the
 * samples its slots, picture → video, the ticker or the Effects section show, at most LANDING_GALLERY_MAX, and the carousel leaves
 * those out (so no clip is on the page twice).
 */
export function landingSamples(): { cards: number; clips: number; sources: number } {
  const share = landingGalleryJobs(landingExcludedJobs());
  const all = showcaseItems();
  const jobs = new Set(all.map(({ e }) => e.jobId));
  const items = all.filter(({ e }) => share.includes(e.jobId));
  return {
    cards: items.length,
    clips: items.filter(({ e, f }) => e.kind === "video" && f.clip !== null).length,
    // A card's source picture is looked up among every sample, the slots' included (ShowcaseGallery byJob).
    sources: items.filter(({ e }) => e.kind === "video" && e.input.kind === "operator_job" && jobs.has(e.input.jobId)).length,
  };
}

/**
 * What is wrong with the labels of a place that shows `m` (components/site/samples.tsx slotMedia), or [] when nothing is. One of
 * our samples, in a box marked as that sample, says AI-generated and nothing more: no model name, no "Try this prompt" or "Use
 * this prompt", no footnote, no maker's credit or "Powered by" (a place's picture is the backdrop for copy about something else,
 * owner 2026-11-13), and nothing about stock. A stock picture says it is a stock example and credits its Pexels contributor, and
 * says nothing about AI. Tests call it for whatever the slots hold, so they pass before and after a sample replaces a stock
 * picture, and fail on a label that lies in either direction.
 */
export function placeLabelProblems(el: Element, m: PlaceMedia, site: Dictionary["site"]): string[] {
  const out: string[] = [];
  const text = el.textContent ?? "";
  const s = site.samples;
  if (m.kind === "ai") {
    const box = el.closest(SAMPLE_CARD);
    if (box?.getAttribute("data-showcase-entry") !== m.entry.jobId) out.push("not inside its sample's box");
    // The "AI" mark and, for a screen reader, what it means (components/site/AiMark.tsx): the long form is the unique one.
    if (!text.includes(site.gallery.badge) || !text.includes(site.gallery.badgeName)) out.push("no AI-generated badge");
    if (text.includes(m.entry.modelName)) out.push("names its model");
    if (el.querySelector(".nx-ai-model")) out.push("has a model label");
    if (el.querySelector(".nx-ai-try") || text.includes(site.gallery.use)) out.push("offers its prompt");
    if (text.includes(site.gallery.useNote)) out.push("has a footnote");
    out.push(...makerCreditProblems(el));
    for (const w of [s.tag, s.frameTag, s.clipTag]) if (text.includes(w)) out.push(`says "${w}"`);
    if (/pexels/i.test(el.innerHTML)) out.push("mentions Pexels");
  } else {
    if (el.closest(SAMPLE_CARD)) out.push("a stock picture inside a sample's box");
    const still = el.querySelector(".nx-result-badge[data-kind='still']")?.textContent;
    if (still !== (m.footage ? s.frameTag : s.tag)) out.push(`still badge is ${still}`);
    const clip = el.querySelector(".nx-result-badge[data-kind='clip']")?.textContent ?? null;
    if (clip !== (m.clip ? s.clipTag : null)) out.push(`clip badge is ${clip}`);
    const credit = el.querySelector(".nx-result-credit")?.textContent;
    if (credit !== creditLine(m.id, s.credit)) out.push(`credit is ${credit}`);
    if (text.includes(site.gallery.badgeName)) out.push("says AI-generated");
  }
  return out;
}

/**
 * A model maker's credit on a public surface, which the owner decided the public site does not carry (2026-11-13): the maker's
 * required credit is shown in the Studio, where the models are used (components/studio/ModelAttribution.tsx). [] when there is none.
 */
export function makerCreditProblems(el: Element): string[] {
  const out: string[] = [];
  for (const a of el.querySelectorAll("a[href]")) {
    const href = a.getAttribute("href") ?? "";
    if (/runway/i.test(href)) out.push(`links ${href}`);
    if (/ideogram/i.test(href)) out.push(`links ${href}`);
  }
  if (/powered by/i.test(el.textContent ?? "")) out.push('says "Powered by"');
  return out;
}
